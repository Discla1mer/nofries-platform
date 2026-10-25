'use strict';

// Controller/DOM contract evidence. Actual layout and keyboard evidence is in
// scripts/tests/dashboard-admin-browser.cjs; this harness is not a browser.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createDom } = require('./fixtures/dashboardDom');
const { buildDashboardAdminDocument, dashboardAdminCss, contentSecurityPolicy } = require('../lib/dashboardAdminDocument');
const { createDashboardAdminService } = require('../api/shared/dashboardAdmin/service');
const { dataCodec } = require('../api/shared/appLifecycle/postgresDashboardBootstrap');
const { applyMembershipCommand } = require('../api/shared/appLifecycle/membershipDomain');
const { fixture: dashboardFixture, SUBJECT, NOW } = require('./fixtures/dashboardFixture');
const source = fs.readFileSync(path.join(__dirname, '../api/shared/protectedAssets/dashboardAdmin.js'), 'utf8');
const html = buildDashboardAdminDocument();
const pause = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const reply = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
const selection = { provider: 'legacy', subjectKey: SUBJECT, tenantId: '11111111-1111-4111-8111-111111111111',
    organisationId: '22222222-2222-4222-8222-222222222222' };
const found = (overrides = {}) => ({ result: { status: 'found', identity: { provider: selection.provider, subjectKey: selection.subjectKey },
    scope: { tenantId: selection.tenantId, organisationId: selection.organisationId }, evaluatedAt: '2026-10-18T22:00:00.000Z',
    revisions: { tenant: 1, organisation: 2, membership: 3, entitlement: 4, flags: 5 },
    tenant: { displayName: 'Synthetic tenant', status: 'active' }, organisation: { displayName: 'Synthetic organisation', status: 'active' },
    memberships: [{ membershipId: 'synthetic-membership', status: 'active', effectiveStatus: 'active', roles: ['consultant'], validFrom: '2026-10-01T00:00:00.000Z', validUntil: null }],
    invitations: [], entitlements: [{ grantId: 'synthetic-grant', code: 'consultant', status: 'active', validFrom: '2026-10-01T00:00:00.000Z', validUntil: '2026-11-19T00:00:00.000Z' }],
    flags: { enabled: { cyber_security: false } }, usage: [{ grantId: 'synthetic-grant', counters: { assessments: 0 } }],
    signup: { status: 'unavailable' }, diagnostics: { status: 'unavailable' }, recovery: [], ...overrides } });

