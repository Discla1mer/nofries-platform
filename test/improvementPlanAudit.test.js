'use strict';

// Real command/store/domain/access and canonical audit composition. Only the
// authority snapshot and submitted assessment reads are mocked. This fixed-SQL
// emulator stages revisions and audit events in one synthetic transaction; it
// proves source behaviour, not installed native SQL, privileges or audit storage.
jest.mock('../api/shared/appLifecycle/postgresDashboardBootstrap', () => {
    const actual = jest.requireActual('../api/shared/appLifecycle/postgresDashboardBootstrap');
    return { ...actual, dataStorage: { ...actual.dataStorage, loadSnapshotForUpdate: jest.fn() } };
});
jest.mock('../api/shared/assessmentLifecycle/postgresNcscAssessmentStore', () => {
    const actual = jest.requireActual('../api/shared/assessmentLifecycle/postgresNcscAssessmentStore');
    return { ...actual, readHead: jest.fn(), readHistory: jest.fn() };
});

const crypto = require('node:crypto');
const { dataStorage } = require('../api/shared/appLifecycle/postgresDashboardBootstrap');
const ncscStore = require('../api/shared/assessmentLifecycle/postgresNcscAssessmentStore');
const { createDashboardAudit } = require('../api/shared/appLifecycle/dashboardAudit');
const { applyMembershipCommand } = require('../api/shared/appLifecycle/membershipDomain');
const { createPostgresImprovementPlanRepository } = require('../api/shared/improvementPlan/postgresImprovementPlanRepository');
const { createImprovementActionPlanSource } = require('../api/shared/improvementPlan/improvementActionPlanSource');
const { ImprovementPlanServiceError } = require('../api/shared/improvementPlan/improvementPlanService');
const { ncscFixture, createClock, createContext, SUBJECT, clone } = require('./fixtures/ncscAssessmentFixture');
const accepted = require('./fixtures/ncscAcceptedEvaluation.json').input;
const NOW = '2026-10-02T00:00:00.000Z';
const OWNER = '10000000-0000-4000-8000-000000000000:10000000-0000-4000-8000-000000000002';
const SOURCE_SHA = 'c'.repeat(64);
const REVISION_TABLE = 'nofries.dashboard_improvement_revisions';
const HEAD_TABLE = 'nofries.dashboard_improvement_heads';
const FILTERS = Object.freeze({ status: 'all', owner: 'all', overdueOnly: false });
const capture = promise => promise.then(result => ({ result }), error => ({ error }));
function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}
function generate() {
    return { planId: 'plan-a', type: 'generate', operationId: 'generate-a', expectedRevision: null, actionId: null,
        payload: { assessmentId: accepted.assessmentId, assessmentRevision: 2, assessmentRevisionSha256: SOURCE_SHA } };
}
function command(plan, type = 'assign', payload, operationId = `${type}-${plan.revision}`) {
    return { planId: plan.planId, type, operationId, expectedRevision: plan.revision,
        actionId: plan.actions[0].actionId, payload: payload || (type === 'assign'
            ? { ownerSubjectKey: OWNER, dueDate: '2026-10-01' } : {}) };
}
function assertPrivateError(error, code = 'improvement_unavailable', statusCode = 503) {
    expect(error).toBeInstanceOf(ImprovementPlanServiceError);
    expect(error).toMatchObject({ code, statusCode, message: code });
    expect(error.stack).toBeUndefined(); expect(Object.isFrozen(error)).toBe(true);
    expect(JSON.stringify(error)).not.toMatch(/private|postgres|synthetic-private|evidenceReference|ownerSubjectKey/);
}

