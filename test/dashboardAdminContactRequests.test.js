'use strict';

// Staff contact request list (#409): flag gate, unchanged staff checks, audit
// category, read-only SQL shape and email resolution. Native RLS proof is in
// contactRequestListPostgres.test.js.
const { Readable } = require('node:stream');
const { createDashboardAdminHandlers } = require('../api/shared/dashboardAdmin/handlers');
const { createContactRequestReader, MAX_ROWS, MAX_TENANTS } = require('../api/shared/dashboardAdmin/contactRequestList');
const { createAccountListReader } = require('../api/shared/dashboardAdmin/accountListStore');
const { starterAccountKey, starterAccountRecord } = require('../api/shared/customerSignup/starterAccountAllocation');
const { approvedStarterPlan, accountWindow } = require('../api/shared/customerSignup/customerStarterPlan');
const { subjectHash } = require('../api/shared/customerSignup/customerAuthority');

const uid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const staff = uid(1) + ':' + uid(2);
const identity = { provider: 'entra-bff', isAuthenticated: true, subjectKey: staff, tenantId: uid(1), principalId: uid(2) };
const origin = 'https://operator.example.test';
const signal = () => new AbortController().signal;
const wire = (input, method = 'POST') => Object.assign(Readable.from([Buffer.from(JSON.stringify(input))]), {
    method, url: '/api/dashboard-admin/accounts/lookup', headers: { 'content-type': 'application/json', origin, 'sec-fetch-site': 'same-origin' } });
const readBody = async request => { const chunks = []; for await (const chunk of request) chunks.push(chunk); return Buffer.concat(chunks); };
const VIEW = { rows: [{ requestedAt: '2026-11-18T22:30:00.000Z', organisation: 'Alpha Ltd', topic: 'Results',
    contactEmail: 'owner@example.test', contactBasis: 'requester' }], truncated: false, windowDays: 90 };

