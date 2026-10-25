'use strict';

// Facade-only boundary tests. The binder and DATA repository are controlled
// dependencies; genuine POR008 context branding and NCSC normalizers remain in
// use. SQL, current authority and paired audit are exercised in the separately
// owned request-database and real PostgreSQL suites.
const { ncscFixture, createCommand, saveCommand, submitCommand, NOW, SUBJECT } = require('./fixtures/ncscAssessmentFixture');
const BINDER = '../api/shared/database/dashboardRequestDatabase';
const REPOSITORY = '../api/shared/appLifecycle/postgresDashboardRepository';
const EVIDENCE_REPOSITORY = '../api/shared/appLifecycle/postgresEvidenceMetadataRepository';
const CONTEXT = '../api/shared/appLifecycle/tenantRequestContext';
const RUNTIME = '../api/shared/dashboardRuntime';
const GENERATION = 'a'.repeat(64);
const OTHER_GENERATION = 'b'.repeat(64);
const OTHER_SUBJECT = '11111111-1111-1111-1111-111111111111:22222222-2222-2222-2222-222222222222';
const REQUEST_A = '11111111-1111-4111-8111-111111111111';
const REQUEST_B = '22222222-2222-4222-8222-222222222222';
const copy = value => JSON.parse(JSON.stringify(value));
const freeze = value => {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
    return value;
};
function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function projectedResults() {
    const example = ncscFixture();
    const { normaliseNcscCommand, projectNcscSummary, projectNcscDetail } = require('../api/shared/ncscAssessmentService');
    const { stableIntent, makeVersion } = require('../api/shared/assessmentLifecycle/postgresNcscAssessmentStore');
    let version = null;
    const actions = {};
    for (const command of [createCommand(), saveCommand(), submitCommand()]) {
        const intent = stableIntent({ scope: example.scope, identity: { subjectKey: SUBJECT } }, normaliseNcscCommand(command));
        version = makeVersion(intent, command.idempotencyKey, version, example.state.tenantAggregate, NOW);
        actions[command.action] = freeze({ schemaVersion: 1, action: command.action, assessment: projectNcscDetail(version) });
    }
    return {
        scope: freeze(copy(example.scope)),
        admission: freeze({ tenantAggregate: example.state.tenantAggregate, membershipState: example.state.membershipState,
            entitlementState: example.state.entitlementState, flags: example.state.flags, advisorAssignments: {}, summary: null }),
        list: freeze({ schemaVersion: 1, assessments: [projectNcscSummary(version)], nextAfterAssessmentId: null }),
        read: freeze({ schemaVersion: 1, assessment: projectNcscDetail(version) }),
        actions
    };
}
const RESULTS = projectedResults();

function harness() {
    const bindings = new WeakMap(), phaseGates = new WeakMap();
    const state = { operations: [], configurations: [], calls: [], contextFactories: [],
        behavior: {}, evidenceConfigurations: [], results: RESULTS };
    const bindRequest = jest.fn(async request => bindings.get(request));
    const handleHostResource = jest.fn();
    const createBinder = jest.fn(() => Object.freeze({ bindRequest, handleHostResource }));
    let actualContext, errors, createRuntime;

    jest.isolateModules(() => {
        actualContext = jest.requireActual(CONTEXT);
        const actualRepository = jest.requireActual(REPOSITORY);
        const ncsc = jest.requireActual('../api/shared/ncscAssessmentService');
        errors = { DashboardPersistenceError: actualRepository.DashboardPersistenceError,
            NcscAssessmentError: ncsc.NcscAssessmentError,
            EvidenceMetadataError: jest.requireActual('../api/shared/evidenceMetadataService').EvidenceMetadataError };
        jest.doMock(BINDER, () => ({ createDashboardRequestDatabase: createBinder }));
        jest.doMock(CONTEXT, () => ({ ...actualContext,
            createTenantRequestContext: adapters => {
                state.contextFactories.push(adapters);
                return actualContext.createTenantRequestContext({ ...adapters,
                    authenticate: async request => {
                        const value = await adapters.authenticate(request);
                        const gate = phaseGates.get(request)?.authenticate;
                        if (gate) { gate.entered.resolve(); await gate.release.promise; }
                        return value;
                    },
                    resolveScope: async (request, principal) => {
                        const value = await adapters.resolveScope(request, principal);
                        const gate = phaseGates.get(request)?.resolveScope;
                        if (gate) { gate.entered.resolve(); await gate.release.promise; }
                        return value;
                    }
                });
            }
        }));
        jest.doMock(REPOSITORY, () => ({ ...actualRepository,
            createPostgresDashboardRepository: configuration => {
                state.configurations.push(configuration);
                const call = (method, args, fallback) => {
                    state.calls.push({ method, args, configuration });
                    return state.behavior[method] ? state.behavior[method](...args) : fallback;
                };
                return Object.freeze({
                    readAdmissionSnapshot: (...args) => call('admission', args, RESULTS.admission),
                    listNcscAssessments: (...args) => call('list', args, RESULTS.list),
                    readNcscAssessment: (...args) => call('read', args, RESULTS.read),
                    executeNcscAssessment: (...args) => call('execute', args, RESULTS.actions[args[1].action]),
                    initialiseOrganisation: jest.fn(() => { throw new Error('Administration must remain inaccessible'); })
                });
            }
        }));
        jest.doMock(EVIDENCE_REPOSITORY, () => ({ createPostgresEvidenceMetadataRepository: configuration => {
            state.evidenceConfigurations.push(configuration);
            return Object.freeze({ readEvidenceMetadata: (...args) => {
                state.calls.push({ method: 'evidence', args, configuration });
                return state.behavior.evidence ? state.behavior.evidence(...args) : Object.freeze({ schemaVersion: 1, artefact: null });
            } });
        } }));
        ({ createDashboardResourceRuntime: createRuntime } = require(RUNTIME));
    });

    const options = Object.freeze({ pool: Object.freeze({ connect: jest.fn() }), clock: () => NOW,
        instanceId: '33333333-3333-4333-8333-333333333333',
        historyBudget: Object.freeze({ maxRecords: 4096, maxBytes: 64 * 1024 * 1024, maxDurationMs: 60000 }),
        captureRequest: jest.fn(), readExternalRuntimeEpoch: jest.fn(),
        newId: () => '44444444-4444-4444-8444-444444444444', resolveSubmissionQuota: jest.fn() });
    const runtime = createRuntime(options);
    function add(request, overrides = {}) {
        const binding = Object.freeze({ requestId: REQUEST_A,
            identity: freeze({ authenticated: true, subjectKey: SUBJECT }), scope: RESULTS.scope, resolvedAt: NOW,
            createOperation: jest.fn(operation => {
                const pair = Object.freeze({ database: Object.freeze({ withTenantTransaction: jest.fn() }),
                    audit: Object.freeze({ createEvent: jest.fn(), writeEvent: jest.fn() }),
                    clock: jest.fn(() => NOW), resolveSubmissionQuota: jest.fn(), finish: jest.fn() });
                state.operations.push({ operation, pair });
                return pair;
            }), ...overrides });
        bindings.set(request, binding);
        return binding;
    }
    function pause(request, phase) {
        const gate = { entered: deferred(), release: deferred() };
        phaseGates.set(request, { ...phaseGates.get(request), [phase]: gate });
        return gate;
    }
    async function ready(request = {}) {
        const binding = add(request);
        const facade = await runtime.forRequest(request, { expectedGeneration: GENERATION });
        const context = await facade.requestContext.resolve(request);
        return { request, binding, facade, context };
    }
    return { ...state, state, errors, actualContext, createRuntime, createBinder, bindRequest, handleHostResource, options, runtime, add, pause, ready };
}

