'use strict';

// Actual retained-history codec, domain replay, request brand and access policy;
// only the locked authority/NCSC read ports and SQL transport are synthetic.
// These checks do not install schema, grant access or exercise PostgreSQL RLS.
jest.mock('../api/shared/appLifecycle/postgresDashboardBootstrap', () => {
    const actual = jest.requireActual('../api/shared/appLifecycle/postgresDashboardBootstrap');
    return { ...actual, dataStorage: { ...actual.dataStorage, loadSnapshotForUpdate: jest.fn() } };
});
jest.mock('../api/shared/assessmentLifecycle/postgresNcscAssessmentStore', () => {
    const actual = jest.requireActual('../api/shared/assessmentLifecycle/postgresNcscAssessmentStore');
    return { ...actual, readHead: jest.fn(), readHistory: jest.fn() };
});

const crypto = require('node:crypto');
const { DashboardPersistenceError, dataStorage } = require('../api/shared/appLifecycle/postgresDashboardBootstrap');
const ncscStore = require('../api/shared/assessmentLifecycle/postgresNcscAssessmentStore');
const store = require('../api/shared/improvementPlan/improvementPlanStore');
const { applyImprovementActionCommand, getImprovementPlanView } = require('../api/shared/improvementPlan/improvementPlanDomain');
const { ImprovementPlanServiceError } = require('../api/shared/improvementPlan/improvementPlanService');
const { ImprovementActionListError } = require('../api/shared/improvementPlan/improvementActionListProjection');
const { createImprovementActionEditorSource } = require('../api/shared/improvementPlan/improvementActionEditorSource');
const { applyMembershipCommand } = require('../api/shared/appLifecycle/membershipDomain');
const { createDashboardAudit } = require('../api/shared/appLifecycle/dashboardAudit');
const { evidenceFixture, clone } = require('./fixtures/evidenceMetadataFixture');
const { createClock, createContext } = require('./fixtures/ncscAssessmentFixture');
const accepted = require('./fixtures/ncscAcceptedEvaluation.json').input;
const NOW = '2026-10-02T00:00:00.000Z';
const OWNER = '10000000-0000-4000-8000-000000000000:10000000-0000-4000-8000-000000000002';
const FOREIGN = '10000000-0000-4000-8000-000000000000:10000000-0000-4000-8000-000000000003';
const SOURCE = Object.freeze({ assessmentId: accepted.assessmentId, revision: 2, revisionSha256: 'c'.repeat(64) });
const selector = () => ({ planId: 'plan-a' });

function history(context) {
    const scope = { ...context.scope, planId: 'plan-a' }, records = [];
    const generate = { ...selector(), type: 'generate', operationId: 'generate-a', expectedRevision: null, actionId: null,
        payload: { assessmentId: SOURCE.assessmentId, assessmentRevision: SOURCE.revision,
            assessmentRevisionSha256: SOURCE.revisionSha256 } };
    const firstIntent = store.stableIntent(context, generate);
    let state = store.seed(firstIntent, accepted.scoreAsOf, clone(accepted));
    records.push(store.makeRecord(firstIntent, accepted.scoreAsOf, SOURCE, null, state, null));
    function step(index, type, payload = {}) {
        const command = { ...selector(), type, operationId: 'operation-' + records.length,
            expectedRevision: records.length - 1, actionId: state.proposals[index].actionId, payload };
        const intent = store.stableIntent(context, command), at = '2026-09-14T10:00:00.000Z';
        const domainCommand = store.domainCommand(intent, at, state.source.evaluationOutputSha256);
        state = applyImprovementActionCommand(state, domainCommand, { ...context.scope,
            actorSubjectKey: context.identity.subjectKey, eligibleOwnerSubjectKeys: [context.identity.subjectKey, OWNER, FOREIGN] });
        records.push(store.makeRecord(intent, at, SOURCE, records.at(-1).payloadSha256, state, domainCommand));
    }
    const assign = (index, ownerSubjectKey = context.identity.subjectKey) => step(index, 'assign', { ownerSubjectKey, dueDate: '2026-10-01' });
    assign(0); // Open, owned by the current actor.
    assign(1, OWNER); step(1, 'start'); // In progress, another current owner.
    assign(2, FOREIGN); step(2, 'start'); step(2, 'block', { reason: 'Historical supplier wait.' });
    assign(3); step(3, 'start'); step(3, 'complete', { note: 'Synthetic complete.', evidenceReference: 'synthetic:completion' });
    assign(4); step(4, 'start'); step(4, 'block', { reason: 'Synthetic wait.' });
    // Proposal5 remains unassigned. Proposal6 has genuine reopen history.
    assign(6, OWNER); step(6, 'start'); step(6, 'complete', { note: 'Synthetic complete.', evidenceReference: 'synthetic:reopened' });
    step(6, 'reopen', { reason: 'Synthetic review requires another pass.' });
    const rows = records.map(record => ({ tenant_id: scope.tenantId, organisation_id: scope.organisationId,
        plan_id: scope.planId, revision: record.revision, operation_id: record.payload.intent.command.operationId,
        payload_sha256: record.payloadSha256, parent_revision: record.revision ? record.revision - 1 : null,
        parent_sha256: record.parentSha256, assessment_id: SOURCE.assessmentId, assessment_revision: SOURCE.revision,
        assessment_sha256: SOURCE.revisionSha256, payload: clone(record.payload) }));
    return { scope, state, rows, heads: [{ tenant_id: scope.tenantId, organisation_id: scope.organisationId,
        plan_id: scope.planId, revision: records.at(-1).revision, payload_sha256: records.at(-1).payloadSha256 }] };
}

