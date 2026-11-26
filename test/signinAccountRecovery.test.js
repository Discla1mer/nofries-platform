'use strict';
const { createDom } = require('./fixtures/dashboardDom');
const { mountSignupJourney } = require('../api/shared/customerSignup/signupJourney');
const { createAuthCallbackFunction } = require('../api/authCallback');
const { BrowserAuthError } = require('../api/shared/browserAuth');

const REFERENCE = /^NF-[A-Z2-9]{6}$/;

async function callbackFailure(code) {
    const warn = jest.fn();
    const callback = createAuthCallbackFunction({ env: {}, customerEntry: true, customerTransport: 'external',
        service: { completeLogin: async () => { throw new BrowserAuthError(401, code); } } });
    const context = { log: { warn } };
    await callback(context, { method: 'POST', headers: { accept: 'text/html', 'user-agent': 'Mozilla/5.0' }, body: '' });
    return { response: context.res, warn };
}

function mount(options) {
    const dom = createDom(), create = dom.document.createElement;
    dom.document.createElement = tag => Object.assign(create(tag), { style: {} });
    const client = { load: jest.fn(async () => ({ status: 'create_account' })), createAccount: jest.fn(),
        acceptTerms: jest.fn(), completeSetup: jest.fn() };
    const view = mountSignupJourney(dom.root, client, options);
    return { ...dom, view };
}

test.each(['browser_auth_customer_required', 'browser_auth_email_verification_required'])(
    '%s sends the visitor to account recovery with a logged support reference', async code => {
        const { response, warn } = await callbackFailure(code);
        expect(response.status).toBe(303);
        const location = new URL(response.headers.Location, 'https://nofries.nz');
        expect(location.pathname).toBe('/login');
        expect(location.searchParams.get('signin')).toBe('account');
        expect(location.searchParams.get('provider')).toBe('external');
        const reference = location.searchParams.get('ref');
        expect(reference).toMatch(REFERENCE);
        // The same reference is in the log line, beside the real code, and nothing else leaks.
        expect(warn).toHaveBeenCalledWith(`Browser sign-in callback failed: ${code} ref=${reference}`);
        expect(response.headers.Location).not.toContain(code);
    });

test('other callback failures stay a generic retry but still carry a reference', async () => {
    const { response } = await callbackFailure('browser_auth_code_exchange_failed');
    const location = new URL(response.headers.Location, 'https://nofries.nz');
    expect(location.searchParams.get('signin')).toBe('retry');
    expect(location.searchParams.get('ref')).toMatch(REFERENCE);
});

test('each failure gets a fresh reference', async () => {
    const refs = new Set();
    for (let i = 0; i < 20; i++) {
        const { response } = await callbackFailure('browser_auth_customer_required');
        refs.add(new URL(response.headers.Location, 'https://nofries.nz').searchParams.get('ref'));
    }
    expect(refs.size).toBe(20);
});

test('account recovery explains the problem and how to get help, quoting the reference', async () => {
    const f = mount({ customerTransport: 'external', signInRecovery: 'account', supportReference: 'NF-7K3Q9A' });
    try {
        await f.view.ready;
        expect(f.root.textContent).toContain('Your account needs attention');
        expect(f.root.textContent).toContain('could not open an active account');
        expect(f.root.textContent).toContain('Email hello@nofries.nz and quote reference NF-7K3Q9A');
        expect(f.root.querySelector('button').textContent).toBe('Try signing in again');
        expect([...f.root.querySelectorAll('a')].map(a => a.textContent)).toContain('Sign in with another account');
    } finally { f.view.dispose(); }
});

test('a generic retry shows the reference as a support fallback', async () => {
    const f = mount({ customerTransport: 'external', signInRecovery: 'retry', supportReference: 'NF-ABC234' });
    try {
        await f.view.ready;
        expect(f.root.textContent).toContain('Restart secure sign-in');
        expect(f.root.textContent).toContain('If this keeps happening, email hello@nofries.nz and quote reference NF-ABC234.');
    } finally { f.view.dispose(); }
});

test.each([['account', 'Email hello@nofries.nz', 'NF-7K3Q9A'], ['retry', 'Get sign-in help', 'NF-ABC234'], ['expired', 'Get sign-in help', undefined]])(
    'the %s recovery screen has a tappable help email that quotes the reference', async (signInRecovery, label, supportReference) => {
        const f = mount({ customerTransport: 'external', signInRecovery, ...(supportReference ? { supportReference } : {}) });
        try {
            await f.view.ready;
            const link = [...f.root.querySelectorAll('a')].find(a => a.textContent === label);
            expect(link.href).toBe('mailto:hello@nofries.nz' + (supportReference
                ? '?subject=Sign-in%20help%2C%20reference%20' + supportReference : ''));
        } finally { f.view.dispose(); }
    });

