'use strict';

// Genuine native request/session/context, source/repositories, store, domain and
// paired audit. Only current authority and submitted-assessment read boundaries
// use existing controlled fixtures. No PostgreSQL/RLS or live acceptance claim.
jest.mock('../api/shared/appLifecycle/postgresDashboardBootstrap', () => {
    const actual = jest.requireActual('../api/shared/appLifecycle/postgresDashboardBootstrap');
    return { ...actual, dataStorage: { ...actual.dataStorage,
        loadSnapshotForShare: jest.fn(), loadSnapshotForUpdate: jest.fn() } };
});
jest.mock('../api/shared/assessmentLifecycle/postgresNcscAssessmentStore', () => {
    const actual = jest.requireActual('../api/shared/assessmentLifecycle/postgresNcscAssessmentStore');
    return { ...actual, readHead: jest.fn(), readHistory: jest.fn() };
});

const { createDashboardResourceRuntime } = require('../api/shared/dashboardRuntime');
const { dataStorage } = require('../api/shared/appLifecycle/postgresDashboardBootstrap');
const { createImprovementRequestFixture, SUBJECT, NOW, OWNER } = require('./fixtures/improvementRequestFixture');

async function ready(options = {}) {
    const h = createImprovementRequestFixture(options), request = h.request();
    const runtime = createDashboardResourceRuntime(h.options);
    const facade = await runtime.forRequest(request, { expectedGeneration: h.session.generationToken });
    return { ...h, makeRequest: h.request, request, runtime, facade, improvement: facade.improvement };
}
const businessQueries = h => h.state.trace.filter(event => /dashboard_(?:improvement|runtime_audit)/.test(event.sql));
const writes = h => h.state.trace.filter(event => /^(?:INSERT|UPDATE) /.test(event.sql));
const commandEvents = h => h.state.committed.auditRows.filter(row => row.payload.action === 'improvement.write');

test('ordinary composition has no improvement capability and later option mutation cannot enable it', async () => {
    const h = await ready({ enabled: false });
    expect(Object.keys(h.facade).sort()).toEqual(['admission', 'evidence', 'ncsc', 'requestContext']);
    expect(h.improvement).toBeUndefined(); expect(businessQueries(h)).toEqual([]);
    h.options.improvementEnabled = true;
    const next = await h.runtime.forRequest(h.makeRequest(), { expectedGeneration: h.session.generationToken });
    expect(next.improvement).toBeUndefined(); expect(businessQueries(h)).toEqual([]);
});

test('explicit trusted opt-in exposes only the frozen request-bound plans/list/view/editor/execute source', async () => {
    const h = await ready();
    expect(Object.keys(h.improvement).sort()).toEqual(['editor', 'execute', 'list', 'plans', 'view']);
    expect(Object.isFrozen(h.improvement)).toBe(true); expect(Object.isFrozen(h.facade)).toBe(true);
    expect(await h.facade.requestContext.resolve(h.request)).toMatchObject({
        scope: h.example.scope, identity: { authenticated: true, subjectKey: SUBJECT }, resolvedAt: NOW });
    await expect(h.facade.requestContext.resolve({ ...h.request })).rejects.toMatchObject({ statusCode: 403 });
    expect(businessQueries(h)).toEqual([]);
});

