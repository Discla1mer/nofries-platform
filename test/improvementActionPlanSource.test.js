'use strict';

// Actual request services, synthetic repository ports: this proves the dormant
// factory's command/list/evidence wiring, not installed SQL or operational audit.
jest.mock('../api/shared/improvementPlan/postgresImprovementPlanRepository', () => ({ createPostgresImprovementPlanRepository: jest.fn() }));
jest.mock('../api/shared/improvementPlan/postgresImprovementActionListRepository', () => ({ createPostgresImprovementActionListRepository: jest.fn() }));
jest.mock('../api/shared/improvementPlan/postgresImprovementEvidenceLinkRepository', () => ({ createPostgresImprovementEvidenceLinkRepository: jest.fn() }));
jest.mock('../api/shared/improvementPlan/improvementActionEditorSource', () => ({ createImprovementActionEditorSource: jest.fn() }));
const { createPostgresImprovementPlanRepository } = require('../api/shared/improvementPlan/postgresImprovementPlanRepository');
const { createPostgresImprovementActionListRepository } = require('../api/shared/improvementPlan/postgresImprovementActionListRepository');
const { createPostgresImprovementEvidenceLinkRepository } = require('../api/shared/improvementPlan/postgresImprovementEvidenceLinkRepository');
const { createImprovementActionEditorSource } = require('../api/shared/improvementPlan/improvementActionEditorSource');
const { createImprovementActionPlanSource } = require('../api/shared/improvementPlan/improvementActionPlanSource');
const { createImprovementPlan, applyImprovementActionCommand } = require('../api/shared/improvementPlan/improvementPlanDomain');
const { projectImprovementActionList, ImprovementActionListError } = require('../api/shared/improvementPlan/improvementActionListProjection');
const { acceptedRegistry } = require('../api/shared/assessmentLifecycle/ncscAssessmentSubmission');
const { createContext, createClock } = require('./fixtures/ncscAssessmentFixture');
const accepted = require('./fixtures/ncscAcceptedEvaluation.json').input;
const listSelector = () => ({ planId: 'plan-a', filters: { status: 'all', owner: 'all', overdueOnly: false } });
const command = () => ({ planId: 'plan-a', operationId: 'assign-a', type: 'assign', expectedRevision: 2,
    actionId: 'action-a', payload: { ownerSubjectKey: '10000000-0000-4000-8000-000000000000:10000000-0000-4000-8000-000000000001', dueDate: '2026-10-21' } });
