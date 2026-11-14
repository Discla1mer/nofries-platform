'use strict';

// Constructing this adapter creates no permission, route or SQL role.
const { IncomingMessage } = require('node:http');
const { AsyncLocalStorage } = require('node:async_hooks');
const { isProxy } = require('node:util').types;
const { createDashboardOperatorSession } = require('../dashboardOperatorSession');
const { createPostgresDashboardAdministrationRepository } = require('../appLifecycle/postgresDashboardRuntimeRepository');
const { copy, fields, freeze, equal, uuid, instant, subject } = require('../appLifecycle/dashboardRuntimeRecords');
const { DashboardAdminError, normaliseSelector } = require('./service');
const { createAuditEnvelope, verifyAuditPhasePair } = require('./auditEnvelope');

const denied = () => { throw new DashboardAdminError(403, 'dashboard_admin_access_denied'); };
const unavailable = () => { throw new DashboardAdminError(503, 'dashboard_admin_unavailable'); };
const fn = value => typeof value === 'function' && !isProxy(value);
const actorOf = capture => capture.identityPayload.identityTenantId + ':' + capture.identityPayload.oid;

function readMethod(object, name) {
    if (!object || typeof object !== 'object' || isProxy(object)) unavailable();
    for (let current = object; current !== null; current = Object.getPrototypeOf(current)) {
        if (isProxy(current)) unavailable();
        const descriptor = Object.getOwnPropertyDescriptor(current, name);
        if (descriptor) {
            if (!Object.prototype.hasOwnProperty.call(descriptor, 'value') || !fn(descriptor.value)) unavailable();
            return descriptor.value.bind(object);
        }
    }
    unavailable();
}
function readOnlyCaptureOptions(config) {
    const auth = config.browserAuthOptions;
    if (!auth || typeof auth !== 'object' || isProxy(auth)) unavailable();
    const keys = Reflect.ownKeys(auth);
    fields(auth, keys);
    const loadSession = readMethod(auth.store, 'loadSession');
    const store = Object.freeze(Object.fromEntries(['createTransaction', 'consumeTransaction', 'deleteTransaction',
        'createSession', 'loadSession', 'deleteSession'].map(name => [name, name === 'loadSession' ? loadSession : async () => unavailable()])));
    fields(config.proofStore, ['createOriginalProof', 'readOriginalProof']);
    return { browserAuthOptions: Object.freeze({ ...auth, store }), identityPolicy: config.identityPolicy,
        proofStore: Object.freeze({ readOriginalProof: readMethod(config.proofStore, 'readOriginalProof'),
            createOriginalProof: async () => unavailable() }),
        ...Object.fromEntries(['clock', 'readExternalRuntimeEpoch', 'newRequestId', 'requestBudgetMs'].map(key => [key, config[key]])) };
}


