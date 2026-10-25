'use strict';
const request = require('supertest');
const { customerProductionHarness, uid } = require('./helpers/customerProductionHarness');

test('production activation port composes with customer logout and denies customer or cross-origin administration', async () => {
    const h = customerProductionHarness({ adminSubject: uid(1) + ':' + uid(98) + ';' + uid(1) + ':' + uid(99) }), user = h.addUser();
    const login = await h.login(user); expect(login.response.status).toBe(303);
    const body = { action: 'customer_activation', activationId: uid(50), phase: 'prepare' };
    expect((await h.sameOrigin(request(h.app).post('/api/dashboard/session')).set('Cookie', login.cookie).send(body)).status).toBe(403);
    expect((await request(h.app).post('/api/dashboard/session').set('Cookie', login.cookie)
        .set('Origin', 'https://foreign.example.test').send(body)).status).toBe(403);
    expect(h.pool.receipts.size).toBe(0); expect(h.pool.registrations.size).toBe(0);
});

test('new organisation waits for canonical preparation before offering or recording terms', async () => {
    const h = customerProductionHarness(), user = h.addUser({ prepared: false });
    const login = await h.login(user); expect(login.response.status).toBe(303);
    const pending = await request(h.app).get('/api/customer-signup/state').set('Cookie', login.cookie);
    expect(pending.status).toBe(200); expect(pending.body.state).toEqual({ status: 'pending_preparation' });
    expect(pending.body.csrfToken).toBeUndefined();
    expect(h.pool.receipts.size).toBe(0); expect(h.pool.registrations.size).toBe(0);
    h.pool.organisations.add(`${user.authority.tenantId}|${user.authority.organisationId}`);
    const unrelated = await request(h.app).get('/api/customer-signup/state').set('Cookie', login.cookie);
    expect(unrelated.body.state).toEqual({ status: 'pending_preparation' });
    h.prepareUser(user);
    const terms = await request(h.app).get('/api/customer-signup/state').set('Cookie', login.cookie);
    expect(terms.body.state.status).toBe('terms');
    h.pool.organisations.clear();
    const raced = await h.sameOrigin(request(h.app).post('/api/customer-signup/terms')).set('Cookie', login.cookie)
        .set('X-CSRF-Token', terms.body.csrfToken).send({ accepted: true, termsVersion: h.termsVersion, termsDigest: h.termsDigest,
            scheduleId: user.scheduleId, scheduleDigest: user.scheduleDigest });
    expect(raced.status).toBe(200); expect(raced.body.state).toEqual({ status: 'pending_preparation' });
    expect(h.pool.receipts.size).toBe(0); expect(h.pool.registrations.size).toBe(0);
    h.pool.organisations.add(`${user.authority.tenantId}|${user.authority.organisationId}`);
    expect((await h.consent(login.cookie)).response.body.state.status).toBe('pending_admission');
});

test.each(['missing receipt', 'wrong intent', 'changed membership', 'changed entitlement', 'changed flags', 'used allowance', 'missing allowance counter'])
('new consent is withheld for %s despite an existing organisation', async defect => {
    const h = customerProductionHarness(), user = h.addUser(), prepared = h.pool.preparations.get(`${user.authority.tenantId}|${user.authority.organisationId}`);
    const login = await h.login(user);
    const terms = await request(h.app).get('/api/customer-signup/state').set('Cookie', login.cookie);
    expect(terms.body.state.status).toBe('terms');
    const t = prepared.tables;
    if (defect === 'missing receipt') t.dashboard_operation_receipts = [];
    if (defect === 'wrong intent') t.dashboard_operation_receipts[0].intent_sha256 = 'f'.repeat(64);
    if (defect === 'changed membership') {
        t.dashboard_membership_states[0].payload.revision++;
        t.dashboard_membership_states[0].revision = String(t.dashboard_membership_states[0].payload.revision);
    }
    if (defect === 'changed entitlement') t.dashboard_entitlement_states[0].payload.grants[0].limits.assessment_runs++;
    if (defect === 'changed flags') t.dashboard_feature_flags[0].payload.enabled.cyber_security = false;
    if (defect === 'used allowance') t.dashboard_usage[0].payload.counters.assessment_runs = 1;
    if (defect === 'missing allowance counter') delete t.dashboard_usage[0].payload.counters.assessment_runs;
    const result = await h.sameOrigin(request(h.app).post('/api/customer-signup/terms')).set('Cookie', login.cookie)
        .set('X-CSRF-Token', terms.body.csrfToken).send({ accepted: true, termsVersion: h.termsVersion, termsDigest: h.termsDigest,
            scheduleId: user.scheduleId, scheduleDigest: user.scheduleDigest });
    expect(result.status).toBe(200); expect(result.body.state).toEqual({ status: 'pending_preparation' });
    expect(h.pool.receipts.size).toBe(0); expect(h.pool.registrations.size).toBe(0);
});

