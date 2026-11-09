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
const origin = 'https://operator.example.test';
const env = { NOFRIES_PUBLIC_URL: origin };
const wire = (input = { email }, method = 'POST') => Object.assign(Readable.from([Buffer.from(JSON.stringify(input))]), {
    method, url: '/api/dashboard-admin/accounts/lookup', headers: { 'content-type': 'application/json', origin, 'sec-fetch-site': 'same-origin' }
});
const readJson = async request => { const chunks = []; for await (const chunk of request) chunks.push(chunk); return JSON.parse(Buffer.concat(chunks)); };
const allowedService = () => ({ authorise: jest.fn(async actor => actor), capabilities: async () => ({}), lookup: async () => ({}) });
const signal = () => new AbortController().signal;
function reader(records, overrides = {}) {
    const entries = records.map((r, i) => ({ name: `customer-subjects/${subjectHash(r.subjectKey)}.json`, record: r }));
    const container = { async *listBlobsFlat() { yield* entries; }, getBlockBlobClient(name) {
        return { async download() { const bytes = Buffer.from(JSON.stringify(entries.find(e => e.name === name).record));
            return { etag: '"test-etag"', contentLength: bytes.length, readableStreamBody: Readable.from([bytes]) }; } };
    }, ...overrides };
    const read = createAccountLookupReader([{ source, container }], () => now);
    return (email, signal, authorise = async () => identity) => read(email, signal, authorise);
}
function handler(overrides = {}, readOperatorSession = async () => ({ identity }), read = jest.fn(async () => []), service = allowedService(), signupListService = null) {
    return { read, handler: createDashboardAdminHandlers({ service, signupListService, accountLookupReader: read, readOperatorSession,
        env: { ...env, NOFRIES_REQUIRE_AUTH: 'true', NOFRIES_ENTRA_TENANT_ID: uid(1), NOFRIES_ALLOWED_SUBJECTS: subject,
            NOFRIES_ADMIN_SUBJECTS: subject, NOFRIES_DASHBOARD_ADMIN_ACCOUNT_LOOKUP: 'true', ...overrides } }) };
}
afterEach(() => jest.restoreAllMocks());

