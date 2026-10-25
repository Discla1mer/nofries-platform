'use strict';

const { randomUUID } = require('node:crypto');
const { NcscAssessmentError, normaliseNcscCommand, normaliseNcscPage, normaliseNcscSelector,
    requireNcscContext, projectNcscSummary, projectNcscDetail,
    createNcscAssessmentService } = require('../api/shared/ncscAssessmentService');
const { createTenantRequestContext } = require('../api/shared/appLifecycle/tenantRequestContext');
const { createTenantAggregate } = require('../api/shared/appLifecycle/tenantDomain');
const { createAssessment, applyAssessmentCommand } = require('../api/shared/assessmentLifecycle/assessmentDomain');
const { acceptedRegistry, acceptedProfile } = require('../api/shared/assessmentLifecycle/ncscAssessmentSubmission');
const { MODULE_ID, ACCEPTED_PROFILE_REF, evaluateAcceptedNcscAssessment } = require('../api/shared/assessmentEngine/ncscAssessmentEvaluator');
const { SUBJECT, NOW } = require('./fixtures/dashboardFixture');
const evaluationFixture = require('./fixtures/ncscAcceptedEvaluation.json');

const copy = value => JSON.parse(JSON.stringify(value));
const scope = { tenantId: 'synthetic-tenant', organisationId: 'synthetic-org' };
const firstId = acceptedProfile.questions[0].id;
const createCommand = () => ({ assessmentId: 'assessment-1', action: 'create', idempotencyKey: 'create-1',
    expectedRevision: null, payload: { scopePopulation: { description: '  Synthetic population\nwith unchanged text.  ' } } });
const saveCommand = (responses = [{ itemId: firstId, optionId: 'yes', rationale: null }]) => ({
    assessmentId: 'assessment-1', action: 'save', idempotencyKey: 'save-1', expectedRevision: 0, payload: { responses } });
function contextResolver(selected = scope) {
    return createTenantRequestContext({ authenticate: async () => ({ authenticated: true, subjectKey: SUBJECT }),
        resolveScope: async () => selected, clock: () => NOW, createRequestId: randomUUID });
}
function harness(requestContext = contextResolver()) {
    const repository = { listNcscAssessments: jest.fn(async () => ({ schemaVersion: 1, assessments: [], nextAfterAssessmentId: null })),
        readNcscAssessment: jest.fn(async () => ({ schemaVersion: 1, assessment: null })),
        executeNcscAssessment: jest.fn(async () => ({ schemaVersion: 1, action: 'create', assessment: null })) };
    return { repository, requestContext, service: createNcscAssessmentService({ repository, requestContext }) };
}
function expectCode(action, code = 'ncsc_input_invalid') {
    expect(action).toThrow(NcscAssessmentError);
    try { action(); } catch (error) { expect(error.code).toBe(code); }
}

test('normalizers detach immutable, exact caller intent and preserve declaration/rationale text', () => {
    const source = createCommand(), value = normaliseNcscCommand(source);
    expect(value).toEqual(source);
    expect(Object.isFrozen(value.payload.scopePopulation)).toBe(true);
    source.payload.scopePopulation.description = 'changed';
    expect(value.payload.scopePopulation.description).toBe('  Synthetic population\nwith unchanged text.  ');
    const responses = [{ itemId: firstId, optionId: 'not_applicable', rationale: { text: '  Pending declaration.\n  ' } },
        { itemId: acceptedProfile.questions[1].id, optionId: null, rationale: null }];
    const saved = normaliseNcscCommand(saveCommand(responses.reverse()));
    expect(saved.payload.responses.map(item => item.itemId)).toEqual(responses.map(item => item.itemId).sort());
    expect(saved.payload.responses.find(item => item.optionId === 'not_applicable').rationale.text).toBe('  Pending declaration.\n  ');
    expect(Object.isFrozen(saved.payload.responses[0])).toBe(true);
    expect(normaliseNcscCommand({ ...saveCommand(), action: 'submit', payload: {} }).payload).toEqual({});
});

