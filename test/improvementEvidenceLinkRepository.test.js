'use strict';

// Real repository/access/domain composition with synthetic storage ports only.
// These cases establish ordering and disclosure, not native SQL or live sessions.
jest.mock('../api/shared/appLifecycle/postgresDashboardBootstrap', () => {
    const actual = jest.requireActual('../api/shared/appLifecycle/postgresDashboardBootstrap');
    return { ...actual, dataStorage: { ...actual.dataStorage, loadSnapshotForUpdate: jest.fn() } };
});
jest.mock('../api/shared/improvementPlan/improvementPlanStore', () => {
    const actual = jest.requireActual('../api/shared/improvementPlan/improvementPlanStore');
    return { ...actual, loadHistory: jest.fn() };
});
jest.mock('../api/shared/evidenceLifecycle/postgresEvidenceStore', () => ({ createPostgresEvidenceStore: jest.fn() }));

const crypto = require('node:crypto');
const { dataStorage } = require('../api/shared/appLifecycle/postgresDashboardBootstrap');
const actionStore = require('../api/shared/improvementPlan/improvementPlanStore');
const { createPostgresEvidenceStore } = require('../api/shared/evidenceLifecycle/postgresEvidenceStore');
const { createPostgresImprovementEvidenceLinkRepository } = require('../api/shared/improvementPlan/postgresImprovementEvidenceLinkRepository');
const { createImprovementPlan, getImprovementPlanView } = require('../api/shared/improvementPlan/improvementPlanDomain');
const { acceptedRegistry } = require('../api/shared/assessmentLifecycle/ncscAssessmentSubmission');
const { applyEvidenceCommand } = require('../api/shared/evidenceLifecycle/evidenceDomain');
const { createDashboardAudit } = require('../api/shared/appLifecycle/dashboardAudit');
const { evidenceFixture, clone } = require('./fixtures/evidenceMetadataFixture');
const { createClock, createContext } = require('./fixtures/ncscAssessmentFixture');
const accepted = require('./fixtures/ncscAcceptedEvaluation.json').input;

async function harness(options = {}) {
    const f = evidenceFixture({ now: accepted.scoreAsOf, organisationId: accepted.organisationId,
        modules: ['overview', 'improvement_plan', 'evidence'], ...options });
    const clock = createClock(f.now), context = await createContext(f.scope, clock), trace = [];
    const state = createImprovementPlan({ ...f.scope, planId: 'plan-a', actorSubjectKey: f.subjectKey, createdAt: f.now },
        clone(accepted), { registry: acceptedRegistry });
    const h = { ...f, state: clone(f.state), clock, context, trace, tx: { query: jest.fn() },
        retained: { state, result: { schemaVersion: 1, plan: getImprovementPlanView(state) },
            source: { assessmentId: accepted.assessmentId, revision: 2, revisionSha256: 'c'.repeat(64) }, history: [] },
        afterAction: null, afterEvidence: null, afterAudit: null, failCommit: false, evidenceTenantOverride: null };
    const newer = { ...clone(f.command), action: 'append-version', expectedRevision: 0,
        idempotencyKey: 'synthetic:append', payload: { ...clone(f.command.payload), versionId: 'version:1',
            declaredContent: { ...f.command.payload.declaredContent, sha256: 'b'.repeat(64), sizeBytes: 90 } } };
    h.evidence = applyEvidenceCommand(f.evidence, f.state.tenantAggregate, newer);
    h.selector = { planId: 'plan-a', planRevision: 0, actionId: h.retained.result.plan.actions[0].actionId,
        artefactId: f.command.artefactId, evidenceVersionId: 'version:0' };
    dataStorage.loadSnapshotForUpdate.mockImplementation(async (tx, scope) => {
        expect(tx).toBe(h.tx); expect(scope).toEqual(f.scope); trace.push('authority'); return h.state;
    });
    actionStore.loadHistory.mockImplementation(async (tx, scope, aggregate) => {
        expect(tx).toBe(h.tx); expect(scope).toEqual({ ...f.scope, planId: 'plan-a' });
        expect(aggregate).toBe(h.state.tenantAggregate); trace.push('action');
        if (h.afterAction) h.afterAction(); return h.retained;
    });
    h.readEvidence = jest.fn(async selector => {
        expect(selector).toEqual({ ...f.scope, artefactId: f.command.artefactId }); trace.push('evidence');
        if (h.afterEvidence) h.afterEvidence(); return h.evidence;
    });
    createPostgresEvidenceStore.mockImplementation(({ database }) => ({
        read: selector => database.withTenantTransaction(h.evidenceTenantOverride || selector.tenantId, async tx => {
            expect(tx).toBe(h.tx); return await h.readEvidence(selector);
        })
    }));
    h.database = { withTenantTransaction: jest.fn(async (tenantId, work) => {
        expect(tenantId).toBe(f.scope.tenantId); trace.push('begin');
        try { const result = await work(h.tx); trace.push('commit');
            if (h.failCommit) throw Object.assign(new Error('private uncertain database outcome'), { code: 'postgres_commit_failed' });
            return result;
        } catch (error) { trace.push('rollback-or-uncertain'); throw error; }
    }) };
    h.auditEvents = [];
    h.audit = createDashboardAudit({ clock: clock.now, createEventId: crypto.randomUUID, writeEvent: async event => {
        expect(trace.slice(trace.lastIndexOf('begin'))).not.toContain('commit');
        trace.push('audit'); h.auditEvents.push(clone(event));
        if (h.afterAudit) h.afterAudit();
    } });
    h.repository = createPostgresImprovementEvidenceLinkRepository({ database: h.database, clock: clock.now, audit: h.audit });
    h.resolve = input => h.repository.resolveImprovementEvidenceLink(h.context, input || h.selector);
    return h;
}
afterEach(() => jest.clearAllMocks());