afterEach(() => { jest.dontMock(BINDER); jest.dontMock(REPOSITORY); jest.dontMock(CONTEXT); jest.dontMock(EVIDENCE_REPOSITORY); });

function expectNcsc(error, h, code, statusCode) {
    expect(error).toBeInstanceOf(h.errors.NcscAssessmentError);
    expect(error).toMatchObject({ code, statusCode });
}
async function rejected(promise) {
    try { await promise; } catch (error) { return error; }
    throw new Error('Expected rejection');
}

describe('dashboard resource facade and original request context', () => {
    test('exposes only closed frozen capabilities and uses the real POR008 context brand', async () => {
        const h = harness(), { request, facade, context } = await h.ready();
        expect(Object.keys(h.runtime).sort()).toEqual(['forRequest', 'handleHostResource']);
        expect(Object.keys(facade).sort()).toEqual(['admission', 'evidence', 'ncsc', 'requestContext']);
        expect(Object.keys(facade.requestContext).sort()).toEqual(['authenticate', 'resolve', 'resolveScope']);
        expect(Object.keys(facade.admission)).toEqual(['readAdmissionSnapshot']);
        expect(Object.keys(facade.evidence)).toEqual(['readEvidenceMetadata']);
        expect(Object.keys(facade.ncsc).sort()).toEqual(['executeNcscAssessment', 'listNcscAssessments', 'readNcscAssessment']);
        for (const value of [h.runtime, facade, facade.requestContext, facade.admission, facade.ncsc, facade.evidence, context, context.identity, context.scope]) {
            expect(Object.isFrozen(value)).toBe(true);
        }
        expect(h.actualContext.requireTenantRequestContext(context)).toBe(context);
        expect(context).toEqual({ schemaVersion: 1, requestId: REQUEST_A, identity: { authenticated: true, subjectKey: SUBJECT },
            scope: RESULTS.scope, resolvedAt: NOW });
        expect(await facade.requestContext.authenticate(request)).toBe(context.identity);
        expect(await facade.requestContext.resolveScope(request, context.identity)).toBe(context.scope);
        expect(h.createBinder).toHaveBeenCalledWith(h.options);
        expect(h.state.contextFactories).toHaveLength(1);
    });

    test('coalesces concurrent consumers before the binder settles and retains one facade', async () => {
        const h = harness(), request = {}, binding = h.add(request), gate = deferred(), entered = deferred();
        h.bindRequest.mockImplementation(async () => { entered.resolve(); await gate.promise; return binding; });
        const pending = Array.from({ length: 8 }, () => h.runtime.forRequest(request, { expectedGeneration: GENERATION }));
        await entered.promise;
        expect(h.bindRequest).toHaveBeenCalledTimes(1);
        gate.resolve();
        const facades = await Promise.all(pending);
        expect(facades.every(value => value === facades[0])).toBe(true);
        expect(await h.runtime.forRequest(request, { expectedGeneration: GENERATION })).toBe(facades[0]);
        expect(h.state.contextFactories).toHaveLength(1);
        expect(h.bindRequest).toHaveBeenCalledWith(request, { expectedGeneration: GENERATION });
    });

    test('a different generation cannot replace a pending or resolved original request', async () => {
        const h = harness(), request = {}, binding = h.add(request), gate = deferred(), entered = deferred();
        h.bindRequest.mockImplementation(async () => { entered.resolve(); await gate.promise; return binding; });
        const first = h.runtime.forRequest(request, { expectedGeneration: GENERATION });
        await entered.promise;
        const wrong = await rejected(h.runtime.forRequest(request, { expectedGeneration: OTHER_GENERATION }));
        expect(wrong).toBeInstanceOf(h.errors.DashboardPersistenceError);
        expect(wrong).toMatchObject({ code: 'dashboard_access_denied', statusCode: 403 });
        expect(h.bindRequest).toHaveBeenCalledTimes(1);
        gate.resolve(); const facade = await first;
        expect(await rejected(h.runtime.forRequest(request, { expectedGeneration: OTHER_GENERATION })))
            .toMatchObject({ code: 'dashboard_access_denied', statusCode: 403 });
        expect(await h.runtime.forRequest(request, { expectedGeneration: GENERATION })).toBe(facade);
    });

    test('deliberately interleaved real context adapters preserve each request ID, subject, scope and time', async () => {
        const h = harness(), a = {}, b = {};
        h.add(a);
        h.add(b, { requestId: REQUEST_B, identity: freeze({ authenticated: true, subjectKey: OTHER_SUBJECT }),
            scope: freeze({ tenantId: 'other-tenant', organisationId: 'other-organisation' }), resolvedAt: '2026-09-07T09:00:01.000Z' });
        const authA = h.pause(a, 'authenticate'), scopeB = h.pause(b, 'resolveScope');
        const pendingA = h.runtime.forRequest(a, { expectedGeneration: GENERATION });
        await authA.entered.promise;
        const pendingB = h.runtime.forRequest(b, { expectedGeneration: GENERATION });
        await scopeB.entered.promise;
        authA.release.resolve(); const facadeA = await pendingA;
        scopeB.release.resolve(); const facadeB = await pendingB;
        const contextA = await facadeA.requestContext.resolve(a), contextB = await facadeB.requestContext.resolve(b);
        expect(contextA).toMatchObject({ requestId: REQUEST_A, identity: { subjectKey: SUBJECT }, scope: RESULTS.scope, resolvedAt: NOW });
        expect(contextB).toMatchObject({ requestId: REQUEST_B, identity: { subjectKey: OTHER_SUBJECT },
            scope: { tenantId: 'other-tenant', organisationId: 'other-organisation' }, resolvedAt: '2026-09-07T09:00:01.000Z' });
        expect(contextA).not.toBe(contextB);
        expect(h.state.contextFactories).toHaveLength(1);
        expect(h.bindRequest).toHaveBeenCalledTimes(2);
    });

    test('a failed binding remains failed for that request while a new original request may recover', async () => {
        const h = harness(), request = {}, next = {}; h.add(request); h.add(next);
        h.bindRequest.mockRejectedValueOnce(new h.errors.DashboardPersistenceError('unavailable', 503));
        expect(await rejected(h.runtime.forRequest(request, { expectedGeneration: GENERATION })))
            .toMatchObject({ code: 'dashboard_unavailable', statusCode: 503 });
        expect(await rejected(h.runtime.forRequest(request, { expectedGeneration: GENERATION })))
            .toMatchObject({ code: 'dashboard_unavailable', statusCode: 503 });
        expect(h.bindRequest).toHaveBeenCalledTimes(1);
        expect(await h.runtime.forRequest(next, { expectedGeneration: GENERATION })).toHaveProperty('ncsc');
        expect(h.bindRequest).toHaveBeenCalledTimes(2);
    });

    test('request properties and caller correlation do not replace trusted context', async () => {
        const h = harness(), hostile = jest.fn(() => { throw new Error('Untrusted request property read'); });
        const request = { body: { tenantId: 'foreign' }, headers: { 'x-request-id': REQUEST_B } };
        Object.defineProperty(request, 'tenantContext', { enumerable: true, get: hostile });
        const { facade, context } = await h.ready(request);
        expect(context.requestId).toBe(REQUEST_A); expect(context.scope).toEqual(RESULTS.scope);
        expect(await facade.requestContext.resolve(request)).toBe(context);
        expect(hostile).not.toHaveBeenCalled();
    });

    test.each(['resolve', 'authenticate', 'resolveScope'])('requestContext.%s rejects a different request object', async method => {
        const h = harness(), { facade, context } = await h.ready();
        const error = await rejected(facade.requestContext[method]({}, context.identity));
        expect(error).toBeInstanceOf(h.errors.DashboardPersistenceError);
        expect(error).toMatchObject({ code: 'dashboard_access_denied', statusCode: 403 });
        expect(h.state.operations).toHaveLength(0);
    });

    test.each(['wrong subject', 'unverified', 'extra field', 'accessor'])('scope resolution rejects %s principal before work', async variant => {
        const h = harness(), { request, facade, context } = await h.ready();
        const principal = copy(context.identity), getter = jest.fn(() => SUBJECT);
        if (variant === 'wrong subject') principal.subjectKey = OTHER_SUBJECT;
        if (variant === 'unverified') principal.authenticated = 'true';
        if (variant === 'extra field') principal.role = 'admin';
        if (variant === 'accessor') Object.defineProperty(principal, 'subjectKey', { enumerable: true, get: getter });
        expect(await rejected(facade.requestContext.resolveScope(request, principal)))
            .toMatchObject({ code: 'dashboard_access_denied', statusCode: 403 });
        expect(getter).not.toHaveBeenCalled(); expect(h.state.operations).toHaveLength(0);
    });

    test.each(['copied', 'other genuine request'])('all NCSC methods reject a %s context, including identical visible fields', async variant => {
        const h = harness(), { facade, context } = await h.ready();
        const foreign = variant === 'copied' ? copy(context) : await h.actualContext.createTenantRequestContext({
            authenticate: async () => context.identity, resolveScope: async () => context.scope,
            clock: () => context.resolvedAt, createRequestId: () => context.requestId }).resolve({});
        if (variant !== 'copied') expect(h.actualContext.requireTenantRequestContext(foreign)).toBe(foreign);
        for (const [method, input] of [['listNcscAssessments', { limit: 10, afterAssessmentId: null }],
            ['readNcscAssessment', { assessmentId: 'assessment-a' }], ['executeNcscAssessment', createCommand()]]) {
            expectNcsc(await rejected(facade.ncsc[method](foreign, input)), h, 'ncsc_access_denied', 403);
        }
        expect(h.state.operations).toHaveLength(0); expect(h.state.calls).toHaveLength(0);
    });

    test.each(['organisation', 'tenant', 'subject', 'extra scope field'])('admission rejects changed %s before repository creation', async variant => {
        const h = harness(), { facade, context } = await h.ready(), scope = copy(context.scope), principal = copy(context.identity);
        if (variant === 'organisation') scope.organisationId = 'other-organisation';
        if (variant === 'tenant') scope.tenantId = 'other-tenant';
        if (variant === 'subject') principal.subjectKey = OTHER_SUBJECT;
        if (variant === 'extra scope field') scope.role = 'admin';
        const error = await rejected(facade.admission.readAdmissionSnapshot(scope, principal));
        expect(error).toBeInstanceOf(h.errors.DashboardPersistenceError);
        expect(error).toMatchObject({ code: 'dashboard_access_denied', statusCode: 403 });
        expect(h.state.operations).toHaveLength(0); expect(h.state.configurations).toHaveLength(0);
    });
});

