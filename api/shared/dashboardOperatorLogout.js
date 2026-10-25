'use strict';

// Dormant composition. A host must explicitly install this capability together
// with the matching H operator capture and approved runtime providers.
const { AsyncLocalStorage } = require('node:async_hooks');
const { isProxy } = require('node:util').types;
const { BrowserAuthError, createBrowserAuthService } = require('./browserAuth');
const { createPostgresDashboardRuntimeRepository } = require('./appLifecycle/postgresDashboardRuntimeRepository');
const { copy, fields, freeze, uuid, instant } = require('./appLifecycle/dashboardRuntimeRecords');

const STORE_METHODS = ['createTransaction', 'consumeTransaction', 'deleteTransaction',
    'createSession', 'loadSession', 'deleteSession'];
const RUNTIME_FIELDS = ['pool', 'clock', 'instanceId', 'historyBudget', 'readExternalRuntimeEpoch', 'newId',
    'readVerifiedOnboardingProof', 'readPreparedCaseCapability', 'authoriseOperatorOperation', 'newGenerationToken'];
const unavailable = () => new BrowserAuthError(503, 'browser_auth_dashboard_unavailable',
    'Dashboard authentication is temporarily unavailable.');
const invalid = () => new BrowserAuthError(400, 'browser_auth_logout_input_invalid');

function createDashboardOperatorLogoutService(options) {
    const attempts = new AsyncLocalStorage();
    let auth, runtime, clock, newOperationId;
    function sample() {
        const attempt = attempts.getStore();
        if (!attempt || attempt.failed) throw unavailable();
        try {
            const at = instant(clock());
            if (attempt.lastAt && at < attempt.lastAt) throw unavailable();
            attempt.lastAt = at; return at;
        } catch (_) { attempt.failed = true; throw unavailable(); }
    }
    try {
        fields(options, ['browserAuthOptions', 'captureRequest', 'runtimeOptions', 'newOperationId']);
        if (typeof options.captureRequest !== 'function' || typeof options.newOperationId !== 'function') throw unavailable();
        newOperationId = options.newOperationId;
        const source = options.browserAuthOptions, keys = source && Reflect.ownKeys(source);
        fields(source, keys);
        if (!keys.includes('env') || !keys.includes('store') || keys.some(key =>
            !['env', 'store', 'clientApplication', 'cryptoProvider', 'randomBytes', 'customerPolicy', 'customerIdentityProvider', 'customerTransport', 'clientAssertion'].includes(key))) throw unavailable();
        const authOptions = Object.fromEntries(keys.map(key => [key, source[key]]));
        if (!authOptions.env || typeof authOptions.env !== 'object' || isProxy(authOptions.env) ||
            String(authOptions.env.NOFRIES_REQUIRE_AUTH || '').trim().toLowerCase() === 'false') throw unavailable();
        const store = Object.fromEntries(STORE_METHODS.map(name => {
            if (!authOptions.store || typeof authOptions.store[name] !== 'function') throw unavailable();
            return [name, authOptions.store[name].bind(authOptions.store)];
        }));
        const wrappedStore = Object.freeze({ ...store,
            async loadSession(id) {
                let value;
                try { value = await store.loadSession(id); } catch (_) { throw unavailable(); }
                if (value === undefined) throw unavailable();
                try { return value === null ? null : freeze(copy(value, 16384)); } catch (_) { throw unavailable(); }
            },
            async deleteSession(id) {
                try { return await store.deleteSession(id); } catch (_) { throw unavailable(); }
            }
        });
        const suppliedRuntime = fields(options.runtimeOptions, RUNTIME_FIELDS);
        clock = suppliedRuntime.clock;
        if (typeof clock !== 'function') throw unavailable();
        auth = createBrowserAuthService({ ...authOptions, store: wrappedStore, now: () => Date.parse(sample()) });
        runtime = createPostgresDashboardRuntimeRepository({ ...suppliedRuntime,
            clock: sample, captureRequest: options.captureRequest });
    } catch (_) { throw unavailable(); }

    async function logout(input = {}) {
        let cookieHeader, returnTo;
        try {
            const keys = input && Reflect.ownKeys(input); fields(input, keys);
            if (keys.some(key => !['cookieHeader', 'returnTo'].includes(key))) throw invalid();
            cookieHeader = input.cookieHeader; returnTo = input.returnTo;
            if (cookieHeader != null && typeof cookieHeader !== 'string' || returnTo != null && typeof returnTo !== 'string') throw invalid();
            cookieHeader = cookieHeader || '';
        } catch (_) { throw invalid(); }
        const original = Object.freeze({ cookieHeader, returnTo });
        const request = Object.freeze({ headers: Object.freeze({ cookie: cookieHeader }) });
        return attempts.run({ lastAt: null, failed: false }, async () => {
            let valid = false;
            try {
                sample();
                try { valid = Boolean(await auth.readSessionDetails(cookieHeader)); }
                catch (error) {
                    // Provider failures have already become fixed 503 errors.
                    // The genuine reader owns invalid-record cleanup itself.
                    if (!(error instanceof BrowserAuthError && (error.statusCode === 401 ||
                        error.statusCode === 400 && error.code === 'browser_auth_email_invalid'))) throw error;
                }
                sample();
                if (valid) {
                    const operationId = uuid(newOperationId());
                    await runtime.revokeSession(request, Object.freeze({ operationId }));
                    sample();
                }
            } catch (_) { throw unavailable(); }
            // No failure after a valid initial parent may choose an unfenced
            // cleanup path. Only acknowledged/reconciled revocation reaches here.
            try { return await auth.logout(original); }
            catch (error) {
                if (error instanceof BrowserAuthError && (error.statusCode === 400 &&
                    error.code === 'browser_auth_return_path_invalid' || error.statusCode === 401 &&
                    error.code === 'browser_auth_cookie_invalid')) throw error;
                throw unavailable();
            }
        });
    }
    return Object.freeze({ logout });
}

module.exports = Object.freeze({ createDashboardOperatorLogoutService });
