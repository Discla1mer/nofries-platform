'use strict';

const fs = require('node:fs');
const path = require('node:path');
const request = require('supertest');
const { createNoFriesApp } = require('../server');
const { entrySessionFixture, uid } = require('./fixtures/dashboardAdminEntrySession');
const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../staticwebapp.config.json'), 'utf8'));
const browserRoutes = [
    ['/dashboard-admin/entry', '/api/dashboard-admin/entry'],
    ['/dashboard-admin', '/api/dashboard-admin']
];
const apiRoutes = [
    ['GET', '/api/dashboard-admin'], ['GET', '/api/dashboard-admin/entry'],
    ['GET', '/api/dashboard-admin/entry.js'], ['GET', '/api/dashboard-admin/entry-capabilities'],
    ['GET', '/api/dashboard-admin/app.js'], ['GET', '/api/dashboard-admin/app.css'],
    ['GET', '/api/dashboard-admin/capabilities'], ['POST', '/api/dashboard-admin/lookup'],
    ['POST', '/api/dashboard-admin/signups']
];

// Resolve the checked-in ordered route table; this is not an Azure edge emulator.
// The unchanged original URL is subsequently sent to the actual Express host.
function edgeRule(url, method) {
    const pathname = new URL(url, 'https://synthetic.invalid').pathname;
    return config.routes.find(rule => (!rule.methods || rule.methods.includes(method)) &&
        (rule.route === pathname || rule.route.endsWith('*') && pathname.startsWith(rule.route.slice(0, -1))));
}

function composed({ authority = true, consultant = false } = {}) {
    const h = entrySessionFixture();
    if (consultant) h.env.NOFRIES_ADMIN_SUBJECTS = '';
    const authoriseOperator = jest.fn(async () => authority);
    const readAuthoritySnapshot = jest.fn(async () => null);
    const audit = jest.fn(async () => true);
    const authoriseSignupList = jest.fn(async () => null);
    const readSignupPage = jest.fn(async () => { throw new Error('NO_SOURCE_READ_EXPECTED'); });
    h.rebuild({ dashboardAdmin: { authoriseOperator, readAuthoritySnapshot, audit,
        clock: h.dashboard.clock, requestBudgetMs: 1000 },
    dashboardAdminSignupList: { authoriseSignupList, readSignupPage, audit,
        clock: h.dashboard.clock, requestBudgetMs: 1000 } });
    return { h, authoriseOperator, readAuthoritySnapshot, audit, authoriseSignupList, readSignupPage };
}

