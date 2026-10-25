'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createNcscAssessmentHandlers } = require('../api/shared/ncscAssessmentHandlers');
const { NcscAssessmentError } = require('../api/shared/ncscAssessmentService');
const { TenantRequestContextError } = require('../api/shared/appLifecycle/tenantRequestContext');
const { acceptedProfile } = require('../api/shared/assessmentLifecycle/ncscAssessmentSubmission');
const { API_SECURITY_HEADERS } = require('../api/shared/securityHeaders');

const itemId = acceptedProfile.questions[0].id;
const createBody = () => ({ assessmentId: 'assessment-1', idempotencyKey: 'create-1', expectedRevision: null,
    payload: { scopePopulation: { description: 'Synthetic population' } } });
const saveBody = () => ({ idempotencyKey: 'save-1', expectedRevision: 0,
    payload: { responses: [{ itemId, optionId: 'yes', rationale: null }] } });
const submitBody = () => ({ idempotencyKey: 'submit-1', expectedRevision: 1, payload: {} });
function harness(guardMutation = jest.fn(() => true)) {
    const service = { list: jest.fn(async () => ({ schemaVersion: 1, assessments: [], nextAfterAssessmentId: null })),
        read: jest.fn(async () => ({ schemaVersion: 1, assessment: { assessmentId: 'assessment-1' } })),
        execute: jest.fn(async (_request, command) => ({ schemaVersion: 1, action: command.action,
            assessment: { assessmentId: command.assessmentId } })) };
    return { service, guardMutation, handlers: createNcscAssessmentHandlers({ service, guardMutation }) };
}
function expectError(response, status, code) {
    expect(response.status).toBe(status);
    expect(response.body).toEqual({ code });
    expect(response.headers).toMatchObject(API_SECURITY_HEADERS);
    expect(response.isRaw).toBe(false);
}

test('list/read pass only canonical page/selector and never invoke mutation guard', async () => {
    const h = harness(), request = { method: 'GET' };
    const list = await h.handlers.handleRequest(request, '');
    expect(list.status).toBe(200);
    expect(list.body).toEqual({ schemaVersion: 1, assessments: [], nextAfterAssessmentId: null });
    expect(h.service.list).toHaveBeenCalledWith(request, { limit: 50, afterAssessmentId: null });
    const paged = { method: 'GET', query: { limit: '100', afterAssessmentId: 'assessment-1' } };
    await h.handlers.handleRequest(paged, '');
    expect(h.service.list).toHaveBeenLastCalledWith(paged, { limit: 100, afterAssessmentId: 'assessment-1' });
    const read = await h.handlers.handleRequest(request, 'assessment-1');
    expect(read.status).toBe(200);
    expect(h.service.read).toHaveBeenCalledWith(request, { assessmentId: 'assessment-1' });
    expect(h.guardMutation).not.toHaveBeenCalled();
    expect(read.headers['Content-Type']).toBe('application/json; charset=utf-8');
    expect(read.headers['Cache-Control']).toBe('private, no-store, max-age=0');
});

test.each([
    ['', createBody, 'create', 201], ['assessment-1/save', saveBody, 'save', 200],
    ['assessment-1/submit', submitBody, 'submit', 200]
])('mutation route %s derives action and preserves original response on exact retries', async (route, body, action, status) => {
    const h = harness(), request = { method: 'POST', body: body(), tenantContext: { forged: true } };
    const original = Object.freeze({ schemaVersion: 1, action, assessment: Object.freeze({ revision: 0, updatedAt: 'original-time' }) });
    h.service.execute.mockResolvedValue(original);
    const result = await h.handlers.handleRequest(request, route);
    const replay = await h.handlers.handleRequest(request, route);
    expect(result.status).toBe(status); expect(replay.status).toBe(status);
    expect(result.body).toBe(original); expect(replay.body).toBe(original);
    expect(h.guardMutation).toHaveBeenCalledWith(request);
    expect(h.service.execute).toHaveBeenCalledWith(request, { assessmentId: 'assessment-1', action,
        idempotencyKey: body().idempotencyKey, expectedRevision: body().expectedRevision, payload: body().payload });
    expect(Object.keys(replay.body).sort()).toEqual(['action', 'assessment', 'schemaVersion']);
});

