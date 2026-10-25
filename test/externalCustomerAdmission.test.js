'use strict';
const request = require('supertest');
const { customerProductionHarness, uid } = require('./helpers/customerProductionHarness');
const { subjectHash } = require('../api/shared/customerSignup/customerAuthority');
const subjectPath = oid => `customer-subjects/${subjectHash(uid(101) + ':' + oid)}.json`;
const fixture = () => customerProductionHarness({ starter: true, external: true, now: Date.now(), customerClientId: uid(105) });
const input = (accountType = 'company') => ({ accountType, organisationName: 'Synthetic managed company',
    details: { name: 'Synthetic Representative', role: 'Owner', address: 'Synthetic address', registrationId: '', authorityConfirmed: true } });
async function begin(h, expected = { status: 'setup_details', email: h.state.externalEmail }) {
    const login = await h.loginExternal(); expect(login.response.status).toBe(303);
    const state = await request(h.app).get('/api/external-customer-signup/state').set('Cookie', login.cookie);
    expect(state.body.state).toEqual(expected);
    return { ...login, token: state.body.csrfToken };
}
async function beginDenied(h) {
    const login = await h.loginExternal(); expect(login.response.status).toBe(303);
    const before = snapshot(h.getContainer('external-starter-authority').records);
    const state = await request(h.app).get('/api/external-customer-signup/state').set('Cookie', login.cookie);
    expect(state.status).toBe(503); expect(state.body).toEqual({ error: 'Signup is unavailable', code: 'signup_unavailable' });
    expect(state.body.csrfToken).toBeUndefined(); expect(state.headers['set-cookie']).toBeUndefined();
    expect(snapshot(h.getContainer('external-starter-authority').records)).toEqual(before);
    // The synthetic fixture knows its opaque SID: exercise a correctly bound
    // token even though denied GETs never publish it to the browser.
    const token = require('node:crypto').createHash('sha256').update('nofries:signup-csrf:v1\0')
        .update(login.cookie.slice(login.cookie.indexOf('=') + 1)).digest('base64url');
    return { ...login, token };
}
const save = (h, login, body = input()) => h.sameOrigin(request(h.app).post('/api/external-customer-signup/setup'))
    .set('Cookie', login.cookie).set('X-CSRF-Token', login.token).send(body);
const snapshot = records => [...records].map(([key, bytes]) => [key, bytes.toString()]);
function exhaustBudget(h) {
    const bucket = Math.floor(Date.now() / 86400000);
    const key = 'browser-auth/organisation-setup/budget/' + require('node:crypto')
        .createHash('sha256').update('global:all:' + bucket).digest('hex') + '.json';
    h.getContainer('nofries-browser-auth').records.set(key, Buffer.from(JSON.stringify({
        schemaVersion: 1, count: 20, expiresAt: (bucket + 1) * 86400000 })));
}

test('exhausted shared daily budget denies a new managed subject before setup assurance or account writes', async () => {
    const h = fixture(); exhaustBudget(h);
    const login = await h.loginExternal();
    expect(login.response.status).toBeGreaterThanOrEqual(400);
    expect(h.getContainer('external-starter-authority').records.size).toBe(0);
    expect(h.pool.registrations.size).toBe(0); expect(h.pool.receipts.size).toBe(0);
});

test('full daily budget preserves a reserved setup retry and established customer login', async () => {
    const h = fixture(), first = await begin(h), original = h.state.externalOid;
    exhaustBudget(h);
    const retry = await begin(h);
    expect((await save(h, retry)).status).toBe(200);
    const records = h.getContainer('external-starter-authority').records;
    const before = snapshot(records);
    expect((await h.loginExternal()).response.status).toBe(303);
    h.state.externalOid = uid(104); h.state.externalEmail = 'another@synthetic.example';
    expect((await h.loginExternal()).response.status).toBeGreaterThanOrEqual(400);
    expect(snapshot(records)).toEqual(before);
    expect(first.cookie).toBeTruthy(); expect(records.has(subjectPath(original))).toBe(true);
});

test('a missing durable admission permit invalidates a provisional session before setup writes', async () => {
    const h = fixture(), login = await begin(h), auth = h.getContainer('external-starter-authority').records;
    const permit = [...auth.keys()].find(key => key.includes('/external-signup-admissions/'));
    expect(permit).toBeDefined(); auth.delete(permit);
    expect((await save(h, login)).status).toBeGreaterThanOrEqual(400);
    expect(h.getContainer('external-starter-authority').records.size).toBe(0);
});