test('retained commands, list and readable history share canonical request scope and paired audit settlement', async () => {
    const h = await ready(), generated = await h.improvement.execute(h.generate());
    expect(generated.plan.revision).toBe(0); expect(generated.plan.actions.length).toBeGreaterThan(0);
    expect(h.state.committed.revisions).toHaveLength(1); expect(commandEvents(h)).toHaveLength(1);
    const assigned = await h.improvement.execute(h.command(generated.plan, 'assign', {
        ownerSubjectKey: SUBJECT, dueDate: '2026-09-06' }));
    const started = await h.improvement.execute(h.command(assigned.plan, 'start'));
    const completed = await h.improvement.execute(h.command(started.plan, 'complete', {
        note: 'Synthetic completion pending evidence review.', evidenceReference: 'synthetic:evidence:completion' }));
    const reopened = await h.improvement.execute(h.command(completed.plan, 'reopen', { reason: 'Synthetic review needs more work.' }));
    const list = await h.improvement.list(h.selector());
    const action = list.actions.find(row => row.actionId === generated.plan.actions[0].actionId);
    expect(list.planRevision).toBe(4);
    expect(action).toMatchObject({ status: 'open', ownerSubjectKey: SUBJECT, dueDate: '2026-09-06', isOverdue: true,
        evidence: { completionVerification: 'not_recorded', downloadAllowed: false, scoreEffect: 'none' } });
    expect(action.history.map(row => row.type)).toEqual(['assign', 'start', 'complete', 'reopen']);
    const view = await h.improvement.view(h.selector());
    const readable = view.actions.find(row => row.actionId === action.actionId);
    expect(view).toMatchObject({ presentationVersion: 1, planRevision: reopened.plan.revision });
    expect(readable.history.map(row => row.label)).toEqual(['Assigned', 'Started', 'Completed', 'Reopened']);
    expect(h.state.committed.revisions).toHaveLength(5);
    expect(h.state.committed.auditRows).toHaveLength(7);
    const context = await h.facade.requestContext.resolve(h.request);
    for (const row of h.state.committed.auditRows) {
        expect(row.payload).toMatchObject({ requestId: context.requestId, actorSubjectKey: SUBJECT,
            tenantId: h.example.scope.tenantId, organisationId: h.example.scope.organisationId,
            module: 'improvement_plan', result: 'succeeded' });
        expect(row.session_sha256).toBe(h.session.sessionSha256);
        expect(row.authority_id).toBe(h.binding.authorityRef.authorityId);
    }
    expect(h.state.transactions.filter(tx => tx.mutations.includes('revision'))).toHaveLength(5);
    for (const tx of h.state.transactions.filter(tx => tx.mutations.includes('revision'))) {
        expect(tx.status).toBe('committed'); expect(tx.mutations).toEqual(['revision', 'head', 'audit']);
    }
    expect(dataStorage.loadSnapshotForShare).not.toHaveBeenCalled();
    expect(h.state.borrows).toBe(h.state.released);
});

test('identical retained command replay discloses its original result with no added revision or audit', async () => {
    const h = await ready(), command = h.generate();
    const original = await h.improvement.execute(command), before = JSON.stringify(h.state.committed);
    const count = writes(h).length;
    expect(await h.improvement.execute(command)).toEqual(original);
    expect(JSON.stringify(h.state.committed)).toBe(before); expect(writes(h)).toHaveLength(count);
    expect(h.state.transactions.at(-1).mutations).toEqual([]);
    expect(h.state.transactions.at(-1).status).toBe('committed');
});

test.each(['list', 'view', 'editor', 'execute'])('%s validates closed input before business I/O and leaves the request reusable', async method => {
    const h = await ready(), before = h.state.trace.length;
    const input = method === 'execute' ? { ...h.generate(), tenantId: 'forged' } : { ...h.selector(), tenantId: 'forged' };
    await expect(h.improvement[method](input)).rejects.toMatchObject({ statusCode: 400 });
    expect(h.state.trace).toHaveLength(before);
    expect((await h.improvement.execute(h.generate())).plan.revision).toBe(0);
});

test('command input is detached before asynchronous operation work', async () => {
    const h = await ready(), command = h.generate(), pending = h.improvement.execute(command);
    command.operationId = 'changed-after-call'; command.payload.assessmentRevision = 99;
    expect((await pending).plan.revision).toBe(0);
    expect(h.state.committed.revisions[0].operation_id).toBe('generate-a');
    expect(h.state.committed.revisions[0].assessment_revision).toBe(2);
});