test('same-transaction real repositories resolve an exact historical version with no business mutation', async () => {
    const h = await harness(), before = clone({ action: h.retained, evidence: h.evidence });
    const result = await h.resolve();
    expect(result).toMatchObject({ schemaVersion: 1, status: 'unpersisted', evidenceVerification: 'not_verified',
        downloadAllowed: false, scoreEffect: 'none', scope: h.scope,
        action: { planId: 'plan-a', planRevision: 0, actionId: h.selector.actionId,
            itemId: h.retained.result.plan.actions[0].itemId, controlId: h.retained.result.plan.actions[0].controlId },
        assessment: { ...h.retained.source, evaluationOutputSha256: h.retained.result.plan.source.evaluationOutputSha256 },
        evidence: { artefactId: h.selector.artefactId, versionId: 'version:0', introducedRevision: 0,
            metadataRevision: 1, currentVersionId: 'version:1', selectedIsCurrent: false,
            declaredContent: { sha256: 'a'.repeat(64), sizeBytes: 100 },
            quarantine: { state: 'quarantined', reason: 'content-unverified' } } });
    expect(h.database.withTenantTransaction).toHaveBeenCalledTimes(1);
    expect(h.trace.filter(item => ['begin', 'action', 'evidence', 'audit', 'commit'].includes(item)))
        .toEqual(['begin', 'action', 'evidence', 'audit', 'commit']);
    expect(h.auditEvents[0]).toMatchObject({ action: 'evidence.read', module: 'evidence', result: 'succeeded', ...h.scope });
    expect({ action: h.retained, evidence: h.evidence }).toEqual(before);
    expect(h.tx.query).not.toHaveBeenCalled();
    expect(Object.isFrozen(result.evidence.declaredContent)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/private-source|private-policy|private-purpose|actorSubjectKey|createdBy|governanceRefs|https?:/);
});

test('explicit latest version selection and repeated reads never upgrade an older selection or save a link', async () => {
    const h = await harness(), first = await h.resolve();
    expect(await h.resolve()).toEqual(first);
    const current = await h.resolve({ ...h.selector, evidenceVersionId: 'version:1' });
    expect(current.evidence).toMatchObject({ versionId: 'version:1', selectedIsCurrent: true,
        declaredContent: { sha256: 'b'.repeat(64), sizeBytes: 90 } });
    expect(h.auditEvents).toHaveLength(3);
    expect(new Set(h.auditEvents.map(event => event.eventId)).size).toBe(3);
    expect(h.retained.result.plan.revision).toBe(0); expect(h.evidence.versions).toHaveLength(2);
    expect(Object.keys(h.repository)).toEqual(['resolveImprovementEvidenceLink']);
});

