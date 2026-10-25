'use strict';

// Managed-provider and admission contracts are synthetic. Real browser-auth,
// dashboard issuance proofs and session capture run without live identity I/O.
const { createBrowserAuthService, BrowserAuthError } = require('../api/shared/browserAuth');
const { MemoryBrowserSessionStore } = require('../api/shared/browserSessionStore');
const { createDashboardCustomerSession, createDashboardOperatorSession } = require('../api/shared/dashboardOperatorSession');

const id = n => '91000000-0000-4000-8000-' + String(n).padStart(12, '0');
const NOW = Date.parse('2026-10-07T00:00:00Z');
const cookie = result => result.cookie.split(';')[0];
const clone = value => JSON.parse(JSON.stringify(value));

function fixture() {
    const provider = { kind: 'external-id', tenantId: id(3), clientId: id(4),
        authority: 'https://synthetic-dashboard.ciamlogin.com/',
        issuer: 'https://' + id(3) + '.ciamlogin.com/' + id(3) + '/v2.0',
        authorizationEndpoint: 'https://synthetic-dashboard.ciamlogin.com/' + id(3) + '/oauth2/v2.0/authorize' };
    const state = { now: NOW, bytes: 0, requests: 100, revoked: false };
    const store = new MemoryBrowserSessionStore(), proofs = new Map();
    const policy = {
        async begin() { return { context: { kind: 'synthetic-admission' } }; },
        async verify({ identity }) {
            if (identity.subjectKey !== id(3) + ':' + id(5)) throw new BrowserAuthError(403, 'synthetic_admission_denied');
            return { subjectKey: identity.subjectKey, expiresAt: state.now + 3600000 };
        },
        async recheck({ identity, assurance }) {
            if (state.revoked || identity.subjectKey !== assurance.subjectKey) throw new BrowserAuthError(401, 'synthetic_admission_revoked');
        }
    };
    const env = { NOFRIES_REQUIRE_AUTH: 'true', NOFRIES_PUBLIC_URL: 'https://nofries.example.test',
        NOFRIES_ENTRA_TENANT_ID: id(1), NOFRIES_ENTRA_CLIENT_ID: id(2),
        NOFRIES_ENTRA_CLIENT_SECRET: 'synthetic-staff-secret', NOFRIES_ALLOWED_SUBJECTS: id(1) + ':' + id(6),
        NOFRIES_CUSTOMER_ENTRA_CLIENT_ID: id(4), NOFRIES_CUSTOMER_ENTRA_CLIENT_SECRET: 'synthetic-customer-secret' };
    const browserAuthOptions = { env, store, customerPolicy: policy, customerIdentityProvider: provider,
        randomBytes: size => Buffer.alloc(size, ++state.bytes),
        cryptoProvider: { async generatePkceCodes() { return { verifier: 'v'.repeat(64), challenge: 'c'.repeat(43) }; } },
        clientApplication: {
            async getAuthCodeUrl(request) {
                const url = new URL(provider.authorizationEndpoint);
                for (const [key, value] of Object.entries({ client_id: id(4), redirect_uri: request.redirectUri,
                    response_mode: request.responseMode, state: request.state, nonce: request.nonce,
                    code_challenge: request.codeChallenge, code_challenge_method: request.codeChallengeMethod })) url.searchParams.set(key, value);
                return url.href;
            },
            async acquireTokenByCode(request) {
                return { idTokenClaims: { tid: id(3), aud: id(4), oid: id(5), iss: provider.issuer,
                    nonce: request.nonce, exp: state.now / 1000 + 3600, email: 'display-only@example.test' },
                    account: { localAccountId: id(5) } };
            },
            getTokenCache() { return { async removeAccount() {} }; }
        } };
    const options = { browserAuthOptions,
        identityPolicy: { policyId: 'synthetic-external-policy', policyRevision: 0, issuer: provider.issuer,
            identityTenantId: id(3), audience: id(4) },
        proofStore: {
            async createOriginalProof(key, value) {
                if (proofs.has(key)) throw new Error('synthetic collision');
                proofs.set(key, clone(value));
            },
            async readOriginalProof(key) { return proofs.has(key) ? clone(proofs.get(key)) : null; }
        },
        clock: () => new Date(state.now).toISOString(),
        readExternalRuntimeEpoch: async () => ({ instanceId: id(7), restoreEpoch: id(8) }),
        newRequestId: () => id(++state.requests), requestBudgetMs: 1000 };
    const browser = createBrowserAuthService({ ...browserAuthOptions, now: () => state.now });
    return { state, provider, store, proofs, options, browser,
        async begin() {
            const started = await browser.beginLogin();
            return { cookieHeader: cookie(started),
                body: { code: 'synthetic-code', state: new URL(started.location).searchParams.get('state') } };
        } };
}
async function login(h, adapter) {
    const input = await h.begin(), result = await adapter.callbackService.completeLogin(input);
    return { result, input, request: { headers: { cookie: cookie(result) } } };
}