describe('dashboard resource facade delegation and settled ownership', () => {
    test('preserves canonical admission shape and NCSC projections from the real projection functions', async () => {
        const h = harness(), { facade, context } = await h.ready();
        expect(await facade.admission.readAdmissionSnapshot(copy(context.scope), copy(context.identity))).toBe(RESULTS.admission);
        expect(await facade.ncsc.listNcscAssessments(context, { limit: 100, afterAssessmentId: null })).toBe(RESULTS.list);
        expect(await facade.ncsc.readNcscAssessment(context, { assessmentId: 'assessment-a' })).toBe(RESULTS.read);
        for (const command of [createCommand(), saveCommand(), submitCommand()]) {
            expect(await facade.ncsc.executeNcscAssessment(context, command)).toBe(RESULTS.actions[command.action]);
        }
        expect(h.state.operations.map(item => item.operation)).toEqual(['admission.read', 'ncsc.list', 'ncsc.read', 'ncsc.execute', 'ncsc.execute', 'ncsc.execute']);
        h.state.configurations.forEach((config, index) => {
            const pair = h.state.operations[index].pair;
            expect(config.database).toBe(pair.database); expect(config.clock).toBe(pair.clock);
            expect(config.authoriseAdministration({}, {})).toBe(false);
            if (index > 0) { expect(config.ncsc.audit).toBe(pair.audit); expect(config.ncsc.resolveSubmissionQuota).toBe(pair.resolveSubmissionQuota); }
            expect(pair.finish).toHaveBeenCalledTimes(1);
        });
        expect(h.state.calls.slice(1).every(call => call.args[0] === context)).toBe(true);
    });

    test('detaches and freezes a valid command before the awaited repository can observe caller mutation', async () => {
        const h = harness(), { facade, context } = await h.ready(), gate = deferred(), entered = deferred();
        h.state.behavior.execute = async () => { entered.resolve(); await gate.promise; return RESULTS.actions.create; };
        const command = createCommand(), pending = facade.ncsc.executeNcscAssessment(context, command);
        await entered.promise;
        command.assessmentId = 'replacement'; command.idempotencyKey = 'replacement'; command.payload.scopePopulation.description = 'replacement';
        const captured = h.state.calls[0].args[1];
        expect(captured).toEqual(createCommand()); expect(captured).not.toBe(command);
        expect(Object.isFrozen(captured)).toBe(true); expect(Object.isFrozen(captured.payload.scopePopulation)).toBe(true);
        expect(h.state.operations[0].pair.finish).not.toHaveBeenCalled();
        gate.resolve(); expect(await pending).toBe(RESULTS.actions.create);
        expect(h.state.operations[0].pair.finish).toHaveBeenCalledTimes(1);
    });

    test.each(['list', 'read', 'execute', 'admission'])('%s retains its operation until repository rejection settles', async method => {
        const h = harness(), { facade, context } = await h.ready(), gate = deferred(), entered = deferred();
        const original = method === 'admission' ? new h.errors.DashboardPersistenceError('unavailable', 503)
            : new h.errors.NcscAssessmentError('ncsc_unavailable', 503);
        h.state.behavior[method] = async () => { entered.resolve(); await gate.promise; throw original; };
        const pending = method === 'admission' ? facade.admission.readAdmissionSnapshot(context.scope, context.identity)
            : method === 'list' ? facade.ncsc.listNcscAssessments(context, { limit: 1, afterAssessmentId: null })
                : method === 'read' ? facade.ncsc.readNcscAssessment(context, { assessmentId: 'assessment-a' })
                    : facade.ncsc.executeNcscAssessment(context, createCommand());
        const observed = rejected(pending);
        await entered.promise; expect(h.state.operations[0].pair.finish).not.toHaveBeenCalled();
        gate.resolve(); expect(await observed).toBe(original);
        expect(h.state.operations[0].pair.finish).toHaveBeenCalledTimes(1);
        expect(h.state.operations).toHaveLength(1);
    });

    test.each([[400, 'ncsc_input_invalid'], [404, 'ncsc_not_found'], [409, 'ncsc_revision_conflict'],
        [413, 'ncsc_request_too_large'], [403, 'ncsc_access_denied'], [503, 'ncsc_outcome_ambiguous']])
    ('preserves the actual NCSC %s result and does not perform an outer retry', async (status, code) => {
        const h = harness(), { facade, context } = await h.ready(), original = new h.errors.NcscAssessmentError(code, status);
        h.state.behavior.execute = () => { throw original; };
        expect(await rejected(facade.ncsc.executeNcscAssessment(context, createCommand()))).toBe(original);
        expect(h.state.calls).toHaveLength(1); expect(h.state.operations[0].pair.finish).toHaveBeenCalledTimes(1);
    });

    test('maps only the actual missing selected owner to admission denial and keeps infrastructure unavailable', async () => {
        const h = harness(), { facade, context } = await h.ready();
        h.state.behavior.admission = () => { throw new h.errors.DashboardPersistenceError('not_found', 404); };
        const missing = await rejected(facade.admission.readAdmissionSnapshot(context.scope, context.identity));
        expect(missing).toBeInstanceOf(h.errors.DashboardPersistenceError);
        expect(missing).toMatchObject({ code: 'dashboard_access_denied', statusCode: 403 });
        h.state.behavior.admission = () => { throw { code: 'dashboard_access_denied', statusCode: 403 }; };
        expect(await rejected(facade.admission.readAdmissionSnapshot(context.scope, context.identity)))
            .toMatchObject({ code: 'dashboard_unavailable', statusCode: 503 });
    });

    test('arbitrary copied NCSC error fields cannot become an authority denial', async () => {
        const h = harness(), { facade, context } = await h.ready();
        h.state.behavior.read = () => { throw { name: 'NcscAssessmentError', code: 'ncsc_access_denied', statusCode: 403,
            detail: 'Synthetic private upstream detail' }; };
        const error = await rejected(facade.ncsc.readNcscAssessment(context, { assessmentId: 'assessment-a' }));
        expectNcsc(error, h, 'ncsc_unavailable', 503);
        expect(JSON.stringify(error)).not.toContain('private upstream');
        expect(h.state.operations[0].pair.finish).toHaveBeenCalledTimes(1);
    });
});

