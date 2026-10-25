'use strict';

const request = require('supertest');
const { createNoFriesApp } = require('../server');
const { createCustomerSignupRuntime, CustomerSignupRuntimeError, customerSignupErrorResponse } = require('../api/shared/customerSignup/customerSignupRuntime');

const TOKEN = 'x'.repeat(43);
const TERMS = { status: 'terms', termsText: 'Pilot terms', termsVersion: 'pilot-v1', termsDigest: 'a'.repeat(64) };
function signup(overrides = {}) {
    const calls = [];
    return { calls, config: {
        env: { NOFRIES_PUBLIC_URL: 'https://nofries.nz', NODE_ENV: 'production' },
        loadState: async () => TERMS,
        issueCsrfToken: async () => TOKEN,
        validateCsrfToken: async (_req, token) => token === TOKEN,
        acceptTerms: async value => { calls.push(value); return { status: 'pending_admission' }; },
        ...overrides
    } };
}

test('signup routes are absent unless explicitly injected', async () => {
    const response = await request(createNoFriesApp()).get('/api/customer-signup/state');
    expect(response.status).toBe(410);
});

test('GET state returns only approved terms and a server-issued CSRF token', async () => {
    const f = signup();
    const response = await request(createNoFriesApp({ customerSignup: f.config })).get('/api/customer-signup/state');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ state: TERMS, csrfToken: TOKEN });
});
test('saved read-only setup has a closed state and issues no write token', async () => {
    const issueCsrfToken = jest.fn(async () => TOKEN), f = signup({
        loadState: async () => ({ status: 'setup_read_only' }), issueCsrfToken });
    const response = await request(createNoFriesApp({ customerSignup: f.config })).get('/api/customer-signup/state');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ state: { status: 'setup_read_only' } });
    expect(issueCsrfToken).not.toHaveBeenCalled();
});
test.each(['accountType','email','termsDigest','canResume'])('read-only setup rejects extra %s authority or action data', async key => {
    const f = signup({ loadState: async () => ({ status: 'setup_read_only', [key]: 'untrusted' }) });
    const response = await request(createNoFriesApp({ customerSignup: f.config })).get('/api/customer-signup/state');
    expect(response.status).toBe(503);
});

test('POST terms requires same-origin CSRF and passes no browser identity fields downstream', async () => {
    const f = signup();
    const response = await request(createNoFriesApp({ customerSignup: f.config }))
        .post('/api/customer-signup/terms').set('Origin', 'https://nofries.nz').set('X-CSRF-Token', TOKEN)
        .send({ accepted: true, termsVersion: TERMS.termsVersion, termsDigest: TERMS.termsDigest });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ state: { status: 'pending_admission' } });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].input).toEqual({ accepted: true, termsVersion: TERMS.termsVersion, termsDigest: TERMS.termsDigest });
});

test.each([
    { headers: {}, body: { accepted: true, termsVersion: TERMS.termsVersion, termsDigest: TERMS.termsDigest } },
    { headers: { Origin: 'https://evil.example', 'X-CSRF-Token': TOKEN }, body: { accepted: true, termsVersion: TERMS.termsVersion, termsDigest: TERMS.termsDigest } },
    { headers: { Origin: 'https://nofries.nz', 'X-CSRF-Token': 'bad' }, body: { accepted: true, termsVersion: TERMS.termsVersion, termsDigest: TERMS.termsDigest } },
    { headers: { Origin: 'https://nofries.nz', 'X-CSRF-Token': TOKEN }, body: { accepted: true, termsVersion: TERMS.termsVersion, termsDigest: TERMS.termsDigest, tenantId: 'forged' } }
])('rejects unsafe or forged terms mutation %#', async input => {
    const f = signup();
    const response = await request(createNoFriesApp({ customerSignup: f.config }))
        .post('/api/customer-signup/terms').set(input.headers).send(input.body);
    expect([400, 403]).toContain(response.status);
    expect(f.calls).toHaveLength(0);
});

test('malformed provider state fails closed without exposing provider data', async () => {
    const f = signup({ loadState: async () => ({ status: 'terms', termsText: '', termsVersion: 'v1', termsDigest: 'a'.repeat(64) }) });
    const response = await request(createNoFriesApp({ customerSignup: f.config })).get('/api/customer-signup/state');
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'Signup is unavailable', code: 'signup_unavailable' });
});

