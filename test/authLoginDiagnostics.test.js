'use strict';
const request = require('supertest');
const { BrowserAuthError } = require('../api/shared/browserAuth');
const { resetAbuseProtectionForTests } = require('../api/shared/abuseProtection');
const { customerProductionHarness } = require('./helpers/customerProductionHarness');
const { createProductionApplication } = require('../lib/productionApplication');
const handlers = [
    ['Login', 'GET', 'beginLogin'], ['Callback', 'POST', 'completeLogin'], ['Session', 'GET', 'readSessionDetails']
];
const warning = code => `Browser sign-in start failed: ${code}`;
let warn;
beforeEach(() => { resetAbuseProtectionForTests(); warn = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => jest.restoreAllMocks());

describe.each(handlers)('staff %s diagnostics', (name, method, operation) => {
    const factory = require(`../api/auth${name}`)[`createAuth${name}Function`];
    const req = { method, headers: { cookie: 'synthetic-private-cookie' },
        body: 'code=synthetic-private-code', query: { returnTo: '/operator?synthetic-private-query' } };
    test.each(['browser_auth_provider_unavailable', 'browser_auth_store_unavailable', 'browser_auth_dashboard_unavailable',
        'browser_auth_store_unavailable\nprivate@example.test', 'unknown', null])('allowlists failure %s exactly once', async code => {
        const error = code === null ? new Error('synthetic-private-exception') : new BrowserAuthError(503, code);
        error.diagnosticStage = 'transaction_store private@example.test';
        const context = { log: { warn: jest.fn() } };
        await factory({ env: {}, service: { async [operation]() { throw error; } } })(context, req);
        const safe = code && !code.includes('\n') && code !== 'unknown' ? code : 'browser_auth_unexpected';
        expect(context.log.warn.mock.calls).toEqual([[warning(safe)]]);
        expect(context.res.status).toBe(code === null && name !== 'Session' ? 500 : 503);
        expect(context.res.body.code).toBe('browser_auth_unavailable');
        expect(JSON.stringify(context.res)).not.toMatch(/private@example|synthetic/);
        expect(context.res.headers['Set-Cookie']).toBeUndefined();
    });
    test.each([undefined, {}, { warn() { throw new Error('synthetic logger failure'); } }])('falls back from absent/failing logger', async log => {
        const context = { log };
        await factory({ env: {}, service: { async [operation]() { throw new BrowserAuthError(503, 'browser_auth_dashboard_unavailable'); } } })(context, req);
        expect(context.res.status).toBe(503);
        expect(warn.mock.calls).toEqual([[warning('browser_auth_dashboard_unavailable')]]);
    });
    test('logs a rate-limit rejection once', async () => {
        const handler = factory({ env: { NOFRIES_RATE_API_READ_MAX: '1', NOFRIES_RATE_API_WRITE_MAX: '1' } });
        await handler({ log: console }, req); warn.mockClear();
        const context = { log: console }; await handler(context, req);
        expect(context.res.status).toBe(429);
        expect(warn.mock.calls).toEqual([[warning('rate_limited')]]);
    });
    test('logs configuration failure before the service exists', async () => {
        const context = { log: console };
        await factory({ env: {} })(context, req);
        expect(context.res.status).toBe(503);
        expect(warn.mock.calls).toEqual([[warning('browser_auth_public_url_invalid')]]);
    });
    test.each([[{ method: 'DELETE' }, 405, 'method_not_allowed'], [{ headers: { 'user-agent': 'sqlmap' } }, 403, 'request_blocked']])
    ('logs early rejection without request data', async (change, status, code) => {
        const context = { log: console };
        await factory({ env: {} })(context, { ...req, ...change });
        expect(context.res.status).toBe(status);
        expect(warn.mock.calls).toEqual([[warning(code)]]);
    });
});

test.each(['provider', 'storage', 'callback', 'session', 'clock', 'deadline'])('production HTTP failure: %s', async boundary => {
    const h = customerProductionHarness();
    const fail = async () => { throw new Error('synthetic-private-provider-detail'); };
    if (boundary === 'provider') h.dependencies.clientApplication.getAuthCodeUrl = fail;
    if (boundary === 'clock') h.dependencies.clock = () => { throw new Error('synthetic-private-clock'); };
    if (boundary === 'deadline') {
        const generate = h.dependencies.cryptoProvider.generatePkceCodes;
        h.dependencies.cryptoProvider.generatePkceCodes = async () => { h.state.now += 60001; return generate(); };
    }
    h.recomposeWithApplication(createProductionApplication);
    if (['storage', 'callback', 'session'].includes(boundary)) h.getContainer('nofries-browser-auth').getProperties = fail;
    const route = ['callback', 'session'].includes(boundary) ? boundary : 'login';
    const call = route === 'callback' ? request(h.app).post('/api/auth/callback').type('form').send({ code: 'private', state: 'private' })
        : request(h.app).get(`/api/auth/${route}?returnTo=%2Foperator`);
    const response = await call.set('Cookie', `__Host-nofries-auth${route === 'callback' ? '-tx' : ''}=${Buffer.alloc(32, 1).toString('base64url')}`);
    expect(response.status).toBe(503);
    expect(response.body.code).toBe('browser_auth_unavailable');
    const code = boundary === 'provider' ? 'browser_auth_provider_unavailable' : boundary === 'storage'
        ? 'browser_auth_transaction_store_unavailable' : 'browser_auth_dashboard_unavailable';
    expect(warn.mock.calls).toEqual([[warning(code)]]);
});

test.each(['parser', 'blocked'])('pre-handler %s failure is logged once', async kind => {
    const h = customerProductionHarness();
    const response = kind === 'parser'
        ? await request(h.app).post('/api/auth/callback').type('form').send('code=' + 'x'.repeat(17000))
        : await request(h.app).get('/api/auth/login').set('User-Agent', 'sqlmap');
    expect(response.status).toBe(kind === 'parser' ? 413 : 403);
    expect(warn.mock.calls).toEqual([[warning('browser_auth_http_failure')]]);
});

test('successful production login redirects without failure diagnostics; anonymous session logs only a fixed code', async () => {
    const h = customerProductionHarness();
    const response = await request(h.app).get('/api/auth/login?returnTo=%2Foperator');
    expect(response.status).toBe(302);
    expect(new URL(response.headers.location).hostname).toBe('login.microsoftonline.com');
    expect(response.headers['set-cookie'][0]).toMatch(/^__Host-nofries-auth-tx=/);
    expect(warn).not.toHaveBeenCalled();
    expect((await request(h.app).get('/api/auth/session')).status).toBe(401);
    expect(warn.mock.calls).toEqual([[warning('authentication_required')]]);
});