describe('dashboard resource facade pre-work validation', () => {
    test.each(['missing', 'uppercase', 'short', 'extra field', 'symbol', 'accessor', 'non-enumerable'])
    ('%s generation transport denies before binding and cannot poison a later valid call', async variant => {
        const h = harness(), request = {}, getter = jest.fn(() => GENERATION);
        h.add(request);
        const transport = { expectedGeneration: GENERATION };
        if (variant === 'missing') delete transport.expectedGeneration;
        if (variant === 'uppercase') transport.expectedGeneration = 'A'.repeat(64);
        if (variant === 'short') transport.expectedGeneration = GENERATION.slice(1);
        if (variant === 'extra field') transport.tenantId = RESULTS.scope.tenantId;
        if (variant === 'symbol') transport[Symbol('scope')] = RESULTS.scope;
        if (variant === 'accessor') Object.defineProperty(transport, 'expectedGeneration', { enumerable: true, get: getter });
        if (variant === 'non-enumerable') Object.defineProperty(transport, 'expectedGeneration', { enumerable: false, value: GENERATION });
        const error = await rejected(h.runtime.forRequest(request, transport));
        expect(error).toBeInstanceOf(h.errors.DashboardPersistenceError);
        expect(error).toMatchObject({ code: 'dashboard_access_denied', statusCode: 403 });
        expect(getter).not.toHaveBeenCalled(); expect(h.bindRequest).not.toHaveBeenCalled();
        expect(h.state.operations).toHaveLength(0); expect(h.state.configurations).toHaveLength(0);
        expect(await h.runtime.forRequest(request, { expectedGeneration: GENERATION })).toHaveProperty('ncsc');
        expect(h.bindRequest).toHaveBeenCalledTimes(1);
    });

    test.each([null, 'synthetic-request', () => {}])('invalid original request %p denies before the binder', async request => {
        const h = harness(), error = await rejected(h.runtime.forRequest(request, { expectedGeneration: GENERATION }));
        expect(error).toBeInstanceOf(h.errors.DashboardPersistenceError);
        expect(error).toMatchObject({ code: 'dashboard_access_denied', statusCode: 403 });
        expect(h.bindRequest).not.toHaveBeenCalled(); expect(h.state.operations).toHaveLength(0);
    });

    test.each([
        ['invalid page', 'listNcscAssessments', () => ({ limit: 101, afterAssessmentId: null }), 400],
        ['invalid selector', 'readNcscAssessment', () => ({ assessmentId: '*' }), 400],
        ['extra command field', 'executeNcscAssessment', () => ({ ...createCommand(), tenantId: 'other' }), 400],
        ['symbol command key', 'executeNcscAssessment', () => ({ ...createCommand(), [Symbol('hidden')]: true }), 400],
        ['NUL text', 'executeNcscAssessment', () => createCommand('assessment-a', 'key', 'bad\u0000text'), 400],
        ['oversized command', 'executeNcscAssessment', () => createCommand('assessment-a', 'key', 'x'.repeat(65537)), 413]
    ])('%s rejects before an operation, repository or policy hook', async (_label, method, input, status) => {
        const h = harness(), { facade, context } = await h.ready();
        const error = await rejected(facade.ncsc[method](context, input()));
        expectNcsc(error, h, status === 413 ? 'ncsc_request_too_large' : 'ncsc_input_invalid', status);
        expect(h.state.operations).toHaveLength(0); expect(h.state.calls).toHaveLength(0); expect(h.state.configurations).toHaveLength(0);
        expect(h.options.captureRequest).not.toHaveBeenCalled(); expect(h.options.resolveSubmissionQuota).not.toHaveBeenCalled();
    });

    test.each(['listNcscAssessments', 'readNcscAssessment', 'executeNcscAssessment'])('%s rejects accessors without invoking them', async method => {
        const h = harness(), { facade, context } = await h.ready(), getter = jest.fn(() => 'assessment-a');
        const input = method === 'listNcscAssessments' ? { limit: 1, afterAssessmentId: null }
            : method === 'readNcscAssessment' ? { assessmentId: 'assessment-a' } : createCommand();
        Object.defineProperty(input, method === 'listNcscAssessments' ? 'limit' : 'assessmentId', { enumerable: true, get: getter });
        expectNcsc(await rejected(facade.ncsc[method](context, input)), h, 'ncsc_input_invalid', 400);
        expect(getter).not.toHaveBeenCalled(); expect(h.state.operations).toHaveLength(0);
    });
});


