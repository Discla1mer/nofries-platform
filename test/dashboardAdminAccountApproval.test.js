'use strict';
const { Readable } = require('node:stream');
const { entrySessionFixture, uid, NOW } = require('./fixtures/dashboardAdminEntrySession');
const { subjectHash } = require('../api/shared/customerSignup/customerAuthority');
const { hash } = require('../api/shared/appLifecycle/dashboardRuntimeRecords');
const iso = time => new Date(time).toISOString();
let warning;
beforeEach(() => { warning = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { expect(JSON.stringify(warning.mock.calls)).not.toMatch(/PRIVATE|synthetic@/); warning.mockRestore(); });
async function fixture(enabled = true, admin = true) {
    const h = entrySessionFixture({ customer: false, externalCustomer: false }), rows = new Map(), trace = [], state = {};
    function container(name) {
        return { url: `https://syntheticstore.blob.core.windows.net/${name}`, pipeline: { options: { retryOptions: { maxTries: 1 } } },
            async *listBlobsFlat() { for (const key of rows.keys()) if (key.startsWith(name + '/')) yield { name: key.slice(name.length + 1) }; },
            getBlockBlobClient(key) { const path = name + '/' + key; return {
                async download() {
                    const saved = rows.get(path); if (!saved) throw Object.assign(new Error('PRIVATE_MISSING'), { statusCode: 404 });
                    const bytes = Buffer.from(JSON.stringify(saved.record));
                    return { contentLength: bytes.length, etag: saved.etag, readableStreamBody: Readable.from([bytes]) };
                }, async uploadData(bytes, { conditions }) {
                    trace.push(path); if (state.fail && key.endsWith(state.fail)) throw new Error('PRIVATE_FAILURE');
                    const prior = rows.get(path);
                    if (conditions.ifNoneMatch && prior || conditions.ifMatch && conditions.ifMatch !== prior?.etag) throw Object.assign(new Error('PRIVATE_CONFLICT'), { statusCode: 412 });
                    rows.set(path, { record: JSON.parse(bytes), etag: '"written"' });
                    if (state.afterWrite) await state.afterWrite(path);
                    return { etag: '"written"' };
                }
            }; }
        };
    }
    const source = { schemaVersion: 1, kind: 'external_starter', storageAccount: 'syntheticstore', container: 'authority',
        providerKind: 'external-id', providerTenantId: uid(10), providerConfigurationSha256: 'a'.repeat(64) };
    const record = { schemaVersion: 1, subjectKey: uid(10) + ':' + uid(11), email: 'synthetic@example.invalid', revision: 0, status: 'active',
        invitationDigest: 'b'.repeat(64), invitationId: 'invite', tenantId: uid(12), organisationId: uid(13), termsVersion: 'terms',
        termsDigest: 'c'.repeat(64), bindingId: null, expiresAt: NOW - 1000 };
    const key = 'authority/customer-subjects/' + subjectHash(record.subjectKey) + '.json'; rows.set(key, { record, etag: '"before"' });
    h.env.NOFRIES_DASHBOARD_ADMIN_ACCOUNT_ACTIONS = enabled ? 'true' : 'false';
    if (!admin) h.env.NOFRIES_ADMIN_SUBJECTS = '';
    h.rebuild({ dashboardAdmin: { authoriseOperator: async () => true, readAuthoritySnapshot: null,
        audit: async () => true, clock: h.dashboard.clock, requestBudgetMs: 10000 },
    dashboardAdminAccountActions: { source, authorityContainer: container('authority'), auditContainer: container('audit') } });
    const { cookie } = await h.login();
    const post = (route, input, selectedCookie = cookie, origin = h.env.NOFRIES_PUBLIC_URL) => h.send('post', '/api/' + route)
        .set('Cookie', selectedCookie).set('Origin', origin).set('Sec-Fetch-Site', 'same-origin').send(input);
    if (admin) expect((await post('dashboard/session', { operationId: h.nextId() })).status).toBe(200);
    const input = { email: record.email, confirmationEmail: record.email, newExpiresAt: iso(NOW + 86400000) };
    const approve = () => post('dashboard-admin/approve-extension', input);
    const extend = approved => post('dashboard-admin/extend-expired-access', { selector: approved.selector, operationId: approved.operationId,
        newExpiresAt: approved.newExpiresAt, confirmationEmail: record.email });
    return { h, rows, trace, state, record, key, input, approve, extend, post, cookie };
}
test('same staff session issues a durable 15-minute approval, then consumes it once without deleting data', async () => {
    const f = await fixture(), before = JSON.stringify(f.rows.get(f.key));
    const result = await f.approve(); expect(result.status).toBe(200);
    const path = 'audit/dashboard-admin-account-actions/' + result.body.operationId + '/';
    const approved = f.rows.get(path + 'approval.json').record;
    expect(approved.approval.expiresAt).toBe(iso(NOW + 15 * 60000));
    expect(f.rows.get(path + 'approval-terminal.json').record).toMatchObject({ outcome: 'succeeded', approvalSha256: hash(approved),
        before: { status: 'expired', expiresAt: iso(NOW - 1000) },
        after: { status: 'approved', approvedExpiresAt: f.input.newExpiresAt, expiresAt: iso(NOW + 15 * 60000) } });
    expect(JSON.stringify(f.rows.get(f.key))).toBe(before);
    expect(f.trace.map(value => value.split('/').pop())).toEqual(['approval-attempt.json', 'approval.json', 'approval-terminal.json']);
    expect((await f.extend(result.body)).status).toBe(200);
    expect((await f.extend(result.body)).status).toBe(409);
    expect(f.rows.get(f.key).record).toEqual({ ...f.record, revision: 1, expiresAt: NOW + 86400000 });
    expect(f.rows.size).toBe(6);
});
test.each(['cap', 'not_expired', 'revoked', 'confirmation', 'ambiguous', 'limit', 'audit', 'session'])('approval refuses %s without changing authority', async mode => {
    const f = await fixture(); let status = 409;
    if (mode === 'cap') { f.input.newExpiresAt = iso(NOW + 90 * 86400000 + 1); status = 400; }
    if (mode === 'not_expired') f.record.expiresAt = NOW + 1000;
    if (mode === 'revoked') f.record.status = 'revoked';
    if (mode === 'confirmation') { f.input.confirmationEmail = 'wrong@example.invalid'; status = 400; }
    if (mode === 'ambiguous') f.rows.set('authority/customer-subjects/' + 'f'.repeat(64) + '.json', { record: f.record, etag: '"duplicate"' });
    if (mode === 'limit') {
        for (let i = 0; i < 100; i++) f.rows.set('authority/customer-subjects/' + String(i).padStart(64, '0') + '.json',
            { record: { email: 'unrelated@example.invalid' }, etag: '"other"' });
        status = 503;
    }
    if (mode === 'audit') { f.state.fail = 'approval-terminal.json'; status = 503; }
    if (mode === 'session') { f.h.state.epoch = uid(99); status = 503; }
    expect((await f.approve()).status).toBe(status);
    expect(f.trace).not.toContain(f.key);
    expect(warning).toHaveBeenCalledTimes(1);
    if (mode === 'audit') {
        const stored = [...f.rows.entries()].find(([key]) => key.endsWith('/approval.json'))[1].record.command;
        expect((await f.extend({ selector: { provider: 'external', ...Object.fromEntries(['subjectKey', 'tenantId', 'organisationId'].map(k => [k, stored.target[k]])) }, ...stored })).status).toBe(503);
        expect(f.trace).not.toContain(f.key);
    }
});
test.each(['expired', 'changed', 'tampered'])('extension rejects %s approval', async mode => {
    const f = await fixture(), approved = (await f.approve()).body;
    if (mode === 'expired') f.h.state.now += 16 * 60000;
    if (mode === 'changed') f.rows.get(f.key).etag = '"other-writer"';
    if (mode === 'tampered') approved.newExpiresAt = iso(NOW + 2 * 86400000);
    expect((await f.extend(approved)).status).toBe(403); expect(f.trace).not.toContain(f.key);
});
test('flag, session, role and origin guards protect issuer and UI asset', async () => {
    const off = await fixture(false);
    expect((await off.approve()).status).toBe(404);
    expect((await off.h.send('get', '/api/dashboard-admin/entry.js').set('Cookie', off.cookie)).text).not.toContain('accountActionsForm');
    expect((await off.h.send('get', '/api/dashboard-admin/entry-capabilities').set('Cookie', off.cookie)).body).toEqual({ entry: true });
    const f = await fixture();
    expect((await f.post('dashboard-admin/approve-extension', f.input, '')).status).toBe(401);
    expect((await f.post('dashboard-admin/approve-extension', f.input, f.cookie, 'https://other.invalid')).status).toBe(403);
    expect((await f.h.send('get', '/api/dashboard-admin/entry.js').set('Cookie', f.cookie)).text).toContain('accountActionsForm');
    const capability = await f.h.send('get', '/api/dashboard-admin/entry-capabilities').set('Cookie', f.cookie);
    expect(capability.body).toEqual({ entry: true }); expect(capability.headers['x-nofries-account-actions']).toBe('true');
    const h = await fixture(true, false);
    expect((await h.approve()).status).toBe(403);
    expect((await h.h.send('get', '/api/dashboard-admin/entry.js').set('Cookie', h.cookie)).status).toBe(403);
    expect(f.trace).toEqual([]);
});
test('issuance waits for its terminal audit, and a later revocation cannot turn durable approval into failure', async () => {
    const f = await fixture(); let release, reached;
    const blocked = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { reached = resolve; });
    f.state.afterWrite = async path => { if (path.endsWith('approval-terminal.json')) { reached(); await blocked; f.h.state.epoch = uid(99); } };
    let completed = false;
    const response = f.approve().then(result => { completed = true; return result; });
    await entered; expect(completed).toBe(false); release(); expect((await response).status).toBe(200);
});