test.each(['viewer', 'membership', 'product', 'improvement-module', 'evidence-module', 'improvement-flag',
    'evidence-flag', 'tenant', 'organisation'])('current %s denial precedes any object lookup or audit', async kind => {
    const h = await harness(kind === 'viewer' ? { role: 'viewer' } : {});
    if (kind === 'membership') h.state.membershipState.memberships[0].status = 'suspended';
    if (kind === 'product') h.state.entitlementState.grants = [];
    if (kind === 'improvement-module') h.state.entitlementState.grants[0].modules = ['overview', 'evidence'];
    if (kind === 'evidence-module') h.state.entitlementState.grants[0].modules = ['overview', 'improvement_plan'];
    if (kind === 'improvement-flag') h.state.flags.enabled.improvement_plan = false;
    if (kind === 'evidence-flag') h.state.flags.enabled.evidence = false;
    if (kind === 'tenant') h.state.tenantAggregate.tenant.recordStatus = 'suspended';
    if (kind === 'organisation') h.state.tenantAggregate.organisations[0].recordStatus = 'suspended';
    await expect(h.resolve()).rejects.toMatchObject({ statusCode: 403 });
    expect(actionStore.loadHistory).not.toHaveBeenCalled(); expect(h.readEvidence).not.toHaveBeenCalled();
    expect(h.auditEvents).toEqual([]);
});

test.each(['action', 'evidence', 'audit'])('expiry during %s withholds the complete candidate', async phase => {
    const h = await harness();
    h['after' + phase[0].toUpperCase() + phase.slice(1)] = () => h.clock.set(h.state.membershipState.memberships[0].validUntil);
    await expect(h.resolve()).rejects.toMatchObject({ statusCode: 403 });
    expect(h.trace).not.toContain('commit');
});

test('revoking only improvement access during the evidence audit is caught by the final dual check', async () => {
    const h = await harness(); h.afterAudit = () => { h.state.flags.enabled.improvement_plan = false; };
    await expect(h.resolve()).rejects.toMatchObject({ statusCode: 403 }); expect(h.trace).not.toContain('commit');
});

test('one monotonic clock rejects a regression between the action and evidence repositories', async () => {
    const h = await harness(); h.afterAction = () => h.clock.advance(2000);
    h.afterEvidence = () => h.clock.advance(-1000);
    await expect(h.resolve()).rejects.toMatchObject({ statusCode: 503 });
    expect(h.auditEvents).toEqual([]); expect(h.trace).not.toContain('commit');
});

test.each(['revision', 'action', 'version', 'plan-missing', 'evidence-missing', 'corrupt-evidence', 'corrupt-plan'])
('invalid %s selection returns no candidate and no successful transaction', async kind => {
    const h = await harness();
    if (kind === 'revision') h.selector.planRevision = 1;
    if (kind === 'action') h.selector.actionId = 'action:absent';
    if (kind === 'version') h.selector.evidenceVersionId = 'version:absent';
    if (kind === 'plan-missing') h.retained = null;
    if (kind === 'evidence-missing') h.evidence = null;
    if (kind === 'corrupt-evidence') { h.evidence = clone(h.evidence); h.evidence.currentVersionId = 'missing-head'; }
    if (kind === 'corrupt-plan') actionStore.loadHistory.mockRejectedValue(new Error('private corrupted history'));
    await expect(h.resolve()).rejects.toMatchObject({ statusCode: kind === 'revision' ? 409 : kind.startsWith('corrupt') ? 503 : 404 });
    expect(h.trace).not.toContain('commit');
});

test('foreign action state and a foreign nested transaction are denied', async () => {
    const h = await harness(); h.retained = clone(h.retained); h.retained.result.plan.organisationId = 'foreign';
    await expect(h.resolve()).rejects.toMatchObject({ statusCode: 503 }); expect(h.readEvidence).not.toHaveBeenCalled();
    const other = await harness(); other.evidenceTenantOverride = 'foreign-tenant';
    await expect(other.resolve()).rejects.toMatchObject({ statusCode: 403 }); expect(other.readEvidence).not.toHaveBeenCalled();
});

test('forged contexts and input scope injection never open a transaction', async () => {
    const h = await harness();
    await expect(h.repository.resolveImprovementEvidenceLink(clone(h.context), h.selector)).rejects.toMatchObject({ statusCode: 403 });
    await expect(h.resolve({ ...h.selector, tenantId: 'foreign' })).rejects.toMatchObject({ statusCode: 400 });
    expect(h.database.withTenantTransaction).not.toHaveBeenCalled();
});

test.each(['audit', 'commit'])('failed or ambiguous %s withholds output without repeating work', async phase => {
    const h = await harness();
    if (phase === 'audit') h.afterAudit = () => { throw new Error('private audit sink detail'); };
    else h.failCommit = true;
    await expect(h.resolve()).rejects.toMatchObject({ code: 'improvement_evidence_unavailable', statusCode: 503 });
    expect(h.database.withTenantTransaction).toHaveBeenCalledTimes(1);
    expect(actionStore.loadHistory).toHaveBeenCalledTimes(1); expect(h.readEvidence).toHaveBeenCalledTimes(1);
    expect(h.auditEvents).toHaveLength(1);
});
