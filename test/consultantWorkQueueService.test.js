'use strict';

const { createConsultantWorkQueueService, ConsultantWorkQueueError,
    normaliseConsultantWorkQueuePage } = require('../api/shared/improvementPlan/consultantWorkQueueService');

const GENERATION = 'a'.repeat(64), NOW = '2026-10-23T23:59:59.000Z';
const bindingId = n => '61000000-0000-4000-8000-' + String(n).padStart(12, '0');
function action(id, change = {}) {
    return { actionId: id, rationale: { suggestedAction: 'Review ' + id }, status: 'open', ownerSubjectKey: null,
        dueDate: null, isOverdue: false, blockedReason: null, ...change };
}
function plan(id, actions, revision = 1) {
    return { scope: { tenantId: 'private-tenant', organisationId: 'private-organisation', planId: id },
        planRevision: revision, source: { assessmentId: 'assessment-a', assessmentRevision: 2 }, actions };
}
function fixture(clients = [[plan('plan-a', [action('action-a')])]]) {
    const state = { clients, calls: [], finishError: null, unavailable: new Set() };
    const ports = { generation: GENERATION, clock: jest.fn(() => NOW),
        listBindings: jest.fn(async page => {
            const all = clients.map((_, i) => ({ bindingId: bindingId(i + 1), organisationLabel: 'Client ' + (i + 1) }));
            const remaining = all.filter(row => page.afterBindingId === null || row.bindingId > page.afterBindingId);
            return { bindings: remaining.slice(0, page.limit), nextAfterBindingId: remaining.length > page.limit ? remaining[page.limit - 1].bindingId : null };
        }),
        plans: jest.fn(async (id, page) => {
            state.calls.push(['plans', id, page]);
            if (state.unavailable.has(id)) throw Object.assign(new Error(), { statusCode: 403 });
            const all = clients[Number(id.slice(-12)) - 1].filter(row => page.afterPlanId === null || row.scope.planId > page.afterPlanId);
            return { plans: all.slice(0, page.limit).map(row => ({ planId: row.scope.planId, planRevision: row.planRevision })),
                nextAfterPlanId: all.length > page.limit ? all[page.limit - 1].scope.planId : null };
        }),
        list: jest.fn(async (id, selected) => {
            state.calls.push(['list', id, selected]);
            return clients[Number(id.slice(-12)) - 1].find(row => row.scope.planId === selected.planId);
        }),
        finish: jest.fn(async () => { if (state.finishError) throw state.finishError; }),
        assertDisclosure: jest.fn(() => { if (state.disclosureError) throw state.disclosureError; }) };
    return { state, ports, service: createConsultantWorkQueueService(ports) };
}
const read = (h, limit = 50, cursor = null) => h.service.read({ limit, cursor });

test('combines real action projections with exact client/plan/action identities and strips private scope and subjects', async () => {
    const h = fixture([[plan('plan-a', [action('same-action', { ownerSubjectKey: 'private-subject', dueDate: '2026-10-22' })])],
        [plan('plan-a', [action('same-action', { status: 'completed', dueDate: '2026-10-22', ownerSubjectKey: 'another-subject' })])]]);
    const result = await read(h);
    expect(result.rows).toHaveLength(2);
    expect(result.rows.map(row => [row.bindingId, row.planId, row.actionId])).toEqual([
        [bindingId(1), 'plan-a', 'same-action'], [bindingId(2), 'plan-a', 'same-action']]);
    expect(result.rows[0]).toMatchObject({ assigned: true, ownerEligibility: 'not_checked', isOverdue: true,
        source: { assessmentId: 'assessment-a', assessmentRevision: 2 } });
    expect(result.rows[1]).toMatchObject({ status: 'completed', isOverdue: false });
    expect(JSON.stringify(result)).not.toMatch(/private-|another-subject|tenantId|organisationId|ownerSubjectKey/);
    expect(result.coverage).toEqual({ basis: 'current_page', checkedOrganisations: 2, partialOrganisations: 0,
        unavailableOrganisations: 0, complete: true });
    expect(result.nextCursor).toBeNull(); expect(h.ports.finish).toHaveBeenCalledTimes(1);
});

test('finite traversal resumes within a retained plan and crosses plans/clients without duplicate actions', async () => {
    const h = fixture([[plan('plan-a', [action('a'), action('b'), action('c')]), plan('plan-b', [action('d')])],
        [], [plan('plan-a', [action('a'), action('b')])]]);
    let cursor = null, result, pages = 0; const keys = [];
    do {
        result = await read(h, 2, cursor); cursor = result.nextCursor; pages++;
        expect(result.rows.length).toBeLessThanOrEqual(2);
        keys.push(...result.rows.map(row => [row.bindingId, row.planId, row.actionId].join('/')));
        expect(pages).toBeLessThan(6);
    } while (cursor);
    expect(keys).toHaveLength(6); expect(new Set(keys).size).toBe(6); expect(pages).toBe(3);
    expect(result.coverage.complete).toBe(true);
});

test('a partial client has explicit current-page coverage, not a portfolio total', async () => {
    const h = fixture([[plan('plan-a', [action('a'), action('b')])], [plan('plan-b', [action('c')])]]);
    const first = await read(h, 1);
    expect(first.organisations).toEqual([{ bindingId: bindingId(1), organisationLabel: 'Client 1', state: 'partial', plansChecked: 1 }]);
    expect(first.coverage).toEqual({ basis: 'current_page', checkedOrganisations: 0, partialOrganisations: 1,
        unavailableOrganisations: 0, complete: false });
    expect(first.nextCursor).not.toBeNull();
});

