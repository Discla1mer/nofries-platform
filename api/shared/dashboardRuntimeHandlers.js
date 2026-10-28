'use strict';

// Explicit internal composition. Merely importing this factory installs no
// routes, provider, runtime, publication capability or customer admission.
const { AsyncLocalStorage } = require('node:async_hooks');
const { IncomingMessage } = require('node:http');
const { TextDecoder } = require('node:util');
const { isProxy } = require('node:util').types;
const { BrowserAuthError, createBrowserAuthService, assertExactSameOriginRequest } = require('./browserAuth');
const { createDashboardOperatorSession, createDashboardCustomerSession } = require('./dashboardOperatorSession');
const { createDashboardOperatorLogoutService } = require('./dashboardOperatorLogout');
const { createPostgresDashboardRuntimeRepository } = require('./appLifecycle/postgresDashboardRuntimeRepository');
const { createDashboardResourceRuntime } = require('./dashboardRuntime');
const { EvidenceMetadataError, normaliseEvidenceMetadataSelector, createEvidenceMetadataService } = require('./evidenceMetadataService');
const { createNcscAssessmentService } = require('./ncscAssessmentService');
const { createNcscAssessmentHandlers } = require('./ncscAssessmentHandlers');
const { ImprovementPlanServiceError, normaliseImprovementCommand, normaliseImprovementSelector } = require('./improvementPlan/improvementPlanService');
const { ImprovementActionListError } = require('./improvementPlan/improvementActionListProjection');
const { normaliseImprovementActionListSelector, normaliseImprovementPlanPage } = require('./improvementPlan/improvementActionListService');
const { ConsultantWorkQueueError, normaliseConsultantWorkQueuePage } = require('./improvementPlan/consultantWorkQueueService');
const { DashboardPersistenceError } = require('./appLifecycle/postgresDashboardBootstrap');
const { DashboardOnboardingError } = require('./appLifecycle/dashboardOnboardingDomain');
const { copy, fields, freeze, uuid, digest, instant } = require('./appLifecycle/dashboardRuntimeRecords');
const { hostResourceForRoute } = require('./appLifecycle/dashboardRuntimeEvents');
const { apiSecurityHeaders } = require('./securityHeaders');

const CONFIG = ['browserAuthOptions', 'identityPolicy', 'proofStore', 'clock', 'readExternalRuntimeEpoch',
    'newRequestId', 'requestBudgetMs', 'pool', 'instanceId', 'historyBudget', 'newId', 'newGenerationToken', 'newOperationId'];
const AUTH = ['env', 'store', 'clientApplication', 'cryptoProvider', 'randomBytes'];
const STORE = ['createTransaction', 'consumeTransaction', 'deleteTransaction', 'createSession', 'loadSession', 'deleteSession'];
const HEADER_NAMES = ['cookie', 'origin', 'sec-fetch-site', 'x-nofries-dashboard-generation', 'x-nofries-dashboard-purpose', 'content-type', 'content-encoding'];
const MAX_WIRE = 524288;
const unavailable = () => new BrowserAuthError(503, 'browser_auth_dashboard_unavailable');
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
class HostError extends Error {
    constructor(status, code, headers = {}) { super(code); this.status = status; this.code = code; this.headers = headers; }
}
const fail = (status, code, headers) => { throw new HostError(status, code, headers); };
const bad = () => fail(400, 'dashboard_input_invalid');

function dataKeys(value) {
    if (!value || typeof value !== 'object' || isProxy(value)) throw unavailable();
    const keys = Reflect.ownKeys(value);
    fields(value, keys);
    return keys;
}
function environmentSnapshot(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) throw unavailable();
    // Node's native process.env has its own prototype. Retain only detached
    // enumerable data fields; never read inherited authority or invoke getters.
    const snapshot = {};
    for (const key of Reflect.ownKeys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (typeof key !== 'string' || !descriptor || !own(descriptor, 'value')) throw unavailable();
        if (descriptor.enumerable) Object.defineProperty(snapshot, key, { value: descriptor.value, enumerable: true });
    }
    return freeze(copy(snapshot, 32768));
}
function method(object, name, optional = false) {
    if (!object || typeof object !== 'object' || isProxy(object)) throw unavailable();
    let current = object;
    while (current !== null) {
        if (isProxy(current)) throw unavailable();
        const descriptor = Object.getOwnPropertyDescriptor(current, name);
        if (descriptor) {
            if (!own(descriptor, 'value') || typeof descriptor.value !== 'function' || isProxy(descriptor.value)) throw unavailable();
            return descriptor.value.bind(object);
        }
        current = Object.getPrototypeOf(current);
    }
    if (optional) return null;
    throw unavailable();
}
function response(status, body, extra = {}) {
    return freeze({ status, headers: apiSecurityHeaders({ 'Content-Type': 'application/json; charset=utf-8', ...extra }), body, isRaw: false });
}
function logFailure(category, status, code) {
    try { console.warn('Dashboard request failed: ' + JSON.stringify({ route: category, status, code })); } catch (_) { /* Logging cannot grant access. */ }
}
function failure(error, category) {
    let status = 503, code = 'dashboard_unavailable', headers = {};
    if (error instanceof HostError) ({ status, code, headers } = error);
    else if (error instanceof DashboardOnboardingError) {
        const known = {
            onboarding_input_invalid: [400, 'dashboard_input_invalid'],
            onboarding_access_denied: [403, 'dashboard_access_denied'],
            onboarding_conflict: [409, 'dashboard_conflict'],
            onboarding_request_too_large: [413, 'dashboard_request_too_large'],
            onboarding_outcome_ambiguous: [503, 'dashboard_outcome_ambiguous']
        };
        if (own(known, error.code) && known[error.code][0] === error.statusCode) [status, code] = known[error.code];
    } else if (error instanceof EvidenceMetadataError) {
        const known = { evidence_input_invalid: 400, evidence_access_denied: 403,
            evidence_not_found: 404, evidence_unavailable: 503 };
        if (own(known, error.code) && known[error.code] === error.statusCode) { status = error.statusCode; code = error.code; }
    } else if (error instanceof ConsultantWorkQueueError) {
        const known = { work_queue_input_invalid: 400, work_queue_access_denied: 403,
            work_queue_changed: 409, work_queue_unavailable: 503 };
        code = 'work_queue_unavailable';
        if (own(known, error.code) && known[error.code] === error.statusCode) { status = error.statusCode; code = error.code; }
    } else if (error instanceof ImprovementPlanServiceError || error instanceof ImprovementActionListError) {
        const known = error instanceof ImprovementActionListError ? {
            improvement_list_input_invalid: 400, improvement_list_access_denied: 403,
            improvement_list_not_found: 404, improvement_list_scope_mismatch: 404,
            improvement_list_time_conflict: 409, improvement_list_unavailable: 503
        } : {
            improvement_input_invalid: 400, improvement_access_denied: 403, improvement_not_found: 404,
            improvement_action_not_found: 404, improvement_scope_mismatch: 404,
            improvement_operation_conflict: 409, improvement_state_conflict: 409,
            improvement_revision_conflict: 409, improvement_source_conflict: 409,
            improvement_owner_ineligible: 409, improvement_transition_invalid: 409,
            improvement_history_limit: 409, improvement_time_regression: 409,
            improvement_outcome_ambiguous: 503, improvement_unavailable: 503
        };
        code = error instanceof ImprovementActionListError ? 'improvement_list_unavailable' : 'improvement_unavailable';
        if (own(known, error.code) && known[error.code] === error.statusCode) { status = error.statusCode; code = error.code; }
    }
    // A fixed route category, status and code are the whole unauthenticated log.
    // No URL, input, cookie, identity, provider exception or driver data enters it.
    logFailure(category, status, code);
    return response(status, { code }, headers);
}

