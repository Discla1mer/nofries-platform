'use strict';

const assert = require('node:assert/strict');
const test = global.test || require('node:test');
const { AssessmentDomainError } = require('../api/shared/assessmentLifecycle/assessmentDomain');
const { REFERENCE_LIMITS, createInMemoryAssessmentRepository,
    createAssessmentLifecycleService } = require('../api/shared/assessmentLifecycle/assessmentRepository');
const { transitionTenant } = require('../api/shared/appLifecycle/tenantDomain');
const { OTHER_ACTOR, LATER, SCOPE, clone, fixture, tenant, creation, command, response } = require('./fixtures/assessmentLifecycle');

function setup() {
    const f = fixture();
    const repository = createInMemoryAssessmentRepository({ registry: f.registry });
    return { ...f, repository, service: createAssessmentLifecycleService({ repository }) };
}
function rejected(promise, code, statusCode) {
    return assert.rejects(promise, error => error instanceof AssessmentDomainError && error.code === `assessment_${code}` &&
        (!statusCode || error.statusCode === statusCode));
}

test('repository/service create, save and read resume durable-shaped immutable state', async () => {
    const f = setup(), initial = await f.service.execute(f.aggregate, creation(f.profile));
    assert.equal(initial.replayed, false);
    const saved = await f.service.execute(f.aggregate, command(initial.state, 'save', { responses: [response()] }));
    assert.deepEqual(await f.service.read(f.aggregate, SCOPE), saved.state);
    assert.equal(saved.state.revision, 1);
    assert.ok(Object.isFrozen(saved));
    assert.ok(Object.isFrozen(saved.state.responses[0].profileRef));
});

test('identical concurrent create retries converge to one original receipt', async () => {
    const f = setup(), input = creation(f.profile);
    const results = await Promise.all(Array.from({ length: 10 }, () => f.service.execute(f.aggregate, clone(input))));
    assert.equal(results.filter(row => !row.replayed).length, 1);
    results.forEach(row => assert.deepEqual(row.state, results[0].state));
    assert.equal((await f.service.read(f.aggregate, SCOPE)).revision, 0);
});

test('concurrent different create commands cannot replace an existing assessment', async () => {
    const f = setup(), first = creation(f.profile), second = creation(f.profile, { idempotencyKey: 'second-create' });
    const results = await Promise.allSettled([f.service.execute(f.aggregate, first), f.service.execute(f.aggregate, second)]);
    assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
    assert.equal(results.find(row => row.status === 'rejected').reason.code, 'assessment_already_exists');
});

test('optimistic concurrency accepts only one competing edit at a revision', async () => {
    const f = setup(), { state } = await f.service.execute(f.aggregate, creation(f.profile));
    const first = command(state, 'save', { responses: [response()] });
    const second = command(state, 'save', { responses: [response('SYN-Q-02', 'unknown')] }, { idempotencyKey: 'other-edit' });
    const results = await Promise.allSettled([f.service.execute(f.aggregate, first), f.service.execute(f.aggregate, second)]);
    assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
    assert.equal(results.find(row => row.status === 'rejected').reason.code, 'assessment_revision_conflict');
    const current = await f.service.read(f.aggregate, SCOPE);
    assert.equal(current.revision, 1);
    assert.equal(current.responses.length, 1);
    // Conflict published no receipt; an explicit reload and fresh command can save safely.
    const resolved = await f.service.execute(f.aggregate, { ...second, expectedRevision: current.revision });
    assert.equal(resolved.state.responses.length, 2);
});

test('identical concurrent submits increment the revision only once', async () => {
    const f = setup(), { state } = await f.service.execute(f.aggregate, creation(f.profile));
    const saved = await f.service.execute(f.aggregate, command(state, 'save', { responses: f.profile.questions.map(row => response(row.id)) }));
    const submit = command(saved.state, 'submit');
    const results = await Promise.all(Array.from({ length: 5 }, () => f.service.execute(f.aggregate, submit)));
    assert.equal(results.filter(row => !row.replayed).length, 1);
    assert.equal((await f.service.read(f.aggregate, SCOPE)).revision, 2);
    assert.ok(results.every(row => row.state.submission.responseSetSha256 === results[0].state.submission.responseSetSha256));
});

test('same operation after lost response returns original snapshot despite subsequent edits', async () => {
    const f = setup(), create = creation(f.profile), initial = await f.service.execute(f.aggregate, create);
    const save = command(initial.state, 'save', { responses: [response()] });
    const original = await f.service.execute(f.aggregate, save);
    await f.service.execute(f.aggregate, command(original.state, 'save', { responses: [response('SYN-Q-02')] }));
    const retry = await f.service.execute(f.aggregate, { ...save, now: '2026-09-06T02:00:00.000Z' });
    assert.equal(retry.replayed, true);
    assert.deepEqual(retry.state, original.state);
    assert.equal(retry.commandSha256, original.commandSha256);
    assert.equal(retry.state.revision, 1);
    assert.equal((await f.service.read(f.aggregate, SCOPE)).revision, 2);
    assert.deepEqual((await f.service.execute(f.aggregate, create)).state, initial.state);
});