test('denied service authority blocks lookup and capabilities before body or storage; signup grants cannot substitute', async () => {
    jest.spyOn(console, 'info').mockImplementation(() => {});
    const { createDashboardAdminService } = require('../api/shared/dashboardAdmin/service');
    const service = createDashboardAdminService({ authoriseOperator: async () => false, readAuthoritySnapshot: null,
        audit: async () => true, clock: () => new Date(now).toISOString(), requestBudgetMs: 1000 });
    const signups = { authorise: async () => true, capabilities: async () => ({}), list: async () => [], authoriseDisclosure: async () => true };
    const h = handler({}, undefined, undefined, service, signups), req = wire(), on = jest.spyOn(req, 'on');
    expect((await h.handler.handle(req, 'accounts/lookup')).status).toBe(403);
    expect(on).not.toHaveBeenCalled(); expect(h.read).not.toHaveBeenCalled();
    expect((await handler({}, undefined, undefined, service).handler.handle(wire({}, 'GET'), 'capabilities')).status).toBe(403);
});
test.each(['entry', 'entry.js', 'entry-capabilities', 'accounts/lookup', 'accounts/app.js'])('reader-only configuration keeps %s unavailable', async route => {
    jest.spyOn(console, 'info').mockImplementation(() => {});
    const h = handler({}, undefined, undefined, null);
    expect((await h.handler.handle(wire({}, route === 'accounts/lookup' ? 'POST' : 'GET'), route)).status).toBe(503);
    expect(h.read).not.toHaveBeenCalled();
});
test('service revocation during storage withholds results', async () => {
    jest.spyOn(console, 'info').mockImplementation(() => {});
    const service = allowedService(), h = handler({}, undefined, async () => {
        service.authorise.mockRejectedValue(Object.assign(new Error(), { statusCode: 403 })); return [record];
    }, service);
    const result = await h.handler.handle(wire(), 'accounts/lookup');
    expect(result.status).toBe(403); expect(JSON.stringify(result)).not.toContain(email);
});
test('foreign, absent and noncanonical origins fail before body reads and cannot consume the lookup budget', async () => {
    jest.spyOn(console, 'info').mockImplementation(() => {});
    const h = handler();
    for (const [originValue, site] of Array.from({ length: 4 }, () => [['https://evil.example', 'cross-site'], ['', 'same-origin'],
        [origin + '/', 'same-origin'], [origin, 'same-site']]).flat()) {
        const req = wire(); Object.assign(req.headers, { origin: originValue, 'sec-fetch-site': site });
        const on = jest.spyOn(req, 'on');
        expect((await h.handler.handle(req, 'accounts/lookup')).status).toBe(403); expect(on).not.toHaveBeenCalled();
    }
    expect(h.read).not.toHaveBeenCalled(); expect((await h.handler.handle(wire(), 'accounts/lookup')).status).toBe(200);
});
test('queries, malformed JSON, oversized and non-JSON bodies fail without storage', async () => {
    jest.spyOn(console, 'info').mockImplementation(() => {});
    const h = handler(), query = wire(); query.url += '?email=' + encodeURIComponent(email);
    // Keep genuine streams, exercising the shared bounded parser rather than parsed request.body.
    const badJson = Readable.from([Buffer.from('{')]); Object.assign(badJson, { method: 'POST', url: wire().url, headers: wire().headers });
    const huge = wire(); huge.headers['content-length'] = '2049';
    const form = wire(); form.headers['content-type'] = 'application/x-www-form-urlencoded';
    for (const [req, status] of [[query, 400], [badJson, 400], [huge, 413], [form, 415]]) {
        expect((await h.handler.handle(req, 'accounts/lookup')).status).toBe(status);
    }
    expect(h.read).not.toHaveBeenCalled();
});

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
test.each(['deny target', 'revoke target before disclosure'])('scoped authority: %s withholds matching account data', async mode => {
    jest.spyOn(console, 'info').mockImplementation(() => {});
    const service = allowedService(); let scopedCalls = 0;
    service.authorise.mockImplementation(async (actor, selector) => {
        if (selector && (++scopedCalls > 1 || mode === 'deny target')) throw Object.assign(new Error(), { statusCode: 403 });
        return actor;
    });
    const h = handler({}, undefined, reader([record]), service), result = await h.handler.handle(wire(), 'accounts/lookup');
    expect(result.status).toBe(403); expect(JSON.stringify(result.body)).not.toMatch(/customer@|private|organisationId/);
    expect(service.authorise).toHaveBeenCalledWith(identity, { provider: 'legacy', subjectKey: subject, tenantId: uid(3), organisationId: uid(4) });
});
test('authorised same-origin POST preserves projected lookup results and checks their scope before disclosure', async () => {
    jest.spyOn(console, 'info').mockImplementation(() => {});
    const service = allowedService(), h = handler({}, undefined, reader([record]), service);
    const response = await h.handler.handle(wire(), 'accounts/lookup');
    expect(response.status).toBe(200); expect(response.body.rows[0]).toMatchObject({ email, status: 'active', revision: 7 });
    expect(service.authorise.mock.calls.filter(([, selector]) => selector !== null)).toHaveLength(2);
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
test('lookup is POST-only, validates JSON, rate limits and audits without email or raw details', async () => {
    const audit = jest.fn(), read = jest.fn(reader([record]));
    const handle = createAccountLookup({ read, readJson, env, audit, now: () => now });
    const run = request => handle(request, 'accounts/lookup', async () => identity, signal());
    expect((await run(wire({}, 'GET'))).status).toBe(405);
    for (const input of [{ email: 'x' }, { email: [] }, { email, extra: 1 }]) expect((await run(wire(input))).status).toBe(400);
    const good = await run(wire({ email: ' CUSTOMER@EXAMPLE.TEST ' }));
    expect(good.status).toBe(200); expect(good.headers['Cache-Control']).toContain('no-store');
    for (let i = 0; i < 6; i++) expect((await run(wire())).status).toBe(200);
    expect((await run(wire())).status).toBe(429);
    expect(audit).toHaveBeenCalledTimes(12);
    expect(JSON.stringify(audit.mock.calls)).not.toMatch(/customer@|private|subjectKey|invitation/);
});
test('safe errors and audit failure prevent disclosure', async () => {
    for (const options of [{ read: async () => { throw new Error('private-provider-token'); }, audit: jest.fn() },
        { read: async () => [record], audit: () => { throw new Error('audit-down'); } }]) {
        const result = await createAccountLookup({ ...options, readJson, env })(wire(), 'accounts/lookup', async () => identity, signal());
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
    expect(await read(email, signal(), async () => identity)).toEqual([{ email, accountType: 'company', organisation: 'Synthetic organisation', status: 'missing', expiresAt: null, revision: null }]);
    expect(load).toHaveBeenCalledTimes(1);
    await expect(read(email, signal(), async () => { throw Object.assign(new Error(), { statusCode: 403 }); })).rejects.toMatchObject({ statusCode: 403 });
    load.mockResolvedValue({ record: { accountType: 'company', activation: null, organisations: [{ organisationName: 'Private pending signup' }] } });
    const authorise = jest.fn();
    expect(await read(email, signal(), authorise)).toEqual([{ email, accountType: null, organisation: null, status: 'missing', expiresAt: null, revision: null }]);
    expect(authorise).not.toHaveBeenCalled();
});
test('host routes stay default-off including method and trailing-path variants', async () => {
    const request = require('supertest'), { createNoFriesApp } = require('../server');
    for (const path of ['lookup', 'lookup/', 'app.js']) {
        const result = await request(createNoFriesApp()).post('/api/dashboard-admin/accounts/' + path).send({ email });
        expect(result.status).toBe(404); expect(result.headers['cache-control']).toContain('no-store');
    }
});
