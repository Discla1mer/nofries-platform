'use strict';
const { Readable } = require('node:stream');
const { createDashboardAdminHandlers } = require('../api/shared/dashboardAdmin/handlers');
const { createAccountLookup } = require('../api/shared/dashboardAdmin/accountLookup');
const { createAccountLookupReader, createProductionAccountLookup } = require('../api/shared/dashboardAdmin/accountLookupStore');
const { subjectHash } = require('../api/shared/customerSignup/customerAuthority');
const uid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const subject = uid(1) + ':' + uid(2), email = 'customer@example.test', now = Date.parse('2026-11-09T12:00:00Z');
const identity = { provider: 'entra-bff', isAuthenticated: true, subjectKey: subject, tenantId: uid(1), principalId: uid(2) };
const source = { schemaVersion: 1, kind: 'legacy_admin', storageAccount: 'syntheticstore', container: 'synthetic-authority',
    providerKind: 'workforce-b2b', providerTenantId: uid(1), providerConfigurationSha256: '1'.repeat(64) };
const record = { schemaVersion: 1, subjectKey: subject, email, revision: 7, status: 'active', expiresAt: now + 1000,
    invitationDigest: '2'.repeat(64), invitationId: 'private-invitation', tenantId: uid(3), organisationId: uid(4),
    termsVersion: 'private-terms', termsDigest: '3'.repeat(64), bindingId: null, accountType: 'company' };
const wire = (query = 'email=' + email, method = 'GET') => ({ method, url: '/api/dashboard-admin/accounts/lookup?' + query, headers: {} });
const signal = () => new AbortController().signal;
function reader(records, overrides = {}) {
    const entries = records.map((r, i) => ({ name: `customer-subjects/${subjectHash(r.subjectKey)}.json`, record: r }));
    const container = { async *listBlobsFlat() { yield* entries; }, getBlockBlobClient(name) {
        return { async download() { const bytes = Buffer.from(JSON.stringify(entries.find(e => e.name === name).record));
            return { etag: '"test-etag"', contentLength: bytes.length, readableStreamBody: Readable.from([bytes]) }; } };
    }, ...overrides };
    return createAccountLookupReader([{ source, container }], () => now);
}
function handler(env = {}, readOperatorSession = async () => ({ identity }), read = jest.fn(async () => [])) {
    return { read, handler: createDashboardAdminHandlers({ accountLookupReader: read, readOperatorSession,
        env: { NOFRIES_REQUIRE_AUTH: 'true', NOFRIES_ENTRA_TENANT_ID: uid(1), NOFRIES_ALLOWED_SUBJECTS: subject,
            NOFRIES_ADMIN_SUBJECTS: subject, NOFRIES_DASHBOARD_ADMIN_ACCOUNT_LOOKUP: 'true', ...env } }) };
}
afterEach(() => jest.restoreAllMocks());

test.each([undefined, 'false', 'TRUE', '1'])('flag %s is off before authentication or storage', async flag => {
    const h = handler({ NOFRIES_DASHBOARD_ADMIN_ACCOUNT_LOOKUP: flag }, () => { throw new Error('must not read session'); });
    expect((await h.handler.handle(wire(), 'accounts/lookup')).status).toBe(404);
    expect(h.read).not.toHaveBeenCalled();
    expect(createProductionAccountLookup({ NOFRIES_DASHBOARD_ADMIN_ACCOUNT_LOOKUP: flag })).toBeNull();
});
test.each([null, { ...identity, provider: 'external-id' }, { ...identity, subjectKey: uid(1) + ':' + uid(9), principalId: uid(9) }])(
    'anonymous/customer/nonstaff is rejected without storage', async actor => {
        jest.spyOn(console, 'info').mockImplementation(() => {});
        const h = handler({}, async () => ({ identity: actor }));
        expect([401, 403]).toContain((await h.handler.handle(wire(), 'accounts/lookup')).status);
        expect(h.read).not.toHaveBeenCalled();
    });
