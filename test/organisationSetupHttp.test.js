'use strict';
const request = require('supertest');
const { createNoFriesApp } = require('../server');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const app = createNoFriesApp();
test('dynamic external login preserves the actual body classes and selects the external setup route', async () => {
    const external = createNoFriesApp({ externalOrganisationSetup: { handle: async () => ({ status: 503, body: { code: 'setup_unavailable' } }) } });
    const login = await request(external).get('/login?provider=external');
    expect(login.status).toBe(200);
    expect(login.text).toContain('<body class="access-page login-page" data-customer-provider="external">');
    expect(login.text.match(/data-customer-provider="external"/g)).toHaveLength(1);
    expect(login.text).toContain('id="organisation-returning-sign-in" href="/api/external-customer-auth/login"');
    expect(login.text).not.toContain('href="/api/customer-auth/login"');
    expect(login.headers['cache-control']).toContain('no-store');
});
test('root serves the real dashboard loader and index canonicalises to root with matching CSP and no private application bundle', async () => {
    const root = await request(app).get('/'), index = await request(app).get('/index.html');
    expect(root.status).toBe(200); expect(index.status).toBe(308); expect(index.headers.location).toBe('/');
    const script = root.text.match(/<script id="dashboardRuntime">([\s\S]*?)<\/script>/)[1];
    const hash = crypto.createHash('sha256').update(script).digest('base64');
    expect(root.headers['content-security-policy']).toContain("'sha256-" + hash + "'");
    expect(root.headers['cache-control']).toContain('no-store');
    const accountCard = root.text.slice(root.text.indexOf('id="create-organisation"'), root.text.indexOf('class="home-intro"'));
    expect([...accountCard.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)]
        .map(match => [match[1], match[2].trim()]))
        .toEqual([['/login?intent=create', 'Create account'], ['/login?intent=login', 'Log in']]);
    expect(accountCard).not.toContain('→');
    expect(root.text).not.toContain('id="organisation-company"');
    const login = await request(app).get('/login');
    expect(login.status).toBe(200); expect(login.headers['cache-control']).toContain('no-store');
    expect(login.text).toContain('<form id="organisation-form">');
    expect(login.text).toContain('Personal and work email');
    expect(login.text).not.toContain('Operator account');
    expect(root.text).not.toContain('NoFriesDashboard = factory');
    expect(root.text).not.toContain('DASHBOARD_APP_INTEGRITY');
});
test('uninstalled verification fails closed without affecting the gateway', async () => {
    for (const route of ['state', 'request', 'verify', 'choose', 'details']) {
        const r = route === 'state' ? await request(app).get('/api/organisation-setup/' + route) :
            await request(app).post('/api/organisation-setup/' + route).send({});
        expect(r.status).toBe(503); expect(r.body).toEqual({ code: 'setup_unavailable' });
    }
    expect((await request(app).get('/')).status).toBe(200);
});
test('forwarded starter routes retain server authentication and API security headers before any signup write', async () => {
    const { customerProductionHarness } = require('./helpers/customerProductionHarness');
    const h = customerProductionHarness({ starter: true });
    const responses = [
        await h.sameOrigin(request(h.app).post('/api/organisation-setup/details')).send({}),
        await request(h.app).post('/api/organisation-setup/details').set('Origin', 'https://foreign.example.test').send({}),
        await request(h.app).get('/api/customer-signup/clients'),
        await h.sameOrigin(request(h.app).post('/api/customer-signup/clients')).send({})
    ];
    expect(responses.map(response => response.status)).toEqual([401, 403, 503, 503]);
    expect(responses.map(response => response.body.code)).toEqual([
        'setup_session_required', 'setup_origin_invalid', 'starter_signup_unavailable', 'starter_signup_unavailable'
    ]);
    for (const response of responses) {
        expect(response.headers['cache-control']).toContain('no-store');
        expect(response.headers['content-security-policy']).toBe("default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
        expect(response.headers['x-robots-tag']).toBe('noindex, nofollow');
        expect(response.headers['x-content-type-options']).toBe('nosniff');
        expect(response.headers['x-frame-options']).toBe('DENY');
    }
    expect(h.state.delivered).toHaveLength(0);
    expect(h.pool.receipts.size).toBe(0); expect(h.pool.registrations.size).toBe(0);
});
test('static host exposes only the explicit organisation setup methods and no private source', () => {
    for (const file of ['staticwebapp.config.json', 'azure/staticwebapp.config.example.json']) {
        const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'));
        const methods = Object.fromEntries(config.routes.filter(x => x.route.startsWith('/api/organisation-setup/')).map(x => [x.route.split('/').pop(), x.methods]));
        expect(methods).toEqual({ state: ['GET', 'POST'], request: ['POST'], verify: ['POST'], choose: ['POST'], details: ['POST'] });
    }
});

test('leave passes through the real HTTP host without cookie mutation, with same-origin protection and no-cache headers', async () => {
    const { customerProductionHarness } = require('./helpers/customerProductionHarness');
    const h = customerProductionHarness({ starter: true });
    const post = () => request(h.app).post('/api/organisation-setup/state');
    const denied = await post().set('Origin', 'https://foreign.example.test').send({});
    expect(denied.status).toBe(403); expect(denied.headers['set-cookie']).toBeUndefined();
    const response = await h.sameOrigin(post()).set('Cookie', '__Host-nofries_org_setup=invalid; unrelated=keep').send({ action: 'leave' });
    expect(response.status).toBe(200); expect(response.body).toEqual({ state: 'start' });
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.headers['content-security-policy']).toContain("default-src 'none'");
    const state = await request(h.app).get('/api/organisation-setup/state');
    expect(state.status).toBe(200); expect(state.headers['set-cookie']).toBeUndefined();
    expect(h.state.delivered).toHaveLength(0);
    expect(h.pool.registrations.size).toBe(0); expect(h.pool.receipts.size).toBe(0);
});