// G: host calls pass through the real facade into a controlled fixed guard
// capability. Buffers below originate in the genuine typed service; these cases
// make no SQL/audit/final-authority claim, which belongs to the guard/PG suites.
const { createDashboardBufferedService } = require('../api/shared/dashboardService');
const { admissionFixture } = require('./fixtures/dashboardAdmissionFixture');
const { apiSecurityHeaders } = require('../api/shared/securityHeaders');
function frozenHostResponse(value) {
    expect(Object.keys(value).sort()).toEqual(['body', 'headers', 'isRaw', 'status']);
    const visit = item => {
        if (item && typeof item === 'object') { expect(Object.isFrozen(item)).toBe(true); Object.values(item).forEach(visit); }
    };
    visit(value);
}
function hostFailureResponse(value, status, code) {
    frozenHostResponse(value);
    expect(value).toEqual({ status, headers: apiSecurityHeaders({ 'Content-Type': 'application/json; charset=utf-8' }),
        body: { code }, isRaw: false });
    expect(JSON.stringify(value.body)).not.toContain('private');
}
function noOrdinaryResourceSetup(h) {
    expect(h.bindRequest).not.toHaveBeenCalled();
    // The preserved constructor creates one process-owned POR008 resolver.
    // Host work must neither bind that resolver nor construct another one.
    expect(h.state.contextFactories).toHaveLength(1);
    expect(h.state.operations).toHaveLength(0);
    expect(h.state.configurations).toHaveLength(0);
    expect(h.state.calls).toHaveLength(0);
    expect(h.options.resolveSubmissionQuota).not.toHaveBeenCalled();
}