test('canonical browser links have exact temporary private redirects to linked API aliases', () => {
    for (const [url, target] of browserRoutes) {
        const rule = edgeRule(url, 'GET');
        expect(rule).toMatchObject({ route: url, methods: ['GET'], redirect: target, statusCode: 302 });
        expect(rule.rewrite).toBeUndefined();
        expect(rule.headers['Cache-Control']).toBe('private, no-store, max-age=0');
        expect(rule.headers['X-Robots-Tag']).toBe('noindex, nofollow');
        for (const method of ['HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) expect(edgeRule(url, method)).toBeUndefined();
    }
});

test('only the nine exact method/path pairs bypass SWA broker roles for the existing BFF boundary', () => {
    const additions = config.routes.filter(rule => rule.route.startsWith('/api/dashboard-admin'));
    expect(additions.map(rule => [rule.methods[0], rule.route])).toEqual(apiRoutes);
    const catchall = config.routes.findIndex(rule => rule.route === '/api/*');
    for (const [method, url] of apiRoutes) {
        const rule = edgeRule(url, method);
        expect(rule).toEqual({ route: url, methods: [method], allowedRoles: ['anonymous'] });
        expect(config.routes.indexOf(rule)).toBeLessThan(catchall);
        for (const other of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].filter(value => value !== method)) {
            expect(edgeRule(url, other)).toMatchObject({ route: '/api/*', allowedRoles: ['authenticated'] });
        }
        for (const tail of ['/', '/other', '-other']) expect(edgeRule(url + tail, method))
            .toMatchObject({ route: '/api/*', allowedRoles: ['authenticated'] });
    }
    expect(edgeRule('/api/dashboard-admin/unknown', 'GET')).toMatchObject({ route: '/api/*', allowedRoles: ['authenticated'] });
});

test.each(apiRoutes)('disabled composition stays private503 for forwarded %s %s', async (method, url) => {
    expect(edgeRule(url, method).allowedRoles).toEqual(['anonymous']);
    const response = await request(createNoFriesApp())[method.toLowerCase()](url)
        .set('X-MS-Client-Principal', 'forged').set('Cookie', '__Host-nofries-auth=forged');
    // The optional signups route remains unknown without its trusted service.
    expect(response.status).toBe(url.endsWith('/signups') ? 404 : 503);
    expect(response.headers.location).toBeUndefined();
    expect(response.headers['cache-control']).toBe('private, no-store, max-age=0');
    expect(response.type).toBe('application/json');
});

test.each(browserRoutes)('forwarded %s uses the same staff session, authority and private document as its existing host route', async (url, target) => {
    expect(edgeRule(url, 'GET').redirect).toBe(target);
    const { h, authoriseOperator, readAuthoritySnapshot, audit } = composed();
    const { cookie } = await h.login(); h.resetObservations();
    const original = await h.send('get', url).set('Cookie', cookie);
    const forwarded = await h.send('get', target).set('Cookie', cookie);
    expect(forwarded.status).toBe(200); expect(forwarded.text).toBe(original.text);
    for (const name of ['cache-control', 'x-robots-tag', 'content-security-policy', 'content-type']) {
        expect(forwarded.headers[name]).toBe(original.headers[name]);
    }
    expect(forwarded.headers['content-security-policy']).toContain("script-src 'self'");
    expect(h.pool.connect).not.toHaveBeenCalled(); expect(readAuthoritySnapshot).not.toHaveBeenCalled(); expect(audit).not.toHaveBeenCalled();
    expect(authoriseOperator.mock.calls.length > 0).toBe(url === '/dashboard-admin');
});

test.each(browserRoutes)('forwarded %s preserves sign-in, customer exclusion and exact query/method closure', async (_url, target) => {
    const { h } = composed();
    const signIn = await h.send('get', target).set('X-MS-Client-Principal', 'forged');
    expect(signIn.status).toBe(302); expect(signIn.headers.location).toMatch(/^https:\/\/login\.microsoftonline\.com\//);
    expect([...h.store.transactions.values()][0].returnTo).toBe('/dashboard-admin/entry');
    const before = h.store.transactions.size;
    for (const name of ['customer', 'external-customer', 'retained-read']) {
        const denied = await h.send('get', target).set('Cookie', '__Host-nofries-' + name + '=forged');
        expect(denied.status).toBe(401); expect(denied.headers.location).toBeUndefined();
        expect(denied.body).toEqual({ code: 'dashboard_admin_authentication_required' });
    }
    for (const [method, suffix] of [['get', '?returnTo=https://attacker.invalid'], ['get', '/other'], ['head', ''], ['post', ''], ['put', '']]) {
        const denied = await h.send(method, target + suffix);
        expect([400, 404, 405]).toContain(denied.status); expect(denied.headers.location).toBeUndefined();
    }
    expect(h.store.transactions.size).toBe(before); expect(h.pool.connect).not.toHaveBeenCalled();
});

test.each([['consultant', { consultant: true }], ['no native authority', { authority: false }]])
('forwarded portal denies %s before source disclosure', async (_name, options) => {
    const { h, readAuthoritySnapshot, audit } = composed(options); const { cookie } = await h.login();
    for (const url of ['/api/dashboard-admin', '/api/dashboard-admin/app.js', '/api/dashboard-admin/app.css', '/api/dashboard-admin/capabilities']) {
        const response = await h.send('get', url).set('Cookie', cookie);
        expect(response.status).toBe(403); expect(response.headers.location).toBeUndefined();
        expect(response.type).toBe('application/json');
    }
    expect(h.pool.connect).not.toHaveBeenCalled(); expect(readAuthoritySnapshot).not.toHaveBeenCalled(); expect(audit).not.toHaveBeenCalled();
});

test.each(['no cookie', 'forged platform identity', 'customer cookie', 'consultant', 'wrong tenant'])
('all nine forwarded routes reject %s without reading data or native grants', async kind => {
    const { h, authoriseOperator, readAuthoritySnapshot, audit, authoriseSignupList, readSignupPage } =
        composed({ consultant: kind === 'consultant' });
    let cookie;
    if (['consultant', 'wrong tenant'].includes(kind)) ({ cookie } = await h.login());
    if (kind === 'customer cookie') cookie = '__Host-nofries-external-customer=forged';
    if (kind === 'wrong tenant') {
        // Keep the genuine opaque staff cookie and actual store/session reader;
        // model a server-side session from another tenant, never a header identity.
        const record = [...h.store.sessions.values()][0];
        record.identity.tenantId = uid(90);
        record.identity.subjectKey = uid(90) + ':' + record.identity.principalId;
    }
    h.resetObservations();
    for (const [method, url] of apiRoutes) {
        expect(edgeRule(url, method).allowedRoles).toEqual(['anonymous']);
        let pending = h.send(method.toLowerCase(), url).set('Origin', h.env.NOFRIES_PUBLIC_URL)
            .set('Sec-Fetch-Site', 'same-origin');
        if (cookie) pending = pending.set('Cookie', cookie);
        if (kind === 'forged platform identity') pending = pending.set('X-MS-Client-Principal', 'forged').set('X-Nofries-Subject', 'forged');
        if (method === 'POST') pending = pending.send(url.endsWith('/signups') ? { cursor: null } : {});
        const response = await pending;
        const document = browserRoutes.some(([, target]) => target === url);
        const signIn = document && !['customer cookie', 'consultant'].includes(kind);
        expect(response.status).toBe(kind === 'consultant' ? 403 : signIn ? 302 : 401);
        if (signIn) expect(response.headers.location).toMatch(/^https:\/\/login\.microsoftonline\.com\//);
        else { expect(response.headers.location).toBeUndefined(); expect(response.type).toBe('application/json'); }
        expect(response.text).not.toContain('id="adminEntryOpen"');
        expect(response.text).not.toContain('Dashboard administration');
        expect(response.headers['cache-control']).toContain('no-store');
    }
    for (const call of [authoriseOperator, readAuthoritySnapshot, audit, authoriseSignupList, readSignupPage, h.pool.connect]) {
        expect(call).not.toHaveBeenCalled();
    }
});
