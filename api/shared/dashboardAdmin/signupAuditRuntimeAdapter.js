'use strict';

// Dormant composition over existing operator sessions, explicit current grants,
// finite data readers and native audit. Constructing this supplies no authority,
// population, route, store binding or database schema.
const { IncomingMessage } = require('node:http');
const { AsyncLocalStorage } = require('node:async_hooks');
const { addAbortListener } = require('node:events');
const { isProxy } = require('node:util').types;
const { createDashboardOperatorSession } = require('../dashboardOperatorSession');
const { createPostgresDashboardAdministrationRepository } = require('../appLifecycle/postgresDashboardRuntimeRepository');
const { copy, fields, freeze, equal, hash, uuid, digest, instant, subject } = require('../appLifecycle/dashboardRuntimeRecords');
const { DashboardAdminError } = require('./service');
const { normaliseSignupAuthority } = require('./signupAuthority');
const { createSignupAuditEnvelope, verifySignupAuditPhasePair } = require('./signupAuditEnvelope');

const denied = () => { throw new DashboardAdminError(403, 'dashboard_admin_access_denied'); };
const unavailable = () => { throw new DashboardAdminError(503, 'dashboard_admin_unavailable'); };
const fn = value => typeof value === 'function' && !isProxy(value);
const actorOf = capture => capture.identityPayload.identityTenantId + ':' + capture.identityPayload.oid;
const signalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get;

function readMethod(object, name) {
    if (!object || typeof object !== 'object' || isProxy(object)) unavailable();
    for (let current = object; current !== null; current = Object.getPrototypeOf(current)) {
        if (isProxy(current)) unavailable();
        const descriptor = Object.getOwnPropertyDescriptor(current, name);
        if (descriptor) {
            if (!Object.hasOwn(descriptor, 'value') || !fn(descriptor.value)) unavailable();
            return descriptor.value.bind(object);
        }
    }
    unavailable();
}
function readOnlyCaptureOptions(config) {
    const auth = config.browserAuthOptions;
    if (!auth || typeof auth !== 'object' || isProxy(auth)) unavailable();
    fields(auth, Reflect.ownKeys(auth));
    const loadSession = readMethod(auth.store, 'loadSession');
    const store = Object.freeze(Object.fromEntries(['createTransaction', 'consumeTransaction', 'deleteTransaction',
        'createSession', 'loadSession', 'deleteSession'].map(name => [name, name === 'loadSession' ? loadSession : async () => unavailable()])));
    fields(config.proofStore, ['createOriginalProof', 'readOriginalProof']);
    return { browserAuthOptions: Object.freeze({ ...auth, store }), identityPolicy: config.identityPolicy,
        proofStore: Object.freeze({ readOriginalProof: readMethod(config.proofStore, 'readOriginalProof'),
            createOriginalProof: async () => unavailable() }),
        ...Object.fromEntries(['clock', 'readExternalRuntimeEpoch', 'newRequestId', 'requestBudgetMs'].map(key => [key, config[key]])) };
}

