'use strict';

const { randomBytes, randomUUID, createHash } = require('node:crypto');
const { isProxy } = require('node:util').types;
const { performance } = require('node:perf_hooks');
const { fields, freeze, instant } = require('../appLifecycle/dashboardRuntimeRecords');
const { DashboardAdminError, normaliseSelector } = require('./service');
const { ACTIONS, prepareInput, confirmationInput, operatorPrincipal, inspection, commandDigest, actionCommand,
    actionReceipt } = require('./accountActionRecords');

const fail = (status, suffix) => { throw new DashboardAdminError(status, 'dashboard_admin_' + suffix); };
const port = value => typeof value === 'function' && !isProxy(value);
const tokenDigest = value => createHash('sha256').update(value, 'utf8').digest('hex');
function translate(error) {
    if (error instanceof DashboardAdminError && [400, 403, 409, 503].includes(error.statusCode) &&
        ['dashboard_admin_input_invalid', 'dashboard_admin_access_denied', 'dashboard_admin_conflict', 'dashboard_admin_unavailable'].includes(error.code)) throw error;
    if (error?.statusCode === 403) fail(403, 'access_denied');
    if (error?.statusCode === 409) fail(409, 'conflict');
    fail(503, 'unavailable');
}

// The host must supply independent current action authority and a concrete
// native adapter. A lookup/listing grant is never a fallback. Confirmations are
// immutable private records, and successful effects/audit are committed by the
// native adapter in one transaction. No in-memory token or outcome is authority.
function createDashboardAdminAccountActionService(options) {
    let config;
    try {
        if (isProxy(options)) throw new Error();
        const optional = ['requestBudgetMs', 'confirmationTtlMs'].filter(key => Object.hasOwn(options, key));
        fields(options, ['authoriseOperator', 'adapter', 'confirmationStore', 'clock', ...optional]);
        config = { requestBudgetMs: 10000, confirmationTtlMs: 300000, ...options };
        if (![config.authoriseOperator, config.clock].every(port) || !config.adapter || isProxy(config.adapter) ||
            !['inspect', 'commit', 'outcome'].every(key => port(config.adapter[key])) ||
            !config.confirmationStore || isProxy(config.confirmationStore) ||
            !['create', 'load'].every(key => port(config.confirmationStore[key])) ||
            !Number.isSafeInteger(config.requestBudgetMs) || config.requestBudgetMs < 1 || config.requestBudgetMs > 60000 ||
            !Number.isSafeInteger(config.confirmationTtlMs) || config.confirmationTtlMs < 1 || config.confirmationTtlMs > 300000) throw new Error();
    } catch (_) { fail(503, 'unavailable'); }
    const inspectTarget = config.adapter.inspect.bind(config.adapter), commit = config.adapter.commit.bind(config.adapter),
        readOutcome = config.adapter.outcome.bind(config.adapter), loadConfirmation = config.confirmationStore.load.bind(config.confirmationStore),
        saveConfirmation = config.confirmationStore.create.bind(config.confirmationStore);
    let lastTime = -Infinity;
    function now() {
        try {
            const value = instant(config.clock()), timestamp = Date.parse(value);
            if (timestamp < lastTime) throw new Error();
            lastTime = timestamp; return value;
        } catch (_) { fail(503, 'unavailable'); }
    }
    function bounded(work) {
        let closed = false, timer;
        const started = performance.now(), controller = new AbortController();
        const check = () => {
            if (closed || controller.signal.aborted || performance.now() - started >= config.requestBudgetMs) fail(503, 'unavailable');
            return now();
        };
        return Promise.race([Promise.resolve().then(() => work(check, controller.signal)), new Promise((_, reject) => {
            timer = setTimeout(() => {
                closed = true; controller.abort(); reject(new DashboardAdminError(503, 'dashboard_admin_unavailable'));
            }, config.requestBudgetMs);
        })]).catch(translate).finally(() => { closed = true; controller.abort(); clearTimeout(timer); });
    }
    async function approved(actor, selector, action, check) {
        check(); let result;
        try { result = await config.authoriseOperator(freeze({ principal: actor, selector, action })); }
        catch (error) {
            check();
            // The native session repository uses its own fixed 503 error class.
            // Preserve unavailable without leaking its code or provider detail;
            // an unclassified policy exception still fails as an access denial.
            if (error?.statusCode === 503) fail(503, 'unavailable');
            fail(403, 'access_denied');
        }
        check(); if (result !== true) fail(403, 'access_denied');
        return actor;
    }
    function authorise(principalInput, selectorInput = null, action = null) {
        return bounded(async check => {
            const actor = operatorPrincipal(principalInput);
            if (action !== null && !ACTIONS.includes(action)) fail(400, 'input_invalid');
            const selector = selectorInput === null ? null : normaliseSelector(selectorInput);
            return approved(actor, selector, action, check);
        });
    }
    function capabilities(principalInput) {
        return bounded(async check => {
            await approved(operatorPrincipal(principalInput), null, null, check);
            return freeze({ accountActions: true });
        });
    }
    function context(actor, selector, action, check, signal, expiresAt = null) {
        const current = () => {
            const at = check();
            if (expiresAt !== null && at >= expiresAt) fail(409, 'conflict');
            return at;
        };
        const beforeCommit = async () => {
            current(); await approved(actor, selector, action, current); current();
        };
        return Object.freeze({ principal: actor, signal, check: current, beforeCommit });
    }
    async function observed(actor, selector, action, check, signal) {
        await approved(actor, selector, action, check);
        const found = inspection(await inspectTarget(selector, context(actor, selector, action, check, signal)), selector);
        check(); await approved(actor, selector, action, check);
        return found;
    }
    function inspect(principalInput, selectorInput) {
        return bounded(async (check, signal) => {
            const actor = operatorPrincipal(principalInput), selector = normaliseSelector(selectorInput);
            await approved(actor, null, null, check);
            const found = await observed(actor, selector, null, check, signal);
            const actions = [];
            for (const action of found.actions) {
                try { await approved(actor, selector, action, check); actions.push(action); }
                catch (error) { if (error?.statusCode !== 403) throw error; }
            }
            await approved(actor, selector, null, check);
            const { witness, ...publicValue } = found;
            return freeze({ ...publicValue, actions });
        });
    }
    function prepare(principalInput, input) {
        return bounded(async (check, signal) => {
            const actor = operatorPrincipal(principalInput), request = prepareInput(input);
            await approved(actor, null, null, check);
            const { selector, action, patch } = request;
            const found = await observed(actor, selector, action, check, signal);
            if (!found.actions.includes(action)) fail(503, 'unavailable');
            // The typed name is checked before saving a command. It is never retained
            // in the command, receipt, URL or diagnostic output. The inspection
            // version already binds the canonical organisation name.
            if (['delete', 'archive', 'reset'].includes(action) && request.confirmationName !== found.displayName) fail(400, 'input_invalid');
            if (action === 'edit' && patch.displayLabel === found.displayLabel) fail(409, 'conflict');
            const preparedAt = check(), expiresAt = new Date(Date.parse(preparedAt) + config.confirmationTtlMs).toISOString();
            const unsigned = { schemaVersion: 1, operationId: randomUUID(), actorSubjectKey: actor.subjectKey,
                selector, expectedVersion: found.version, action, patch, preparedAt, expiresAt, witness: found.witness };
            const command = actionCommand({ ...unsigned, commandSha256: commandDigest(unsigned) });
            const token = randomBytes(32).toString('base64url'), ctx = context(actor, selector, action, check, signal, expiresAt);
            const saved = await saveConfirmation(tokenDigest(token), command, ctx.beforeCommit);
            check(); if (saved !== true) fail(503, 'unavailable');
            await ctx.beforeCommit();
            return freeze({ confirmationToken: token, operationId: command.operationId, selector, action, patch,
                before: { displayName: found.displayName, displayLabel: found.displayLabel, membership: found.membership }, expiresAt });
        });
    }
    async function retained(actor, input, check) {
        const request = confirmationInput(input);
        await approved(actor, null, null, check);
        const raw = await loadConfirmation(tokenDigest(request.confirmationToken));
        check();
        if (raw === null) fail(409, 'conflict');
        const command = actionCommand(raw);
        if (command.actorSubjectKey !== actor.subjectKey) fail(403, 'access_denied');
        if (command.preparedAt > check()) fail(503, 'unavailable');
        await approved(actor, command.selector, command.action, check);
        return command;
    }
    function notStarted(command, expired) {
        return freeze({ operationId: command.operationId, commandSha256: command.commandSha256,
            status: expired ? 'not_started_expired' : 'not_started', version: null, occurredAt: null });
    }
    async function receipt(raw, command, actor, check) {
        const value = actionReceipt(raw, command);
        if (value.occurredAt > check()) fail(503, 'unavailable');
        await approved(actor, command.selector, command.action, check);
        return value;
    }
    function execute(principalInput, input) {
        return bounded(async (check, signal) => {
            const actor = operatorPrincipal(principalInput), command = await retained(actor, input, check);
            // Reconcile durable evidence first. An expired confirmation may
            // disclose its committed outcome, but can never start a new effect.
            const readContext = context(actor, command.selector, command.action, check, signal);
            const original = await readOutcome(command, readContext); check();
            if (original !== null) return receipt(original, command, actor, check);
            const ctx = context(actor, command.selector, command.action, check, signal, command.expiresAt);
            await ctx.beforeCommit();
            return receipt(await commit(command, ctx), command, actor, check);
        });
    }
    function outcome(principalInput, input) {
        return bounded(async (check, signal) => {
            const actor = operatorPrincipal(principalInput), command = await retained(actor, input, check);
            const ctx = context(actor, command.selector, command.action, check, signal);
            let result = await readOutcome(command, ctx);
            check(); await approved(actor, command.selector, command.action, check);
            // The adapter's outcome read must serialize on the same native
            // tenant fence as commit. A pre-expiry absent read can race with a
            // commit during the authorization await above. Establish expiry
            // BEFORE a fresh serialized read, rather than using a later clock
            // to turn that earlier absence into proof that no effect happened.
            if (result === null && check() >= command.expiresAt) {
                result = await readOutcome(command, ctx);
                check(); await approved(actor, command.selector, command.action, check);
                return result === null ? notStarted(command, true) : receipt(result, command, actor, check);
            }
            return result === null ? notStarted(command, false) : receipt(result, command, actor, check);
        });
    }
    return Object.freeze({ authorise, capabilities, inspect, prepare, execute, outcome });
}

module.exports = { createDashboardAdminAccountActionService, tokenDigest };
