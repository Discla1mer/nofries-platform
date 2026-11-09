'use strict';
const fs = require('node:fs'), vm = require('node:vm');
const { createDom } = require('./fixtures/dashboardDom');
const source = fs.readFileSync(require.resolve('../api/shared/protectedAssets/accountActions.js'), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(failure = null) {
    const { document, window } = createDom(), elements = {}, events = {}, state = { allowed: true };
    const listen = window.addEventListener; window.addEventListener = (name, fn) => { events[name] = fn; listen(name, fn); };
    for (const name of ['Panel', 'Form', 'Email', 'Confirmation', 'Expiry', 'Approve', 'Extend', 'Status']) elements[name] = document.createElement('div');
    document.getElementById = id => elements[id.replace('accountActions', '')];
    document.body = { dataset: { page: 'operator' } };
    elements.Email.value = elements.Confirmation.value = 'synthetic@example.invalid';
    elements.Expiry.value = new Date(Date.now() + 86400000).toISOString().slice(0, 16);
    elements.Form.elements = ['Email', 'Confirmation', 'Expiry', 'Approve', 'Extend'].map(k => elements[k]);
    elements.Form.reportValidity = () => true; elements.Form.reset = jest.fn();
    Object.assign(window, { nofriesAccountSelection: { email: 'synthetic@example.invalid', organisation: 'Synthetic', selector: { subjectKey: 'synthetic-subject' } }, crypto: { randomUUID: () => 'synthetic-operation' }, setTimeout: jest.fn(() => 1), clearTimeout: jest.fn() });
    const fetch = jest.fn(async (url, options) => {
        const input = options.body && JSON.parse(options.body);
        let status = 200, value = { authenticated: true, purpose: 'operator_dashboard' };
        if (url.endsWith('entry-capabilities')) value = { entry: true, accountActions: state.allowed };
        if (url.endsWith('approve-extension')) {
            if (failure === 'network') throw new Error('PRIVATE_PROVIDER_DETAIL');
            status = failure || 200;
            value = { selector: { subjectKey: 'synthetic-subject' }, operationId: 'synthetic-operation',
                newExpiresAt: input.newExpiresAt, approvalExpiresAt: new Date(Date.now() + 15 * 60000).toISOString() };
        }
        if (url.endsWith('extend-expired-access')) value = { outcome: 'succeeded', operationId: input.operationId };
        return { status, headers: { get: () => 'application/json' }, json: async () => value };
    });
    vm.runInNewContext(source, { document, window, fetch, AbortController, Date });
    const submit = async () => { for (const fn of elements.Form.events.submit) fn({ preventDefault() {} }); await flush(); };
    return { elements, fetch, window, submit, events, state };
}
test('explicit approval and extension are separate; editing invalidates approval and pagehide clears it', async () => {
    const f = fixture(); expect(f.fetch).not.toHaveBeenCalled();
    await f.submit(); expect(f.elements.Extend.disabled).toBe(false);
    expect(JSON.parse(f.fetch.mock.calls[1][1].body)).toMatchObject({ selector: { subjectKey: 'synthetic-subject' } });
    expect(f.fetch.mock.calls.map(([url]) => url)).toEqual(['/api/dashboard/session', '/api/dashboard-admin/approve-extension']);
    f.elements.Extend.click(); await flush();
    expect(f.elements.Status.textContent).toMatch(/Access expiry extended/);
    expect(f.elements.Extend.disabled).toBe(true);
    await f.submit(); for (const fn of f.elements.Form.events.input) fn();
    f.elements.Extend.click(); await flush();
    expect(f.fetch.mock.calls.filter(([url]) => url.endsWith('extend-expired-access'))).toHaveLength(1);
    f.window.dispatch('pagehide'); expect(f.elements.Form.reset).toHaveBeenCalled(); expect(f.elements.Panel.hidden).toBe(true);
});
test('back navigation resets an in-flight form and rechecks current access without resubmitting', async () => {
    const f = fixture(); let release;
    f.fetch.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    await f.submit(); expect(f.elements.Email.disabled).toBe(true); f.window.dispatch('pagehide');
    await f.events.pageshow({ persisted: true });
    expect(f.elements.Panel.hidden).toBe(false); expect(f.elements.Email.disabled).toBe(false); expect(f.elements.Extend.disabled).toBe(true);
    release({ status: 200, headers: { get: () => 'application/json' }, json: async () => ({ authenticated: true, purpose: 'operator_dashboard' }) });
    await flush(); expect(f.fetch.mock.calls.some(([url]) => url.endsWith('approve-extension'))).toBe(false);
    f.window.dispatch('pagehide'); f.state.allowed = false; await f.events.pageshow({ persisted: true });
    expect(f.elements.Panel.hidden).toBe(true);
});
test.each([403, 409, 503, 'network'])('failure %s never enables execution or retries automatically', async failure => {
    const f = fixture(failure); await f.submit(); expect(f.elements.Extend.disabled).toBe(true);
    expect(f.fetch).toHaveBeenCalledTimes(2); expect(f.elements.Status.textContent).not.toMatch(/PRIVATE|Approved/);
    if (failure === 'network' || failure === 503) expect(f.elements.Status.textContent).toMatch(/could not be confirmed/);
});

test('changing the selected account aborts old approval and requires a new explicit approval', async () => {
    const f = fixture(); await f.submit();
    f.window.nofriesAccountSelection = null; f.window.dispatch('nofries-account-selection');
    expect(f.elements.Extend.disabled).toBe(true); expect(f.elements.Email.value).toBe('');
    const calls = f.fetch.mock.calls.length; await f.submit(); expect(f.fetch).toHaveBeenCalledTimes(calls);
});
