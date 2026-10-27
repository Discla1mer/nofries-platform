'use strict';

// Trusted, uninstalled request composition. No HTTP/auth/environment factory.
const { AsyncLocalStorage } = require('node:async_hooks');
const { createDashboardRequestDatabase } = require('./database/dashboardRequestDatabase');
const { createTenantRequestContext, requireTenantRequestContext } = require('./appLifecycle/tenantRequestContext');
const { createPostgresDashboardRepository, DashboardPersistenceError } = require('./appLifecycle/postgresDashboardRepository');
const { NcscAssessmentError, normaliseNcscCommand, normaliseNcscPage, normaliseNcscSelector } = require('./ncscAssessmentService');
const { copy, fields, freeze, equal, scope, subject, digest } = require('./appLifecycle/dashboardRuntimeRecords');
const { hostResourceForRoute } = require('./appLifecycle/dashboardRuntimeEvents');
const { createPostgresEvidenceMetadataRepository } = require('./appLifecycle/postgresEvidenceMetadataRepository');
const { EvidenceMetadataError, normaliseEvidenceMetadataSelector } = require('./evidenceMetadataService');
const { createImprovementActionPlanSource } = require('./improvementPlan/improvementActionPlanSource');
const { ImprovementPlanServiceError, normaliseImprovementCommand, normaliseImprovementSelector, serviceError } = require('./improvementPlan/improvementPlanService');
const { normaliseImprovementActionListSelector, normaliseImprovementPlanPage,
    actionListError } = require('./improvementPlan/improvementActionListService');
const { ImprovementActionListError } = require('./improvementPlan/improvementActionListProjection');
const { ConsultantWorkQueueError, normaliseConsultantWorkQueuePage,
    createConsultantWorkQueueService } = require('./improvementPlan/consultantWorkQueueService');
const { apiSecurityHeaders } = require('./securityHeaders');

const denied = () => new DashboardPersistenceError('access_denied', 403);
const unavailable = () => new DashboardPersistenceError('unavailable', 503);
const ncscDenied = () => new NcscAssessmentError('ncsc_access_denied', 403);