test('served dashboard loader keeps signed-out visitors outside the protected application', async () => {
    const { servedDashboard } = require('./helpers/servedDashboard');
    const h = customerProductionHarness();
    const page = await servedDashboard({ app: h.app, cookie: '', now: h.state.now, origin: h.env.NOFRIES_PUBLIC_URL });
    expect(page.state).toBe('unauthenticated'); expect(page.hidden).toBe(true); expect(page.text).toBe('');
    expect(page.trace).toEqual([{ url: '/api/dashboard/session', method: 'get', status: 401 }]);
});

test('failed customer callback clears its transaction cookie and preserves concurrent operator login', async () => {
    const h = customerProductionHarness(), user = h.addUser();
    const operator = await request(h.app).get('/api/auth/login');
    expect(operator.status).toBe(302);
    h.state.acrs = [];
    const failed = await h.login(user);
    expect(failed.response.status).toBeGreaterThanOrEqual(400);
    expect(failed.response.headers['set-cookie']).toEqual([
        expect.stringMatching(/^__Host-nofries-customer-tx=;.*Max-Age=0/)
    ]);
    h.state.acrs = ['c1']; h.state.oid = uid(99);
    const continued = await request(h.app).post('/api/auth/callback')
        .set('Cookie', operator.headers['set-cookie'][0].split(';')[0]).type('form')
        .send({ state: new URL(operator.headers.location).searchParams.get('state'), code: 'synthetic-code' });
    expect(continued.status).toBe(303);
    expect(continued.headers['set-cookie'][0]).toMatch(/^__Host-nofries-auth=/);
});