describe('fixed host resource facade response boundary', () => {
    test('HN-F01 passes exact original request and detached transport once with genuine service buffers', async () => {
        const h = harness(), original = { method: 'GET' }, pending = deferred(), entered = deferred();
        const transport = { route: 'bootstrap', expectedGeneration: GENERATION };
        const succeeded = (await createDashboardBufferedService(admissionFixture().adapters).handleResource(original, 'bootstrap')).response;
        h.handleHostResource.mockImplementation(async (received, selected) => {
            expect(received).toBe(original); expect(selected).not.toBe(transport);
            expect(selected).toEqual({ route: 'bootstrap', expectedGeneration: GENERATION });
            expect(Object.isFrozen(selected)).toBe(true); entered.resolve(); await pending.promise; return succeeded;
        });
        const first = h.runtime.handleHostResource(original, transport);
        transport.route = 'modules/evidence'; transport.expectedGeneration = OTHER_GENERATION;
        const second = h.runtime.handleHostResource(original, { route: 'bootstrap', expectedGeneration: GENERATION });
        expect(second).toBe(first);
        await entered.promise;
        try { expect(h.handleHostResource).toHaveBeenCalledTimes(1); noOrdinaryResourceSetup(h); }
        finally { pending.resolve(); }
        expect(await first).toBe(succeeded); expect(await second).toBe(succeeded); frozenHostResponse(succeeded);
        const deniedRequest = { method: 'GET' };
        const denied = (await createDashboardBufferedService(admissionFixture({ role: 'viewer' }).adapters)
            .handleResource(deniedRequest, 'modules/cyber_security')).response;
        h.handleHostResource.mockResolvedValueOnce(denied);
        expect(await h.runtime.handleHostResource(deniedRequest, { route: 'modules/cyber_security', expectedGeneration: GENERATION })).toBe(denied);
        hostFailureResponse(denied, 403, 'dashboard_access_denied'); noOrdinaryResourceSetup(h);
    });

    test('HN-F02 interleaved host requests retain their own route generation and response', async () => {
        const h = harness(), a = { method: 'GET' }, b = { method: 'GET' }, holdA = deferred(), enteredA = deferred();
        const responseA = (await createDashboardBufferedService(admissionFixture().adapters).handleResource(a, 'modules/overview')).response;
        const responseB = (await createDashboardBufferedService(admissionFixture({ name: 'Second scoped organisation' }).adapters)
            .handleResource(b, 'bootstrap')).response;
        const order = [];
        h.handleHostResource.mockImplementation(async (original, transport) => {
            if (original === a) {
                expect(transport).toEqual({ route: 'modules/overview', expectedGeneration: GENERATION });
                order.push('A entered'); enteredA.resolve(); await holdA.promise; order.push('A returned'); return responseA;
            }
            expect(original).toBe(b); expect(transport).toEqual({ route: 'bootstrap', expectedGeneration: OTHER_GENERATION });
            order.push('B returned'); return responseB;
        });
        const first = h.runtime.handleHostResource(a, { route: 'modules/overview', expectedGeneration: GENERATION });
        await enteredA.promise;
        try {
            expect(await h.runtime.handleHostResource(b, { route: 'bootstrap', expectedGeneration: OTHER_GENERATION })).toBe(responseB);
            expect(order).toEqual(['A entered', 'B returned']);
        } finally { holdA.resolve(); }
        expect(await first).toBe(responseA); expect(order).toEqual(['A entered', 'B returned', 'A returned']);
        expect(responseA.body.module.key).toBe('overview'); expect(responseB.body.context.displayName).toBe('Second scoped organisation');
        expect(h.handleHostResource).toHaveBeenCalledTimes(2); noOrdinaryResourceSetup(h);
    });

    test('HN-F03 copied denial fields and unknown failures resolve sanitized unavailable without NCSC setup', async () => {
        const h = harness();
        for (const error of [Object.assign(new Error('private copied denial'), { code: 'dashboard_access_denied', statusCode: 403 }),
            { name: 'DashboardPersistenceError', code: 'dashboard_outcome_ambiguous', statusCode: 503, details: { private: true } },
            new Error('private unknown upstream')]) {
            h.handleHostResource.mockRejectedValueOnce(error);
            const response = await h.runtime.handleHostResource({ method: 'GET' }, { route: 'bootstrap', expectedGeneration: GENERATION });
            hostFailureResponse(response, 503, 'dashboard_unavailable');
        }
        expect(h.handleHostResource).toHaveBeenCalledTimes(3); noOrdinaryResourceSetup(h);
    });

    test('HF01 genuine guarded current refusal resolves closed403 without success or automatic retry', async () => {
        const h = harness(), original = { method: 'GET' };
        h.handleHostResource.mockRejectedValueOnce(new h.errors.DashboardPersistenceError('access_denied', 403));
        const response = await h.runtime.handleHostResource(original, { route: 'bootstrap', expectedGeneration: GENERATION });
        hostFailureResponse(response, 403, 'dashboard_access_denied');
        expect(await h.runtime.handleHostResource(original, { route: 'bootstrap', expectedGeneration: GENERATION })).toBe(response);
        expect(h.handleHostResource).toHaveBeenCalledTimes(1); noOrdinaryResourceSetup(h);
    });

    test('HF02 genuine guarded unavailable resolves closed503 without success or automatic retry', async () => {
        const h = harness(), original = { method: 'GET' };
        h.handleHostResource.mockRejectedValueOnce(new h.errors.DashboardPersistenceError('unavailable', 503));
        const response = await h.runtime.handleHostResource(original, { route: 'bootstrap', expectedGeneration: GENERATION });
        hostFailureResponse(response, 503, 'dashboard_unavailable');
        expect(await h.runtime.handleHostResource(original, { route: 'bootstrap', expectedGeneration: GENERATION })).toBe(response);
        expect(h.handleHostResource).toHaveBeenCalledTimes(1); noOrdinaryResourceSetup(h);
    });

    test('HF03 genuine unproved guarded outcome resolves closed ambiguous503 without automatic retry', async () => {
        const h = harness(), original = { method: 'GET' };
        h.handleHostResource.mockRejectedValueOnce(new h.errors.DashboardPersistenceError('outcome_ambiguous', 503));
        const response = await h.runtime.handleHostResource(original, { route: 'bootstrap', expectedGeneration: GENERATION });
        hostFailureResponse(response, 503, 'dashboard_outcome_ambiguous');
        expect(await h.runtime.handleHostResource(original, { route: 'bootstrap', expectedGeneration: GENERATION })).toBe(response);
        expect(h.handleHostResource).toHaveBeenCalledTimes(1); noOrdinaryResourceSetup(h);
    });
});