test('payload order is canonical, while changed answer, actor, action or expected revision conflicts', async () => {
    const f = setup(), { state } = await f.service.execute(f.aggregate, creation(f.profile));
    const save = command(state, 'save', { responses: [response(), response('SYN-Q-02')] });
    const saved = await f.service.execute(f.aggregate, save);
    const reordered = clone(save);
    reordered.payload.responses.reverse();
    assert.equal((await f.service.execute(f.aggregate, reordered)).replayed, true);
    const changes = [
        { ...save, payload: { responses: [response('SYN-Q-01', 'not_met')] } },
        { ...save, actorSubjectKey: OTHER_ACTOR },
        { ...save, action: 'start', payload: {} },
        { ...save, expectedRevision: 1 }
    ];
    for (const changed of changes) await rejected(f.service.execute(f.aggregate, changed), 'idempotency_conflict', 409);
    assert.deepEqual(await f.service.read(f.aggregate, SCOPE), saved.state);
});

test('failed validation commits neither state nor receipt, allowing corrected retry', async () => {
    const f = setup(), { state } = await f.service.execute(f.aggregate, creation(f.profile));
    const input = command(state, 'save', { responses: [response(), response('unknown')] });
    await rejected(f.service.execute(f.aggregate, input), 'question_unknown');
    assert.deepEqual(await f.service.read(f.aggregate, SCOPE), state);
    input.payload.responses = [response()];
    const success = await f.service.execute(f.aggregate, input);
    assert.equal(success.replayed, false);
    assert.equal(success.state.revision, 1);
});

test('failed create leaves assessment and idempotency key available for a corrected operation', async () => {
    const f = setup(), input = creation(f.profile);
    input.payload.profileRef.catalogueSha256 = '0'.repeat(64);
    await rejected(f.service.execute(f.aggregate, input), 'profile_mismatch', 409);
    await rejected(f.service.read(f.aggregate, SCOPE), 'not_found', 404);
    assert.equal((await f.service.execute(f.aggregate, creation(f.profile))).state.revision, 0);
});

test('tenant, organisation and assessment isolation apply to reads, writes and receipts', async () => {
    const f = setup(), { state } = await f.service.execute(f.aggregate, creation(f.profile));
    for (const [field, value] of [['tenantId', 'tenant-b'], ['organisationId', 'org-b'], ['assessmentId', 'assessment-b']]) {
        const aggregate = field === 'tenantId' ? tenant('tenant-b') : f.aggregate;
        await rejected(f.service.read(aggregate, { ...SCOPE, [field]: value }), 'not_found', 404);
        await rejected(f.service.execute(aggregate, command(state, 'start', {}, { [field]: value })), 'not_found', 404);
        const isolated = await f.service.execute(aggregate, creation(f.profile, { [field]: value }));
        assert.equal(isolated.replayed, false);
        assert.equal(isolated.state[field], value);
    }
    assert.deepEqual(await f.service.read(f.aggregate, SCOPE), state);
    await rejected(f.service.read(tenant('tenant-b'), SCOPE), 'not_found', 404);
});

test('tuple keys cannot confuse IDs containing separators', async () => {
    const f = setup();
    const a = await f.service.execute(f.aggregate, creation(f.profile, { assessmentId: 'assessment-a:org-b' }));
    const b = await f.service.execute(f.aggregate, creation(f.profile, { organisationId: 'org-b', assessmentId: 'assessment-a' }));
    assert.equal(a.replayed, false);
    assert.equal(b.replayed, false);
    assert.notEqual(a.commandSha256, b.commandSha256);
});

test('current inactive organisation is checked before serving a mutation receipt', async () => {
    const f = setup(), input = creation(f.profile);
    await f.service.execute(f.aggregate, input);
    const suspended = clone(f.aggregate);
    suspended.tenant = transitionTenant(suspended.tenant, { expectedRevision: 0, toStatus: 'suspended' });
    await rejected(f.service.execute(suspended, input), 'organisation_inactive', 409);
    assert.equal((await f.service.read(suspended, SCOPE)).status, 'created');
});

test('response and command object mutation cannot affect state or retry fingerprints', async () => {
    const f = setup(), { state } = await f.service.execute(f.aggregate, creation(f.profile));
    const save = command(state, 'save', { responses: [response()] }), original = clone(save);
    const pending = f.service.execute(f.aggregate, save);
    save.payload.responses[0].optionId = 'not_met';
    const saved = await pending;
    assert.equal(saved.state.responses[0].optionId, 'met');
    assert.throws(() => { saved.state.responses[0].optionId = 'not_met'; }, TypeError);
    assert.equal((await f.service.execute(f.aggregate, original)).replayed, true);
});

test('receipt capacity rejects new commands without losing the last state or earlier receipts', async () => {
    const f = setup(), create = creation(f.profile), initial = await f.service.execute(f.aggregate, create);
    let state = initial.state;
    for (let i = 1; i < REFERENCE_LIMITS.receiptsPerAssessment; i += 1) {
        state = (await f.service.execute(f.aggregate, command(state, 'save', { responses: [response()] }))).state;
    }
    await rejected(f.service.execute(f.aggregate, command(state, 'archive')), 'reference_capacity_reached', 503);
    assert.deepEqual(await f.service.read(f.aggregate, SCOPE), state);
    assert.deepEqual((await f.service.execute(f.aggregate, create)).state, initial.state);
});

test('reference repository is explicitly ephemeral with no fallback persistence', async () => {
    const f = setup();
    await f.service.execute(f.aggregate, creation(f.profile));
    const restarted = createInMemoryAssessmentRepository({ registry: f.registry });
    await rejected(restarted.read(f.aggregate, SCOPE), 'not_found', 404);
    assert.throws(() => createAssessmentLifecycleService({ repository: {} }), AssessmentDomainError);
    assert.throws(() => createInMemoryAssessmentRepository(), AssessmentDomainError);
});
