'use strict';
const request = require('supertest');
const { createNoFriesApp } = require('../server');
const { createSignupDiagnostics } = require('../api/shared/customerSignup/signupDiagnostics');
const { CustomerSignupRuntimeError } = require('../api/shared/customerSignup/customerSignupRuntime');
const { resetAbuseProtectionForTests } = require('../api/shared/abuseProtection');
const { createSignupClient } = require('../api/shared/customerSignup/signupClient');
const report = require('../js/customer-report');
const { customerProductionHarness } = require('./helpers/customerProductionHarness');
const { createProductionDashboardConfiguration } = require('../lib/dashboardProduction');
const { createExternalCustomerSignupConfiguration } = require('../lib/customerSignupProduction');
const TOKEN = 'x'.repeat(43), PRIVATE = 'synthetic-private-provider-token';
beforeEach(resetAbuseProtectionForTests);
function fixture(external, overrides = {}) {
    const events = [], diagnostic = createSignupDiagnostics({ sink: event => events.push(event) });
    const config = { env: { NOFRIES_PUBLIC_URL: 'https://nofries.nz', NODE_ENV: 'production' },
        loadState: async () => { diagnostic('signup_state', new Error(PRIVATE)); throw new Error(PRIVATE); },
        acceptTerms: async () => ({ status: 'pending_admission' }),
        issueCsrfToken: async () => TOKEN, validateCsrfToken: async () => true, ...overrides };
    let dashboard;
    if (external) {
        const h = customerProductionHarness({ external: true });
        dashboard = createProductionDashboardConfiguration(h.env, h.dependencies);
        const provider = createExternalCustomerSignupConfiguration(h.env, dashboard, h.dependencies, h.dependencies.externalCustomer);
        dashboard = { ...dashboard, externalCustomer: provider.customer };
    }
    const app = createNoFriesApp({ ...(dashboard ? { dashboard } : {}), [external ? 'externalCustomerSignup' : 'customerSignup']: config });
    return { app, events, diagnostic, route: '/api/' + (external ? 'external-customer-signup' : 'customer-signup') };
}

test.each([false, true])('original %s signup HTTP failure matches only its safe diagnostic and ignores incoming IDs', async external => {
    const f = fixture(external), response = await request(f.app).get(f.route + '/state')
        .set('X-NoFries-Support-Reference', 'NF-FFFFFFFFFFFFFFFF').set('X-Request-ID', PRIVATE).set('Cookie', 'unrelated=' + PRIVATE);
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'Signup is unavailable', code: 'signup_unavailable' });
    const reference = response.headers['x-nofries-support-reference'];
    expect(reference).toMatch(/^NF-[A-F0-9]{16}$/); expect(reference).toHaveLength(19);
    expect(reference).not.toBe('NF-FFFFFFFFFFFFFFFF'); expect(f.events).toHaveLength(1);
    expect(f.events[0]).toEqual({ timestamp: expect.any(String), stage: 'signup_state', code: 'signup_state_unavailable', supportReference: reference });
    expect(Object.isFrozen(f.events[0])).toBe(true); expect(JSON.stringify(f.events)).not.toContain(PRIVATE);
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.headers['x-nofries-release-sha']).toBeUndefined(); // Source fixture is not a stamped package.
    expect(response.headers['cache-control']).toContain('no-store'); expect(response.headers['x-content-type-options']).toBe('nosniff');
});

test('repeated requests receive fresh references and concurrent requests do not cross-contaminate events', async () => {
    const f = fixture(true), responses = await Promise.all(Array.from({ length: 4 }, () => request(f.app).get(f.route + '/state')));
    const references = responses.map(response => response.headers['x-nofries-support-reference']);
    expect(new Set(references).size).toBe(4); expect(f.events).toHaveLength(4);
    expect(new Set(f.events.map(event => event.supportReference))).toEqual(new Set(references));
    const later = await request(f.app).get(f.route + '/state');
    expect(references).not.toContain(later.headers['x-nofries-support-reference']);
});