function createDashboardAdminSignupRuntime(input) {
    let config, session, repository;
    const requests = new WeakMap(), sourceSignals = new WeakMap(), invocations = new AsyncLocalStorage();
    try {
        if (isProxy(input)) unavailable();
        fields(input, ['browserAuthOptions', 'identityPolicy', 'proofStore', 'clock', 'readExternalRuntimeEpoch',
            'newRequestId', 'requestBudgetMs', 'pool', 'instanceId', 'historyBudget', 'newId',
            'readApprovedAuthority', 'resolvePopulationBinding', 'readSignupPage',
            ...(Object.hasOwn(input, 'readApprovedState') ? ['readApprovedState'] : [])]);
        config = { ...input };
        if (![config.clock, config.readExternalRuntimeEpoch, config.newRequestId, config.newId,
            config.readApprovedAuthority, config.resolvePopulationBinding, config.readSignupPage].every(fn) ||
            Object.hasOwn(config, 'readApprovedState') && !fn(config.readApprovedState) ||
            !Number.isSafeInteger(config.requestBudgetMs) || config.requestBudgetMs < 1 || config.requestBudgetMs > 10000) unavailable();
        uuid(config.instanceId);
        session = createDashboardOperatorSession(readOnlyCaptureOptions(config));
        repository = createPostgresDashboardAdministrationRepository({ pool: config.pool, clock: config.clock,
            instanceId: config.instanceId, historyBudget: config.historyBudget, readExternalRuntimeEpoch: config.readExternalRuntimeEpoch,
            newId: config.newId, captureRequest: request => session.captureRequest(request),
            authoriseAdministration: () => false, authoriseSignupList: nativePolicy,
            beforeQuery() {
                const invocation = invocations.getStore();
                if (!invocation) unavailable();
                check(invocation.entry, invocation.signal);
            } });
    } catch (_) { unavailable(); }

    function entryFor(request) {
        if (isProxy(request) || !(request instanceof IncomingMessage)) denied();
        let entry = requests.get(request);
        if (!entry) {
            entry = { request, started: Date.now(), lastAt: null, expiresAt: null, failed: false,
                actor: null, authority: null, population: null, capture: null, listId: null, readStarted: false, attempt: null, outcome: null };
            requests.set(request, entry);
        }
        check(entry); return entry;
    }
    function check(entry, signal = null) {
        try {
            const at = instant(config.clock());
            if (entry.failed || entry.request.aborted || signal && (signalAborted.call(signal) ||
                sourceSignals.has(signal) && signalAborted.call(sourceSignals.get(signal))) ||
                Date.now() - entry.started >= config.requestBudgetMs || entry.lastAt !== null && at < entry.lastAt ||
                entry.expiresAt !== null && at >= entry.expiresAt) denied();
            entry.lastAt = at;
            if (entry.expiresAt === null) entry.expiresAt = new Date(Date.parse(at) + config.requestBudgetMs).toISOString();
            if (entry.authority && (at < entry.authority.issuedAt || at >= entry.authority.expiresAt)) denied();
            return at;
        } catch (error) { entry.failed = true; throw error instanceof DashboardAdminError ? error : new DashboardAdminError(503, 'dashboard_admin_unavailable'); }
    }
    function context(input) {
        fields(input, Object.hasOwn(input, 'signal') ? ['request', 'signal'] : ['request']);
        let signal = null, listener = null;
        if (Object.hasOwn(input, 'signal')) {
            const supplied = input.signal;
            if (!supplied || isProxy(supplied) || Object.getPrototypeOf(supplied) !== AbortSignal.prototype ||
                ['aborted', 'reason', 'addEventListener', 'removeEventListener'].some(key => Object.hasOwn(supplied, key))) unavailable();
            const controller = new AbortController();
            signal = controller.signal;
            // A private listener/controller plus the captured native getter
            // remain reliable if the caller later shadows source properties.
            sourceSignals.set(signal, supplied);
            listener = addAbortListener(supplied, () => controller.abort());
            if (signalAborted.call(supplied)) controller.abort();
        }
        try {
            const entry = entryFor(input.request);
            check(entry, signal);
            return { entry, signal, dispose: () => listener?.[Symbol.dispose]() };
        } catch (error) { listener?.[Symbol.dispose](); throw error; }
    }
    async function currentAuthority(entry, actor, expected = null, signal = null) {
        try {
            check(entry, signal); subject(actor);
            if (entry.actor !== null && entry.actor !== actor) denied();
            entry.actor = actor;
            const query = freeze({ operatorSubjectKey: actor, capability: 'signupList' });
            let raw, binding;
            if (config.readApprovedState) {
                // The bound reader returns both values from one coherent read.
                // Every existing checkpoint still reads current authority; no
                // request cache or fallback may conceal a failed selected port.
                const state = fields(copy(await config.readApprovedState(query, signal ? { signal } : {}), 8192),
                    ['authority', 'population']);
                raw = state.authority;
                binding = fields(state.population, ['authoritySha256', 'manifestSha256']);
            } else {
                raw = await config.readApprovedAuthority(query);
            }
            const value = normaliseSignupAuthority(raw, { actorSubjectKey: actor, now: check(entry, signal) });
            if (entry.authority && !equal(entry.authority, value) || expected && !equal(expected, value)) denied();
            if (!config.readApprovedState) {
                binding = fields(copy(await config.resolvePopulationBinding(value, signal ? { signal } : {}), 1024),
                    ['authoritySha256', 'manifestSha256']);
            }
            check(entry, signal); digest(binding.authoritySha256); digest(binding.manifestSha256);
            if (binding.authoritySha256 !== hash(value) || value.schemaVersion === 2 && binding.manifestSha256 !== value.scope.manifestSha256 ||
                entry.population && !equal(entry.population, binding)) denied();
            if (!entry.authority) entry.authority = value;
            if (!entry.population) entry.population = freeze(binding);
            return value;
        } catch (error) {
            entry.failed = true;
            if (error instanceof DashboardAdminError && error.statusCode === 503 && error.code === 'dashboard_admin_unavailable') {
                entry.authorityUnavailable = true;
                unavailable();
            }
            denied();
        }
    }
    async function nativePolicy(input) {
        try {
            const entry = entryFor(input.request), invocation = invocations.getStore();
            if (!invocation || invocation.entry !== entry) denied();
            const capture = input.capture;
            if (capture.kind !== 'operator_dashboard' || !capture.operatorIssuanceProof || capture.instanceId !== config.instanceId) denied();
            await currentAuthority(entry, actorOf(capture), input.authority, invocation.signal);
            check(entry, invocation.signal); return true;
        } catch (_) { return false; }
    }
    function nativeCall(entry, signal, method, ...args) {
        check(entry, signal);
        return invocations.run({ entry, signal }, () => repository[method](entry.request, ...args));
    }
    async function validate(entry, actor, expected = null, signal = null) {
        try {
            const authority = await currentAuthority(entry, actor, expected, signal);
            const result = await nativeCall(entry, signal, 'validateSignupSession', authority);
            check(entry, signal);
            fields(result, ['schemaVersion', 'state', 'purpose', 'capture']);
            if (result.schemaVersion !== 1 || result.state !== 'ready' || result.purpose !== 'operator_dashboard' ||
                result.capture.kind !== 'operator_dashboard' || !result.capture.operatorIssuanceProof ||
                result.capture.instanceId !== config.instanceId || actorOf(result.capture) !== actor ||
                entry.capture && !equal(entry.capture, result.capture)) denied();
            await currentAuthority(entry, actor, authority, signal);
            if (!entry.capture) entry.capture = freeze(copy(result.capture, 16384));
            return authority;
        } catch (error) {
            entry.failed = true;
            if (error?.statusCode === 403 || error?.statusCode === 401) denied();
            unavailable();
        }
    }
    async function authoriseSignupList(input) {
        try {
            fields(input, ['principal', 'capability', 'request']);
            const principal = fields(copy(input.principal, 2048), ['provider', 'isAuthenticated', 'subjectKey']);
            if (input.capability !== 'signupList' || principal.provider !== 'entra-bff' || principal.isAuthenticated !== true) denied();
            return await validate(entryFor(input.request), principal.subjectKey);
        } catch (error) {
            if (error instanceof DashboardAdminError && error.statusCode === 503 && error.code === 'dashboard_admin_unavailable' &&
                requests.get(input.request)?.authorityUnavailable === true) unavailable();
            return null;
        }
    }
    async function readSignupPage(input, suppliedContext) {
        const invocation = context(suppliedContext);
        try { return await readPage(input, invocation); }
        finally { invocation.dispose(); }
    }
    async function readPage(input, { entry, signal }) {
        const query = freeze(copy(input, 8192));
        if (!entry.actor || !entry.attempt?.acknowledged || entry.readStarted || entry.outcome) denied();
        entry.readStarted = true;
        await validate(entry, entry.actor, query.authority, signal);
        let result;
        try { result = await config.readSignupPage(query, signal ? { signal } : {}); }
        catch (error) {
            check(entry, signal);
            if (error?.statusCode === 403 || error?.statusCode === 401) { entry.failed = true; denied(); }
            unavailable();
        }
        await validate(entry, entry.actor, query.authority, signal);
        check(entry, signal);
        return result;
    }
    async function audit(inputEvent, inputAuthority, suppliedContext) {
        const invocation = context(suppliedContext);
        try { return await writeAudit(inputEvent, inputAuthority, invocation); }
        finally { invocation.dispose(); }
    }
    async function writeAudit(inputEvent, inputAuthority, { entry, signal }) {
        const event = freeze(copy(inputEvent, 16384));
        const supplied = normaliseSignupAuthority(inputAuthority, { actorSubjectKey: event.actorSubjectKey, now: check(entry, signal) });
        const authority = await validate(entry, event.actorSubjectKey, supplied, signal), capture = entry.capture;
        const phase = event.phase;
        if (!['attempt', 'outcome'].includes(phase) || entry.listId !== null && entry.listId !== event.requestId ||
            phase === 'outcome' && !entry.attempt?.acknowledged) denied();
        if (entry.listId === null) entry.listId = event.requestId;
        const previous = entry[phase];
        const envelope = createSignupAuditEnvelope({ serviceEvent: event, authority,
            nativeBinding: { requestId: capture.requestId, sessionSha256: capture.sessionSha256,
                instanceId: capture.instanceId, actorSubjectKey: actorOf(capture) },
            eventId: previous ? previous.envelope.event.eventId : config.newId() });
        if (phase === 'outcome') verifySignupAuditPhasePair(entry.attempt.envelope, envelope);
        if (previous) {
            if (!equal(previous.envelope, envelope)) denied();
            if (previous.promise) await previous.promise;
            await validate(entry, event.actorSubjectKey, authority, signal);
            if (!previous.acknowledged) unavailable();
            return freeze({ schemaVersion: 1, durable: true, eventSha256: hash(event) });
        }
        const record = { envelope, acknowledged: false, promise: null };
        entry[phase] = record;
        record.promise = (async () => {
            const attempt = phase === 'outcome' ? entry.attempt.envelope : null;
            try {
                if (await nativeCall(entry, signal, 'persistSignupAudit', envelope, authority, attempt) !== true) unavailable();
            } catch (error) {
                check(entry, signal);
                // One exact SELECT-only reconciliation is allowed only for the
                // native uncertain-COMMIT result. No insert or data-read retry.
                if (error?.code !== 'onboarding_outcome_ambiguous' || error?.statusCode !== 503) throw error;
                if (await nativeCall(entry, signal, 'reconcileSignupAudit', envelope, authority, attempt) !== true) unavailable();
            }
            await validate(entry, event.actorSubjectKey, authority, signal);
            record.acknowledged = true;
        })();
        try { await record.promise; }
        catch (_) { entry.failed = true; unavailable(); }
        finally { record.promise = null; }
        return freeze({ schemaVersion: 1, durable: true, eventSha256: hash(event) });
    }
    return Object.freeze({ authoriseSignupList, readSignupPage, audit, clock: config.clock, requestBudgetMs: config.requestBudgetMs });
}

module.exports = { createDashboardAdminSignupRuntime };
