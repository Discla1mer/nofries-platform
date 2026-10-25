'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const express = require('express');
const request = require('supertest');
const { customerProductionHarness, uid } = require('./helpers/customerProductionHarness');
const { createProductionApplication } = require('../lib/productionApplication');
const root = path.resolve(__dirname, '..');
const endpoints = [
    ['GET', '/api/external-customer-auth/login'],
    ['POST', '/api/external-customer-auth/callback'],
    ['GET', '/api/external-customer-signup/state'],
    ['POST', '/api/external-customer-signup/terms'],
    ['POST', '/api/external-customer-signup/setup']
];
const methods = ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'CONNECT', 'OPTIONS', 'TRACE', 'PATCH'];
// SWA evaluates the first matching path AND method; omitted allowedRoles means
// anonymous, as documented at learn.microsoft.com/azure/static-web-apps/configuration.
const matched = (config, method, url) => config.routes.find(route =>
    (route.route.endsWith('*') ? url.startsWith(route.route.slice(0, -1)) : route.route === url) &&
    (!route.methods || route.methods.includes(method)));
const roles = route => route?.allowedRoles ?? ['anonymous'];
let built;
beforeAll(() => {
    execFileSync(process.execPath, ['scripts/build-static.js'], { cwd: root, stdio: 'pipe' });
    built = JSON.parse(fs.readFileSync(path.join(root, 'dist/staticwebapp.config.json')));
});
function fronted(app) {
    const edge = express();
    edge.use((req, res, next) => {
        const route = matched(built, req.method, req.path);
        if (!route || !roles(route).includes('anonymous')) return res.sendStatus(401);
        next();
    });
    edge.use(app);
    return edge;
}
function snapshot(h) {
    return [...h.state.containers].map(([name, container]) => [name,
        [...container.records].map(([key, bytes]) => [key, bytes.toString('base64')])]);
}

describe.each(['staticwebapp.config.json', 'azure/staticwebapp.config.example.json', 'dist/staticwebapp.config.json'])(
    'external first-match boundary in %s', filename => {
        const read = () => JSON.parse(fs.readFileSync(path.join(root, filename)));
        test.each(endpoints)('%s %s reaches only its exact backend boundary', (method, endpoint) => {
            const config = read(), rule = matched(config, method, endpoint);
            expect(rule?.route).toBe(endpoint);
            expect(roles(rule)).toEqual(['anonymous']);
            expect(rule.methods).toEqual([method]);
            expect(rule.headers['Cache-Control']).toContain('no-store');
            expect(rule.headers['Content-Security-Policy']).toContain("default-src 'none'");
            for (const other of methods.filter(value => value !== method)) {
                expect(matched(config, other, endpoint)?.allowedRoles).toEqual(['authenticated']);
            }
            for (const suffix of ['-extra', '/nested', '/admin', '.json']) {
                expect(matched(config, method, endpoint + suffix)?.allowedRoles).toEqual(['authenticated']);
            }
        });
        test('unused OTP, admin, token and staff namespaces remain protected', () => {
            const config = read();
            for (const endpoint of [
                '/api/external-organisation-setup/state', '/api/external-organisation-setup/request',
                '/api/external-organisation-setup/verify', '/api/external-organisation-setup/choose',
                '/api/external-organisation-setup/details', '/api/external-customer-auth/token',
                '/api/external-customer-signup/bootstrap', '/api/external-customer-signup/invitations',
                '/api/external-customer-signup/clients', '/api/admin/roles', '/api/operator/roles'
            ]) for (const method of methods) {
                expect(matched(config, method, endpoint)?.allowedRoles).toEqual(['authenticated']);
            }
            expect(config.responseOverrides['401']).toBeUndefined();
            expect(config.responseOverrides['403']).toBeUndefined();
        });
    });

test.each([undefined, 'false'])('forwarding with external ENABLED=%s cannot read credentials, redirect or write', async enabled => {
    const h = customerProductionHarness({ starter: true, now: Date.now(), customerClientId: uid(105) });
    const env = { ...h.env };
    if (enabled !== undefined) {
        env.NOFRIES_EXTERNAL_CUSTOMER_ENABLED = enabled;
        env.NOFRIES_EXTERNAL_CUSTOMER_ADMISSION_ENABLED = 'false';
    }
    const secret = jest.fn(() => { throw new Error('Inactive runtime must not read external credentials'); });
    Object.defineProperty(env, 'NOFRIES_EXTERNAL_CUSTOMER_CLIENT_SECRET', { get: secret, configurable: true });
    expect(require('../lib/externalCustomerConfiguration').externalCustomerConfiguration(env)).toBeNull();
    expect(secret).not.toHaveBeenCalled();
    delete env.NOFRIES_EXTERNAL_CUSTOMER_CLIENT_SECRET;
    const app = fronted(createProductionApplication(env, h.dependencies)), before = snapshot(h);
    for (const [method, endpoint] of endpoints) {
        const pending = request(app)[method.toLowerCase()](endpoint);
        const response = await (method === 'POST' ? pending.type('form').send({}) : pending);
        expect(response.status).toBe(410);
        expect(response.body.code).toBe('legacy_workspace_retired');
        expect(response.headers.location).toBeUndefined();
        expect(response.headers['set-cookie']).toBeUndefined();
    }
    expect(secret).not.toHaveBeenCalled();
    expect(snapshot(h)).toEqual(before);
    expect(h.state.authRequests).toEqual([]);
    expect(h.state.delivered).toEqual([]);
    expect(h.pool.registrations.size).toBe(0);
    expect(h.pool.receipts.size).toBe(0);
});