function addOwner(h, validUntil) {
    const at = '2026-10-01T23:00:00.000Z';
    for (const [action, actorSubjectKey, payload] of [
        ['invite', h.subjectKey, { invitationId: 'synthetic-owner-invitation', subjectKey: OWNER, roles: ['viewer'],
            validFrom: at, validUntil, expiresAt: validUntil, grantEvidenceId: 'synthetic-owner-evidence' }],
        ['accept', OWNER, { invitationId: 'synthetic-owner-invitation', membershipId: 'synthetic-owner-membership' }]
    ]) h.state.membershipState = applyMembershipCommand(h.state.membershipState, h.state.tenantAggregate,
        { ...h.scope, action, actorSubjectKey, payload, now: at, expectedRevision: h.state.membershipState.revision });
}

async function harness(options = {}) {
    const f = evidenceFixture({ now: NOW, organisationId: accepted.organisationId,
        modules: ['overview', 'improvement_plan'], ...options });
    const clock = createClock(NOW), context = await createContext(f.scope, clock);
    const h = { ...f, state: clone(f.state), context, clock, trace: [], queries: [],
        retained: history(context), pendingAudit: [], committedAudit: [], afterSnapshot: null, afterRows: null,
        afterAudit: null, beforeCommit: null, afterCommit: null, failCommit: false };
    addOwner(h, options.ownerEndsAt || '2026-10-03T00:00:00.000Z');
    h.state.membershipState = clone(h.state.membershipState);
    if (options.role === 'fractional_advisor') {
        h.state.advisorAssignments.forEach(assignment => {
            assignment.modules = ['improvement_plan']; assignment.permissions = ['improvement.read', 'improvement.write'];
        });
    }
    h.tx = { query: jest.fn(async (sql, params) => {
        expect(params).toEqual([h.scope.tenantId, h.scope.organisationId, 'plan-a']);
        h.queries.push(sql);
        if (/FROM nofries\.dashboard_improvement_heads\b/.test(sql)) {
            h.trace.push('head'); return { rows: clone(h.retained.heads) };
        }
        if (/FROM nofries\.dashboard_improvement_revisions\b/.test(sql)) {
            h.trace.push('history');
            if (h.afterRows) await h.afterRows();
            return { rows: clone(h.retained.rows) };
        }
        throw new Error('private unexpected editor SQL');
    }) };
    dataStorage.loadSnapshotForUpdate.mockImplementation(async (tx, scope) => {
        expect(tx).toBe(h.tx); expect(scope).toEqual(h.scope); h.trace.push('authority');
        if (h.afterSnapshot) await h.afterSnapshot(); return h.state;
    });
    ncscStore.readHead.mockImplementation(async (tx, scope) => {
        expect(tx).toBe(h.tx); expect(scope).toEqual({ ...h.scope, assessmentId: SOURCE.assessmentId });
        return { synthetic: 'validated-submitted-source-head' };
    });
    ncscStore.readHistory.mockImplementation(async (tx, scope, _head, revisions, aggregate) => {
        expect(tx).toBe(h.tx); expect(scope).toEqual({ ...h.scope, assessmentId: SOURCE.assessmentId });
        expect(revisions).toEqual([SOURCE.revision]); expect(aggregate).toBe(h.state.tenantAggregate);
        return new Map([[SOURCE.revision, { revisionSha256: SOURCE.revisionSha256,
            envelope: { state: { status: 'submitted' }, submission: { input: clone(accepted) } } }]]);
    });
    h.database = { withTenantTransaction: jest.fn(async (tenantId, work, assertAt) => {
        expect(tenantId).toBe(h.scope.tenantId); h.trace.push('begin'); h.pendingAudit = [];
        try {
            const result = await work(h.tx);
            if (h.beforeCommit) await h.beforeCommit();
            // Model the existing host's final authority sample after its awaits.
            if (assertAt) expect(assertAt(h.clock.now())).toBeUndefined();
            if (h.failCommit) throw Object.assign(new Error('private commit outcome'), { code: 'postgres_commit_failed' });
            h.trace.push('commit'); h.committedAudit.push(...clone(h.pendingAudit));
            if (h.afterCommit) await h.afterCommit();
            return result;
        } catch (error) { h.trace.push('rollback-or-uncertain'); throw error; }
    }) };
    h.audit = createDashboardAudit({ clock: h.clock.now, createEventId: crypto.randomUUID, writeEvent: async event => {
        expect(h.trace.at(-1)).not.toBe('commit'); h.trace.push('audit'); h.pendingAudit.push(clone(event));
        if (h.afterAudit) await h.afterAudit();
    } });
    h.requestContext = { resolve: jest.fn(async () => h.context) };
    h.source = createImprovementActionEditorSource({ database: h.database, clock: h.clock.now, audit: h.audit,
        requestContext: h.requestContext });
    h.editor = input => h.source.editor({}, input === undefined ? selector() : input);
    h.action = (result, index) => result.actions.find(action => action.actionId === h.retained.state.proposals[index].actionId);
    return h;
}