function handler(options = {}) {
    const { admin = staff, contactRequests = jest.fn(async () => VIEW) } = options;
    const flag = Object.hasOwn(options, 'flag') ? options.flag : 'true';
    let { service } = options;
    const audit = jest.fn(async () => {}), read = jest.fn(async () => ({ rows: [], truncated: false }));
    service ||= { authorise: jest.fn(async actor => actor), capabilities: async () => ({}), lookup: async () => ({}) };
    const env = { NOFRIES_PUBLIC_URL: origin, NOFRIES_REQUIRE_AUTH: 'true', NOFRIES_ENTRA_TENANT_ID: uid(1), NOFRIES_ALLOWED_SUBJECTS: staff,
        NOFRIES_ADMIN_SUBJECTS: admin, NOFRIES_DASHBOARD_ADMIN_ACCOUNT_LOOKUP: 'true',
        ...(flag === undefined ? {} : { NOFRIES_OPERATOR_CONTACT_REQUESTS_ENABLED: flag }) };
    const handlers = createDashboardAdminHandlers({ service, readOperatorSession: async () => ({ identity }), env,
        accountLookupReader: { read, audit, contactRequests, targetDigest: () => '0'.repeat(64) } });
    return { handlers, audit, read, contactRequests, service };
}
beforeEach(() => { jest.spyOn(console, 'info').mockImplementation(() => {}); jest.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => jest.restoreAllMocks());

describe('route', () => {
    test.each([undefined, '', 'false', 'TRUE', '1'])('flag %p: the list is 404 and its client script is not served', async flag => {
        const h = handler({ flag });
        expect((await h.handlers.handle(wire({ contactRequests: true }), 'accounts/lookup')).status).toBe(404);
        expect(h.contactRequests).not.toHaveBeenCalled();
        const script = await h.handlers.handle(wire({}, 'GET'), 'accounts/app.js');
        expect(script.status).toBe(200);
        expect(script.body).not.toContain('contactRequestsPanel');
    });

    test('flag on: staff get the rows, one audit record names the category and no target', async () => {
        const h = handler(), result = await h.handlers.handle(wire({ contactRequests: true }), 'accounts/lookup');
        expect(result.status).toBe(200);
        expect(result.body).toEqual(VIEW);
        expect(h.contactRequests).toHaveBeenCalledTimes(1);
        expect(h.read).not.toHaveBeenCalled();
        expect(h.audit).toHaveBeenCalledTimes(1);
        const event = h.audit.mock.calls[0][0];
        expect(event).toMatchObject({ category: 'dashboard_admin_contact_request_list', targetSha256: null, status: 200, count: 1, truncated: false });
        expect(JSON.stringify(event)).not.toContain('@');
        expect((await h.handlers.handle(wire({}, 'GET'), 'accounts/app.js')).body).toContain('contactRequestsPanel');
    });

    test.each([[{ contactRequests: false }], [{ contactRequests: 'true' }], [{ contactRequests: true, email: 'x@example.test' }]])('body %j is refused', async input => {
        const h = handler();
        expect((await h.handlers.handle(wire(input), 'accounts/lookup')).status).toBe(400);
        expect(h.contactRequests).not.toHaveBeenCalled();
    });

    test('a staff subject without the admin role is refused before the reader runs', async () => {
        const h = handler({ admin: uid(9) + ':' + uid(9) });
        const result = await h.handlers.handle(wire({ contactRequests: true }), 'accounts/lookup');
        expect(result.status).toBe(403);
        expect(h.contactRequests).not.toHaveBeenCalled();
    });

    test('revocation while reading withholds the rows', async () => {
        const service = { authorise: jest.fn(async actor => actor), capabilities: async () => ({}), lookup: async () => ({}) };
        const h = handler({ service, contactRequests: jest.fn(async () => {
            service.authorise.mockRejectedValue(Object.assign(new Error(), { statusCode: 403 })); return VIEW;
        }) });
        const result = await h.handlers.handle(wire({ contactRequests: true }), 'accounts/lookup');
        expect(result.status).toBe(403);
        expect(JSON.stringify(result)).not.toContain('owner@example.test');
    });

    test('a cross-site request is refused before the body or reader', async () => {
        const h = handler(), request = wire({ contactRequests: true });
        request.headers = { ...request.headers, origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' };
        expect((await h.handlers.handle(request, 'accounts/lookup')).status).toBe(403);
        expect(h.contactRequests).not.toHaveBeenCalled();
        expect((await readBody(request)).length).toBeGreaterThan(0);
    });
});

describe('reader', () => {
    const tenant = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    function fakePool(rowsByTenant, { failOn = null, rollbackFails = false } = {}) {
        const log = [], released = [];
        let tenantSetting = null;
        const client = { async query(sql, values) {
            log.push([sql, values]);
            if (sql === 'ROLLBACK' && rollbackFails) throw new Error('rollback');
            if (sql.startsWith("SELECT set_config('nofries.tenant_id'")) { tenantSetting = values[0]; return { rows: [] }; }
            if (sql.includes('FROM nofries.dashboard_contact_requests')) {
                if (failOn === values[0]) throw new Error('PRIVATE_DRIVER_MESSAGE');
                expect(values[0]).toBe(tenantSetting);
                return { rows: rowsByTenant[values[0]] || [] };
            }
            return { rows: [] };
        }, release(discard) { released.push(discard); } };
        return { pool: { connect: jest.fn(async () => client) }, log, released };
    }
    const accounts = rows => jest.fn(async () => ({ rows, truncated: false }));
    const owner = { readable: true, email: 'owner@example.test', subjectKey: 'owner-subject',
        scopes: [{ tenantId: tenant(1), name: 'Alpha (blob)' }, { tenantId: tenant(2), name: 'Client (blob)' }] };
    const now = () => Date.parse('2026-11-19T00:00:00Z');

    test('reads each listed tenant in one READ ONLY transaction and resolves the requester or the owner', async () => {
        const { pool, log, released } = fakePool({
            [tenant(1)]: [{ subject_key: 'owner-subject', topic: 'results', requested_at: new Date('2026-11-18T22:30:00Z'), display_name: 'Alpha Ltd' }],
            [tenant(2)]: [{ subject_key: 'someone-else', topic: 'no_such_topic', requested_at: new Date('2026-11-19T00:00:00Z'), display_name: null }] });
        const list = accounts([owner, { readable: true, email: 'x@example.test', subjectKey: null, scopes: [{ tenantId: 'not-a-uuid', name: 'Bad' }] }]);
        const view = await createContactRequestReader({ list, pool, now })(signal());
        expect(list).toHaveBeenCalledWith(expect.anything(), false, true);
        expect(view).toEqual({ truncated: false, windowDays: 90, rows: [
            { requestedAt: '2026-11-19T00:00:00.000Z', organisation: 'Client (blob)', topic: 'Other', contactEmail: 'owner@example.test', contactBasis: 'account' },
            { requestedAt: '2026-11-18T22:30:00.000Z', organisation: 'Alpha Ltd', topic: 'Results', contactEmail: 'owner@example.test', contactBasis: 'requester' }] });
        expect(log[0][0]).toBe('BEGIN READ ONLY');
        expect(log.at(-1)[0]).toBe('COMMIT');
        expect(log.filter(([sql]) => /^(INSERT|UPDATE|DELETE)/i.test(sql.trim()))).toEqual([]);
        expect(log.filter(([sql]) => sql.includes('FROM nofries.dashboard_contact_requests')).map(([, values]) => values))
            .toEqual([[tenant(1), '2026-08-21T00:00:00.000Z'], [tenant(2), '2026-08-21T00:00:00.000Z']]);
        expect(released).toEqual([false]);
    });

    test.each([[{ readable: false }], [{ ...{ readable: true, email: 'c@example.test', subjectKey: null, scopes: [] }, organisationsComplete: false }]])('an incomplete account scan (%j) is reported as truncated', async partial => {
        const { pool } = fakePool({});
        const view = await createContactRequestReader({ list: accounts([partial]), pool, now })(signal());
        expect(view).toEqual({ rows: [], truncated: true, windowDays: 90 });
    });

    test('no listed organisations: no database connection', async () => {
        const { pool } = fakePool({});
        expect(await createContactRequestReader({ list: accounts([]), pool, now })(signal())).toEqual({ rows: [], truncated: false, windowDays: 90 });
        expect(pool.connect).not.toHaveBeenCalled();
    });

    test('caps rows and tenants and reports truncation', async () => {
        const many = Array.from({ length: MAX_TENANTS + 1 }, (_, i) => ({ tenantId: tenant(i + 1), name: `Org ${i}` }));
        const rows = Array.from({ length: 101 }, (_, i) => ({ subject_key: 's', topic: 'results', requested_at: new Date(Date.parse('2026-11-01T00:00:00Z') + i * 60000), display_name: 'Org' }));
        const { pool, log } = fakePool({ [tenant(1)]: rows, [tenant(2)]: rows, [tenant(3)]: rows });
        const view = await createContactRequestReader({ list: accounts([{ ...owner, scopes: many }]), pool, now })(signal());
        expect(view.truncated).toBe(true);
        expect(view.rows).toHaveLength(MAX_ROWS);
        expect(view.rows[0].requestedAt >= view.rows.at(-1).requestedAt).toBe(true);
        expect(log.filter(([sql]) => sql.includes('FROM nofries.dashboard_contact_requests'))).toHaveLength(MAX_TENANTS);
    });

    test('a database failure rolls back, discards the client if rollback fails, and leaks no driver text', async () => {
        const { pool, log, released } = fakePool({}, { failOn: tenant(2), rollbackFails: true });
        const error = await createContactRequestReader({ list: accounts([owner]), pool, now })(signal()).catch(caught => caught);
        expect(error).toBeInstanceOf(Error);
        expect(log.at(-1)[0]).toBe('ROLLBACK');
        expect(released).toEqual([true]);
    });

    test('an aborted request does not query', async () => {
        const { pool } = fakePool({}), controller = new AbortController(); controller.abort();
        await expect(createContactRequestReader({ list: accounts([owner]), pool, now })(controller.signal)).rejects.toBeDefined();
        expect(pool.connect).not.toHaveBeenCalled();
    });

    test('rejects an unusable composition', () => {
        expect(() => createContactRequestReader({ list: null, pool: { connect() {} } })).toThrow('dashboard_admin_configuration_invalid');
        expect(() => createContactRequestReader({ list: () => {}, pool: null })).toThrow('dashboard_admin_configuration_invalid');
    });
});

describe('account list scopes', () => {
    const TENANT = uid(1), NOW = Date.parse('2026-11-14T03:00:00.000Z');
    const SLOT_IDS = ['tenantId', 'organisationId', 'grantId', 'scheduleId', 'activationId', 'bootstrapOperationId', 'acceptOperationId',
        'publicationOperationId', 'bindingId', 'authorityId', 'membershipId', 'admissionOperationId'];
    const source = { schemaVersion: 1, kind: 'external_starter', storageAccount: 'syntheticstore', container: 'synthetic-external',
        providerKind: 'external-id', providerTenantId: TENANT, providerConfigurationSha256: '1'.repeat(64) };
    function fixture() {
        const plan = approvedStarterPlan(), subjectKey = TENANT + ':' + uid(500), email = 'customer@example.test';
        const slot = { requestId: uid(101), kind: 'own', organisationName: 'Synthetic org', ...Object.fromEntries(SLOT_IDS.map((key, i) => [key, uid(110 + i)])) };
        const at = new Date(NOW + 1000).toISOString();
        const record = starterAccountRecord({ schemaVersion: 1, accountId: uid(100), planId: plan.planId, planSha256: plan.sha256, email,
            accountType: 'company', setupRequestId: slot.requestId, setupSha256: 'a'.repeat(64), createdAt: new Date(NOW).toISOString(),
            activation: { subjectKey, receiptId: uid(150), activatedAt: at, validUntil: accountWindow(at, plan.planId).validUntil },
            organisations: [slot], identitySubjectKey: subjectKey });
        const authority = { schemaVersion: 1, subjectKey, email, revision: 1, status: 'active', invitationDigest: 'b'.repeat(64), invitationId: 'synthetic-invite',
            tenantId: slot.tenantId, organisationId: slot.organisationId, termsVersion: 'synthetic-terms', termsDigest: 'c'.repeat(64), bindingId: null,
            accountType: 'company', expiresAt: NOW - 1000 };
        const blobs = new Map([['customer-starter/' + starterAccountKey(email) + '.json', record], [`customer-subjects/${subjectHash(subjectKey)}.json`, authority]]);
        const container = {
            listBlobsFlat({ prefix }) { return (async function* () { for (const name of [...blobs.keys()].filter(key => key.startsWith(prefix))) yield { name, properties: {} }; }()); },
            getBlockBlobClient(name) { return { async download() {
                if (!blobs.has(name)) throw Object.assign(new Error(), { statusCode: 404, code: 'BlobNotFound' });
                const bytes = Buffer.from(JSON.stringify(blobs.get(name)));
                return { etag: '"e"', contentLength: bytes.length, readableStreamBody: Readable.from([bytes]) };
            } }; } };
        return { list: createAccountListReader([{ source, container }], () => NOW), subjectKey, slot };
    }

    test('tenant ids and subjects are added only for the server-side caller', async () => {
        const { list, subjectKey, slot } = fixture();
        const plain = await list(signal(), true);
        expect(JSON.stringify(plain)).not.toContain('"scopes"');
        expect(plain.rows[0]).not.toHaveProperty('subjectKey');
        const scoped = await list(signal(), false, true);
        expect(scoped.rows[0]).toMatchObject({ subjectKey, scopes: [{ tenantId: slot.tenantId, name: 'Synthetic org' }] });
        expect(scoped.rows[0]).not.toHaveProperty('selector');
    });
});

describe('production composition', () => {
    const { createStaffDashboardAdministration, CONTACT_REQUESTS_SETTING } = require('../lib/dashboardAdminStaffProduction');
    const base = () => ({ NOFRIES_STAFF_CONSOLE: 'true', NOFRIES_DASHBOARD_ADMIN_ACCOUNT_LOOKUP: 'true', NOFRIES_SCOPE_SIGNING_SECRET: 'k'.repeat(32),
        AZURE_STORAGE_ACCOUNT_NAME: 'syntheticdata', NOFRIES_BROWSER_AUTH_STORAGE_ACCOUNT: 'syntheticauth', NOFRIES_DASHBOARD_PROOF_CONTAINER: 'dashboard-proofs',
        NOFRIES_DASHBOARD_EPOCH_CONTAINER: 'dashboard-epochs', NOFRIES_DASHBOARD_ADMIN_AUDIT_CONTAINER: 'admin-audit', NOFRIES_ENTRA_TENANT_ID: uid(1),
        NOFRIES_EXTERNAL_CUSTOMER_TENANT_ID: uid(2), NOFRIES_EXTERNAL_CUSTOMER_AUTHORITY_CONTAINER: 'external-signups' });
    const sdk = { ManagedIdentityCredential: function () {}, BlobServiceClient: class { getContainerClient() { return {}; } } };
    const { MemoryBrowserSessionStore } = require('../api/shared/browserSessionStore');
    const authEnv = { NOFRIES_REQUIRE_AUTH: 'true', NOFRIES_PUBLIC_URL: 'https://staff-console.invalid', NOFRIES_ENTRA_TENANT_ID: uid(1), NOFRIES_ENTRA_CLIENT_ID: uid(6),
        NOFRIES_ENTRA_CLIENT_SECRET: 'synthetic-staff-console-secret', NOFRIES_ALLOWED_SUBJECTS: uid(1) + ':' + uid(7), NOFRIES_ADMIN_SUBJECTS: uid(1) + ':' + uid(7) };
    const dashboard = pool => ({ browserAuthOptions: { env: authEnv, store: new MemoryBrowserSessionStore() },
        identityPolicy: { policyId: 'synthetic-policy', policyRevision: 1, issuer: 'https://login.microsoftonline.com/' + uid(1) + '/v2.0', identityTenantId: uid(1), audience: uid(6) },
        proofStore: { createOriginalProof: async () => {}, readOriginalProof: async () => null }, clock: () => '2026-11-19T00:00:00.000Z',
        readExternalRuntimeEpoch: async () => ({}), newRequestId: () => uid(3), requestBudgetMs: 30000, pool, instanceId: uid(4),
        historyBudget: { maxRecords: 4096, maxBytes: 67108864, maxDurationMs: 60000 }, newId: () => uid(5) });
    const pool = { connect: async () => { throw new Error('PRIVATE_UNEXPECTED_SQL'); }, end: async () => {} };

    test('exactly true composes the reader; anything else leaves it out', () => {
        expect(CONTACT_REQUESTS_SETTING).toBe('NOFRIES_OPERATOR_CONTACT_REQUESTS_ENABLED');
        const on = createStaffDashboardAdministration({ ...base(), [CONTACT_REQUESTS_SETTING]: 'true' }, dashboard(pool), sdk);
        expect(typeof on.dashboardAdminAccountLookup.contactRequests).toBe('function');
        for (const value of [undefined, 'false', 'True', '1']) {
            const off = createStaffDashboardAdministration({ ...base(), ...(value === undefined ? {} : { [CONTACT_REQUESTS_SETTING]: value }) }, dashboard(pool), sdk);
            expect(off.dashboardAdminAccountLookup).toBeDefined();
            expect(off.dashboardAdminAccountLookup).not.toHaveProperty('contactRequests');
        }
    });

    test('an unusable pool leaves only the list off, with one safe log line', () => {
        const warn = jest.spyOn(console, 'warn');
        const result = createStaffDashboardAdministration({ ...base(), [CONTACT_REQUESTS_SETTING]: 'true' }, dashboard({ connect: 'not a function', end: async () => {} }), sdk);
        expect(result.dashboardAdminAccountLookup).toBeDefined();
        expect(result.dashboardAdminAccountLookup).not.toHaveProperty('contactRequests');
        expect(warn).toHaveBeenCalledWith('[dashboard-admin-contact-requests] dashboard_admin_unavailable');
    });
});