test('customer provider callback issues and captures the original dashboard proof with its immutable identity', async () => {
    const h = fixture(), adapter = createDashboardCustomerSession(h.options);
    const issued = await login(h, adapter), capture = await adapter.captureRequest(issued.request);
    expect(capture.kind).toBe('customer');
    expect(capture.identityPayload).toEqual({ ...h.options.identityPolicy, oid: id(5) });
    expect(h.proofs.size).toBe(1);
    expect([...h.proofs.values()][0].kind).toBe('customer_dashboard_issuance');
    expect(capture.operatorIssuanceProof).toBeNull();
    expect([...h.store.sessions.values()][0].customerProviderKey).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(capture)).not.toContain('display-only@example.test');
});

test('fresh customer login after ordinary parent logout keeps the same identity and creates a new proof', async () => {
    const h = fixture(), adapter = createDashboardCustomerSession(h.options);
    const first = await login(h, adapter), capture = await adapter.captureRequest(first.request);
    await h.browser.logout({ cookieHeader: cookie(first.result) });
    await expect(adapter.captureRequest(first.request)).resolves.toBeNull();
    const next = await login(h, adapter), again = await adapter.captureRequest(next.request);
    expect(again.identityPayload).toEqual(capture.identityPayload);
    expect(again.sessionSha256).not.toBe(capture.sessionSha256);
    expect(h.proofs.size).toBe(2);
});

test.each(['removed', 'changed'])('a %s provider binding cannot retain dashboard authority', async kind => {
    const h = fixture(), adapter = createDashboardCustomerSession(h.options), issued = await login(h, adapter);
    const record = [...h.store.sessions.values()][0];
    if (kind === 'removed') delete record.customerProviderKey;
    else record.customerProviderKey = 'f'.repeat(64);
    await expect(adapter.captureRequest(issued.request)).resolves.toBeNull();
});

test.each(['missing proof', 'wrong proof', 'revoked admission'])('%s cannot retain customer dashboard authority', async kind => {
    const h = fixture(), adapter = createDashboardCustomerSession(h.options), issued = await login(h, adapter);
    if (kind === 'missing proof') h.proofs.clear();
    if (kind === 'wrong proof') [...h.proofs.values()][0].identitySha256 = 'f'.repeat(64);
    if (kind === 'revoked admission') h.state.revoked = true;
    await expect(adapter.captureRequest(issued.request)).resolves.toBeNull();
});

test('an injected provider cannot enter staff capture or use the staff identity policy', () => {
    const h = fixture();
    expect(() => createDashboardOperatorSession(h.options)).toThrow(BrowserAuthError);
    expect(() => createDashboardCustomerSession({ ...h.options, identityPolicy: {
        ...h.options.identityPolicy, identityTenantId: id(1),
        issuer: 'https://login.microsoftonline.com/' + id(1) + '/v2.0' } })).toThrow(BrowserAuthError);
});

test('replaying a successful external callback cannot issue a second original proof', async () => {
    const h = fixture(), adapter = createDashboardCustomerSession(h.options), issued = await login(h, adapter);
    await expect(adapter.callbackService.completeLogin(issued.input)).rejects.toBeInstanceOf(BrowserAuthError);
    expect(h.proofs.size).toBe(1);
    expect(h.store.sessions.size).toBe(1);
});