test('retained revision or directory-position changes require refresh instead of skipping/replaying rows', async () => {
    const h = fixture([[plan('plan-a', [action('a'), action('b')])]]), first = await read(h, 1);
    h.state.clients[0][0].planRevision++;
    await expect(read(h, 1, first.nextCursor)).rejects.toMatchObject({ code: 'work_queue_changed', statusCode: 409 });
    h.state.clients[0][0].planRevision--;
    h.ports.listBindings.mockResolvedValue({ bindings: [{ bindingId: bindingId(2), organisationLabel: 'Changed' }], nextAfterBindingId: null });
    await expect(read(h, 1, first.nextCursor)).rejects.toMatchObject({ statusCode: 409 });
});

test('a continuation from a different generation is rejected before directory I/O', async () => {
    const h = fixture([[plan('plan-a', [action('a'), action('b')])]]), first = await read(h, 1);
    const next = createConsultantWorkQueueService({ ...h.ports, generation: 'b'.repeat(64) });
    h.ports.listBindings.mockClear();
    await expect(next.read({ limit: 1, cursor: first.nextCursor })).rejects.toMatchObject({ code: 'work_queue_changed' });
    expect(h.ports.listBindings).not.toHaveBeenCalled();
});

test.each([
    { limit: 0, cursor: null }, { limit: 51, cursor: null }, { limit: 1, cursor: '' },
    { limit: 1, cursor: null, tenantId: 'forged' }, { limit: 1, cursor: 'e30' },
    { limit: 1, cursor: Buffer.from('{"__proto__":{}}').toString('base64url') }
])('invalid selectors cannot invoke directory reads: %j', async input => {
    const h = fixture(); await expect(h.service.read(input)).rejects.toMatchObject({ statusCode: 400 });
    expect(h.ports.listBindings).not.toHaveBeenCalled();
});

test('denied clients contribute no label or rows and cannot create a portfolio all-clear', async () => {
    const h = fixture([[], [plan('plan-a', [action('private-action')])]]);
    h.state.unavailable.add(bindingId(2));
    const result = await read(h);
    expect(result.rows).toEqual([]);
    expect(result.organisations).toEqual([{ bindingId: bindingId(1), organisationLabel: 'Client 1', state: 'checked', plansChecked: 0 }]);
    expect(result.coverage).toMatchObject({ complete: true, unavailableOrganisations: 1, checkedOrganisations: 1 });
    expect(JSON.stringify(result)).not.toMatch(/Client 2|private-action/);
});

test('final authority failure withholds all prepared rows', async () => {
    const h = fixture(), denied = new ConsultantWorkQueueError('work_queue_access_denied', 403);
    h.state.finishError = denied;
    await expect(read(h)).rejects.toBe(denied);
    expect(h.ports.list).toHaveBeenCalledTimes(1); expect(h.ports.finish).toHaveBeenCalledTimes(1);
});

test('expiry at the asynchronous finish continuation withholds the prepared payload', async () => {
    const h = fixture(), expired = new ConsultantWorkQueueError('work_queue_access_denied', 403);
    h.ports.finish.mockImplementation(async () => { h.state.disclosureError = expired; });
    await expect(read(h)).rejects.toBe(expired);
    expect(h.ports.assertDisclosure).toHaveBeenCalledTimes(1);
});

test('empty clients and empty plans obey finite server work budgets and produce forward continuations', async () => {
    const clients = Array.from({ length: 7 }, () => []), h = fixture(clients);
    const result = await read(h);
    expect(result.organisations).toHaveLength(5); expect(result.rows).toEqual([]); expect(result.nextCursor).not.toBeNull();
    expect((await read(h, 50, result.nextCursor)).organisations).toHaveLength(2);
    const manyPlans = fixture([Array.from({ length: 12 }, (_, i) => plan('plan-' + String(i).padStart(2, '0'), []))]);
    const page = await read(manyPlans);
    expect(manyPlans.ports.list).toHaveBeenCalledTimes(10); expect(page.nextCursor).not.toBeNull();
    expect((await read(manyPlans, 50, page.nextCursor)).nextCursor).toBeNull();
});

test('output bytes are bounded and a new plan can resume at offset zero', async () => {
    const large = 'x'.repeat(140000), h = fixture([[plan('plan-a', [action('a', { rationale: { suggestedAction: large } })]),
        plan('plan-b', [action('b', { rationale: { suggestedAction: large } })])]]);
    const first = await read(h); expect(first.rows).toHaveLength(1); expect(first.nextCursor).not.toBeNull();
    const second = await read(h, 50, first.nextCursor); expect(second.rows.map(row => row.actionId)).toEqual(['b']);
    expect(second.nextCursor).toBeNull();
});

test('overdue uses the page server UTC date and completed actions are never overdue', async () => {
    const h = fixture([[plan('plan-a', [action('before', { dueDate: '2026-10-22', isOverdue: false }),
        action('today', { dueDate: '2026-10-23', isOverdue: true }), action('done', { status: 'completed', dueDate: '2026-10-20', isOverdue: true })])]]);
    const result = await read(h);
    expect(result.asOf).toBe(NOW); expect(result.dueDateBasis).toBe('UTC_calendar_day');
    expect(result.rows.map(row => row.isOverdue)).toEqual([true, false, false]);
});

test('input normalisation is detached and closed', () => {
    const input = { limit: 3, cursor: null }, value = normaliseConsultantWorkQueuePage(input);
    input.limit = 50; expect(value.limit).toBe(3); expect(Object.isFrozen(value)).toBe(true);
});
