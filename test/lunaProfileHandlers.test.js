'use strict';

const request = require('supertest');
const { customerProductionHarness, uid } = require('./helpers/customerProductionHarness');
const { createProductionDashboardConfiguration } = require('../lib/dashboardProduction');
const { createExternalCustomerSignupConfiguration, createProductionCustomerSignupConfiguration } = require('../lib/customerSignupProduction');
const { createLunaProfileHandlers } = require('../api/shared/customerSignup/lunaProfileHandlers');
const { AzureLunaProfileStore } = require('../api/shared/customerSignup/azureLunaProfileStore');
const { subjectHash } = require('../api/shared/customerSignup/customerAuthority');
const EXTERNAL = '__Host-nofries-external-customer';
const TOKEN = 'c'.repeat(43);
const command = (nickname = 'Luna', expectedRevision = 0, operationId = uid(900)) => ({ nickname, expectedRevision, operationId });
const read = cookie => ({ method: 'GET', headers: { cookie }, query: {} });
const post = (cookie, token, body = command()) => ({ method: 'POST', headers: { cookie,
    origin: 'https://nofries.nz', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'x-csrf-token': token }, body });
const entries = container => [...container.records].map(([key, bytes]) => [key, bytes.toString('base64')]);

function compose(h, store, external = true) {
    const deps = { ...h.dependencies, ...(store ? { lunaProfileStore: store } : {}) };
    const dashboard = createProductionDashboardConfiguration(h.env, deps);
    return external ? createExternalCustomerSignupConfiguration(h.env, dashboard, deps, deps.externalCustomer)
        : createProductionCustomerSignupConfiguration(h.env, dashboard, deps);
}
async function fixture() {
    const h = customerProductionHarness({ starter: true, external: true, now: Date.now(), customerClientId: uid(105) });
    const setup = await h.loginExternal(); expect(setup.response.status).toBe(303);
    const state = await request(h.app).get('/api/external-customer-signup/state').set('Cookie', setup.cookie);
    const saved = await h.sameOrigin(request(h.app).post('/api/external-customer-signup/setup'))
        .set('Cookie', setup.cookie).set('X-CSRF-Token', state.body.csrfToken)
        .send({ accountType: 'company', organisationName: 'Synthetic profile company', details: {
            name: 'Synthetic Owner', role: 'Owner', address: 'Synthetic address', registrationId: '', authorityConfirmed: true } });
    expect(saved.status).toBe(200);
    const login = await h.loginExternal(); expect(login.response.status).toBe(303);
    const container = h.getContainer('synthetic-luna-profiles'), store = new AzureLunaProfileStore(container);
    const port = () => compose(h, new AzureLunaProfileStore(container)).lunaProfile;
    const authority = h.getContainer('external-starter-authority');
    return { h, setup, login, container, store, port, authority, revoke() {
        const key = `customer-subjects/${subjectHash(uid(101) + ':' + h.state.externalOid)}.json`;
        const value = JSON.parse(authority.records.get(key)); value.status = 'revoked';
        authority.records.set(key, Buffer.from(JSON.stringify(value)));
    } };
}
function isolated(issueCsrfToken = async () => TOKEN) {
    const service = { read: jest.fn(async () => null), save: jest.fn(async (_, body) => ({ nickname: body.nickname })) };
    const handlers = createLunaProfileHandlers({ service, env: { NOFRIES_PUBLIC_URL: 'https://nofries.nz' },
        customerCookie: EXTERNAL, issueCsrfToken });
    return { service, handlers };
}