test('forwarded managed authentication rejects missing transaction before any authority or session issuance', async () => {
    const h = customerProductionHarness({ starter: true, external: true, now: Date.now(), customerClientId: uid(105) });
    const app = fronted(h.app), before = snapshot(h);
    const response = await request(app).post('/api/external-customer-auth/callback').type('form')
        .send({ code: 'synthetic-unbound-code', state: 's'.repeat(43) });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.headers.location).toBeUndefined();
    expect(response.headers['set-cookie']).toEqual([
        expect.stringMatching(/^__Host-nofries-external-customer-tx=;.*Max-Age=0/)
    ]);
    expect(snapshot(h)).toEqual(before);
    expect(h.pool.registrations.size).toBe(0);
});

async function externalSession(app) {
    const started = await request(app).get('/api/external-customer-auth/login');
    expect(started.status).toBe(302);
    const callback = await request(app).post('/api/external-customer-auth/callback').type('form')
        .set('Cookie', started.headers['set-cookie'][0].split(';')[0])
        .send({ code: 'synthetic-managed-code', state: new URL(started.headers.location).searchParams.get('state') });
    expect(callback.status).toBe(303);
    const cookie = callback.headers['set-cookie'][0].split(';')[0];
    const state = await request(app).get('/api/external-customer-signup/state').set('Cookie', cookie);
    expect(state.status).toBe(200);
    expect(state.body.state.status).toBe('setup_details');
    return { cookie, token: state.body.csrfToken };
}

test.each(['setup', 'terms'].flatMap(action => ['missing csrf', 'cross origin', 'legacy cookie'].map(defect => [action, defect])))(
    'forwarded %s rejects %s with no durable writes', async (action, defect) => {
        const h = customerProductionHarness({ starter: true, external: true, now: Date.now(), customerClientId: uid(105) });
        const app = fronted(h.app), { cookie, token } = await externalSession(app), before = snapshot(h);
        let pending = request(app).post('/api/external-customer-signup/' + action);
        pending = defect === 'cross origin' ? pending.set('Origin', 'https://untrusted.invalid') : h.sameOrigin(pending);
        const body = action === 'terms' ? { accepted: true, termsVersion: h.termsVersion, termsDigest: h.termsDigest }
            : { accountType: 'company', organisationName: 'Synthetic company', details: { name: 'Representative',
                role: 'Owner', address: 'Synthetic address', registrationId: '', authorityConfirmed: true } };
        const response = await pending.set('Cookie', defect === 'legacy cookie' ? cookie.replace('external-customer', 'customer') : cookie)
            .set('X-CSRF-Token', defect === 'missing csrf' ? '' : token).send(body);
        // A legacy cookie cannot authenticate an external mutation. Confirmed
        // external absence requests fresh sign-in; invalid CSRF/origin stays403.
        expect(response.status).toBe(defect === 'legacy cookie' ? 401 : 403);
        if (defect === 'missing csrf') expect(response.body.code).toBe('signup_csrf_invalid');
        if (defect === 'legacy cookie') {
            expect(response.body.code).toBe('signup_signin_required');
            expect(response.headers['set-cookie']).toHaveLength(1);
            expect(response.headers['set-cookie'][0]).toMatch(/^__Host-nofries-external-customer=;.*Max-Age=0/);
            expect(response.headers['set-cookie'][0]).not.toContain('-tx=');
            expect(response.headers.location).toBeUndefined();
        } else expect(response.headers['set-cookie']).toBeUndefined();
        expect(snapshot(h)).toEqual(before);
        expect(h.pool.registrations.size).toBe(0);
        expect(h.pool.receipts.size).toBe(0);
    });

test('forwarded customer authentication grants no staff session even with a renamed cookie', async () => {
    const h = customerProductionHarness({ starter: true, external: true, now: Date.now(), customerClientId: uid(105) });
    const app = fronted(h.app), { cookie } = await externalSession(app), before = snapshot(h);
    const staff = await request(app).get('/api/auth/session').set('Cookie', cookie);
    expect(staff.body.authenticated).toBe(false);
    expect(snapshot(h)).toEqual(before);
    const forgedStaffCookie = cookie.replace('__Host-nofries-external-customer=', '__Host-nofries-auth=');
    expect((await request(app).get('/api/auth/session').set('Cookie', forgedStaffCookie)).status).toBe(401);
    // A forged namespace may invalidate its opaque browser session. It must not
    // create staff authority or mutate customer durable account/consent records.
    const durable = rows => rows.map(([name, records]) => [name,
        records.filter(([key]) => !key.startsWith('browser-auth/sessions/'))]);
    expect(durable(snapshot(h))).toEqual(durable(before));
    expect(h.pool.registrations.size).toBe(0);
    expect(h.pool.receipts.size).toBe(0);
});
