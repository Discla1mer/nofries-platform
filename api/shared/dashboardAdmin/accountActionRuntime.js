'use strict';

const { IncomingMessage } = require('node:http');
const { AsyncLocalStorage } = require('node:async_hooks');
const { isProxy } = require('node:util').types;
const { fields, freeze, equal, hash, instant, uuid } = require('../appLifecycle/dashboardRuntimeRecords');
const { createDashboardOperatorSession } = require('../dashboardOperatorSession');
const { createPostgresDashboardAdministrationRepository } = require('../appLifecycle/postgresDashboardRuntimeRepository');
const { readOnlyCaptureOptions } = require('./runtimeAdapter');
const { accountActionApproval } = require('./accountActionApproval');
const { normaliseSelector, DashboardAdminError } = require('./service');

const denied = () => { throw new DashboardAdminError(403, 'dashboard_admin_access_denied'); };
const unavailable = () => { throw new DashboardAdminError(503, 'dashboard_admin_unavailable'); };
const fn = value => typeof value === 'function' && !isProxy(value);
function confirmationPort(store, key) {
    if (!store || typeof store !== 'object' || isProxy(store) || Array.isArray(store)) unavailable();
    for (let owner = store; owner !== null; owner = Object.getPrototypeOf(owner)) {
        if (isProxy(owner)) unavailable();
        const descriptor = Object.getOwnPropertyDescriptor(owner, key);
        if (descriptor) {
            if (!Object.hasOwn(descriptor, 'value') || !fn(descriptor.value)) unavailable();
            return (...args) => descriptor.value.apply(store, args);
        }
    }
    unavailable();
}