async function harness() {
    const f = ncscFixture({ now: NOW, organisationId: accepted.organisationId });
    const clock = createClock(NOW), context = await createContext(f.scope, clock);
    const state = clone(f.state), product = state.entitlementState.grants.find(row => row.grantId === 'synthetic-product');
    product.modules.push('improvement_plan'); product.modules.sort();
    const ownerEnd = '2026-10-02T01:00:00.000Z';
    state.membershipState = applyMembershipCommand(state.membershipState, state.tenantAggregate, { ...f.scope,
        expectedRevision: state.membershipState.revision, actorSubjectKey: SUBJECT, now: NOW, action: 'invite',
        payload: { invitationId: 'owner-invite', subjectKey: OWNER, roles: ['viewer'], validFrom: NOW,
            validUntil: ownerEnd, expiresAt: ownerEnd, grantEvidenceId: 'synthetic-owner-grant' } });
    state.membershipState = applyMembershipCommand(state.membershipState, state.tenantAggregate, { ...f.scope,
        expectedRevision: state.membershipState.revision, actorSubjectKey: OWNER, now: NOW, action: 'accept',
        payload: { invitationId: 'owner-invite', membershipId: 'owner-member' } });
    state.membershipState = clone(state.membershipState);
    const h = { ...f, state, context, clock, transactions: [], committed: { revisions: [], heads: [], events: [] },
        active: null, afterAudit: null, afterAppend: null, beforeCommit: null, commitMode: null, transformEvent: null };
    const input = { ...clone(accepted), organisationId: f.scope.organisationId };
    ncscStore.readHead.mockImplementation(async (tx, scope) => {
        expect(tx).toBe(h.active.tx); expect(scope).toEqual({ ...f.scope, assessmentId: accepted.assessmentId });
        return { synthetic: 'submitted-head' };
    });
    ncscStore.readHistory.mockImplementation(async (tx, scope, head, revisions, aggregate) => {
        expect(tx).toBe(h.active.tx); expect(revisions).toEqual([2]); expect(aggregate).toBe(state.tenantAggregate);
        return new Map([[2, { revisionSha256: SOURCE_SHA, envelope: { state: { status: 'submitted' }, submission: { input } } }]]);
    });
    dataStorage.loadSnapshotForUpdate.mockImplementation(async (tx, scope) => {
        expect(tx).toBe(h.active.tx); expect(scope).toEqual(f.scope); return state;
    });
    h.database = { withTenantTransaction: jest.fn(async (tenantId, work) => {
        expect(tenantId).toBe(f.scope.tenantId);
        const transaction = { staged: clone(h.committed), queries: [], status: 'pending', tx: null };
        h.transactions.push(transaction); h.active = transaction;
        transaction.tx = { query: jest.fn(async (sql, values) => {
            transaction.queries.push({ sql, values: clone(values) });
            expect(values.slice(0, 3)).toEqual([f.scope.tenantId, f.scope.organisationId, 'plan-a']);
            const { staged } = transaction;
            if (sql === `SELECT * FROM ${HEAD_TABLE} WHERE tenant_id=$1 AND organisation_id=$2 AND plan_id=$3`) {
                return { rows: clone(staged.heads) };
            }
            if (sql === `SELECT * FROM ${REVISION_TABLE} WHERE tenant_id=$1 AND organisation_id=$2 AND plan_id=$3 ORDER BY revision LIMIT 1026`) {
                return { rows: clone(staged.revisions) };
            }
            if (sql.startsWith(`INSERT INTO ${REVISION_TABLE} `)) {
                expect(values).toHaveLength(12);
                expect(staged.revisions.some(row => row.revision === values[3] || row.operation_id === values[4])).toBe(false);
                staged.revisions.push({ tenant_id: values[0], organisation_id: values[1], plan_id: values[2], revision: values[3],
                    operation_id: values[4], payload_sha256: values[5], parent_revision: values[6], parent_sha256: values[7],
                    assessment_id: values[8], assessment_revision: values[9], assessment_sha256: values[10], payload: JSON.parse(values[11]) });
                return { rowCount: 1 };
            }
            if (sql.startsWith(`INSERT INTO ${HEAD_TABLE} `)) {
                expect(staged.heads).toEqual([]);
                staged.heads.push({ tenant_id: values[0], organisation_id: values[1], plan_id: values[2],
                    revision: values[3], payload_sha256: values[4] });
            } else if (sql.startsWith(`UPDATE ${HEAD_TABLE} SET revision=$4,payload_sha256=$5 `)) {
                const head = staged.heads[0];
                if (!head || head.revision !== values[5] || head.payload_sha256 !== values[6]) return { rowCount: 0 };
                head.revision = values[3]; head.payload_sha256 = values[4];
            } else throw new Error('Unexpected SQL in synthetic command audit proof');
            if (h.afterAppend) await h.afterAppend();
            return { rowCount: 1 };
        }) };
        let result;
        try {
            result = await work(transaction.tx);
            if (h.beforeCommit) await h.beforeCommit();
        } catch (error) { transaction.status = 'rolled_back'; h.active = null; throw error; }
        const mode = h.commitMode; h.commitMode = null;
        if (mode !== 'lost-uncommitted') h.committed = transaction.staged;
        transaction.status = mode ? mode : 'committed'; h.active = null;
        if (mode) throw Object.assign(new Error('private uncertain settlement'), { code: 'postgres_commit_failed' });
        return result;
    }) };
    const canonical = createDashboardAudit({ clock: clock.now, createEventId: crypto.randomUUID, writeEvent: async event => {
        expect(h.active.status).toBe('pending');
        const current = h.active.staged;
        if (event.action === 'improvement.write') expect(current.revisions.length).toBe(h.committed.revisions.length + 1);
        current.events.push(clone(event));
        if (h.afterAudit) await h.afterAudit(event);
    } });
    h.audit = {
        createEvent: jest.fn(function (ctx, operation) {
            expect(this).toBe(h.audit);
            const event = canonical.createEvent(ctx, operation);
            return h.transformEvent ? h.transformEvent(event) : event;
        }),
        writeEvent: jest.fn(function (event) { expect(this).toBe(h.audit); return canonical.writeEvent(event); })
    };
    h.repository = createPostgresImprovementPlanRepository({ database: h.database, clock: clock.now, audit: h.audit });
    h.execute = (input = generate(), ctx = context) => h.repository.executeImprovementPlan(ctx, input);
    h.source = createImprovementActionPlanSource({ database: h.database, clock: clock.now, audit: h.audit,
        requestContext: { resolve: async () => context } });
    return h;
}
afterEach(() => jest.clearAllMocks());