function harness(fetch) {
    const dom = createDom(), nodes = new Map();
    for (const match of html.matchAll(/<(\w+)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
        const item = dom.document.createElement(match[1]); item.id = match[2]; item.value = '';
        item.disabled = /\sdisabled(?:[\s>])/.test(match[0]); item.hidden = /\shidden(?:[\s>])/.test(match[0]);
        nodes.set(match[2], item);
    }
    nodes.get('adminProvider').value = 'legacy';
    dom.document.getElementById = id => nodes.get(id) || null;
    dom.window.setTimeout = jest.fn(() => 1); dom.window.clearTimeout = jest.fn();
    vm.runInNewContext(source, { document: dom.document, window: dom.window, fetch, AbortController });
    const emit = (id, event) => { for (const listener of nodes.get(id).events[event] || []) listener({ preventDefault() {} }); };
    return { ...dom, nodes, emit, fill(input = selection) {
        for (const [key, id] of Object.entries({ provider: 'adminProvider', subjectKey: 'adminSubject', tenantId: 'adminTenant', organisationId: 'adminOrganisation' }))
            nodes.get(id).value = input[key];
    }, async ready() { await pause(); await pause(); } };
}

describe('dashboard administration document', () => {
    test('uses protected external assets and a strict policy with labelled keyboard controls', () => {
        expect(html).toContain('src="/api/dashboard-admin/app.js" defer');
        expect(html).toContain('href="/api/dashboard-admin/app.css"');
        expect(html).not.toMatch(/<style\b|<script[^>]*>\s*[^<\s]|\son\w+=|\sstyle=/i);
        expect(contentSecurityPolicy).toContain("default-src 'none'");
        expect(contentSecurityPolicy).toContain("frame-ancestors 'none'");
        expect(contentSecurityPolicy).not.toMatch(/unsafe-inline|unsafe-eval|https?:/);
        for (const id of ['adminProvider', 'adminSubject', 'adminTenant', 'adminOrganisation']) expect(html).toContain(`for="${id}"`);
        expect(html).toContain('role="status" aria-live="polite" aria-atomic="true"');
        expect(html).toContain('autocomplete="off"');
        expect(html).toContain('Sales lifecycle customers are separate records');
        expect(dashboardAdminCss).toContain('minmax(0, 1fr)');
        expect(source).not.toMatch(/\.innerHTML|localStorage|sessionStorage|console\./);
    });
});

describe('protected exact lookup controller', () => {
    test('checks capabilities before enabling lookup and submits only an exact provider and scope', async () => {
        const gate = deferred(), fetch = jest.fn().mockReturnValueOnce(gate.promise).mockResolvedValueOnce(reply(found()));
        const h = harness(fetch);
        expect(h.nodes.get('adminLookupFields').disabled).toBe(true);
        h.fill(); h.emit('adminLookupForm', 'submit'); expect(fetch).toHaveBeenCalledTimes(1);
        gate.resolve(reply({ lookup: true, recovery: [] })); await h.ready();
        expect(h.nodes.get('adminLookupFields').disabled).toBe(false);
        h.emit('adminLookupForm', 'submit'); await h.ready();
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(fetch.mock.calls[0][0]).toBe('/api/dashboard-admin/capabilities');
        expect(fetch.mock.calls[1][0]).toBe('/api/dashboard-admin/lookup');
        const request = fetch.mock.calls[1][1];
        expect(JSON.parse(request.body)).toEqual(selection);
        expect(request).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
        const content = h.nodes.get('adminLookupResult').textContent;
        expect(content).toContain('Scoped access records found'); expect(content).toContain('consultant');
        expect(content).toContain('2026-11-19T00:00:00.000Z'); expect(content).toContain('Disabled');
        expect(content).toContain('Unavailable — this lookup does not establish signup completion.');
        expect(content).toContain('Plan details are unavailable');
        expect(content).not.toMatch(/14.day|3.month|signup complete|activation successful/i);
        expect(h.document.activeElement.id).toBe('adminResultHeading');
    });

    test('round trips mixed-case non-UUID scope through the actual service and canonical domain projection without case folding', async () => {
        const selected = { ...selection, tenantId: 'Synthetic-Tenant_A.1', organisationId: 'Synthetic-Workshop_A.1' };
        const fixture = dashboardFixture({ organisationId: selected.organisationId });
        const snapshot = JSON.parse(JSON.stringify({ tenantAggregate: fixture.tenantAggregate, membershipState: fixture.membershipState,
            entitlementState: fixture.entitlementState, flags: fixture.flags, advisorAssignments: [],
            usage: fixture.entitlementState.grants.map(dataCodec.newUsage) }), (key, value) => key === 'tenantId' ? selected.tenantId : value);
        const actor = SUBJECT.slice(0, -1) + '9';
        const principal = { provider: 'entra-bff', isAuthenticated: true, subjectKey: actor };
        const read = jest.fn(async () => ({ snapshot, revisions: dataCodec.revisionVector(snapshot), evaluatedAt: NOW }));
        const service = createDashboardAdminService({ requestBudgetMs: 1000, clock: () => NOW, audit: async () => true,
            authoriseOperator: ({ principal: user, selector }) => user.subjectKey === actor && (!selector ||
                selector.tenantId === selected.tenantId && selector.organisationId === selected.organisationId), readAuthoritySnapshot: read });
        const fetch = jest.fn(async (url, init) => reply(url.endsWith('/capabilities') ? await service.capabilities(principal) :
            await service.lookup(principal, JSON.parse(init.body))));
        const h = harness(fetch); await h.ready(); h.fill(selected); h.emit('adminLookupForm', 'submit'); await h.ready();
        expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual(selected);
        expect(read).toHaveBeenCalledWith({ tenantId: selected.tenantId, organisationId: selected.organisationId },
            { authenticated: true, subjectKey: actor }, selected);
        expect(h.nodes.get('adminLookupResult').hidden).toBe(false);
        expect(h.nodes.get('adminLookupResult').textContent).toContain('Scoped access records found');
        expect(h.nodes.get('adminLookupResult').textContent).toContain('Synthetic-Tenant_A.1');
        expect(h.nodes.get('adminLookupResult').textContent).toContain('Synthetic-Workshop_A.1');
        expect(h.nodes.get('adminLookupResult').textContent).toContain('Unavailable — no trusted diagnostic reader is connected.');
    });

    test('an actual service invitation-only result uses neutral access wording without inferring membership or completed signup', async () => {
        const targetSubject = SUBJECT.slice(0, -1) + '2', actor = SUBJECT.slice(0, -1) + '9';
        const fixture = dashboardFixture(), selected = { ...fixture.scope, provider: 'legacy', subjectKey: targetSubject };
        const membershipState = applyMembershipCommand(fixture.membershipState, fixture.tenantAggregate, { ...fixture.scope,
            expectedRevision: fixture.membershipState.revision, actorSubjectKey: SUBJECT, now: NOW, action: 'invite',
            payload: { invitationId: 'synthetic-pending-only', subjectKey: targetSubject, roles: ['viewer'], validFrom: NOW,
                validUntil: fixture.entitlementState.grants[0].validUntil, expiresAt: fixture.entitlementState.grants[0].validUntil,
                grantEvidenceId: 'synthetic-pending-evidence' } });
        const snapshot = { tenantAggregate: fixture.tenantAggregate, membershipState, entitlementState: fixture.entitlementState,
            flags: fixture.flags, advisorAssignments: [], usage: fixture.entitlementState.grants.map(dataCodec.newUsage) };
        const principal = { provider: 'entra-bff', isAuthenticated: true, subjectKey: actor };
        const service = createDashboardAdminService({ requestBudgetMs: 1000, clock: () => NOW, audit: async () => true,
            authoriseOperator: ({ principal: user, selector }) => user.subjectKey === actor && (!selector ||
                selector.subjectKey === targetSubject && selector.tenantId === selected.tenantId && selector.organisationId === selected.organisationId),
            readAuthoritySnapshot: async () => ({ snapshot, revisions: dataCodec.revisionVector(snapshot), evaluatedAt: NOW }) });
        let projected;
        const fetch = jest.fn(async (url, init) => {
            if (url.endsWith('/capabilities')) return reply(await service.capabilities(principal));
            projected = await service.lookup(principal, JSON.parse(init.body)); return reply(projected);
        });
        const h = harness(fetch); await h.ready(); h.fill(selected); h.emit('adminLookupForm', 'submit'); await h.ready();
        expect(projected.result).toMatchObject({ status: 'found', memberships: [], invitations: [{ status: 'pending' }], signup: { status: 'unavailable' } });
        const output = h.nodes.get('adminLookupResult'), children = output.children;
        expect(children[0].textContent).toBe('Scoped access records found');
        expect(h.nodes.get('adminLookupStatus').textContent).toBe('Scoped access records found.');
        const membershipHeading = children.findIndex(item => item.tagName === 'H3' && item.textContent === 'Memberships');
        expect(children[membershipHeading + 1].textContent).toBe('None recorded in this snapshot.');
        const invitationHeading = children.findIndex(item => item.tagName === 'H3' && item.textContent === 'Invitations');
        expect(children[invitationHeading + 1].textContent).toContain('pending');
        expect(output.textContent).not.toMatch(/Scoped membership found|Effective status|synthetic-membership|signup complete|activation successful/i);
        expect(output.textContent).toContain('Unavailable — this lookup does not establish signup completion.');
    });

    test.each(['memberships', 'invitations', 'entitlements', 'usage'].flatMap(field =>
        [undefined, null, {}, 'private-detail', false, 0].map(rows => [field, rows])))
    ('malformed found collection %s=%p is unavailable, never a verified empty result', async (field, rows) => {
        const fetch = jest.fn().mockResolvedValueOnce(reply({ lookup: true, recovery: [] }))
            .mockResolvedValueOnce(reply(found())).mockResolvedValueOnce(reply(found({ [field]: rows })))
            .mockResolvedValueOnce(reply(found()));
        const h = harness(fetch); await h.ready(); h.fill(); h.emit('adminLookupForm', 'submit'); await h.ready();
        expect(h.nodes.get('adminLookupResult').hidden).toBe(false);
        h.emit('adminLookupForm', 'submit'); await h.ready();
        expect(h.nodes.get('adminLookupResult').hidden).toBe(true);
        expect(h.nodes.get('adminLookupResult').textContent).toBe('');
        expect(h.nodes.get('adminLookupStatus').textContent).toBe('Lookup unavailable. No account state has been inferred. You can try again.');
        expect(h.nodes.get('adminLookupSubmit').disabled).toBe(false);
        expect(h.nodes.get('adminLookupCancel').hidden).toBe(true);
        expect(h.nodes.get('adminLookupForm').getAttribute('aria-busy')).toBe('false');
        h.emit('adminLookupForm', 'submit'); await h.ready();
        expect(h.nodes.get('adminLookupResult').textContent).toContain('Scoped access records found');
        expect(fetch).toHaveBeenCalledTimes(4);
    });

    test.each([['memberships', 'Memberships'], ['invitations', 'Invitations'], ['entitlements', 'Entitlements'], ['usage', 'Usage']])
    ('an explicit empty %s collection remains a verified empty result', async (field, title) => {
        const fetch = jest.fn().mockResolvedValueOnce(reply({ lookup: true, recovery: [] }))
            .mockResolvedValueOnce(reply(found({ [field]: [] })));
        const h = harness(fetch); await h.ready(); h.fill(); h.emit('adminLookupForm', 'submit'); await h.ready();
        const output = h.nodes.get('adminLookupResult'), children = output.children;
        const heading = children.findIndex(item => item.tagName === 'H3' && item.textContent === title);
        expect(output.hidden).toBe(false);
        expect(children[heading + 1].textContent).toBe('None recorded in this snapshot.');
        expect(h.nodes.get('adminLookupStatus').textContent).toBe('Scoped access records found.');
    });

    test('case-only response substitution is rejected rather than treated as the requested scope', async () => {
        const selected = { ...selection, tenantId: 'Synthetic-Tenant_A.1', organisationId: 'Synthetic-Workshop_A.1' };
        const fetch = jest.fn().mockResolvedValueOnce(reply({ lookup: true, recovery: [] })).mockResolvedValueOnce(reply(found({
            scope: { tenantId: selected.tenantId.toLowerCase(), organisationId: selected.organisationId } })));
        const h = harness(fetch); await h.ready(); h.fill(selected); h.emit('adminLookupForm', 'submit'); await h.ready();
        expect(h.nodes.get('adminLookupResult').hidden).toBe(true);
        expect(h.nodes.get('adminLookupStatus').textContent).toContain('Lookup unavailable');
    });

    test.each(['', '*', 'with*wildcard', 'with\u0000control', ' leading-space', 'trailing-space ', 'x'.repeat(181)])('rejects out-of-contract scope before network %#', async tenantId => {
        const fetch = jest.fn(async () => reply({ lookup: true, recovery: [] })), h = harness(fetch); await h.ready();
        h.fill({ ...selection, tenantId }); h.emit('adminLookupForm', 'submit');
        expect(fetch).toHaveBeenCalledTimes(1); expect(h.nodes.get('adminLookupStatus').textContent).toContain('exact tenant and organisation identifiers');
    });

    test.each([false, undefined, 'true'])('missing or absent lookup capability fails closed: %s', async lookup => {
        const fetch = jest.fn(async () => reply({ lookup, recovery: [] })), h = harness(fetch); await h.ready();
        expect(h.nodes.get('adminLookupFields').disabled).toBe(true);
        h.fill(); h.emit('adminLookupForm', 'submit'); await h.ready();
        expect(fetch).toHaveBeenCalledTimes(1); expect(h.nodes.get('adminLookupResult').hidden).toBe(true);
        expect(h.nodes.get('adminAccessStatus').textContent).toMatch(/unavailable|could not be checked/i);
    });

    test.each([() => Promise.reject(new Error('private-detail')), () => Promise.resolve(new Response('<html>private-detail</html>')),
        () => Promise.resolve(new Response('{', { headers: { 'content-type': 'application/json' } }))])('capability reader failures reveal no raw details %#', async response => {
        const h = harness(jest.fn(response)); await h.ready();
        expect(h.nodes.get('adminLookupFields').disabled).toBe(true);
        expect(h.nodes.get('adminAccessStatus').textContent).toContain('could not be checked');
        expect(h.nodes.get('adminAccessStatus').textContent).not.toContain('private-detail');
        expect(h.nodes.get('adminCheckAccess').disabled).toBe(false);
    });

    test.each(['not_found', 'unavailable', 'ambiguous'])('reports %s without implying universal identity absence or signup success', async status => {
        const fetch = jest.fn().mockResolvedValueOnce(reply({ lookup: true, recovery: [] })).mockResolvedValueOnce(reply(found({ status })));
        const h = harness(fetch); await h.ready(); h.fill(); h.emit('adminLookupForm', 'submit'); await h.ready();
        expect(h.nodes.get('adminLookupResult').hidden).toBe(false);
        expect(h.nodes.get('adminLookupResult').textContent).not.toContain('Synthetic organisation');
        expect(h.nodes.get('adminLookupResult').textContent).toContain('Unavailable — this lookup does not establish signup completion.');
        if (status === 'not_found') expect(h.nodes.get('adminLookupResult').textContent).toContain('another provider or in another scope');
    });

    test('loading supports cancellation, repeated lookup and stale successful response discard', async () => {
        const first = deferred(), second = deferred();
        const fetch = jest.fn().mockResolvedValueOnce(reply({ lookup: true, recovery: [] })).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
        const h = harness(fetch); await h.ready(); h.fill(); h.emit('adminLookupForm', 'submit');
        expect(h.nodes.get('adminLookupSubmit').disabled).toBe(true); expect(h.nodes.get('adminLookupCancel').hidden).toBe(false);
        expect(h.nodes.get('adminLookupForm').getAttribute('aria-busy')).toBe('true');
        h.emit('adminLookupCancel', 'click');
        expect(fetch.mock.calls[1][1].signal.aborted).toBe(true); expect(h.nodes.get('adminLookupResult').hidden).toBe(true);
        expect(h.document.activeElement).toBe(h.nodes.get('adminLookupSubmit'));
        h.emit('adminLookupForm', 'submit'); second.resolve(reply(found({ organisation: { displayName: 'Current synthetic result', status: 'active' } })));
        await h.ready(); first.resolve(reply(found({ organisation: { displayName: 'Stale synthetic result', status: 'active' } }))); await h.ready();
        expect(h.nodes.get('adminLookupResult').textContent).toContain('Current synthetic result');
        expect(h.nodes.get('adminLookupResult').textContent).not.toContain('Stale synthetic result');
        expect(h.nodes.get('adminLookupSubmit').disabled).toBe(false);
    });

    test('a timed out read aborts and restores a truthful retry state without keeping an earlier record', async () => {
        const fetch = jest.fn().mockResolvedValueOnce(reply({ lookup: true, recovery: [] })).mockResolvedValueOnce(reply(found()))
            .mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('private-timeout-detail')))));
        const h = harness(fetch); await h.ready(); h.fill(); h.emit('adminLookupForm', 'submit'); await h.ready();
        expect(h.nodes.get('adminLookupResult').hidden).toBe(false);
        h.emit('adminLookupForm', 'submit');
        const timeout = h.window.setTimeout.mock.calls.at(-1);
        expect(timeout[1]).toBe(15000); timeout[0](); await h.ready();
        expect(fetch.mock.calls[2][1].signal.aborted).toBe(true); expect(h.nodes.get('adminLookupResult').hidden).toBe(true);
        expect(h.nodes.get('adminLookupSubmit').disabled).toBe(false); expect(h.nodes.get('adminLookupCancel').hidden).toBe(true);
        expect(h.nodes.get('adminLookupStatus').textContent).toContain('Lookup unavailable');
        expect(h.nodes.get('adminLookupStatus').textContent).not.toContain('private-timeout-detail');
    });

    test.each(['input', 'change'])('%s clears saved output and aborts pending response', async event => {
        const pending = deferred(), fetch = jest.fn().mockResolvedValueOnce(reply({ lookup: true, recovery: [] })).mockResolvedValueOnce(reply(found())).mockReturnValueOnce(pending.promise);
        const h = harness(fetch); await h.ready(); h.fill(); h.emit('adminLookupForm', 'submit'); await h.ready();
        expect(h.nodes.get('adminLookupResult').hidden).toBe(false);
        h.emit('adminLookupForm', event); expect(h.nodes.get('adminLookupResult').hidden).toBe(true);
        h.emit('adminLookupForm', 'submit'); h.emit('adminLookupForm', event);
        expect(fetch.mock.calls[2][1].signal.aborted).toBe(true);
        pending.resolve(reply(found())); await h.ready(); expect(h.nodes.get('adminLookupResult').hidden).toBe(true);
    });

    test.each([401, 403])('observed %s revokes access, clears output and identifying fields, including from a stale request', async status => {
        const pending = deferred(), fetch = jest.fn().mockResolvedValueOnce(reply({ lookup: true, recovery: [] })).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(reply(found()));
        const h = harness(fetch); await h.ready(); h.fill(); h.emit('adminLookupForm', 'submit'); h.emit('adminLookupCancel', 'click');
        h.emit('adminLookupForm', 'submit'); await h.ready(); expect(h.nodes.get('adminLookupResult').hidden).toBe(false);
        pending.resolve(reply({ message: 'private-detail' }, status)); await h.ready();
        expect(h.nodes.get('adminLookupResult').hidden).toBe(true); expect(h.nodes.get('adminLookupResult').textContent).toBe('');
        expect(h.nodes.get('adminLookupFields').disabled).toBe(true); expect(h.nodes.get('adminLookupSubmit').disabled).toBe(true);
        expect(h.nodes.get('adminSubject').value).toBe(''); expect(h.nodes.get('adminTenant').value).toBe(''); expect(h.nodes.get('adminOrganisation').value).toBe('');
        expect(h.nodes.get('adminAccessStatus').textContent).not.toContain('private-detail');
        expect(h.nodes.get('adminSignIn').hidden).toBe(status !== 401);
        h.fill(); h.emit('adminLookupForm', 'submit'); expect(fetch).toHaveBeenCalledTimes(3);
    });

    test('refuses mismatched response scope and renders untrusted display text as text nodes', async () => {
        const injection = '<img src=x onerror=alert(1)>', fetch = jest.fn().mockResolvedValueOnce(reply({ lookup: true, recovery: [] }))
            .mockResolvedValueOnce(reply(found({ scope: { tenantId: selection.tenantId, organisationId: '33333333-3333-4333-8333-333333333333' } })))
            .mockResolvedValueOnce(reply(found({ organisation: { displayName: injection, status: 'active' }, unapprovedSecret: 'private-detail' })));
        const h = harness(fetch); await h.ready(); h.fill(); h.emit('adminLookupForm', 'submit'); await h.ready();
        expect(h.nodes.get('adminLookupResult').hidden).toBe(true); expect(h.nodes.get('adminLookupStatus').textContent).toContain('Lookup unavailable');
        h.emit('adminLookupForm', 'submit'); await h.ready();
        expect(h.nodes.get('adminLookupResult').textContent).toContain(injection);
        expect(h.nodes.get('adminLookupResult').querySelectorAll('img')).toHaveLength(0);
        expect(h.nodes.get('adminLookupResult').textContent).not.toContain('private-detail');
    });

    test('invalid exact scope never sends a lookup and page exit clears output', async () => {
        const fetch = jest.fn().mockResolvedValueOnce(reply({ lookup: true, recovery: [] })).mockResolvedValueOnce(reply(found()));
        const h = harness(fetch); await h.ready(); h.fill({ ...selection, tenantId: 'invalid*scope' }); h.emit('adminLookupForm', 'submit');
        expect(fetch).toHaveBeenCalledTimes(1); expect(h.nodes.get('adminLookupStatus').textContent).toContain('exact tenant');
        h.fill(); h.emit('adminLookupForm', 'submit'); await h.ready(); h.window.dispatch('pagehide');
        expect(h.nodes.get('adminLookupResult').hidden).toBe(true);
        expect(h.nodes.get('adminLookupFields').disabled).toBe(true);
    });
});
