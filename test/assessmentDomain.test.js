'use strict';

const assert = require('node:assert/strict');
const test = global.test || require('node:test');
const { AssessmentDomainError, STATUSES, createAssessment, normaliseAssessmentState,
    applyAssessmentCommand, getAssessmentProgress } = require('../api/shared/assessmentLifecycle/assessmentDomain');
const { calculateFrameworkProfileSha256, createFrameworkRegistry } = require('../api/shared/assessmentEngine/frameworkProfileRegistry');
const { getDefaultFrameworkRegistry, createNcscFrameworkProfile } = require('../api/shared/assessmentEngine/ncscFrameworkProfile');
const { evaluateAssessment, calculateEvidenceSnapshotSha256, calculateRiskContextSnapshotSha256 } = require('../api/shared/assessmentEngine/assessmentEvaluator');
const { transitionTenant, transitionOrganisation } = require('../api/shared/appLifecycle/tenantDomain');
const { ACTOR, OTHER_ACTOR, NOW, LATER, SCOPE, clone, fixture, creation, command, response, created, act, answered } = require('./fixtures/assessmentLifecycle');

function rejects(fn, code, statusCode) {
    assert.throws(fn, error => error instanceof AssessmentDomainError && error.code === `assessment_${code}` &&
        (!statusCode || error.statusCode === statusCode));
}

test('creates a frozen assessment with an exact profile, scope and no invented answers', () => {
    const f = fixture(), state = created(f);
    assert.equal(state.status, 'created');
    assert.equal(state.revision, 0);
    assert.deepEqual(state.responses, []);
    assert.equal(state.profileRef.catalogueSha256, f.profile.catalogueSha256);
    assert.ok(Object.isFrozen(state.profileRef));
    assert.deepEqual(getAssessmentProgress(state, f.registry), { total: 4, answered: 0, missing: 4, unknown: 0, notApplicableClaims: 0 });
});

test('start, save, submit, review and archive preserve one sealed response set', () => {
    const f = fixture(), initial = created(f), started = act(f, initial, 'start');
    const draft = answered(f, started), submitted = act(f, draft, 'submit');
    const reviewed = act(f, submitted, 'review', {}, { actorSubjectKey: OTHER_ACTOR });
    const archived = act(f, reviewed, 'archive');
    assert.deepEqual([initial.status, started.status, submitted.status, reviewed.status, archived.status], STATUSES);
    assert.equal(archived.revision, 5);
    assert.equal(archived.archive.previousStatus, 'reviewed');
    assert.deepEqual(submitted.responses, draft.responses);
    assert.deepEqual(reviewed.responses, draft.responses);
    assert.deepEqual(archived.submission, submitted.submission);
    assert.equal(reviewed.review.reviewedBy, OTHER_ACTOR);
    assert.equal(reviewed.responses[0].updatedBy, ACTOR);
});

test('partial saves resume without dropping other answers and clear restores missing', () => {
    const f = fixture();
    const a = act(f, created(f), 'save', { responses: [response()] });
    const b = act(f, a, 'save', { responses: [response('SYN-Q-02', 'unknown')] });
    assert.equal(b.responses.length, 2);
    assert.deepEqual(b.responses[0], a.responses[0]);
    assert.deepEqual(b.responses[1].profileRef, b.profileRef);
    assert.deepEqual(getAssessmentProgress(b, f.registry), { total: 4, answered: 2, missing: 2, unknown: 1, notApplicableClaims: 0 });
    const c = act(f, b, 'save', { responses: [response('SYN-Q-01', null)] });
    assert.equal(c.responses.length, 1);
    assert.equal(getAssessmentProgress(c, f.registry).missing, 3);
    rejects(() => act(f, c, 'submit'), 'responses_incomplete', 409);
});

test('explicit unknown and N/A answers do not invent attainment or applicability approval', () => {
    const f = fixture(), draft = act(f, created(f), 'save', { responses: f.profile.questions.map((row, i) =>
        response(row.id, i === 0 ? 'not_applicable' : 'unknown', i === 0 ? 'b'.repeat(64) : null)) });
    const submitted = act(f, draft, 'submit'), reviewed = act(f, submitted, 'review');
    assert.deepEqual(getAssessmentProgress(reviewed, f.registry), { total: 4, answered: 4, missing: 0, unknown: 3, notApplicableClaims: 1 });
    assert.equal(Object.hasOwn(reviewed, 'score'), false);
    assert.equal(Object.hasOwn(reviewed.responses[0], 'applicabilityDecision'), false);
    assert.deepEqual(reviewed.responses, submitted.responses);
});