const evidenceSelector = () => ({ planId: 'plan-a', planRevision: 3, actionId: 'action-a', artefactId: 'evidence-a', evidenceVersionId: 'version:0' });
async function harness() {
    const clock = createClock('2026-10-02T00:00:00.000Z'), context = await createContext({ tenantId: 'tenant-a', organisationId: 'organisation-a' }, clock);
    const ports = { database: { withTenantTransaction: jest.fn() }, clock: clock.now,
        audit: { createEvent: jest.fn(), writeEvent: jest.fn() }, requestContext: { resolve: jest.fn(async () => context) } };
    const planRepository = { readImprovementPlan: jest.fn(), executeImprovementPlan: jest.fn(async () => ({ plan: { revision: 3 } })) };
    const scope = { ...context.scope, planId: 'plan-a' }, actorSubjectKey = context.identity.subjectKey;
    let state = createImprovementPlan({ ...scope, actorSubjectKey, createdAt: accepted.scoreAsOf },
        { ...JSON.parse(JSON.stringify(accepted)), organisationId: scope.organisationId }, { registry: acceptedRegistry });
    for (const [type, payload] of [['assign', command().payload], ['start', {}], ['block', { reason: 'Synthetic wait.' }]]) {
        state = applyImprovementActionCommand(state, { ...scope, actorSubjectKey, type, payload,
            actionId: state.proposals[0].actionId, evaluationOutputSha256: state.source.evaluationOutputSha256,
            operationId: 'operation-' + state.commands.length, expectedRevision: state.commands.length,
            at: '2026-09-14T09:01:00.000Z' }, { ...context.scope, actorSubjectKey,
            eligibleOwnerSubjectKeys: [command().payload.ownerSubjectKey] });
    }
    const listResult = projectImprovementActionList(state, { scope, asOf: clock.now(), filters: listSelector().filters });
    const listRepository = { readImprovementActionList: jest.fn(async () => listResult),
        listImprovementPlans: jest.fn(async () => Object.freeze({ schemaVersion: 1, scope: context.scope,
            asOf: clock.now(), plans: [{ planId: 'plan-a', planRevision: 3 }], nextAfterPlanId: null })) };
    const evidenceRepository = { resolveImprovementEvidenceLink: jest.fn(async () => ({ status: 'unpersisted', evidenceVerification: 'not_verified', downloadAllowed: false })) };
    const editorSource = { editor: jest.fn(async () => Object.freeze({ schemaVersion: 1,
        scope, planRevision: 3, asOf: clock.now(), canWrite: false, ownerChoices: [], actions: [] })) };
    createPostgresImprovementPlanRepository.mockReturnValue(planRepository);
    createPostgresImprovementActionListRepository.mockReturnValue(listRepository);
    createPostgresImprovementEvidenceLinkRepository.mockReturnValue(evidenceRepository);
    createImprovementActionEditorSource.mockReturnValue(editorSource);
    return { ports, context, listResult, planRepository, listRepository, evidenceRepository, editorSource,
        source: createImprovementActionPlanSource(ports) };
}
afterEach(() => jest.clearAllMocks());

test('factory shares explicit ports while preserving distinct transaction/audit responsibilities', async () => {
    const h = await harness(), { database, clock, audit } = h.ports;
    expect(createPostgresImprovementPlanRepository).toHaveBeenCalledWith({ database, clock, audit });
    expect(createPostgresImprovementActionListRepository).toHaveBeenCalledWith({ database, clock, audit });
    expect(createPostgresImprovementEvidenceLinkRepository).toHaveBeenCalledWith({ database, clock, audit });
    expect(createImprovementActionEditorSource).toHaveBeenCalledWith(h.ports);
    expect(Object.keys(h.source).sort()).toEqual(['editor', 'execute', 'list', 'plans', 'resolveEvidence', 'view']); expect(Object.isFrozen(h.source)).toBe(true);
    const request = {};
    await expect(h.source.execute(request, command())).resolves.toEqual({ plan: { revision: 3 } });
    await expect(h.source.list(request, listSelector())).resolves.toMatchObject({ planRevision: 3, priority: { status: 'not_calculated' } });
    await expect(h.source.resolveEvidence(request, evidenceSelector())).resolves.toMatchObject({ status: 'unpersisted', evidenceVerification: 'not_verified', downloadAllowed: false });
    expect(h.ports.requestContext.resolve).toHaveBeenCalledTimes(3);
    expect(h.planRepository.executeImprovementPlan).toHaveBeenCalledWith(h.context, command());
    expect(h.listRepository.readImprovementActionList).toHaveBeenCalledWith(h.context, listSelector());
    expect(h.evidenceRepository.resolveImprovementEvidenceLink).toHaveBeenCalledWith(h.context, evidenceSelector());
    expect(h.ports.audit.writeEvent).not.toHaveBeenCalled(); // No fabricated post-commit command audit.
    expect(h.ports.database.withTenantTransaction).not.toHaveBeenCalled(); // Repositories own settlement.
});

