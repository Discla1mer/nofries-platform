const crypto = require('crypto');
const {
    BrowserSessionStoreError,
    createBrowserSessionStore
} = require('./browserSessionStore');
const {
    createCustomerIdentityProviderProfile,
    customerProviderKey,
    CustomerIdentityProviderProfileError
} = require('./customerSignup/customerIdentityProviderProfile');

const SESSION_COOKIE_NAME = '__Host-nofries-auth';
const TRANSACTION_COOKIE_NAME = '__Host-nofries-auth-tx';
const RETAINED_READ_COOKIE_NAME = '__Host-nofries-retained-read';
const RETAINED_READ_TRANSACTION_COOKIE_NAME = RETAINED_READ_COOKIE_NAME + '-tx';
const COOKIE_NAME = SESSION_COOKIE_NAME;
const TRANSACTION_KIND = 'oidc_transaction';
const SESSION_KIND = 'browser_session';
const TRANSACTION_TTL_MS = 5 * 60 * 1000;
const SESSION_ABSOLUTE_TTL_MS = 4 * 60 * 60 * 1000;
const MAX_COOKIE_BYTES = 4096;
const MAX_FORM_BYTES = 16 * 1024;
const CLOCK_SKEW_SECONDS = 60;
const OIDC_SCOPES = Object.freeze(['openid', 'profile', 'email']);
const ALLOWED_RETURN_PATHS = new Set(['/', '/operator', '/scoping', '/support', '/portal', '/dashboard', '/dashboard-admin/entry', '/signup']);
const RETAINED_RETURN_PATHS = new Set(['/api/retained-results']);

class BrowserAuthError extends Error {
    constructor(statusCode, code, message = 'No Fries could not complete sign-in.') {
        super(message);
        this.name = 'BrowserAuthError';
        this.statusCode = statusCode;
        this.code = code;
    }
}