test('source execute then list retains each real transition, with one scoped audit per command', async () => {
    const h = await harness(), authorityBefore = clone(h.state);
    const commands = [generate()];
    let result = await h.source.execute({}, commands[0]);
    const initial = result;
    for (const [type, payload] of [['assign'], ['start'], ['block', { reason: 'Synthetic wait.' }],
        ['complete', { note: 'Synthetic completion.', evidenceReference: 'opaque:synthetic-evidence' }],
        ['reopen', { reason: 'Synthetic review.' }]]) {
        h.clock.advance(1000);
        const next = command(result.plan, type, payload); commands.push(next);
        result = await h.source.execute({}, next);
    }
    expect(h.committed.revisions.map(row => row.payload.intent.command.type)).toEqual(['generate', 'assign', 'start', 'block', 'complete', 'reopen']);
    expect(h.committed.events).toHaveLength(6);
    h.committed.events.forEach((event, index) => {
        expect(event).toEqual({ schemaVersion: 1, eventType: 'dashboard.operation', eventId: expect.any(String),
            requestId: h.context.requestId, actorSubjectKey: SUBJECT, ...h.scope,
            action: 'improvement.write', module: 'improvement_plan', result: 'succeeded',
            occurredAt: h.committed.revisions[index].payload.at });
        expect(Object.isFrozen(h.audit.writeEvent.mock.calls[index][0])).toBe(true);
    });
    expect(new Set(h.committed.events.map(event => event.eventId)).size).toBe(6);
    const list = await h.source.list({}, { planId: 'plan-a', filters: FILTERS });
    const row = list.actions.find(action => action.actionId === result.plan.actions[0].actionId);
    expect(list).toMatchObject({ planRevision: 5, priority: { status: 'not_calculated' } });
    expect(row).toMatchObject({ ownerSubjectKey: OWNER, ownerEligibility: 'not_checked', dueDate: '2026-10-01',
        status: 'open', completion: null, evidence: { completionVerification: 'not_recorded', downloadAllowed: false, scoreEffect: 'none' } });
    expect(row.history.map(event => event.type)).toEqual(['assign', 'start', 'block', 'complete', 'reopen']);
    expect(row.history[3].details).toMatchObject({ evidenceReference: 'opaque:synthetic-evidence', evidenceVerification: 'not_verified' });
    expect(h.committed.events.map(event => event.action)).toEqual([...Array(6).fill('improvement.write'), 'improvement.read']);
    expect(h.transactions.at(-1).queries.every(query => query.sql.startsWith('SELECT '))).toBe(true);
    expect(h.state).toEqual(authorityBefore); expect(result.plan.source).toEqual(initial.plan.source);
    expect(JSON.stringify(list)).not.toMatch(/actorSubjectKey|operationId|createdBy|completedBy|synthetic-private/);
    expect(Object.isFrozen(list.actions[0].history)).toBe(true);
});