test('actual production application serves signup and joins callback, terms, CSRF, receipt and returning status', async () => {
    const h = customerProductionHarness(), user = h.addUser();
    expect((await request(h.app).get('/signup')).text).toContain('/api/customer-auth/login');
    expect((await request(h.app).get('/api/customer-signup/state')).body.state.status).toBe('create_account');
    const login = await h.login(user);
    expect(login.response.status).toBe(303);
    expect(login.cookie).toMatch(/^__Host-nofries-customer=/);
    expect(h.state.authRequests[0].claims).toBe(JSON.stringify({ id_token: { acrs: { essential: true, value: 'c1' } } }));
    const { before, response } = await h.consent(login.cookie);
    expect(before.body.state).toEqual({ status: 'terms', termsText: h.termsText, termsVersion: h.termsVersion,
        termsDigest: h.termsDigest, scheduleId: user.scheduleId, scheduleText: user.scheduleText,
        scheduleDigest: user.scheduleDigest });
    expect(response.status).toBe(200); expect(response.body.state.status).toBe('pending_admission');
    expect(h.pool.receipts.size).toBe(1); expect(h.pool.registrations.size).toBe(1);
    for (const container of h.state.containers.values()) {
        for (const bytes of container.records.values()) expect(bytes.toString()).not.toContain(user.invitationToken);
    }
    user.deleteBootstrap();
    expect((await request(h.app).get('/api/customer-signup/state').set('Cookie', login.cookie)).body.state.status).toBe('pending_admission');
    const returning = await h.login(user, { bootstrap: false });
    expect(returning.response.status).toBe(303);
    expect((await request(h.app).get('/api/customer-signup/state').set('Cookie', returning.cookie)).body.state.status).toBe('pending_admission');
    user.authority.status = 'revoked'; user.save();
    expect((await request(h.app).get('/api/customer-signup/state').set('Cookie', returning.cookie)).status).toBe(503);
    expect(h.pool.receipts.size).toBe(1);
});
test.each(['missing claim', 'disabled policy', 'excluded user', 'conditional locations', 'alternative grant'])('real callback denies %s without an issued customer session', async variant => {
    const h = customerProductionHarness(), user = h.addUser();
    if (variant === 'missing claim') h.state.acrs = [];
    if (variant === 'disabled policy') h.state.policyEnabled = false;
    if (variant === 'excluded user') h.state.changePolicy = p => p.conditions.users.excludeUsers.push(user.authority.subjectKey.split(':')[1]);
    if (variant === 'conditional locations') h.state.changePolicy = p => { p.conditions.locations = { includeLocations: ['AllTrusted'] }; };
    if (variant === 'alternative grant') h.state.changePolicy = p => { p.grantControls = { operator: 'OR', builtInControls: ['mfa', 'compliantDevice'] }; };
    expect((await h.login(user)).response.status).toBeGreaterThanOrEqual(400);
    expect([...h.getContainer('nofries-browser-auth').records.keys()].filter(k => k.startsWith('browser-auth/sessions/'))).toHaveLength(0);
});
test('display email and tenant login cannot replace the delivered invitation capability', async () => {
    const h = customerProductionHarness(), user = h.addUser();
    expect((await h.login(user, { bootstrap: false })).response.status).toBeGreaterThanOrEqual(400);
    const other = h.addUser({ oid: uid(8), organisationId: 'org-two' });
    expect((await h.login({ ...user, invitationToken: other.invitationToken })).response.status).toBeGreaterThanOrEqual(400);
});
test('second user requires records only and customer cookie cannot be promoted into operator session', async () => {
    const h = customerProductionHarness(), first = h.addUser(), second = h.addUser({ oid: uid(8), organisationId: 'org-two' });
    for (const user of [first, second]) {
        const login = await h.login(user); expect(login.response.status).toBe(303);
        expect((await h.consent(login.cookie)).response.status).toBe(200);
        const forged = login.cookie.replace('__Host-nofries-customer=', '__Host-nofries-auth=');
        expect((await request(h.app).get('/api/auth/session').set('Cookie', forged)).status).toBe(401);
    }
    expect(h.pool.receipts.size).toBe(2); expect(h.pool.registrations.size).toBe(2);
});
test('bootstrap and consent require same-origin protection and session-bound CSRF', async () => {
    const h = customerProductionHarness(), user = h.addUser();
    expect((await request(h.app).post('/api/customer-signup/bootstrap').send({ invitationToken: user.invitationToken })).status).toBe(403);
    const login = await h.login(user);
    const response = await h.sameOrigin(request(h.app).post('/api/customer-signup/terms')).set('Cookie', login.cookie)
        .set('X-CSRF-Token', 'x'.repeat(43)).send({ accepted: true, termsVersion: h.termsVersion, termsDigest: h.termsDigest });
    expect(response.status).toBe(403); expect(h.pool.receipts.size).toBe(0);
});

