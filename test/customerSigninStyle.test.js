'use strict';

// Source/configuration model and real local handler only: this does not observe
// Azure header precedence, deployment, sign-in or a customer session.
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { createAuthLogoutFunction } = require('../api/authLogout');
const { BrowserAuthError } = require('../api/shared/browserAuth');
const { resetAbuseProtectionForTests } = require('../api/shared/abuseProtection');
const { buildSignupDocument, buildHostedSignupDocument, buildSignupUnavailableDocument } = require('../lib/signupDocument');

const ROUTE = '/api/external-customer-auth/logout';
const POLICY = "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; style-src 'self'; img-src 'self'";
const directives = policy => policy.split(';').map(part => part.trim());
function match(config, path, method) {
    return config.routes.find(rule => (!rule.methods || rule.methods.includes(method)) &&
        (rule.route.endsWith('*') ? path.startsWith(rule.route.slice(0, -1)) : rule.route === path));
}
async function errorDocument() {
    resetAbuseProtectionForTests();
    const logout = jest.fn(async () => { throw new BrowserAuthError(401, 'browser_auth_failed'); });
    const handler = createAuthLogoutFunction({ setupAccountChange: true, service: { logout },
        env: { NOFRIES_PUBLIC_URL: 'https://nofries.test', NODE_ENV: 'production' } });
    const context = { log: { warn: jest.fn() } };
    await handler(context, { method: 'POST', body: '', headers: { origin: 'https://nofries.test', accept: 'text/html' } });
    expect(logout).toHaveBeenCalledTimes(1);
    return context.res;
}

test('all account and dashboard entry documents use the existing header mark as their tab icon', async () => {
    const sources = { clientSource: fs.readFileSync('api/shared/customerSignup/signupClient.js', 'utf8'),
        journeySource: fs.readFileSync('api/shared/customerSignup/signupJourney.js', 'utf8') };
    const documents = ['index.html', 'login.html', 'app/dashboard.html'].map(file => fs.readFileSync(file, 'utf8'));
    documents.push(buildSignupDocument({ ...sources, customerLogin: true, customerTransport: 'external' }).html,
        buildHostedSignupDocument(sources).html, buildSignupUnavailableDocument(), (await errorDocument()).body);
    for (const html of documents) {
        const icons = html.match(/<link\b[^>]*rel="icon"[^>]*>/g);
        expect(icons).toHaveLength(1);
        expect(icons[0]).toContain('href="/images/nofrieslogo.png"');
        expect(icons[0]).toContain('type="image/png"');
    }
});

test.each(['staticwebapp.config.json', 'azure/staticwebapp.config.example.json'])(
    'only the existing exact POST logout rule supports source-owned recovery assets in %s', async file => {
        const config = JSON.parse(fs.readFileSync(file, 'utf8')), rule = match(config, ROUTE, 'POST');
        expect(rule.route).toBe(ROUTE); expect(rule.methods).toEqual(['POST']); expect(rule.allowedRoles).toEqual(['anonymous']);
        expect(rule.headers).toEqual({ 'Cache-Control': 'private, no-store, max-age=0', 'X-Robots-Tag': 'noindex, nofollow',
            'Content-Security-Policy': POLICY });
        expect(match(config, ROUTE, 'GET').route).not.toBe(ROUTE);
        for (const sibling of ['/api/customer-auth/logout', '/api/auth/logout']) {
            expect(directives(match(config, sibling, 'POST').headers['Content-Security-Policy']))
                .toEqual(directives(POLICY).slice(0, 4));
        }
        const response = await errorDocument();
        expect(response.status).toBe(401); expect(response.headers['Set-Cookie']).toBeUndefined();
        expect(response.headers.Location).toBeUndefined();
        expect(response.headers['Content-Security-Policy']).toBe(POLICY);
        expect(response.body).toContain('Sign-out was not confirmed');
        expect(response.body).toContain('Any sign-in already in progress may still finish');
        expect(response.body).toContain('href="/signup?provider=external"');
        expect(response.body).not.toMatch(/<script|\son\w+=|https?:\/\//i);
    });

test('the real ordered static package retains the recovery policy under the unchanged 20000-byte ceiling', async () => {
    execFileSync(process.execPath, ['scripts/build-static.js'], { stdio: 'pipe' });
    const bytes = fs.readFileSync('dist/staticwebapp.config.json');
    expect(bytes.length).toBeLessThanOrEqual(20000);
    const built = JSON.parse(bytes), source = JSON.parse(fs.readFileSync('staticwebapp.config.json', 'utf8'));
    const rule = match(built, ROUTE, 'POST');
    expect(rule.route).toBe(ROUTE); expect(rule.methods).toEqual(['POST']);
    expect(rule.allowedRoles ?? ['anonymous']).toEqual(['anonymous']);
    expect(directives(rule.headers['Content-Security-Policy'])).toEqual(directives(POLICY));
    expect(rule.headers['Cache-Control']).toBe('no-store');
    // Model both possible same-named-header winners. Either source-owned layer
    // allows exactly the same self assets and keeps every original denial.
    const response = await errorDocument();
    for (const effective of [{ ...rule.headers, ...response.headers }, { ...response.headers, ...rule.headers }]) {
        expect(directives(effective['Content-Security-Policy'])).toEqual(directives(POLICY));
    }
    expect(match(built, ROUTE, 'GET').route).toBe(match(source, ROUTE, 'GET').route);
    expect(match(built, '/api/external-customer-auth/logout-extra', 'POST').route)
        .toBe(match(source, '/api/external-customer-auth/logout-extra', 'POST').route);
});
