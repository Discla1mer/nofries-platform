'use strict';
const fs = require('node:fs'), vm = require('node:vm');
const { createDom } = require('./fixtures/dashboardDom');
const source = fs.readFileSync(require.resolve('../api/shared/protectedAssets/accountMembershipActions.js'), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
    const { document, window } = createDom(), elements = {}, events = {};
    const selector = { provider: 'external', subjectKey: 'synthetic-subject', tenantId: 'synthetic-tenant', organisationId: 'synthetic-org' };
    const state = { allowed: true, status: 'active', revision: 7, fail: null };
    const listen = window.addEventListener; window.addEventListener = (name, fn) => { events[name] = fn; listen(name, fn); };
    for (const name of ['Panel', 'Form', 'Email', 'Confirmation', 'Action', 'Refresh', 'Approve', 'Apply', 'Summary', 'Status']) elements[name] = document.createElement('div');
    document.getElementById = id => elements[id.replace('accountMembership', '')]; document.body = { dataset: { page: 'operator' } };
    elements.Form.elements = ['Email', 'Confirmation', 'Action', 'Refresh', 'Approve', 'Apply'].map(key => elements[key]);
    elements.Form.reportValidity = () => true; elements.Form.reset = jest.fn(); elements.Confirmation.value = 'synthetic@example.invalid';
    Object.assign(window, { nofriesAccountSelection: { email: 'synthetic@example.invalid', revision: 999, selector },
        crypto: { randomUUID: () => 'synthetic-operation' }, setTimeout: jest.fn(() => 1), clearTimeout: jest.fn() });
    const fetch = jest.fn(async (url, options) => {
        const input = options.body && JSON.parse(options.body); let status = 200, value;
        if (url.endsWith('dashboard/session')) value = { authenticated: true, purpose: 'operator_dashboard' };
        else if (url.endsWith('entry-capabilities')) value = { entry: true, accountActions: state.allowed };
        else if (url.endsWith('/membership')) value = { selector, expectedMembershipRevision: state.revision, membershipStatus: state.status };
        else if (url.includes('/approve-')) {
            status = state.fail || 200; value = { selector, action: url.endsWith('suspend') ? 'suspend' : 'restore',
                expectedMembershipRevision: input.expectedMembershipRevision, operationId: 'synthetic-operation', approvalExpiresAt: new Date(Date.now() + 900000).toISOString() };
        } else { state.status = url.endsWith('suspend') ? 'suspended' : 'active'; state.revision++;
            value = { outcome: 'succeeded', operationId: input.operationId }; }
        return { status, headers: { get: () => 'application/json' }, json: async () => value };
    });
    vm.runInNewContext(source, { document, window, fetch, AbortController, Date });
    const click = async name => { elements[name].click(); await flush(); };
    const submit = async () => { for (const fn of elements.Form.events.submit) fn({ preventDefault() {} }); await flush(); };
    return { elements, events, window, fetch, state, click, submit };
}
test('reads native membership revision before separate approval and suspend/restore calls', async () => {
    const h = fixture(); expect(h.fetch).not.toHaveBeenCalled(); expect(h.elements.Approve.disabled).toBe(true);
    await h.click('Refresh'); expect(h.elements.Summary.textContent).toBe('Membership: active. Revision: 7.');
    await h.submit(); expect(h.elements.Apply.disabled).toBe(false);
    const approval = h.fetch.mock.calls.find(([url]) => url.endsWith('approve-suspend'));
    expect(JSON.parse(approval[1].body)).toMatchObject({ expectedMembershipRevision: 7, confirmationEmail: 'synthetic@example.invalid' });
    expect(h.fetch.mock.calls.some(([url]) => url.endsWith('/suspend'))).toBe(false);
    await h.click('Apply'); expect(h.elements.Status.textContent).toContain('Membership suspended.'); expect(h.elements.Approve.disabled).toBe(true);
    await h.click('Refresh'); expect(h.elements.Summary.textContent).toBe('Membership: suspended. Revision: 8.');
    await h.submit(); await h.click('Apply'); expect(h.elements.Status.textContent).toContain('Membership restored.');
    expect(h.fetch.mock.calls.filter(([url]) => url.endsWith('/restore'))).toHaveLength(1);
});
test('selection and typed input invalidate approval and never replay an action', async () => {
    const h = fixture(); await h.click('Refresh'); await h.submit();
    for (const fn of h.elements.Form.events.input) fn(); await h.click('Apply');
    expect(h.fetch.mock.calls.some(([url]) => url.endsWith('/suspend'))).toBe(false);
    h.window.nofriesAccountSelection = null; h.window.dispatch('nofries-account-selection');
    expect(h.elements.Email.value).toBe(''); expect(h.elements.Refresh.disabled).toBe(true); expect(h.elements.Apply.disabled).toBe(true);
});
test('bfcache restoration clears pending request state and rechecks current access', async () => {
    const h = fixture(); let release;
    h.fetch.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    await h.click('Refresh'); h.window.dispatch('pagehide'); await h.events.pageshow({ persisted: true });
    expect(h.elements.Panel.hidden).toBe(false); expect(h.elements.Summary.textContent).toBe(''); expect(h.elements.Apply.disabled).toBe(true);
    release({ status: 200, headers: { get: () => 'application/json' }, json: async () => ({ authenticated: true, purpose: 'operator_dashboard' }) });
    await flush(); expect(h.fetch.mock.calls.some(([url]) => url.endsWith('/membership'))).toBe(false);
    h.state.allowed = false; h.window.dispatch('pagehide'); await h.events.pageshow({ persisted: true }); expect(h.elements.Panel.hidden).toBe(true);
});
test.each([403, 409, 503])('refusal %s clears membership state without automatic retries', async failure => {
    const h = fixture(); await h.click('Refresh'); h.state.fail = failure; await h.submit();
    expect(h.elements.Summary.textContent).toBe(''); expect(h.elements.Apply.disabled).toBe(true);
    expect(h.fetch.mock.calls.filter(([url]) => url.includes('/approve-'))).toHaveLength(1);
    expect(h.fetch.mock.calls.some(([url]) => url.endsWith('/suspend'))).toBe(false);
});
