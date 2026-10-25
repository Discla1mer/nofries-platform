'use strict';

const { createImprovementPlan, getImprovementPlanView, applyImprovementActionCommand,
    ImprovementPlanError } = require('../api/shared/improvementPlan/improvementPlanDomain');
const { createFrameworkRegistry } = require('../api/shared/assessmentEngine/frameworkProfileRegistry');
const { createAcceptedNcscFrameworkProfile } = require('../api/shared/assessmentEngine/ncscAcceptedFrameworkProfile');
const { evaluateAssessment, calculateEvidenceSnapshotSha256,
    calculateApplicabilityDecisionSha256 } = require('../api/shared/assessmentEngine/assessmentEvaluator');
const fixture = require('./fixtures/ncscAcceptedEvaluation.json');
const { normaliseEvidenceSelector } = require('../api/shared/evidenceLifecycle/evidenceDomain');

const clone = value => JSON.parse(JSON.stringify(value));
const ACTOR = '11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222';
const OWNER = '11111111-1111-4111-8111-111111111111:33333333-3333-4333-8333-333333333333';
const OTHER = '11111111-1111-4111-8111-111111111111:44444444-4444-4444-8444-444444444444';
const scope = { tenantId: 'synthetic-tenant', organisationId: fixture.input.organisationId,
    planId: 'synthetic-plan', createdAt: '2026-09-14T09:00:00.000Z', actorSubjectKey: ACTOR };
const context = { tenantId: scope.tenantId, organisationId: scope.organisationId,
    actorSubjectKey: ACTOR, eligibleOwnerSubjectKeys: [OWNER] };
const registry = createFrameworkRegistry([createAcceptedNcscFrameworkProfile()]);
const options = { registry };
function plan(input = clone(fixture.input), selectedScope = scope, dependencies = options) {
    return createImprovementPlan(selectedScope, input, dependencies);
}
function command(state, type = 'assign', payload = { ownerSubjectKey: OWNER, dueDate: '2026-10-01' }) {
    return { tenantId: state.tenantId, organisationId: state.organisationId, planId: state.planId,
        evaluationOutputSha256: state.source.evaluationOutputSha256, actionId: state.proposals[0].actionId,
        operationId: 'op-' + state.commands.length, expectedRevision: state.commands.length,
        actorSubjectKey: ACTOR, at: '2026-09-14T09:01:00.000Z', type, payload };
}
function step(state, type, payload) { return applyImprovementActionCommand(state, command(state, type, payload), context); }
function first(state) { return getImprovementPlanView(state).actions[0]; }
function running() { return step(step(plan()), 'start', {}); }
function completed() { return step(running(), 'complete', { note: 'Synthetic change checked.', evidenceReference: 'evidence:synthetic-1' }); }
function expectCode(work, code) {
    expect(work).toThrow(ImprovementPlanError);
    try { work(); } catch (error) { expect(error.code).toBe('improvement_' + code); }
}