test.each(['membership', 'viewer', 'module', 'entitlement'])('current %s denial withholds list/editor and command without business effects', async kind => {
    const h = await ready();
    if (kind === 'membership') h.snapshot.membershipState.memberships[0].status = 'suspended';
    if (kind === 'viewer') {
        h.snapshot.membershipState.memberships[0].roles = ['viewer'];
        h.snapshot.membershipState.invitations[0].roles = ['viewer'];
    }
    if (kind === 'module') h.snapshot.flags.enabled.improvement_plan = false;
    if (kind === 'entitlement') h.snapshot.entitlementState.grants.find(row => row.grantId === 'synthetic-product').status = 'revoked';
    await expect(h.improvement.list(h.selector())).rejects.toMatchObject({ code: 'improvement_list_access_denied', statusCode: 403 });
    await expect(h.improvement.editor({ planId: 'plan-a' })).rejects.toMatchObject({ code: 'improvement_list_access_denied', statusCode: 403 });
    await expect(h.improvement.execute(h.generate())).rejects.toMatchObject({ code: 'improvement_access_denied', statusCode: 403 });
    expect(h.state.committed).toEqual({ heads: [], revisions: [], auditRows: [] }); expect(writes(h)).toEqual([]);
});

function deeplyFrozen(value) {
    if (value && typeof value === 'object') {
        expect(Object.isFrozen(value)).toBe(true);
        for (const child of Object.values(value)) deeplyFrozen(child);
    }
}

test('editor reconstructs canonical retained actions and audits read metadata without changing the plan', async () => {
    const h = await ready(), generated = await h.improvement.execute(h.generate());
    const revisions = JSON.stringify(h.state.committed.revisions), fresh = createDashboardResourceRuntime(h.options), request = h.makeRequest();
    const restored = await fresh.forRequest(request, { expectedGeneration: h.session.generationToken });
    const editor = await restored.improvement.editor({ planId: generated.plan.planId });
    expect(editor).toEqual({ schemaVersion: 1, scope: { ...h.example.scope, planId: 'plan-a' }, planRevision: 0,
        asOf: NOW, canWrite: true, ownerChoices: [{ subjectKey: SUBJECT, label: 'Assign to me' }],
        actions: generated.plan.actions.map(action => ({ actionId: action.actionId, commands: ['assign'] })) });
    deeplyFrozen(editor);
    expect(JSON.stringify(h.state.committed.revisions)).toBe(revisions);
    expect(h.state.transactions.at(-1)).toMatchObject({ status: 'committed', mutations: ['audit'] });
    const context = await restored.requestContext.resolve(request), audit = h.state.committed.auditRows.at(-1);
    expect(audit.payload).toMatchObject({ ...h.example.scope, requestId: context.requestId, actorSubjectKey: SUBJECT,
        action: 'improvement.read', module: 'improvement_plan', result: 'succeeded' });
    expect(audit.session_sha256).toBe(h.session.sessionSha256);
    expect(audit.authority_id).toBe(h.binding.authorityRef.authorityId);
    expect(h.state.borrows).toBe(h.state.released);
});

test('editor tracks retained command legality through assignment, start, block, completion and reopen', async () => {
    const h = await ready(); let result = await h.improvement.execute(h.generate());
    const actionId = result.plan.actions[0].actionId;
    const commands = async expected => {
        const editor = await h.improvement.editor({ planId: result.plan.planId });
        expect(editor.planRevision).toBe(result.plan.revision);
        expect(editor.actions.find(action => action.actionId === actionId).commands).toEqual(expected);
    };
    await commands(['assign']);
    for (const [type, payload, expected] of [
        ['assign', { ownerSubjectKey: SUBJECT, dueDate: '2026-09-08' }, ['assign', 'start']],
        ['start', {}, ['assign', 'block', 'complete']],
        ['block', { reason: 'Synthetic dependency outstanding.' }, ['assign', 'start', 'complete']],
        ['complete', { note: 'Synthetic declared completion.', evidenceReference: 'synthetic:completion' }, ['reopen']],
        ['reopen', { reason: 'Synthetic additional work requested.' }, ['assign', 'start']]
    ]) {
        result = await h.improvement.execute(h.command(result.plan, type, payload)); await commands(expected);
    }
    expect(h.state.committed.revisions).toHaveLength(6); expect(commandEvents(h)).toHaveLength(6);
    expect(h.state.borrows).toBe(h.state.released);
});