test.each([
    [{ signInRecovery: 'account', supportReference: 'nf-7k3q9a' }],
    [{ signInRecovery: 'account', supportReference: 'NF-7K3Q9A<script>' }],
    [{ signInRecovery: 'account', supportReference: 'NF-0O1I00' }],
    [{ supportReference: 'NF-7K3Q9A' }],
    [{ signInRecovery: 'bogus' }]
])('the view refuses malformed or orphaned hints: %j', options => {
    expect(() => mountSignupJourney({}, {}, { customerTransport: 'external', ...options })).toThrow(/signup_view_(reference|recovery)_invalid/);
});

test('the daily new-account limit gets its own outcome, log code and screen, not a sign-in restart', async () => {
    const { response, warn } = await callbackFailure('browser_auth_signup_capacity_reached');
    const location = new URL(response.headers.Location, 'https://nofries.nz');
    expect(location.searchParams.get('signin')).toBe('busy');
    const reference = location.searchParams.get('ref');
    expect(warn).toHaveBeenCalledWith(`Browser sign-in callback failed: browser_auth_signup_capacity_reached ref=${reference}`);
    const f = mount({ customerTransport: 'external', signInRecovery: 'busy', supportReference: reference });
    try {
        await f.view.ready;
        expect(f.root.textContent).toContain('New accounts are full for today');
        expect(f.root.textContent).toContain('Come back tomorrow and sign in with the same email and password.');
        expect(f.root.textContent).toContain('quote reference ' + reference);
        expect(f.root.textContent).not.toContain('Restart secure sign-in');
        expect(f.root.querySelector('button').textContent).toBe('Try signing in again');
    } finally { f.view.dispose(); }
});

test.each([[Object.assign(new Error('x'), { code: 'setup_rate_limited' }), 'browser_auth_signup_capacity_reached'],
    [Object.assign(new Error('x'), { code: 'setup_unavailable' }), 'setup_unavailable'],
    [Object.assign(new Error('x'), { code: 'setup_rate_limited', contended: true }), 'setup_rate_limited'],
    [new Error('external_signup_admission_unavailable'), undefined]])(
    'only an exhausted new-account limit is named at first admission (%#)', async (failure, code) => {
        const { createExternalCustomerIdentityPolicy } = require('../api/shared/customerSignup/externalCustomerIdentityPolicy');
        const tenant = '11111111-1111-4111-8111-111111111111', app = '22222222-2222-4222-8222-222222222222',
            oid = '33333333-3333-4333-8333-333333333333', now = Date.parse('2026-11-27T00:00:00.000Z');
        const profile = { kind: 'external-id', tenantId: tenant, clientId: app, authority: 'https://synthetic-customer.ciamlogin.com/',
            issuer: `https://${tenant}.ciamlogin.com/${tenant}/v2.0`,
            authorizationEndpoint: `https://synthetic-customer.ciamlogin.com/${tenant}/oauth2/v2.0/authorize` };
        const identity = { tenantId: tenant, principalId: oid, subjectKey: `${tenant}:${oid}` };
        const policy = createExternalCustomerIdentityPolicy({ profile, records: { readSubject: async () => null }, allowNewSignup: true,
            signupAdmission: { reserve: async () => { throw failure; }, recheck: async () => {} }, now: () => now,
            verifyAuthentication: async () => ({ subjectKey: identity.subjectKey, email: 'synthetic@example.test',
                verifiedAt: now, expiresAt: now + 3600000, policySha256: 'a'.repeat(64) }),
            recheckAuthentication: async () => true });
        const attempt = policy.verify({ identity, context: { verifiedEmail: null },
            claims: { iss: profile.issuer, tid: tenant, oid, aud: app, exp: Math.floor(now / 1000) + 3600 } });
        if (code === 'browser_auth_signup_capacity_reached') {
            await expect(attempt).rejects.toBeInstanceOf(BrowserAuthError);
            await expect(attempt).rejects.toMatchObject({ statusCode: 429, code });
        } else await expect(attempt).rejects.toBe(failure);
    });

test('a full daily limit and lost write races are told apart by the budget itself', async () => {
    const { reserveSetupGlobalBudget } = require('../api/shared/organisationSetup');
    const key = n => String(n).padStart(64, 'a'), at = Date.parse('2026-11-27T00:00:00.000Z');
    const records = new Map();
    const store = { load: async k => records.has(k) ? { record: records.get(k), version: 1 } : null,
        create: async (k, v) => { records.set(k, v); return true; }, replace: async (k, _version, v) => { records.set(k, v); return true; } };
    for (let i = 0; i < 100; i++) await reserveSetupGlobalBudget(store, at, key(i));
    const full = await reserveSetupGlobalBudget(store, at, key(100)).catch(error => error);
    expect(full).toMatchObject({ statusCode: 429, code: 'setup_rate_limited' }); expect(full.contended).toBeUndefined();
    const racing = { load: async () => null, create: async () => false, replace: async () => false };
    expect(await reserveSetupGlobalBudget(racing, at, key(1)).catch(error => error))
        .toMatchObject({ statusCode: 429, code: 'setup_rate_limited', contended: true });
});
