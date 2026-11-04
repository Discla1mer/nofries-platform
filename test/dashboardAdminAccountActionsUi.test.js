'use strict';

// Deterministic controller/DOM tests. Browser layout evidence is collected
// separately; this harness exercises the served script and actual document IDs.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createDom } = require('./fixtures/dashboardDom');
const { buildDashboardAdminDocument } = require('../lib/dashboardAdminDocument');
const { createDashboardAdminAccountActionService } = require('../api/shared/dashboardAdmin/accountActionService');
const source = fs.readFileSync(path.join(__dirname, '../api/shared/protectedAssets/dashboardAdminAccountActions.js'), 'utf8');
const lookupSource = fs.readFileSync(path.join(__dirname, '../api/shared/protectedAssets/dashboardAdmin.js'), 'utf8');
const signupSource = fs.readFileSync(path.join(__dirname, '../api/shared/protectedAssets/signupQueue.js'), 'utf8');
const html = buildDashboardAdminDocument();
const NOW = Date.now();
const pause = () => new Promise(resolve => setImmediate(resolve));
const reply = (body, code = 200, type = 'application/json') => new Response(JSON.stringify(body), { status: code, headers: { 'content-type': type } });
function deferred() { let resolve, reject; return { promise: new Promise((yes, no) => { resolve = yes; reject = no; }), resolve: value => resolve(value), reject: error => reject(error) }; }
const selector = { provider: 'legacy', subjectKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    tenantId: 'Synthetic-Tenant_A.1', organisationId: 'Synthetic-Organisation_A.1' };
const membership = { membershipId: 'synthetic-member', status: 'active', validFrom: '2026-01-01T00:00:00.000Z', validUntil: '2027-01-01T00:00:00.000Z' };
const inspected = (patch = {}) => ({ selector, version: 'a'.repeat(64), displayName: 'Synthetic organisation', displayLabel: null,
    membership, actions: ['edit', 'delete'], ...patch });
const preparation = (action = 'edit', patch = { displayLabel: 'Synthetic staff label' }, extra = {}) => ({
    confirmationToken: 'a'.repeat(43), operationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', selector, action, patch,
    before: { displayName: 'Synthetic organisation', displayLabel: null, membership }, expiresAt: new Date(NOW + 300000).toISOString(), ...extra
});
const receipt = (status = 'succeeded', extra = {}) => ({ operationId: preparation().operationId, commandSha256: 'b'.repeat(64), status,
    version: status.startsWith('not_started') ? null : 'c'.repeat(64), occurredAt: status.startsWith('not_started') ? null : new Date(NOW).toISOString(), ...extra });
function harness(fetch, all = false) {
    const dom = createDom(), nodes = new Map(), listeners = new Map(), timers = [];
    let now = NOW;
    class Clock extends Date { static now() { return now; } }
    for (const match of html.matchAll(/<(\w+)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
        const item = dom.document.createElement(match[1]); item.id = match[2]; item.value = ''; item.checked = false;
        item.disabled = /\sdisabled(?:[\s>])/.test(match[0]); item.hidden = /\shidden(?:[\s>])/.test(match[0]); nodes.set(item.id, item);
    }
    nodes.get('accountActionsProvider').value = 'legacy'; nodes.get('adminProvider').value = 'legacy';
    dom.document.getElementById = id => nodes.get(id) || null;
    dom.window.setTimeout = (fn, delay) => { timers.push({ fn, delay, cleared: false }); return timers.length; };
    dom.window.clearTimeout = id => { if (timers[id - 1]) timers[id - 1].cleared = true; };
    dom.window.CustomEvent = class { constructor(type, options) { this.type = type; this.detail = options?.detail; } };
    dom.window.addEventListener = (type, fn) => { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); };
    dom.window.dispatchEvent = event => { for (const fn of listeners.get(event.type) || []) fn(event); };
    vm.runInNewContext((all ? lookupSource + '\n' + signupSource + '\n' : '') + source,
        { document: dom.document, window: dom.window, fetch, AbortController, Date: Clock });
    const h = { ...dom, nodes, timers, emit(id, type = 'click') { for (const fn of nodes.get(id).events[type] || []) fn({ preventDefault() {} }); },
        dispatch(type, values = {}) { const event = { type, preventDefault: jest.fn(), ...values }; dom.window.dispatchEvent(event); return event; },
        setNow(value) { now = value; }, fill(value = selector) {
            for (const [key, suffix] of Object.entries({ provider: 'Provider', subjectKey: 'Subject', tenantId: 'Tenant', organisationId: 'Organisation' })) nodes.get('accountActions' + suffix).value = value[key];
        }, async ready() { await pause(); await pause(); },
        async inspect() { h.fill(); h.emit('accountActionsSelectorForm', 'submit'); await h.ready(); },
        async prepare(action = 'edit') { nodes.get('accountActionsAction').value = action; nodes.get('accountActionsName').value = 'Synthetic staff label'; nodes.get('accountActionsConfirmationName').value = 'Synthetic organisation';
            h.emit('accountActionsPrepareForm', 'change'); h.emit('accountActionsPrepareForm', 'submit'); await h.ready(); },
        confirm() { nodes.get('accountActionsConfirm').checked = true; h.emit('accountActionsConfirm', 'change'); h.emit('accountActionsConfirmForm', 'submit'); }
    }; return h;
}
const normalFetch = (...responses) => jest.fn().mockResolvedValueOnce(reply({ accountActions: true })).mockResolvedValueOnce(reply(inspected()))
    .mockResolvedValueOnce(reply(preparation())).mockImplementation(() => responses.length ? Promise.resolve(responses.shift()) : Promise.resolve(reply(receipt())));

