'use strict';

const { inspectCustomerAuthority, normaliseCustomerAuthoritySource } = require('./customerAuthorityExpiry');
const { subjectHash } = require('../customerSignup/customerAuthority');
const { AzureStarterAccountStore } = require('../customerSignup/azureStarterAccountStore');
const { starterAccountKey } = require('../customerSignup/starterAccountAllocation');
const { hash } = require('../appLifecycle/dashboardRuntimeRecords');
const unavailable = () => { throw new Error('account_lookup_unavailable'); };
const missing = email => ({ email, accountType: null, organisation: null, status: 'missing', expiresAt: null, revision: null });

function createAccountLookupReader(sources, now = Date.now) {
    return async function lookup(email, signal, authorise, includeSelector = false) {
        const rows = [];
        let count = 0;
        for (const { source, container } of sources) {
            signal.throwIfAborted();
            const account = source.kind === 'legacy_admin' ? null :
                (await new AzureStarterAccountStore(container).load(starterAccountKey(email)))?.record;
            const expectedSubject = account?.identitySubjectKey ?? account?.activation?.subjectKey;
            let foundExpected = false;
            // No email index exists for legacy subjects. Bound enumeration and fail
            // closed on overflow: never report a partial scan as a missing account.
            for await (const blob of container.listBlobsFlat({ prefix: 'customer-subjects/', abortSignal: signal })) {
                signal.throwIfAborted();
                if (++count > 100) unavailable();
                if (!/^customer-subjects\/[a-f0-9]{64}\.json$/.test(blob.name)) unavailable();
                let record, etag;
                try {
                    const response = await container.getBlockBlobClient(blob.name).download(0, 16385, { abortSignal: signal });
                    const chunks = []; let size = 0;
                    try {
                        if (!Number.isSafeInteger(response.contentLength) || response.contentLength < 1 || response.contentLength > 16384) unavailable();
                        for await (const chunk of response.readableStreamBody) {
                            size += chunk.length; if (size > 16384) unavailable(); chunks.push(chunk);
                        }
                        if (size !== response.contentLength) unavailable();
                        record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
                        etag = response.etag;
                    } finally { response.readableStreamBody?.destroy(); }
                } catch (error) {
                    if (error.statusCode === 404 && error.code === 'BlobNotFound') continue;
                    throw error;
                }
                if (record?.email !== email) continue;
                const row = missing(email); let selector = null;
                try {
                    const at = new Date(now()).toISOString();
                    const slot = record.subjectKey === expectedSubject ? account.organisations[0] : null;
                    const result = inspectCustomerAuthority({ source, blobName: blob.name, etag, observedAt: at, record },
                        { sourceSha256: hash(source), subjectKey: record.subjectKey, tenantId: slot?.tenantId ?? record.tenantId, organisationId: slot?.organisationId ?? record.organisationId }, at);
                    selector = { provider: source.kind === 'external_starter' ? 'external' : 'legacy',
                        subjectKey: record.subjectKey, tenantId: record.tenantId, organisationId: record.organisationId };
                    Object.assign(row, { accountType: record.accountType ?? null, organisation: record.organisationId,
                        status: result.status, expiresAt: result.expiresAt, revision: result.revision });
                    if (record.subjectKey === expectedSubject && record.tenantId === slot.tenantId && record.organisationId === slot.organisationId) {
                        row.organisation = slot.organisationName;
                        row.accountType = account.accountType;
                    }
                } catch (_) { /* A malformed/misbound record is not usable authority. */ }
                // Authorization errors must not be reinterpreted as missing authority.
                if (selector) { await authorise(selector); if (includeSelector) row.selector = selector; }
                if (expectedSubject && blob.name === `customer-subjects/${subjectHash(expectedSubject)}.json`) foundExpected = true;
                rows.push(row);
            }
            if (account && expectedSubject && !foundExpected) {
                await authorise({ provider: source.kind === 'external_starter' ? 'external' : 'legacy', subjectKey: expectedSubject,
                    tenantId: account.organisations[0].tenantId, organisationId: account.organisations[0].organisationId });
                rows.push({ ...missing(email), accountType: account.accountType, organisation: account.organisations[0].organisationName });
            }
        }
        signal.throwIfAborted();
        return rows.length ? rows : [missing(email)];
    };
}

function createProductionAccountLookup(env) {
    if (env.NOFRIES_DASHBOARD_ADMIN_ACCOUNT_LOOKUP !== 'true') return null;
    // Construct SDK clients lazily; the disabled feature performs no storage I/O.
    return async (email, signal, authorise, includeSelector = false) => {
        const account = env.AZURE_STORAGE_ACCOUNT_NAME;
        if (!/^[a-z0-9]{3,24}$/.test(account || '') || account === env.NOFRIES_BROWSER_AUTH_STORAGE_ACCOUNT) unavailable();
        const { ManagedIdentityCredential } = require('@azure/identity');
        const { BlobServiceClient } = require('@azure/storage-blob');
        const credential = env.NOFRIES_MANAGED_IDENTITY_CLIENT_ID ? new ManagedIdentityCredential({ clientId: env.NOFRIES_MANAGED_IDENTITY_CLIENT_ID }) : new ManagedIdentityCredential();
        const service = new BlobServiceClient(`https://${account}.blob.core.windows.net`, credential, { retryOptions: { maxTries: 1 } });
        const sources = [
            ['legacy_admin', env.NOFRIES_CUSTOMER_AUTHORITY_CONTAINER, env.NOFRIES_ENTRA_TENANT_ID],
            ['legacy_starter', env.NOFRIES_STARTER_AUTHORITY_CONTAINER, env.NOFRIES_ENTRA_TENANT_ID],
            ['external_starter', env.NOFRIES_EXTERNAL_CUSTOMER_AUTHORITY_CONTAINER, env.NOFRIES_EXTERNAL_CUSTOMER_TENANT_ID]
        ].filter(([, name]) => name).map(([kind, container, tenant]) => {
            if ([env.NOFRIES_BROWSER_AUTH_CONTAINER || 'nofries-browser-auth', env.NOFRIES_DASHBOARD_PROOF_CONTAINER,
                env.NOFRIES_DASHBOARD_EPOCH_CONTAINER].includes(container)) unavailable();
            const source = normaliseCustomerAuthoritySource({ schemaVersion: 1, kind, storageAccount: account, container,
                providerKind: kind === 'external_starter' ? 'external-id' : 'workforce-b2b', providerTenantId: tenant,
                providerConfigurationSha256: hash({ kind, tenant }) });
            return { source, container: service.getContainerClient(container) };
        });
        if (!sources.length || new Set(sources.map(s => s.source.container)).size !== sources.length) unavailable();
        return createAccountLookupReader(sources)(email, signal, authorise, includeSelector);
    };
}
module.exports = { createAccountLookupReader, createProductionAccountLookup };