test('N/A requires the evaluator rationale digest before saving an answer that can be sealed', () => {
    const f = fixture(), draft = answered(f);
    rejects(() => act(f, draft, 'save', { responses: [response('SYN-Q-01', 'not_applicable')] }),
        'not_applicable_rationale_required');
    const saved = act(f, draft, 'save', { responses: [response('SYN-Q-01', 'not_applicable', 'b'.repeat(64))] });
    const invalid = clone(saved);
    invalid.responses[0].applicabilityRationaleSha256 = null;
    rejects(() => normaliseAssessmentState(invalid, f.registry), 'not_applicable_rationale_required');
    assert.equal(act(f, saved, 'submit').status, 'submitted');
});

for (const status of ['created', 'in-progress', 'submitted', 'reviewed']) {
    test(`archive from ${status} preserves history and is terminal`, () => {
        const f = fixture();
        let state = created(f);
        if (status !== 'created') state = answered(f, state);
        if (['submitted', 'reviewed'].includes(status)) state = act(f, state, 'submit');
        if (status === 'reviewed') state = act(f, state, 'review');
        const archive = act(f, state, 'archive');
        assert.equal(archive.archive.previousStatus, status);
        assert.deepEqual(archive.responses, state.responses);
        for (const action of ['start', 'submit', 'review', 'archive']) {
            rejects(() => act(f, archive, action), 'transition_not_allowed', 409);
        }
        rejects(() => act(f, archive, 'save', { responses: [response()] }), 'responses_sealed', 409);
    });
}

test('archived in-progress state requires a preceding mutation even with no saved responses', () => {
    const f = fixture(), started = act(f, created(f), 'start'), archived = act(f, started, 'archive');
    assert.equal(archived.revision, 2);
    assert.deepEqual(normaliseAssessmentState(clone(archived), f.registry), archived);
    const invalid = clone(archived);
    invalid.revision = 1;
    invalid.archive.revision = 1;
    rejects(() => normaliseAssessmentState(invalid, f.registry), 'history_invalid');
});

test('archival cannot share a revision with a saved response mutation', () => {
    const f = fixture(), archived = act(f, answered(f), 'archive');
    assert.equal(archived.revision, 2);
    assert.deepEqual(normaliseAssessmentState(clone(archived), f.registry), archived);
    const invalid = clone(archived);
    invalid.responses[0].updatedRevision = invalid.archive.revision;
    rejects(() => normaliseAssessmentState(invalid, f.registry), 'history_invalid');
});

test('created cannot skip to submission or review; submitted/reviewed answers cannot change', () => {
    const f = fixture(), state = created(f);
    rejects(() => act(f, state, 'submit'), 'transition_not_allowed', 409);
    rejects(() => act(f, state, 'review'), 'transition_not_allowed', 409);
    const submitted = act(f, answered(f), 'submit');
    rejects(() => act(f, submitted, 'save', { responses: [response()] }), 'responses_sealed', 409);
    rejects(() => act(f, act(f, submitted, 'review'), 'save', { responses: [response()] }), 'responses_sealed', 409);
});

for (const field of ['tenantId', 'organisationId', 'assessmentId']) {
    test(`commands reject wrong ${field} with not-found and preserve original state`, () => {
        const f = fixture(), state = answered(f), before = JSON.stringify(state);
        rejects(() => act(f, state, 'submit', {}, { [field]: 'other' }), 'not_found', 404);
        assert.equal(JSON.stringify(state), before);
    });
}

test('suspended tenant/organisation blocks editing but allows historical archive', () => {
    for (const field of ['tenant', 'organisation']) {
        const f = fixture(), state = answered(f), aggregate = clone(f.aggregate);
        if (field === 'tenant') aggregate.tenant = transitionTenant(aggregate.tenant, { expectedRevision: 0, toStatus: 'suspended' });
        else aggregate.organisations[0] = transitionOrganisation(aggregate.organisations[0], { expectedRevision: 0, toStatus: 'suspended' });
        rejects(() => createAssessment(aggregate, creation(f.profile), f.registry), 'organisation_inactive', 409);
        rejects(() => applyAssessmentCommand(state, aggregate, command(state, 'submit'), f.registry), 'organisation_inactive', 409);
        assert.equal(applyAssessmentCommand(state, aggregate, command(state, 'archive'), f.registry).status, 'archived');
    }
});

test('revision conflict and time regression reject without mutating inputs', () => {
    const f = fixture(), state = answered(f), before = JSON.stringify(state);
    rejects(() => act(f, state, 'submit', {}, { expectedRevision: 0 }), 'revision_conflict', 409);
    rejects(() => act(f, state, 'submit', {}, { now: NOW }), 'time_regression', 409);
    const max = { ...state, revision: Number.MAX_SAFE_INTEGER };
    rejects(() => act(f, max, 'submit'), 'revision_exhausted', 409);
    assert.equal(JSON.stringify(state), before);
});

