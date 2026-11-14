'use strict';
const assert = require('node:assert/strict');
const test = global.test || require('node:test');
const { selectDashboardSources: select } = require('../api/shared/assessmentLifecycle/dashboardSourceSelection');
const { makeVersion } = require('../api/shared/assessmentLifecycle/postgresNcscAssessmentStore');
const { ncscFixture, allResponses, createCommand, saveCommand, submitCommand, SUBJECT, NOW } = require('./fixtures/ncscAssessmentFixture');
const clone = value => JSON.parse(JSON.stringify(value));
function history(id = 'assessment-a', options = {}) {
    const tenant = ncscFixture(options), versions = [];
    for (const command of [createCommand(id, 'create-' + id, options.description || 'Synthetic scope.'),
        saveCommand(id, 0, 'save-' + id, allResponses()), submitCommand(id, 1, 'submit-' + id)]) {
        const version = makeVersion({ ...tenant.scope, actorSubjectKey: SUBJECT, assessmentId: id,
            action: command.action, expectedRevision: command.expectedRevision, payload: command.payload },
        command.idempotencyKey, versions.at(-1) || null, tenant.state.tenantAggregate, NOW);
        versions.push(version);
    }
    return versions.map(({ envelope, revisionSha256 }) => ({ envelope, revisionSha256 }));
}
const a = history(), b = history('assessment-b');
function ref(v) { return { assessmentId: v.envelope.assessmentId, revision: v.envelope.revision,
    revisionSha256: v.revisionSha256, scopePopulationSha256: v.envelope.state.scopePopulationSha256 }; }
function input(extra = {}) { return { tenantId: a[0].envelope.tenantId, organisationId: a[0].envelope.organisationId,
    baseline: ref(a[2]), draft: ref(b[1]), complete: true, versions: [...a, ...b], ...extra }; }
function invalid(value) { assert.throws(() => select(value), /^Error: dashboard_source_selection_invalid$/); }
test('explicit baseline and draft remain separate regardless of input ordering', () => {
    const selected = select(input());
    assert.deepEqual(selected, select(input({ versions: [...b, ...a].reverse() })));
    assert.equal(selected.baseline.source.assessmentId, 'assessment-a');
    assert.equal(selected.baseline.source.status, 'submitted');
    assert.equal(selected.draft.source.status, 'in-progress');
    assert.equal(selected.draft.source.evaluationSha256, null);
    assert.equal(selected.baseline.source.evaluationSha256, a[2].envelope.submission.evaluation.outputSha256);
    assert.equal(selected.baseline.source.savedAt, NOW);
    assert.equal(selected.scopeRelation, 'not_established');
});
test('equal descriptions never establish cross-assessment scope equivalence', () => {
    assert.equal(a[2].envelope.scopePopulation.body.description, b[1].envelope.scopePopulation.body.description);
    assert.notEqual(ref(a[2]).scopePopulationSha256, ref(b[1]).scopePopulationSha256);
    assert.equal(select(input()).scopeRelation, 'not_established');
});
test('exact historical versions can reproduce prior source selections', () => {
    const value = select(input({ draft: ref(a[0]) }));
    assert.equal(value.draft.source.revision, 0);
    assert.equal(value.draft.source.status, 'created');
    assert.equal(value.scopeRelation, 'same_assessment');
    assert.equal(value.baseline.source.revision, 2);
});
test('unselected stays unselected rather than choosing the first record', () => {
    const value = select(input({ baseline: null, draft: null }));
    assert.deepEqual(value.baseline, { status: 'unselected', source: null });
    assert.deepEqual(value.draft, value.baseline);
    assert.equal(value.scopeRelation, 'unavailable');
});
test('missing exact revisions distinguish incomplete loading from complete absence', () => {
    const partial = select(input({ versions: [], complete: false }));
    assert.equal(partial.coverage, 'partial');
    assert.equal(partial.baseline.status, 'not_loaded');
    assert.equal(partial.draft.status, 'not_loaded');
    assert.equal(select(input({ versions: [] })).baseline.status, 'not_found');
    assert.equal(select(input({ versions: [a[0], b[1]] })).baseline.status, 'not_found');
});
test('loaded explicit selections remain usable without a false complete claim', () => {
    const value = select(input({ complete: false }));
    assert.equal(value.coverage, 'partial');
    assert.equal(value.baseline.status, 'selected');
});
test('baseline cannot be draft and submitted source cannot become draft progress', () => {
    invalid(input({ baseline: ref(a[1]) })); invalid(input({ draft: ref(b[2]) }));
});
test('exact selected revision and scope hashes are required', () => {
    invalid(input({ baseline: { ...ref(a[2]), revisionSha256: 'a'.repeat(64) } }));
    invalid(input({ baseline: { ...ref(a[2]), scopePopulationSha256: ref(b[2]).scopePopulationSha256 } }));
});
test('cross-organisation and cross-tenant inputs return no partial selection', () => {
    for (const extra of [{ organisationId: 'other-org' }, { tenantId: 'other-tenant' }]) {
        invalid(input({ versions: [...a, ...history('assessment-other', extra)] }));
    }
});
test('corruption in even an unselected source rejects the complete batch', () => {
    const corrupted = clone(b[0]); corrupted.envelope.scopePopulation.body.description = 'Changed';
    invalid(input({ versions: [...a, corrupted] }));
    invalid(input({ versions: [...a, { ...b[0], revisionSha256: '0'.repeat(64) }] }));
});
test('identical duplicate sources are idempotent', () => {
    assert.deepEqual(select(input()), select(input({ versions: [...a, ...b, clone(a[2])] })));
});
test('malformed and oversized selection requests fail closed', () => {
    for (const extra of [{ complete: null }, { versions: null }, { versions: Array(101).fill(a[0]) },
        { tenantId: '' }, { organisationId: '' }, { baseline: {} }, { draft: { ...ref(b[1]), revision: -1 } }]) invalid(input(extra));
    invalid({ ...input(), inventedObservationTime: NOW });
});
test('output is frozen and detached from mutable supplied records', () => {
    const source = clone(input()), result = select(source);
    assert.ok(Object.isFrozen(result.baseline.source.profileRef));
    assert.ok(Object.isFrozen(result.draft.source.progress));
    source.versions[2].envelope.state.profileRef.profileVersion = 'changed';
    assert.equal(result.baseline.source.profileRef.profileVersion, a[2].envelope.state.profileRef.profileVersion);
});
test('conflicting histories for one assessment cannot establish immutable scope', () => {
    const other = history('assessment-a', { description: 'Different synthetic population.' });
    invalid(input({ versions: [a[2], other[0]] }));
    invalid(input({ versions: [a[2], other[2]] }));
});