function createDashboardRuntimeHandlers(configuration) {
    const ledger = new AsyncLocalStorage(), requests = new WeakMap();
    const ambiguousErrors = new WeakSet(), ambiguousResponses = new WeakSet();
    let supplied, authOptions, options, clock, budget, browser, operator, runtime, logout, resources, ncscQuota = null, customerBrowser = null, customerSession = null, customerLogout = null, activationBinding = null;
    let activationPort = null, adminSubjects = new Set(), customerIdentityProvider, improvementEnabled = false;
    let externalBrowser = null, externalSession = null, externalLogout = null, externalBinding = null, externalAuth = null;

    function hostClock() {
        const entry = ledger.getStore();
        if (!entry || entry.initialising || entry.settled || entry.expired) throw unavailable();
        try {
            const value = instant(clock()), at = Date.parse(value);
            if (at < entry.lastAt || at >= entry.deadline || entry.expired || entry.settled) throw unavailable();
            entry.lastAt = at;
            return value;
        } catch (_) { entry.expired = true; throw unavailable(); }
    }
    async function bounded(work, owner = null) {
        hostClock();
        let value, error, failed = false;
        try { value = await work(); } catch (caught) { error = caught; failed = true; }
        // Only the direct, privately constructed runtime call can establish this
        // provenance. Provider-supplied codes never enter these sets. Expiry may
        // withhold success, but cannot turn an unresolved commit into certainty.
        if (owner === 'runtime' && failed && error instanceof DashboardOnboardingError &&
            error.statusCode === 503 && error.code === 'onboarding_outcome_ambiguous') ambiguousErrors.add(error);
        if (owner === 'improvement' && failed && error instanceof ImprovementPlanServiceError &&
            error.statusCode === 503 && error.code === 'improvement_outcome_ambiguous') ambiguousErrors.add(error);
        if (owner === 'ncsc' && !failed && value && value.status === 503 && value.isRaw === false &&
            value.body && Object.keys(value.body).length === 1 && value.body.code === 'ncsc_outcome_ambiguous') ambiguousResponses.add(value);
        if (owner === 'resource' && !failed && value && value.status === 503 && value.isRaw === false &&
            value.body && Object.keys(value.body).length === 1 && value.body.code === 'dashboard_outcome_ambiguous') ambiguousResponses.add(value);
        try { hostClock(); }
        catch (closed) {
            if (failed && ambiguousErrors.has(error)) throw error;
            if (!failed && ambiguousResponses.has(value)) return value;
            if (owner === 'wire' && failed && ledger.getStore().wireFailure === error) throw error;
            throw closed;
        }
        if (failed) throw error;
        return value;
    }
    function provider(fn, { load = false, consume = false, transferTokenResult = false, customerStage = null } = {}) {
        return async (...args) => {
            hostClock();
            let value;
            try { value = await fn(...args); } catch (cause) {
                // Only known auth errors cross this trusted policy boundary.
                // Never log provider messages, token claims, cookies or emails.
                if (customerStage && cause instanceof BrowserAuthError) throw cause;
                const error = unavailable();
                if (customerStage) error.diagnosticStage = customerStage;
                throw error;
            }
            // Genuine completeLogin must own every successfully acquired token
            // result before its clock validation can fail. Its finally then
            // awaits token-cache cleanup, including after this host expires.
            if (transferTokenResult) return value;
            try {
                hostClock();
                if (load) {
                    if (value === undefined) throw unavailable();
                    return value === null ? null : freeze(copy(value, 16384));
                }
                return value;
            } catch (_) {
                const error = unavailable();
                // The original transaction has actually settled. A deadline
                // failure cannot make its one-use cookie useful again.
                if (consume && value) error.clearTransactionCookie = true;
                throw error;
            }
        };
    }
    function identifier(fn) {
        return () => { hostClock(); try { return fn(); } catch (_) { throw unavailable(); } };
    }
    try {
        const configurationKeys = dataKeys(configuration);
        fields(configuration, [...CONFIG, ...['ncsc', 'improvementEnabled', 'customer', 'externalCustomer', 'activation'].filter(key => configurationKeys.includes(key))]);
        if (configurationKeys.includes('improvementEnabled')) {
            if (configuration.improvementEnabled !== true) throw unavailable();
            improvementEnabled = true;
        }
        if (configurationKeys.includes('ncsc')) {
            fields(configuration.ncsc, ['resolveSubmissionQuota']);
            ncscQuota = configuration.ncsc.resolveSubmissionQuota;
            if (typeof ncscQuota !== 'function' || isProxy(ncscQuota)) throw unavailable();
        }
        supplied = Object.fromEntries(CONFIG.map(key => [key, configuration[key]]));
        const authKeys = dataKeys(supplied.browserAuthOptions);
        if (!authKeys.includes('env') || !authKeys.includes('store') || authKeys.some(key => !AUTH.includes(key))) throw unavailable();
        authOptions = Object.fromEntries(authKeys.map(key => [key, supplied.browserAuthOptions[key]]));
        authOptions.env = environmentSnapshot(authOptions.env);
        if (configurationKeys.includes('activation')) {
            fields(configuration.activation, ['read', 'writeCompletion']);
            activationPort = Object.freeze({ read: provider(method(configuration.activation, 'read')),
                writeCompletion: provider(method(configuration.activation, 'writeCompletion')) });
            const values = String(authOptions.env.NOFRIES_ADMIN_SUBJECTS || '').split(/[,;\n]/).map(value => value.trim().toLowerCase()).filter(Boolean);
            if (!values.length || values.some(value => !/^[0-9a-f-]{36}:[0-9a-f-]{36}$/.test(value))) throw unavailable();
            for (const value of values) value.split(':').forEach(uuid);
            adminSubjects = new Set(values);
        }
        if (String(authOptions.env.NOFRIES_REQUIRE_AUTH || '').trim().toLowerCase() === 'false') throw unavailable();
        const policy = freeze(copy(supplied.identityPolicy, 16384));
        fields(policy, ['policyId', 'policyRevision', 'issuer', 'identityTenantId', 'audience']);
        fields(supplied.proofStore, ['createOriginalProof', 'readOriginalProof']);
        const originalStore = Object.fromEntries(STORE.map(name => [name, method(authOptions.store, name)]));
        const cancelTransaction = configurationKeys.includes('externalCustomer')
            ? method(authOptions.store, 'cancelTransaction', true) : null;
        const proof = Object.fromEntries(['createOriginalProof', 'readOriginalProof'].map(name => [name, method(supplied.proofStore, name)]));
        const connect = method(supplied.pool, 'connect'), end = method(supplied.pool, 'end');
        clock = supplied.clock; budget = supplied.requestBudgetMs;
        for (const key of ['clock', 'readExternalRuntimeEpoch', 'newRequestId', 'newId', 'newGenerationToken', 'newOperationId']) {
            if (typeof supplied[key] !== 'function' || isProxy(supplied[key])) throw unavailable();
        }
        if (!Number.isSafeInteger(budget) || budget <= 0 || budget > 60000) throw unavailable();
        authOptions.store = Object.freeze({ ...Object.fromEntries(STORE.map(name => [name,
            provider(originalStore[name], { load: name === 'loadSession', consume: name === 'consumeTransaction' })])),
            ...(cancelTransaction ? { cancelTransaction: provider(cancelTransaction) } : {}) });
        if (own(authOptions, 'clientApplication')) {
            const client = authOptions.clientApplication;
            const cache = method(client, 'getTokenCache', true);
            authOptions.clientApplication = Object.freeze({
                getAuthCodeUrl: provider(method(client, 'getAuthCodeUrl')),
                acquireTokenByCode: provider(method(client, 'acquireTokenByCode'), { transferTokenResult: true }),
                // This is genuine cleanup after a token response. It must still
                // settle after expiry; it cannot create dashboard authority.
                ...(cache ? { getTokenCache: cache } : {})
            });
        }
        if (own(authOptions, 'cryptoProvider')) authOptions.cryptoProvider = Object.freeze({
            generatePkceCodes: provider(method(authOptions.cryptoProvider, 'generatePkceCodes'))
        });
        if (own(authOptions, 'randomBytes')) {
            if (typeof authOptions.randomBytes !== 'function' || isProxy(authOptions.randomBytes)) throw unavailable();
            const random = authOptions.randomBytes;
            authOptions.randomBytes = size => { hostClock(); try { return random(size); } catch (_) { throw unavailable(); } };
        }
        Object.freeze(authOptions);
        const epoch = provider(supplied.readExternalRuntimeEpoch);
        operator = createDashboardOperatorSession({ browserAuthOptions: authOptions, identityPolicy: policy,
            proofStore: Object.freeze(Object.fromEntries(Object.entries(proof).map(([name, fn]) => [name, provider(fn)]))),
            clock: hostClock, readExternalRuntimeEpoch: epoch, newRequestId: identifier(supplied.newRequestId), requestBudgetMs: budget });
        browser = createBrowserAuthService({ ...authOptions, now: () => Date.parse(hostClock()) });
        if (configurationKeys.includes('customer')) {
            const customerKeys = dataKeys(configuration.customer);
            const hasIdentityProvider = customerKeys.includes('identityProvider');
            fields(configuration.customer, ['policy', 'resolveActivationBinding',
                ...(hasIdentityProvider ? ['identityProvider', 'identityPolicy'] : [])]);
            if (hasIdentityProvider) customerIdentityProvider = freeze(copy(configuration.customer.identityProvider, 16384));
            fields(configuration.customer.policy, ['begin', 'verify', 'recheck']);
            const customerPolicy = Object.freeze(Object.fromEntries(['begin', 'verify', 'recheck'].map(name =>
                [name, provider(method(configuration.customer.policy, name), { customerStage: 'customer_' + name })])));
            const customerAuth = Object.freeze({ ...authOptions, customerPolicy,
                ...(hasIdentityProvider ? { customerIdentityProvider } : {}) });
            activationBinding = provider(method(configuration.customer, 'resolveActivationBinding'));
            customerBrowser = createBrowserAuthService({ ...customerAuth, now: () => Date.parse(hostClock()) });
            customerSession = createDashboardCustomerSession({ browserAuthOptions: customerAuth,
                identityPolicy: hasIdentityProvider ? configuration.customer.identityPolicy :
                    { ...policy, audience: authOptions.env.NOFRIES_CUSTOMER_ENTRA_CLIENT_ID || policy.audience },
                proofStore: Object.freeze(Object.fromEntries(Object.entries(proof).map(([name, fn]) => [name, provider(fn)]))),
                clock: hostClock, readExternalRuntimeEpoch: epoch, newRequestId: identifier(supplied.newRequestId), requestBudgetMs: budget });
        }
        if (configurationKeys.includes('externalCustomer')) {
            const external = fields(configuration.externalCustomer,
                ['policy', 'resolveActivationBinding', 'identityProvider', 'identityPolicy', 'client']);
            const profile = freeze(copy(external.identityProvider, 16384));
            if (profile.kind !== 'external-id' || String(profile.clientId || '').toLowerCase() ===
                String(authOptions.env.NOFRIES_CUSTOMER_ENTRA_CLIENT_ID || '').trim().toLowerCase()) throw unavailable();
            const clientKeys = dataKeys(external.client);
            const assertion = clientKeys.includes('clientAssertion');
            fields(external.client, [assertion ? 'clientAssertion' : 'clientSecret', ...(clientKeys.includes('clientApplication') ? ['clientApplication'] : [])]);
            if (assertion && (typeof external.client.clientAssertion !== 'function' || isProxy(external.client.clientAssertion))) throw unavailable();
            fields(external.policy, ['begin', 'verify', 'recheck']);
            const customerPolicy = Object.freeze(Object.fromEntries(['begin', 'verify', 'recheck'].map(name =>
                [name, provider(method(external.policy, name), { customerStage: 'customer_' + name })])));
            const customerEnvironment = Object.fromEntries(Object.keys(authOptions.env)
                .filter(key => key !== 'NOFRIES_CUSTOMER_ENTRA_CLIENT_SECRET').map(key => [key, authOptions.env[key]]));
            customerEnvironment.NOFRIES_CUSTOMER_ENTRA_CLIENT_ID = profile.clientId;
            if (!assertion) customerEnvironment.NOFRIES_CUSTOMER_ENTRA_CLIENT_SECRET = external.client.clientSecret;
            const configured = { ...authOptions,
                env: environmentSnapshot(customerEnvironment),
                ...(assertion ? { clientAssertion: external.client.clientAssertion } : {}),
                customerPolicy, customerIdentityProvider: profile, customerTransport: 'external' };
            // Never inherit the staff/legacy client instance for the new app.
            delete configured.clientApplication;
            if (clientKeys.includes('clientApplication')) {
                const client = external.client.clientApplication, cache = method(client, 'getTokenCache', true);
                configured.clientApplication = Object.freeze({
                    getAuthCodeUrl: provider(method(client, 'getAuthCodeUrl')),
                    acquireTokenByCode: provider(method(client, 'acquireTokenByCode'), { transferTokenResult: true }),
                    ...(cache ? { getTokenCache: cache } : {})
                });
            }
            externalAuth = Object.freeze(configured);
            externalBinding = provider(method(external, 'resolveActivationBinding'));
            externalBrowser = createBrowserAuthService({ ...externalAuth, now: () => Date.parse(hostClock()) });
            externalSession = createDashboardCustomerSession({ browserAuthOptions: externalAuth,
                identityPolicy: external.identityPolicy,
                proofStore: Object.freeze(Object.fromEntries(Object.entries(proof).map(([name, fn]) => [name, provider(fn)]))),
                clock: hostClock, readExternalRuntimeEpoch: epoch, newRequestId: identifier(supplied.newRequestId), requestBudgetMs: budget });
        }
        options = Object.freeze({ pool: Object.freeze({ async connect() {
            hostClock();
            // The repository owns a returned client, including when its next
            // clock check fails. Never throw here after successful acquisition.
            try { return await connect(); } catch (_) { throw unavailable(); }
        }, end }), clock: hostClock, instanceId: supplied.instanceId, historyBudget: freeze(copy(supplied.historyBudget, 16384)),
        readExternalRuntimeEpoch: epoch, newId: identifier(supplied.newId),
        readVerifiedOnboardingProof: async () => null, readPreparedCaseCapability: async () => null,
        authoriseOperatorOperation: facts => activationPort !== null && facts.operationType === 'customerActivation' &&
            ['prepare', 'activate'].includes(facts.phase) && facts.capture?.kind === 'operator_dashboard' &&
            adminSubjects.has(facts.capture.identityPayload.identityTenantId + ':' + facts.capture.identityPayload.oid),
        newGenerationToken: identifier(supplied.newGenerationToken) });
        runtime = createPostgresDashboardRuntimeRepository({ ...options, captureRequest,
            ...(activationPort ? { readCustomerActivation: (_request, id) => activationPort.read(id) } : {}) });
        logout = createDashboardOperatorLogoutService({ browserAuthOptions: authOptions, captureRequest,
            runtimeOptions: options, newOperationId: identifier(supplied.newOperationId) });
        if (customerBrowser) customerLogout = createDashboardOperatorLogoutService({
            browserAuthOptions: { ...authOptions, customerPolicy: configuration.customer.policy,
                ...(customerIdentityProvider ? { customerIdentityProvider } : {}) }, captureRequest,
            runtimeOptions: options, newOperationId: identifier(supplied.newOperationId) });
        if (externalBrowser) externalLogout = createDashboardOperatorLogoutService({
            browserAuthOptions: externalAuth, captureRequest,
            runtimeOptions: options, newOperationId: identifier(supplied.newOperationId) });
        resources = createDashboardResourceRuntime({ pool: options.pool, clock: hostClock, instanceId: options.instanceId,
            historyBudget: options.historyBudget, captureRequest, readExternalRuntimeEpoch: epoch,
            newId: options.newId, resolveSubmissionQuota: ncscQuota || (() => null),
            ...(ncscQuota ? { ncscEnabled: true } : {}), ...(improvementEnabled ? { improvementEnabled: true } : {}) });
    } catch (_) { throw unavailable(); }

    function selectedCustomer(cookie) {
        const legacy = !!customerBrowser && /(?:^|;\s*)__Host-nofries-customer=/.test(cookie || '');
        const external = !!externalBrowser && /(?:^|;\s*)__Host-nofries-external-customer=/.test(cookie || '');
        // Do not probe readers: a failed reader may delete the other parent's
        // record. Ambiguous customer selection has no storage side effects.
        if (legacy && external) fail(401, 'dashboard_authentication_required');
        if (external) return { browser: externalBrowser, session: externalSession, logout: externalLogout, binding: externalBinding };
        if (legacy) return { browser: customerBrowser, session: customerSession, logout: customerLogout, binding: activationBinding };
        return null;
    }
    function isCustomer(cookie) { return selectedCustomer(cookie) !== null; }
    async function captureRequest(request) {
        const selected = selectedCustomer(request.headers.cookie);
        if (selected) return selected.session.captureRequest(request);
        return operator.captureRequest(request);
    }

    function start(entry, original = null) {
        try {
            const at = Date.parse(instant(clock())), deadline = at + budget;
            if (!Number.isSafeInteger(deadline)) throw unavailable();
            instant(new Date(deadline).toISOString());
            Object.assign(entry, { startedAt: at, deadline, lastAt: at, expired: false, settled: false, phase: 'starting' });
            entry.timer = setTimeout(() => {
                if (entry.settled) return;
                entry.expired = true;
                if (entry.phase === 'wire' && original && !original.readableEnded && !original.destroyed) original.destroy(unavailable());
            }, budget);
            if (entry.timer.unref) entry.timer.unref();
            if (original) {
                entry.abort = () => { entry.expired = true; };
                original.once('aborted', entry.abort);
                if (original.socket) original.socket.once('close', entry.abort);
            }
        } catch (_) { entry.expired = true; throw unavailable(); }
    }
    function settle(entry, original = null) {
        entry.settled = true;
        clearTimeout(entry.timer);
        if (original && entry.abort) {
            original.removeListener('aborted', entry.abort);
            if (original.socket) original.socket.removeListener('close', entry.abort);
        }
    }
    function transport(original) {
        if (!(original instanceof IncomingMessage) || isProxy(original)) throw unavailable();
        const methodValue = original.method, url = original.originalUrl === undefined ? original.url : original.originalUrl;
        if (typeof methodValue !== 'string' || typeof url !== 'string' || !Array.isArray(original.rawHeaders)) bad();
        const headers = Object.fromEntries(HEADER_NAMES.map(name => [name, []]));
        const raw = original.rawHeaders.slice();
        if (raw.length % 2) bad();
        for (let i = 0; i < raw.length; i += 2) {
            if (typeof raw[i] !== 'string' || typeof raw[i + 1] !== 'string') bad();
            const key = raw[i].toLowerCase();
            if (own(headers, key)) headers[key].push(raw[i + 1]);
        }
        return freeze({ method: methodValue, url, headers });
    }
    function routeFor(snapshot, entry) {
        const split = snapshot.url.indexOf('?'), path = split < 0 ? snapshot.url : snapshot.url.slice(0, split);
        const query = split < 0 ? null : snapshot.url.slice(split + 1);
        const prefix = '/api/dashboard/';
        const route = path.startsWith(prefix) ? path.slice(prefix.length) : '';
        const workQueue = improvementEnabled && route === 'work-queue';
        let resource = null, ncscRoute = null, improvementRoute = null;
        if (improvementEnabled && ['improvement/plans', 'improvement/list', 'improvement/view', 'improvement/editor', 'improvement/execute'].includes(route)) {
            improvementRoute = route.slice('improvement/'.length);
        }
        if (ncscQuota && (route === 'ncsc/assessments' || route.startsWith('ncsc/assessments/'))) {
            ncscRoute = route === 'ncsc/assessments' ? '' : route.slice('ncsc/assessments/'.length);
            if (route.endsWith('/')) fail(404, 'dashboard_not_found');
            if (ncscRoute) {
                const parts = ncscRoute.split('/');
                let id;
                try { id = decodeURIComponent(parts[0]); } catch (_) { fail(404, 'dashboard_not_found'); }
                if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(id) || encodeURIComponent(id) !== parts[0] ||
                    parts.length > 2 || parts.length === 2 && !['save', 'submit'].includes(parts[1])) fail(404, 'dashboard_not_found');
                ncscRoute = id + (parts.length === 2 ? '/' + parts[1] : '');
            }
        }
        const methods = { session: ['GET', 'POST'], organisations: ['GET'], selection: ['POST'], logout: ['POST'], evidence: ['GET'] };
        if (!workQueue && ncscRoute === null && improvementRoute === null && !own(methods, route)) {
            try { resource = hostResourceForRoute(route); } catch (_) { fail(404, 'dashboard_not_found'); }
        }
        entry.category = improvementRoute !== null ? 'improvement' : ncscRoute === null ? route : 'ncsc';
        const allow = workQueue ? ['GET'] : improvementRoute !== null ? improvementRoute === 'execute' ? ['POST'] : ['GET']
            : ncscRoute !== null ? (ncscRoute === '' ? ['GET', 'POST'] : ncscRoute.includes('/') ? ['POST'] : ['GET']) : resource ? ['GET'] : methods[route];
        if (!allow.includes(snapshot.method)) fail(405, 'dashboard_method_not_allowed', { Allow: allow.join(', ') });
        const directory = { limit: 50, afterBindingId: null };
        let evidenceSelector = null;
        let improvementSelector = null;
        let workQueueSelector = null;
        const ncscQuery = {};
        if (workQueue) {
            const values = {};
            if (query !== null) {
                if (!query || query.length > 3072) bad();
                for (const pair of query.split('&')) {
                    const pieces = pair.split('=');
                    if (pieces.length !== 2 || !['limit', 'cursor'].includes(pieces[0]) || own(values, pieces[0])) bad();
                    let decoded;
                    try { decoded = decodeURIComponent(pieces[1]); } catch (_) { bad(); }
                    if (encodeURIComponent(decoded) !== pieces[1]) bad();
                    values[pieces[0]] = decoded;
                }
            }
            if (own(values, 'limit') && !/^(?:[1-9]|[1-4][0-9]|50)$/.test(values.limit)) bad();
            workQueueSelector = normaliseConsultantWorkQueuePage({ limit: own(values, 'limit') ? Number(values.limit) : 50,
                cursor: values.cursor ?? null });
        } else if (improvementRoute === 'plans') {
            const values = {};
            if (query !== null) {
                if (!query || query.length > 2048) bad();
                for (const pair of query.split('&')) {
                    const pieces = pair.split('=');
                    if (pieces.length !== 2 || !['limit', 'afterPlanId'].includes(pieces[0]) || own(values, pieces[0])) bad();
                    let decoded;
                    try { decoded = decodeURIComponent(pieces[1]); } catch (_) { bad(); }
                    if (encodeURIComponent(decoded) !== pieces[1]) bad();
                    values[pieces[0]] = decoded;
                }
            }
            if (own(values, 'limit') && !/^(?:[1-9]|[1-4][0-9]|50)$/.test(values.limit)) bad();
            improvementSelector = normaliseImprovementPlanPage({ limit: own(values, 'limit') ? Number(values.limit) : 20,
                afterPlanId: values.afterPlanId ?? null });
        } else if (improvementRoute !== null && improvementRoute !== 'execute') {
            // One canonical encoding per value; no form aliases, repeated keys
            // or tenant/identity inputs. Defaults match the retained list codec.
            if (!query || query.length > 2048) bad();
            const values = {};
            for (const pair of query.split('&')) {
                const pieces = pair.split('=');
                const keys = improvementRoute === 'editor' ? ['planId'] : ['planId', 'status', 'owner', 'overdueOnly'];
                if (pieces.length !== 2 || !keys.includes(pieces[0]) || own(values, pieces[0])) bad();
                let decoded;
                try { decoded = decodeURIComponent(pieces[1]); } catch (_) { bad(); }
                if (encodeURIComponent(decoded) !== pieces[1]) bad();
                values[pieces[0]] = decoded;
            }
            if (!own(values, 'planId') || own(values, 'overdueOnly') && !['true', 'false'].includes(values.overdueOnly)) bad();
            improvementSelector = improvementRoute === 'editor' ? normaliseImprovementSelector({ planId: values.planId })
                : normaliseImprovementActionListSelector({ planId: values.planId,
                filters: { status: values.status ?? 'all', owner: values.owner ?? 'all', overdueOnly: values.overdueOnly === 'true' } });
        } else if (ncscRoute === '' && snapshot.method === 'GET' && query !== null) {
            if (!query) bad();
            for (const pair of query.split('&')) {
                const pieces = pair.split('=');
                if (pieces.length !== 2 || !['limit', 'afterAssessmentId'].includes(pieces[0]) || own(ncscQuery, pieces[0])) bad();
                const [key, value] = pieces;
                if (key === 'limit') {
                    if (!/^(?:[1-9][0-9]?|100)$/.test(value)) bad();
                    ncscQuery[key] = value;
                } else {
                    let id;
                    try { id = decodeURIComponent(value); } catch (_) { bad(); }
                    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(id) || encodeURIComponent(id) !== value) bad();
                    ncscQuery[key] = id;
                }
            }
        } else if (route === 'evidence') {
            // One canonical encoded opaque identifier; no alternate keys, form
            // aliases or repeated decoding. It never becomes a path or log field.
            if (query === null || !query.startsWith('artefactId=')) bad();
            const encoded = query.slice('artefactId='.length);
            // At most 180 UTF-16 units, each needing at most nine URL bytes.
            if (!encoded || encoded.length > 1620) bad();
            try {
                const artefactId = decodeURIComponent(encoded);
                if (encodeURIComponent(artefactId) !== encoded) bad();
                evidenceSelector = normaliseEvidenceMetadataSelector({ artefactId });
            } catch (_) { bad(); }
        } else if (route === 'organisations' && query !== null) {
            if (!query) bad();
            const seen = new Set();
            for (const pair of query.split('&')) {
                const pieces = pair.split('=');
                if (pieces.length !== 2 || !['limit', 'afterBindingId'].includes(pieces[0]) || seen.has(pieces[0])) bad();
                const [key, value] = pieces; seen.add(key);
                if (key === 'limit') {
                    if (!/^(?:[1-9]|[1-9][0-9]|100)$/.test(value)) bad();
                    directory.limit = Number(value);
                } else { try { directory.afterBindingId = uuid(value); } catch (_) { bad(); } }
            }
        } else if (query !== null) bad();
        return freeze({ route, resource, directory, evidenceSelector, ncscRoute, ncscQuery, improvementRoute, improvementSelector, workQueueSelector });
    }
    async function readWire(original, entry, snapshot) {
        entry.phase = 'wire';
        if (original.readableEncoding || original.readableEnded || own(original, 'body') && original.body !== undefined) bad();
        if (original.aborted || original.destroyed && !original.readableEnded) throw unavailable();
        let mediaFailure = false;
        if (snapshot.method === 'POST') {
            const types = snapshot.headers['content-type'], encodings = snapshot.headers['content-encoding'];
            mediaFailure = types.length !== 1 || !/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(types[0]) ||
                encodings.length > 1 || encodings.length === 1 && encodings[0].trim().toLowerCase() !== 'identity';
        }
        const bytes = await new Promise((resolve, reject) => {
            let count = 0, chunks = [], finished = false;
            function cleanup() {
                original.removeListener('data', onData); original.removeListener('end', onEnd);
                original.removeListener('error', onError); original.removeListener('close', onClose);
            }
            function done(error) {
                if (finished) return;
                finished = true; cleanup();
                if (entry.wireFailure) reject(entry.wireFailure);
                else if (error) reject(error);
                else if (snapshot.method === 'GET' && count) reject(new HostError(400, 'dashboard_input_invalid'));
                else resolve(Buffer.concat(chunks, count));
                chunks = [];
            }
            function onData(chunk) {
                if (!Buffer.isBuffer(chunk)) { done(new HostError(400, 'dashboard_input_invalid')); return; }
                count += chunk.length;
                if (count > MAX_WIRE && !entry.wireFailure) entry.wireFailure = new HostError(413, 'dashboard_request_too_large');
                if (count <= MAX_WIRE && !(snapshot.method === 'GET' && count)) chunks.push(chunk);
                else chunks = [];
            }
            function onEnd() { done(); }
            function onError() { done(unavailable()); }
            function onClose() { if (!original.readableEnded) done(unavailable()); }
            original.on('data', onData); original.once('end', onEnd); original.once('error', onError); original.once('close', onClose);
            if (original.readableEnded) done();
        });
        entry.phase = 'validated-wire';
        if (mediaFailure) fail(415, 'dashboard_unsupported_media_type');
        if (snapshot.method === 'GET') return undefined;
        let value;
        try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)); }
        catch (_) { bad(); }
        if (!value || typeof value !== 'object' || Array.isArray(value)) bad();
        return value;
    }
    function commandFor(route, input) {
        try {
            if (route === 'session' && input.action === 'customer_activation') {
                fields(input, ['action', 'activationId', 'phase']); uuid(input.activationId);
                if (!['prepare', 'activate'].includes(input.phase)) bad();
            }
            else if (route === 'session') { fields(input, ['operationId']); uuid(input.operationId); }
            else if (route === 'selection') { fields(input, ['bindingId', 'expectedGeneration', 'operationId']); uuid(input.bindingId); digest(input.expectedGeneration); uuid(input.operationId); }
            else if (route === 'logout') fields(input, []);
            return freeze(copy(input, MAX_WIRE));
        } catch (_) { bad(); }
    }
    async function authenticated(cookie) {
        const selected = selectedCustomer(cookie);
        let result;
        try { result = await bounded(() => (selected?.browser || browser).readSessionDetails(cookie)); }
        catch (error) {
            // Check the original host budget before turning an awaited genuine
            // invalid parent into a sign-in requirement.
            hostClock();
            if (error instanceof BrowserAuthError && (error.statusCode === 401 ||
                error.statusCode === 400 && error.code === 'browser_auth_email_invalid')) fail(401, 'dashboard_authentication_required');
            throw unavailable();
        }
        if (!result) fail(401, 'dashboard_authentication_required');
    }
    async function approvedCustomerBinding(req) {
        const selected = selectedCustomer(req.headers.cookie);
        if (!selected) fail(403, 'dashboard_access_denied');
        const binding = await bounded(() => selected.binding(req));
        try {
            const value = copy(binding, 8192);
            fields(value, ['bindingId', 'scope', ...(own(value, 'accountType') ? ['accountType'] : []),
                ...(own(value, 'clientSetupAvailable') ? ['clientSetupAvailable'] : [])]);
            uuid(value.bindingId); fields(value.scope, ['tenantId', 'organisationId']);
            if (own(value, 'accountType') && !['company', 'consultant'].includes(value.accountType)) throw new Error();
            if (own(value, 'clientSetupAvailable') && (value.clientSetupAvailable !== true || value.accountType !== 'consultant')) throw new Error();
            return freeze(value);
        } catch (_) { fail(403, 'dashboard_access_denied'); }
    }
    async function execute(original, entry) {
        const selected = routeFor(entry.transport, entry);
        entry.category = selected.improvementRoute !== null ? 'improvement' : selected.ncscRoute === null ? selected.route : 'ncsc';
        entry.resource = selected.resource !== null;
        const snapshot = entry.transport;
        const purposes = snapshot.headers['x-nofries-dashboard-purpose'];
        const expectedOperator = purposes.length !== 0;
        if (expectedOperator) {
            if (selected.route !== 'session' || purposes.length !== 1 || purposes[0] !== 'operator_dashboard') bad();
            // This header restricts the expected purpose; it cannot override a
            // competing customer cookie or select a different parent session.
            // Reject before any customer authentication, cleanup or activation.
            if (snapshot.headers.cookie.some(value => /(?:^|;)\s*__Host-nofries-(?:external-)?customer\s*=/.test(value))) {
                fail(403, 'dashboard_access_denied');
            }
        }
        const input = await bounded(() => readWire(original, entry, snapshot), 'wire');
        const command = snapshot.method === 'POST' ? commandFor(selected.route, input) : undefined;
        if (expectedOperator && command?.action) bad();
        const privateRequest = Object.freeze({ method: snapshot.method,
            ...(selected.ncscRoute !== null ? { query: selected.ncscQuery, ...(command === undefined ? {} : { body: command }) } : {}), headers: Object.freeze({ cookie: snapshot.headers.cookie.join('; '),
            origin: snapshot.headers.origin.join(', '), 'sec-fetch-site': snapshot.headers['sec-fetch-site'].join(', ') }) });
        if (snapshot.method === 'POST') await bounded(async () => {
            try { assertExactSameOriginRequest(privateRequest, authOptions.env); } catch (_) { fail(403, 'dashboard_access_denied'); }
            return true;
        });
        entry.phase = 'providers';
        await authenticated(privateRequest.headers.cookie);
        if (selected.route === 'session' && command?.action === 'customer_activation') {
            if (!activationPort || isCustomer(privateRequest.headers.cookie)) fail(403, 'dashboard_access_denied');
            const result = await bounded(() => runtime.customerActivation(privateRequest,
                { activationId: command.activationId, phase: command.phase }), 'runtime');
            if (result.phase === 'activated') await bounded(() => activationPort.writeCompletion(result));
            return response(200, { schemaVersion: 1, phase: result.phase,
                next: result.phase === 'prepared' ? 'customer_terms' : 'owner_finalisation' });
        }
        let expectedGeneration = null;
        if (selected.workQueueSelector || selected.improvementRoute !== null || selected.ncscRoute !== null || selected.evidenceSelector || selected.resource && selected.resource.requiresGeneration) {
            const generations = snapshot.headers['x-nofries-dashboard-generation'];
            try { if (generations.length !== 1) throw new Error(); expectedGeneration = digest(generations[0]); }
            catch (_) { fail(403, 'dashboard_access_denied'); }
        }
        if (selected.workQueueSelector) {
            if (!isCustomer(privateRequest.headers.cookie)) fail(403, 'dashboard_access_denied');
            const approved = await approvedCustomerBinding(privateRequest);
            if (approved.accountType !== 'consultant') fail(403, 'dashboard_access_denied');
            entry.disclosureCheck = () => resources.assertWorkQueueDisclosure(privateRequest);
            return response(200, await bounded(() => resources.readWorkQueue(privateRequest,
                { expectedGeneration }, selected.workQueueSelector)));
        }
        if (selected.improvementRoute !== null) {
            return response(200, await bounded(async () => {
                const execute = selected.improvementRoute === 'execute';
                const selection = execute ? normaliseImprovementCommand(command) : selected.improvementSelector;
                let bound;
                try { bound = await resources.forRequest(privateRequest, { expectedGeneration }); }
                catch (error) {
                    const denied = error instanceof DashboardPersistenceError && error.code === 'dashboard_access_denied' && error.statusCode === 403;
                    if (execute) throw new ImprovementPlanServiceError(denied ? 'improvement_access_denied' : 'improvement_unavailable', denied ? 403 : 503);
                    throw new ImprovementActionListError(denied ? 'improvement_list_access_denied' : 'improvement_list_unavailable', denied ? 403 : 503);
                }
                return bound.improvement[selected.improvementRoute](selection);
            }, 'improvement'));
        }
        if (selected.ncscRoute !== null) {
            const value = await bounded(async () => {
                let bound;
                try { bound = await resources.forRequest(privateRequest, { expectedGeneration }); }
                catch (error) {
                    if (error instanceof DashboardPersistenceError && error.code === 'dashboard_access_denied' && error.statusCode === 403) {
                        return response(403, { code: 'ncsc_access_denied' });
                    }
                    return response(503, { code: 'ncsc_unavailable' });
                }
                const service = createNcscAssessmentService({ repository: bound.ncsc, requestContext: bound.requestContext });
                // Exact-origin policy was checked above on this same immutable
                // request, before any provider; no caller can supply this guard.
                const handlers = createNcscAssessmentHandlers({ service, guardMutation: candidate => candidate === privateRequest });
                return handlers.handleRequest(privateRequest, selected.ncscRoute);
            }, 'ncsc');
            if (value.status >= 400) logFailure('ncsc', value.status, value.body.code);
            return value;
        }
        if (selected.evidenceSelector) {
            const value = await bounded(async () => {
                let bound;
                try { bound = await resources.forRequest(privateRequest, { expectedGeneration }); }
                catch (error) {
                    if (error instanceof DashboardPersistenceError && error.code === 'dashboard_access_denied' && error.statusCode === 403) {
                        throw new EvidenceMetadataError('evidence_access_denied', 403);
                    }
                    throw new EvidenceMetadataError();
                }
                const service = createEvidenceMetadataService({ repository: bound.evidence, requestContext: bound.requestContext });
                return service.read(privateRequest, selected.evidenceSelector);
            });
            return response(200, value);
        }
        if (selected.resource) return bounded(() => resources.handleHostResource(privateRequest, {
            route: selected.route, expectedGeneration
        }), 'resource');
        if (selected.route === 'session' && snapshot.method === 'GET') {
            const value = await bounded(() => runtime.readSession(privateRequest), 'runtime');
            if (value.state === 'initialization_required') return response(409, { code: 'dashboard_initialization_required' });
            const customerAccount = value.purpose === 'customer' ? await approvedCustomerBinding(privateRequest) : null;
            const admin = activationPort && value.purpose === 'operator_dashboard' ? await bounded(() => captureRequest(privateRequest)) : null;
            const activationAvailable = admin && adminSubjects.has(admin.identityPayload.identityTenantId + ':' + admin.identityPayload.oid);
            return response(200, { schemaVersion: 1, authenticated: true, purpose: value.purpose, expiresAt: value.expiresAt,
                generation: value.generation, selectedBindingId: value.selectedBindingId,
                ...(customerAccount?.accountType ? { accountType: customerAccount.accountType } : {}),
                ...(customerAccount?.clientSetupAvailable ? { clientSetupAvailable: true } : {}), ...(activationAvailable ? { activationAvailable: true } : {}) });
        }
        if (selected.route === 'session') {
            if (isCustomer(privateRequest.headers.cookie)) {
                const binding = await approvedCustomerBinding(privateRequest);
                await bounded(() => runtime.activateCustomerSession(privateRequest, { ...command, bindingId: binding.bindingId, scope: binding.scope }), 'runtime');
            } else await bounded(() => runtime.initializeOperatorSession(privateRequest, command), 'runtime');
            return response(200, { schemaVersion: 1, initialized: true });
        }
        if (selected.route === 'organisations') {
            let directory = selected.directory;
            if (isCustomer(privateRequest.headers.cookie)) {
                const approved = await approvedCustomerBinding(privateRequest);
                // The subject-scoped SQL directory still filters immutable identity.
                // Each selected binding rechecks its own current membership.
                if (approved.accountType !== 'consultant') directory = { ...directory, bindingId: approved.bindingId };
            }
            const value = await bounded(() => runtime.discoverBindings(privateRequest, directory), 'runtime');
            return response(200, { schemaVersion: 1, bindings: value.bindings, nextAfterBindingId: value.nextAfterBindingId });
        }
        if (selected.route === 'selection') {
            if (isCustomer(privateRequest.headers.cookie)) {
                const approved = await approvedCustomerBinding(privateRequest);
                if (approved.accountType !== 'consultant' && approved.bindingId !== command.bindingId) fail(403, 'dashboard_access_denied');
            }
            const value = await bounded(() => runtime.selectBinding(privateRequest, command), 'runtime');
            return response(200, { schemaVersion: 1, generation: value.record.generationToken, selectedBindingId: value.record.selectedBindingId });
        }
        const value = await bounded(() => (selectedCustomer(privateRequest.headers.cookie)?.logout || logout).logout({ cookieHeader: privateRequest.headers.cookie, returnTo: '/' }));
        return response(200, { schemaVersion: 1, loggedOut: true }, { 'Set-Cookie': value.cookie });
    }
    function handleRequest(original) {
        let snapshot, entry;
        try { snapshot = transport(original); }
        catch (error) { return Promise.resolve(failure(error, 'unknown')); }
        entry = requests.get(original);
        if (entry) {
            if (entry.initialising || JSON.stringify(entry.transport) !== JSON.stringify(snapshot)) return Promise.resolve(failure(new HostError(403, 'dashboard_access_denied'), 'unknown'));
            return entry.promise;
        }
        entry = { initialising: true, transport: snapshot, category: 'unknown', promise: null };
        requests.set(original, entry);
        try { ledger.run(entry, () => start(entry, original)); }
        catch (error) { entry.promise = Promise.resolve(failure(error, 'unknown')); settle(entry, original); entry.initialising = false; return entry.promise; }
        entry.promise = Promise.resolve().then(() => ledger.run(entry, async () => {
            try {
                hostClock(); const value = await execute(original, entry);
                try { hostClock(); } catch (error) { if (!ambiguousResponses.has(value)) throw error; }
                if (entry.disclosureCheck) entry.disclosureCheck();
                if (entry.resource && value.status >= 400) {
                    const code = value.body && value.body.code;
                    if (value.status === 403 && code === 'dashboard_access_denied' || value.status === 503 &&
                        ['dashboard_unavailable', 'dashboard_outcome_ambiguous'].includes(code)) logFailure(entry.category, value.status, code);
                    else logFailure(entry.category, 503, 'dashboard_unavailable');
                }
                return value;
            }
            catch (error) { return failure(error, entry.category); }
            finally { settle(entry, original); }
        }));
        entry.initialising = false;
        return entry.promise;
    }
    function service(work, callback = false) {
        return input => {
            const active = ledger.getStore();
            async function invoke() {
                let returned = false;
                try { hostClock(); const value = await work(input); returned = true; hostClock(); return value; }
                catch (error) {
                    try { hostClock(); }
                    catch (_) {
                        const closed = unavailable();
                        if (callback && (returned || error && error.clearTransactionCookie === true)) closed.clearTransactionCookie = true;
                        throw closed;
                    }
                    // Genuine callback errors retain their consumed-cookie flag.
                    throw error;
                }
            }
            if (active) return active.initialising || active.settled ? Promise.reject(unavailable()) : invoke();
            const entry = { initialising: true };
            return ledger.run(entry, async () => {
                try { start(entry); entry.initialising = false; return await invoke(); }
                finally { settle(entry); }
            });
        };
    }
    async function completeForPurpose(adapter, input, chosenCookie) {
        const result = await adapter.callbackService.completeLogin(input);
        if (!customerBrowser && !externalBrowser) return result;
        // A successful explicit sign-in chooses the dashboard purpose. Clear
        // the competing credential so an expired cookie cannot trap the other
        // session behind cookie-name precedence.
        const competing = ['__Host-nofries-auth', ...(customerBrowser ? ['__Host-nofries-customer'] : []),
            ...(externalBrowser ? ['__Host-nofries-external-customer'] : [])].filter(name => name !== chosenCookie);
        const cookies = [...(result.cookies || (Array.isArray(result.cookie) ? result.cookie : [result.cookie])),
            ...competing.map(name =>
                `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`)];
        return { ...result, cookie: cookies, cookies };
    }
    const authServices = Object.freeze({
        login: Object.freeze({ beginLogin: service(input => browser.beginLogin(input)) }),
        callback: Object.freeze({ completeLogin: service(input => completeForPurpose(operator, input, '__Host-nofries-auth'), true) }),
        logout: Object.freeze({ logout: service(input => logout.logout(input)) }),
        session: Object.freeze({ readSessionDetails: service(input => browser.readSessionDetails(input)) }),
        ...(customerBrowser ? { customer: Object.freeze({
            login: Object.freeze({ beginLogin: service(input => customerBrowser.beginLogin(input)) }),
            callback: Object.freeze({ completeLogin: service(input => completeForPurpose(customerSession, input, '__Host-nofries-customer'), true) }),
            session: Object.freeze({ readSessionDetails: service(input => customerBrowser.readSessionDetails(input)) })
        }) } : {}),
        ...(externalBrowser ? { externalCustomer: Object.freeze({
            login: Object.freeze({ beginLogin: service(input => externalBrowser.beginLogin(input)) }),
            callback: Object.freeze({ completeLogin: service(input => completeForPurpose(externalSession, input, '__Host-nofries-external-customer'), true) }),
            session: Object.freeze({ readSessionDetails: service(input => externalBrowser.readSessionDetails(input)) }),
            // Setup has no dashboard authority or dashboard logout capability.
            // This separate operation may end only a provisional app session.
            setupLogout: Object.freeze({ logout: service(input => externalBrowser.logoutSetup({ cookieHeader: input.cookieHeader })) })
        }) } : {})
    });
    return Object.freeze({ handleRequest, authServices });
}

module.exports = Object.freeze({ createDashboardRuntimeHandlers });