function createBrowserAuthService(options = {}) {
    const env = options.env || process.env;
    const now = options.now || (() => Date.now());
    const randomBytes = options.randomBytes || crypto.randomBytes;
    const customerPolicy = options.customerPolicy || null;
    if (customerPolicy && ['begin', 'verify', 'recheck'].some(key => typeof customerPolicy[key] !== 'function')) {
        throw new BrowserAuthError(503, 'browser_auth_customer_policy_invalid');
    }
    const customerProvider = readCustomerProvider(options, env, customerPolicy);
    const customerTransport = readCustomerTransport(options, customerPolicy, customerProvider);
    const customerPurpose = readCustomerPurpose(options, customerTransport);
    const assertion = Object.hasOwn(options, 'clientAssertion');
    if (assertion && (customerTransport !== 'external' || typeof options.clientAssertion !== 'function' ||
        Object.hasOwn(env, 'NOFRIES_CUSTOMER_ENTRA_CLIENT_SECRET'))) {
        throw new BrowserAuthError(503, 'browser_auth_customer_credential_invalid');
    }
    const config = readBrowserAuthConfig(env, customerPolicy !== null, customerProvider, customerTransport, assertion);
    const sessionCookie = customerPurpose ? RETAINED_READ_COOKIE_NAME : customerTransport ? '__Host-nofries-external-customer' : customerPolicy ? '__Host-nofries-customer' : SESSION_COOKIE_NAME;
    const transactionCookie = customerPurpose ? RETAINED_READ_TRANSACTION_COOKIE_NAME : customerTransport ? '__Host-nofries-external-customer-tx' : customerPolicy ? '__Host-nofries-customer-tx' : TRANSACTION_COOKIE_NAME;
    const store = options.store || createBrowserSessionStore({
        env,
        containerClient: options.containerClient,
        serviceClient: options.serviceClient,
        credential: options.credential
    });
    let clientApplication = options.clientApplication || null;
    let cryptoProvider = options.cryptoProvider || null;

    function ensureMsalClients() {
        if (clientApplication && cryptoProvider) return;
        let msal = options.msal;
        if (!msal) {
            try {
                msal = require('@azure/msal-node');
            } catch (error) {
                throw new BrowserAuthError(503, 'browser_auth_dependency_missing');
            }
        }
        if (!clientApplication) {
            clientApplication = new msal.ConfidentialClientApplication({
                auth: {
                    clientId: config.clientId,
                    ...(assertion ? { clientAssertion: options.clientAssertion } : { clientSecret: config.clientSecret }),
                    authority: config.authority,
                    knownAuthorities: config.knownAuthorities.slice()
                }
            });
        }
        if (!cryptoProvider) cryptoProvider = new msal.CryptoProvider();
    }

    async function beginLogin(input = {}) {
        const selectAccount = Object.hasOwn(input, 'selectAccount');
        if (selectAccount && (input.selectAccount !== true || customerTransport !== 'external')) {
            throw new BrowserAuthError(400, 'browser_auth_account_change_invalid');
        }
        const registration = Object.hasOwn(input, 'registration');
        if (registration && (input.registration !== true || customerTransport !== 'external' || customerPurpose || selectAccount)) {
            throw new BrowserAuthError(400, 'browser_auth_registration_invalid');
        }
        ensureMsalClients();
        const returnTo = customerPurpose
            ? normaliseReturnTo(input.returnTo, config.publicOrigin, '/api/retained-results', RETAINED_RETURN_PATHS)
            : customerPolicy ? '/signup' : normaliseReturnTo(input.returnTo, config.publicOrigin, '/operator');
        const customer = customerPolicy ? await customerPolicy.begin(input) : null;
        const correlationId = randomOpaqueId(randomBytes);
        const state = randomOpaqueId(randomBytes);
        const nonce = randomOpaqueId(randomBytes);
        let pkce;
        try {
            pkce = await cryptoProvider.generatePkceCodes();
        } catch (error) {
            throw new BrowserAuthError(503, 'browser_auth_pkce_unavailable');
        }
        assertPkceCodes(pkce);

        let location;
        try {
            location = await clientApplication.getAuthCodeUrl({
                scopes: OIDC_SCOPES.slice(),
                redirectUri: config.callbackUrl,
                responseMode: 'form_post',
                state,
                nonce,
                codeChallenge: pkce.challenge,
                codeChallengeMethod: 'S256',
                ...(registration ? { prompt: 'create' } : selectAccount ? { prompt: 'login' } : customerTransport === 'external' ? {} : { prompt: 'select_account' }),
                ...(customer ? { claims: customer.claims,
                    ...(!selectAccount && !registration && customer.loginHint ? { loginHint: customer.loginHint } : {}) } : {})
            });
        } catch (error) {
            throw new BrowserAuthError(503, 'browser_auth_provider_unavailable');
        }
        assertTrustedAuthorizationUrl(location, config, { state, nonce, challenge: pkce.challenge, selectAccount, registration });

        const issuedAt = Number(now());
        await storeCall(() => store.createTransaction(correlationId, {
            v: 1,
            kind: TRANSACTION_KIND,
            issuedAt,
            expiresAt: issuedAt + TRANSACTION_TTL_MS,
            state,
            nonce,
            codeVerifier: pkce.verifier,
            returnTo,
            ...(customer ? { customer: customer.context } : {}),
            ...(customerProvider ? { customerProviderKey: config.customerProviderKey } : {}),
            ...(customerTransport ? { customerTransport } : {}),
            ...(customerPurpose ? { customerPurpose } : {})
        }));
        return {
            location,
            cookie: makeCookie(transactionCookie, correlationId, TRANSACTION_TTL_MS / 1000, 'None')
        };
    }

    async function completeLogin(input = {}) {
        ensureMsalClients();
        const form = parseFormBody(input.body);
        const returnedState = boundedRequiredString(form.state, 1024, 'browser_auth_state_missing');
        const correlationId = requireOpaqueCookie(
            input.cookieHeader,
            transactionCookie,
            'browser_auth_transaction_missing'
        );
        const consumed = await storeCall(() => store.consumeTransaction(correlationId, returnedState, customerPurpose));
        if (!consumed) throw new BrowserAuthError(401, 'browser_auth_transaction_invalid');
        if (!consumed.matched || !consumed.record) {
            throw new BrowserAuthError(400, 'browser_auth_state_invalid');
        }
        const transaction = consumed.record;
        try {
            validateTransaction(transaction, now, customerPurpose);
            if (Object.hasOwn(transaction, 'customer') !== !!customerPolicy) throw new BrowserAuthError(401, 'browser_auth_transaction_invalid');
            if (transaction.customerProviderKey !== config.customerProviderKey) throw new BrowserAuthError(401, 'browser_auth_transaction_invalid');
            if (transaction.customerTransport !== customerTransport) throw new BrowserAuthError(401, 'browser_auth_transaction_invalid');
            if (!constantTimeEqual(returnedState, transaction.state)) {
                throw new BrowserAuthError(400, 'browser_auth_state_invalid');
            }
            if (form.error) throw new BrowserAuthError(400, 'browser_auth_provider_rejected');
            const code = boundedRequiredString(form.code, 8192, 'browser_auth_code_missing');

            let result;
            let identity;
            let customerAssurance;
            try {
                result = await clientApplication.acquireTokenByCode({
                    code,
                    scopes: OIDC_SCOPES.slice(),
                    redirectUri: config.callbackUrl,
                    codeVerifier: transaction.codeVerifier,
                    nonce: transaction.nonce
                });
                validateTransaction(transaction, now, customerPurpose);
                identity = validatedIdentity(result, transaction.nonce, config, now);
                if (customerPolicy) customerAssurance = await customerPolicy.verify({
                    identity, claims: result.idTokenClaims, context: transaction.customer, now: Number(now())
                });
                assertAssurancePurpose(customerAssurance, customerPurpose);
            } catch (error) {
                if (error instanceof BrowserAuthError) throw error;
                throw new BrowserAuthError(400, 'browser_auth_code_exchange_failed');
            } finally {
                if (result) await discardTokenCache(clientApplication, result);
                result = null;
            }

            // Provider exchange and token-cache cleanup may outlast the original
            // five-minute attempt. Consuming it never extends that deadline.
            validateTransaction(transaction, now, customerPurpose);
            const sessionId = randomOpaqueId(randomBytes);
            const issuedAt = Number(now());
            const absoluteExpiresAt = customerPolicy
                ? Math.min(issuedAt + SESSION_ABSOLUTE_TTL_MS, customerAssurance.expiresAt)
                : issuedAt + SESSION_ABSOLUTE_TTL_MS;
            if (!Number.isSafeInteger(absoluteExpiresAt) || absoluteExpiresAt <= issuedAt) {
                throw new BrowserAuthError(401, 'browser_auth_customer_assurance_expired');
            }
            await storeCall(() => store.createSession(sessionId, {
                v: 1,
                kind: SESSION_KIND,
                issuedAt,
                idleExpiresAt: absoluteExpiresAt,
                absoluteExpiresAt,
                identity,
                ...(customerPolicy ? { customerAssurance } : {}),
                ...(customerProvider ? { customerProviderKey: config.customerProviderKey } : {}),
                ...(customerTransport ? { customerTransport } : {}),
                ...(customerPurpose ? { customerPurpose } : {})
            }));
            try {
                validateTransaction(transaction, now, customerPurpose);
            } catch (error) {
                // No session cookie has been issued. A delayed save must not
                // turn an ended transaction into browser authentication.
                await storeCall(() => store.deleteSession(sessionId));
                throw error;
            }
            const cookie = makeCookie(sessionCookie, sessionId, Math.floor((absoluteExpiresAt - issuedAt) / 1000), 'Lax');
            return {
                location: transaction.returnTo,
                cookie,
                ...(customerTransport === 'external' ? { cookies: [cookie, clearCookie(transactionCookie, 'None')] } : {}),
                identity,
                expiresAt: new Date(absoluteExpiresAt).toISOString()
            };
        } catch (error) {
            if (error && typeof error === 'object') {
                error.clearTransactionCookie = true;
            }
            throw error;
        }
    }

    async function readSession(cookieHeader) {
        const details = await readSessionDetails(cookieHeader);
        return details && details.identity || null;
    }

    async function readSessionDetails(cookieHeader) {
        return readStoredSession(cookieHeader, { env, now, store, customerPolicy, customerProvider, customerTransport, customerPurpose });
    }

    async function logout(input = {}) {
        const sessionId = optionalOpaqueCookie(input.cookieHeader, sessionCookie);
        if (sessionId) {
            const record = await storeCall(() => store.loadSession(sessionId));
            if (record === undefined) throw new BrowserAuthError(503, 'browser_auth_store_unavailable');
            if (record !== null) assertSessionPurpose(record, customerPurpose);
            await storeCall(() => store.deleteSession(sessionId));
        }
        return {
            location: normaliseReturnTo(input.returnTo, config.publicOrigin, '/'),
            cookie: clearCookie(sessionCookie, 'Lax')
        };
    }

    async function logoutSetup(input = {}) {
        if (customerTransport !== 'external' || customerPurpose !== undefined) {
            throw new BrowserAuthError(400, 'browser_auth_account_change_invalid');
        }
        if (!input || typeof input !== 'object' || Array.isArray(input) ||
            Object.keys(input).some(key => key !== 'cookieHeader') ||
            input.cookieHeader != null && typeof input.cookieHeader !== 'string') {
            throw new BrowserAuthError(400, 'browser_auth_account_change_invalid');
        }
        // Parse both names before storage effects. Neither competing purpose's
        // cookie nor its records belong to this setup-only operation.
        const sessionId = optionalOpaqueCookie(input.cookieHeader, sessionCookie);
        const transactionId = optionalOpaqueCookie(input.cookieHeader, transactionCookie);
        let ownedSetupSession = false;
        if (sessionId) {
            const record = await storeCall(() => store.loadSession(sessionId));
            if (record === undefined) throw new BrowserAuthError(503, 'browser_auth_store_unavailable');
            if (record !== null) {
                validateSetupLogoutRecord(record, env, now, customerProvider, customerTransport);
                ownedSetupSession = true;
            }
        }
        if (transactionId) {
            const cancelled = await storeCall(() => store.cancelTransaction(transactionId, {
                customerProviderKey: config.customerProviderKey, customerTransport
            }));
            if (cancelled === 'missing') throw new BrowserAuthError(503, 'browser_auth_account_change_pending');
            if (cancelled === false) throw new BrowserAuthError(401, 'browser_auth_transaction_invalid');
            if (cancelled !== true) throw new BrowserAuthError(503, 'browser_auth_store_unavailable');
        }
        if (ownedSetupSession) await storeCall(() => store.deleteSession(sessionId));
        return { location: '/signup?provider=external&account=choose', cookie: [
            clearCookie(sessionCookie, 'Lax'), clearCookie(transactionCookie, 'None')
        ] };
    }

    return { beginLogin, completeLogin, logout, logoutSetup, readSession, readSessionDetails };
}

