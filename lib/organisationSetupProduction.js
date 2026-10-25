'use strict';

const { createOrganisationSetup } = require('../api/shared/organisationSetup');
const { readOrganisationSetupContinuation } = require('../api/shared/customerSignup/organisationSetupBinding');
const MAX_BYTES = 8192;
class AzureOrganisationSetupStore {
    constructor(container) { this.container = container; }
    blob(key) {
        if (!/^(requests|budget|references|detached)\/[a-f0-9]{64}$/.test(key)) throw new Error('setup_key_invalid');
        return this.container.getBlockBlobClient('browser-auth/organisation-setup/' + key + '.json');
    }
    async load(key) {
        try {
            const result = await this.blob(key).download(0, undefined, { abortSignal: AbortSignal.timeout(8000) });
            let length = 0; const chunks = [];
            for await (const chunk of result.readableStreamBody) {
                length += chunk.length;
                if (length > MAX_BYTES) { result.readableStreamBody.destroy(); throw new Error('setup_record_invalid'); }
                chunks.push(chunk);
            }
            if (typeof result.etag !== 'string' || !result.etag) throw new Error('setup_record_invalid');
            const record = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (record.schemaVersion !== 1 || !Number.isSafeInteger(record.expiresAt)) throw new Error('setup_record_invalid');
            return { record, version: result.etag };
        } catch (e) { if (e.statusCode === 404) return null; throw new Error('setup_storage_unavailable'); }
    }
    async write(key, record, conditions) {
        const data = Buffer.from(JSON.stringify(record));
        if (data.length > MAX_BYTES) throw new Error('setup_record_invalid');
        try {
            await this.blob(key).uploadData(data, { conditions, abortSignal: AbortSignal.timeout(8000),
                blobHTTPHeaders: { blobContentType: 'application/json', blobCacheControl: 'no-store' } });
            return true;
        } catch (e) { if ([409, 412].includes(e.statusCode)) return false; throw new Error('setup_storage_unavailable'); }
    }
    create(key, record) { return this.write(key, record, { ifNoneMatch: '*' }); }
    replace(key, version, record) { return this.write(key, record, { ifMatch: version }); }
}
// Use the same bounded create/read adapter in the separately configured external
// authority container. Its customer-starter records are retained outside the
// production browser-auth/ one-day lifecycle; the counter remains ephemeral.
class AzureExternalSignupAdmissionStore extends AzureOrganisationSetupStore {
    blob(key) {
        if (!/^admissions\/[a-f0-9]{64}$/.test(key)) throw new Error('setup_key_invalid');
        return this.container.getBlockBlobClient('customer-starter/external-signup-' + key + '.json');
    }
}
function createProductionOrganisationSetup(env, dependencies = {}) {
    if ([undefined, '', 'false'].includes(env.NOFRIES_ORGANISATION_SETUP_ENABLED)) return null;
    if (env.NOFRIES_ORGANISATION_SETUP_ENABLED !== 'true' || env.NOFRIES_DASHBOARD_RUNTIME_ENABLED !== 'true' || env.NOFRIES_PUBLIC_URL !== 'https://nofries.nz' ||
        !/^[a-z0-9]{3,24}$/.test(env.NOFRIES_BROWSER_AUTH_STORAGE_ACCOUNT || '') ||
        !env.RESEND_API_KEY || !env.NOFRIES_SCOPE_EMAIL_FROM) throw new Error('organisation_setup_configuration_invalid');
    const Credential = dependencies.ManagedIdentityCredential || require('@azure/identity').ManagedIdentityCredential;
    const BlobServiceClient = dependencies.BlobServiceClient || require('@azure/storage-blob').BlobServiceClient;
    const credential = env.NOFRIES_MANAGED_IDENTITY_CLIENT_ID ? new Credential({ clientId: env.NOFRIES_MANAGED_IDENTITY_CLIENT_ID }) : new Credential();
    const service = new BlobServiceClient('https://' + env.NOFRIES_BROWSER_AUTH_STORAGE_ACCOUNT + '.blob.core.windows.net', credential,
        { retryOptions: { maxTries: 1, tryTimeoutInMs: 8000 } });
    const container = service.getContainerClient(env.NOFRIES_BROWSER_AUTH_CONTAINER || 'nofries-browser-auth');
    let readContinuation;
    if (env.NOFRIES_CUSTOMER_SIGNUP_ENABLED === 'true') {
        if (!/^[a-z0-9]{3,24}$/.test(env.AZURE_STORAGE_ACCOUNT_NAME || '') ||
            env.AZURE_STORAGE_ACCOUNT_NAME === env.NOFRIES_BROWSER_AUTH_STORAGE_ACCOUNT ||
            !/^(?!.*--)[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(env.NOFRIES_CUSTOMER_AUTHORITY_CONTAINER || '')) throw new Error('organisation_setup_configuration_invalid');
        const authorityService = new BlobServiceClient('https://' + env.AZURE_STORAGE_ACCOUNT_NAME + '.blob.core.windows.net', credential,
            { retryOptions: { maxTries: 1, tryTimeoutInMs: 8000 } });
        const authorityContainer = authorityService.getContainerClient(env.NOFRIES_CUSTOMER_AUTHORITY_CONTAINER);
        readContinuation = record => readOrganisationSetupContinuation({ record, authorityContainer });
    }
    const send = dependencies.fetch || globalThis.fetch;
    return createOrganisationSetup({ store: new AzureOrganisationSetupStore(container), origin: env.NOFRIES_PUBLIC_URL, readContinuation,
        ...(dependencies.findAccount ? { findAccount: dependencies.findAccount } : {}),
        ...(dependencies.starterSetup ? { starterSetup: dependencies.starterSetup } : {}),
        async sendEmail({ email, code }) {
            const response = await send('https://api.resend.com/emails', { method: 'POST', signal: AbortSignal.timeout(10000),
                headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
                body: JSON.stringify({ from: env.NOFRIES_SCOPE_EMAIL_FROM, to: [email],
                    subject: 'Verify your email for No Fries',
                    text: 'Your No Fries signup verification code is: ' + code + '\n\nEnter it in the browser where you started setup at https://nofries.nz. It expires in 10 minutes and can be used once. If you did not request it, ignore this email. No account access or subscription has been activated.' }) });
            if (!response.ok) throw new Error('setup_delivery_unconfirmed');
        } });
}
module.exports = { AzureOrganisationSetupStore, AzureExternalSignupAdmissionStore, createProductionOrganisationSetup };
