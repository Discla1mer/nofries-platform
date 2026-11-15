'use strict';
const fs = require('node:fs'), vm = require('node:vm');
const { Readable } = require('node:stream');
const { createDom } = require('./fixtures/dashboardDom');
const { createDashboardAdminHandlers } = require('../api/shared/dashboardAdmin/handlers');
const source = fs.readFileSync(require.resolve('../api/shared/protectedAssets/accountWipe.js'), 'utf8');
const html = fs.readFileSync(require.resolve('../app/operator.html'), 'utf8');
const flush = async () => { for (let i = 0; i < 5; i += 1) await new Promise(resolve => setImmediate(resolve)); };
const EMAIL = 'synthetic@example.invalid';
const IDS = ['Panel', 'Form', 'Reset', 'Delete', 'Email', 'Word', 'WordHint', 'Approve', 'Apply', 'Status', 'Summary', 'ResumeEmail', 'Resume'];

function fixture({ approveReply = null, executeReply = null, selected = { email: EMAIL } } = {}) {
    const { document, window } = createDom(), elements = {};
    for (const name of IDS) elements[name] = document.createElement('div');
    document.getElementById = id => elements[id.replace('accountWipe', '')];
    document.body = { dataset: { page: 'operator' } };
    elements.Form.reportValidity = () => true;
    Object.assign(window, { nofriesAccountSelection: selected, crypto: { randomUUID: () => 'synthetic-operation' }, setTimeout: jest.fn(() => 1), clearTimeout: jest.fn() });
    const fetch = jest.fn(async (url, options) => {
        const input = options.body && JSON.parse(options.body);
        let status = 200, value = { authenticated: true, purpose: 'operator_dashboard' };
        if (url.endsWith('entry-capabilities')) value = { entry: true, accountWipe: true };
        if (input?.wipe?.step === 'approve') ({ status, value } = approveReply || { status: 200, value: { approvalId: 'synthetic-approval', action: input.wipe.action,
            approvalExpiresAt: new Date(Date.now() + 15 * 60000).toISOString(), organisations: 1, store: 'external' } });
        if (input?.wipe?.step === 'execute') ({ status, value } = executeReply || { status: 200, value: { operationId: 'synthetic-approval', action: 'delete',
            outcome: 'succeeded', stages: { database: 'done', storage: 'done', identity: 'done' }, failedStage: null, code: null, counts: { databaseRows: 4, blobs: 3, versions: 0 }, recorded: true } });
        return { status, headers: { get: () => 'application/json' }, json: async () => value };
    });
    vm.runInNewContext(source, { document, window, fetch, AbortController, Date });
    const type = (email, word) => { elements.Email.value = email; elements.Word.value = word; };
    const submit = async () => { for (const fn of elements.Form.events.submit) fn({ preventDefault() {} }); await flush(); };
    const applyNow = async () => { elements.Apply.click(); await flush(); };
    const bodies = () => fetch.mock.calls.filter(([url]) => url.endsWith('/accounts/lookup')).map(([, options]) => JSON.parse(options.body));
    return { elements, fetch, window, type, submit, applyNow, bodies };
}

test('the operator page carries every control, hidden until the script shows it, next to suspend', () => {
    for (const id of IDS) expect(html).toContain(`id="accountWipe${id}"`);
    expect(html).toMatch(/id="accountWipePanel"[^>]*hidden/);
    expect(html.indexOf('id="accountWipePanel"')).toBeGreaterThan(html.indexOf('id="accountActionsPanel"'));
});

test('nothing can be approved until an account is selected and an action chosen', () => {
    const f = fixture({ selected: null });
    expect(f.elements.Panel.hidden).toBe(false);
    expect(f.elements.Reset.disabled).toBe(true); expect(f.elements.Delete.disabled).toBe(true); expect(f.elements.Approve.disabled).toBe(true);
    expect(f.elements.Summary.textContent).toMatch(/Select an account/);
    f.window.nofriesAccountSelection = { email: EMAIL }; f.window.dispatch('nofries-account-selection');
    expect(f.elements.Delete.disabled).toBe(false); expect(f.elements.Approve.disabled).toBe(true);
    f.elements.Delete.click();
    expect(f.elements.Approve.disabled).toBe(false); expect(f.elements.Approve.textContent).toBe('Approve delete');
    expect(f.elements.WordHint.textContent).toBe('DELETE'); expect(f.elements.Summary.textContent).toMatch(/cannot be undone/);
});

test('delete: approve with typed email and word, then apply once, through the lookup route', async () => {
    const f = fixture();
    f.elements.Delete.click(); f.type(EMAIL, 'DELETE'); await f.submit();
    expect(f.elements.Apply.disabled).toBe(false); expect(f.elements.Status.textContent).toMatch(/Approved: delete/);
    await f.applyNow();
    expect(f.bodies()).toEqual([
        { wipe: { step: 'approve', action: 'delete', email: EMAIL, confirmEmail: EMAIL, confirmWord: 'DELETE' } },
        { wipe: { step: 'execute', approvalId: 'synthetic-approval', email: EMAIL } }]);
    expect(f.fetch.mock.calls.every(([url]) => !/[@?]/.test(url))).toBe(true);
    expect(f.elements.Status.textContent).toMatch(/Delete complete .*Database: removed; Stored records: removed; Sign-in user: removed/);
    expect(f.elements.Apply.disabled).toBe(true); expect(f.elements.Approve.disabled).toBe(true);
});

test('reset reports rows cleared and that sign-in is kept', async () => {
    const f = fixture({ executeReply: { status: 200, value: { action: 'reset', outcome: 'succeeded', stages: { database: 'done' }, counts: { databaseRows: 9 }, recorded: true } } });
    f.elements.Reset.click(); f.type(EMAIL, 'RESET'); await f.submit(); await f.applyNow();
    expect(f.elements.Status.textContent).toBe(`Reset complete for ${EMAIL}: 9 database rows cleared. Sign-in is kept.`);
});