describe('protected account actions UI', () => {
    test('real service wire contract round trips label edit, scoped removal and restore through explicit UI previews', async () => {
        const principal = { provider: 'entra-bff', isAuthenticated: true,
            subjectKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:cccccccc-cccc-4ccc-8ccc-cccccccccccc' };
        const confirmations = new Map(), receipts = new Map();
        let label = null, savedStatus = 'active', commits = 0;
        const service = createDashboardAdminAccountActionService({ authoriseOperator: async () => true,
            clock: () => new Date(NOW).toISOString(), confirmationStore: {
                create: async (key, command, beforeWrite) => { await beforeWrite(); confirmations.set(key, command); return true; },
                load: async key => confirmations.get(key) || null
            }, adapter: {
                inspect: async selected => ({ ...inspected(), selector: selected, displayLabel: label,
                    membership: { ...membership, status: savedStatus }, actions: ['edit', savedStatus === 'active' ? 'delete' : 'restore'], witness: { source: 'synthetic-native' } }),
                outcome: async command => receipts.get(command.operationId) || null,
                commit: async (command, context) => {
                    await context.beforeCommit(); commits += 1;
                    if (command.action === 'edit') label = command.patch.displayLabel;
                    else savedStatus = command.action === 'delete' ? 'suspended' : 'active';
                    const result = { operationId: command.operationId, commandSha256: command.commandSha256, status: 'succeeded',
                        version: 'c'.repeat(64), occurredAt: new Date(NOW).toISOString() };
                    receipts.set(command.operationId, result); return result;
                }
            } });
        const fetch = jest.fn(async (url, init) => {
            try { const method = url.split('/').at(-1); return reply(await service[method](principal, init.body ? JSON.parse(init.body) : undefined)); }
            catch (error) { return reply({ code: error.code }, error.statusCode || 503); }
        });
        const h = harness(fetch); await h.ready(); await h.inspect();
        for (const chosen of ['edit', 'delete', 'restore']) {
            await h.prepare(chosen); expect(h.nodes.get('accountActionsPreview').hidden).toBe(false);
            expect(h.nodes.get('accountActionsPreview').textContent).toContain('Synthetic organisation');
            h.confirm(); await h.ready(); expect(h.nodes.get('accountActionsOutcome').textContent).toContain('Succeeded');
            h.emit('accountActionsFresh'); await h.ready();
        }
        expect(commits).toBe(3); expect(receipts.size).toBe(3); expect(label).toBe('Synthetic staff label'); expect(savedStatus).toBe('active');
        expect(h.nodes.get('accountActionsInspection').textContent).toContain('Synthetic organisation');
        expect(h.nodes.get('accountActionsInspection').textContent).toContain(membership.validUntil);
    });
    test('document has disabled labelled controls, explicit review, live status, and honest action scope', () => {
        for (const suffix of ['Provider', 'Subject', 'Tenant', 'Organisation', 'Action', 'Name', 'Confirm']) expect(html).toContain('for="accountActions' + suffix + '"');
        expect(html).toContain('id="accountActionsSelectorFields" disabled');
        expect(html).toContain('id="accountActionsConfirmFields" disabled');
        expect(html).toContain('id="accountActionsStatus" role="status" aria-live="polite" aria-atomic="true"');
        expect(html).toContain('staff-facing account label'); expect(html).toContain('preserves stored data');
        expect(html).toContain('Signup reset is disabled while its safety checks are completed.');
        expect(source).not.toMatch(/innerHTML|localStorage|sessionStorage|console\.|sendBeacon/);
    });
    test.each([{}, { lookup: true }, { accountActions: false }, { accountActions: ['edit'] }, { accountActions: 'true' }])('capability %p never enables action authority', async value => {
        const fetch = jest.fn(async () => reply(value)), h = harness(fetch); await h.ready(); h.fill(); h.emit('accountActionsSelectorForm', 'submit');
        expect(fetch).toHaveBeenCalledTimes(1); expect(h.nodes.get('accountActionsSelectorFields').disabled).toBe(true);
        expect(h.nodes.get('accountActionsStatus').textContent).toContain('unavailable');
    });
    test('exact inspect, label-only preview and explicit confirmation perform one POST with the retained token', async () => {
        const fetch = normalFetch(), h = harness(fetch); await h.ready(); expect(fetch).toHaveBeenCalledTimes(1); await h.inspect();
        expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual(selector);
        expect(fetch.mock.calls[1][0]).toBe('/api/dashboard-admin/actions/inspect');
        expect(h.document.activeElement.id).toBe('accountActionsInspectionHeading');
        expect(h.nodes.get('accountActionsInspection').textContent).toContain('Permanent account erasure is unavailable');
        expect(h.nodes.get('accountActionsAction').children.map(item => item.value)).toEqual(['edit', 'delete']);
        await h.prepare(); expect(fetch).toHaveBeenCalledTimes(3);
        expect(JSON.parse(fetch.mock.calls[2][1].body)).toEqual({ selector, action: 'edit', patch: { displayLabel: 'Synthetic staff label' } });
        const preview = h.nodes.get('accountActionsPreview').textContent;
        for (const text of [selector.subjectKey, selector.tenantId, selector.organisationId, 'Synthetic organisation', 'Not set', 'Synthetic staff label', 'active', 'unchanged']) expect(preview).toContain(text);
        expect(h.document.activeElement.id).toBe('accountActionsPreviewHeading');
        expect(h.nodes.get('accountActionsExecute').disabled).toBe(true);
        h.emit('accountActionsConfirmForm', 'submit'); expect(fetch).toHaveBeenCalledTimes(3);
        h.confirm(); h.confirm(); await h.ready();
        expect(fetch).toHaveBeenCalledTimes(4); expect(JSON.parse(fetch.mock.calls[3][1].body)).toEqual({ confirmationToken: preparation().confirmationToken });
        expect(fetch.mock.calls[3][0]).toBe('/api/dashboard-admin/actions/execute');
        for (const [, init] of fetch.mock.calls) expect(init).toMatchObject({ credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
        expect(h.nodes.get('accountActionsOutcome').textContent).toContain('Request completed');
        expect(h.nodes.get('accountActionsFresh').hidden).toBe(false); expect(h.document.activeElement.id).toBe('accountActionsOutcomeHeading');
        h.confirm(); expect(fetch).toHaveBeenCalledTimes(4);
    });
    test.each(['delete', 'restore'])('%s preview is scoped, reversible access change with null patch and accurate before/after', async chosen => {
        const beforeMembership = { ...membership, status: chosen === 'restore' ? 'suspended' : 'active' };
        const fetch = jest.fn().mockResolvedValueOnce(reply({ accountActions: true })).mockResolvedValueOnce(reply(inspected({ membership: beforeMembership, actions: [chosen] })))
            .mockResolvedValueOnce(reply(preparation(chosen, null, { before: { displayName: 'Synthetic organisation', displayLabel: null, membership: beforeMembership } })));
        const h = harness(fetch); await h.ready(); await h.inspect(); await h.prepare(chosen);
        expect(JSON.parse(fetch.mock.calls[2][1].body)).toEqual({ selector, action: chosen, patch: null, ...(chosen === 'delete' ? { confirmationName: 'Synthetic organisation' } : {}) });
        const text = h.nodes.get('accountActionsPreview').textContent;
        expect(text).toContain('active'); expect(text).toContain('suspended'); expect(text).toContain('unchanged');
        expect(text).toContain(chosen === 'delete' ? 'Stored data, the global identity' : 'does not extend access dates');
        expect(h.nodes.get('accountActionsNameLabel').hidden).toBe(true);
    });
    test.each(['input', 'change'])('%s invalidates preview and requires fresh explicit review', async type => {
        const fetch = normalFetch(), h = harness(fetch); await h.ready(); await h.inspect(); await h.prepare();
        h.nodes.get('accountActionsConfirm').checked = true; h.nodes.get('accountActionsName').value = 'Different label'; h.emit('accountActionsPrepareForm', type);
        expect(h.nodes.get('accountActionsPreview').hidden).toBe(true); h.emit('accountActionsConfirmForm', 'submit'); expect(fetch).toHaveBeenCalledTimes(3);
        h.emit('accountActionsSelectorForm', type); expect(h.nodes.get('accountActionsInspection').hidden).toBe(true);
    });
    test('changing scope aborts a pending inspection and discards its late successful result', async () => {
        const late = deferred(), fetch = jest.fn().mockResolvedValueOnce(reply({ accountActions: true })).mockReturnValueOnce(late.promise), h = harness(fetch);
        await h.ready(); h.fill(); h.emit('accountActionsSelectorForm', 'submit');
        h.nodes.get('accountActionsOrganisation').value = 'Different-Organisation'; h.emit('accountActionsSelectorForm', 'input');
        expect(fetch.mock.calls[1][1].signal.aborted).toBe(true); late.resolve(reply(inspected())); await h.ready();
        expect(h.nodes.get('accountActionsInspection').hidden).toBe(true); expect(h.nodes.get('accountActionsPrepareFields').disabled).toBe(true);
    });
    test('expiry disables execution while keeping safe preview discard available', async () => {
        const fetch = normalFetch(), h = harness(fetch); await h.ready(); await h.inspect(); await h.prepare();
        h.nodes.get('accountActionsConfirm').checked = true;
        h.setNow(NOW + 300000); h.timers.find(timer => timer.delay === 300000 && !timer.cleared).fn();
        expect(h.nodes.get('accountActionsExecute').disabled).toBe(true); expect(h.nodes.get('accountActionsConfirmFields').disabled).toBe(false);
        h.emit('accountActionsConfirmForm', 'submit'); expect(fetch).toHaveBeenCalledTimes(3);
        h.emit('accountActionsDiscard'); expect(h.nodes.get('accountActionsPreview').hidden).toBe(true);
    });
    test.each(['cancel', 'timeout', 'network', '503'])('%s during execution retains the same request and requires outcome recovery', async kind => {
        const late = deferred(), fetch = jest.fn().mockResolvedValueOnce(reply({ accountActions: true })).mockResolvedValueOnce(reply(inspected()))
            .mockResolvedValueOnce(reply(preparation())).mockReturnValueOnce(late.promise).mockResolvedValueOnce(reply(receipt()));
        const h = harness(fetch); await h.ready(); await h.inspect(); await h.prepare(); h.confirm();
        if (kind === 'cancel') h.emit('accountActionsCancel');
        if (kind === 'timeout') h.timers.at(-1).fn();
        if (kind === 'network') late.reject(new Error('PRIVATE_FAILURE'));
        if (kind === '503') late.resolve(reply({ raw: 'PRIVATE_FAILURE' }, 503));
        await h.ready(); expect(h.nodes.get('accountActionsRecover').hidden).toBe(false);
        expect(h.nodes.get('accountActionsSelectorFields').disabled).toBe(true); expect(h.nodes.get('accountActionsFresh').hidden).toBe(true);
        h.emit('accountActionsSelectorForm', 'submit'); h.confirm(); expect(fetch).toHaveBeenCalledTimes(4);
        if (['cancel', 'timeout'].includes(kind)) { expect(fetch.mock.calls[3][1].signal.aborted).toBe(true); late.resolve(reply(receipt())); await h.ready(); expect(h.nodes.get('accountActionsOutcome').hidden).toBe(true); }
        const warning = h.dispatch('beforeunload'); expect(warning.preventDefault).toHaveBeenCalled();
        h.emit('accountActionsRecover'); await h.ready();
        expect(fetch.mock.calls[4][0]).toBe('/api/dashboard-admin/actions/outcome');
        expect(fetch.mock.calls[4][1].body).toBe(fetch.mock.calls[3][1].body);
        expect(h.nodes.get('accountActionsOutcome').textContent).toContain('Succeeded');
        expect(h.nodes.get('accountActionsStatus').textContent).not.toContain('PRIVATE_FAILURE');
        expect(h.dispatch('beforeunload').preventDefault).not.toHaveBeenCalled();
    });
    test('pending and not_started preserve uncertainty; only explicit same-token retry is allowed', async () => {
        const fetch = normalFetch(reply(receipt('pending')), reply(receipt('not_started')), reply(receipt())), h = harness(fetch);
        await h.ready(); await h.inspect(); await h.prepare(); h.confirm(); await h.ready();
        expect(h.nodes.get('accountActionsStatus').textContent).toContain('pending'); h.emit('accountActionsRecover'); await h.ready();
        expect(h.nodes.get('accountActionsStatus').textContent).toContain('original request may still finish');
        expect(h.nodes.get('accountActionsResume').hidden).toBe(false); expect(h.nodes.get('accountActionsFresh').hidden).toBe(true);
        h.emit('accountActionsPrepareForm', 'submit'); expect(fetch).toHaveBeenCalledTimes(5);
        h.emit('accountActionsResume'); await h.ready(); expect(fetch.mock.calls[5][1].body).toBe(fetch.mock.calls[3][1].body);
        expect(h.nodes.get('accountActionsOutcome').textContent).toContain('Succeeded');
    });
    test('an uncertain request cannot be resent after expiry, while outcome recovery stays available', async () => {
        const fetch = normalFetch(reply(receipt('not_started'))), h = harness(fetch);
        await h.ready(); await h.inspect(); await h.prepare(); h.confirm(); await h.ready();
        expect(h.nodes.get('accountActionsResume').hidden).toBe(false);
        h.setNow(NOW + 300000); h.timers.find(timer => timer.delay === 300000 && !timer.cleared).fn();
        expect(h.nodes.get('accountActionsResume').hidden).toBe(true); expect(h.nodes.get('accountActionsRecover').hidden).toBe(false);
        expect(h.nodes.get('accountActionsFresh').hidden).toBe(true); h.emit('accountActionsResume'); expect(fetch).toHaveBeenCalledTimes(4);
    });
    test('stale execute requires outcome reconciliation and does not silently issue a fresh change', async () => {
        const fetch = normalFetch(reply({ code: 'dashboard_admin_conflict' }, 409), reply(receipt('not_started'))), h = harness(fetch);
        await h.ready(); await h.inspect(); await h.prepare(); h.confirm(); await h.ready();
        expect(h.nodes.get('accountActionsStatus').textContent).toContain('stale'); expect(h.nodes.get('accountActionsFresh').hidden).toBe(true);
        h.emit('accountActionsRecover'); await h.ready(); expect(h.nodes.get('accountActionsFresh').hidden).toBe(true);
        expect(fetch.mock.calls[4][1].body).toBe(fetch.mock.calls[3][1].body);
    });
    test('only server-confirmed expired absence unlocks a new inspection after an uncertain request', async () => {
        const fetch = normalFetch(reply({ code: 'dashboard_admin_conflict' }, 409), reply(receipt('not_started')),
            reply(receipt('not_started_expired')), reply(inspected())), h = harness(fetch);
        await h.ready(); await h.inspect(); await h.prepare(); h.confirm(); await h.ready();
        h.setNow(NOW + 600000); h.emit('accountActionsRecover'); await h.ready();
        expect(h.nodes.get('accountActionsFresh').hidden).toBe(true); expect(h.nodes.get('accountActionsResume').hidden).toBe(true);
        h.emit('accountActionsRecover'); await h.ready(); expect(h.nodes.get('accountActionsFresh').hidden).toBe(false);
        expect(h.nodes.get('accountActionsOutcome').textContent).toContain('expired without applying');
        h.emit('accountActionsFresh'); await h.ready(); expect(fetch.mock.calls[6][0]).toBe('/api/dashboard-admin/actions/inspect');
        expect(h.nodes.get('accountActionsPrepareFields').disabled).toBe(false);
    });
    test.each([401, 403])('late %s broadcasts revocation and clears every panel and identifying field', async code => {
        const late = deferred(), fetch = jest.fn(url => url.endsWith('capabilities') ? Promise.resolve(reply({ accountActions: true, lookup: true, recovery: [], signupList: true })) : late.promise);
        const h = harness(fetch, true); await h.ready(); h.fill(); h.emit('accountActionsSelectorForm', 'submit'); h.emit('accountActionsCancel');
        h.nodes.get('adminLookupResult').textContent = 'PRIVATE_LOOKUP'; h.nodes.get('adminLookupResult').hidden = false;
        h.nodes.get('signupQueueResult').textContent = 'PRIVATE_SIGNUP'; h.nodes.get('signupQueueResult').hidden = false;
        late.resolve(reply({ raw: 'PRIVATE_DIAGNOSTIC' }, code)); await h.ready();
        for (const id of ['accountActionsInspection', 'accountActionsPreview', 'accountActionsOutcome', 'adminLookupResult', 'signupQueueResult']) expect(h.nodes.get(id).textContent).toBe('');
        for (const suffix of ['Subject', 'Tenant', 'Organisation', 'Name']) expect(h.nodes.get('accountActions' + suffix).value).toBe('');
        expect(h.nodes.get('accountActionsSelectorFields').disabled).toBe(true); expect(h.nodes.get('adminLookupFields').disabled).toBe(true); expect(h.nodes.get('signupQueueLoad').disabled).toBe(true);
    });
    test('revocation after execute preserves only an opaque in-memory recovery ticket for re-authorisation', async () => {
        const fetch = normalFetch(reply({}, 403), reply({ accountActions: true }), reply(receipt())), h = harness(fetch);
        await h.ready(); await h.inspect(); await h.prepare(); h.confirm(); await h.ready();
        expect(h.nodes.get('accountActionsPreview').textContent).toBe(''); expect(h.nodes.get('accountActionsSubject').value).toBe('');
        h.emit('accountActionsCheck'); await h.ready(); expect(h.nodes.get('accountActionsRecover').hidden).toBe(false);
        h.emit('accountActionsRecover'); await h.ready(); expect(fetch.mock.calls[5][1].body).toBe(fetch.mock.calls[3][1].body);
        expect(h.nodes.get('accountActionsOutcome').textContent).toContain('Succeeded');
    });
    test.each(['selector', 'private-field', 'membership', 'action', 'type'])('malformed %s inspection fails closed', async mode => {
        const value = inspected(); if (mode === 'selector') value.selector = { ...selector, organisationId: 'another-org' };
        if (mode === 'private-field') value.witness = { secret: 'PRIVATE_WITNESS' }; if (mode === 'membership') value.membership = {};
        if (mode === 'action') value.actions = ['erase'];
        const fetch = jest.fn().mockResolvedValueOnce(reply({ accountActions: true })).mockResolvedValueOnce(reply(value, 200, mode === 'type' ? 'text/html' : 'application/json'));
        const h = harness(fetch); await h.ready(); await h.inspect(); expect(h.nodes.get('accountActionsInspection').hidden).toBe(true);
        expect(h.nodes.get('accountActionsPrepareFields').disabled).toBe(true); expect(h.nodes.get('accountActionsStatus').textContent).toContain('could not be inspected');
    });
    test.each(['selector', 'action', 'patch', 'before', 'extra'])('malformed %s preview never enables confirmation', async mode => {
        const value = preparation(); if (mode === 'selector') value.selector = { ...selector, provider: 'external' };
        if (mode === 'action') value.action = 'delete'; if (mode === 'patch') value.patch = { displayLabel: 'another label' };
        if (mode === 'before') value.before = {}; if (mode === 'extra') value.secret = 'PRIVATE_SECRET';
        const fetch = jest.fn().mockResolvedValueOnce(reply({ accountActions: true })).mockResolvedValueOnce(reply(inspected())).mockResolvedValueOnce(reply(value));
        const h = harness(fetch); await h.ready(); await h.inspect(); await h.prepare(); expect(h.nodes.get('accountActionsPreview').hidden).toBe(true);
        h.confirm(); expect(fetch).toHaveBeenCalledTimes(3);
    });
    test('mismatched outcome never reports success and retains the original recovery token', async () => {
        const fetch = normalFetch(reply(receipt('succeeded', { operationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' }))), h = harness(fetch);
        await h.ready(); await h.inspect(); await h.prepare(); h.confirm(); await h.ready();
        expect(h.nodes.get('accountActionsOutcome').hidden).toBe(true); expect(h.nodes.get('accountActionsRecover').hidden).toBe(false);
    });
    test('existing organisation names use safe text nodes; invalid label or selector never reaches service', async () => {
        const injection = '<img src=x onerror=alert(1)>', fetch = jest.fn().mockResolvedValueOnce(reply({ accountActions: true })).mockResolvedValueOnce(reply(inspected({ displayName: injection })));
        const h = harness(fetch); await h.ready(); h.fill({ ...selector, tenantId: 'bad*scope' }); h.emit('accountActionsSelectorForm', 'submit'); expect(fetch).toHaveBeenCalledTimes(1);
        await h.inspect(); expect(h.nodes.get('accountActionsInspection').textContent).toContain(injection); expect(h.nodes.get('accountActionsInspection').querySelectorAll('img')).toHaveLength(0);
        h.nodes.get('accountActionsName').value = '<b>unsafe label</b>'; h.emit('accountActionsPrepareForm', 'submit'); expect(fetch).toHaveBeenCalledTimes(2);
    });
    test('pagehide clears all identity data and confirmation, rejects late success and pageshow rechecks access', async () => {
        const late = deferred(), fetch = normalFetch(); fetch.mockReset().mockResolvedValueOnce(reply({ accountActions: true })).mockResolvedValueOnce(reply(inspected()))
            .mockResolvedValueOnce(reply(preparation())).mockReturnValueOnce(late.promise).mockResolvedValueOnce(reply({ accountActions: true }));
        const h = harness(fetch); await h.ready(); await h.inspect(); await h.prepare(); h.confirm(); h.dispatch('pagehide');
        late.resolve(reply(receipt())); await h.ready(); expect(h.nodes.get('accountActionsPreview').textContent).toBe(''); expect(h.nodes.get('accountActionsSubject').value).toBe('');
        h.dispatch('pageshow', { persisted: true }); await h.ready(); h.emit('accountActionsRecover'); expect(fetch).toHaveBeenCalledTimes(5);
        expect(h.nodes.get('accountActionsOutcome').hidden).toBe(true);
    });
});

test('half-created signup reset has no fabricated membership and requires typed name plus explicit confirmation', async () => {
    const fetch = jest.fn().mockResolvedValueOnce(reply({ accountActions: true }))
        .mockResolvedValueOnce(reply(inspected({ membership: null, actions: ['reset'], signup: {
            state: 'half_created', accountId: '74000000-0000-4000-8000-000000000100', hasAuthority: false } })))
        .mockResolvedValueOnce(reply(preparation('reset', null, { before: { displayName: 'Synthetic organisation', displayLabel: null, membership: null } })))
        .mockResolvedValueOnce(reply(receipt()));
    const h = harness(fetch); await h.ready(); await h.inspect();
    expect(h.nodes.get('accountActionsInspection').textContent).toContain('Not created');
    await h.prepare('reset');
    expect(JSON.parse(fetch.mock.calls[2][1].body)).toEqual({ selector, action: 'reset', patch: null, confirmationName: 'Synthetic organisation' });
    expect(h.nodes.get('accountActionsPreview').textContent).toContain('half-created External ID signup');
    expect(h.nodes.get('accountActionsExecute').disabled).toBe(true); h.confirm(); await h.ready(); expect(fetch).toHaveBeenCalledTimes(4);
});
test('complete member and invitation lists remain in the protected view and clear on revocation', async () => {
    const rows = [{ membershipId: 'member-a', subjectKey: selector.subjectKey, status: 'active', roles: ['viewer'],
        validFrom: membership.validFrom, validUntil: membership.validUntil, effectiveStatus: 'active' },
    { membershipId: 'member-b', subjectKey: selector.subjectKey.replace(/b/g, 'c'), status: 'suspended', roles: ['editor'],
        validFrom: membership.validFrom, validUntil: membership.validUntil, effectiveStatus: 'suspended' }];
    const h = harness(jest.fn().mockResolvedValueOnce(reply({ accountActions: true }))
        .mockResolvedValueOnce(reply(inspected({ members: rows, invitations: [] }))));
    await h.ready(); await h.inspect();
    expect(h.nodes.get('accountActionsInspection').textContent).toContain('2 records. Complete for this organisation.');
    expect(h.nodes.get('accountActionsInspection').textContent).toContain(rows[1].subjectKey);
    h.dispatch('dashboard-admin-revoked', { detail: 403 });
    expect(h.nodes.get('accountActionsInspection').textContent).toBe('');
});