test('default legacy and external factory shapes remain unchanged and profile composition stays unmounted', async () => {
    const h = customerProductionHarness({ starter: true, external: true, now: Date.now(), customerClientId: uid(105) });
    const store = new AzureLunaProfileStore(h.getContainer('synthetic-luna-profiles'));
    const load = jest.spyOn(store, 'load'), create = jest.spyOn(store, 'create');
    for (const external of [false, true]) {
        const baseline = compose(h, null, external), selected = compose(h, store, external);
        expect(baseline).not.toHaveProperty('lunaProfile');
        expect(Object.keys(selected).filter(key => key !== 'lunaProfile')).toEqual(Object.keys(baseline));
        expect(Object.isFrozen(selected.lunaProfile)).toBe(true);
    }
    expect(load).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
    expect([404, 410]).toContain((await request(h.app).get('/api/luna/profile')).status);
    const disabled = { ...h.env, NOFRIES_STARTER_SIGNUP_ENABLED: 'false' };
    const deps = { ...h.dependencies, lunaProfileStore: store };
    expect(() => createProductionCustomerSignupConfiguration(disabled,
        createProductionDashboardConfiguration(disabled, deps), deps)).toThrow();
});

test('actual configured customer saves and reads the same private profile after reconstruction without account changes', async () => {
    const f = await fixture(), before = entries(f.authority);
    const initial = await f.port().handleRequest(read(f.login.cookie));
    expect(initial.status).toBe(200); expect(initial.body.profile).toBeNull();
    expect(initial.headers['Cache-Control']).toBe('no-store');
    const write = post(f.login.cookie, initial.body.csrfToken, command('  Lu\u0301na  '));
    const saved = await f.port().handleRequest(write);
    expect(saved.status).toBe(200); expect(saved.body.profile.nickname).toBe('Lúna');
    expect(saved.body.profile.revision).toBe(1);
    expect((await f.port().handleRequest(read(f.login.cookie))).body).toEqual(saved.body);
    expect((await f.port().handleRequest(write)).body).toEqual(saved.body);
    const conflict = await f.port().handleRequest(post(f.login.cookie, initial.body.csrfToken, command('Competing', 0, uid(901))));
    expect(conflict).toMatchObject({ status: 409, body: { code: 'luna_profile_conflict' } });
    expect(entries(f.authority)).toEqual(before);
    expect(f.container.records.size).toBe(1);
    expect([...f.container.records.keys()]).toEqual(['customer-luna/profiles/' + saved.body.profile.accountId + '.json']);
    expect(saved.body.profile).not.toHaveProperty('accountCreatedAt');
    expect(saved.body.profile).not.toHaveProperty('classification');
});