test('current policy removal and authority edits invalidate an already issued customer session', async () => {
    for (const change of ['policy', 'authority']) {
        const h = customerProductionHarness(), user = h.addUser(), login = await h.login(user);
        expect(login.response.status).toBe(303);
        if (change === 'policy') h.state.policyEnabled = false;
        else { user.authority.organisationId = 'changed-without-revision'; user.save(); }
        expect((await request(h.app).get('/api/customer-signup/state').set('Cookie', login.cookie)).status).toBeGreaterThanOrEqual(400);
    }
});

test('a customer parent cookie without its original issuance proof cannot initialize a dashboard', async () => {
    const h = customerProductionHarness(), user = h.addUser(), login = await h.login(user);
    expect(login.response.status).toBe(303);
    h.getContainer('dashboard-proofs').records.clear();
    const response = await request(h.app).get('/api/dashboard/session').set('Cookie', login.cookie);
    expect(response.status).toBe(403);
});

test('successful purpose transitions clear the competing browser credential', async () => {
    const h = customerProductionHarness(), user = h.addUser(), customer = await h.login(user);
    expect(customer.response.status).toBe(303);
    expect(customer.response.headers['set-cookie'].some(value => value.startsWith('__Host-nofries-auth=;'))).toBe(true);
    h.state.oid = uid(99);
    const login = await request(h.app).get('/api/auth/login?returnTo=%2Fdashboard').set('Cookie', customer.cookie);
    const callback = await request(h.app).post('/api/auth/callback').set('Cookie', login.headers['set-cookie'][0].split(';')[0]).type('form')
        .send({ code: 'synthetic-code', state: new URL(login.headers.location).searchParams.get('state') });
    expect(callback.status).toBe(303);
    expect(callback.headers['set-cookie'].some(value => value.startsWith('__Host-nofries-customer=;'))).toBe(true);
});

test('the public login route opens only the customer journey', async () => {
    const h = customerProductionHarness();
    const entry = await request(h.app).get('/api/dashboard/login');
    expect(entry.status).toBe(303); expect(entry.headers.location).toBe('/login');
    const page = await request(h.app).get(entry.headers.location);
    expect(page.status).toBe(200); expect(page.text).toContain('Sign up / Sign in');
    expect(page.text).not.toMatch(/Operator account|Staff sign in|\/api\/auth\/login/);
});

test('a historical mailbox proof cannot verify a changed email address on the same guest', async () => {
    const h = customerProductionHarness(), user = h.addUser();
    expect((await h.login(user)).response.status).toBe(303);
    user.authority.email = 'unverified-replacement@example.test'; user.authority.revision++; user.save();
    expect((await h.login(user, { bootstrap: false })).response.status).toBeGreaterThanOrEqual(400);
});

test('durable authority stays in the data account while sessions stay in the auth-only account', async () => {
    const h = customerProductionHarness(), user = h.addUser();
    expect(h.state.blobContainerClients.filter(c => c.name === 'customer-authority'))
        .toEqual([{ name: 'customer-authority', account: h.env.AZURE_STORAGE_ACCOUNT_NAME }]);
    h.getContainer('customer-authority', h.env.NOFRIES_BROWSER_AUTH_STORAGE_ACCOUNT).records
        .set('customer-terms/' + h.termsDigest + '.json', Buffer.from('{}'));
    const login = await h.login(user);
    expect(login.response.status).toBe(303);
    const { before, response } = await h.consent(login.cookie);
    expect(before.body.state.termsText).toBe(h.termsText);
    expect(response.status).toBe(200);
    expect(h.state.blobServiceUrls).toContain('https://' + h.env.AZURE_STORAGE_ACCOUNT_NAME + '.blob.core.windows.net');
    expect(h.getContainer('nofries-browser-auth').records.size).toBeGreaterThan(0);
    expect(h.getContainer('nofries-browser-auth', h.env.AZURE_STORAGE_ACCOUNT_NAME).records.size).toBe(0);
});