test('failed patch applies no earlier valid answer, duplicate or unrecognised IDs', () => {
    const f = fixture(), state = created(f), before = JSON.stringify(state);
    rejects(() => act(f, state, 'save', { responses: [response(), response('unknown-question')] }), 'question_unknown');
    rejects(() => act(f, state, 'save', { responses: [response(), response()] }), 'response_duplicate');
    rejects(() => act(f, state, 'save', { responses: [response('SYN-Q-01', 'made-up')] }), 'response_option_invalid');
    rejects(() => act(f, state, 'save', { responses: [response('SYN-Q-01', 'met', 'a'.repeat(64))] }), 'rationale_invalid');
    rejects(() => act(f, state, 'save', { responses: [response('SYN-Q-01', null, 'a'.repeat(64))] }), 'rationale_invalid');
    assert.equal(JSON.stringify(state), before);
});

test('each question enforces its own allowed response option set', () => {
    const f = fixture();
    f.profile.questions[0].responseOptionIds = f.profile.questions[0].responseOptionIds.filter(id => id !== 'not_applicable');
    f.profile.catalogueSha256 = calculateFrameworkProfileSha256(f.profile);
    f.registry = createFrameworkRegistry([f.profile]);
    rejects(() => act(f, created(f), 'save', { responses: [response('SYN-Q-01', 'not_applicable')] }), 'response_option_invalid');
});

test('new profile versions cannot move existing answers and same-version replacement fails closed', () => {
    const f = fixture(), state = answered(f), next = clone(f.profile);
    next.profile.version = '2.0.0';
    next.questions[0].weight += 1;
    next.catalogueSha256 = calculateFrameworkProfileSha256(next);
    const registry = createFrameworkRegistry([f.profile, next]);
    assert.deepEqual(normaliseAssessmentState(state, registry), state);
    const replaced = clone(next);
    replaced.profile.version = f.profile.profile.version;
    replaced.catalogueSha256 = calculateFrameworkProfileSha256(replaced);
    rejects(() => normaliseAssessmentState(state, createFrameworkRegistry([replaced])), 'profile_mismatch', 409);
    rejects(() => normaliseAssessmentState(state, createFrameworkRegistry([next])), 'profile_unavailable', 409);
});

test('profile identity, digest and source catalogue identity are immutable including rehydration', () => {
    const f = fixture(), state = answered(f);
    for (const key of ['profileVersion', 'frameworkVersion', 'profileId', 'frameworkId', 'catalogueSha256']) {
        const invalid = clone(state);
        invalid.profileRef[key] = key === 'catalogueSha256' ? 'f'.repeat(64) : 'different';
        rejects(() => normaliseAssessmentState(invalid, f.registry), key === 'profileVersion' || key === 'profileId'
            ? 'profile_unavailable' : 'profile_mismatch', 409);
    }
    const invalidResponse = clone(state);
    invalidResponse.responses[0].profileRef.profileVersion = '2.0.0';
    rejects(() => normaliseAssessmentState(invalidResponse, f.registry), 'response_profile_mismatch', 409);
    const ncsc = createNcscFrameworkProfile(), registry = getDefaultFrameworkRegistry();
    const ncscState = createAssessment(f.aggregate, creation(ncsc), registry);
    assert.equal(ncscState.profileRef.sourceCatalogueSha256, ncsc.sourceCatalogueSha256);
    const missing = clone(ncscState);
    delete missing.profileRef.sourceCatalogueSha256;
    rejects(() => normaliseAssessmentState(missing, registry), 'profile_mismatch', 409);
});

test('submitted response tampering and forged lifecycle metadata fail rehydration', () => {
    const f = fixture(), submitted = act(f, answered(f), 'submit');
    const changed = clone(submitted);
    changed.responses[0].optionId = 'not_met';
    rejects(() => normaliseAssessmentState(changed, f.registry), 'submission_mismatch', 409);
    const badStamp = clone(submitted);
    badStamp.submission.revision = 1;
    rejects(() => normaliseAssessmentState(badStamp, f.registry), 'submission_mismatch', 409);
    const missing = clone(submitted);
    missing.submission = null;
    rejects(() => normaliseAssessmentState(missing, f.registry), 'history_invalid');
    const badReview = clone(act(f, submitted, 'review'));
    badReview.review.reviewedBy = OTHER_ACTOR;
    rejects(() => normaliseAssessmentState(badReview, f.registry), 'history_invalid');
});