test('CSRF validation requires the exact boolean true', async () => {
    const f = signup({ validateCsrfToken: async () => ({ valid: true }) });
    const response = await request(createNoFriesApp({ customerSignup: f.config }))
        .post('/api/customer-signup/terms').set('Origin', 'https://nofries.nz').set('X-CSRF-Token', TOKEN)
        .send({ accepted: true, termsVersion: TERMS.termsVersion, termsDigest: TERMS.termsDigest });
    expect(response.status).toBe(403);
    expect(f.calls).toHaveLength(0);
});

test.each([
    () => Object.defineProperty({ termsVersion: 'pilot-v1', termsDigest: 'a'.repeat(64), status: 'terms' },
        'termsText', { enumerable: true, get: () => 'provider getter' }),
    () => new (class ProviderState { constructor() { Object.assign(this, TERMS); } })()
])('provider state must be a stable plain data record %#', async makeState => {
    const f = signup({ loadState: async () => makeState() });
    const response = await request(createNoFriesApp({ customerSignup: f.config })).get('/api/customer-signup/state');
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'Signup is unavailable', code: 'signup_unavailable' });
});

test('receipt reconciliation has a distinct CSRF-protected mutation with no consent fields', async () => {
    const resumes = [];
    const f = signup({ loadState: async () => ({ status: 'resume_acceptance' }),
        resumeAcceptance: async value => { resumes.push(value); return { status: 'pending_admission' }; } });
    const app = createNoFriesApp({ customerSignup: f.config });
    const state = await request(app).get('/api/customer-signup/state');
    expect(state.body).toEqual({ state: { status: 'resume_acceptance' }, csrfToken: TOKEN });
    const result = await request(app).post('/api/customer-signup/terms')
        .set('Origin', 'https://nofries.nz').set('X-CSRF-Token', TOKEN).send({ resume: true });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ state: { status: 'pending_admission' } });
    expect(resumes).toHaveLength(1);
    expect(f.calls).toHaveLength(0);
});


test.each(['company', 'consultant'])('completed signup projects the approved %s destination type only', async accountType => {
    const f = signup({ loadState: async () => ({ status: 'continue_to_dashboard', accountType }) });
    const response = await request(createNoFriesApp({ customerSignup: f.config })).get('/api/customer-signup/state');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ state: { status: 'continue_to_dashboard', accountType } });
});
test.each([
    { status: 'continue_to_dashboard', accountType: 'operator' },
    { status: 'continue_to_dashboard', accountType: 'consultant', destination: 'https://foreign.invalid' },
    { status: 'terms', accountType: 'consultant', termsText: 'Terms', termsVersion: 'v1', termsDigest: 'a'.repeat(64) }
])('untrusted destination shape fails closed: %j', async value => {
    const f = signup({ loadState: async () => value });
    expect((await request(createNoFriesApp({ customerSignup: f.config })).get('/api/customer-signup/state')).status).toBe(503);
});

const RESERVED = { accountType: 'consultant', organisationName: 'Synthetic reserved workspace' };
const RECOVERY = { status: 'resume_setup', email: 'synthetic@example.test', ...RESERVED };
const setupRequest = body => ({ method: 'POST', headers: { origin: 'https://nofries.nz', 'x-csrf-token': TOKEN }, body });

test.each([RECOVERY, { status: 'setup_details', email: RECOVERY.email, reservation: RESERVED }])(
    'a retained setup projection issues CSRF without performing setup: %s', async current => {
        const completeSetup = jest.fn(), acceptTerms = jest.fn(), issueCsrfToken = jest.fn(async () => TOKEN);
        const runtime = createCustomerSignupRuntime(signup({ loadState: async () => current, completeSetup, acceptTerms, issueCsrfToken }).config);
        const result = await runtime.handle({ method: 'GET' }, 'state');
        expect(result).toEqual({ status: 200, body: { state: current, csrfToken: TOKEN } });
        expect(Object.isFrozen(result.body.state)).toBe(true);
        if (current.reservation) expect(Object.isFrozen(result.body.state.reservation)).toBe(true);
        expect(issueCsrfToken).toHaveBeenCalledTimes(1); expect(completeSetup).not.toHaveBeenCalled(); expect(acceptTerms).not.toHaveBeenCalled();
    });

test('setup resumption passes only the closed resume command after origin and CSRF validation', async () => {
    const completeSetup = jest.fn(async () => ({ status: 'continue_authentication' }));
    const runtime = createCustomerSignupRuntime(signup({ completeSetup }).config), req = setupRequest({ resume: true });
    expect(await runtime.handle(req, 'setup')).toEqual({ status: 200, body: { state: { status: 'continue_authentication' } } });
    expect(completeSetup).toHaveBeenCalledWith({ req, input: { resume: true } });
    expect(Object.isFrozen(completeSetup.mock.calls[0][0].input)).toBe(true);
});