test('editor current read-only advisor metadata cannot authorize an existing command', async () => {
    const h = await ready({ role: 'fractional_advisor', service: true, assessmentEndsAt: '2026-09-07T12:00:00.000Z' });
    const generated = await h.improvement.execute(h.generate());
    h.snapshot.advisorAssignments.find(row => row.assignmentId === 'synthetic-improvement-assignment').permissions = ['improvement.read'];
    const editor = await h.improvement.editor({ planId: 'plan-a' });
    expect(editor).toMatchObject({ canWrite: false, ownerChoices: [] });
    expect(editor.actions).toEqual(generated.plan.actions.map(action => ({ actionId: action.actionId, commands: [] })));
    const before = JSON.stringify(h.state.committed);
    await expect(h.improvement.execute(h.command(generated.plan, 'assign', { ownerSubjectKey: SUBJECT, dueDate: '2026-09-08' })))
        .rejects.toMatchObject({ code: 'improvement_access_denied', statusCode: 403 });
    expect(JSON.stringify(h.state.committed)).toBe(before);
});

test('editor rejects missing or corrupt retained history without a read audit', async () => {
    const h = await ready();
    await expect(h.improvement.editor({ planId: 'missing-plan' })).rejects.toMatchObject({ code: 'improvement_not_found', statusCode: 404 });
    expect(h.state.committed.auditRows).toEqual([]);
    await h.improvement.execute(h.generate());
    h.state.committed.revisions[0].payload.resultSha256 = '0'.repeat(64);
    const before = JSON.stringify(h.state.committed);
    await expect(h.improvement.editor({ planId: 'plan-a' })).rejects.toMatchObject({ code: 'improvement_unavailable', statusCode: 503 });
    expect(JSON.stringify(h.state.committed)).toBe(before);
});

test('editor audit failure rolls back its read event and withholds prepared commands', async () => {
    const h = await ready(); await h.improvement.execute(h.generate());
    const before = JSON.stringify(h.state.committed);
    h.state.hook = event => {
        if (event.phase === 'after' && /INSERT INTO nofries\.dashboard_runtime_audit\b/.test(event.sql)) {
            throw new Error('Synthetic private editor audit failure');
        }
    };
    await expect(h.improvement.editor({ planId: 'plan-a' })).rejects.toMatchObject({ statusCode: 503 });
    expect(JSON.stringify(h.state.committed)).toBe(before);
    expect(h.state.transactions.at(-1)).toMatchObject({ status: 'rolled_back', mutations: ['audit'] });
    expect(h.state.borrows).toBe(h.state.released);
});