test('an unactivated legacy starter reservation cannot substitute for an immutable account-owner binding', async () => {
    const h = customerProductionHarness({ starter: true, now: Date.now() }), email = 'legacy-profile@example.invalid';
    h.state.directoryUsers = [{ id: h.state.oid, mail: email, userPrincipalName: email,
        otherMails: [], proxyAddresses: [], userType: 'Member', accountEnabled: true }];
    const begun = await h.sameOrigin(request(h.app).post('/api/organisation-setup/request'))
        .send({ email, accountType: 'consultant', organisationName: 'Synthetic legacy profile' });
    expect(begun.status).toBe(202);
    const setupCookie = begun.headers['set-cookie'][0].split(';')[0];
    const setup = action => h.sameOrigin(request(h.app).post('/api/organisation-setup/' + action))
        .set('Cookie', setupCookie).set('X-NoFries-Setup-Request', begun.body.requestId);
    expect((await setup('verify').send({ code: h.state.delivered[0].text.match(/\b[0-9]{8}\b/)[0] })).status).toBe(200);
    // This transport fixture retains genuine immutable account/authority records
    // but cannot execute the separate native SQL provisioning path.
    expect((await setup('details').send({ name: 'Synthetic Owner', role: 'Owner',
        address: 'Synthetic address', registrationId: '', authorityConfirmed: true })).status).toBe(503);
    const accounts = h.getContainer('starter-authority');
    const authority = JSON.parse([...accounts.records].find(([key]) => key.startsWith('customer-subjects/'))[1]);
    const user = { authority, invitationToken: h.state.delivered.find(value => value.kind === 'member_invitation').text
        .match(/#invitation=([A-Za-z0-9_-]{43})/)[1] };
    const login = await h.login(user); expect(login.response.status).toBe(303);
    const container = h.getContainer('synthetic-luna-profiles'), before = entries(accounts);
    const account = JSON.parse([...accounts.records].find(([key]) => key.startsWith('customer-starter/starter-accounts/'))[1]);
    expect(account.activation).toBeNull(); expect(account).not.toHaveProperty('identitySubjectKey');
    const port = compose(h, new AzureLunaProfileStore(container), false).lunaProfile;
    const initial = await port.handleRequest(read(login.cookie));
    expect(initial).toMatchObject({ status: 503, body: { code: 'luna_profile_unavailable' } });
    expect(entries(accounts)).toEqual(before); expect(container.records.size).toBe(0);
});

test('setup-only sessions, another current subject and revoked current authority cannot read or change the saved profile', async () => {
    const f = await fixture();
    const initial = await f.port().handleRequest(read(f.login.cookie));
    expect((await f.port().handleRequest(post(f.login.cookie, initial.body.csrfToken))).status).toBe(200);
    const before = entries(f.container);
    expect((await f.port().handleRequest(read(f.setup.cookie))).status).toBeGreaterThanOrEqual(400);
    f.h.state.externalOid = uid(104); f.h.state.externalEmail = 'another-profile@synthetic.example';
    const other = await f.h.loginExternal(); expect(other.response.status).toBe(303);
    expect((await f.port().handleRequest(read(other.cookie))).status).toBeGreaterThanOrEqual(400);
    f.h.state.externalOid = uid(103); f.revoke();
    expect((await f.port().handleRequest(read(f.login.cookie))).status).toBeGreaterThanOrEqual(400);
    expect((await f.port().handleRequest(post(f.login.cookie, initial.body.csrfToken, command('After revoke', 1, uid(902))))).status)
        .toBeGreaterThanOrEqual(400);
    expect(entries(f.container)).toEqual(before);
});

test('same-origin and session-bound CSRF guards reject actual customer mutations before profile access', async () => {
    const f = await fixture(), load = jest.spyOn(f.store, 'load'), create = jest.spyOn(f.store, 'create');
    const port = compose(f.h, f.store).lunaProfile;
    const initial = await port.handleRequest(read(f.login.cookie)); load.mockClear();
    const mutations = [r => { r.headers.origin = 'https://luna.nofries.nz'; }, r => { delete r.headers.origin; },
        r => { r.headers['sec-fetch-site'] = 'same-site'; }, r => { delete r.headers['x-csrf-token']; },
        r => { r.headers['x-csrf-token'] = TOKEN; }];
    for (const mutate of mutations) {
        const req = post(f.login.cookie, initial.body.csrfToken); mutate(req);
        expect(await port.handleRequest(req)).toMatchObject({ status: 403, body: { code: 'luna_profile_access_denied' } });
    }
    const next = await f.h.loginExternal(); expect(next.response.status).toBe(303);
    expect((await port.handleRequest(post(next.cookie, initial.body.csrfToken))).status).toBe(403);
    expect(load).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
});

test('revocation during the actual adapter replacement preflight causes zero additional writes', async () => {
    const f = await fixture(), initial = await f.port().handleRequest(read(f.login.cookie));
    expect((await f.port().handleRequest(post(f.login.cookie, initial.body.csrfToken))).status).toBe(200);
    const before = entries(f.container), original = f.container.getBlockBlobClient.bind(f.container);
    let reads = 0, writes = 0;
    f.container.getBlockBlobClient = key => {
        const blob = original(key), download = blob.download.bind(blob), upload = blob.uploadData.bind(blob);
        blob.download = async (...args) => { const result = await download(...args); if (++reads === 2) f.revoke(); return result; };
        blob.uploadData = async (...args) => { writes++; return upload(...args); }; return blob;
    };
    expect((await f.port().handleRequest(post(f.login.cookie, initial.body.csrfToken, command('Revoked edit', 1, uid(903))))).status)
        .toBeGreaterThanOrEqual(400);
    // The service can read once more to reconcile a possible lost response;
    // revocation before dispatch must still leave the stored bytes untouched.
    expect(reads).toBeGreaterThanOrEqual(2); expect(writes).toBe(0); expect(entries(f.container)).toEqual(before);
});

test('acknowledgement loss reconciles the committed profile through the composed request handler', async () => {
    const f = await fixture(), initial = await f.port().handleRequest(read(f.login.cookie));
    const original = f.container.getBlockBlobClient.bind(f.container); let writes = 0;
    f.container.getBlockBlobClient = key => {
        const blob = original(key), upload = blob.uploadData.bind(blob);
        blob.uploadData = async (...args) => { await upload(...args); writes++; throw new Error('Synthetic secret provider detail'); };
        return blob;
    };
    const input = post(f.login.cookie, initial.body.csrfToken), first = await f.port().handleRequest(input);
    expect(first.status).toBe(200); expect(first.body.profile.revision).toBe(1);
    expect((await f.port().handleRequest(input)).body).toEqual(first.body); expect(writes).toBe(1);
});

test.each(['', '__Host-nofries-session=staff', '__Host-nofries-customer=legacy',
    EXTERNAL + '=first; ' + EXTERNAL + '=second', EXTERNAL + '=one; __Host-nofries-customer=two'])
('missing, staff, duplicate or mixed customer cookies are denied before trusted providers: %s', async cookie => {
    const csrf = jest.fn(async () => TOKEN), f = isolated(csrf);
    expect(await f.handlers.handleRequest(read(cookie))).toMatchObject({ status: 401, body: { code: 'luna_profile_unauthenticated' } });
    expect(csrf).not.toHaveBeenCalled(); expect(f.service.read).not.toHaveBeenCalled();
});

test.each([
    ['method', r => { r.method = 'DELETE'; }, 405],
    ['identity query', r => { r.query = { accountId: uid(1) }; }, 400],
    ['body selector', r => { r.accountId = uid(1); }, 400],
    ['command identity', r => { r.body.accountId = uid(1); }, 400],
    ['header alias', r => { r.headers.Cookie = r.headers.cookie; }, 400],
    ['header injection', r => { r.headers.origin += '\r\nx-test: yes'; }, 400],
    ['body over bound', r => { r.body.nickname = 'a'.repeat(4096); }, 413],
    ['declared body over bound', r => { r.headers['content-length'] = '4097'; }, 413],
    ['non-JSON body', r => { r.headers['content-type'] = 'text/plain'; }, 400],
    ['array body', r => { r.body = []; }, 400],
    ['accessor', r => { Object.defineProperty(r.body, 'nickname', { enumerable: true, get() { throw new Error('must not execute'); } }); }, 400]
])('strict request snapshot rejects %s before calling providers', async (_, mutate, status) => {
    const csrf = jest.fn(async () => TOKEN), f = isolated(csrf), input = post(EXTERNAL + '=synthetic', TOKEN);
    mutate(input); const result = await f.handlers.handleRequest(input);
    expect(result.status).toBe(status); expect(csrf).not.toHaveBeenCalled(); expect(f.service.save).not.toHaveBeenCalled();
    expect(result.headers['Cache-Control']).toBe('no-store');
});

test('the detached request keeps original identity, origin and command through an asynchronous CSRF read', async () => {
    let release, enter;
    const entered = new Promise(resolve => { enter = resolve; }), pending = new Promise(resolve => { release = resolve; });
    const f = isolated(async req => { expect(Object.isFrozen(req.body)).toBe(true); enter(); await pending; return TOKEN; });
    const input = post(EXTERNAL + '=original', TOKEN, command('Original'));
    const result = f.handlers.handleRequest(input); await entered;
    input.headers.cookie = EXTERNAL + '=other'; input.headers.origin = 'https://untrusted.invalid'; input.body.nickname = 'Mutated';
    release(); expect((await result).status).toBe(200);
    expect(f.service.save).toHaveBeenCalledWith(EXTERNAL + '=original', command('Original'));
});

test('private provider errors and malformed trusted CSRF output are sanitized without a write', async () => {
    for (const issuer of [async () => { throw new Error('Synthetic private credential'); }, async () => 'invalid']) {
        const f = isolated(issuer), result = await f.handlers.handleRequest(post(EXTERNAL + '=synthetic', TOKEN));
        expect(result).toMatchObject({ status: 503, body: { code: 'luna_profile_unavailable' } });
        expect(f.service.save).not.toHaveBeenCalled();
    }
});