test('commands reject extra fields, accessors, proxies, sparse arrays and implicit defaults', () => {
    const f = fixture(), state = created(f);
    for (const extra of ['score', 'profileRef', 'tenantId', 'evidence', 'applicabilityDecision']) {
        rejects(() => act(f, state, 'save', { responses: [{ ...response(), [extra]: 'untrusted' }] }), 'shape_invalid');
    }
    let invoked = false;
    const payload = { get responses() { invoked = true; return [response()]; } };
    rejects(() => act(f, state, 'save', payload), 'shape_invalid');
    assert.equal(invoked, false);
    const proxy = new Proxy({}, { getPrototypeOf() { invoked = true; throw new Error('must not run'); } });
    rejects(() => act(f, state, 'save', proxy), 'shape_invalid');
    assert.equal(invoked, false);
    rejects(() => act(f, state, 'save', { responses: Array(2) }), 'collection_invalid');
    rejects(() => act(f, state, 'save', { responses: Array.from({ length: 1025 }, () => response()) }), 'collection_invalid');
    const incomplete = clone(state);
    delete incomplete.revision;
    rejects(() => normaliseAssessmentState(incomplete, f.registry), 'shape_invalid');
});

test('invalid and future versions, unsafe revisions, actor IDs and dates are rejected', () => {
    const f = fixture();
    const latest = creation(f.profile);
    latest.payload.profileRef.profileVersion = 'latest';
    rejects(() => createAssessment(f.aggregate, latest, f.registry), 'version_invalid');
    rejects(() => createAssessment(f.aggregate, creation(f.profile, { now: '2026-09-01T00:00:00.000Z' }), f.registry), 'profile_not_yet_effective');
    for (const expectedRevision of [-1, -0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        rejects(() => act(f, created(f), 'start', {}, { expectedRevision }), 'revision_invalid');
    }
    rejects(() => act(f, created(f), 'start', {}, { actorSubjectKey: 'email@example.invalid' }), 'subject_invalid');
    rejects(() => act(f, created(f), 'start', {}, { now: '2026-02-30T00:00:00.000Z' }), 'time_invalid');
});

test('input mutations cannot alter retained profile or response data and returned nested rows freeze', () => {
    const f = fixture(), state = created(f), input = command(state, 'save', { responses: [response()] });
    const saved = applyAssessmentCommand(state, f.aggregate, input, f.registry);
    input.payload.responses[0].optionId = 'not_met';
    assert.equal(saved.responses[0].optionId, 'met');
    assert.ok(Object.isFrozen(saved.responses[0]));
    assert.ok(Object.isFrozen(saved.responses[0].profileRef));
    assert.throws(() => { saved.responses[0].optionId = 'not_met'; }, TypeError);
    assert.deepEqual(normaliseAssessmentState(clone(saved), f.registry), saved);
});

test('saved responses remain compatible with the existing evaluator without lifecycle review approving N/A', () => {
    const f = fixture(), draft = act(f, answered(f), 'save', { responses: [response('SYN-Q-01', 'not_applicable', 'b'.repeat(64))] });
    const submitted = act(f, draft, 'submit'), reviewed = act(f, submitted, 'review');
    function evaluate(state) {
        const atomInputs = state.responses.map(row => ({ itemId: row.itemId, response: { optionId: row.optionId },
            ...(row.applicabilityRationaleSha256 ? { applicabilityClaim: { rationaleSha256: row.applicabilityRationaleSha256 } } : {}),
            evidenceState: 'not_provided', statedImpact: 'unspecified', priorityOverlay: 'none' }));
        return evaluateAssessment({ schemaVersion: 1, scoreContractVersion: 'PROD-003-R1',
            organisationId: state.organisationId, moduleId: state.moduleId, assessmentId: state.assessmentId,
            assessmentRevision: `rev-${state.submission.revision}`, profileRef: state.profileRef,
            scoreAsOf: state.submission.submittedAt, scopePopulationSha256: state.scopePopulationSha256,
            evidenceSnapshot: { id: 'synthetic-evidence', sha256: calculateEvidenceSnapshotSha256(atomInputs.map(row => ({ itemId: row.itemId, evidenceState: row.evidenceState }))) },
            riskContextSnapshot: { id: 'synthetic-risk', sha256: calculateRiskContextSnapshotSha256(atomInputs.map(row => ({ itemId: row.itemId, statedImpact: row.statedImpact, priorityOverlay: row.priorityOverlay }))) },
            atomInputs }, { registry: f.registry });
    }
    const before = evaluate(submitted), after = evaluate(reviewed);
    assert.deepEqual(after, before);
    assert.equal(before.countsCompletion.approvedNotApplicableAtoms, 0);
});