test('mandatory guard composition rejects absent, non-function, extra or accessor adapters', () => {
    const h = harness();
    for (const adapters of [undefined, null, {}, { service: h.service }, { service: h.service, guardMutation: true },
        { service: h.service, guardMutation: () => true, policy: true }]) {
        expect(() => createNcscAssessmentHandlers(adapters)).toThrow(NcscAssessmentError);
    }
    let reads = 0;
    expect(() => createNcscAssessmentHandlers({ service: h.service, get guardMutation() { reads += 1; return () => true; } }))
        .toThrow(NcscAssessmentError);
    expect(reads).toBe(0);
});

test.each([false, undefined, null, 1, 'true', {}, { then: resolve => resolve(false) }])(
    'guard result %p denies every mutation with no service access', async result => {
        const guard = jest.fn(() => result), h = harness(guard);
        for (const [route, body] of [['', createBody()], ['assessment-1/save', saveBody()], ['assessment-1/submit', submitBody()]]) {
            const request = { method: 'POST', body, guardMutation: () => true };
            expectError(await h.handlers.handleRequest(request, route), 403, 'ncsc_access_denied');
            expect(guard).toHaveBeenLastCalledWith(request);
        }
        for (const method of Object.values(h.service)) expect(method).not.toHaveBeenCalled();
    });

test.each(['throw', 'reject'])('guard %s is sanitized as access denied', async mode => {
    const secret = new Error('private-origin-provider-host-key');
    secret.code = 'ncsc_quota_exceeded';
    const h = harness(() => { if (mode === 'throw') throw secret; return Promise.reject(secret); });
    const result = await h.handlers.handleRequest({ method: 'POST', body: createBody() }, '');
    expectError(result, 403, 'ncsc_access_denied');
    expect(JSON.stringify(result)).not.toContain('private-origin-provider-host-key');
    expect(h.service.execute).not.toHaveBeenCalled();
});

test('pending async guard cannot begin service access and only resolved literal true releases it', async () => {
    let release;
    const h = harness(jest.fn(() => new Promise(resolve => { release = resolve; })));
    const request = { method: 'POST', body: createBody() };
    const pending = h.handlers.handleRequest(request, '');
    await Promise.resolve();
    expect(h.guardMutation).toHaveBeenCalledWith(request);
    expect(h.service.execute).not.toHaveBeenCalled();
    release(true);
    expect((await pending).status).toBe(201);
    expect(h.service.execute).toHaveBeenCalledTimes(1);
});

test('mutation intent is detached before a pending guard despite later body, identity, key and query mutations', async () => {
    let release;
    const h = harness(() => new Promise(resolve => { release = resolve; }));
    const request = { method: 'POST', body: createBody(), query: {} };
    const expected = { assessmentId: request.body.assessmentId, action: 'create', idempotencyKey: request.body.idempotencyKey,
        expectedRevision: null, payload: { scopePopulation: { description: request.body.payload.scopePopulation.description } } };
    const pending = h.handlers.handleRequest(request, '');
    request.body.assessmentId = 'changed-assessment'; request.body.idempotencyKey = 'changed-key';
    request.body.expectedRevision = 99; request.body.payload.scopePopulation.description = 'changed declaration';
    request.query.tenantId = 'changed-tenant'; request.method = 'DELETE';
    request.body = { action: 'archive', tenantId: 'forged', payload: {} };
    expect(h.service.execute).not.toHaveBeenCalled();
    release(true);
    expect((await pending).status).toBe(201);
    expect(h.service.execute).toHaveBeenCalledWith(request, expected);
    expect(Object.isFrozen(h.service.execute.mock.calls[0][1].payload.scopePopulation)).toBe(true);
});

