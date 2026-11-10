'use strict';
const { Readable } = require('node:stream');
const { entrySessionFixture, uid, NOW } = require('./dashboardAdminEntrySession');
const { canonical } = require('../../api/shared/appLifecycle/dashboardRuntimeRecords');
const { subjectHash } = require('../../api/shared/customerSignup/customerAuthority');
const { createProductionApplication } = require('../../lib/productionApplication');
const iso = n => new Date(n).toISOString();
function fixture(kind = 'legacy_admin') {
    const h = entrySessionFixture({ customer: false, externalCustomer: false }), stores = new Map(), reads = [], writes = [], clients = [];
    Object.assign(h.env, { NODE_ENV: 'production', NOFRIES_BROWSER_AUTH_MODE: 'entra_bff', NOFRIES_BROWSER_SESSION_STORE: 'azure',
        NOFRIES_BROWSER_AUTH_STORAGE_ACCOUNT: 'syntheticauth', AZURE_STORAGE_ACCOUNT_NAME: 'syntheticdata',
        NOFRIES_SCOPE_SIGNING_SECRET: 's'.repeat(32), NOFRIES_PROSPECT_SIGNING_SECRET: 'p'.repeat(32),
        NOFRIES_DASHBOARD_RUNTIME_ENABLED: 'true', NOFRIES_DASHBOARD_INSTANCE_ID: h.dashboard.instanceId,
        NOFRIES_DASHBOARD_IDENTITY_POLICY_ID: h.dashboard.identityPolicy.policyId, NOFRIES_DASHBOARD_IDENTITY_POLICY_REVISION: '1',
        NOFRIES_DASHBOARD_PROOF_CONTAINER: 'dashboard-proofs', NOFRIES_DASHBOARD_EPOCH_CONTAINER: 'dashboard-epochs',
        NOFRIES_POSTGRES_HOST: 'synthetic.postgres.database.azure.com', NOFRIES_POSTGRES_DATABASE: 'nofries', NOFRIES_POSTGRES_USER: 'nofries_app',
        NOFRIES_CUSTOMER_SIGNUP_ENABLED: 'false', NOFRIES_EXTERNAL_CUSTOMER_ENABLED: 'false', NOFRIES_EXTERNAL_CUSTOMER_TENANT_ID: uid(40),
        NOFRIES_CUSTOMER_AUTHORITY_CONTAINER: 'customer-authority', NOFRIES_STARTER_AUTHORITY_CONTAINER: 'legacy-signups',
        NOFRIES_EXTERNAL_CUSTOMER_AUTHORITY_CONTAINER: 'external-signups', NOFRIES_DASHBOARD_ADMIN_AUDIT_CONTAINER: 'account-action-audit',
        NOFRIES_DASHBOARD_ADMIN_ACCOUNT_ACTIONS: 'true', NOFRIES_STAFF_CONSOLE: 'true', NOFRIES_DASHBOARD_ADMIN_ACCOUNT_LOOKUP: 'true' });
    const connect = h.pool.connect.getMockImplementation();
    h.pool.connect.mockImplementation(async () => { const client = await connect(); return { release: client.release,
        query: (sql, values) => /^(SAVEPOINT |ROLLBACK TO SAVEPOINT |RELEASE SAVEPOINT )/.test(sql) ? Promise.resolve({ rows: [] }) : client.query(sql, values) }; });
    const bucket = (account, name) => { const key = account + '/' + name; if (!stores.has(key)) stores.set(key, new Map()); return stores.get(key); };
    const sdk = {
        ManagedIdentityCredential: jest.fn(function (options) { this.options = options; }),
        BlobServiceClient: class {
            constructor(url, credential, options) { this.url = url; this.options = options; clients.push({ url, credential, options }); }
            getContainerClient(name) {
                const account = new URL(this.url).hostname.split('.')[0], rows = bucket(account, name), options = this.options;
                return { url: this.url + '/' + name, pipeline: { options }, async getProperties() { return {}; },
                    listBlobsFlat() { throw new Error('PRIVATE_UNEXPECTED_SCAN'); }, getBlockBlobClient(key) { return {
                        async download() {
                            reads.push({ account, name, key });
                            const value = name === 'dashboard-epochs' ? { bytes: Buffer.from(JSON.stringify({ instanceId: h.dashboard.instanceId, restoreEpoch: h.state.epoch })), etag: '"epoch"' } : rows.get(key);
                            if (!value) throw Object.assign(new Error('PRIVATE_MISSING'), { statusCode: 404, code: 'BlobNotFound' });
                            return { contentLength: value.bytes.length, etag: value.etag, readableStreamBody: Readable.from([value.bytes]) };
                        }, async uploadData(bytes, args = {}) {
                            const previous = rows.get(key), conditions = args.conditions || {};
                            if (conditions.ifNoneMatch && previous || conditions.ifMatch && conditions.ifMatch !== previous?.etag)
                                throw Object.assign(new Error('PRIVATE_CONFLICT'), { statusCode: 412 });
                            rows.set(key, { bytes: Buffer.from(bytes), etag: '"written"' }); writes.push({ account, name, key }); return { etag: '"written"' };
                        }
                    }; } };
            }
        }, createPostgresPool: () => h.pool, createBrowserSessionStore: () => h.store, clock: () => iso(h.state.now),
        clientApplication: h.dashboard.browserAuthOptions.clientApplication, cryptoProvider: h.dashboard.browserAuthOptions.cryptoProvider
    };
    const sourceName = ({ legacy_admin: 'customer-authority', legacy_starter: 'legacy-signups', external_starter: 'external-signups' })[kind];
    const record = { schemaVersion: 1, subjectKey: (kind === 'external_starter' ? uid(40) : h.env.NOFRIES_ENTRA_TENANT_ID) + ':' + uid(41),
        email: 'synthetic@example.invalid', revision: 0, status: 'active', invitationDigest: 'a'.repeat(64), invitationId: 'synthetic-invite',
        tenantId: 'synthetic-tenant', organisationId: 'synthetic-org', termsVersion: 'synthetic-terms', termsDigest: 'b'.repeat(64), bindingId: null, expiresAt: NOW - 1000 };
    const selector = { provider: kind === 'external_starter' ? 'external' : 'legacy', subjectKey: record.subjectKey, tenantId: record.tenantId, organisationId: record.organisationId };
    const put = (name, key, value) => bucket('syntheticdata', name).set(key, { bytes: Buffer.from(canonical(value)), etag: '"initial"' });
    const subjectPath = `customer-subjects/${subjectHash(record.subjectKey)}.json`; put(sourceName, subjectPath, record);
    const build = () => createProductionApplication(h.env, sdk);
    return { ...h, sdk, build, bucket, put, reads, writes, clients, record, sourceName, subjectPath, selector,
        input: { selector, confirmationEmail: record.email, newExpiresAt: iso(NOW + 86400000) } };
}
module.exports = { fixture };