test.each(['before', 'after'])('editor withholds advertised owner commands when eligibility expires %s COMMIT', async phase => {
    const cutoff = '2026-09-07T11:00:30.000Z', h = await ready({ ownerEndsAt: cutoff });
    const generated = await h.improvement.execute(h.generate());
    await h.improvement.execute(h.command(generated.plan, 'assign', { ownerSubjectKey: OWNER, dueDate: '2026-09-08' }));
    const current = await h.improvement.editor({ planId: 'plan-a' });
    expect(current.actions.find(action => action.actionId === generated.plan.actions[0].actionId).commands).toEqual(['assign', 'start']);
    const before = JSON.stringify(h.state.committed), auditCount = h.state.committed.auditRows.length, boundary = h.state.trace.length;
    const crossed = phase === 'before' ? crossCommandWindowDuringCommitPreparation(h, cutoff) : () => {};
    if (phase === 'after') h.state.hook = event => {
        if (event.phase === 'after' && event.sql === 'COMMIT') h.state.at = cutoff;
    };
    await expect(h.improvement.editor({ planId: 'plan-a' })).rejects.toMatchObject({ code: 'improvement_owner_ineligible', statusCode: 409 });
    crossed();
    const trace = h.state.trace.slice(boundary);
    expect(trace.filter(event => event.sql === 'COMMIT')).toHaveLength(phase === 'before' ? 0 : 1);
    expect(trace.filter(event => event.sql === 'ROLLBACK')).toHaveLength(phase === 'before' ? 1 : 0);
    if (phase === 'before') expect(JSON.stringify(h.state.committed)).toBe(before);
    else expect(h.state.committed.auditRows).toHaveLength(auditCount + 1);
    expect(h.state.committed.revisions).toHaveLength(2); expect(h.state.borrows).toBe(h.state.released);
});

test('editor does not disclose writer controls after narrower advisor write authority expires during COMMIT preparation', async () => {
    const cutoff = '2026-09-07T11:00:30.000Z';
    const h = await ready({ role: 'fractional_advisor', service: true, assessmentEndsAt: '2026-09-07T12:00:00.000Z' });
    await h.improvement.execute(h.generate());
    const read = h.snapshot.advisorAssignments.find(row => row.assignmentId === 'synthetic-improvement-assignment');
    const write = JSON.parse(JSON.stringify(read));
    read.permissions = ['improvement.read'];
    write.assignmentId = 'synthetic-writer-assignment'; write.permissions = ['improvement.write']; write.validUntil = cutoff;
    h.snapshot.advisorAssignments.push(write); h.snapshot.advisorAssignments.sort((a, b) => a.assignmentId.localeCompare(b.assignmentId));
    expect((await h.improvement.editor({ planId: 'plan-a' })).canWrite).toBe(true);
    const before = JSON.stringify(h.state.committed), boundary = h.state.trace.length;
    const crossed = crossCommandWindowDuringCommitPreparation(h, cutoff);
    await expect(h.improvement.editor({ planId: 'plan-a' })).rejects.toMatchObject({ code: 'improvement_access_denied', statusCode: 403 });
    crossed(); expect(JSON.stringify(h.state.committed)).toBe(before);
    expect(h.state.trace.slice(boundary).filter(event => event.sql === 'COMMIT')).toEqual([]);
    expect(h.state.transactions.at(-1).status).toBe('rolled_back');
    h.state.hook = null;
    const current = await h.improvement.editor({ planId: 'plan-a' });
    expect(current.canWrite).toBe(false); expect(current.ownerChoices).toEqual([]);
    expect(current.actions.every(action => action.commands.length === 0)).toBe(true);
});

test('a changed generation and an unknown captured request cannot select native source authority', async () => {
    const h = await ready();
    await expect(h.runtime.forRequest(h.request, { expectedGeneration: 'a'.repeat(64) })).rejects.toMatchObject({ statusCode: 403 });
    await expect(h.runtime.forRequest({}, { expectedGeneration: h.session.generationToken })).rejects.toMatchObject({ statusCode: 403 });
    expect(h.state.committed).toEqual({ heads: [], revisions: [], auditRows: [] });
});

test('failure after staged audit insertion rolls back both retained command and canonical audit', async () => {
    const h = await ready();
    h.state.hook = event => {
        if (event.phase === 'after' && /INSERT INTO nofries\.dashboard_runtime_audit\b/.test(event.sql)) {
            throw new Error('synthetic private sink failure after insert');
        }
    };
    await expect(h.improvement.execute(h.generate())).rejects.toMatchObject({ code: 'improvement_unavailable', statusCode: 503 });
    expect(h.state.committed).toEqual({ heads: [], revisions: [], auditRows: [] });
    expect(h.state.transactions.at(-1)).toMatchObject({ status: 'rolled_back', mutations: ['revision', 'head', 'audit'] });
    expect(h.state.borrows).toBe(h.state.released);
});