test.each([true, false])('a captured invalid query remains invalid after pending guard; denied guard preserves403 precedence (%s)', async allowed => {
    let release;
    const h = harness(() => new Promise(resolve => { release = resolve; }));
    const request = { method: 'POST', body: createBody(), query: { tenantId: 'forged' } };
    const pending = h.handlers.handleRequest(request, '');
    request.query = {};
    release(allowed);
    expectError(await pending, allowed ? 400 : 403, allowed ? 'ncsc_input_invalid' : 'ncsc_access_denied');
    expect(h.service.execute).not.toHaveBeenCalled();
});

test('a synchronous guard cannot rewrite already captured valid intent', async () => {
    const h = harness(request => { request.body.idempotencyKey = 'changed'; request.body.payload.responses[0].optionId = 'no'; return true; });
    const request = { method: 'POST', body: saveBody() };
    expect((await h.handlers.handleRequest(request, 'assessment-1/save')).status).toBe(200);
    expect(h.service.execute.mock.calls[0][1]).toMatchObject({ idempotencyKey: 'save-1',
        payload: { responses: [{ itemId, optionId: 'yes', rationale: null }] } });
});

test.each([
    ['', 'DELETE', 'GET, POST'], ['', 'OPTIONS', 'GET, POST'], ['assessment-1', 'POST', 'GET'],
    ['assessment-1/save', 'GET', 'POST'], ['assessment-1/submit', 'HEAD', 'POST'], ['', 'get', 'GET, POST']
])('unsupported method on %s returns exact Allow and cannot access service', async (route, method, allow) => {
    const h = harness(), result = await h.handlers.handleRequest({ method }, route);
    expectError(result, 405, 'ncsc_method_not_allowed');
    expect(result.headers.Allow).toBe(allow);
    expect(h.guardMutation).not.toHaveBeenCalled();
    for (const value of Object.values(h.service)) expect(value).not.toHaveBeenCalled();
});

test.each([undefined, null, '/', '/assessment-1', 'assessment-1/', 'assessment-1/review', 'assessment-1/archive',
    'assessment-1/approve', 'assessment-1/save/', 'assessment-1/save/more', 'assessments/assessment-1',
    'api/dashboard/ncsc/assessments', 'a'.repeat(121), '%61ssessment-1', '../save'])('route %p has no alias or hidden operation', async route => {
    const h = harness();
    expectError(await h.handlers.handleRequest({ method: 'POST', body: createBody() }, route), 404, 'ncsc_not_found');
    expect(h.guardMutation).not.toHaveBeenCalled();
    for (const value of Object.values(h.service)) expect(value).not.toHaveBeenCalled();
});

test.each(['01', '0', '101', '-1', '+1', '1.0', '1e2', ' 50', '50 ', '', '100\n', 50, ['50'], null])(
    'noncanonical query limit %p is rejected before service', async limit => {
        const h = harness();
        expectError(await h.handlers.handleRequest({ method: 'GET', query: { limit } }, ''), 400, 'ncsc_input_invalid');
        expect(h.service.list).not.toHaveBeenCalled();
    });

test('only list permits query keys and every GET rejects a body', async () => {
    const h = harness();
    for (const request of [{ method: 'GET', query: { limit: '50', tenantId: 'forged' } },
        { method: 'GET', query: { afterAssessmentId: '*' } }, { method: 'GET', query: { afterAssessmentId: ['a', 'b'] } },
        { method: 'GET', body: {} }, { method: 'GET', body: null }, { method: 'GET', body: '' }]) {
        expectError(await h.handlers.handleRequest(request, ''), 400, 'ncsc_input_invalid');
    }
    expectError(await h.handlers.handleRequest({ method: 'GET', query: { limit: '50' } }, 'assessment-1'), 400, 'ncsc_input_invalid');
    expectError(await h.handlers.handleRequest({ method: 'POST', body: createBody(), query: { limit: '50' } }, ''), 400, 'ncsc_input_invalid');
    for (const value of Object.values(h.service)) expect(value).not.toHaveBeenCalled();
});