test('editor composes the same explicit transaction, audit and genuine request context ports', async () => {
    const h = await harness(), request = {}, selector = { planId: 'plan-a' };
    const result = await h.source.editor(request, selector);
    expect(result).toMatchObject({ schemaVersion: 1, scope: { ...h.context.scope, planId: 'plan-a' },
        planRevision: 3, canWrite: false, ownerChoices: [], actions: [] });
    expect(h.source.editor).toBe(h.editorSource.editor);
    expect(h.editorSource.editor).toHaveBeenCalledTimes(1);
    expect(h.editorSource.editor).toHaveBeenCalledWith(request, selector);
    expect(h.planRepository.executeImprovementPlan).not.toHaveBeenCalled();
    expect(h.listRepository.readImprovementActionList).not.toHaveBeenCalled();
    expect(h.evidenceRepository.resolveImprovementEvidenceLink).not.toHaveBeenCalled();
    expect(h.ports.database.withTenantTransaction).not.toHaveBeenCalled();
    expect(h.ports.audit.writeEvent).not.toHaveBeenCalled();
});

test('a later stale evidence selection preserves the original revision and is never retried or saved', async () => {
    const h = await harness(), selected = evidenceSelector();
    const { ImprovementEvidenceLinkError } = require('../api/shared/improvementPlan/improvementEvidenceLinkService');
    h.evidenceRepository.resolveImprovementEvidenceLink.mockRejectedValue(new ImprovementEvidenceLinkError('improvement_evidence_selection_conflict', 409));
    await expect(h.source.resolveEvidence({}, selected)).rejects.toMatchObject({ statusCode: 409 });
    expect(h.evidenceRepository.resolveImprovementEvidenceLink).toHaveBeenCalledWith(h.context, selected);
    expect(h.evidenceRepository.resolveImprovementEvidenceLink).toHaveBeenCalledTimes(1);
    expect(h.planRepository.executeImprovementPlan).not.toHaveBeenCalled(); expect(h.listRepository.readImprovementActionList).not.toHaveBeenCalled();
});

test('plans uses the paired list repository/context without loading actions or creating a tracker', async () => {
    const h = await harness(), request = {}, page = { limit: 20, afterPlanId: null };
    await expect(h.source.plans(request, page)).resolves.toMatchObject({ schemaVersion: 1, scope: h.context.scope,
        plans: [{ planId: 'plan-a', planRevision: 3 }], nextAfterPlanId: null });
    expect(h.ports.requestContext.resolve).toHaveBeenCalledTimes(1);
    expect(h.ports.requestContext.resolve).toHaveBeenCalledWith(request);
    expect(h.listRepository.listImprovementPlans).toHaveBeenCalledTimes(1);
    expect(h.listRepository.listImprovementPlans).toHaveBeenCalledWith(h.context, page);
    expect(h.listRepository.readImprovementActionList).not.toHaveBeenCalled();
    expect(h.planRepository.executeImprovementPlan).not.toHaveBeenCalled();
    expect(h.evidenceRepository.resolveImprovementEvidenceLink).not.toHaveBeenCalled();
    expect(h.ports.database.withTenantTransaction).not.toHaveBeenCalled(); expect(h.ports.audit.writeEvent).not.toHaveBeenCalled();
});