function createDashboardResourceRuntime(options) {
    const binder = createDashboardRequestDatabase(options);
    // Capture the validated trusted opt-in before any request or await. The
    // production host supplies none while schema/audit readiness is unproved.
    const improvementEnabled = options.improvementEnabled === true;
    const queueClock = options.clock;
    const requests = new WeakMap();
    // Correlation only. Authority and active SQL handles never enter this store.
    const correlation = new AsyncLocalStorage();

    function bound(request) {
        const entry = request && typeof request === 'object' && requests.get(request);
        if (!entry || !entry.binding) throw denied();
        return entry.binding;
    }
    function principal(input, expected) {
        let value;
        try {
            value = fields(copy(input, 16384), ['authenticated', 'subjectKey']);
            subject(value.subjectKey);
        } catch (_) { throw denied(); }
        if (value.authenticated !== true || value.subjectKey !== expected.subjectKey) throw denied();
        return freeze(value);
    }
    const resolver = createTenantRequestContext({
        authenticate: async request => bound(request).identity,
        resolveScope: async (request, identity) => {
            const binding = bound(request);
            principal(identity, binding.identity);
            return binding.scope;
        },
        createRequestId: () => bound(correlation.getStore()).requestId,
        clock: () => bound(correlation.getStore()).resolvedAt
    });

    function forRequest(request, transport) {
        let expectedGeneration;
        try {
            if (!request || typeof request !== 'object') throw denied();
            const selected = fields(copy(transport, 16384), ['expectedGeneration']);
            expectedGeneration = digest(selected.expectedGeneration);
        } catch (_) { return Promise.reject(denied()); }
        const existing = requests.get(request);
        if (existing) return existing.mode === 'binding' && existing.expectedGeneration === expectedGeneration ? existing.promise : Promise.reject(denied());

        const entry = { mode: 'binding', expectedGeneration, binding: null, promise: null };
        entry.promise = Promise.resolve().then(async () => {
            const binding = await binder.bindRequest(request, { expectedGeneration });
            entry.binding = binding;
            const context = await correlation.run(request, () => resolver.resolve(request));

            async function invoke(operation, method, args) {
                let pair;
                const ncsc = ['ncsc.list', 'ncsc.read', 'ncsc.execute'].includes(operation);
                const evidence = operation === 'evidence.read';
                try {
                    pair = binding.createOperation(operation);
                    const configured = { database: pair.database, clock: pair.clock, authoriseAdministration: () => false };
                    if (ncsc) configured.ncsc = { audit: pair.audit, resolveSubmissionQuota: pair.resolveSubmissionQuota };
                    const repository = evidence
                        ? createPostgresEvidenceMetadataRepository({ database: pair.database, clock: pair.clock, audit: pair.audit })
                        : createPostgresDashboardRepository(configured);
                    return await repository[method](...args);
                } catch (error) {
                    if (evidence) {
                        if (error instanceof EvidenceMetadataError) throw error;
                        throw new EvidenceMetadataError('evidence_unavailable', 503);
                    }
                    if (ncsc) {
                        if (error instanceof NcscAssessmentError) throw error;
                        throw new NcscAssessmentError('ncsc_unavailable', 503);
                    }
                    if (error instanceof DashboardPersistenceError) {
                        if (error.statusCode === 404) throw denied();
                        throw error;
                    }
                    throw unavailable();
                } finally {
                    if (pair) pair.finish();
                }
            }
            function matchingContext(value) {
                if (value !== context) throw ncscDenied();
                try { requireTenantRequestContext(value); } catch (_) { throw ncscDenied(); }
                return value;
            }
            function sameRequest(value) {
                if (value !== request) throw denied();
                return context;
            }
            const requestContext = Object.freeze({
                resolve(value) {
                    try { return Promise.resolve(sameRequest(value)); } catch (error) { return Promise.reject(error); }
                },
                async authenticate(value) { return sameRequest(value).identity; },
                async resolveScope(value, identity) {
                    const selected = sameRequest(value);
                    principal(identity, selected.identity);
                    return selected.scope;
                }
            });
            async function improvement(method, input) {
                // Capture caller data before the first await or pair ownership.
                const execute = method === 'execute';
                const selected = execute ? normaliseImprovementCommand(input) : method === 'plans'
                    ? normaliseImprovementPlanPage(input) : method === 'editor'
                        ? normaliseImprovementSelector(input) : normaliseImprovementActionListSelector(input);
                let pair;
                try {
                    pair = binding.createOperation(execute ? 'improvement.execute' : 'improvement.list', context);
                    const source = createImprovementActionPlanSource({ database: pair.database,
                        clock: pair.clock, audit: pair.audit, requestContext });
                    const result = await source[method](request, selected);
                    // Include presentation and asynchronous resumption in this
                    // invocation's original monotonic request budget.
                    pair.clock();
                    return result;
                } catch (error) {
                    throw execute || method === 'editor' && error instanceof ImprovementPlanServiceError
                        ? serviceError(error) : actionListError(error);
                }
                finally { if (pair) pair.finish(); }
            }
            return Object.freeze({
                requestContext,
                ...(improvementEnabled ? { improvement: Object.freeze({
                    plans: input => improvement('plans', input),
                    list: input => improvement('list', input),
                    view: input => improvement('view', input),
                    editor: input => improvement('editor', input),
                    execute: input => improvement('execute', input)
                }) } : {}),
                admission: Object.freeze({
                    async readAdmissionSnapshot(scopeInput, principalInput) {
                        let selected;
                        try { selected = freeze(scope(copy(scopeInput, 16384))); } catch (_) { throw denied(); }
                        const identity = principal(principalInput, binding.identity);
                        if (!equal(selected, binding.scope)) throw denied();
                        return invoke('admission.read', 'readAdmissionSnapshot', [selected, identity]);
                    }
                }),
                evidence: Object.freeze({
                    async readEvidenceMetadata(contextInput, selector) {
                        if (contextInput !== context) throw new EvidenceMetadataError('evidence_access_denied', 403);
                        try { requireTenantRequestContext(contextInput); }
                        catch (_) { throw new EvidenceMetadataError('evidence_access_denied', 403); }
                        const input = normaliseEvidenceMetadataSelector(selector);
                        return invoke('evidence.read', 'readEvidenceMetadata', [contextInput, input]);
                    }
                }),
                ncsc: Object.freeze({
                    async listNcscAssessments(contextInput, page) {
                        const selected = matchingContext(contextInput), input = normaliseNcscPage(page);
                        return invoke('ncsc.list', 'listNcscAssessments', [selected, input]);
                    },
                    async readNcscAssessment(contextInput, selector) {
                        const selected = matchingContext(contextInput), input = normaliseNcscSelector(selector);
                        return invoke('ncsc.read', 'readNcscAssessment', [selected, input]);
                    },
                    async executeNcscAssessment(contextInput, command) {
                        const selected = matchingContext(contextInput), input = normaliseNcscCommand(command);
                        return invoke('ncsc.execute', 'executeNcscAssessment', [selected, input]);
                    }
                })
            });
        });
        requests.set(request, entry);
        return entry.promise;
    }
    function hostFailure(error) {
        let status = 503, code = 'dashboard_unavailable';
        if (error instanceof DashboardPersistenceError &&
            ((error.code === 'dashboard_access_denied' && error.statusCode === 403) ||
             (['dashboard_unavailable', 'dashboard_outcome_ambiguous'].includes(error.code) && error.statusCode === 503))) {
            status = error.statusCode; code = error.code;
        }
        return freeze({ status, headers: apiSecurityHeaders({ 'Content-Type': 'application/json; charset=utf-8' }),
            body: { code }, isRaw: false });
    }
    function readWorkQueue(request, transport, input) {
        let expectedGeneration, page;
        try {
            if (!improvementEnabled || !request || typeof request !== 'object') throw denied();
            expectedGeneration = digest(fields(copy(transport, 16384), ['expectedGeneration']).expectedGeneration);
            page = normaliseConsultantWorkQueuePage(input);
        } catch (error) { return Promise.reject(queueError(error)); }
        const key = JSON.stringify(page), existing = requests.get(request);
        if (existing) return existing.mode === 'portfolio' && existing.expectedGeneration === expectedGeneration && existing.key === key
            ? existing.promise.then(value => { assertWorkQueueDisclosure(request); return value; })
            : Promise.reject(new ConsultantWorkQueueError('work_queue_access_denied', 403));
        const entry = { mode: 'portfolio', expectedGeneration, key, promise: null, assertDisclosure: null };
        entry.promise = Promise.resolve().then(async () => {
            const portfolio = await binder.bindPortfolioRequest(request, { expectedGeneration });
            entry.assertDisclosure = () => portfolio.assertDisclosure();
            const targets = new Map();
            async function target(bindingId) {
                if (!targets.has(bindingId)) targets.set(bindingId, (async () => {
                    const binding = await portfolio.bindTarget(bindingId);
                    const requestContext = createTenantRequestContext({
                        authenticate: async candidate => { if (candidate !== request) throw denied(); return binding.identity; },
                        resolveScope: async (candidate, identity) => {
                            if (candidate !== request) throw denied(); principal(identity, binding.identity); return binding.scope;
                        },
                        createRequestId: () => binding.requestId, clock: () => binding.resolvedAt
                    });
                    const context = await requestContext.resolve(request);
                    return { binding, requestContext, context };
                })());
                return targets.get(bindingId);
            }
            async function read(bindingId, name, selected) {
                let pair;
                try {
                    const boundTarget = await target(bindingId);
                    pair = boundTarget.binding.createOperation('improvement.list', boundTarget.context);
                    const source = createImprovementActionPlanSource({ database: pair.database, clock: pair.clock,
                        audit: pair.audit, requestContext: boundTarget.requestContext });
                    const value = await source[name](request, selected);
                    pair.clock(); return value;
                } finally { if (pair) pair.finish(); }
            }
            const result = await createConsultantWorkQueueService({ generation: expectedGeneration, clock: queueClock,
                listBindings: pageInput => portfolio.listBindings(pageInput),
                plans: (bindingId, pageInput) => read(bindingId, 'plans', pageInput),
                list: (bindingId, selector) => read(bindingId, 'list', selector),
                finish: () => portfolio.finish(), assertDisclosure: () => portfolio.assertDisclosure() }).read(page);
            portfolio.assertDisclosure();
            return result;
        }).catch(error => { throw queueError(error); });
        requests.set(request, entry);
        return entry.promise;
    }
    function assertWorkQueueDisclosure(request) {
        try {
            const entry = requests.get(request);
            if (!entry || entry.mode !== 'portfolio' || !entry.assertDisclosure) throw denied();
            return entry.assertDisclosure();
        } catch (error) { throw queueError(error); }
    }
    function queueError(error) {
        if (error instanceof ConsultantWorkQueueError) return error;
        if ((error instanceof DashboardPersistenceError && error.code === 'dashboard_access_denied' ||
            error instanceof ImprovementActionListError && error.code === 'improvement_list_access_denied' ||
            error instanceof ImprovementPlanServiceError && error.code === 'improvement_access_denied') && error.statusCode === 403) {
            return new ConsultantWorkQueueError('work_queue_access_denied', 403);
        }
        return new ConsultantWorkQueueError();
    }
    function handleHostResource(request, transport) {
        let selected;
        try {
            if (!request || typeof request !== 'object') throw denied();
            selected = fields(copy(transport, 16384), ['route', 'expectedGeneration']);
            const resource = hostResourceForRoute(selected.route);
            if (resource.requiresGeneration) digest(selected.expectedGeneration);
            else if (selected.expectedGeneration !== null) throw denied();
            selected = freeze(selected);
        } catch (_) { return Promise.resolve(hostFailure(denied())); }
        const existing = requests.get(request);
        if (existing) return existing.mode === 'host' && existing.route === selected.route &&
            existing.expectedGeneration === selected.expectedGeneration ? existing.promise : Promise.resolve(hostFailure(denied()));
        // Install before entering the trusted binder, including reentrant calls
        // from its clock/ID/capture adapters. No host authority enters the ALS.
        const entry = { mode: 'host', route: selected.route, expectedGeneration: selected.expectedGeneration, promise: null };
        entry.promise = Promise.resolve().then(() => binder.handleHostResource(request, selected)).catch(hostFailure);
        requests.set(request, entry);
        return entry.promise;
    }
    return Object.freeze({ forRequest, handleHostResource, ...(improvementEnabled ? { readWorkQueue, assertWorkQueueDisclosure } : {}) });
}

module.exports = { createDashboardResourceRuntime };