test('mutation body schemas reject missing keys, route overrides and all privileged fields', async () => {
    const h = harness();
    for (const key of ['action', 'actorSubjectKey', 'tenantId', 'organisationId', 'now', 'profileRef', 'grant', 'quota',
        'receipt', 'audit', 'evaluation', 'guardMutation']) {
        expectError(await h.handlers.handleRequest({ method: 'POST', body: { ...createBody(), [key]: 'forged' } }, ''),
            400, 'ncsc_input_invalid');
    }
    for (const key of Object.keys(createBody())) {
        const body = createBody(); delete body[key];
        expectError(await h.handlers.handleRequest({ method: 'POST', body }, ''), 400, 'ncsc_input_invalid');
    }
    expectError(await h.handlers.handleRequest({ method: 'POST', body: { ...saveBody(), assessmentId: 'foreign' } },
        'assessment-1/save'), 400, 'ncsc_input_invalid');
    expectError(await h.handlers.handleRequest({ method: 'POST', body: { ...submitBody(), payload: { approved: true } } },
        'assessment-1/submit'), 400, 'ncsc_input_invalid');
    expect(h.service.execute).not.toHaveBeenCalled();
});

test.each([
    ['NUL', '\u0000'], ['lone high surrogate', '\uD800'], ['lone low surrogate', '\uDC00']
].flatMap(([label, invalid]) => ['create', 'save'].map(action => [action, label, invalid])))
('Unicode %s with %s returns a generic 400 without invoking the service', async (action, _label, invalid) => {
    const h = harness(), body = action === 'create' ? createBody() : saveBody(), value = `Synthetic ${invalid} text`;
    if (action === 'create') body.payload.scopePopulation.description = value;
    else body.payload.responses = [{ itemId, optionId: 'not_applicable', rationale: { text: value } }];
    const request = { method: 'POST', body };
    expectError(await h.handlers.handleRequest(request, action === 'create' ? '' : 'assessment-1/save'),
        400, 'ncsc_input_invalid');
    expect(h.guardMutation).toHaveBeenCalledWith(request);
    for (const method of Object.values(h.service)) expect(method).not.toHaveBeenCalled();
});

test('Unicode valid text remains exact through HTTP with the 4000 UTF-16-unit boundary', async () => {
    const h = harness();
    for (const value of ['Māori 日本語 العربية e\u0301 \uD83D\uDE80\n\t\r\b\f\u0001\u007F unchanged', '\uD83D\uDE80'.repeat(2000)]) {
        const create = createBody(), save = saveBody();
        create.payload.scopePopulation.description = value;
        save.payload.responses = [{ itemId, optionId: 'not_applicable', rationale: { text: value } }];
        expect((await h.handlers.handleRequest({ method: 'POST', body: create }, '')).status).toBe(201);
        expect(h.service.execute.mock.calls.at(-1)[1].payload.scopePopulation.description).toBe(value);
        expect((await h.handlers.handleRequest({ method: 'POST', body: save }, 'assessment-1/save')).status).toBe(200);
        expect(h.service.execute.mock.calls.at(-1)[1].payload.responses[0].rationale.text).toBe(value);
    }
    const overLimit = '\uD83D\uDE80'.repeat(2000) + 'x', create = createBody(), save = saveBody();
    expect(overLimit.length).toBe(4001);
    create.payload.scopePopulation.description = overLimit;
    save.payload.responses = [{ itemId, optionId: 'not_applicable', rationale: { text: overLimit } }];
    for (const [route, body] of [['', create], ['assessment-1/save', save]]) {
        expectError(await h.handlers.handleRequest({ method: 'POST', body }, route), 400, 'ncsc_input_invalid');
    }
    expect(h.service.execute).toHaveBeenCalledTimes(4);
});