test('closed method inputs reject forged scope, ownership context, and ranking before authentication', async () => {
    const h = await harness();
    await expect(h.source.list({}, { ...listSelector(), priority: 'top-three' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(h.source.view({}, { ...listSelector(), priority: 'top-three' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(h.source.execute({}, { ...command(), eligibleOwnerSubjectKeys: ['forged'] })).rejects.toMatchObject({ statusCode: 400 });
    await expect(h.source.resolveEvidence({}, { ...evidenceSelector(), tenantId: 'forged' })).rejects.toMatchObject({ statusCode: 400 });
    expect(h.ports.requestContext.resolve).not.toHaveBeenCalled();
});

test('view calls the existing list once, preserves its real payload and adds only readable presentation', async () => {
    const h = await harness(), request = { synthetic: 'request' }, selected = listSelector();
    const result = await h.source.view(request, selected);
    expect(result).toMatchObject({ presentationVersion: 1, planRevision: 3, source: h.listResult.source,
        counts: h.listResult.counts, filters: selected.filters, notices: { priority: expect.any(String) } });
    const blocked = result.actions.find(action => action.status === 'blocked');
    expect(blocked).toMatchObject({ ownerSubjectKey: command().payload.ownerSubjectKey, dueDate: '2026-10-21',
        blockedReason: 'Synthetic wait.', labels: { status: 'Blocked', owner: 'Assigned (eligibility not checked)' } });
    expect(blocked.history.map(event => event.label)).toEqual(['Assigned', 'Started', 'Blocked']);
    expect(h.ports.requestContext.resolve).toHaveBeenCalledTimes(1);
    expect(h.ports.requestContext.resolve).toHaveBeenCalledWith(request);
    expect(h.listRepository.readImprovementActionList).toHaveBeenCalledTimes(1);
    expect(h.listRepository.readImprovementActionList).toHaveBeenCalledWith(h.context, selected);
    expect(h.planRepository.executeImprovementPlan).not.toHaveBeenCalled();
    expect(h.planRepository.readImprovementPlan).not.toHaveBeenCalled();
    expect(h.evidenceRepository.resolveImprovementEvidenceLink).not.toHaveBeenCalled();
    expect(h.ports.audit.createEvent).not.toHaveBeenCalled(); expect(h.ports.audit.writeEvent).not.toHaveBeenCalled();
    expect(h.ports.database.withTenantTransaction).not.toHaveBeenCalled();
    expect(Object.isFrozen(result.actions[0].labels)).toBe(true);
    const raw = await h.source.list(request, selected);
    expect(raw).toBe(h.listResult); expect(raw).not.toHaveProperty('presentationVersion');
});

test.each([
    ['improvement_list_access_denied', 403], ['improvement_list_not_found', 404],
    ['improvement_list_time_conflict', 409], ['improvement_list_unavailable', 503]
])('view preserves the existing %s list error without retry or side effects', async (code, status) => {
    const h = await harness(), error = new ImprovementActionListError(code, status);
    h.listRepository.readImprovementActionList.mockRejectedValue(error);
    await expect(h.source.view({}, listSelector())).rejects.toBe(error);
    expect(h.listRepository.readImprovementActionList).toHaveBeenCalledTimes(1);
    expect(h.ports.requestContext.resolve).toHaveBeenCalledTimes(1);
    expect(h.planRepository.executeImprovementPlan).not.toHaveBeenCalled();
    expect(h.evidenceRepository.resolveImprovementEvidenceLink).not.toHaveBeenCalled();
    expect(h.ports.audit.writeEvent).not.toHaveBeenCalled();
});

test('view awaits list settlement and never retries a malformed successful payload', async () => {
    const h = await harness(); let resolve, settled = false;
    h.listRepository.readImprovementActionList.mockReturnValue(new Promise(done => { resolve = done; }));
    const pending = h.source.view({}, listSelector()).then(result => { settled = true; return result; });
    await Promise.resolve(); await Promise.resolve();
    expect(settled).toBe(false); expect(h.listRepository.readImprovementActionList).toHaveBeenCalledTimes(1);
    resolve(h.listResult); await expect(pending).resolves.toMatchObject({ presentationVersion: 1 });
    h.listRepository.readImprovementActionList.mockResolvedValue({ privateDetail: 'private source payload' });
    await expect(h.source.view({}, listSelector())).rejects.toMatchObject({ code: 'improvement_presentation_unavailable', statusCode: 503 });
    expect(h.listRepository.readImprovementActionList).toHaveBeenCalledTimes(2);
    expect(h.ports.audit.writeEvent).not.toHaveBeenCalled();
});

test('factory requires an explicit closed port set and has no default runtime binding', () => {
    for (const input of [undefined, {}, { database: {}, clock() {}, audit: {}, requestContext: {}, enable: true }]) {
        expect(() => createImprovementActionPlanSource(input)).toThrow();
    }
});