async function readBrowserSessionCookie(source, options = {}) {
    const details = await readBrowserSessionDetails(source, options);
    return details && details.identity || null;
}

async function readBrowserSessionDetails(source, options = {}) {
    const env = options.env || process.env;
    const customerPolicy = options.customerPolicy || null;
    const customerProvider = readCustomerProvider(options, env, customerPolicy);
    const customerTransport = readCustomerTransport(options, customerPolicy, customerProvider);
    const customerPurpose = readCustomerPurpose(options, customerTransport);
    const store = options.store || createBrowserSessionStore(Object.assign({}, options, { env }));
    return readStoredSession(source, {
        env,
        store,
        now: options.now || (() => Date.now()),
        customerPolicy,
        customerProvider,
        customerTransport,
        customerPurpose
    });
}

async function readStoredSession(source, options) {
    const cookieHeader = typeof source === 'string' ? source : getHeader(source, 'cookie');
    const sessionId = optionalOpaqueCookie(cookieHeader, options.customerPurpose ? RETAINED_READ_COOKIE_NAME : options.customerTransport ? '__Host-nofries-external-customer' : options.customerPolicy ? '__Host-nofries-customer' : SESSION_COOKIE_NAME);
    if (!sessionId) return null;
    const record = await storeCall(() => options.store.loadSession(sessionId));
    if (!record) throw new BrowserAuthError(401, 'browser_auth_session_invalid');
    // A transplanted SID does not grant ownership of the other purpose's
    // record, including ownership of its invalid-session cleanup.
    assertSessionPurpose(record, options.customerPurpose);
    try {
        const details = validateSessionRecord(record, options.env, options.now, !!options.customerPolicy, options.customerProvider, options.customerTransport);
        if (options.customerPolicy) {
            await options.customerPolicy.recheck({ identity: details.identity, assurance: record.customerAssurance, now: Number(options.now()) });
            if (Math.min(record.idleExpiresAt, record.absoluteExpiresAt) <= Number(options.now())) throw new BrowserAuthError(401, 'browser_auth_session_expired');
        }
        return details;
    } catch (error) {
        if (error instanceof BrowserAuthError && error.statusCode === 401) {
            try {
                await options.store.deleteSession(sessionId);
            } catch (deleteError) {
                // Invalid records fail closed even when cleanup is delayed.
            }
        }
        throw error;
    }
}