describe('improvement plan source domain', () => {
    test('synthetic assessment to owned work preserves source scores through completion and reopening', () => {
        const input = clone(fixture.input), original = clone(input), evaluation = evaluateAssessment(input, options);
        let state = plan(input);
        expect(getImprovementPlanView(state)).toMatchObject({ revision: 0,
            counts: { total: 14, unassigned: 14, completed: 0 },
            priority: { status: 'not_calculated', reason: 'priority_adapter_required' } });
        state = step(state);
        expect(first(state)).toMatchObject({ ownerSubjectKey: OWNER, dueDate: '2026-10-01', status: 'open' });
        state = step(state, 'start', {});
        state = step(state, 'complete', { note: 'Synthetic work completed.', evidenceReference: 'evidence:synthetic-1' });
        expect(first(state)).toMatchObject({ status: 'completed', completion: {
            completedBy: ACTOR, completedAt: '2026-09-14T09:01:00.000Z',
            evidenceVerification: 'not_verified', evidenceReference: 'evidence:synthetic-1' } });
        expect(getImprovementPlanView(state).counts.completed).toBe(1);
        state = step(state, 'reopen', { reason: 'A new review found unfinished work.' });
        expect(first(state)).toMatchObject({ status: 'open', completion: null, ownerSubjectKey: OWNER });
        expect(state.commands).toHaveLength(4);
        expect(state.commands[2].payload.evidenceReference).toBe('evidence:synthetic-1');
        expect(state.source).toEqual({ provenance: evaluation.provenance, evaluationOutputSha256: evaluation.outputSha256 });
        expect(input).toEqual(original);
        expect(evaluateAssessment(input, options)).toEqual(evaluation);
    });

    test('distinguishes the literal nine implementation, two clarification and three evidence gaps', () => {
        const actions = getImprovementPlanView(plan()).actions;
        expect(actions.filter(a => a.kind === 'implementation')).toHaveLength(9);
        expect(actions.filter(a => a.kind === 'assessment')).toHaveLength(1);
        expect(actions.filter(a => a.kind === 'applicability')).toHaveLength(1);
        expect(actions.filter(a => a.kind === 'evidence')).toHaveLength(3);
        expect(actions.find(a => a.itemId === 'NF-NCSC-CC-NS-01-Q1')).toMatchObject({
            kind: 'applicability', response: 'unknown', responseOrigin: 'claimed_not_applicable' });
    });

    test('approved N/A produces no work while preserving the evaluator-approved source', () => {
        const input = clone(fixture.input), atom = input.atomInputs.find(a => a.itemId === 'NF-NCSC-CC-NS-01-Q1');
        const decision = { decisionId: 'decision-ns', decisionRevision: 'decision-1', organisationId: input.organisationId,
            moduleId: input.moduleId, assessmentId: input.assessmentId, assessmentRevision: input.assessmentRevision,
            itemId: atom.itemId, frameworkId: input.profileRef.frameworkId, frameworkVersion: input.profileRef.frameworkVersion,
            profileId: input.profileRef.profileId, profileVersion: input.profileRef.profileVersion,
            catalogueSha256: input.profileRef.catalogueSha256, scopePopulationSha256: input.scopePopulationSha256,
            status: 'approved', rationaleSha256: atom.applicabilityClaim.rationaleSha256,
            approvedBy: 'synthetic-reviewer', approvedAt: '2026-09-07T09:00:00.000Z' };
        atom.applicabilityDecision = { ...decision, decisionSha256: calculateApplicabilityDecisionSha256(decision) };
        const dependencies = { registry, applicabilityDecisionRegistry: { getDecision: () => clone(atom.applicabilityDecision) } };
        const state = plan(input, scope, dependencies);
        expect(state.proposals).toHaveLength(13);
        expect(state.proposals.some(a => a.itemId === atom.itemId)).toBe(false);
        expect(state.source.evaluationOutputSha256).toBe(evaluateAssessment(input, dependencies).outputSha256);
    });

    test.each(['documented_current', 'tested_or_observed_current', 'independently_reviewed_current'])(
        'Yes with %s produces no default evidence task', evidenceState => {
            const input = clone(fixture.input);
            input.atomInputs.filter(a => a.response.optionId === 'yes').forEach(a => { a.evidenceState = evidenceState; });
            input.evidenceSnapshot.sha256 = calculateEvidenceSnapshotSha256(input.atomInputs.map(({ itemId, evidenceState: state }) => ({ itemId, evidenceState: state })));
            expect(plan(input).proposals).toHaveLength(11);
        });

    test('Yes with stale evidence remains an evidence task', () => {
        const input = clone(fixture.input), atom = input.atomInputs.find(a => a.response.optionId === 'yes');
        atom.evidenceState = 'stale';
        input.evidenceSnapshot.sha256 = calculateEvidenceSnapshotSha256(input.atomInputs.map(({ itemId, evidenceState }) => ({ itemId, evidenceState })));
        expect(plan(input).proposals.find(a => a.itemId === atom.itemId).kind).toBe('evidence');
    });

    test('identical generation is stable and tenant, plan and assessment revision change action identities', () => {
        const original = plan();
        expect(plan()).toEqual(original);
        expect(plan(undefined, { ...scope, tenantId: 'other-tenant' }).proposals[0].actionId).not.toBe(original.proposals[0].actionId);
        expect(plan(undefined, { ...scope, planId: 'other-plan' }).proposals[0].actionId).not.toBe(original.proposals[0].actionId);
        const input = clone(fixture.input); input.assessmentRevision = 'rev-2';
        expect(plan(input).proposals[0].actionId).not.toBe(original.proposals[0].actionId);
    });

    test('does not accept fabricated evaluation output in place of evaluator input', () => {
        expect(() => plan(evaluateAssessment(clone(fixture.input), options))).toThrow();
    });

    test('accepted ENG-003 revision versions containing plus survive view, command and JSON round trips', () => {
        const input = clone(fixture.input); input.assessmentRevision = 'rev-1+synthetic';
        const state = plan(input), assigned = step(state);
        expect(getImprovementPlanView(clone(assigned)).source.provenance.assessmentRevision).toBe('rev-1+synthetic');
        expect(first(assigned).ownerSubjectKey).toBe(OWNER);
        const tooLong = clone(state); tooLong.source.provenance.assessmentRevision = 'r'.repeat(81);
        expectCode(() => getImprovementPlanView(tooLong), 'version_invalid');
        const floating = clone(state); floating.source.provenance.assessmentRevision = 'LATEST';
        expectCode(() => getImprovementPlanView(floating), 'version_invalid');
    });

    test('rejects a wrong profile digest by using the original engine', () => {
        const input = clone(fixture.input); input.profileRef.catalogueSha256 = '0'.repeat(64);
        expect(() => plan(input)).toThrow();
    });

    test('creation rejects a mismatched organisation or pre-evaluation timestamp', () => {
        expectCode(() => plan(undefined, { ...scope, organisationId: 'other-org' }), 'scope_mismatch');
        expectCode(() => plan(undefined, { ...scope, createdAt: '2026-09-01T00:00:00.000Z' }), 'time_invalid');
    });

    test('exact retries before and after later work append no history', () => {
        const initial = plan(), assignment = command(initial), assigned = applyImprovementActionCommand(initial, assignment, context);
        expect(applyImprovementActionCommand(assigned, assignment, context)).toEqual(assigned);
        const started = step(assigned, 'start', {});
        expect(applyImprovementActionCommand(started, assignment, context)).toEqual(started);
        expect(started.commands).toHaveLength(2);
    });

    test('reused operation IDs with changed payload fail without changing state', () => {
        const initial = plan(), assignment = command(initial), assigned = applyImprovementActionCommand(initial, assignment, context);
        const altered = { ...assignment, payload: { ...assignment.payload, dueDate: '2026-10-02' } };
        expectCode(() => applyImprovementActionCommand(assigned, altered, context), 'operation_conflict');
        expect(assigned.commands).toEqual([assignment]);
    });

    test.each(['tenantId', 'organisationId', 'planId', 'evaluationOutputSha256'])(
        'commands bind the exact %s', key => {
            const state = plan(), changed = command(state);
            changed[key] = key === 'evaluationOutputSha256' ? 'f'.repeat(64) : 'other';
            expectCode(() => applyImprovementActionCommand(state, changed, context), 'scope_mismatch');
        });

    test.each(['tenantId', 'organisationId', 'actorSubjectKey'])(
        'the trusted context must match %s even on retry', key => {
            const state = plan(), assignment = command(state), assigned = applyImprovementActionCommand(state, assignment, context);
            const changed = { ...context, [key]: key === 'actorSubjectKey' ? OTHER : 'other' };
            expectCode(() => applyImprovementActionCommand(assigned, assignment, changed), 'scope_mismatch');
        });

    test('owner must be explicitly eligible at assignment and start', () => {
        const state = plan();
        expectCode(() => applyImprovementActionCommand(state, command(state), { ...context, eligibleOwnerSubjectKeys: [] }), 'owner_ineligible');
        const assigned = step(state);
        expectCode(() => applyImprovementActionCommand(assigned, command(assigned, 'start', {}),
            { ...context, eligibleOwnerSubjectKeys: [] }), 'owner_ineligible');
    });

    test('stale revisions and time regression are rejected', () => {
        const state = step(plan()), stale = command(state, 'start', {});
        stale.expectedRevision = 0;
        expectCode(() => applyImprovementActionCommand(state, stale, context), 'revision_conflict');
        stale.expectedRevision = 1; stale.at = '2026-09-14T09:00:00.000Z';
        expectCode(() => applyImprovementActionCommand(state, stale, context), 'time_regression');
    });

    test('requires an actual calendar due date and an assigned action before starting', () => {
        const state = plan();
        expectCode(() => step(state, 'assign', { ownerSubjectKey: OWNER, dueDate: '2026-02-30' }), 'date_invalid');
        expectCode(() => step(state, 'start', {}), 'owner_ineligible');
        expectCode(() => step(step(state), 'complete', { note: 'Not started.', evidenceReference: 'evidence:1' }), 'transition_invalid');
    });

    test('blocked work retains a reason and can resume or complete', () => {
        const blocked = step(running(), 'block', { reason: 'Waiting on a supplier.' });
        expect(first(blocked)).toMatchObject({ status: 'blocked', blockedReason: 'Waiting on a supplier.' });
        expect(first(step(blocked, 'start', {}))).toMatchObject({ status: 'in_progress', blockedReason: null });
        expect(first(step(blocked, 'complete', { note: 'Resolved and checked.', evidenceReference: 'evidence:1' })).status).toBe('completed');
    });

    test('completed actions need reopening before reassignment or another start', () => {
        const state = completed();
        expectCode(() => step(state), 'transition_invalid');
        expectCode(() => step(state, 'start', {}), 'transition_invalid');
        expectCode(() => step(running(), 'reopen', { reason: 'Wrong lifecycle.' }), 'transition_invalid');
    });

    test('completion requires a note and opaque evidence reference without implying verification', () => {
        const state = running();
        expectCode(() => step(state, 'complete', { note: ' ', evidenceReference: 'evidence:1' }), 'note_invalid');
        expectCode(() => step(state, 'complete', { note: 'Done.', evidenceReference: 'https://secret.example/download?token=123' }), 'identifier_invalid');
        expectCode(() => step(state, 'complete', { note: 'Done.' }), 'fields_invalid');
    });

    test.each(['A'.repeat(180), '證據'.repeat(90), '😀'.repeat(90), 'Opaque:Case|/path?like#id'])(
        'completion preserves existing evidence-domain ID %s without narrower assessment rules', artefactId => {
            const state = running();
            const accepted = normaliseEvidenceSelector({ tenantId: state.tenantId,
                organisationId: state.organisationId, artefactId });
            expect(accepted.artefactId).toBe(artefactId);
            const input = command(state, 'complete', { note: 'Synthetic completion.', evidenceReference: accepted.artefactId });
            const next = applyImprovementActionCommand(state, input, context);
            expect(first(clone(next)).completion).toMatchObject({ evidenceReference: artefactId,
                evidenceVerification: 'not_verified' });
            expect(applyImprovementActionCommand(next, input, context)).toEqual(next);
        });

    test('completion applies evidence bounds while separately rejecting unsafe locations and preserving opaque identity', () => {
        const state = running();
        for (const value of ['a'.repeat(181), '\ud800', '\udc00', '\u0000', ' leading', 'trailing ']) {
            expect(() => step(state, 'complete', { note: 'Done.', evidenceReference: value })).toThrow();
        }
        for (const value of ['https://example.invalid/evidence', 'HTTP:example.invalid', 's3://bucket/key',
            'file:///tmp/evidence', 'data:text/plain,hello', 'javascript:alert(1)',
            '/tmp/evidence', '../evidence', './evidence', '..\\evidence', 'C:\\evidence', '\\\\server\\evidence']) {
            expect(normaliseEvidenceSelector({ tenantId: state.tenantId,
                organisationId: state.organisationId, artefactId: value }).artefactId).toBe(value);
            expectCode(() => step(state, 'complete', { note: 'Done.', evidenceReference: value }), 'identifier_invalid');
        }
        expect(state.commands).toHaveLength(2);
    });

    test('unknown actions, unknown fields and duplicate owner rows fail closed', () => {
        const state = plan(), unknown = command(state); unknown.actionId = 'action:missing';
        expectCode(() => applyImprovementActionCommand(state, unknown, context), 'action_not_found');
        expectCode(() => applyImprovementActionCommand(state, { ...command(state), admin: true }, context), 'fields_invalid');
        expectCode(() => applyImprovementActionCommand(state, command(state), { ...context, eligibleOwnerSubjectKeys: [OWNER, OWNER] }), 'owner_invalid');
    });

    test('JSON round trip preserves the replayed view and all returned data is frozen', () => {
        const state = completed(), view = getImprovementPlanView(state);
        expect(getImprovementPlanView(clone(state))).toEqual(view);
        expect(Object.isFrozen(state.commands[0].payload)).toBe(true);
        expect(Object.isFrozen(view.actions[0].completion)).toBe(true);
        expect(() => { view.actions[0].status = 'open'; }).toThrow(TypeError);
    });

    test('malformed or duplicated command history cannot alter the replayed view', () => {
        const duplicate = clone(running()); duplicate.commands.push(clone(duplicate.commands[0]));
        expectCode(() => getImprovementPlanView(duplicate), 'history_invalid');
        const reversed = clone(running()); reversed.commands.reverse();
        expectCode(() => getImprovementPlanView(reversed), 'revision_conflict');
        const modified = clone(plan()); modified.proposals[0].kind = 'evidence';
        expectCode(() => getImprovementPlanView(modified), 'proposal_invalid');
    });

    test('rejects getter-bearing data without running the getter', () => {
        const getter = jest.fn(() => scope.tenantId), input = { ...scope };
        Object.defineProperty(input, 'tenantId', { enumerable: true, get: getter });
        expectCode(() => plan(undefined, input), 'plain_data_required');
        expect(getter).not.toHaveBeenCalled();
    });

    test('a Unicode history append fails atomically before the replay byte envelope is exceeded', () => {
        const input = clone(fixture.input), wideScope = { ...scope,
            tenantId: 't'.repeat(120), organisationId: 'o'.repeat(120), planId: 'p'.repeat(120) };
        input.organisationId = wideScope.organisationId;
        const state = clone(plan(input, wideScope));
        const wideContext = { ...context, tenantId: state.tenantId, organisationId: state.organisationId };
        let bytes = Buffer.byteLength(JSON.stringify(state)), exceeding;
        for (let index = 0; index < 1024; index += 1) {
            const next = index === 0 ? command(state) : command(state,
                index % 2 ? 'start' : 'block', index % 2 ? {} : { reason: '測'.repeat(1000) });
            next.operationId = 'op' + String(index).padStart(118, '0');
            const added = Buffer.byteLength(JSON.stringify(next)) + (index ? 1 : 0);
            if (bytes + added > 2 * 1024 * 1024) { exceeding = next; break; }
            state.commands.push(next); bytes += added;
        }
        expect(exceeding).toBeDefined();
        expect(Buffer.byteLength(JSON.stringify(state))).toBe(bytes);
        const before = getImprovementPlanView(state);
        expectCode(() => applyImprovementActionCommand(state, exceeding, wideContext), 'plain_data_required');
        expect(getImprovementPlanView(state)).toEqual(before);
        expect(state.commands).toHaveLength(before.revision);
    });
});
