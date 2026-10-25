'use strict';

// Uninstalled operator-only adapter. The host must supply fenced logout before
// installing this callback service; this module configures no routes or stores.
const { createHash } = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { isProxy } = require('node:util').types;
const {
    BrowserAuthError, createBrowserAuthService, readBrowserSessionDetails
} = require('./browserAuth');
const { createCustomerIdentityProviderProfile, customerProviderKey } = require('./customerSignup/customerIdentityProviderProfile');
const {
    normaliseStableIdentity, canonicalDigest, normaliseOperatorIssuanceProof
} = require('./appLifecycle/dashboardOnboardingDomain');
const { copy, fields, freeze, uuid, instant, equal } = require('./appLifecycle/dashboardRuntimeRecords');

const LIMIT = 16384;

const STORE_METHODS = ['createTransaction', 'consumeTransaction', 'deleteTransaction',
    'createSession', 'loadSession', 'deleteSession'];
const unavailable = () => new BrowserAuthError(503, 'browser_auth_dashboard_unavailable',
    'Dashboard authentication is temporarily unavailable.');
class Refused extends Error {}
const refuse = () => { throw new Refused(); };

function createDashboardOperatorSession(options) { return createDashboardSession(options, false); }
function createDashboardCustomerSession(options) { return createDashboardSession(options, true); }
function createDashboardSession(options, customer) {
    let PREFIX, proofKind;
    const normaliseProof = input => {
        const value = copy(input, LIMIT);
        if (!value || value.kind !== proofKind) refuse();
        return freeze({ ...normaliseOperatorIssuanceProof({ ...value, kind: 'operator_dashboard_issuance' }), kind: proofKind });
    };
    let auth, policy, store, proof, clock, epochProvider, newId, budget, customerProvider;
    try {
        fields(options, ['browserAuthOptions', 'identityPolicy', 'proofStore', 'clock',
            'readExternalRuntimeEpoch', 'newRequestId', 'requestBudgetMs']);
        const supplied = options.browserAuthOptions;
        const keys = supplied && Reflect.ownKeys(supplied);
        fields(supplied, keys);
        if (!keys.includes('env') || !keys.includes('store') || keys.some(key =>
            !['env', 'store', 'clientApplication', 'cryptoProvider', 'randomBytes',
                ...(customer ? ['customerPolicy', 'customerIdentityProvider', 'customerTransport', 'customerPurpose', 'clientAssertion'] : [])].includes(key))) throw unavailable();
        auth = Object.fromEntries(keys.map(key => [key, supplied[key]]));
        if (customer && !auth.customerPolicy) throw unavailable();
        if (keys.includes('customerPurpose') && (auth.customerPurpose !== 'retained_read' || auth.customerTransport !== 'external')) throw unavailable();
        const retained = auth.customerPurpose === 'retained_read';
        PREFIX = Buffer.from(retained ? 'nofries:customer-retained-read-session:v1\0' :
            customer ? 'nofries:customer-dashboard-session:v1\0' : 'nofries:operator-dashboard-session:v1\0', 'utf8');
        proofKind = retained ? 'customer_retained_read_issuance' : customer ? 'customer_dashboard_issuance' : 'operator_dashboard_issuance';
        if (!auth.env || typeof auth.env !== 'object' || isProxy(auth.env)) throw unavailable();
        if (keys.includes('customerIdentityProvider')) {
            auth.customerIdentityProvider = freeze(copy(auth.customerIdentityProvider, LIMIT));
            customerProvider = createCustomerIdentityProviderProfile(auth.customerIdentityProvider, {
                tenantId: auth.env.NOFRIES_ENTRA_TENANT_ID, clientId: auth.env.NOFRIES_ENTRA_CLIENT_ID
            });
        }
        for (const key of ['clientApplication', 'cryptoProvider']) {
            if (keys.includes(key) && (!auth[key] || typeof auth[key] !== 'object' || isProxy(auth[key]))) throw unavailable();
        }
        if (keys.includes('randomBytes') && typeof auth.randomBytes !== 'function') throw unavailable();
        policy = freeze(fields(copy(options.identityPolicy, LIMIT),
            ['policyId', 'policyRevision', 'issuer', 'identityTenantId', 'audience']));
        normaliseStableIdentity({ ...policy, oid: '00000000-0000-0000-0000-000000000000' });
        store = Object.fromEntries(STORE_METHODS.map(name => {
            if (!auth.store || typeof auth.store[name] !== 'function') throw unavailable();
            return [name, auth.store[name].bind(auth.store)];
        }));
        fields(options.proofStore, ['createOriginalProof', 'readOriginalProof']);
        proof = Object.fromEntries(['createOriginalProof', 'readOriginalProof'].map(name => {
            if (typeof options.proofStore[name] !== 'function') throw unavailable();
            return [name, options.proofStore[name].bind(options.proofStore)];
        }));
        clock = options.clock; epochProvider = options.readExternalRuntimeEpoch; newId = options.newRequestId;
        budget = options.requestBudgetMs;
        if ([clock, epochProvider, newId].some(value => typeof value !== 'function') ||
            !Number.isSafeInteger(budget) || budget <= 0 || budget > 60000) throw unavailable();
        configuredPolicy();
    } catch (_) { throw unavailable(); }

    // Only the genuine auth callback can reach the private creation wrapper.
    // Its per-callback state cannot be exchanged by concurrent logins.
    const callbacks = new AsyncLocalStorage();
    const requests = new WeakMap();
    const wrappedStore = Object.freeze({ ...store,
        async createSession(id, input) {
            const attempt = callbacks.getStore();
            if (!attempt || attempt.issuance) throw unavailable();
            let stage = 'session_record';
            try {
                const record = freeze(copy(input, LIMIT));
                const sessionSha256 = sessionDigest(id);
                const identity = stableIdentity(record.identity);
                const life = parentLifetime(record);
                requireWindow(attempt, life);
                stage = 'runtime_epoch';
                const originalEpoch = await readEpoch(attempt);
                requireWindow(attempt, life);
                const issued = normaliseProof({ schemaVersion: 1,
                    kind: proofKind, sessionSha256,
                    identitySha256: canonicalDigest(identity), ...originalEpoch, ...life });
                attempt.issuance = freeze({ proof: issued, identity });
                stage = 'session_save';
                await store.createSession(id, record);
                stage = 'epoch_after_save';
                await sameEpoch(attempt, originalEpoch);
                requireWindow(attempt, life);
                stage = 'issuance_proof';
                if (await proof.createOriginalProof(sessionSha256, issued) !== undefined) throw unavailable();
                stage = 'epoch_after_proof';
                await sameEpoch(attempt, originalEpoch);
                requireWindow(attempt, life);
            } catch (_) {
                const error = unavailable(); error.diagnosticStage = stage; throw error;
            }
        }
    });
    let service;
    try {
        service = createBrowserAuthService({ ...auth, store: wrappedStore,
            now: () => sample(callbacks.getStore()) });
    } catch (_) { throw unavailable(); }

    function configuredPolicy() {
        const tenant = customerProvider ? customerProvider.tenantId : String(auth.env.NOFRIES_ENTRA_TENANT_ID || '').trim().toLowerCase();
        const audience = String(customer && auth.env.NOFRIES_CUSTOMER_ENTRA_CLIENT_ID || auth.env.NOFRIES_ENTRA_CLIENT_ID || '').trim().toLowerCase();
        const issuer = customerProvider ? customerProvider.issuer : 'https://login.microsoftonline.com/' + tenant + '/v2.0';
        if (String(auth.env.NOFRIES_REQUIRE_AUTH || '').trim().toLowerCase() === 'false' ||
            tenant !== policy.identityTenantId || audience !== policy.audience ||
            policy.issuer !== issuer || customerProvider && audience !== customerProvider.clientId) throw unavailable();
    }
    function sample(state) {
        if (!state || state.failed) throw unavailable();
        try {
            const at = Date.parse(instant(clock()));
            if (state.lastAt !== null && at < state.lastAt || state.deadline !== undefined && at >= state.deadline) throw unavailable();
            state.lastAt = at;
            return at;
        } catch (_) { state.failed = true; throw unavailable(); }
    }
    function requireWindow(state, life) {
        const at = sample(state);
        if (at < Date.parse(life.issuedAt) || at >= Date.parse(life.expiresAt)) refuse();
    }
    async function readEpoch(state) {
        sample(state);
        let value;
        try { value = await epochProvider(); } catch (_) { throw unavailable(); }
        sample(state);
        try {
            value = fields(copy(value, LIMIT), ['instanceId', 'restoreEpoch']);
            uuid(value.instanceId); uuid(value.restoreEpoch);
            return freeze(value);
        } catch (_) { throw unavailable(); }
    }
    async function sameEpoch(state, expected) {
        if (!equal(await readEpoch(state), expected)) refuse();
    }
    function stableIdentity(identity) {
        configuredPolicy();
        if (!identity || identity.provider !== 'entra-bff' || identity.isAuthenticated !== true ||
            identity.tenantId !== policy.identityTenantId ||
            identity.subjectKey !== policy.identityTenantId + ':' + identity.principalId) refuse();
        try { return normaliseStableIdentity({ ...policy, oid: identity.principalId }); } catch (_) { refuse(); }
    }
    function parentLifetime(record) {
        try {
            fields(record, ['v', 'kind', 'issuedAt', 'idleExpiresAt', 'absoluteExpiresAt', 'identity',
                ...(customer ? ['customerAssurance'] : []), ...(customerProvider ? ['customerProviderKey'] : []),
                ...(auth.customerTransport ? ['customerTransport'] : []), ...(auth.customerPurpose ? ['customerPurpose'] : [])]);
            if (record.customerProviderKey !== customerProviderKey(customerProvider)) refuse();
            if (record.customerTransport !== auth.customerTransport) refuse();
            if (record.customerPurpose !== auth.customerPurpose) refuse();
            if (record.v !== 1 || record.kind !== 'browser_session' ||
                ![record.issuedAt, record.idleExpiresAt, record.absoluteExpiresAt].every(Number.isSafeInteger)) refuse();
            const issuedAt = instant(new Date(record.issuedAt).toISOString());
            const expiresAt = instant(new Date(Math.min(record.idleExpiresAt, record.absoluteExpiresAt)).toISOString());
            if (issuedAt >= expiresAt) refuse();
            return { issuedAt, expiresAt };
        } catch (_) { refuse(); }
    }
    function sessionDigest(id) {
        if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(id)) refuse();
        const bytes = Buffer.from(id, 'base64url');
        if (bytes.length !== 32 || bytes.toString('base64url') !== id) refuse();
        return createHash('sha256').update(PREFIX).update(bytes).digest('hex');
    }
    function captureCookie(request) {
        // Header extraction only: the genuine session reader owns cookie parsing.
        if (typeof request.get === 'function') return String(request.get('cookie') || '').trim();
        const headers = request.headers || {};
        return String(headers.cookie || headers.COOKIE || '').trim();
    }
    function captureRequest(request) {
        if (!request || typeof request !== 'object' || isProxy(request)) return Promise.resolve(null);
        let entry = requests.get(request);
        if (!entry) {
            entry = { initialising: true, lastAt: null, failed: false, original: null };
            requests.set(request, entry);
            try {
                entry.cookie = captureCookie(request);
                entry.requestId = uuid(newId());
                entry.deadline = sample(entry) + budget;
                entry.deadlineIso = instant(new Date(entry.deadline).toISOString());
            } catch (_) { entry.failed = true; }
            entry.initialising = false;
        }
        if (entry.initialising || entry.failed) return Promise.reject(unavailable());
        return capture(entry);
    }
    async function capture(entry) {
        let parentId, parentRecord, providerFailed = false;
        // Each reader invocation owns its exact load result, including when two
        // requests await the same backing store concurrently.
        const readerStore = { ...store, async loadSession(id) {
            parentId = id;
            let loaded;
            try { loaded = await store.loadSession(id); } catch (_) { providerFailed = true; throw unavailable(); }
            if (loaded === undefined) { providerFailed = true; throw unavailable(); }
            if (loaded === null) return null;
            try { parentRecord = freeze(copy(loaded, LIMIT)); } catch (_) {
                throw new BrowserAuthError(401, 'browser_auth_session_invalid');
            }
            return parentRecord;
        } };
        try {
            sample(entry); configuredPolicy();
            const originalEpoch = await readEpoch(entry);
            const details = await readBrowserSessionDetails(entry.cookie,
                { env: auth.env, store: readerStore, ...(customer ? { customerPolicy: auth.customerPolicy } : {}),
                    ...(customerProvider ? { customerIdentityProvider: auth.customerIdentityProvider } : {}),
                    ...(auth.customerTransport ? { customerTransport: auth.customerTransport } : {}),
                    ...(auth.customerPurpose ? { customerPurpose: auth.customerPurpose } : {}), now: () => sample(entry) });
            sample(entry);
            if (!details) return null;
            if (auth.customerTransport === 'external' && parentRecord.customerAssurance?.stage === 'setup') refuse();
            const identityPayload = stableIdentity(details.identity);
            const life = parentLifetime(parentRecord);
            if (life.expiresAt !== details.expiresAt) refuse();
            requireWindow(entry, life);
            const sessionSha256 = sessionDigest(parentId);
            let rawProof;
            try { rawProof = await proof.readOriginalProof(sessionSha256); } catch (_) { throw unavailable(); }
            sample(entry);
            if (rawProof === undefined) throw unavailable();
            let operatorIssuanceProof = null;
            if (rawProof !== null) {
                try { operatorIssuanceProof = normaliseProof(rawProof); } catch (_) { refuse(); }
                const expected = { schemaVersion: 1, kind: proofKind, sessionSha256,
                    identitySha256: canonicalDigest(identityPayload), ...originalEpoch, ...life };
                if (!equal(operatorIssuanceProof, expected)) refuse();
            }
            if (customer && !operatorIssuanceProof) refuse();
            await sameEpoch(entry, originalEpoch);
            configuredPolicy(); requireWindow(entry, life);
            const value = freeze({ requestId: entry.requestId, deadline: entry.deadlineIso,
                sessionSha256, kind: customer ? 'customer' : 'operator_dashboard', identityPayload,
                ...originalEpoch, ...life, operatorIssuanceProof: customer ? null : operatorIssuanceProof, discovery: null });
            if (entry.original && !equal(entry.original, value)) refuse();
            if (!entry.original) entry.original = value;
            return value;
        } catch (error) {
            if (!entry.failed && !providerFailed && (error instanceof Refused ||
                error instanceof BrowserAuthError && (error.statusCode === 401 ||
                    error.statusCode === 400 && error.code === 'browser_auth_email_invalid'))) return null;
            throw unavailable();
        }
    }
    const callbackService = Object.freeze({
        completeLogin(input) {
            const attempt = { lastAt: null, failed: false, issuance: null };
            return callbacks.run(attempt, async () => {
                configuredPolicy();
                if (auth.customerPurpose === 'retained_read') attempt.deadline = sample(attempt) + budget;
                const result = await service.completeLogin(input);
                try {
                    if (!attempt.issuance) throw unavailable();
                    await sameEpoch(attempt, { instanceId: attempt.issuance.proof.instanceId,
                        restoreEpoch: attempt.issuance.proof.restoreEpoch });
                    configuredPolicy(); requireWindow(attempt, attempt.issuance.proof);
                    return result;
                } catch (_) {
                    const error = unavailable();
                    // The genuine callback has already consumed its one-use
                    // transaction, including when this final proof check fails.
                    error.clearTransactionCookie = true;
                    throw error;
                }
            });
        }
    });
    return Object.freeze({ callbackService, captureRequest });
}

module.exports = { createDashboardOperatorSession, createDashboardCustomerSession };
