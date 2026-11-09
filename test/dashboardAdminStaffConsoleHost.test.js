'use strict';

// A fresh staff login on the actual production launcher: the lookup client
// loads before any native operator session exists, the console opens that
// session itself, and only then can an email be looked up. SQL and SDK
// transports are synthetic; the gate, receipts and audit are real.
const { Readable } = require('node:stream');
const { fixture } = require('./fixtures/dashboardAdminAccountActionsProduction');
let warning;
beforeEach(() => { warning = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { expect(JSON.stringify(warning.mock.calls)).not.toMatch(/PRIVATE|synthetic|@/); warning.mockRestore(); });

function staffHost() {
    const h = fixture('legacy_starter');
    delete h.env.NOFRIES_DASHBOARD_ADMIN_BINDING; delete h.env.NOFRIES_DASHBOARD_ADMIN_ENABLED;
    Object.assign(h.env, { NOFRIES_DASHBOARD_ADMIN_ACCOUNT_ACTIONS: 'false', NOFRIES_STAFF_CONSOLE: 'true', NOFRIES_DASHBOARD_ADMIN_ACCOUNT_LOOKUP: 'true' });
    const Client = h.sdk.BlobServiceClient, original = Client.prototype.getContainerClient;
    // Bounded prefix listing over the synthetic bucket; the fixture otherwise refuses scans.
    Client.prototype.getContainerClient = function (name) {
        const account = new URL(this.url).hostname.split('.')[0], rows = h.bucket(account, name);
        return { ...original.call(this, name), async *listBlobsFlat(options) {
            h.lists.push({ name, prefix: options.prefix });
            for (const key of [...rows.keys()].sort()) if (key.startsWith(options.prefix)) yield { name: key };
        } };
    };
    h.lists = [];
    return h;
}
const lookup = (h, app, cookie, email) => h.send('post', '/api/dashboard-admin/accounts/lookup', app).set('Cookie', cookie)
    .set('Origin', h.env.NOFRIES_PUBLIC_URL).set('Sec-Fetch-Site', 'same-origin').send({ email });

test('a fresh staff login loads the lookup client, opens its native session and reads one account with a durable audit record', async () => {
    const h = staffHost(), app = h.build(), { cookie } = await h.login(app);
    expect(h.state.tables.dashboard_session_gates).toEqual([]);
    const script = await h.send('get', '/api/dashboard-admin/accounts/app.js', app).set('Cookie', cookie);
    expect(script.status).toBe(200); expect(script.headers['content-type']).toMatch(/javascript/); expect(script.text).toMatch(/\/api\/dashboard\/session/);
    // Without the native gate every customer read is refused and nothing is scanned.
    const early = await lookup(h, app, cookie, h.record.email);
    expect(early.status).toBe(403); expect(h.lists).toEqual([]); expect(early.text).not.toMatch(/synthetic|@/);
    expect((await h.send('get', '/api/dashboard-admin/capabilities', app).set('Cookie', cookie)).status).toBe(403);
    const session = (purpose, body) => h.send(body ? 'post' : 'get', '/api/dashboard/session', app).set('Cookie', cookie)
        .set('X-Nofries-Dashboard-Purpose', 'operator_dashboard').set('Origin', h.env.NOFRIES_PUBLIC_URL).set('Sec-Fetch-Site', 'same-origin').send(body);
    const closed = await session(); expect(closed.status).toBe(409); expect(closed.body.code).toBe('dashboard_initialization_required');
    expect((await session(null, { operationId: h.nextId() })).status).toBe(200);
    expect((await session()).body).toMatchObject({ authenticated: true, purpose: 'operator_dashboard' });
    expect((await h.send('get', '/api/dashboard-admin/capabilities', app).set('Cookie', cookie)).body).toEqual({ lookup: true, recovery: [] });
    const found = await lookup(h, app, cookie, h.record.email);
    expect(found.status).toBe(200);
    expect(found.body).toEqual({ truncated: false, rows: [{ email: h.record.email, kind: 'legacy_starter', schemaVersion: 1, plan: null, accountType: null,
        organisation: 'synthetic-org', status: 'expired', effectiveAt: null, expiresAt: new Date(h.record.expiresAt).toISOString(), revision: 0 }] });
    expect(found.text).not.toMatch(/subjectKey|invitation|Digest|selector/);
    expect(h.lists.map(row => row.name)).toEqual(['customer-authority', 'legacy-signups', 'external-signups']);
    const audits = h.writes.filter(row => row.name === 'account-action-audit');
    expect(audits).toHaveLength(2); expect(audits.every(row => /^dashboard-admin-account-lookups\/[0-9a-f-]{36}\.json$/.test(row.key))).toBe(true);
    const records = audits.map(row => JSON.parse(h.bucket('syntheticdata', 'account-action-audit').get(row.key).bytes));
    expect(records.map(row => row.status)).toEqual([403, 200]); expect(records[1]).toMatchObject({ count: 1, truncated: false, actorSha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(JSON.stringify(records)).not.toMatch(/@|subjectKey|synthetic-org/);
    expect(h.writes.filter(row => row.account === 'syntheticdata' && row.name !== 'account-action-audit')).toEqual([]);
    const missing = await lookup(h, app, cookie, 'nobody@example.invalid');
    expect(missing.status).toBe(200); expect(missing.body).toEqual({ rows: [], truncated: false });
});
test('an audit write failure withholds the lookup result', async () => {
    const h = staffHost(), Client = h.sdk.BlobServiceClient, original = Client.prototype.getContainerClient;
    Client.prototype.getContainerClient = function (name) {
        const container = original.call(this, name);
        if (name !== 'account-action-audit') return container;
        return { ...container, getBlockBlobClient: () => ({ async uploadData() { throw Object.assign(new Error('PRIVATE_AUDIT_DOWN'), { statusCode: 500 }); } }) };
    };
    const app = h.build(), { cookie } = await h.login(app);
    expect((await h.send('post', '/api/dashboard/session', app).set('Cookie', cookie).set('X-Nofries-Dashboard-Purpose', 'operator_dashboard')
        .set('Origin', h.env.NOFRIES_PUBLIC_URL).set('Sec-Fetch-Site', 'same-origin').send({ operationId: h.nextId() })).status).toBe(200);
    const result = await lookup(h, app, cookie, h.record.email);
    expect(result.status).toBe(503); expect(result.body).toEqual({ code: 'dashboard_admin_account_lookup_503' });
    expect(result.text).not.toMatch(/synthetic|@|PRIVATE|rows/);
    expect(h.lists.length).toBeGreaterThan(0);
});