test('browser-auth lifecycle cleanup cannot erase an incomplete signup admission permit', async () => {
    const h = fixture(); await begin(h);
    const lifecycle = require('node:fs').readFileSync(require('node:path')
        .join(__dirname, '../infra/azure/production-security.bicep'), 'utf8');
    const prefix = lifecycle.match(/\$\{browserAuthContainerName\}\/([^']+)'/)[1];
    const auth = h.getContainer('nofries-browser-auth').records;
    for (const key of [...auth.keys()]) if (key.startsWith(prefix)) auth.delete(key);
    exhaustBudget(h);
    expect((await h.loginExternal()).response.status).toBe(303);
});

test.each(['company', 'consultant'])('provider signup precedes %s details and binds a new subject without application OTP, invitation delivery or inferred consent', async accountType => {
    const h = fixture(), legacy = h.addUser({ email: h.state.externalEmail });
    const legacyBefore = snapshot(h.getContainer('customer-authority').records);
    const login = await begin(h), records = h.getContainer('external-starter-authority').records;
    expect(records.has(subjectPath(h.state.externalOid))).toBe(false);
    expect((await request(h.app).get('/api/dashboard/session').set('Cookie', login.cookie)).status).toBeGreaterThanOrEqual(400);
    expect((await save(h, login, input(accountType))).body.state).toEqual({ status: 'continue_authentication' });
    const authority = JSON.parse(records.get(subjectPath(h.state.externalOid)));
    expect(authority.accountType).toBe(accountType);
    expect(authority.subjectKey).toBe(uid(101) + ':' + h.state.externalOid);
    expect(authority.subjectKey).not.toBe(legacy.authority.subjectKey);
    expect(authority.organisationId).not.toBe(legacy.authority.organisationId);
    expect(h.pool.registrations.size).toBe(0); expect(h.pool.receipts.size).toBe(0);
    expect(h.state.delivered).toEqual([]);
    expect(snapshot(h.getContainer('customer-authority').records)).toEqual(legacyBefore);
    const saved = JSON.parse([...records].find(([key]) => key.includes('/starter-setups/'))[1]);
    expect(saved.assertion.proof.source).toBe('external-id-signup');
    expect(saved.assertion.proof.subjectKey).toBe(authority.subjectKey);
    expect(saved.assertion.proof).not.toHaveProperty('codeHash');
    // Publishing authority never upgrades the provisional session.
    expect((await request(h.app).get('/api/dashboard/session').set('Cookie', login.cookie)).status).toBeGreaterThanOrEqual(400);
    const next = await h.loginExternal(); expect(next.response.status).toBe(303);
    // Native PostgreSQL acceptance covers preparation, terms and admission.
    // This bounded fixture proves real callback/session/immutable-store behavior.
    const before = snapshot(records);
    expect((await h.loginExternal()).response.status).toBe(303);
    expect(snapshot(records)).toEqual(before);
});

test.each(['no csrf', 'cross origin', 'legacy proof', 'untrusted identity'])('setup rejects %s without a reservation', async defect => {
    const h = fixture(), login = await begin(h);
    if (defect === 'legacy proof') {
        const start = await h.sameOrigin(request(h.app).post('/api/organisation-setup/request')).send({ email: 'legacy@example.test' });
        login.cookie = start.headers['set-cookie'][0].split(';')[0];
    }
    let post = request(h.app).post('/api/external-customer-signup/setup');
    post = defect === 'cross origin' ? post.set('Origin', 'https://untrusted.invalid') : h.sameOrigin(post);
    const body = input(); if (defect === 'untrusted identity') body.subjectKey = uid(101) + ':' + uid(104);
    const response = await post.set('Cookie', login.cookie).set('X-CSRF-Token', defect === 'no csrf' ? '' : login.token).send(body);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect([...h.getContainer('external-starter-authority').records.keys()].some(key => key.includes('/starter-accounts/'))).toBe(false);
});

test('external entry does not expose application OTP or accept a cross-provider proof', async () => {
    const h = fixture(), page = await request(h.app).get('/login?provider=external');
    expect(page.status).toBe(200); expect(page.text).toContain('/api/external-customer-auth/login');
    expect(page.text).not.toContain('/api/external-organisation-setup');
    for (const action of ['request', 'verify', 'details']) {
        const result = await h.sameOrigin(request(h.app).post('/api/external-organisation-setup/' + action)).send({});
        expect(result.status).toBe(503); expect(result.body).toEqual({ code: 'setup_unavailable' });
    }
    expect((await request(h.app).get('/login')).text).toContain('/api/customer-auth/login');
});

test('an interrupted immutable claim resumes original records and denies a second same-email subject', async () => {
    const h = fixture(), login = await begin(h), container = h.getContainer('external-starter-authority');
    const original = container.getBlockBlobClient.bind(container); let interrupt = true;
    container.getBlockBlobClient = key => {
        const blob = original(key), upload = blob.uploadData.bind(blob);
        blob.uploadData = async (...args) => {
            if (interrupt && key.startsWith('customer-subjects/')) { interrupt = false; throw new Error('Synthetic interruption'); }
            return upload(...args);
        }; return blob;
    };
    expect((await save(h, login)).status).toBe(503);
    const records = container.records, retained = [...records].find(([key]) => /external-claims\/.*\.json$/.test(key));
    expect(retained).toBeDefined();
    const owner = h.state.externalOid; h.state.externalOid = uid(104);
    const competitor = await beginDenied(h), before = snapshot(records);
    expect((await save(h, competitor)).status).toBe(503);
    expect(snapshot(records)).toEqual(before);
    h.state.externalOid = owner;
    // A fresh authenticated session resumes after a browser interruption.
    const retry = await begin(h, { status: 'resume_setup', email: h.state.externalEmail,
        accountType: input().accountType, organisationName: input().organisationName });
    expect((await save(h, retry)).body.state.status).toBe('continue_authentication');
    expect(records.get(retained[0]).equals(retained[1])).toBe(true);
    expect(JSON.parse(records.get(subjectPath(owner)))).toEqual(JSON.parse(retained[1]).entry);
});

test('a reservation interrupted before details already belongs to its immutable subject', async () => {
    const h = fixture(), owner = await begin(h), container = h.getContainer('external-starter-authority');
    const original = container.getBlockBlobClient.bind(container);
    container.getBlockBlobClient = key => {
        const blob = original(key);
        if (key.includes('/starter-setups/')) blob.uploadData = async () => { throw new Error('Synthetic details outage'); };
        return blob;
    };
    expect((await save(h, owner)).status).toBe(503);
    expect([...container.records.keys()].some(key => key.includes('/starter-accounts/'))).toBe(true);
    container.getBlockBlobClient = original;
    h.state.externalOid = uid(104); const other = await beginDenied(h);
    const before = snapshot(container.records);
    expect((await save(h, other)).status).toBe(503); expect(snapshot(container.records)).toEqual(before);
});

test('completed deleted or revoked authority cannot be reclaimed', async () => {
    const h = fixture(), login = await begin(h), records = h.getContainer('external-starter-authority').records;
    expect((await save(h, login)).status).toBe(200);
    const key = subjectPath(h.state.externalOid), original = JSON.parse(records.get(key));
    records.set(key, Buffer.from(JSON.stringify({ ...original, status: 'revoked' })));
    expect((await h.loginExternal()).response.status).toBe(401);
    records.delete(key);
    const retry = await beginDenied(h);
    expect((await save(h, retry)).status).toBe(503); expect(records.has(key)).toBe(false);
});

test('legal archive retry retains the original declaration and creates no consent', async () => {
    const h = fixture(), legacy = h.getContainer('customer-authority').records;
    const terms = [...legacy].find(([key]) => key.startsWith('customer-terms/'));
    const login = await begin(h); legacy.delete(terms[0]);
    expect((await save(h, login)).status).toBe(503);
    const records = h.getContainer('external-starter-authority').records;
    expect(records.has(subjectPath(h.state.externalOid))).toBe(false);
    legacy.set(...terms);
    expect((await save(h, login)).status).toBe(200);
    expect(records.get(terms[0]).equals(terms[1])).toBe(true);
    expect(h.pool.receipts.size).toBe(0);
});

test.each([{ aud: uid(2) }, { tid: uid(1) }, { iss: 'https://untrusted.invalid' }, { email: '' }, { exp: 0 }, { nonce: 'wrong' }])(
    'nonce-bound provider claims %j cannot create a setup session or authority', async claims => {
        const h = fixture(); h.state.externalClaims = claims;
        expect((await h.loginExternal()).response.status).toBeGreaterThanOrEqual(400);
        expect([...h.getContainer('external-starter-authority').records.keys()].some(key => key.startsWith('customer-subjects/'))).toBe(false);
    });

test('missing user flow and reused legacy store reject composition; external requires no legacy MFA setting', () => {
    const h = fixture();
    const { createExternalCustomerSignupConfiguration, createProductionCustomerSignupConfiguration } = require('../lib/customerSignupProduction');
    const dashboard = require('../lib/dashboardProduction').createProductionDashboardConfiguration(h.env, h.dependencies);
    for (const change of [{ userFlowId: null }, { starterAuthorityContainer: h.env.NOFRIES_STARTER_AUTHORITY_CONTAINER }]) {
        expect(() => createExternalCustomerSignupConfiguration(h.env, dashboard, h.dependencies, { ...h.dependencies.externalCustomer, ...change })).toThrow();
    }
    const env = { ...h.env }; delete env.NOFRIES_CUSTOMER_MFA_POLICY_ID; delete env.NOFRIES_CUSTOMER_MFA_CONTEXT;
    expect(() => createExternalCustomerSignupConfiguration(env, dashboard, h.dependencies, h.dependencies.externalCustomer)).not.toThrow();
    expect(() => createProductionCustomerSignupConfiguration(env, dashboard, h.dependencies)).toThrow();
});

test('stopping new admission rejects setup sessions and new subjects while preserving established external login and saved records', async () => {
    const h = fixture(), setup = await begin(h);
    expect((await save(h, setup)).status).toBe(200);
    const records = h.getContainer('external-starter-authority').records, before = snapshot(records);
    const app = require('../lib/productionApplication').createProductionApplication(h.env, { ...h.dependencies,
        externalCustomer: { ...h.dependencies.externalCustomer, allowNewSignup: false } });
    const provisional = await request(app).get('/api/external-customer-signup/state').set('Cookie', setup.cookie);
    expect(provisional.status).toBeGreaterThanOrEqual(400);
    async function login() {
        const started = await request(app).get('/api/external-customer-auth/login');
        expect(started.status).toBe(302);
        return request(app).post('/api/external-customer-auth/callback').type('form')
            .set('Cookie', started.headers['set-cookie'][0].split(';')[0])
            .send({ code: 'synthetic-managed-code', state: new URL(started.headers.location).searchParams.get('state') });
    }
    expect((await login()).status).toBe(303);
    h.state.externalOid = uid(104);
    expect((await login()).status).toBe(401);
    expect(snapshot(records)).toEqual(before);
});

test('changed contact email cannot bypass a completed subject claim after authority deletion', async () => {
    const h = fixture(), login = await begin(h), records = h.getContainer('external-starter-authority').records;
    expect((await save(h, login)).status).toBe(200);
    const key = subjectPath(h.state.externalOid);
    h.state.externalEmail = 'changed@example.test';
    // With authority present, current policy already denies mismatched email.
    expect((await h.loginExternal()).response.status).toBe(401);
    records.delete(key);
    const before = snapshot(records), retry = await beginDenied(h);
    expect((await save(h, retry)).status).toBe(503);
    expect(records.has(key)).toBe(false);
    expect(snapshot(records)).toEqual(before);
});

test('simultaneous authenticated emails for one subject reserve only one account', async () => {
    const h = fixture(), first = await begin(h);
    h.state.externalEmail = 'changed@example.test';
    const second = await begin(h);
    const outcomes = await Promise.all([save(h, first), save(h, second)]);
    expect(outcomes.map(r => r.status).sort()).toEqual([200, 503]);
    const keys = [...h.getContainer('external-starter-authority').records.keys()];
    expect(keys.filter(key => key.includes('/external-subject-reservations/'))).toHaveLength(1);
    expect(keys.filter(key => key.includes('/starter-accounts/'))).toHaveLength(1);
    expect(keys.filter(key => key.includes('/starter-setups/'))).toHaveLength(1);
    expect(keys.filter(key => key.includes('/external-claims/') && !key.endsWith('.complete.json'))).toHaveLength(1);
});

test.each(['lost fence acknowledgement', 'interruption before account allocation'])('subject fence safely reconciles %s', async failure => {
    const h = fixture(), first = await begin(h), container = h.getContainer('external-starter-authority');
    const original = container.getBlockBlobClient.bind(container); let interrupt = true;
    container.getBlockBlobClient = key => {
        const blob = original(key), upload = blob.uploadData.bind(blob);
        blob.uploadData = async (...args) => {
            if (interrupt && key.includes(failure === 'lost fence acknowledgement' ? '/external-subject-reservations/' : '/starter-accounts/')) {
                interrupt = false;
                if (failure === 'lost fence acknowledgement') await upload(...args);
                throw new Error('Synthetic uncertainty');
            }
            return upload(...args);
        }; return blob;
    };
    const outcome = await save(h, first);
    expect(outcome.status).toBe(failure === 'lost fence acknowledgement' ? 200 : 503);
    const fence = [...container.records].find(([key]) => key.includes('/external-subject-reservations/'));
    expect(fence).toBeDefined();
    if (failure === 'interruption before account allocation') {
        h.state.externalEmail = 'changed@example.test'; const changed = await beginDenied(h);
        expect((await save(h, changed)).status).toBe(503);
        expect([...container.records.keys()].some(key => key.includes('/starter-accounts/'))).toBe(false);
        h.state.externalEmail = 'synthetic@gmail.com'; const retry = await begin(h);
        expect((await save(h, retry)).status).toBe(200);
    }
    expect(container.records.get(fence[0]).equals(fence[1])).toBe(true);
});