test.each([{ resume: false }, { resume: 'true' }, { resume: true, details: {} },
    { resume: true, accountType: 'company', organisationName: 'Replacement' }, { resume: true, subjectKey: 'forged' }])(
    'resume cannot carry edited details or identity: %j', async body => {
        const completeSetup = jest.fn(), runtime = createCustomerSignupRuntime(signup({ completeSetup }).config);
        await expect(runtime.handle(setupRequest(body), 'setup')).rejects.toMatchObject({ statusCode: 400, code: 'signup_request_invalid' });
        expect(completeSetup).not.toHaveBeenCalled();
    });

test.each([
    { origin: 'https://foreign.invalid', 'x-csrf-token': TOKEN }, { origin: 'https://nofries.nz' },
    { origin: 'https://nofries.nz', 'x-csrf-token': 'invalid' }
])('resume requires the existing origin/CSRF guard %#', async headers => {
    const completeSetup = jest.fn(), runtime = createCustomerSignupRuntime(signup({ completeSetup }).config);
    await expect(runtime.handle({ ...setupRequest({ resume: true }), headers }, 'setup')).rejects.toMatchObject({ statusCode: 403 });
    expect(completeSetup).not.toHaveBeenCalled();
});

test('the existing complete-details mutation keeps its original payload', async () => {
    const completeSetup = jest.fn(async () => ({ status: 'continue_authentication' }));
    const runtime = createCustomerSignupRuntime(signup({ completeSetup }).config);
    const body = { ...RESERVED, details: { name: 'Synthetic name', role: 'Owner', address: 'Synthetic address', registrationId: '', authorityConfirmed: true } };
    await runtime.handle(setupRequest(body), 'setup');
    expect(completeSetup.mock.calls[0][0].input).toEqual(body);
});

test.each([
    { ...RECOVERY, email: 'synthetic@example.test\n' }, { ...RECOVERY, accountType: 'staff' },
    { ...RECOVERY, organisationName: 'x'.repeat(121) }, { ...RECOVERY, organisationName: ' Untrimmed' },
    { ...RECOVERY, organisationName: 'Synthetic\nname' }, { ...RECOVERY, details: { private: 'not-a-projection' } },
    { status: 'setup_details', email: RECOVERY.email, reservation: null },
    { status: 'setup_details', email: RECOVERY.email, reservation: { ...RESERVED, subjectKey: 'forged' } }
])('malformed retained setup state cannot be presented as resumable %#', async current => {
    const issueCsrfToken = jest.fn(), runtime = createCustomerSignupRuntime(signup({ loadState: async () => current, issueCsrfToken }).config);
    await expect(runtime.handle({ method: 'GET' }, 'state')).rejects.toMatchObject({ statusCode: 503, code: 'signup_unavailable' });
    expect(issueCsrfToken).not.toHaveBeenCalled();
});

test('reservation accessors are rejected without being read', async () => {
    const getter = jest.fn(() => { throw new Error('synthetic-private-value'); });
    const reservation = Object.defineProperty({ accountType: 'company' }, 'organisationName', { enumerable: true, get: getter });
    const completeSetup = jest.fn(), runtime = createCustomerSignupRuntime(signup({ completeSetup,
        loadState: async () => ({ status: 'setup_details', email: RECOVERY.email, reservation }) }).config);
    await expect(runtime.handle({ method: 'GET' }, 'state')).rejects.toMatchObject({ code: 'signup_unavailable' });
    expect(getter).not.toHaveBeenCalled(); expect(completeSetup).not.toHaveBeenCalled();
});

test('only a trusted confirmed sign-in error clears the external session cookie', () => {
    const result = customerSignupErrorResponse(new CustomerSignupRuntimeError(401, 'signup_signin_required'));
    expect(result.status).toBe(401); expect(result.body).toEqual({ error: 'Signup is unavailable', code: 'signup_signin_required' });
    expect(result.headers['Set-Cookie']).toBe('__Host-nofries-external-customer=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
    for (const error of [{ statusCode: 401, code: 'signup_signin_required' }, new CustomerSignupRuntimeError(503, 'signup_unavailable'),
        new CustomerSignupRuntimeError(401, 'other_auth_failure')]) expect(customerSignupErrorResponse(error).headers).toBeUndefined();
});