test.each([undefined, '', 'ABCD', 'has-dash', 'bad.account', 'ab', 'a'.repeat(25), 'syntheticauth123'])
    ('customer signup rejects missing, malformed or auth-only authority account %p before provider construction', value => {
        const env = { NOFRIES_CUSTOMER_SIGNUP_ENABLED: 'true', NOFRIES_CUSTOMER_AUTHORITY_CONTAINER: 'customer-authority',
            NOFRIES_BROWSER_AUTH_STORAGE_ACCOUNT: 'syntheticauth123', NOFRIES_CUSTOMER_MFA_POLICY_ID: uid(7) };
        const { createProductionCustomerSignupConfiguration } = require('../lib/customerSignupProduction');
        const dependencies = { ManagedIdentityCredential: jest.fn(), BlobServiceClient: jest.fn() };
        expect(() => createProductionCustomerSignupConfiguration({ ...env, AZURE_STORAGE_ACCOUNT_NAME: value }, {}, dependencies))
            .toThrow('customer_signup_production_unavailable');
        expect(dependencies.ManagedIdentityCredential).not.toHaveBeenCalled();
        expect(dependencies.BlobServiceClient).not.toHaveBeenCalled();
    });

test('verified email repairs first login without an invitation cookie; returning login preserves the same identity', async () => {
    const h = customerProductionHarness({ starter: true, now: Date.now(), customerClientId: uid(70) });
    const user = h.addUser({ email: 'person@gmail.com' });
    const start = await h.sameOrigin(request(h.app).post('/api/organisation-setup/request')).send({ email: user.authority.email });
    expect(start.status).toBe(202);
    const setupCookie = start.headers['set-cookie'][0].split(';')[0];
    const code = h.state.delivered.find(x => x.kind === 'code').text.match(/\b[0-9]{8}\b/)[0];
    const verified = await h.sameOrigin(request(h.app).post('/api/organisation-setup/verify')).set('Cookie', setupCookie)
        .set('X-NoFries-Setup-Request', start.body.requestId).send({ code });
    expect(verified.status).toBe(200);
    const first = await h.login(user, { bootstrap: false, setupCookie });
    expect(first.response.status).toBe(303); expect(first.cookie).toMatch(/^__Host-nofries-customer=/);
    expect(h.state.authRequests.at(-1).loginHint).toBe(user.authority.email);
    const returning = await h.login(user, { bootstrap: false });
    expect(returning.response.status).toBe(303); expect(returning.cookie).toMatch(/^__Host-nofries-customer=/);
    expect(h.pool.registrations.size).toBe(0); expect(h.pool.receipts.size).toBe(0);
    const proof = [...h.getContainer('nofries-browser-auth').records.entries()].find(([k]) => k.startsWith('customer-email-proofs/'));
    expect(JSON.parse(proof[1])).toMatchObject({ subjectKey: user.authority.subjectKey, email: user.authority.email, method: 'nofries-email-code-and-entra-mfa' });
    // Customer proof never makes this identity a staff/operator user.
    expect((await request(h.app).get('/api/auth/session').set('Cookie', returning.cookie)).body.authenticated).toBe(false);
});

test.each(['unverified', 'wrong mailbox', 'detached'])('customer callback refuses %s email recovery without issuing a session', async defect => {
    const h = customerProductionHarness({ starter: true, now: Date.now() }), user = h.addUser({ email: 'person@gmail.com' });
    const email = defect === 'wrong mailbox' ? 'someone-else@gmail.com' : user.authority.email;
    const start = await h.sameOrigin(request(h.app).post('/api/organisation-setup/request')).send({ email });
    const setupCookie = start.headers['set-cookie'][0].split(';')[0];
    const post = path => h.sameOrigin(request(h.app).post('/api/organisation-setup/' + path)).set('Cookie', setupCookie).set('X-NoFries-Setup-Request', start.body.requestId);
    if (defect !== 'unverified') await post('verify').send({ code: h.state.delivered.find(x => x.kind === 'code').text.match(/\b[0-9]{8}\b/)[0] });
    if (defect === 'detached') await post('state').send({ action: 'leave' });
    expect((await h.login(user, { bootstrap: false, setupCookie })).response.status).toBe(401);
    expect([...h.getContainer('nofries-browser-auth').records.keys()].filter(k => k.startsWith('browser-auth/sessions/'))).toHaveLength(0);
    expect([...h.getContainer('nofries-browser-auth').records.keys()].filter(k => k.startsWith('customer-email-proofs/'))).toHaveLength(0);
});

