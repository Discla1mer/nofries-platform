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

test.each([
    [{ signInRecovery: 'account', supportReference: 'nf-7k3q9a' }],
    [{ signInRecovery: 'account', supportReference: 'NF-7K3Q9A<script>' }],
    [{ signInRecovery: 'account', supportReference: 'NF-0O1I00' }],
    [{ supportReference: 'NF-7K3Q9A' }],
    [{ signInRecovery: 'bogus' }]
])('the view refuses malformed or orphaned hints: %j', options => {
    expect(() => mountSignupJourney({}, {}, { customerTransport: 'external', ...options })).toThrow(/signup_view_(reference|recovery)_invalid/);
});