test('accepted profile question count, options and rationale semantics are enforced', () => {
    const rows = acceptedProfile.questions.map(item => ({ itemId: item.id, optionId: 'unknown', rationale: null }));
    expect(normaliseNcscCommand(saveCommand(rows)).payload.responses).toHaveLength(14);
    for (const responses of [[], [...rows, rows[0]], [rows[0], rows[0]],
        [{ itemId: 'foreign-question', optionId: 'yes', rationale: null }],
        [{ itemId: firstId, optionId: 'approved', rationale: null }],
        [{ itemId: firstId, optionId: 'not_applicable', rationale: null }],
        [{ itemId: firstId, optionId: null, rationale: { text: 'must not retain' } }],
        [{ itemId: firstId, optionId: 'yes', rationale: { text: 'forbidden' } }],
        [{ itemId: firstId, optionId: 'not_applicable', rationale: { text: ' ', approved: true } }]]) {
        expectCode(() => normaliseNcscCommand(saveCommand(responses)));
    }
});

test('all command envelopes and nested payloads are closed, including privileged fields', () => {
    for (const key of ['tenantId', 'organisationId', 'actorSubjectKey', 'now', 'profileRef', 'grant', 'quota', 'audit', 'receipt']) {
        expectCode(() => normaliseNcscCommand({ ...createCommand(), [key]: 'untrusted' }));
    }
    for (const command of [{ ...createCommand(), action: 'archive' }, { ...createCommand(), expectedRevision: 0 },
        { ...saveCommand(), expectedRevision: null }, { ...saveCommand(), expectedRevision: -0 },
        { ...saveCommand(), expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
        { ...saveCommand(), action: 'submit', payload: { approval: true } },
        { ...createCommand(), payload: { scopePopulation: { description: 'text', sha256: 'a'.repeat(64) } } }]) {
        expectCode(() => normaliseNcscCommand(command));
    }
    for (const key of Object.keys(createCommand())) {
        const command = createCommand(); delete command[key];
        expectCode(() => normaliseNcscCommand(command));
    }
});

test('exact identifier, character and UTF-8 JSON byte bounds reject rather than normalize', () => {
    const source = createCommand();
    source.assessmentId = 'A'.repeat(120); source.idempotencyKey = '0:a_b.c-D';
    source.payload.scopePopulation.description = 'x'.repeat(4000);
    expect(normaliseNcscCommand(source).assessmentId).toHaveLength(120);
    for (const id of ['A'.repeat(121), ' leading', 'trailing ', 'unicode-é', '*', '', 'id/path', 'id\n']) {
        expectCode(() => normaliseNcscCommand({ ...source, assessmentId: id }));
    }
    for (const description of ['', '\n\t ', 'x'.repeat(4001)]) {
        expectCode(() => normaliseNcscCommand({ ...source, payload: { scopePopulation: { description } } }));
    }
    const rows = acceptedProfile.questions.map(item => ({ itemId: item.id, optionId: 'not_applicable',
        rationale: { text: 'x'.repeat(4000) } }));
    expect(normaliseNcscCommand(saveCommand(rows)).payload.responses).toHaveLength(14);
    let remaining = 65536 - Buffer.byteLength(JSON.stringify(saveCommand(rows)), 'utf8');
    for (const row of rows) {
        const extra = Math.min(remaining, 4000);
        row.rationale.text = 'é'.repeat(extra) + 'x'.repeat(4000 - extra);
        remaining -= extra;
    }
    expect(remaining).toBe(0);
    expect(Buffer.byteLength(JSON.stringify(saveCommand(rows)), 'utf8')).toBe(65536);
    expect(normaliseNcscCommand(saveCommand(rows)).payload.responses).toHaveLength(14);
    const last = rows[rows.length - 1];
    last.rationale.text = last.rationale.text.replace('x', 'é');
    expect(Buffer.byteLength(JSON.stringify(saveCommand(rows)), 'utf8')).toBe(65537);
    expectCode(() => normaliseNcscCommand(saveCommand(rows)), 'ncsc_request_too_large');
    rows.forEach(item => { item.rationale.text = '界'.repeat(4000); });
    expectCode(() => normaliseNcscCommand(saveCommand(rows)), 'ncsc_request_too_large');
    expectCode(() => normaliseNcscCommand({ ...source, payload: { scopePopulation: { description: 'x'.repeat(65537) } } }),
        'ncsc_request_too_large');
});

test.each([
    ['NUL', '\u0000'], ['lone high surrogate', '\uD800'], ['lone low surrogate', '\uDC00']
].flatMap(([label, invalid]) => ['create', 'save'].map(action => [action, label, invalid])))
('Unicode %s rejects %s before resolving context or invoking the repository', async (action, _label, invalid) => {
    const value = `Synthetic ${invalid} text`, command = action === 'create' ? createCommand()
        : saveCommand([{ itemId: firstId, optionId: 'not_applicable', rationale: { text: value } }]);
    if (action === 'create') command.payload.scopePopulation.description = value;
    const h = harness({ resolve: jest.fn() });
    await expect(h.service.execute({}, command)).rejects.toMatchObject({ code: 'ncsc_input_invalid', statusCode: 400 });
    expect(h.requestContext.resolve).not.toHaveBeenCalled();
    expect(h.repository.executeNcscAssessment).not.toHaveBeenCalled();
});

test('Unicode text preserves valid astral pairs, multilingual content and non-NUL controls with the exact UTF-16 bound', async () => {
    const h = harness();
    for (const value of ['Māori 日本語 العربية e\u0301 \uD83D\uDE80\n\t\r\b\f\u0001\u007F unchanged', '\uD83D\uDE80'.repeat(2000)]) {
        const create = createCommand(); create.payload.scopePopulation.description = value;
        const save = saveCommand([{ itemId: firstId, optionId: 'not_applicable', rationale: { text: value } }]);
        for (const command of [create, save]) {
            await h.service.execute({}, command);
            expect(h.repository.executeNcscAssessment.mock.calls.at(-1)[1]).toEqual(command);
        }
    }
    const overLimit = '\uD83D\uDE80'.repeat(2000) + 'x';
    expect(overLimit.length).toBe(4001);
    const oversizedCreate = createCommand(); oversizedCreate.payload.scopePopulation.description = overLimit;
    const oversizedSave = saveCommand([{ itemId: firstId, optionId: 'not_applicable', rationale: { text: overLimit } }]);
    for (const command of [oversizedCreate, oversizedSave]) {
        await expect(h.service.execute({}, command)).rejects.toMatchObject({ code: 'ncsc_input_invalid', statusCode: 400 });
    }
    expect(h.repository.executeNcscAssessment).toHaveBeenCalledTimes(4);
});

test('accessors, proxies, sparse arrays, cycles and non-JSON data never execute client hooks', () => {
    let hooks = 0;
    const getter = createCommand();
    Object.defineProperty(getter.payload.scopePopulation, 'description', { enumerable: true, get() { hooks += 1; return 'x'; } });
    const proxy = new Proxy(createCommand(), { ownKeys() { hooks += 1; throw new Error('executed'); } });
    const sparse = Array(1), cycle = createCommand(); cycle.payload.self = cycle;
    const symbol = createCommand(); symbol[Symbol('private')] = 'x';
    const hidden = createCommand(); Object.defineProperty(hidden, 'hidden', { value: 'x' });
    const arrayHook = [{ itemId: firstId, optionId: 'yes', rationale: null }];
    Object.defineProperty(arrayHook, '0', { enumerable: true, get() { hooks += 1; return null; } });
    for (const command of [getter, proxy, cycle, symbol, hidden, saveCommand(sparse), saveCommand(arrayHook),
        { ...createCommand(), payload: new Date() }, { ...createCommand(), payload: undefined },
        { ...createCommand(), payload: 1n }, { ...createCommand(), payload: Infinity },
        { ...createCommand(), payload: () => 'x' }, Object.create(createCommand())]) {
        expectCode(() => normaliseNcscCommand(command));
    }
    expect(hooks).toBe(0);
});

test('keyset pages and selectors require exact bounded fields', () => {
    expect(normaliseNcscPage({ limit: 100, afterAssessmentId: 'A-z:1' })).toEqual({ limit: 100, afterAssessmentId: 'A-z:1' });
    expect(normaliseNcscSelector({ assessmentId: 'assessment-1' })).toEqual({ assessmentId: 'assessment-1' });
    for (const limit of [0, 101, -1, 1.2, NaN, '50']) expectCode(() => normaliseNcscPage({ limit, afterAssessmentId: null }));
    expectCode(() => normaliseNcscPage({ limit: 50 }));
    expectCode(() => normaliseNcscSelector({ assessmentId: 'assessment-1', tenantId: 'foreign' }));
});

test('context must retain the process brand and exact representable canonical scope', async () => {
    const valid = await contextResolver().resolve({});
    expect(requireNcscContext(valid)).toBe(valid);
    for (const context of [null, copy(valid), { ...valid }, Object.create(valid)]) {
        expectCode(() => requireNcscContext(context), 'ncsc_access_denied');
    }
    for (const selected of [{ ...scope, tenantId: 'é-tenant' }, { ...scope, organisationId: 'x'.repeat(121) }]) {
        const h = harness(contextResolver(selected));
        await expect(h.service.execute({}, createCommand())).rejects.toMatchObject({ code: 'ncsc_selected_scope_unsupported' });
        expect(h.repository.executeNcscAssessment).not.toHaveBeenCalled();
    }
});

test('service resolves trusted context, detaches before await and never reuses authority', async () => {
    let release;
    const resolver = contextResolver(), request = { tenantId: 'forged', actor: 'forged' };
    const branded = await resolver.resolve(request);
    const h = harness({ resolve: jest.fn(() => new Promise(resolve => { release = () => resolve(branded); })) });
    const source = createCommand(), original = copy(source), pending = h.service.execute(request, source);
    source.payload.scopePopulation.description = 'changed while context pending';
    expect(h.repository.executeNcscAssessment).not.toHaveBeenCalled();
    release(); await pending;
    expect(h.repository.executeNcscAssessment).toHaveBeenCalledWith(branded, original);
    const fresh = harness(resolver);
    const firstResult = { schemaVersion: 1, action: 'create', assessment: { revision: 0, updatedAt: NOW } };
    fresh.repository.executeNcscAssessment.mockResolvedValueOnce(firstResult)
        .mockRejectedValueOnce(new NcscAssessmentError('ncsc_access_denied', 403));
    expect(await fresh.service.execute(request, createCommand())).toBe(firstResult);
    await expect(fresh.service.execute(request, createCommand())).rejects.toMatchObject({ code: 'ncsc_access_denied' });
    expect(fresh.repository.executeNcscAssessment).toHaveBeenCalledTimes(2);
    await fresh.service.list(request, { limit: 50, afterAssessmentId: null });
    await fresh.service.read(request, { assessmentId: 'assessment-1' });
    expect(fresh.repository.listNcscAssessments).toHaveBeenCalledWith(branded, { limit: 50, afterAssessmentId: null });
    expect(fresh.repository.readNcscAssessment).toHaveBeenCalledWith(branded, { assessmentId: 'assessment-1' });
});

test('bad caller intent and forged context cannot reach repository methods', async () => {
    const h = harness({ resolve: jest.fn(async () => ({ scope })) });
    await expect(h.service.execute({}, { ...createCommand(), tenantId: 'forged' })).rejects.toMatchObject({ code: 'ncsc_input_invalid' });
    expect(h.requestContext.resolve).not.toHaveBeenCalled();
    await expect(h.service.execute({}, createCommand())).rejects.toMatchObject({ code: 'ncsc_access_denied' });
    expect(h.repository.executeNcscAssessment).not.toHaveBeenCalled();
    expectCode(() => createNcscAssessmentService({ repository: h.repository }));
    expectCode(() => createNcscAssessmentService({ repository: h.repository, requestContext: {}, policy: {} }));
});

function projectionFixture(submitted = false) {
    const tenant = createTenantAggregate({ tenant: { tenantId: scope.tenantId, displayName: 'Synthetic tenant' },
        organisations: [{ ...scope, displayName: 'Synthetic organisation' }] });
    const command = { ...scope, assessmentId: 'assessment-1', actorSubjectKey: SUBJECT, now: NOW, idempotencyKey: 'create-1',
        action: 'create', expectedRevision: null, payload: { moduleId: MODULE_ID, profileRef: ACCEPTED_PROFILE_REF,
            scopePopulationSha256: 'a'.repeat(64) } };
    let state = createAssessment(tenant, command, acceptedRegistry);
    const responses = acceptedProfile.questions.map((item, index) => ({ itemId: item.id,
        optionId: index === 0 ? 'not_applicable' : index === 1 ? 'unknown' : 'yes',
        applicabilityRationaleSha256: index === 0 ? 'b'.repeat(64) : null }));
    state = applyAssessmentCommand(state, tenant, { ...command, action: 'save', expectedRevision: 0, payload: { responses } }, acceptedRegistry);
    if (submitted) state = applyAssessmentCommand(state, tenant, { ...command, action: 'submit', expectedRevision: 1, payload: {} }, acceptedRegistry);
    return { envelope: { schemaVersion: 1, ...scope, assessmentId: 'assessment-1', revision: state.revision, state,
        scopePopulation: { actorSubjectKey: SUBJECT, body: { description: 'Synthetic declared population', private: 'hidden' } },
        rationales: [{ itemId: firstId, actorSubjectKey: SUBJECT, body: { text: 'Pending N/A rationale', private: 'hidden' } }],
        evidence: { private: 'evidence-input' }, risk: { private: 'risk-input' },
        submission: submitted ? { input: { private: 'evaluation-input' }, evaluation: evaluateAcceptedNcscAssessment(copy(evaluationFixture.input)) } : null,
        authority: 'private-authority', usage: 'private-usage', receipt: 'private-receipt', audit: 'private-audit' },
    revisionSha256: 'c'.repeat(64) };
}

test('public summary and detail use closed named fields and keep internal actors and records private', () => {
    const fixture = projectionFixture(), summary = projectNcscSummary(fixture), detail = projectNcscDetail(fixture);
    const summaryKeys = ['assessmentId', 'moduleId', 'profileRef', 'status', 'revision', 'revisionSha256', 'createdAt', 'updatedAt', 'progress'];
    expect(Object.keys(summary).sort()).toEqual(summaryKeys.sort());
    expect(Object.keys(detail).sort()).toEqual([...summaryKeys, 'scopePopulation', 'responses', 'submission'].sort());
    expect(summary.progress).toEqual({ total: 14, answered: 14, missing: 0, unknown: 1, notApplicableClaims: 1 });
    expect(detail.scopePopulation).toEqual({ description: 'Synthetic declared population' });
    expect(detail.responses.find(item => item.itemId === firstId)).toEqual({ itemId: firstId, optionId: 'not_applicable',
        rationale: { text: 'Pending N/A rationale' } });
    expect(detail.submission).toBeNull();
    for (const response of detail.responses) expect(Object.keys(response).sort()).toEqual(['itemId', 'optionId', 'rationale']);
    const publicJson = JSON.stringify({ summary, detail });
    for (const sentinel of [SUBJECT, scope.tenantId, 'private', 'hidden', 'actorSubjectKey', 'updatedBy', 'scopePopulationSha256']) {
        expect(publicJson).not.toContain(sentinel);
    }
    expect(Object.isFrozen(detail.responses[0])).toBe(true);
});

test('submitted projection retains exact evaluator output and seal without input or internal actor fields', () => {
    const fixture = projectionFixture(true), detail = projectNcscDetail(fixture);
    expect(Object.keys(detail.submission).sort()).toEqual(['evaluation', 'responseSetSha256', 'revision', 'submittedAt']);
    expect(detail.submission.evaluation).toEqual(fixture.envelope.submission.evaluation);
    expect(detail.submission.evaluation).not.toBe(fixture.envelope.submission.evaluation);
    expect(detail.submission.revision).toBe(fixture.envelope.state.submission.revision);
    expect(detail.submission.submittedAt).toBe(NOW);
    expect(JSON.stringify(detail)).not.toContain('evaluation-input');
    expect(JSON.stringify(detail)).not.toContain(SUBJECT);
});
