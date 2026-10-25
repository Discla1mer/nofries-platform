'use strict';

const request = require('supertest');
const { customerProductionHarness } = require('./helpers/customerProductionHarness');
const { createProductionApplication } = require('../lib/productionApplication');

let warning;
beforeEach(() => { warning = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { warning.mockRestore(); });
const events = () => warning.mock.calls.map(([line]) => JSON.parse(line));
function expectPrivate(eventsSeen, user, cookie, response) {
    const reference = response.headers['x-nofries-support-reference'];
    expect(reference).toHaveLength(19); expect(reference).toMatch(/^NF-[A-F0-9]{16}$/);
    for (const event of eventsSeen) {
        expect(Object.keys(event)).toEqual(['timestamp', 'code', 'stage', 'supportReference']);
        expect(event.supportReference).toBe(reference);
        expect(new Date(event.timestamp).toISOString()).toBe(event.timestamp);
    }
    const text = JSON.stringify(eventsSeen);
    for (const secret of [user.invitationToken, user.authority.email, user.authority.subjectKey,
        user.authority.invitationDigest, user.authority.organisationId, cookie, 'synthetic-provider-secret']) {
        expect(text).not.toContain(secret);
    }
}

async function savedConsultantOwnWorkspace() {
    const h = customerProductionHarness({ starter: true, now: Date.now() });
    const email = 'synthetic-consultant@example.invalid';
    h.state.directoryUsers = [{ id: h.state.oid, mail: email, userPrincipalName: email,
        otherMails: [], proxyAddresses: [], userType: 'Member', accountEnabled: true }];
    const start = await h.sameOrigin(request(h.app).post('/api/organisation-setup/request'))
        .send({ email, accountType: 'consultant', organisationName: 'Synthetic consultant workspace' });
    expect(start.status).toBe(202);
    const setupCookie = start.headers['set-cookie'][0].split(';')[0];
    const post = action => h.sameOrigin(request(h.app).post('/api/organisation-setup/' + action))
        .set('Cookie', setupCookie).set('X-NoFries-Setup-Request', start.body.requestId);
    expect((await post('verify').send({ code: h.state.delivered[0].text.match(/\b[0-9]{8}\b/)[0] })).body.nextStep).toBe('details_required');
    // Genuine source composition saves the own-slot account, completed delivery
    // and authority before the synthetic SQL fixture rejects preparation.
    expect((await post('details').send({ name: 'Synthetic representative', role: 'Owner',
        address: 'Synthetic address', registrationId: '', authorityConfirmed: true })).status).toBe(503);
    const authorityEntry = [...h.getContainer('starter-authority').records].find(([key]) => key.startsWith('customer-subjects/'));
    expect(authorityEntry).toBeDefined();
    const authority = JSON.parse(authorityEntry[1].toString());
    const deliveries = h.state.delivered.filter(value => value.kind === 'member_invitation');
    expect(deliveries).toHaveLength(1);
    const user = { authority, invitationToken: deliveries[0].text.match(/#invitation=([A-Za-z0-9_-]{43})/)[1] };
    const login = await h.login(user);
    expect(login.response.status).toBe(303);
    warning.mockClear();
    return { h, user, login };
}

test('Consultant own-workspace state retains the safe account-store failure code without repeating saved setup', async () => {
    const { h, user, login } = await savedConsultantOwnWorkspace();
    const container = h.getContainer('starter-authority');
    const before = [...container.records].map(([key, bytes]) => [key, bytes.toString('base64')]);
    const original = container.getBlockBlobClient;
    let reads = 0;
    container.getBlockBlobClient = key => {
        const blob = original(key);
        if (!key.startsWith('customer-starter/starter-accounts/')) return blob;
        return { ...blob, async download() { reads++; throw new Error('synthetic-provider-secret'); } };
    };
    const response = await request(h.app).get('/api/customer-signup/state').set('Cookie', login.cookie);
    expect(reads).toBe(1);
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'Signup is unavailable', code: 'signup_unavailable' });
    expect(events()).toEqual([{ timestamp: expect.any(String), code: 'starter_store_unavailable', stage: 'organisation_preparation', supportReference: response.headers['x-nofries-support-reference'] }]);
    expectPrivate(events(), user, login.cookie, response);
    expect([...container.records].map(([key, bytes]) => [key, bytes.toString('base64')])).toEqual(before);
    expect(h.state.delivered).toHaveLength(2);
    expect(h.pool.receipts.size).toBe(0); expect(h.pool.registrations.size).toBe(0);
});

test.each(['postgres_connection_failed', 'postgres_query_failed'])
('Consultant own-workspace preparation retains %s from the real database adapter', async code => {
    const { h, user, login } = await savedConsultantOwnWorkspace();
    const connect = h.pool.connect;
    const before = [...h.getContainer('starter-authority').records].map(([key, bytes]) => [key, bytes.toString('base64')]);
    let failures = 0;
    h.pool.connect = async () => {
        if (code === 'postgres_connection_failed') { failures++; throw new Error('synthetic-provider-secret'); }
        const client = await connect();
        return { ...client, async query(sql, params) {
            if (sql.startsWith('SELECT preparation,activation FROM nofries.dashboard_starter_scopes')) {
                failures++; throw new Error('synthetic-provider-secret');
            }
            return client.query(sql, params);
        } };
    };
    const response = await request(h.app).get('/api/customer-signup/state').set('Cookie', login.cookie);
    expect(failures).toBe(1);
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'Signup is unavailable', code: 'signup_unavailable' });
    expect(events()).toEqual([{ timestamp: expect.any(String), code, stage: 'organisation_preparation', supportReference: response.headers['x-nofries-support-reference'] }]);
    expectPrivate(events(), user, login.cookie, response);
    expect([...h.getContainer('starter-authority').records].map(([key, bytes]) => [key, bytes.toString('base64')])).toEqual(before);
    expect(h.state.delivered).toHaveLength(2);
    expect(h.pool.receipts.size).toBe(0); expect(h.pool.registrations.size).toBe(0);
});