test('request expiry after successful COMMIT withholds disclosure without claiming rollback', async () => {
    const h = await ready();
    h.state.hook = event => {
        if (event.phase === 'after' && event.sql === 'COMMIT') h.state.at = '2026-09-07T11:01:00.000Z';
    };
    await expect(h.improvement.execute(h.generate())).rejects.toMatchObject({ code: 'improvement_unavailable', statusCode: 503 });
    expect(h.state.committed.revisions).toHaveLength(1); expect(h.state.committed.auditRows).toHaveLength(1);
    expect(h.state.transactions.at(-1).status).toBe('committed');
    expect(h.state.borrows).toBe(h.state.released);
});

test('revocation after command append fails final checks and rolls back the paired transaction', async () => {
    const h = await ready();
    h.state.hook = event => {
        if (event.phase === 'after' && /INSERT INTO nofries\.dashboard_runtime_audit\b/.test(event.sql)) {
            h.snapshot.flags.enabled.improvement_plan = false;
        }
    };
    await expect(h.improvement.execute(h.generate())).rejects.toMatchObject({ code: 'improvement_access_denied', statusCode: 403 });
    expect(h.state.committed).toEqual({ heads: [], revisions: [], auditRows: [] });
    expect(h.state.transactions.at(-1).status).toBe('rolled_back');
});

function crossCommandWindowDuringCommitPreparation(h, at) {
    const load = dataStorage.loadSnapshotForUpdate.getMockImplementation();
    let snapshots = 0, sealed = false, crossed = false;
    dataStorage.loadSnapshotForUpdate.mockImplementation(async (...args) => {
        const value = await load(...args);
        // Binder initial snapshot, repository snapshot, then binder's final
        // authority snapshot. Only the subsequent awaited COMMIT preparation
        // crosses the narrower command-specific window.
        if (++snapshots === 3) sealed = true;
        return value;
    });
    h.state.hook = event => {
        if (sealed && !crossed && event.phase === 'after' && event.sql === "SELECT set_config('statement_timeout', $1, true)") {
            crossed = true; h.state.at = at;
        }
    };
    return () => expect(crossed).toBe(true);
}

test('owner eligibility expiry during final COMMIT preparation refuses assignment before sending COMMIT', async () => {
    const cutoff = '2026-09-07T11:00:30.000Z', h = await ready({ ownerEndsAt: cutoff });
    const generated = await h.improvement.execute(h.generate()), before = JSON.stringify(h.state.committed);
    const boundary = h.state.trace.length, crossed = crossCommandWindowDuringCommitPreparation(h, cutoff);
    await expect(h.improvement.execute(h.command(generated.plan, 'assign', {
        ownerSubjectKey: OWNER, dueDate: '2026-09-08' }))).rejects.toMatchObject({
        code: 'improvement_owner_ineligible', statusCode: 409 });
    crossed(); expect(JSON.stringify(h.state.committed)).toBe(before);
    expect(h.state.trace.slice(boundary).filter(event => event.sql === 'COMMIT')).toEqual([]);
    expect(h.state.transactions.at(-1).status).toBe('rolled_back');
});

test('replay after its saved owner expires retains the original current-writer-only disclosure policy', async () => {
    const cutoff = '2026-09-07T11:00:30.000Z', h = await ready({ ownerEndsAt: cutoff });
    const generated = await h.improvement.execute(h.generate());
    const command = h.command(generated.plan, 'assign', { ownerSubjectKey: OWNER, dueDate: '2026-09-08' });
    const assigned = await h.improvement.execute(command), before = JSON.stringify(h.state.committed);
    h.state.at = cutoff;
    expect(await h.improvement.execute(command)).toEqual(assigned);
    expect(JSON.stringify(h.state.committed)).toBe(before);
    expect(h.state.transactions.at(-1).mutations).toEqual([]);
});