describe('request-bound evidence metadata facade', () => {
    test('pairs only the evidence operation with its database clock and audit, retaining ownership until settlement', async () => {
        const h = harness(), { facade, context } = await h.ready(), entered = deferred(), gate = deferred();
        const result = Object.freeze({ schemaVersion: 1, artefact: null });
        h.state.behavior.evidence = async () => { entered.resolve(); await gate.promise; return result; };
        const selector = { artefactId: 'synthetic-evidence' };
        const pending = facade.evidence.readEvidenceMetadata(context, selector);
        await entered.promise;
        const { pair, operation } = h.state.operations[0];
        expect(operation).toBe('evidence.read');
        expect(h.state.evidenceConfigurations).toEqual([{ database: pair.database, clock: pair.clock, audit: pair.audit }]);
        expect(h.state.calls[0].args[0]).toBe(context);
        expect(h.state.calls[0].args[1]).toEqual(selector);
        expect(h.state.calls[0].args[1]).not.toBe(selector);
        expect(Object.isFrozen(h.state.calls[0].args[1])).toBe(true);
        selector.artefactId = 'changed-after-call';
        expect(h.state.calls[0].args[1].artefactId).toBe('synthetic-evidence');
        expect(pair.finish).not.toHaveBeenCalled();
        gate.resolve(); expect(await pending).toBe(result);
        expect(pair.finish).toHaveBeenCalledTimes(1);
        expect(pair.resolveSubmissionQuota).not.toHaveBeenCalled();
        expect(h.state.configurations).toHaveLength(0);
    });
    test('copied and other-request branded contexts deny before allocating an operation', async () => {
        const h = harness(), first = await h.ready(), second = await h.ready();
        // Both requests deliberately have identical serialized fields; identity of
        // the branded context still ties access to the originating request.
        expect(second.context).toEqual(first.context);
        for (const context of [copy(first.context), second.context]) {
            const error = await rejected(first.facade.evidence.readEvidenceMetadata(context, { artefactId: 'synthetic-evidence' }));
            expect(error).toBeInstanceOf(h.errors.EvidenceMetadataError);
            expect(error).toMatchObject({ code: 'evidence_access_denied', statusCode: 403 });
        }
        expect(h.state.operations).toHaveLength(0); expect(h.state.calls).toHaveLength(0);
    });
    test('hostile or tenant-selecting evidence input never reaches a repository', async () => {
        const h = harness(), { facade, context } = await h.ready(), getter = jest.fn();
        const accessor = {}; Object.defineProperty(accessor, 'artefactId', { enumerable: true, get: getter });
        for (const input of [accessor, { artefactId: 'evidence', tenantId: 'other' }, { artefactId: '' },
            { artefactId: 'evidence', [Symbol('scope')]: 'other' }]) {
            const error = await rejected(facade.evidence.readEvidenceMetadata(context, input));
            expect(error).toBeInstanceOf(h.errors.EvidenceMetadataError);
            expect(error).toMatchObject({ code: 'evidence_input_invalid', statusCode: 400 });
        }
        expect(getter).not.toHaveBeenCalled(); expect(h.state.operations).toHaveLength(0);
    });
    test.each([[403, 'evidence_access_denied'], [404, 'evidence_not_found'], [503, 'evidence_unavailable']])
    ('preserves typed %s evidence failure and finishes once without retry', async (statusCode, code) => {
        const h = harness(), { facade, context } = await h.ready();
        const original = new h.errors.EvidenceMetadataError(code, statusCode);
        h.state.behavior.evidence = async () => { throw original; };
        expect(await rejected(facade.evidence.readEvidenceMetadata(context, { artefactId: 'synthetic-evidence' }))).toBe(original);
        expect(h.state.calls).toHaveLength(1); expect(h.state.operations[0].pair.finish).toHaveBeenCalledTimes(1);
    });
    test('copied error fields cannot manufacture an evidence denial', async () => {
        const h = harness(), { facade, context } = await h.ready();
        h.state.behavior.evidence = () => { throw { code: 'evidence_access_denied', statusCode: 403, secret: 'private-upstream' }; };
        const error = await rejected(facade.evidence.readEvidenceMetadata(context, { artefactId: 'synthetic-evidence' }));
        expect(error).toBeInstanceOf(h.errors.EvidenceMetadataError);
        expect(error).toMatchObject({ code: 'evidence_unavailable', statusCode: 503 });
        expect(JSON.stringify(error)).not.toContain('private-upstream');
        expect(h.state.operations[0].pair.finish).toHaveBeenCalledTimes(1);
    });
});