test('identical replay returns the original result, and conflicting or foreign actor reuse adds no audit', async () => {
    const h = await harness(), initial = await h.execute(), assign = command(initial.plan), assigned = await h.execute(assign);
    await h.execute(command(assigned.plan, 'start'));
    const before = clone(h.committed), calls = h.audit.createEvent.mock.calls.length;
    expect(await h.execute(generate())).toEqual(initial); expect(await h.execute(assign)).toEqual(assigned);
    const conflict = await capture(h.execute({ ...assign, payload: { ...assign.payload, dueDate: '2026-10-03' } }));
    assertPrivateError(conflict.error, 'improvement_operation_conflict', 409);
    const ownerContext = await createContext(h.scope, h.clock, OWNER);
    // Give this other actor write permission, so the actor-bound intent comparison is reached.
    h.state.membershipState.memberships.find(member => member.subjectKey === OWNER).roles = ['editor'];
    h.state.membershipState.invitations.find(invitation => invitation.subjectKey === OWNER).roles = ['editor'];
    const actorConflict = await capture(h.execute(assign, ownerContext));
    assertPrivateError(actorConflict.error, 'improvement_operation_conflict', 409);
    expect(h.committed).toEqual(before); expect(h.audit.createEvent).toHaveBeenCalledTimes(calls);
    expect(h.transactions.slice(-4).every(tx => tx.queries.every(query => query.sql.startsWith('SELECT ')))).toBe(true);
});

test.each(['create', 'create-pretends-commit', 'write', 'write-pretends-commit'])('%s audit failure rolls back the real append without reconciliation or leakage', async phase => {
    const h = await harness();
    if (phase === 'create') h.transformEvent = () => { throw new Error('private audit creation'); };
    else if (phase === 'create-pretends-commit') h.transformEvent = () => {
        throw Object.assign(new Error('private fake database error'), { code: 'postgres_commit_failed' });
    };
    else if (phase === 'write') h.afterAudit = () => { throw new Error('private audit delivery'); };
    else {
        h.audit.writeEvent = () => { throw Object.assign(new Error('private fake database error'), { code: 'postgres_commit_failed' }); };
        h.repository = createPostgresImprovementPlanRepository({ database: h.database, clock: h.clock.now, audit: h.audit });
    }
    const outcome = await capture(h.execute()); assertPrivateError(outcome.error);
    expect(h.committed).toEqual({ revisions: [], heads: [], events: [] });
    expect(h.transactions).toHaveLength(1); expect(h.transactions[0].status).toBe('rolled_back');
    expect(h.transactions[0].staged.revisions).toHaveLength(1);
});