function readOnlyAdvisor(h) {
    h.state.advisorAssignments.forEach(assignment => { assignment.permissions = ['improvement.read']; });
}
function splitWriterExpiry(h, until) {
    const read = h.state.advisorAssignments[0];
    read.permissions = ['improvement.read'];
    const write = { ...clone(read), assignmentId: 'synthetic-write-assignment', permissions: ['improvement.write'], validUntil: until };
    h.state.advisorAssignments.push(write);
    h.state.advisorAssignments.sort((a, b) => a.assignmentId < b.assignmentId ? -1 : a.assignmentId > b.assignmentId ? 1 : 0);
}
afterEach(() => jest.clearAllMocks());

test('actual retained history yields only self assignment and domain-valid current commands, paired with one read audit', async () => {
    const h = await harness(), before = clone({ authority: h.state, rows: h.retained.rows, heads: h.retained.heads });
    const result = await h.editor();
    expect(result).toEqual({ schemaVersion: 1, scope: { ...h.scope, planId: 'plan-a' }, planRevision: h.retained.rows.length - 1,
        asOf: NOW, canWrite: true, ownerChoices: [{ subjectKey: h.subjectKey, label: 'Assign to me' }],
        actions: expect.any(Array) });
    expect(result.actions).toHaveLength(getImprovementPlanView(h.retained.state).actions.length);
    expect(h.action(result, 0).commands).toEqual(['assign', 'start']);
    expect(h.action(result, 1).commands).toEqual(['assign', 'block', 'complete']);
    expect(h.action(result, 2).commands).toEqual(['assign']);
    expect(h.action(result, 3).commands).toEqual(['reopen']);
    expect(h.action(result, 4).commands).toEqual(['assign', 'start', 'complete']);
    expect(h.action(result, 5).commands).toEqual(['assign']);
    expect(h.action(result, 6).commands).toEqual(['assign', 'start']);
    expect(h.trace).toEqual(['begin', 'authority', 'head', 'history', 'audit', 'commit']);
    expect(h.database.withTenantTransaction).toHaveBeenCalledTimes(1);
    expect(h.database.withTenantTransaction.mock.calls[0][2]).toEqual(expect.any(Function));
    expect(h.committedAudit).toHaveLength(1);
    expect(h.committedAudit[0]).toMatchObject({ action: 'improvement.read', module: 'improvement_plan', result: 'succeeded', ...h.scope });
    expect({ authority: h.state, rows: h.retained.rows, heads: h.retained.heads }).toEqual(before);
    expect(h.queries.every(sql => sql.startsWith('SELECT '))).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/displayName|operationId|actorSubjectKey|grantEvidenceId|Historical supplier|synthetic:completion/);
    expect(JSON.stringify(result)).not.toContain(OWNER); expect(JSON.stringify(result)).not.toContain(FOREIGN);
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.actions[0].commands)).toBe(true);
    expect(Object.isFrozen(result.ownerChoices[0])).toBe(true); expect(Object.keys(h.source)).toEqual(['editor']);
});