test('HTTP200 unavailable retains its exact body and known successful states receive no support header', async () => {
    const f = fixture(true);
    // The same existing diagnostic builder can be used by nested loadState callbacks.
    let fail = true;
    const loadState = async () => { if (fail) f.diagnostic('signup_state'); return { status: fail ? 'unavailable' : 'pending_admission' }; };
    const second = fixture(true, { loadState });
    const unavailable = await request(second.app).get(second.route + '/state');
    expect(unavailable.status).toBe(200); expect(unavailable.body).toEqual({ state: { status: 'unavailable' } });
    expect(unavailable.headers['x-nofries-support-reference']).toBe(f.events[0].supportReference);
    fail = false;
    const success = await request(second.app).get(second.route + '/state');
    expect(success.status).toBe(200); expect(success.body).toEqual({ state: { status: 'pending_admission' } });
    expect(success.headers['x-nofries-support-reference']).toBeUndefined();
});

test('confirmed401 keeps the exact session-clearing cookie while carrying an optional matching reference', async () => {
    let diagnostic;
    const f = fixture(true, { loadState: async () => { diagnostic('customer_session'); throw new CustomerSignupRuntimeError(401, 'signup_signin_required'); } });
    diagnostic = f.diagnostic;
    const response = await request(f.app).get(f.route + '/state');
    expect(response.status).toBe(401); expect(response.body).toEqual({ error: 'Signup is unavailable', code: 'signup_signin_required' });
    expect(response.headers['set-cookie']).toEqual(['__Host-nofries-external-customer=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT']);
    expect(response.headers['x-nofries-support-reference']).toBe(f.events[0].supportReference);
});

test('missing-event failures and origin/CSRF rejection remain uncorrelated and do not execute a mutation', async () => {
    const acceptTerms = jest.fn(), f = fixture(true, { loadState: async () => { throw new Error(PRIVATE); }, acceptTerms });
    const failed = await request(f.app).get(f.route + '/state');
    expect(failed.status).toBe(503); expect(failed.headers['x-nofries-support-reference']).toBeUndefined();
    const rejected = await request(f.app).post(f.route + '/terms').set('Origin', 'https://foreign.example.test')
        .set('X-CSRF-Token', TOKEN).send({ accepted: true, termsVersion: 'v1', termsDigest: 'a'.repeat(64) });
    expect(rejected.status).toBe(403); expect(rejected.headers['x-nofries-support-reference']).toBeUndefined();
    expect(acceptTerms).not.toHaveBeenCalled(); expect(f.events).toEqual([]);
});

test('the actual HTTP result survives the browser transport and exact reviewed report without an extra read', async () => {
    const f = fixture(true), fetch = jest.fn(async path => {
        const res = await request(f.app).get(path);
        return new Response(JSON.stringify(res.body), { status: res.status, headers: res.headers });
    });
    const client = createSignupClient({ fetch, createAccount: jest.fn(), customerTransport: 'external' });
    let error; try { await client.load(); } catch (caught) { error = caught; }
    const metadata = client.diagnostic(error); expect(metadata.supportReference).toBe(f.events[0].supportReference);
    const context = report.readContext(report.link({ kind: 'error', screen: 'signup', code: 'signup_unavailable', reference: metadata.supportReference }).split('#')[1]);
    const draft = report.prepare({ kind: 'error', screen: 'signup', description: 'Status check did not finish.' }, context,
        'NF-FEDCBA9876543210', '2026-10-13T11:00:00.000Z');
    expect(draft.body).toContain('Support reference: ' + metadata.supportReference);
    expect(draft.body).not.toContain(PRIVATE); expect(new URL(draft.mailto).searchParams.get('body')).toBe(draft.body);
    expect(fetch).toHaveBeenCalledTimes(1);
});