// Explicit composition seam only: no environment switch or production caller
// selects an external customer provider. Discovery, admission and MFA integration
// must be reviewed before this option is connected to a live route.
// The option accepts the raw six-field configuration (kind, tenantId, clientId,
// authority, issuer, authorizationEndpoint), not the factory's derived output.
function readCustomerProvider(options, env, customerPolicy) {
    if (options.customerIdentityProvider === undefined) return undefined;
    if (!customerPolicy) throw new BrowserAuthError(503, 'browser_auth_customer_provider_requires_policy');
    if (['begin', 'verify', 'recheck'].some(key => typeof customerPolicy[key] !== 'function')) {
        throw new BrowserAuthError(503, 'browser_auth_customer_policy_invalid');
    }
    let profile;
    try {
        profile = createCustomerIdentityProviderProfile(options.customerIdentityProvider, {
            tenantId: env.NOFRIES_ENTRA_TENANT_ID, clientId: env.NOFRIES_ENTRA_CLIENT_ID
        });
    } catch (error) {
        if (error instanceof CustomerIdentityProviderProfileError) throw new BrowserAuthError(503, error.code);
        throw error;
    }
    if (profile.clientId !== String(env.NOFRIES_CUSTOMER_ENTRA_CLIENT_ID || '').trim().toLowerCase()) {
        throw new BrowserAuthError(503, 'browser_auth_customer_provider_client_mismatch');
    }
    return profile;
}

// A fixed trusted constructor choice, never an arbitrary callback/cookie path.
// Legacy records omit the field so their exact namespace remains compatible.
function readCustomerTransport(options, customerPolicy, customerProvider) {
    if (options.customerTransport === undefined) return undefined;
    if (options.customerTransport !== 'external' || !customerPolicy || customerProvider?.kind !== 'external-id') {
        throw new BrowserAuthError(503, 'browser_auth_customer_transport_invalid');
    }
    return 'external';
}

function readCustomerPurpose(options, customerTransport) {
    if (!Object.hasOwn(options, 'customerPurpose')) return undefined;
    if (options.customerPurpose !== 'retained_read' || customerTransport !== 'external') {
        throw new BrowserAuthError(503, 'browser_auth_customer_purpose_invalid');
    }
    return 'retained_read';
}

function assertAssurancePurpose(assurance, purpose) {
    if (purpose === 'retained_read' ? assurance?.stage !== 'retained_read' : assurance?.stage === 'retained_read') {
        throw new BrowserAuthError(401, 'browser_auth_session_purpose_invalid');
    }
}

function assertSessionPurpose(record, purpose) {
    if (record.customerPurpose !== purpose) throw new BrowserAuthError(401, 'browser_auth_session_purpose_invalid');
    assertAssurancePurpose(record.customerAssurance, purpose);
}