test.each(['undefined', 'pending', 'wrong-id', 'mutable', 'extra', 'accessor', 'proxy'])
('%s acknowledgement rejects staged delivery and append without retrying', async kind => {
    const h = await harness(), originalWrite = h.audit.writeEvent;
    h.audit.writeEvent = async event => {
        const receipt = await originalWrite.call(h.audit, event);
        if (kind === 'undefined') return undefined;
        if (kind === 'pending') return Object.freeze({ ...receipt, delivery: 'pending' });
        if (kind === 'wrong-id') return Object.freeze({ ...receipt, eventId: crypto.randomUUID() });
        if (kind === 'mutable') return { ...receipt };
        if (kind === 'extra') return Object.freeze({ ...receipt, privateDetail: 'private receipt detail' });
        if (kind === 'proxy') return new Proxy(receipt, {});
        return Object.freeze(Object.defineProperty({ ...receipt }, 'delivery', { enumerable: true,
            get() { throw new Error('private acknowledgement accessor must never execute'); } }));
    };
    h.repository = createPostgresImprovementPlanRepository({ database: h.database, clock: h.clock.now, audit: h.audit });
    const outcome = await capture(h.execute()); assertPrivateError(outcome.error);
    expect(h.transactions).toHaveLength(1); expect(h.transactions[0].status).toBe('rolled_back');
    expect(h.transactions[0].staged.events).toHaveLength(1);
    expect(h.committed).toEqual({ revisions: [], heads: [], events: [] });
});

test('an explicit caller retry after failed audit starts afresh and commits exactly one revision and event', async () => {
    const h = await harness(); h.afterAudit = () => { throw new Error('private delivery failure'); };
    const failed = await capture(h.execute()); assertPrivateError(failed.error);
    expect(h.committed.revisions).toEqual([]); expect(h.committed.events).toEqual([]);
    const discardedId = h.transactions[0].staged.events[0].eventId;
    h.afterAudit = null;
    const result = await h.execute();
    expect(result.plan.revision).toBe(0);
    expect(h.transactions.map(tx => tx.status)).toEqual(['rolled_back', 'committed']);
    expect(h.committed.revisions).toHaveLength(1); expect(h.committed.events).toHaveLength(1);
    expect(h.committed.events[0].eventId).not.toBe(discardedId);
});

test.each(['writer-expiry', 'writer-revoked', 'owner-expiry', 'owner-revoked', 'clock-regression'])
('%s during awaited audit rolls back both effects', async kind => {
    const h = await harness(), initial = await h.execute(), before = clone(h.committed);
    h.afterAudit = () => {
        if (kind === 'writer-expiry') h.clock.set(h.state.membershipState.memberships[0].validUntil);
        if (kind === 'writer-revoked') h.state.flags.enabled.improvement_plan = false;
        if (kind === 'owner-expiry') h.clock.set(h.state.membershipState.memberships.find(member => member.subjectKey === OWNER).validUntil);
        if (kind === 'owner-revoked') h.state.membershipState.memberships.find(member => member.subjectKey === OWNER).status = 'suspended';
        if (kind === 'clock-regression') h.clock.advance(-1);
    };
    const outcome = await capture(h.execute(command(initial.plan)));
    assertPrivateError(outcome.error, kind.startsWith('owner') ? 'improvement_owner_ineligible'
        : kind === 'clock-regression' ? 'improvement_unavailable' : 'improvement_access_denied',
    kind.startsWith('owner') ? 409 : kind === 'clock-regression' ? 503 : 403);
    expect(h.committed).toEqual(before); expect(h.transactions.at(-1).status).toBe('rolled_back');
    expect(h.transactions.at(-1).staged.events).toHaveLength(2);
});

test.each(['schemaVersion', 'eventType', 'eventId', 'requestId', 'actorSubjectKey', 'tenantId', 'organisationId',
    'action', 'module', 'result', 'old-time', 'future-time', 'mutable', 'extra', 'accessor', 'proxy'])