test('generation assessment-read expiry during final COMMIT preparation refuses before sending COMMIT', async () => {
    const cutoff = '2026-09-07T11:00:30.000Z';
    const h = await ready({ role: 'fractional_advisor', service: true, assessmentEndsAt: cutoff });
    const boundary = h.state.trace.length, crossed = crossCommandWindowDuringCommitPreparation(h, cutoff);
    await expect(h.improvement.execute(h.generate())).rejects.toMatchObject({ statusCode: 403 });
    crossed(); expect(h.state.committed).toEqual({ heads: [], revisions: [], auditRows: [] });
    expect(h.state.trace.slice(boundary).filter(event => event.sql === 'COMMIT')).toEqual([]);
    expect(h.state.transactions.at(-1).status).toBe('rolled_back');
});

test('retained plan index is an audited empty selection when the current organisation has no plans', async () => {
    const h = await ready(), result = await h.improvement.plans({ limit: 20, afterPlanId: null });
    expect(result).toEqual({ schemaVersion: 1, scope: h.example.scope, asOf: NOW, plans: [], nextAfterPlanId: null });
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.plans)).toBe(true);
    expect(h.state.committed.heads).toEqual([]); expect(h.state.committed.revisions).toEqual([]);
    expect(h.state.committed.auditRows).toHaveLength(1);
    expect(h.state.committed.auditRows[0].payload).toMatchObject({ ...h.example.scope,
        actorSubjectKey: SUBJECT, action: 'improvement.read', module: 'improvement_plan', result: 'succeeded' });
    expect(h.state.transactions.at(-1).mutations).toEqual(['audit']);
});

test('runtime reconstruction discovers bounded retained plan pages and selects the actual saved detail', async () => {
    const h = await ready();
    const generated = {};
    for (const planId of ['plan-c', 'plan-a', 'plan-b']) {
        generated[planId] = await h.improvement.execute(h.generate(planId, 'generate-' + planId));
    }
    const assigned = await h.improvement.execute(h.command(generated['plan-b'].plan, 'assign', {
        ownerSubjectKey: SUBJECT, dueDate: '2026-09-08' }, 'assign-plan-b'));
    const beforeReplay = JSON.stringify(h.state.committed);
    expect(await h.improvement.execute(h.generate('plan-b', 'generate-plan-b'))).toEqual(generated['plan-b']);
    expect(JSON.stringify(h.state.committed)).toBe(beforeReplay);
    const fresh = createDashboardResourceRuntime(h.options);
    const restored = await fresh.forRequest(h.makeRequest(), { expectedGeneration: h.session.generationToken });
    const page = await restored.improvement.plans({ limit: 2, afterPlanId: null });
    expect(Object.keys(page).sort()).toEqual(['asOf', 'nextAfterPlanId', 'plans', 'schemaVersion', 'scope']);
    expect(page).toMatchObject({ scope: h.example.scope,
        plans: [{ planId: 'plan-a', planRevision: 0 }, { planId: 'plan-b', planRevision: 1 }], nextAfterPlanId: 'plan-b' });
    expect(Object.isFrozen(page.plans[0])).toBe(true);
    const last = await restored.improvement.plans({ limit: 2, afterPlanId: page.nextAfterPlanId });
    expect(last).toMatchObject({ plans: [{ planId: 'plan-c', planRevision: 0 }], nextAfterPlanId: null });
    const selected = page.plans.find(plan => plan.planId === 'plan-b');
    const view = await restored.improvement.view(h.selector(selected.planId));
    expect(view).toMatchObject({ planRevision: assigned.plan.revision, scope: { ...h.example.scope, planId: selected.planId } });
    expect(view.actions.find(action => action.actionId === assigned.plan.actions[0].actionId).ownerSubjectKey).toBe(SUBJECT);
    expect(h.state.committed.revisions).toHaveLength(4); expect(commandEvents(h)).toHaveLength(4);
    expect(dataStorage.loadSnapshotForShare).not.toHaveBeenCalled(); expect(h.state.borrows).toBe(h.state.released);
});