// Staff policy: the authority is the allowlisted staff admin's own native
// operator session. The host has already checked subject allowlist and admin
// role; the native repository checks the session gate, issuance proof and
// restore epoch; this adapter pins actor and identity policy for the request.
function createDashboardAdminRuntime(input) {
    let config, session, repository;
    const requests = new WeakMap(), invocations = new AsyncLocalStorage();
    try {
        fields(input, ['browserAuthOptions', 'identityPolicy', 'proofStore', 'clock', 'readExternalRuntimeEpoch',
            'newRequestId', 'requestBudgetMs', 'pool', 'instanceId', 'historyBudget', 'newId']);
        config = { ...input };
        if (![config.clock, config.readExternalRuntimeEpoch, config.newRequestId, config.newId].every(fn) ||
            !Number.isSafeInteger(config.requestBudgetMs) || config.requestBudgetMs < 1 || config.requestBudgetMs > 60000) unavailable();
        fields(config.identityPolicy, Reflect.ownKeys(config.identityPolicy));
        if (typeof config.identityPolicy.policyId !== 'string' || !config.identityPolicy.policyId ||
            !Number.isSafeInteger(config.identityPolicy.policyRevision) || config.identityPolicy.policyRevision < 0) unavailable();
        config.staffPolicy = freeze({ policyId: config.identityPolicy.policyId, policyRevision: config.identityPolicy.policyRevision });
        uuid(config.instanceId);
        // Genuine validation can normally clean up invalid parents. This
        // uninstalled read-only composition refuses every backing-store write,
        // including cleanup during uncertain audit reconciliation.
        session = createDashboardOperatorSession(readOnlyCaptureOptions(config));
        repository = createPostgresDashboardAdministrationRepository({ pool: require('./accountActionsPool').accountActionsPool(config.pool), clock: config.clock,
            instanceId: config.instanceId, historyBudget: config.historyBudget, readExternalRuntimeEpoch: config.readExternalRuntimeEpoch,
            newId: config.newId, captureRequest: request => session.captureRequest(request), authoriseAdministration: nativePolicy,
            beforeQuery() {
                // The existing checked client calls this synchronously after
                // timeout preparation and immediately before SQL/COMMIT.
                const entry = invocations.getStore();
                if (!entry) unavailable();
                check(entry);
            } });
    } catch (_) { unavailable(); }

    function entryFor(request) {
        if (isProxy(request) || !(request instanceof IncomingMessage)) denied();
        let entry = requests.get(request);
        if (!entry) {
            entry = { request, started: Date.now(), lastAt: null, expiresAt: null, failed: false,
                actor: null, selector: null, capture: null, lookupId: null, snapshotStarted: false,
                attempt: null, terminal: null };
            requests.set(request, entry);
        }
        check(entry); return entry;
    }
    function check(entry) {
        try {
            const at = instant(config.clock());
            if (entry.failed || entry.request.aborted || Date.now() - entry.started >= config.requestBudgetMs ||
                entry.lastAt !== null && at < entry.lastAt || entry.expiresAt !== null && at >= entry.expiresAt) denied();
            entry.lastAt = at;
            if (entry.expiresAt === null) entry.expiresAt = new Date(Date.parse(at) + config.requestBudgetMs).toISOString();
            return at;
        } catch (error) { entry.failed = true; throw error instanceof DashboardAdminError ? error : new DashboardAdminError(503, 'dashboard_admin_unavailable'); }
    }
    function pinSelector(entry, selector) {
        if (selector === null) return null;
        const value = normaliseSelector(selector);
        if (entry.selector && !equal(entry.selector, value)) { entry.failed = true; denied(); }
        if (!entry.selector) entry.selector = value;
        return value;
    }
    function staffPolicy(entry, actor, capture) {
        try {
            check(entry); subject(actor);
            if (entry.actor !== null && entry.actor !== actor) denied();
            entry.actor = actor;
            // Only the configured identity policy captured by the native gate
            // may stand behind this actor.
            if (actorOf(capture) !== actor || config.staffPolicy.policyId !== capture.identityPayload.policyId ||
                config.staffPolicy.policyRevision !== capture.identityPayload.policyRevision) denied();
            check(entry); return true;
        } catch (_) { entry.failed = true; denied(); }
    }
    async function nativePolicy(context) {
        try {
            const entry = entryFor(context.request), selector = pinSelector(entry, context.selector);
            const capture = context.capture;
            if (capture.kind !== 'operator_dashboard' || !capture.operatorIssuanceProof || capture.instanceId !== config.instanceId) denied();
            staffPolicy(entry, actorOf(capture), capture);
            check(entry); return true;
        } catch (_) { return false; }
    }
    async function validate(entry, selector, actor = null) {
        try {
            check(entry); selector = pinSelector(entry, selector);
            if (actor !== null) {
                subject(actor);
                if (entry.actor !== null && entry.actor !== actor) denied();
                entry.actor = actor;
            }
            const result = await nativeCall(entry, 'validateSession', selector);
            check(entry);
            fields(result, ['schemaVersion', 'state', 'purpose', 'capture']);
            if (result.schemaVersion !== 1 || result.state !== 'ready' || result.purpose !== 'operator_dashboard' ||
                result.capture.kind !== 'operator_dashboard' || !result.capture.operatorIssuanceProof ||
                result.capture.instanceId !== config.instanceId || actor !== null && actorOf(result.capture) !== actor ||
                entry.capture && !equal(entry.capture, result.capture)) denied();
            staffPolicy(entry, actorOf(result.capture), result.capture); check(entry);
            if (!entry.capture) entry.capture = freeze(copy(result.capture, 16384));
            return entry.capture;
        } catch (error) {
            entry.failed = true;
            if (error?.statusCode === 403 || error?.statusCode === 401) denied();
            unavailable();
        }
    }
    function nativeCall(entry, method, ...args) {
        check(entry);
        return invocations.run(entry, () => repository[method](entry.request, ...args));
    }
    async function authoriseOperator(input) {
        try {
            fields(input, ['principal', 'selector', 'request']);
            const principal = fields(copy(input.principal, 2048), ['provider', 'isAuthenticated', 'subjectKey']);
            if (principal.provider !== 'entra-bff' || principal.isAuthenticated !== true) denied();
            await validate(entryFor(input.request), input.selector, principal.subjectKey);
            return true;
        } catch (_) { return false; }
    }
    async function readAuthoritySnapshot(scope, principal, selector, context) {
        fields(context, ['request', 'selector']);
        const entry = entryFor(context.request), target = pinSelector(entry, selector);
        if (!target || !equal(target, context.selector) || !equal(scope, { tenantId: target.tenantId, organisationId: target.organisationId }) ||
            !equal(principal, { authenticated: true, subjectKey: entry.actor }) || !entry.attempt?.acknowledged || entry.snapshotStarted) denied();
        // Reserve before the first await so concurrent invocations cannot both
        // pass admission. Failed validation consumes this request's read slot.
        entry.snapshotStarted = true;
        await validate(entry, target, principal.subjectKey); check(entry);
        let result;
        try { result = await nativeCall(entry, 'readAuthoritySnapshot', target); }
        catch (error) {
            if (error?.statusCode === 403 || error?.statusCode === 401) { entry.failed = true; denied(); }
            unavailable();
        }
        await validate(entry, target, principal.subjectKey); check(entry);
        return result;
    }
    async function audit(serviceEvent, context) {
        fields(context, ['request', 'selector']);
        const entry = entryFor(context.request), selector = pinSelector(entry, context.selector);
        if (!selector) denied();
        const capture = await validate(entry, selector, serviceEvent.actorSubjectKey);
        check(entry);
        const phase = serviceEvent.outcome === 'attempt' ? 'attempt' : 'terminal';
        if (entry.lookupId !== null && entry.lookupId !== serviceEvent.requestId || phase === 'terminal' && !entry.attempt?.acknowledged) denied();
        if (entry.lookupId === null) entry.lookupId = serviceEvent.requestId;
        const previous = entry[phase];
        const envelope = createAuditEnvelope({ serviceEvent, selector, nativeBinding: { requestId: capture.requestId,
            sessionSha256: capture.sessionSha256, instanceId: capture.instanceId, actorSubjectKey: actorOf(capture) },
            eventId: previous ? previous.envelope.event.eventId : config.newId() });
        if (phase === 'terminal') verifyAuditPhasePair(entry.attempt.envelope, envelope);
        if (previous) {
            if (!equal(previous.envelope, envelope)) denied();
            if (previous.promise) await previous.promise;
            await validate(entry, selector); check(entry);
            if (!previous.acknowledged) unavailable();
            return true;
        }
        const record = { envelope, acknowledged: false, promise: null };
        entry[phase] = record;
        record.promise = (async () => {
            const attempt = phase === 'terminal' ? entry.attempt.envelope : null;
            try {
                if (await nativeCall(entry, 'persistAudit', envelope, selector, attempt) !== true) unavailable();
            }
            catch (error) {
                check(entry);
                // Only this direct finite repository operation can signal an
                // ambiguous COMMIT. Never retry INSERT or the snapshot.
                if (error?.code !== 'onboarding_outcome_ambiguous' || error?.statusCode !== 503) throw error;
                if (await nativeCall(entry, 'reconcileAudit', envelope, selector, attempt) !== true) unavailable();
            }
            await validate(entry, selector); check(entry);
            record.acknowledged = true;
        })();
        try { await record.promise; }
        catch (_) { entry.failed = true; unavailable(); }
        finally { record.promise = null; }
        return true;
    }
    return Object.freeze({ authoriseOperator, readAuthoritySnapshot, audit, clock: config.clock, requestBudgetMs: config.requestBudgetMs });
}

module.exports = { createDashboardAdminRuntime };