test('an explicit read-only advisor gets all retained identities with no owner choices or commands', async () => {
    const h = await harness({ role: 'fractional_advisor', service: 'fractional_advisory' }); readOnlyAdvisor(h);
    const result = await h.editor();
    expect(result.canWrite).toBe(false); expect(result.ownerChoices).toEqual([]);
    expect(result.actions).toHaveLength(h.retained.state.proposals.length);
    expect(result.actions.every(action => action.commands.length === 0)).toBe(true);
    expect(h.committedAudit).toHaveLength(1);
});

test.each(['expired', 'suspended', 'foreign-organisation', 'removed'])('current %s owner loses owner-dependent commands without exposing identity', async kind => {
    const h = await harness();
    const member = h.state.membershipState.memberships.find(row => row.subjectKey === OWNER);
    if (kind === 'expired') h.clock.set(member.validUntil);
    if (kind === 'suspended') member.status = 'suspended';
    if (kind === 'removed') member.status = 'removed';
    if (kind === 'foreign-organisation') {
        // Retain genuine old commands but remove this subject from the selected
        // organisation's current canonical membership state.
        h.state.membershipState.memberships = h.state.membershipState.memberships.filter(row => row.subjectKey !== OWNER);
        h.state.membershipState.invitations = h.state.membershipState.invitations.filter(row => row.subjectKey !== OWNER);
    }
    if (kind === 'expired') {
        // Leave the actor/product valid while this separately granted owner ends.
        const actorEnd = '2026-10-04T00:00:00.000Z';
        const actor = h.state.membershipState.memberships.find(row => row.subjectKey === h.subjectKey);
        actor.validUntil = actorEnd;
        h.state.membershipState.invitations.find(row => row.subjectKey === h.subjectKey).validUntil = actorEnd;
        h.state.membershipState.invitations.find(row => row.subjectKey === h.subjectKey).expiresAt = actorEnd;
        h.state.entitlementState.grants.forEach(row => { row.validUntil = actorEnd; });
    }
    const result = await h.editor();
    expect(result.canWrite).toBe(true); expect(h.action(result, 1).commands).toEqual(['assign', 'block']);
    expect(h.action(result, 6).commands).toEqual(['assign']);
    expect(JSON.stringify(result)).not.toContain(OWNER);
});

test.each(['viewer', 'membership', 'product', 'module', 'tenant', 'organisation'])('current %s read denial precedes history and audit', async kind => {
    const h = await harness(kind === 'viewer' ? { role: 'viewer' } : {});
    if (kind === 'membership') h.state.membershipState.memberships[0].status = 'suspended';
    if (kind === 'product') h.state.entitlementState.grants = [];
    if (kind === 'module') h.state.flags.enabled.improvement_plan = false;
    if (kind === 'tenant') h.state.tenantAggregate.tenant.recordStatus = 'suspended';
    if (kind === 'organisation') h.state.tenantAggregate.organisations[0].recordStatus = 'suspended';
    await expect(h.editor()).rejects.toMatchObject({ code: 'improvement_access_denied', statusCode: 403 });
    expect(h.tx.query).not.toHaveBeenCalled(); expect(h.pendingAudit).toEqual([]); expect(h.trace).not.toContain('commit');
});

test('missing authority snapshot denies access without revealing retained plan existence', async () => {
    const h = await harness(); dataStorage.loadSnapshotForUpdate.mockRejectedValue(new DashboardPersistenceError('dashboard_not_found', 404));
    await expect(h.editor()).rejects.toMatchObject({ code: 'improvement_access_denied', statusCode: 403 });
    expect(h.tx.query).not.toHaveBeenCalled(); expect(h.pendingAudit).toEqual([]);
});