test('a partial delete names the failed stage and leaves Delete ready to approve again', async () => {
    const f = fixture({ executeReply: { status: 200, value: { action: 'delete', outcome: 'partial', failedStage: 'identity', code: 'account_wipe_identity_forbidden',
        stages: { database: 'done', storage: 'done', identity: 'failed' }, counts: { databaseRows: 1 }, recorded: true } } });
    f.elements.Delete.click(); f.type(EMAIL, 'DELETE'); await f.submit(); await f.applyNow();
    expect(f.elements.Status.textContent).toMatch(/partly done.*Sign-in user: failed.*not allowed to remove the sign-in user.*approve and apply Delete again/i);
    expect(f.elements.Approve.disabled).toBe(false); expect(f.elements.Approve.textContent).toBe('Approve delete');
});

test.each([
    [{ status: 409, value: { code: 'account_wipe_reference_blocked' } }, /End it and try again. Nothing was changed/],
    [{ status: 409, value: { code: 'account_wipe_legacy_index_configured' } }, /legacy signup listing/],
    [{ status: 400, value: { code: 'account_wipe_confirmation_mismatch' } }, /Type the account email exactly/],
    [{ status: 503, value: { code: 'PRIVATE_UNKNOWN' } }, /unavailable/]
])('approval refusal %# is explained without enabling apply', async (approveReply, text) => {
    const f = fixture({ approveReply });
    f.elements.Delete.click(); f.type(EMAIL, 'DELETE'); await f.submit();
    expect(f.elements.Status.textContent).toMatch(text); expect(f.elements.Status.textContent).not.toContain('PRIVATE');
    expect(f.elements.Apply.disabled).toBe(true);
});

test('editing after approval, or selecting another account, clears the approval', async () => {
    const f = fixture();
    f.elements.Delete.click(); f.type(EMAIL, 'DELETE'); await f.submit();
    for (const fn of f.elements.Form.events.input) fn();
    expect(f.elements.Apply.disabled).toBe(true); await f.applyNow();
    expect(f.bodies().some(body => body.wipe.step === 'execute')).toBe(false);
    f.type(EMAIL, 'DELETE'); await f.submit(); expect(f.elements.Apply.disabled).toBe(false);
    f.window.nofriesAccountSelection = { email: 'other@example.invalid' }; f.window.dispatch('nofries-account-selection');
    expect(f.elements.Apply.disabled).toBe(true); expect(f.elements.Approve.disabled).toBe(true);
});

test('a delete that left no lookup rows can be finished by email without a selection', async () => {
    const f = fixture({ selected: null });
    expect(f.elements.Delete.disabled).toBe(true);
    f.elements.ResumeEmail.value = 'not-an-email'; f.elements.Resume.click();
    expect(f.elements.Status.textContent).toMatch(/Enter the account email/); expect(f.elements.Approve.disabled).toBe(true);
    f.elements.ResumeEmail.value = ' ' + EMAIL + ' '; f.elements.Resume.click();
    expect(f.elements.Reset.disabled).toBe(true); expect(f.elements.Approve.textContent).toBe('Approve delete');
    expect(f.elements.Summary.textContent).toMatch(/Finish the delete of synthetic@example.invalid/);
    f.type(EMAIL, 'DELETE'); await f.submit(); await f.applyNow();
    // Only the email goes to the server; no identity reference comes from the page.
    expect(f.bodies()).toEqual([
        { wipe: { step: 'approve', action: 'delete', email: EMAIL, confirmEmail: EMAIL, confirmWord: 'DELETE' } },
        { wipe: { step: 'execute', approvalId: 'synthetic-approval', email: EMAIL } }]);
    expect(f.elements.Status.textContent).toMatch(/Delete complete/);
});

test('pagehide hides the panel and forgets the selection', () => {
    const f = fixture(); f.elements.Delete.click(); f.window.dispatch('pagehide');
    expect(f.elements.Panel.hidden).toBe(true); expect(f.elements.Delete.disabled).toBe(true);
});

test('the script is served with entry.js only while the flag is on', async () => {
    const uid = n => '72000000-0000-4000-8000-' + String(n).padStart(12, '0'), staff = uid(1) + ':' + uid(2);
    const entry = async flag => {
        const handler = createDashboardAdminHandlers({ service: { authorise: async actor => actor, capabilities: async () => ({}), lookup: async () => ({}) },
            readOperatorSession: async () => ({ identity: { provider: 'entra-bff', isAuthenticated: true, subjectKey: staff, tenantId: uid(1), principalId: uid(2) } }),
            accountLookupReader: { read: jest.fn(), wipe: jest.fn(), audit: jest.fn(), targetDigest: () => '0'.repeat(64) },
            env: { NOFRIES_REQUIRE_AUTH: 'true', NOFRIES_ENTRA_TENANT_ID: uid(1), NOFRIES_ALLOWED_SUBJECTS: staff, NOFRIES_ADMIN_SUBJECTS: staff,
                NOFRIES_DASHBOARD_ADMIN_ACCOUNT_LOOKUP: 'true', NOFRIES_DASHBOARD_ADMIN_ACCOUNT_WIPE: flag } });
        return (await handler.handle(Object.assign(Readable.from([]), { method: 'GET', url: '/api/dashboard-admin/entry.js', headers: {} }), 'entry.js')).body;
    };
    expect(await entry('true')).toContain("getElementById('accountWipePanel')");
    expect(await entry('false')).not.toContain('accountWipePanel');
});