test('plan cursors bound independent current reads and include later retained heads without a snapshot claim', async () => {
    const h = await ready();
    await h.improvement.execute(h.generate('plan-a', 'generate-plan-a'));
    await h.improvement.execute(h.generate('plan-c', 'generate-plan-c'));
    const first = await h.improvement.plans({ limit: 1, afterPlanId: null });
    expect(first).toMatchObject({ plans: [{ planId: 'plan-a', planRevision: 0 }], nextAfterPlanId: 'plan-a' });
    await h.improvement.execute(h.generate('plan-b', 'generate-plan-b'));
    const second = await h.improvement.plans({ limit: 2, afterPlanId: first.nextAfterPlanId });
    expect(second).toMatchObject({ plans: [{ planId: 'plan-b', planRevision: 0 }, { planId: 'plan-c', planRevision: 0 }],
        nextAfterPlanId: null });
    expect(second).not.toHaveProperty('snapshotId');
});

test('plan index validates the closed page before acquiring a transaction', async () => {
    const h = await ready(), before = h.state.trace.length;
    for (const input of [{ limit: 0, afterPlanId: null }, { limit: 51, afterPlanId: null },
        { limit: 1.5, afterPlanId: null }, { limit: 1, afterPlanId: '' },
        { limit: 1, afterPlanId: null, tenantId: 'forged' }]) {
        await expect(h.improvement.plans(input)).rejects.toMatchObject({ code: 'improvement_list_input_invalid', statusCode: 400 });
    }
    expect(h.state.trace).toHaveLength(before); expect(h.state.committed.auditRows).toEqual([]);
});

test('plan index current module denial discloses no plan identity and commits no read audit', async () => {
    const h = await ready(); await h.improvement.execute(h.generate());
    const before = JSON.stringify(h.state.committed);
    h.snapshot.flags.enabled.improvement_plan = false;
    await expect(h.improvement.plans({ limit: 20, afterPlanId: null })).rejects.toMatchObject({
        code: 'improvement_list_access_denied', statusCode: 403 });
    expect(JSON.stringify(h.state.committed)).toBe(before);
});

test('plan index audit failure rolls back its event and withholds the already prepared identities', async () => {
    const h = await ready(); await h.improvement.execute(h.generate());
    const before = JSON.stringify(h.state.committed); let failed = false;
    h.state.hook = event => {
        if (event.phase === 'after' && /INSERT INTO nofries\.dashboard_runtime_audit\b/.test(event.sql)) {
            failed = true; throw new Error('Synthetic plan index audit failure');
        }
    };
    await expect(h.improvement.plans({ limit: 20, afterPlanId: null })).rejects.toMatchObject({
        code: 'improvement_list_unavailable', statusCode: 503 });
    expect(failed).toBe(true); expect(JSON.stringify(h.state.committed)).toBe(before);
    expect(h.state.transactions.at(-1).status).toBe('rolled_back');
});

test('a retained head is selection metadata and cannot substitute for corrupt history validation on view', async () => {
    const h = await ready(); await h.improvement.execute(h.generate());
    h.state.committed.revisions[0].payload.resultSha256 = '0'.repeat(64);
    const page = await h.improvement.plans({ limit: 20, afterPlanId: null });
    expect(page.plans).toEqual([{ planId: 'plan-a', planRevision: 0 }]);
    await expect(h.improvement.view(h.selector(page.plans[0].planId))).rejects.toMatchObject({
        code: 'improvement_list_unavailable', statusCode: 503 });
    expect(h.state.committed.revisions).toHaveLength(1);
});