test('malformed descriptor-bearing and over-byte-budget requests are rejected without executing hooks', async () => {
    const h = harness(); let hooks = 0;
    const getterBody = createBody();
    Object.defineProperty(getterBody.payload.scopePopulation, 'description', { enumerable: true, get() { hooks += 1; return 'forged'; } });
    const proxyBody = new Proxy(createBody(), { ownKeys() { hooks += 1; return []; } });
    const getterQuery = { get limit() { hooks += 1; return '50'; } };
    for (const body of [getterBody, proxyBody, { ...saveBody(), payload: { responses: Array(1) } }]) {
        expectError(await h.handlers.handleRequest({ method: 'POST', body }, body === getterBody || body === proxyBody ? '' : 'assessment-1/save'),
            400, 'ncsc_input_invalid');
    }
    expectError(await h.handlers.handleRequest({ method: 'GET', query: getterQuery }, ''), 400, 'ncsc_input_invalid');
    expectError(await h.handlers.handleRequest({ method: 'POST', body: { ...createBody(),
        payload: { scopePopulation: { description: 'x'.repeat(65537) } } } }, ''), 413, 'ncsc_request_too_large');
    expect(hooks).toBe(0);
    for (const value of Object.values(h.service)) expect(value).not.toHaveBeenCalled();
});

test.each([
    ['ncsc_input_invalid', 400], ['ncsc_selected_scope_unsupported', 400], ['ncsc_access_denied', 403],
    ['ncsc_not_found', 404], ['ncsc_revision_conflict', 409], ['ncsc_idempotency_conflict', 409],
    ['ncsc_state_conflict', 409], ['ncsc_quota_exceeded', 409], ['ncsc_submission_unavailable', 409], ['ncsc_request_too_large', 413],
    ['ncsc_unavailable', 503], ['ncsc_outcome_ambiguous', 503]
])('known %s maps to fixed public status without messages or error metadata', async (code, status) => {
    const h = harness(), error = new NcscAssessmentError(code, 599);
    error.message = 'private-driver-data'; error.details = { foreignTenantId: 'secret' };
    h.service.execute.mockRejectedValue(error);
    const result = await h.handlers.handleRequest({ method: 'POST', body: createBody() }, '');
    expectError(result, status, code);
    expect(JSON.stringify(result)).not.toContain('private-driver-data');
    expect(JSON.stringify(result)).not.toContain('secret');
});

test('corrupt records, read transaction failures, sink failures and arbitrary codes stay unavailable', async () => {
    for (const error of [new Error('private-sql-host'), new NcscAssessmentError('ncsc_corrupt_record', 400),
        Object.assign(new Error('sink failed'), { code: 'ncsc_access_denied', statusCode: 403 }),
        Object.assign(new Error('commit failed'), { code: 'postgres_commit_failed' })]) {
        const h = harness();
        h.service.list.mockRejectedValue(error); h.service.read.mockRejectedValue(error); h.service.execute.mockRejectedValue(error);
        expectError(await h.handlers.handleRequest({ method: 'GET' }, ''), 503, 'ncsc_unavailable');
        expectError(await h.handlers.handleRequest({ method: 'GET' }, 'assessment-1'), 503, 'ncsc_unavailable');
        expectError(await h.handlers.handleRequest({ method: 'POST', body: createBody() }, ''), 503, 'ncsc_unavailable');
    }
    const h = harness(); h.service.read.mockRejectedValue(new TenantRequestContextError());
    expectError(await h.handlers.handleRequest({ method: 'GET' }, 'assessment-1'), 403, 'ncsc_access_denied');
});

test('NCSC HTTP/service source remains uninstalled in runtime entry points and factories', () => {
    const root = path.resolve(__dirname, '..');
    for (const file of ['server.js', 'app-service.js']) {
        const source = fs.readFileSync(path.join(root, file), 'utf8');
        expect(source).not.toMatch(/ncscAssessmentHandlers|ncscAssessmentService|dashboard\/ncsc\/assessments/);
    }
    function inspect(directory) {
        for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
            if (item.name === 'node_modules' || item.name === 'shared') continue;
            const file = path.join(directory, item.name);
            if (item.isDirectory()) inspect(file);
            else if (/\.(?:js|json)$/.test(item.name)) {
                expect(fs.readFileSync(file, 'utf8')).not.toMatch(/ncscAssessmentHandlers|ncscAssessmentService|dashboard\/ncsc\/assessments/);
            }
        }
    }
    inspect(path.join(root, 'api')); inspect(path.join(root, 'connector-functions'));
});