test('customer application validates its own audience and the operator application retains its audience', async () => {
    const h = customerProductionHarness({ customerClientId: uid(70) }), user = h.addUser();
    expect((await h.login(user)).response.status).toBe(303);
    h.state.tokenAudience = h.env.NOFRIES_ENTRA_CLIENT_ID;
    expect((await h.login(user, { bootstrap: false })).response.status).toBe(400);
    const staff = await request(h.app).get('/api/auth/login');
    expect(new URL(staff.headers.location).searchParams.get('client_id')).toBe(h.env.NOFRIES_ENTRA_CLIENT_ID);
});

test('missing first-login email proof is diagnosable and browsers return to a recoverable customer page', async () => {
    const h = customerProductionHarness(), user = h.addUser();
    const log = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
        const missing = await h.login(user, { bootstrap: false });
        expect(missing.response.status).toBe(401);
        expect(log).toHaveBeenCalledWith('Browser sign-in callback failed: browser_auth_email_verification_required');
        const page = await h.login(user, { bootstrap: false, html: true });
        expect(page.response.status).toBe(303); expect(page.response.headers.location).toBe('/login?signin=retry&provider=legacy');
        expect(page.response.headers['set-cookie']).toEqual([expect.stringMatching(/^__Host-nofries-customer-tx=;.*Max-Age=0/)]);
        expect(JSON.stringify(log.mock.calls)).not.toContain(user.authority.email);
    } finally { log.mockRestore(); }
});


test.each([false, true].flatMap(starter => [null, 'company', 'consultant'].map(savedChoice => [starter, savedChoice])))
('verified returning legacy account is recovered with starter=%s, saved choice=%s', async (starter, savedChoice) => {
    const h = customerProductionHarness({ starter, organisationSetup: true, now: Date.now() });
    const user = h.addUser({ email: 'returning@gmail.com' });
    h.state.directoryUsers = [{ id: h.state.oid, mail: user.authority.email, userPrincipalName: user.authority.email,
        otherMails: [], proxyAddresses: [], userType: 'Member', accountEnabled: true }];
    const before = [...h.getContainer('customer-authority').records].map(([key, value]) => [key, value.toString('base64')]);
    const organisations = [...h.pool.organisations];
    const start = await h.sameOrigin(request(h.app).post('/api/organisation-setup/request')).send({ email: user.authority.email,
        ...(savedChoice ? { accountType: savedChoice, organisationName: 'Saved organisation choice' } : {}) });
    expect(start.status).toBe(202);
    const setupCookie = start.headers['set-cookie'][0].split(';')[0];
    const post = action => h.sameOrigin(request(h.app).post('/api/organisation-setup/' + action))
        .set('Cookie', setupCookie).set('X-NoFries-Setup-Request', start.body.requestId);
    const verified = await post('verify').send({ code: h.state.delivered[0].text.match(/\b[0-9]{8}\b/)[0] });
    expect(verified.status).toBe(200);
    expect(verified.body).toMatchObject({ state: 'verified', nextStep: 'account_found', accountType: 'company' });
    expect((await request(h.app).get('/api/organisation-setup/state').set('Cookie', setupCookie)).body).toEqual(verified.body);
    expect((await post('verify').send({ code: '00000000' })).body).toEqual(verified.body);
    if (!savedChoice) {
        const choose = await post('choose').send({ accountType: 'consultant', organisationName: 'Duplicate organisation' });
        expect(choose.status).toBe(409); expect(choose.body.code).toBe('starter_account_exists');
    }
    const login = await h.login(user, { bootstrap: false, setupCookie });
    expect(login.response.status).toBe(303);
    expect(login.cookie).toMatch(/^__Host-nofries-customer=/);
    expect([...h.getContainer('customer-authority').records].map(([key, value]) => [key, value.toString('base64')])).toEqual(before);
    expect(h.getContainer('starter-authority').records.size).toBe(0);
    expect([...h.pool.organisations]).toEqual(organisations);
    expect(h.pool.registrations.size).toBe(0); expect(h.pool.receipts.size).toBe(0);
    expect(h.state.delivered).toHaveLength(1);
});

