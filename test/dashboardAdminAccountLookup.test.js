'use strict';
const { Readable } = require('node:stream');
const { createDashboardAdminHandlers } = require('../api/shared/dashboardAdmin/handlers');
const { createAccountLookup } = require('../api/shared/dashboardAdmin/accountLookup');
const { createAccountLookupReader } = require('../api/shared/dashboardAdmin/accountLookupStore');
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
const base = { email, kind: 'legacy_admin', schemaVersion: null, plan: null, accountType: null,
    organisation: null, status: 'missing', effectiveAt: null, expiresAt: null, revision: null };
const wire = (input = { email }, method = 'POST') => Object.assign(Readable.from([Buffer.from(JSON.stringify(input))]), {
    method, url: '/api/dashboard-admin/accounts/lookup', headers: { 'content-type': 'application/json', origin, 'sec-fetch-site': 'same-origin' }
});
const readJson = async request => { const chunks = []; for await (const chunk of request) chunks.push(chunk); return JSON.parse(Buffer.concat(chunks)); };
const allowedService = () => ({ authorise: jest.fn(async actor => actor), capabilities: async () => ({}), lookup: async () => ({}) });
const signal = () => new AbortController().signal;
function reader(records, overrides = {}, kind = 'legacy_admin') {
    const entries = records.map(r => ({ name: `customer-subjects/${subjectHash(r.subjectKey)}.json`, record: r }));
    const container = { async *listBlobsFlat() { yield* entries; }, getBlockBlobClient(name) {
        return { async download() { const bytes = Buffer.from(JSON.stringify(entries.find(e => e.name === name).record));
            return { etag: '"test-etag"', contentLength: bytes.length, readableStreamBody: Readable.from([bytes]) }; } };
    }, ...overrides };
    return createAccountLookupReader([{ source: { ...source, kind }, container }], () => now);
}
function handler(overrides = {}, readOperatorSession = async () => ({ identity }), read = jest.fn(async () => ({ rows: [], truncated: false })), service = allowedService(), signupListService = null) {
    const audit = jest.fn(async () => {});
    return { read, audit, handler: createDashboardAdminHandlers({ service, signupListService, accountLookupReader: { read, audit }, readOperatorSession,
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
        service.authorise.mockRejectedValue(Object.assign(new Error(), { statusCode: 403 })); return { rows: [{ ...base, status: 'active' }], truncated: false };
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
    const badJson = Readable.from([Buffer.from('{')]); Object.assign(badJson, { method: 'POST', url: wire().url, headers: wire().headers });
    const huge = wire(); huge.headers['content-length'] = '2049';
    const form = wire(); form.headers['content-type'] = 'application/x-www-form-urlencoded';
    for (const [req, status] of [[query, 400], [badJson, 400], [huge, 413], [form, 415]]) {
        expect((await h.handler.handle(req, 'accounts/lookup')).status).toBe(status);
    }
    expect(h.read).not.toHaveBeenCalled();
});
test.each([undefined, 'false', 'TRUE', '1'])('lookup route flag %s keeps email lookup off before authentication or storage', async flag => {
    const h = handler({ NOFRIES_DASHBOARD_ADMIN_ACCOUNT_LOOKUP: flag }, () => { throw new Error('must not read session'); });
    expect((await h.handler.handle(wire(), 'accounts/lookup')).status).toBe(404);
    expect((await h.handler.handle(wire({}, 'GET'), 'accounts/app.js')).status).toBe(404);
    expect(h.read).not.toHaveBeenCalled();
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
    const h = handler({}, async () => ({ identity: signedIn ? identity : null }), async () => { signedIn = false; return { rows: [{ ...base }], truncated: false }; });
    const response = await h.handler.handle(wire(), 'accounts/lookup');
    expect(response.status).toBe(401); expect(JSON.stringify(response)).not.toContain(email);
});
test.each([['active', now + 1000, 'active'], ['active', now, 'expired'], ['revoked', now + 1000, 'revoked'], ['revoked', now - 1, 'revoked']])(
    'maps %s at %s to %s and only discloses allowlisted fields', async (status, expiresAt, expected) => {
        const result = await reader([{ ...record, status, expiresAt }, { ...record, subjectKey: uid(1) + ':' + uid(8), email: 'other@example.test' }])(email, signal());
        expect(result).toEqual({ truncated: false, rows: [{ ...base, schemaVersion: 1, accountType: 'company', organisation: uid(4), status: expected,
            expiresAt: new Date(expiresAt).toISOString(), revision: 7 }] });
        expect(JSON.stringify(result)).not.toMatch(/private|other@|invitation|subjectKey|bindingId|Digest/);
    });
test('authorised same-origin POST authorises before and after storage and returns the reader result unchanged', async () => {
    jest.spyOn(console, 'info').mockImplementation(() => {});
    const service = allowedService(), h = handler({}, undefined, reader([record]), service);
    const response = await h.handler.handle(wire(), 'accounts/lookup');
    expect(response.status).toBe(200); expect(response.body.truncated).toBe(false);
    expect(response.body.rows[0]).toMatchObject({ email, status: 'active', revision: 7, kind: 'legacy_admin' });
    expect(JSON.stringify(response.body)).not.toMatch(/synthetic-authority|container/);
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ status: 200, count: 1, truncated: false, targetSha256: expect.stringMatching(/^[0-9a-f]{64}$/) }));
    expect(h.audit.mock.calls[0][0].targetSha256).not.toBe(require('node:crypto').createHash('sha256').update(email).digest('hex'));
    // Staff authority is not scoped per customer: no selector reaches the policy.
    expect(service.authorise.mock.calls.every(([, selector]) => selector === null)).toBe(true);
    expect(service.authorise.mock.calls.length).toBeGreaterThanOrEqual(2);
});
test('absent, malformed and mismatched subjects produce no rows or unusable rows without raw fields', async () => {
    expect(await reader([])(email, signal())).toEqual({ rows: [], truncated: false });
    expect(await reader([{ ...record, secret: 'private-token' }])(email, signal())).toEqual({ rows: [base], truncated: false });
    expect(await reader([{ ...record, subjectKey: uid(9) + ':' + uid(2) }])(email, signal())).toEqual({ rows: [base], truncated: false });
});
test('bounded scans report the cap per source instead of a partial answer; storage failures never pretend to be missing', async () => {
    const many = Array.from({ length: 101 }, (_, i) => ({ ...record, subjectKey: uid(1) + ':' + uid(i + 10), email: `other${i}@example.test` }));
    expect(await reader(many)(email, signal())).toEqual({ rows: [], truncated: true });
    expect(await reader([record, ...many])(email, signal())).toMatchObject({ truncated: true, rows: [{ status: 'active' }] });
    await expect(reader([], { async *listBlobsFlat() { throw new Error('private-provider'); } })(email, signal())).rejects.toThrow();
    // A cap in one store does not hide a fully scanned starter account elsewhere.
    const { AzureStarterAccountStore } = require('../api/shared/customerSignup/azureStarterAccountStore');
    jest.spyOn(AzureStarterAccountStore.prototype, 'load').mockResolvedValue({ record: { planId: 'p', accountType: 'company', activation: null,
        organisations: [{ tenantId: uid(3), organisationId: uid(4), organisationName: 'Synthetic organisation' }] } });
    const container = records => ({ async *listBlobsFlat() { yield* records.map(r => ({ name: `customer-subjects/${subjectHash(r.subjectKey)}.json` })); },
        getBlockBlobClient(name) { return { async download() { const bytes = Buffer.from(JSON.stringify(records.find(r => name.includes(subjectHash(r.subjectKey)))));
            return { etag: '"e"', contentLength: bytes.length, readableStreamBody: Readable.from([bytes]) }; } }; } });
    const two = createAccountLookupReader([{ source, container: container(many) }, { source: { ...source, kind: 'legacy_starter', container: 'starter' }, container: container([]) }], () => now);
    expect(await two(email, signal())).toMatchObject({ truncated: true, rows: [{ kind: 'legacy_starter', status: 'missing', plan: 'p' }] });
});
test('lookup is POST-only, validates JSON, rate limits and audits without email or raw details', async () => {
    const audit = jest.fn(), read = jest.fn(reader([record]));
    const handle = createAccountLookup({ read, readJson, env, audit, now: () => now });
    expect(() => createAccountLookup({ read, readJson, env })).toThrow();
    const run = request => handle(request, 'accounts/lookup', async () => identity, signal());
    expect((await run(wire({}, 'GET'))).status).toBe(405);
    for (const input of [{ email: 'x' }, { email: [] }, { email, extra: 1 }]) expect((await run(wire(input))).status).toBe(400);
    const good = await run(wire({ email: ' CUSTOMER@EXAMPLE.TEST ' }));
    expect(good.status).toBe(200); expect(good.headers['Cache-Control']).toContain('no-store');
    for (let i = 0; i < 6; i++) expect((await run(wire())).status).toBe(200);
    expect((await run(wire())).status).toBe(429);
    expect(audit).toHaveBeenCalledTimes(12);
    expect(audit.mock.calls[4][0]).toMatchObject({ category: 'dashboard_admin_account_lookup', status: 200, count: 1, truncated: false,
        actorSha256: expect.stringMatching(/^[0-9a-f]{64}$/), targetSha256: expect.stringMatching(/^[0-9a-f]{64}$/), requestId: expect.any(String) });
    expect(audit.mock.calls[0][0]).toMatchObject({ status: 405, targetSha256: null });
    expect(JSON.stringify(audit.mock.calls)).not.toMatch(/customer@|private|subjectKey|invitation/);
});
test('safe errors, malformed reader results and audit failure prevent disclosure', async () => {
    for (const options of [{ read: async () => { throw new Error('private-provider-token'); }, audit: jest.fn() },
        { read: async () => [record], audit: jest.fn() },
        { read: async () => ({ rows: [base], truncated: false }), audit: () => { throw new Error('audit-down'); } }]) {
        const result = await createAccountLookup({ audit: jest.fn(), ...options, readJson, env })(wire(), 'accounts/lookup', async () => identity, signal());
        expect(result.status).toBe(503); expect(result.body).toEqual({ code: 'dashboard_admin_account_lookup_503' });
    }
});
test('starter metadata binds plan, effective date and organisation name to the matching subject record', async () => {
    const { AzureStarterAccountStore } = require('../api/shared/customerSignup/azureStarterAccountStore');
    const account = { identitySubjectKey: subject, planId: 'synthetic-plan', accountType: 'consultant', createdAt: '2026-01-01T00:00:00.000Z',
        activation: { subjectKey: subject, activatedAt: '2026-02-01T00:00:00.000Z' },
        organisations: [{ tenantId: uid(3), organisationId: uid(4), organisationName: 'Synthetic organisation' }] };
    const load = jest.spyOn(AzureStarterAccountStore.prototype, 'load').mockResolvedValue({ record: account });
    const starter = { ...base, kind: 'legacy_starter' };
    expect(await reader([record], {}, 'legacy_starter')(email, signal(), true)).toEqual({ truncated: false, rows: [{ ...starter, schemaVersion: 1,
        plan: 'synthetic-plan', accountType: 'consultant', organisation: 'Synthetic organisation', status: 'active', effectiveAt: '2026-02-01T00:00:00.000Z',
        expiresAt: new Date(record.expiresAt).toISOString(), revision: 7, selector: { provider: 'legacy', subjectKey: subject, tenantId: uid(3), organisationId: uid(4) } }] });
    // A starter account whose subject record is absent is shown without sign-in authority.
    expect(await reader([], {}, 'legacy_starter')(email, signal())).toEqual({ truncated: false, rows: [{ ...starter, plan: 'synthetic-plan',
        accountType: 'consultant', organisation: 'Synthetic organisation', effectiveAt: '2026-02-01T00:00:00.000Z' }] });
    // A subject record in another organisation keeps its own identifiers.
    expect((await reader([{ ...record, organisationId: uid(5) }], {}, 'legacy_starter')(email, signal())).rows[0]).toMatchObject({ plan: null, organisation: uid(5), status: 'active' });
    expect(load).toHaveBeenCalledTimes(3);
    load.mockRejectedValue(Object.assign(new Error('private-store'), { code: 'starter_store_unavailable' }));
    await expect(reader([], {}, 'legacy_starter')(email, signal())).rejects.toThrow();
});
test('host routes stay default-off including method and trailing-path variants', async () => {
    const request = require('supertest'), { createNoFriesApp } = require('../server');
    for (const path of ['lookup', 'lookup/', 'app.js']) {
        const result = await request(createNoFriesApp()).post('/api/dashboard-admin/accounts/' + path).send({ email });
        expect(result.status).toBe(404); expect(result.headers['cache-control']).toContain('no-store');
    }
    expect(() => createNoFriesApp({ dashboardAdminAccountLookup: { read: async () => ({ rows: [], truncated: false }), audit: async () => {} } })).toThrow();
});
test.each([undefined, 'false', 'true'])('selected-account selectors require the actions flag %s', async flag => {
    jest.spyOn(console, 'info').mockImplementation(() => {});
    const h = handler({ NOFRIES_DASHBOARD_ADMIN_ACCOUNT_ACTIONS: flag }, undefined, reader([record]));
    const response = await h.handler.handle(wire(), 'accounts/lookup'); expect(response.status).toBe(200);
    expect(response.body.rows[0].selector).toEqual(flag === 'true' ? { provider: 'legacy', subjectKey: subject, tenantId: uid(3), organisationId: uid(4) } : undefined);
});
