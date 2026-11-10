'use strict';
const fs = require('node:fs'), vm = require('node:vm');
const { createDom } = require('./fixtures/dashboardDom');
const source = fs.readFileSync(require.resolve('../api/shared/protectedAssets/accountActions.js'), 'utf8');
const html = fs.readFileSync(require.resolve('../app/operator.html'), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
const selection = (status = 'active') => ({ email: 'synthetic@example.invalid', organisation: 'Synthetic', selector: { subjectKey: 'synthetic-subject' },
    membershipRevision: 4, memberships: [{ membershipId: 'm1', status, roles: ['admin'] }] });
function fixture(failure = null, selected = selection()) {
    const { document, window } = createDom(), elements = {}, events = {}, state = { allowed: true };
    const listen = window.addEventListener; window.addEventListener = (name, fn) => { events[name] = fn; listen(name, fn); };
    for (const name of ['Panel', 'Form', 'Email', 'Confirmation', 'Approve', 'Apply', 'Status', 'Summary']) elements[name] = document.createElement('div');
    document.getElementById = id => elements[id.replace('accountActions', '')];
    document.body = { dataset: { page: 'operator' } };
    elements.Email.value = elements.Confirmation.value = 'synthetic@example.invalid';
    elements.Form.elements = ['Email', 'Confirmation', 'Approve', 'Apply'].map(k => elements[k]);
    elements.Form.reportValidity = () => true; elements.Form.reset = jest.fn();
    Object.assign(window, { nofriesAccountSelection: selected, crypto: { randomUUID: () => 'synthetic-operation' }, setTimeout: jest.fn(() => 1), clearTimeout: jest.fn() });
    const fetch = jest.fn(async (url, options) => {
        const input = options.body && JSON.parse(options.body);
        let status = 200, value = { authenticated: true, purpose: 'operator_dashboard' };
        if (url.endsWith('entry-capabilities')) value = { entry: true, accountActions: state.allowed };
        if (/approve-(suspend|restore)$/.test(url)) {
            if (failure === 'network') throw new Error('PRIVATE_PROVIDER_DETAIL');
            status = failure || 200;
            value = { selector: input.selector, operationId: 'synthetic-operation', action: url.split('approve-')[1], expectedMembershipRevision: input.expectedMembershipRevision,
                membershipStatus: 'active', approvalExpiresAt: new Date(Date.now() + 15 * 60000).toISOString() };
        }
        if (/\/(suspend|restore)$/.test(url)) value = { outcome: 'succeeded', operationId: input.operationId };
        return { status, headers: { get: () => 'application/json' }, json: async () => value };
    });
    vm.runInNewContext(source, { document, window, fetch, AbortController, Date });
    const submit = async () => { for (const fn of elements.Form.events.submit) fn({ preventDefault() {} }); await flush(); };
    return { elements, fetch, window, submit, events, state };
}
test('the operator page carries every control the client binds and no expiry field', () => {
    for (const id of ['Panel', 'Form', 'Email', 'Confirmation', 'Approve', 'Apply', 'Status', 'Summary']) expect(html).toContain(`id="accountActions${id}"`);
    expect(html).not.toMatch(/accountActionsExpiry|accountActionsExtend|Extend expired/);
});
test('approval and application are separate steps bound to the read membership revision; editing invalidates approval', async () => {
    const f = fixture(); expect(f.fetch).not.toHaveBeenCalled(); expect(f.elements.Approve.textContent).toBe('Approve suspend');
    await f.submit(); expect(f.elements.Apply.disabled).toBe(false);
    expect(f.fetch.mock.calls.map(([url]) => url)).toEqual(['/api/dashboard/session', '/api/dashboard-admin/approve-suspend']);
    expect(JSON.parse(f.fetch.mock.calls[1][1].body)).toEqual({ selector: { subjectKey: 'synthetic-subject' }, confirmationEmail: 'synthetic@example.invalid', expectedMembershipRevision: 4 });
    f.elements.Apply.click(); await flush();
    expect(JSON.parse(f.fetch.mock.calls[2][1].body)).toMatchObject({ operationId: 'synthetic-operation', expectedMembershipRevision: 4 });
    expect(f.elements.Status.textContent).toMatch(/Suspend dashboard access succeeded/);
    // The membership changed: a fresh read is required before another action.
    expect(f.elements.Apply.disabled).toBe(true); expect(f.elements.Approve.disabled).toBe(true);
    const calls = f.fetch.mock.calls.length; await f.submit(); expect(f.fetch).toHaveBeenCalledTimes(calls);
    f.window.dispatch('pagehide'); expect(f.elements.Form.reset).toHaveBeenCalled(); expect(f.elements.Panel.hidden).toBe(true);
});
test('a suspended membership offers restore and a typed-email edit clears approval without applying', async () => {
    const f = fixture(null, selection('suspended')); expect(f.elements.Approve.textContent).toBe('Approve restore');
    await f.submit(); expect(f.fetch.mock.calls[1][0]).toBe('/api/dashboard-admin/approve-restore'); expect(f.elements.Apply.disabled).toBe(false);
    for (const fn of f.elements.Form.events.input) fn(); f.elements.Apply.click(); await flush();
    expect(f.fetch.mock.calls.some(([url]) => url.endsWith('/restore'))).toBe(false);
});
test.each([[null, 'Select an account'], [{ email: 'x@example.invalid' }, 'no dashboard membership'], [{ ...selection(), memberships: undefined }, 'Show dashboard access'],
    [{ ...selection(), memberships: [] }, 'No single active or suspended']])('selection %p cannot be approved: %s', async (selected, text) => {
    const f = fixture(null, selected); expect(f.elements.Approve.disabled).toBe(true); expect(f.elements.Summary.textContent).toContain(text);
    await f.submit(); expect(f.fetch).not.toHaveBeenCalled();
});
test('back navigation resets an in-flight form and rechecks current access without resubmitting', async () => {
    const f = fixture(); let release;
    f.fetch.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    await f.submit(); expect(f.elements.Email.disabled).toBe(true); f.window.dispatch('pagehide');
    await f.events.pageshow({ persisted: true });
    expect(f.elements.Panel.hidden).toBe(false); expect(f.elements.Email.disabled).toBe(false); expect(f.elements.Apply.disabled).toBe(true);
    release({ status: 200, headers: { get: () => 'application/json' }, json: async () => ({ authenticated: true, purpose: 'operator_dashboard' }) });
    await flush(); expect(f.fetch.mock.calls.some(([url]) => url.includes('approve-'))).toBe(false);
    f.window.dispatch('pagehide'); f.state.allowed = false; await f.events.pageshow({ persisted: true });
    expect(f.elements.Panel.hidden).toBe(true);
});
test.each([403, 409, 503, 'network'])('failure %s never enables application or retries automatically', async failure => {
    const f = fixture(failure); await f.submit(); expect(f.elements.Apply.disabled).toBe(true);
    expect(f.fetch).toHaveBeenCalledTimes(2); expect(f.elements.Status.textContent).not.toMatch(/PRIVATE|Approved/);
    expect(f.elements.Status.textContent).toMatch(failure === 'network' || failure === 503 ? /could not be confirmed/ : /refused/);
});
test('changing the selected account aborts the old approval and requires a new explicit approval', async () => {
    const f = fixture(); await f.submit();
    f.window.nofriesAccountSelection = null; f.window.dispatch('nofries-account-selection');
    expect(f.elements.Apply.disabled).toBe(true); expect(f.elements.Email.value).toBe('');
    const calls = f.fetch.mock.calls.length; await f.submit(); expect(f.fetch).toHaveBeenCalledTimes(calls);
});