test.each(['missing', 'hash', 'revision', 'scope', 'source'])('%s retained history never yields partial editor metadata or an audit', async kind => {
    const h = await harness();
    if (kind === 'missing') { h.retained.rows = []; h.retained.heads = []; }
    if (kind === 'hash') h.retained.rows[1].payload.resultSha256 = 'd'.repeat(64);
    if (kind === 'revision') h.retained.rows[1].revision = 12;
    if (kind === 'scope') h.retained.heads[0].organisation_id = 'foreign-organisation';
    if (kind === 'source') ncscStore.readHistory.mockResolvedValue(new Map());
    await expect(h.editor()).rejects.toMatchObject({ code: kind === 'missing' ? 'improvement_not_found' : 'improvement_unavailable',
        statusCode: kind === 'missing' ? 404 : 503 });
    expect(h.pendingAudit).toEqual([]); expect(h.trace).not.toContain('commit');
});

test('closed selectors reject hostile data before request resolution and copied contexts before transactions', async () => {
    const h = await harness(), hook = jest.fn(), accessor = {};
    Object.defineProperty(accessor, 'planId', { enumerable: true, get: hook });
    for (const input of [undefined, null, {}, { ...selector(), tenantId: 'foreign' }, { ...selector(), asOf: NOW },
        { ...selector(), canWrite: true }, { planId: '../plan-a' }, accessor,
        new Proxy(selector(), { ownKeys: hook, get: hook })]) {
        await expect(h.source.editor({}, input)).rejects.toMatchObject({ code: 'improvement_input_invalid', statusCode: 400 });
    }
    expect(hook).not.toHaveBeenCalled(); expect(h.requestContext.resolve).not.toHaveBeenCalled();
    h.requestContext.resolve.mockResolvedValue(clone(h.context));
    await expect(h.editor()).rejects.toMatchObject({ code: 'improvement_access_denied', statusCode: 403 });
    expect(h.database.withTenantTransaction).not.toHaveBeenCalled();
});

test('selector capture survives mutation while canonical request context is pending', async () => {
    const h = await harness(), request = { callerScope: 'ignored' }, input = selector(); let release;
    h.requestContext.resolve.mockReturnValue(new Promise(resolve => { release = () => resolve(h.context); }));
    const pending = h.source.editor(request, input); input.planId = 'foreign-plan';
    await Promise.resolve(); expect(h.database.withTenantTransaction).not.toHaveBeenCalled(); release();
    await expect(pending).resolves.toMatchObject({ scope: { ...h.scope, planId: 'plan-a' } });
    expect(h.requestContext.resolve).toHaveBeenCalledWith(request);
});

test.each(['audit', 'finalizing', 'settlement'])('writer-only expiry during %s withholds metadata instead of silently downgrading its authority', async phase => {
    const h = await harness({ role: 'fractional_advisor', service: 'fractional_advisory' });
    const until = '2026-10-02T00:00:01.000Z'; splitWriterExpiry(h, until);
    h[phase === 'audit' ? 'afterAudit' : phase === 'finalizing' ? 'beforeCommit' : 'afterCommit'] = () => h.clock.set(until);
    await expect(h.editor()).rejects.toMatchObject({ code: 'improvement_access_denied', statusCode: 403 });
    expect(h.database.withTenantTransaction).toHaveBeenCalledTimes(1);
    expect(h.pendingAudit).toHaveLength(1);
    expect(h.committedAudit).toHaveLength(phase === 'settlement' ? 1 : 0);
    expect(h.trace.includes('commit')).toBe(phase === 'settlement');
});

test.each(['audit', 'finalizing', 'settlement'])('advertised owner expiry during %s withholds the complete response', async phase => {
    const until = '2026-10-02T00:00:01.000Z', h = await harness({ ownerEndsAt: until });
    h[phase === 'audit' ? 'afterAudit' : phase === 'finalizing' ? 'beforeCommit' : 'afterCommit'] = () => h.clock.set(until);
    await expect(h.editor()).rejects.toMatchObject({ code: 'improvement_owner_ineligible', statusCode: 409 });
    expect(h.database.withTenantTransaction).toHaveBeenCalledTimes(1);
    expect(h.pendingAudit).toHaveLength(1); expect(h.committedAudit).toHaveLength(phase === 'settlement' ? 1 : 0);
});