test('production state logs the swallowed terms failure while retaining the exact public state and manual consent', async () => {
    const h = customerProductionHarness(), user = h.addUser(), login = await h.login(user);
    const ready = await request(h.app).get('/api/customer-signup/state').set('Cookie', login.cookie);
    expect(ready.body.state.status).toBe('terms');
    expect(warning).not.toHaveBeenCalled();
    user.withdrawOffer();
    const response = await request(h.app).get('/api/customer-signup/state').set('Cookie', login.cookie);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ state: { status: 'unavailable' } });
    expect(events()).toEqual([{ timestamp: expect.any(String), code: 'signup_terms_unavailable', stage: 'terms_offer', supportReference: response.headers['x-nofries-support-reference'] }]);
    expectPrivate(events(), user, login.cookie, response);
    expect(h.pool.receipts.size).toBe(0); expect(h.pool.registrations.size).toBe(0);
});

test('a missing invitation without durable consent logs the precise continuation failure without recreating it', async () => {
    const h = customerProductionHarness(), user = h.addUser(), login = await h.login(user);
    user.deleteBootstrap();
    const authRecords = h.getContainer('nofries-browser-auth').records;
    const beforeKeys = [...authRecords.keys()];
    const response = await request(h.app).get('/api/customer-signup/state').set('Cookie', login.cookie);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ state: { status: 'unavailable' } });
    expect(events()).toEqual([
        { timestamp: expect.any(String), code: 'signup_continuation_unavailable', stage: 'continuation_receipt', supportReference: response.headers['x-nofries-support-reference'] },
        { timestamp: expect.any(String), code: 'signup_continuation_unavailable', stage: 'signup_continuation', supportReference: response.headers['x-nofries-support-reference'] }
    ]);
    expectPrivate(events(), user, login.cookie, response);
    expect([...authRecords.keys()]).toEqual(beforeKeys);
    expect(h.pool.receipts.size).toBe(0); expect(h.pool.registrations.size).toBe(0);
});

test('production state logs an outer organisation preparation failure but keeps the generic HTTP error', async () => {
    const h = customerProductionHarness(), user = h.addUser(), login = await h.login(user);
    h.pool.connect = async () => { throw new Error('synthetic-provider-secret'); };
    const response = await request(h.app).get('/api/customer-signup/state').set('Cookie', login.cookie);
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'Signup is unavailable', code: 'signup_unavailable' });
    expect(events()).toEqual([{ timestamp: expect.any(String), code: 'signup_acceptance_journal_unavailable', stage: 'organisation_preparation', supportReference: response.headers['x-nofries-support-reference'] }]);
    expectPrivate(events(), user, login.cookie, response);
    expect(h.pool.receipts.size).toBe(0); expect(h.pool.registrations.size).toBe(0);
});

test('production state observes an asynchronous projection rejection after identity rechecks without admitting the user', async () => {
    const h = customerProductionHarness(), user = h.addUser(), login = await h.login(user);
    expect((await h.consent(login.cookie)).response.body.state.status).toBe('pending_admission');
    let policies = 0;
    h.state.changePolicy = policy => { if (++policies === 5) policy.state = 'disabled'; };
    const response = await request(h.app).get('/api/customer-signup/state').set('Cookie', login.cookie);
    expect(policies).toBe(5);
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'Signup is unavailable', code: 'signup_unavailable' });
    expect(events()).toEqual([{ timestamp: expect.any(String), code: 'browser_auth_customer_mfa_required', stage: 'admission_projection', supportReference: response.headers['x-nofries-support-reference'] }]);
    expectPrivate(events(), user, login.cookie, response);
    expect(h.pool.receipts.size).toBe(1); expect(h.pool.registrations.size).toBe(1);
});

test('a failing production diagnostic sink cannot change the failed customer state', async () => {
    const h = customerProductionHarness(), user = h.addUser(), login = await h.login(user);
    const signupDiagnostics = jest.fn(() => { throw new Error('synthetic-provider-secret'); });
    const app = createProductionApplication(h.env, { ...h.dependencies, signupDiagnostics });
    user.withdrawOffer();
    const response = await request(app).get('/api/customer-signup/state').set('Cookie', login.cookie);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ state: { status: 'unavailable' } });
    expect(signupDiagnostics).toHaveBeenCalledTimes(1);
    expect(Object.isFrozen(signupDiagnostics.mock.calls[0][0])).toBe(true);
    expectPrivate(signupDiagnostics.mock.calls.map(([event]) => event), user, login.cookie, response);
    expect(warning).not.toHaveBeenCalled();
    expect(h.pool.receipts.size).toBe(0); expect(h.pool.registrations.size).toBe(0);
});