test('saved starter details remain retryable when failure precedes invitation delivery', async () => {
    const h = customerProductionHarness({ starter: true, now: Date.now() });
    const start = await h.sameOrigin(request(h.app).post('/api/organisation-setup/request'))
        .send({ email: 'retry@gmail.com', accountType: 'company', organisationName: 'Retry organisation' });
    expect(start.status).toBe(202);
    const setupCookie = start.headers['set-cookie'][0].split(';')[0];
    const post = action => h.sameOrigin(request(h.app).post('/api/organisation-setup/' + action))
        .set('Cookie', setupCookie).set('X-NoFries-Setup-Request', start.body.requestId);
    expect((await post('verify').send({ code: h.state.delivered[0].text.match(/\b[0-9]{8}\b/)[0] })).body.nextStep).toBe('details_required');
    const input = { name: 'Synthetic representative', role: 'Owner', address: 'Synthetic address', registrationId: '', authorityConfirmed: true };
    const terms = h.getContainer('customer-authority').records, termsKey = `customer-terms/${h.termsDigest}.json`, savedTerms = terms.get(termsKey);
    expect(savedTerms).toBeDefined(); terms.delete(termsKey);
    expect((await post('details').send(input)).status).toBe(503);
    const starter = h.getContainer('starter-authority').records;
    const reserved = [...starter].filter(([key]) => /starter-accounts\/|starter-setups\//.test(key))
        .map(([key, value]) => [key, value.toString('base64')]);
    expect(reserved).toHaveLength(2);
    expect([...starter.keys()].some(key => key.startsWith('customer-invitation-attempts/'))).toBe(false);
    expect(h.state.delivered).toHaveLength(1);
    terms.set(termsKey, savedTerms);
    const resumed = await request(h.app).get('/api/organisation-setup/state').set('Cookie', setupCookie);
    expect(resumed.status).toBe(200); expect(resumed.body.nextStep).toBe('details_required');
    // This fixture deliberately has no native starter SQL. Delivery and its
    // durable context must still complete once, before preparation fails closed.
    expect((await post('details').send(input)).status).toBe(503);
    expect((await request(h.app).get('/api/organisation-setup/state').set('Cookie', setupCookie)).body.nextStep).toBe('account_found');
    expect((await post('details').send(input)).status).toBe(503);
    expect([...starter].filter(([key]) => /starter-accounts\/|starter-setups\//.test(key))
        .map(([key, value]) => [key, value.toString('base64')])).toEqual(reserved);
    expect(h.state.delivered.filter(value => value.kind === 'invitation')).toHaveLength(1);
    expect(h.pool.registrations.size).toBe(0); expect(h.pool.receipts.size).toBe(0);
});


test('opening a different invitation clears only the old browser setup pointer and authenticates the invited identity', async () => {
    const h = customerProductionHarness({ starter: true, now: Date.now() });
    const previous = h.addUser({ oid: uid(51), email: 'previous@gmail.com', organisationId: 'previous-org' });
    const invited = h.addUser({ oid: uid(52), email: 'invited@gmail.com', organisationId: 'invited-org' });
    h.state.directoryUsers = [{ id: uid(51), mail: previous.authority.email, userPrincipalName: previous.authority.email,
        otherMails: [], proxyAddresses: [], userType: 'Guest', accountEnabled: true }];
    const start = await h.sameOrigin(request(h.app).post('/api/organisation-setup/request')).send({ email: previous.authority.email });
    const setupCookie = start.headers['set-cookie'][0].split(';')[0];
    const verified = await h.sameOrigin(request(h.app).post('/api/organisation-setup/verify')).set('Cookie', setupCookie)
        .set('X-NoFries-Setup-Request', start.body.requestId).send({ code: h.state.delivered[0].text.match(/\b[0-9]{8}\b/)[0] });
    expect(verified.body.nextStep).toBe('account_found');
    const setupRecords = () => [...h.getContainer('nofries-browser-auth').records]
        .filter(([key]) => key.startsWith('browser-auth/organisation-setup/')).map(([key, value]) => [key, value.toString('base64')]);
    const before = setupRecords();
    const authorities = [...h.getContainer('customer-authority').records].map(([key, value]) => [key, value.toString('base64')]);
    const rejected = await h.sameOrigin(request(h.app).post('/api/customer-signup/bootstrap')).set('Cookie', setupCookie)
        .send({ invitationToken: 'invalid' });
    expect(rejected.status).toBe(403); expect(rejected.headers['set-cookie']).toBeUndefined();
    const bootstrap = await h.sameOrigin(request(h.app).post('/api/customer-signup/bootstrap')).set('Cookie', setupCookie)
        .send({ invitationToken: invited.invitationToken });
    expect(bootstrap.status).toBe(204);
    const cookies = bootstrap.headers['set-cookie'];
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toBe('__Host-nofries-signup=' + invited.invitationToken + '; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600');
    expect(cookies[1]).toBe('__Host-nofries_org_setup=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0');
    expect(setupRecords()).toEqual(before);
    // The browser applies both Set-Cookie values: the old setup cookie is expired.
    const login = await h.login(invited, { bootstrap: false, setupCookie: cookies[0].split(';')[0] });
    expect(login.response.status).toBe(303); expect(login.cookie).toMatch(/^__Host-nofries-customer=/);
    expect(h.state.authRequests.at(-1)).not.toHaveProperty('loginHint');
    expect(setupRecords()).toEqual(before);
    expect([...h.getContainer('customer-authority').records].map(([key, value]) => [key, value.toString('base64')])).toEqual(authorities);
    expect(h.pool.registrations.size).toBe(0); expect(h.pool.receipts.size).toBe(0); expect(h.state.delivered).toHaveLength(1);
});

test('fresh email verification still overrides an older invitation cookie on the public login entry', async () => {
    const h = customerProductionHarness({ starter: true, now: Date.now() });
    const older = h.addUser({ oid: uid(61), email: 'older@gmail.com', organisationId: 'older-org' });
    const current = h.addUser({ oid: uid(62), email: 'current@gmail.com', organisationId: 'current-org' });
    const start = await h.sameOrigin(request(h.app).post('/api/organisation-setup/request')).send({ email: current.authority.email });
    const setupCookie = start.headers['set-cookie'][0].split(';')[0];
    const verified = await h.sameOrigin(request(h.app).post('/api/organisation-setup/verify')).set('Cookie', setupCookie)
        .set('X-NoFries-Setup-Request', start.body.requestId).send({ code: h.state.delivered[0].text.match(/\b[0-9]{8}\b/)[0] });
    expect(verified.status).toBe(200);
    const login = await h.login(current, { bootstrap: false, setupCookie: setupCookie + '; __Host-nofries-signup=' + older.invitationToken });
    expect(login.response.status).toBe(303);
    expect(h.state.authRequests.at(-1).loginHint).toBe(current.authority.email);
    expect(h.pool.registrations.size).toBe(0); expect(h.pool.receipts.size).toBe(0); expect(h.state.delivered).toHaveLength(1);
});