function readBrowserAuthConfig(env, customer = false, customerProvider, customerTransport, assertion = false) {
    const publicOrigin = configuredPublicOrigin(env.NOFRIES_PUBLIC_URL);
    const tenant = customerProvider ? customerProvider.tenantId : configuredTenant(env.NOFRIES_ENTRA_TENANT_ID);
    const separateCustomer = customer && (assertion || env.NOFRIES_CUSTOMER_ENTRA_CLIENT_ID !== undefined || env.NOFRIES_CUSTOMER_ENTRA_CLIENT_SECRET !== undefined);
    const clientId = configuredGuid(separateCustomer ? env.NOFRIES_CUSTOMER_ENTRA_CLIENT_ID : env.NOFRIES_ENTRA_CLIENT_ID, 'browser_auth_client_id_invalid');
    const clientSecret = assertion ? undefined : configuredSecret(separateCustomer ? env.NOFRIES_CUSTOMER_ENTRA_CLIENT_SECRET : env.NOFRIES_ENTRA_CLIENT_SECRET);
    if (separateCustomer && clientId === String(env.NOFRIES_ENTRA_CLIENT_ID).trim().toLowerCase()) {
        throw new BrowserAuthError(503, 'browser_auth_customer_client_not_separate');
    }
    const requireAuth = String(env.NOFRIES_REQUIRE_AUTH || '').trim().toLowerCase() !== 'false';
    return {
        publicOrigin,
        callbackUrl: `${publicOrigin}${customerTransport ? '/api/external-customer-auth/callback' : customer ? '/api/customer-auth/callback' : '/api/auth/callback'}`,
        tenant,
        expectedTenantId: tenant,
        authority: customerProvider ? customerProvider.authority : `https://login.microsoftonline.com/${tenant}`,
        knownAuthorities: customerProvider ? customerProvider.knownAuthorities : ['login.microsoftonline.com'],
        expectedIssuer: customerProvider ? customerProvider.issuer.replace(/\/$/, '').toLowerCase() : `https://login.microsoftonline.com/${tenant}/v2.0`,
        authorizationEndpoint: customerProvider ? customerProvider.authorizationEndpoint : `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
        customerProviderKey: customerProviderKey(customerProvider),
        clientId,
        clientSecret,
        allowedSubjects: parseAllowedSubjects(env.NOFRIES_ALLOWED_SUBJECTS, requireAuth && !customer),
        requireAuth, customer
    };
}

function configuredPublicOrigin(value) {
    let url;
    try {
        url = new URL(String(value || ''));
    } catch (error) {
        throw new BrowserAuthError(503, 'browser_auth_public_url_invalid');
    }
    if (
        url.protocol !== 'https:' || url.username || url.password ||
        url.pathname !== '/' || url.search || url.hash
    ) {
        throw new BrowserAuthError(503, 'browser_auth_public_url_invalid');
    }
    return url.origin;
}

function configuredTenant(value) {
    const tenant = String(value || '').trim().toLowerCase();
    if (!isGuid(tenant)) throw new BrowserAuthError(503, 'browser_auth_tenant_invalid');
    return tenant;
}

function configuredGuid(value, code) {
    const result = String(value || '').trim().toLowerCase();
    if (!isGuid(result)) throw new BrowserAuthError(503, code);
    return result;
}

function configuredSecret(value) {
    const result = String(value || '').trim();
    if (!result || result.length > 4096 || /[\u0000-\u001f\u007f]/.test(result)) {
        throw new BrowserAuthError(503, 'browser_auth_client_secret_missing');
    }
    return result;
}

function parseAllowedSubjects(value, required = true) {
    const entries = String(value || '')
        .split(/[\s,;]+/)
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean);
    const result = new Set();
    for (const entry of entries) {
        const pieces = entry.split(':');
        if (pieces.length !== 2 || !isGuid(pieces[0]) || !isGuid(pieces[1])) {
            throw new BrowserAuthError(503, 'browser_auth_allowed_subjects_invalid');
        }
        result.add(`${pieces[0]}:${pieces[1]}`);
    }
    if (required && !result.size) {
        throw new BrowserAuthError(503, 'browser_auth_allowed_subjects_missing');
    }
    return result;
}

function isGuid(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(String(value || ''));
}

function validateTransaction(value, now, customerPurpose) {
    const current = Number(now());
    if (
        !value || typeof value !== 'object' || Array.isArray(value) ||
        value.v !== 1 || value.kind !== TRANSACTION_KIND ||
        !Number.isFinite(value.issuedAt) || !Number.isFinite(value.expiresAt) ||
        value.expiresAt <= value.issuedAt || value.expiresAt - value.issuedAt !== TRANSACTION_TTL_MS ||
        value.issuedAt > current + (CLOCK_SKEW_SECONDS * 1000) || value.expiresAt <= current
    ) {
        throw new BrowserAuthError(401, 'browser_auth_transaction_expired');
    }
    if (!isOpaqueId(value.state) || !isOpaqueId(value.nonce)) {
        throw new BrowserAuthError(401, 'browser_auth_transaction_invalid');
    }
    if (value.customerPurpose !== customerPurpose) throw new BrowserAuthError(401, 'browser_auth_transaction_invalid');
    assertPkceCodes({ verifier: value.codeVerifier, challenge: 'a'.repeat(43) });
    normaliseReturnTo(value.returnTo, 'https://nofries.invalid', customerPurpose ? '/api/retained-results' : '/operator',
        customerPurpose ? RETAINED_RETURN_PATHS : ALLOWED_RETURN_PATHS);
}

function validatedIdentity(result, expectedNonce, config, now) {
    const claims = result && result.idTokenClaims;
    const account = result && result.account || {};
    if (!claims || typeof claims !== 'object' || Array.isArray(claims)) {
        throw new BrowserAuthError(400, 'browser_auth_identity_invalid');
    }
    if (!constantTimeEqual(String(claims.nonce || ''), expectedNonce)) {
        throw new BrowserAuthError(400, 'browser_auth_nonce_invalid');
    }
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.map((item) => String(item).toLowerCase()).includes(config.clientId)) {
        throw new BrowserAuthError(400, 'browser_auth_audience_invalid');
    }
    const tenantId = String(claims.tid || '').trim().toLowerCase();
    if (tenantId !== config.expectedTenantId) {
        throw new BrowserAuthError(403, 'browser_auth_tenant_not_allowed');
    }
    if (String(claims.iss || '').replace(/\/$/, '').toLowerCase() !== config.expectedIssuer) {
        throw new BrowserAuthError(400, 'browser_auth_issuer_invalid');
    }
    const tokenExpiresAt = Number(claims.exp);
    if (!Number.isFinite(tokenExpiresAt) || tokenExpiresAt <= Math.floor(Number(now()) / 1000) - CLOCK_SKEW_SECONDS) {
        throw new BrowserAuthError(400, 'browser_auth_token_expired');
    }
    const principalId = String(claims.oid || '').trim().toLowerCase();
    if (!isGuid(principalId)) throw new BrowserAuthError(400, 'browser_auth_subject_missing');
    const subjectKey = `${tenantId}:${principalId}`;
    if (config.requireAuth && !config.customer && !config.allowedSubjects.has(subjectKey)) {
        throw new BrowserAuthError(403, 'browser_auth_subject_not_allowed');
    }
    return {
        email: normaliseOptionalEmail(
            claims.preferred_username || claims.email || claims.upn || account.username
        ),
        name: String(claims.name || account.name || '').trim().slice(0, 160),
        provider: 'entra-bff',
        principalId,
        tenantId,
        subjectKey,
        isAuthenticated: true
    };
}

function validateSessionRecord(record, env, now, customer = false, customerProvider, customerTransport, allowExpired = false) {
    const current = Number(now());
    if (
        !record || typeof record !== 'object' || Array.isArray(record) ||
        record.v !== 1 || record.kind !== SESSION_KIND ||
        !Number.isFinite(record.issuedAt) || !Number.isFinite(record.idleExpiresAt) ||
        !Number.isFinite(record.absoluteExpiresAt) ||
        record.absoluteExpiresAt <= record.issuedAt ||
        record.absoluteExpiresAt - record.issuedAt > SESSION_ABSOLUTE_TTL_MS ||
        record.idleExpiresAt > record.absoluteExpiresAt ||
        record.issuedAt > current + (CLOCK_SKEW_SECONDS * 1000)
    ) {
        throw new BrowserAuthError(401, 'browser_auth_session_invalid');
    }
    if (!allowExpired && (record.idleExpiresAt <= current || record.absoluteExpiresAt <= current)) {
        throw new BrowserAuthError(401, 'browser_auth_session_expired');
    }
    if (Object.hasOwn(record, 'customerAssurance') !== customer) throw new BrowserAuthError(401, 'browser_auth_session_invalid');
    if (record.customerProviderKey !== customerProviderKey(customerProvider)) throw new BrowserAuthError(401, 'browser_auth_session_provider_invalid');
    if (record.customerTransport !== customerTransport) throw new BrowserAuthError(401, 'browser_auth_session_provider_invalid');
    const identity = validatedSessionIdentity(record.identity);
    const requireAuth = String(env.NOFRIES_REQUIRE_AUTH || '').trim().toLowerCase() !== 'false';
    const expectedTenantId = customerProvider ? customerProvider.tenantId : configuredTenant(env.NOFRIES_ENTRA_TENANT_ID);
    if (identity.tenantId !== expectedTenantId) {
        throw new BrowserAuthError(401, 'browser_auth_session_tenant_invalid');
    }
    const allowedSubjects = parseAllowedSubjects(env.NOFRIES_ALLOWED_SUBJECTS, requireAuth && !customer);
    if (requireAuth && !customer && !allowedSubjects.has(identity.subjectKey)) {
        throw new BrowserAuthError(401, 'browser_auth_session_revoked');
    }
    return {
        identity,
        expiresAt: new Date(Math.min(record.idleExpiresAt, record.absoluteExpiresAt)).toISOString()
    };
}

function validateSetupLogoutRecord(record, env, now, customerProvider, customerTransport) {
    const { identity } = validateSessionRecord(record, env, now, true, customerProvider, customerTransport, true);
    const recordKeys = ['v', 'kind', 'issuedAt', 'idleExpiresAt', 'absoluteExpiresAt', 'identity',
        'customerAssurance', 'customerProviderKey', 'customerTransport'];
    const value = record.customerAssurance;
    const keys = ['stage', 'subjectKey', 'email', 'verifiedAt', 'expiresAt', 'providerKey', 'authentication'];
    const proof = value && value.authentication;
    const proofKeys = ['subjectKey', 'email', 'verifiedAt', 'expiresAt', 'policySha256'];
    if (Object.keys(record).length !== recordKeys.length || recordKeys.some(key => !Object.hasOwn(record, key)) ||
        !Number.isSafeInteger(record.issuedAt) || !Number.isSafeInteger(record.idleExpiresAt) ||
        !Number.isSafeInteger(record.absoluteExpiresAt) || record.idleExpiresAt <= record.issuedAt ||
        !value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key)) ||
        value.stage !== 'setup' || value.subjectKey !== identity.subjectKey ||
        value.providerKey !== customerProviderKey(customerProvider) ||
        !proof || typeof proof !== 'object' || Array.isArray(proof) ||
        Object.keys(proof).length !== proofKeys.length || proofKeys.some(key => !Object.hasOwn(proof, key)) ||
        proof.subjectKey !== identity.subjectKey || proof.email !== value.email ||
        value.email !== normaliseOptionalEmail(value.email) || !value.email ||
        !Number.isSafeInteger(proof.verifiedAt) || proof.verifiedAt < 0 || proof.verifiedAt > Number(now()) ||
        !Number.isSafeInteger(proof.expiresAt) || proof.expiresAt <= proof.verifiedAt ||
        value.verifiedAt !== proof.verifiedAt || value.expiresAt !== proof.expiresAt ||
        record.absoluteExpiresAt !== Math.min(record.issuedAt + SESSION_ABSOLUTE_TTL_MS, proof.expiresAt) ||
        record.idleExpiresAt !== record.absoluteExpiresAt ||
        typeof proof.policySha256 !== 'string' || !/^[0-9a-f]{64}$/.test(proof.policySha256)) {
        throw new BrowserAuthError(401, 'browser_auth_setup_session_required');
    }
}

function validatedSessionIdentity(identity) {
    if (!identity || typeof identity !== 'object' || identity.provider !== 'entra-bff' || identity.isAuthenticated !== true) {
        throw new BrowserAuthError(401, 'browser_auth_session_invalid');
    }
    const tenantId = String(identity.tenantId || '').trim().toLowerCase();
    const principalId = String(identity.principalId || '').trim().toLowerCase();
    if (!isGuid(tenantId) || !isGuid(principalId) || identity.subjectKey !== `${tenantId}:${principalId}`) {
        throw new BrowserAuthError(401, 'browser_auth_session_invalid');
    }
    return {
        email: normaliseOptionalEmail(identity.email),
        name: String(identity.name || '').trim().slice(0, 160),
        provider: 'entra-bff',
        principalId,
        tenantId,
        subjectKey: identity.subjectKey,
        isAuthenticated: true
    };
}

function normaliseReturnTo(value, publicOrigin, fallback, allowedPaths = ALLOWED_RETURN_PATHS) {
    const raw = value == null || String(value).trim() === '' ? fallback : String(value).trim();
    if (
        raw.length > 2048 || !raw.startsWith('/') || raw.startsWith('//') ||
        raw.includes('\\') || /[\u0000-\u001f\u007f]/.test(raw)
    ) {
        throw new BrowserAuthError(400, 'browser_auth_return_path_invalid');
    }
    let parsed;
    try {
        parsed = new URL(raw, publicOrigin);
    } catch (error) {
        throw new BrowserAuthError(400, 'browser_auth_return_path_invalid');
    }
    let decoded;
    try {
        decoded = decodeURIComponent(`${parsed.pathname}${parsed.search}${parsed.hash}`);
    } catch (error) {
        throw new BrowserAuthError(400, 'browser_auth_return_path_invalid');
    }
    if (
        parsed.origin !== publicOrigin || !allowedPaths.has(parsed.pathname) ||
        decoded.includes('\\') || /[\u0000-\u001f\u007f]/.test(decoded)
    ) {
        throw new BrowserAuthError(400, 'browser_auth_return_path_invalid');
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

function parseFormBody(value) {
    if (value == null) return {};
    if (Buffer.isBuffer(value)) {
        if (value.length > MAX_FORM_BYTES) throw new BrowserAuthError(413, 'browser_auth_callback_too_large');
        return parseUrlEncoded(value.toString('utf8'));
    }
    if (typeof value === 'string') {
        if (Buffer.byteLength(value, 'utf8') > MAX_FORM_BYTES) {
            throw new BrowserAuthError(413, 'browser_auth_callback_too_large');
        }
        return parseUrlEncoded(value);
    }
    if (typeof value === 'object' && !Array.isArray(value)) {
        if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_FORM_BYTES) {
            throw new BrowserAuthError(413, 'browser_auth_callback_too_large');
        }
        return value;
    }
    throw new BrowserAuthError(400, 'browser_auth_callback_invalid');
}

function parseUrlEncoded(value) {
    const params = new URLSearchParams(value);
    const result = {};
    for (const [name, item] of params.entries()) {
        if (Object.prototype.hasOwnProperty.call(result, name)) {
            throw new BrowserAuthError(400, 'browser_auth_callback_invalid');
        }
        result[name] = item;
    }
    return result;
}

function assertTrustedAuthorizationUrl(value, config, expected) {
    const endpoint = new URL(config.authorizationEndpoint);
    let url;
    try {
        url = new URL(String(value || ''));
    } catch (error) {
        throw new BrowserAuthError(503, 'browser_auth_provider_url_invalid');
    }
    if (
        url.protocol !== 'https:' || url.origin !== endpoint.origin ||
        url.username || url.password ||
        url.pathname.toLowerCase() !== endpoint.pathname.toLowerCase() ||
        url.searchParams.get('client_id') !== config.clientId ||
        url.searchParams.get('redirect_uri') !== config.callbackUrl ||
        url.searchParams.get('response_mode') !== 'form_post' ||
        url.searchParams.get('state') !== expected.state ||
        url.searchParams.get('nonce') !== expected.nonce ||
        url.searchParams.get('code_challenge') !== expected.challenge ||
        url.searchParams.get('code_challenge_method') !== 'S256' ||
        (expected.selectAccount || expected.registration) && (url.searchParams.getAll('prompt').length !== 1 ||
            url.searchParams.get('prompt') !== (expected.registration ? 'create' : 'login') || url.searchParams.has('login_hint'))
    ) {
        throw new BrowserAuthError(503, 'browser_auth_provider_url_invalid');
    }
}

function assertPkceCodes(value) {
    if (
        !value || typeof value !== 'object' ||
        !/^[A-Za-z0-9._~-]{43,128}$/.test(String(value.verifier || '')) ||
        !/^[A-Za-z0-9_-]{43,128}$/.test(String(value.challenge || ''))
    ) {
        throw new BrowserAuthError(503, 'browser_auth_pkce_invalid');
    }
}

function assertExactSameOriginRequest(req, env = process.env) {
    const expectedOrigin = configuredPublicOrigin(env.NOFRIES_PUBLIC_URL);
    const origin = getHeader(req, 'origin');
    const fetchSite = getHeader(req, 'sec-fetch-site').toLowerCase();
    let actualOrigin;
    try {
        actualOrigin = new URL(origin).origin;
    } catch (error) {
        throw new BrowserAuthError(403, 'same_origin_required');
    }
    if (origin !== actualOrigin || actualOrigin !== expectedOrigin || fetchSite !== 'same-origin') {
        throw new BrowserAuthError(403, 'same_origin_required');
    }
}

async function discardTokenCache(clientApplication, result) {
    try {
        if (!result.account || typeof clientApplication.getTokenCache !== 'function') return;
        const tokenCache = clientApplication.getTokenCache();
        if (tokenCache && typeof tokenCache.removeAccount === 'function') {
            await tokenCache.removeAccount(result.account);
        }
    } catch (error) {
        throw new BrowserAuthError(503, 'browser_auth_token_cache_cleanup_failed');
    }
}

function makeCookie(name, value, maxAgeSeconds, sameSite) {
    const cookie = `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=${sameSite}; Max-Age=${maxAgeSeconds}`;
    if (Buffer.byteLength(cookie, 'utf8') > MAX_COOKIE_BYTES) {
        throw new BrowserAuthError(500, 'browser_auth_cookie_too_large');
    }
    return cookie;
}

function clearAuthCookie() {
    return clearCookie(SESSION_COOKIE_NAME, 'Lax');
}

function clearTransactionCookie() {
    return clearCookie(TRANSACTION_COOKIE_NAME, 'None');
}

function clearCustomerTransactionCookie() {
    return clearCookie('__Host-nofries-customer-tx', 'None');
}

function clearExternalCustomerTransactionCookie() {
    return clearCookie('__Host-nofries-external-customer-tx', 'None');
}

function clearRetainedReadTransactionCookie() {
    return clearCookie(RETAINED_READ_TRANSACTION_COOKIE_NAME, 'None');
}

// Only selects the closed callback service. Cookies are not authentication;
// that service must atomically consume its own purpose-bound transaction.
function externalCustomerCallbackPurpose(cookieHeader) {
    const ordinary = optionalOpaqueCookie(cookieHeader, '__Host-nofries-external-customer-tx');
    const retained = optionalOpaqueCookie(cookieHeader, RETAINED_READ_TRANSACTION_COOKIE_NAME);
    if (ordinary && retained) throw new BrowserAuthError(400, 'browser_auth_callback_purpose_ambiguous');
    return retained ? 'retained_read' : undefined;
}

function clearCookie(name, sameSite) {
    return `${name}=; Path=/; HttpOnly; Secure; SameSite=${sameSite}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

function requireOpaqueCookie(header, name, missingCode) {
    const value = optionalSingleCookie(header, name);
    if (!value) throw new BrowserAuthError(401, missingCode);
    if (!isOpaqueId(value)) throw new BrowserAuthError(401, 'browser_auth_cookie_invalid');
    return value;
}

function optionalOpaqueCookie(header, name) {
    const value = optionalSingleCookie(header, name);
    if (!value) return '';
    if (!isOpaqueId(value)) throw new BrowserAuthError(401, 'browser_auth_cookie_invalid');
    return value;
}

function optionalSingleCookie(header, name) {
    const matches = String(header || '')
        .split(';')
        .map((part) => part.trim())
        .filter(Boolean)
        .filter((part) => part.startsWith(`${name}=`))
        .map((part) => part.slice(name.length + 1));
    if (matches.length > 1) throw new BrowserAuthError(401, 'browser_auth_cookie_invalid');
    return matches[0] || '';
}

function isOpaqueId(value) {
    const text = String(value || '');
    if (!/^[A-Za-z0-9_-]{43}$/.test(text)) return false;
    try {
        return Buffer.from(text, 'base64url').length === 32 &&
            Buffer.from(text, 'base64url').toString('base64url') === text;
    } catch (error) {
        return false;
    }
}

function boundedRequiredString(value, maximumLength, code) {
    const result = String(value || '').trim();
    if (!result || result.length > maximumLength || /[\u0000-\u001f\u007f]/.test(result)) {
        throw new BrowserAuthError(400, code);
    }
    return result;
}

function randomOpaqueId(randomBytes) {
    const value = randomBytes(32);
    if (!Buffer.isBuffer(value) || value.length !== 32) {
        throw new BrowserAuthError(503, 'browser_auth_random_unavailable');
    }
    return value.toString('base64url');
}

function constantTimeEqual(left, right) {
    const leftBuffer = Buffer.from(String(left || ''), 'utf8');
    const rightBuffer = Buffer.from(String(right || ''), 'utf8');
    return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function normaliseOptionalEmail(value) {
    const email = String(value || '').trim().toLowerCase();
    if (!email) return '';
    if (email.length > 320 || !email.includes('@') || /[\u0000-\u001f\u007f]/.test(email)) {
        throw new BrowserAuthError(400, 'browser_auth_email_invalid');
    }
    return email;
}

async function storeCall(work) {
    try {
        return await work();
    } catch (error) {
        if (error instanceof BrowserAuthError) throw error;
        if (error instanceof BrowserSessionStoreError) {
            throw new BrowserAuthError(503, error.code);
        }
        throw new BrowserAuthError(503, 'browser_auth_store_unavailable');
    }
}

function getHeader(req, name) {
    if (!req) return '';
    if (typeof req.get === 'function') return String(req.get(name) || '').trim();
    const headers = req.headers || {};
    return String(headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()] || '').trim();
}

module.exports = {
    BrowserAuthError,
    COOKIE_NAME,
    OIDC_SCOPES,
    SESSION_COOKIE_NAME,
    TRANSACTION_COOKIE_NAME,
    assertExactSameOriginRequest,
    clearAuthCookie,
    clearTransactionCookie,
    clearCustomerTransactionCookie,
    clearExternalCustomerTransactionCookie,
    clearRetainedReadTransactionCookie,
    externalCustomerCallbackPurpose,
    createBrowserAuthService,
    normaliseReturnTo,
    parseAllowedSubjects,
    parseFormBody,
    readBrowserSessionCookie,
    readBrowserSessionDetails
};