test('non-admin staff and forged SWA principal cannot bypass BFF role checks', async () => {
    jest.spyOn(console, 'info').mockImplementation(() => {});
    const h = handler({ NOFRIES_ADMIN_SUBJECTS: uid(1) + ':' + uid(9) });
    const request = wire(); request.headers['x-ms-client-principal'] = Buffer.from(JSON.stringify({ userRoles: ['admin'] })).toString('base64');
    expect((await h.handler.handle(request, 'accounts/lookup')).status).toBe(403);
    expect(h.read).not.toHaveBeenCalled();
});
test('revocation during I/O withholds buffered results', async () => {
    jest.spyOn(console, 'info').mockImplementation(() => {});
    let signedIn = true;
    const h = handler({}, async () => ({ identity: signedIn ? identity : null }), async () => { signedIn = false; return [record]; });
    const response = await h.handler.handle(wire(), 'accounts/lookup');
    expect(response.status).toBe(401); expect(JSON.stringify(response)).not.toContain(email);
});
test.each([['active', now + 1000, 'active'], ['active', now, 'expired'], ['revoked', now + 1000, 'revoked'], ['revoked', now - 1, 'revoked']])(
    'maps %s at %s to %s and only discloses allowlisted fields', async (status, expiresAt, expected) => {
        const rows = await reader([{ ...record, status, expiresAt }, { ...record, subjectKey: uid(1) + ':' + uid(8), email: 'other@example.test' }])(email, signal());
        expect(rows).toEqual([{ email, accountType: 'company', organisation: uid(4), status: expected, expiresAt: new Date(expiresAt).toISOString(), revision: 7 }]);
        expect(JSON.stringify(rows)).not.toMatch(/private|other@|invitation|subjectKey|bindingId|Digest/);
    });
test('absent, malformed and mismatched subjects map to missing without raw fields', async () => {
    for (const records of [[], [{ ...record, secret: 'private-token' }], [{ ...record, subjectKey: uid(9) + ':' + uid(2) }]]) {
        expect(await reader(records)(email, signal())).toEqual([{ email, accountType: null, organisation: null, status: 'missing', expiresAt: null, revision: null }]);
    }
});
test('bounded scans and storage failures never pretend to be missing', async () => {
    await expect(reader(Array.from({ length: 101 }, (_, i) => ({ ...record, subjectKey: uid(1) + ':' + uid(i + 10) })))(email, signal())).rejects.toThrow();
    await expect(reader([], { async *listBlobsFlat() { throw new Error('private-provider'); } })(email, signal())).rejects.toThrow();
});
test('lookup is GET-only, validates queries, rate limits and audits without email or raw details', async () => {
    const audit = jest.fn(), read = jest.fn(reader([record]));
    const handle = createAccountLookup({ read, audit, now: () => now });
    const run = request => handle(request, 'accounts/lookup', async () => identity, signal());
    expect((await run(wire('', 'POST'))).status).toBe(405);
    for (const query of ['email=x', 'email=a@b.test&email=c@d.test', 'email=a@b.test&extra=1']) expect((await run(wire(query))).status).toBe(400);
    const good = await run(wire('email=%20CUSTOMER%40EXAMPLE.TEST%20'));
    expect(good.status).toBe(200); expect(good.headers['Cache-Control']).toContain('no-store');
    for (let i = 0; i < 6; i++) expect((await run(wire())).status).toBe(200);
    expect((await run(wire())).status).toBe(429);
    expect(audit).toHaveBeenCalledTimes(12);
    expect(JSON.stringify(audit.mock.calls)).not.toMatch(/customer@|private|subjectKey|invitation/);
});
test('safe errors and audit failure prevent disclosure', async () => {
    for (const options of [{ read: async () => { throw new Error('private-provider-token'); }, audit: jest.fn() },
        { read: async () => [record], audit: () => { throw new Error('audit-down'); } }]) {
        const result = await createAccountLookup(options)(wire(), 'accounts/lookup', async () => identity, signal());
        expect(result.status).toBe(503); expect(result.body).toEqual({ code: 'dashboard_admin_account_lookup_503' });
    }
});
test('known signup with absent or mismatched authority remains missing', async () => {
    const { AzureStarterAccountStore } = require('../api/shared/customerSignup/azureStarterAccountStore');
    const load = jest.spyOn(AzureStarterAccountStore.prototype, 'load').mockResolvedValue({ record: {
        identitySubjectKey: subject, accountType: 'company', organisations: [{ tenantId: uid(3), organisationId: uid(4), organisationName: 'Synthetic organisation' }]
    } });
    const container = { async *listBlobsFlat() {}, getBlockBlobClient() {} };
    const read = createAccountLookupReader([{ source: { ...source, kind: 'legacy_starter' }, container }], () => now);
    expect(await read(email, signal())).toEqual([{ email, accountType: 'company', organisation: 'Synthetic organisation', status: 'missing', expiresAt: null, revision: null }]);
    expect(load).toHaveBeenCalledTimes(1);
});
test('host routes stay default-off including method and trailing-path variants', async () => {
    const request = require('supertest'), { createNoFriesApp } = require('../server');
    for (const path of ['lookup', 'lookup/', 'app.js']) {
        const result = await request(createNoFriesApp()).get('/api/dashboard-admin/accounts/' + path + '?email=' + email);
        expect(result.status).toBe(404); expect(result.headers['cache-control']).toContain('no-store');
    }
});