('rejects a corrupt %s envelope before invoking the sink', async kind => {
    const h = await harness();
    h.clock.advance(1000); // Old time is valid for the context but predates this command.
    h.transformEvent = event => {
        if (kind === 'mutable') return { ...event };
        if (kind === 'proxy') return new Proxy(event, {});
        if (kind === 'accessor') return Object.freeze(Object.defineProperty({ ...event }, 'action', { enumerable: true,
            get() { throw new Error('private accessor must never execute'); } }));
        const values = { schemaVersion: 2, eventType: 'foreign.operation', eventId: 'invalid', requestId: 'foreign-request',
            actorSubjectKey: OWNER, tenantId: 'foreign-tenant', organisationId: 'foreign-organisation',
            action: 'improvement.read', module: 'cyber_security', result: 'failed',
            'old-time': NOW, 'future-time': '2026-10-02T00:00:02.000Z' };
        return Object.freeze({ ...event, [kind.endsWith('-time') ? 'occurredAt' : kind]: values[kind] });
    };
    const outcome = await capture(h.execute()); assertPrivateError(outcome.error);
    expect(h.audit.writeEvent).not.toHaveBeenCalled(); expect(h.transactions).toHaveLength(1);
    expect(h.committed).toEqual({ revisions: [], heads: [], events: [] });
});

test.each(['audit', 'commit'])('awaits %s settlement before returning any command result', async phase => {
    const h = await harness(), reached = deferred(), release = deferred();
    h[phase === 'audit' ? 'afterAudit' : 'beforeCommit'] = async () => { reached.resolve(); await release.promise; };
    let settled = false;
    const pending = h.execute().then(value => { settled = true; return value; });
    await reached.promise;
    expect(settled).toBe(false); expect(h.committed).toEqual({ revisions: [], heads: [], events: [] });
    expect(h.transactions[0].staged.events).toHaveLength(1);
    release.resolve();
    const result = await pending;
    expect(result.plan.revision).toBe(0); expect(h.committed.revisions).toHaveLength(1); expect(h.committed.events).toHaveLength(1);
});

test.each(['lost-committed', 'lost-uncommitted'])('%s COMMIT reconciles only SELECT receipts and never repeats append or audit', async mode => {
    const h = await harness(); h.commitMode = mode;
    const outcome = await capture(h.execute());
    if (mode === 'lost-committed') expect(outcome.result.plan.revision).toBe(0);
    else assertPrivateError(outcome.error, 'improvement_outcome_ambiguous');
    expect(h.transactions).toHaveLength(2);
    expect(h.transactions[1].queries.map(query => query.sql)).toHaveLength(2);
    expect(h.transactions[1].queries.every(query => query.sql.startsWith('SELECT '))).toBe(true);
    expect(h.audit.createEvent).toHaveBeenCalledTimes(1); expect(h.audit.writeEvent).toHaveBeenCalledTimes(1);
    expect(h.committed.revisions).toHaveLength(mode === 'lost-committed' ? 1 : 0);
    expect(h.committed.events).toHaveLength(mode === 'lost-committed' ? 1 : 0);
});

test('lost COMMIT refuses a corrupt retained receipt rather than trusting an operation ID match', async () => {
    const h = await harness(); h.commitMode = 'lost-committed';
    h.beforeCommit = () => { h.active.staged.revisions[0].payload.resultSha256 = 'f'.repeat(64); };
    const outcome = await capture(h.execute()); assertPrivateError(outcome.error, 'improvement_outcome_ambiguous');
    expect(h.transactions).toHaveLength(2);
    expect(h.transactions[1].queries.every(query => query.sql.startsWith('SELECT '))).toBe(true);
    expect(h.committed.revisions).toHaveLength(1); expect(h.committed.events).toHaveLength(1);
    expect(h.audit.writeEvent).toHaveBeenCalledTimes(1);
});