test.each(['history', 'audit', 'settlement'])('clock regression during %s withholds metadata with sanitized unavailable error', async phase => {
    const h = await harness();
    h[phase === 'history' ? 'afterRows' : phase === 'audit' ? 'afterAudit' : 'afterCommit'] = () => h.clock.advance(-1);
    await expect(h.editor()).rejects.toMatchObject({ code: 'improvement_unavailable', statusCode: 503 });
    expect(h.committedAudit).toHaveLength(phase === 'settlement' ? 1 : 0);
});

test.each(['audit', 'commit'])('failed or uncertain %s returns no metadata and never retries the transaction', async phase => {
    const h = await harness();
    if (phase === 'audit') h.afterAudit = () => { throw new Error('private audit failure detail'); };
    else h.failCommit = true;
    let error; try { await h.editor(); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(ImprovementPlanServiceError);
    expect(error).toMatchObject({ code: 'improvement_unavailable', statusCode: 503 });
    expect(error.stack).toBeUndefined(); expect(Object.isFrozen(error)).toBe(true);
    expect(JSON.stringify(error)).not.toMatch(/private|postgres|audit failure/);
    expect(h.database.withTenantTransaction).toHaveBeenCalledTimes(1); expect(h.committedAudit).toEqual([]);
    expect(h.trace).not.toContain('commit'); expect(h.queries).toHaveLength(2);
});

test.each([
    ['improvement_list_access_denied', 403], ['improvement_list_unavailable', 503]
])('preserves the genuine native %s error before source work without retry or disclosure', async (code, statusCode) => {
    const h = await harness(), error = new ImprovementActionListError(code, statusCode);
    h.database.withTenantTransaction.mockRejectedValue(error);
    await expect(h.editor()).rejects.toBe(error);
    expect(h.database.withTenantTransaction).toHaveBeenCalledTimes(1);
    expect(h.queries).toEqual([]); expect(h.pendingAudit).toEqual([]); expect(h.committedAudit).toEqual([]);
    expect(JSON.stringify(error)).not.toMatch(/private|postgres/);
});

test('an unbranded or proxied native-looking error cannot acquire a public error status', async () => {
    const h = await harness(), hook = jest.fn();
    for (const error of [{ code: 'improvement_list_access_denied', statusCode: 403, privateDetail: 'private failure' },
        new Proxy(new ImprovementActionListError('improvement_list_access_denied', 403), { get: hook, getPrototypeOf: hook })]) {
        h.database.withTenantTransaction.mockRejectedValue(error);
        await expect(h.editor()).rejects.toMatchObject({ code: 'improvement_unavailable', statusCode: 503 });
    }
    expect(hook).not.toHaveBeenCalled(); expect(h.queries).toEqual([]); expect(h.committedAudit).toEqual([]);
});

test('source construction captures only the closed existing adapter set', async () => {
    const h = await harness(), options = { database: h.database, clock: h.clock.now, audit: h.audit, requestContext: h.requestContext };
    for (const input of [undefined, {}, { ...options, permissions: ['improvement.write'] },
        { ...options, database: {} }, { ...options, audit: {} }, { ...options, requestContext: {} }]) {
        expect(() => createImprovementActionEditorSource(input)).toThrow(ImprovementPlanServiceError);
    }
});

test('adapter getters and proxies cannot fabricate transaction, request or audit authority', async () => {
    const h = await harness(), hook = jest.fn(), options = {
        database: h.database, clock: h.clock.now, audit: h.audit, requestContext: h.requestContext
    };
    for (const [port, method] of [['database', 'withTenantTransaction'], ['requestContext', 'resolve'],
        ['audit', 'createEvent'], ['audit', 'writeEvent']]) {
        const adapter = { ...options[port] };
        Object.defineProperty(adapter, method, { enumerable: true, get: hook });
        expect(() => createImprovementActionEditorSource({ ...options, [port]: adapter }))
            .toThrow(ImprovementPlanServiceError);
    }
    for (const port of ['database', 'clock', 'audit', 'requestContext']) {
        const proxy = new Proxy(options[port], { get: hook, ownKeys: hook, getOwnPropertyDescriptor: hook });
        expect(() => createImprovementActionEditorSource({ ...options, [port]: proxy }))
            .toThrow(ImprovementPlanServiceError);
    }
    expect(hook).not.toHaveBeenCalled(); expect(h.requestContext.resolve).not.toHaveBeenCalled();
    expect(h.database.withTenantTransaction).not.toHaveBeenCalled();
});