// Only current protected approvals authorise actions. Store locator settings
// create no action grant, SQL permission or storage container.
function createDashboardAdminAccountActionRuntime(input) {
    let config, session, repository;
    const entries = new WeakMap(), invocations = new AsyncLocalStorage();
    try {
        fields(input, ['browserAuthOptions', 'identityPolicy', 'proofStore', 'clock', 'readExternalRuntimeEpoch',
            'newRequestId', 'requestBudgetMs', 'pool', 'instanceId', 'historyBudget', 'newId',
            'readApprovedActionBinding', 'confirmationStore', ...(Object.hasOwn(input, 'signupReset') ? ['signupReset'] : [])]);
        config = { ...input };
        if (![config.clock, config.readExternalRuntimeEpoch, config.newRequestId, config.newId, config.readApprovedActionBinding].every(fn) ||
            !Number.isSafeInteger(config.requestBudgetMs) || config.requestBudgetMs < 1 || config.requestBudgetMs > 10000) unavailable();
        config.confirmationStore = Object.freeze(Object.fromEntries(['create', 'load', 'writeState', 'readState'].map(key =>
            [key, confirmationPort(config.confirmationStore, key)])));
        uuid(config.instanceId);
        session = createDashboardOperatorSession(readOnlyCaptureOptions(config));
        repository = createPostgresDashboardAdministrationRepository({
            ...Object.fromEntries(['pool', 'clock', 'instanceId', 'historyBudget', 'readExternalRuntimeEpoch', 'newId'].map(key => [key, config[key]])),
            captureRequest: request => session.captureRequest(request), authoriseAdministration: () => false,
            authoriseAccountAction: nativePolicy,
            accountActionState: config.confirmationStore,
            beforeQuery() {
                const invocation = invocations.getStore();
                if (!invocation) unavailable();
                check(invocation.entry, invocation.context);
            }
        });
    } catch (_) { unavailable(); }

    function check(entry, context = null) {
        let at;
        try { at = instant(config.clock()); } catch (_) { unavailable(); }
        if (entry.failed || entry.request.aborted || Date.now() - entry.started >= config.requestBudgetMs ||
            entry.lastAt !== null && at < entry.lastAt || entry.binding && (at < entry.binding.validFrom || at >= entry.binding.validUntil)) denied();
        entry.lastAt = at;
        if (context) {
            if (context.signal.aborted) unavailable();
            context.check();
        }
        return at;
    }
    function entryFor(request) {
        if (isProxy(request) || !(request instanceof IncomingMessage)) denied();
        let entry = entries.get(request);
        if (!entry) {
            entry = { request, started: Date.now(), lastAt: null, binding: null, targeted: false, actor: null, selector: null, failed: false };
            entries.set(request, entry);
        }
        check(entry); return entry;
    }
    function pin(entry, selector) {
        if (selector === null) return null;
        const target = normaliseSelector(selector);
        if (entry.selector && !equal(entry.selector, target)) denied();
        entry.selector = target; return target;
    }
    async function nativePolicy(input) {
        const entry = entryFor(input.request), invocation = invocations.getStore();
        if (!invocation || invocation.entry !== entry) denied();
        check(entry, invocation.context);
        const capture = input.capture, actor = capture.identityPayload.identityTenantId + ':' + capture.identityPayload.oid;
        if (capture.kind !== 'operator_dashboard' || capture.instanceId !== config.instanceId || entry.actor && entry.actor !== actor) denied();
        entry.actor = actor;
        const selector = pin(entry, input.selector) || entry.selector;
        const binding = accountActionApproval(await config.readApprovedActionBinding(freeze({
            operatorSubjectKey: actor, purpose: 'account_support', instanceId: config.instanceId, selector
        })));
        check(entry, invocation.context);
        if (binding.operatorSubjectKey !== actor || binding.instanceId !== config.instanceId || binding.restoreEpoch !== capture.restoreEpoch ||
            binding.identityPolicy.policyId !== capture.identityPayload.policyId ||
            binding.identityPolicy.policyRevision !== capture.identityPayload.policyRevision ||
            selector && !equal(binding.selector, selector) || input.action !== null && !binding.actions.includes(input.action) ||
            entry.binding && entry.targeted && !equal(entry.binding, binding)) denied();
        entry.binding = binding; entry.targeted = selector !== null;
        check(entry, invocation.context);
        return freeze({ authoritySha256: hash(binding), listMembers: binding.actions.includes('list_members') });
    }
    function call(entry, context, method, ...args) {
        check(entry, context);
        return invocations.run({ entry, context }, () => repository[method](entry.request, ...args));
    }
    async function authoriseOperator(input) {
        fields(input, ['principal', 'selector', 'action', 'request']);
        const entry = entryFor(input.request), selector = pin(entry, input.selector);
        if (input.principal.provider !== 'entra-bff' || input.principal.isAuthenticated !== true) denied();
        if (input.action === 'reset' && !config.signupReset) denied();
        const response = await call(entry, null, 'validateAccountActionSession', selector, input.action);
        check(entry);
        if (entry.actor !== input.principal.subjectKey || response?.state !== 'ready' ||
            input.action !== null && !entry.binding.actions.includes(input.action)) denied();
        return true;
    }
    async function resetPort(entry, context, method, command) {
        if (!config.signupReset || command.witness.authoritySha256 !== hash(entry.binding) ||
            command.witness.restoreEpoch !== entry.binding.restoreEpoch) denied();
        await call(entry, context, 'validateAccountActionSession', command.selector, 'reset');
        check(entry, context);
        return config.signupReset[method](command, { async check() {
            await context.beforeCommit(); check(entry, context);
            if (command.witness.authoritySha256 !== hash(entry.binding)) denied();
        } });
    }
    function adapterContext(context) {
        const entry = entryFor(context.request);
        if (entry.actor !== context.principal.subjectKey) denied();
        check(entry, context); return entry;
    }
    return Object.freeze({ authoriseOperator,
        adapter: Object.freeze({
            async inspect(selector, context) {
                const entry = adapterContext(context); pin(entry, selector);
                let result = null;
                if (config.signupReset && entry.binding?.actions.includes('reset')) {
                    result = await config.signupReset.inspect(selector, { actorSubjectKey: entry.actor,
                        authoritySha256: hash(entry.binding), restoreEpoch: entry.binding.restoreEpoch,
                        async check() { await context.beforeCommit(); check(entry, context); } });
                }
                if (result === null) result = await call(entry, context, 'inspectAccountAction', selector);
                check(entry, context); return result;
            },
            async commit(command, context) {
                const entry = adapterContext(context); pin(entry, command.selector);
                await context.beforeCommit(); check(entry, context);
                const result = command.action === 'reset' ? await resetPort(entry, context, 'commit', command) :
                    await call(entry, context, 'commitAccountAction', command);
                check(entry, context); return result;
            },
            async outcome(command, context) {
                const entry = adapterContext(context); pin(entry, command.selector);
                const result = command.action === 'reset' ? await resetPort(entry, context, 'outcome', command) :
                    await call(entry, context, 'accountActionOutcome', command);
                check(entry, context); return result;
            }
        }), confirmationStore: config.confirmationStore, clock: config.clock, requestBudgetMs: config.requestBudgetMs });
}

module.exports = { createDashboardAdminAccountActionRuntime };