test.each(['new', 'replay', 'reconcile'])('%s result is withheld when access expires during COMMIT, without claiming rollback', async kind => {
    const h = await harness();
    if (kind === 'replay') await h.execute();
    if (kind === 'reconcile') h.commitMode = 'lost-committed';
    h.beforeCommit = () => h.clock.set(h.state.membershipState.memberships[0].validUntil);
    const outcome = await capture(h.execute()); assertPrivateError(outcome.error, 'improvement_access_denied', 403);
    expect(outcome.result).toBeUndefined(); expect(h.committed.revisions).toHaveLength(1); expect(h.committed.events).toHaveLength(1);
    expect(h.transactions.filter(tx => tx.status === 'rolled_back')).toHaveLength(kind === 'reconcile' ? 1 : 0);
    expect(h.audit.writeEvent).toHaveBeenCalledTimes(1);
    if (kind === 'reconcile') expect(h.transactions.at(-1).queries).toEqual([]); // Denied before retained lookup.
});

test.each(['new', 'replay'])('%s post-COMMIT result requires current writer access and a monotonic clock', async kind => {
    for (const change of ['revocation', 'clock-regression']) {
        const h = await harness();
        if (kind === 'replay') await h.execute();
        h.beforeCommit = () => {
            if (change === 'revocation') h.state.flags.enabled.improvement_plan = false;
            else h.clock.advance(-1);
        };
        const outcome = await capture(h.execute());
        assertPrivateError(outcome.error, change === 'revocation' ? 'improvement_access_denied' : 'improvement_unavailable',
            change === 'revocation' ? 403 : 503);
        expect(h.transactions.every(tx => tx.status === 'committed')).toBe(true);
        expect(h.committed.revisions).toHaveLength(1); expect(h.committed.events).toHaveLength(1);
    }
});

test('replay checks the current writer without re-granting historical owner membership or re-auditing', async () => {
    const h = await harness(), initial = await h.execute(), assign = command(initial.plan), assigned = await h.execute(assign);
    h.clock.set(h.state.membershipState.memberships.find(member => member.subjectKey === OWNER).validUntil);
    expect(await h.execute(assign)).toEqual(assigned);
    expect(h.committed.revisions).toHaveLength(2); expect(h.committed.events).toHaveLength(2);
    const deniedNew = await capture(h.execute(command(assigned.plan, 'start')));
    assertPrivateError(deniedNew.error, 'improvement_owner_ineligible', 409);
    expect(h.committed.events).toHaveLength(2);
});

test('legacy unaudited history replays without inventing an audit, while new commands use captured bound methods', async () => {
    const h = await harness();
    const legacy = createPostgresImprovementPlanRepository({ database: h.database, clock: h.clock.now });
    const initial = await legacy.executeImprovementPlan(h.context, generate());
    expect(h.committed.events).toEqual([]);
    expect(await h.execute()).toEqual(initial); expect(h.committed.events).toEqual([]);
    const create = h.audit.createEvent, write = h.audit.writeEvent;
    h.audit.createEvent = () => { throw new Error('private replacement'); };
    h.audit.writeEvent = () => { throw new Error('private replacement'); };
    await h.execute(command(initial.plan));
    expect(create).toHaveBeenCalledTimes(1); expect(write).toHaveBeenCalledTimes(1);
    expect(h.committed.revisions).toHaveLength(2); expect(h.committed.events).toHaveLength(1);
});

test('present malformed audit ports fail closed at construction', async () => {
    const h = await harness();
    for (const audit of [undefined, null, {}, { createEvent() {} }, { createEvent() {}, writeEvent: true },
        { createEvent() {}, writeEvent() {}, extra: true }]) {
        expect(() => createPostgresImprovementPlanRepository({ database: h.database, clock: h.clock.now, audit }))
            .toThrow('improvement_input_invalid');
    }
    expect(h.database.withTenantTransaction).not.toHaveBeenCalled();
});
