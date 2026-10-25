'use strict';

const request = require('supertest');
const { customerProductionHarness, uid } = require('./helpers/customerProductionHarness');

function savedEvidence(h) {
    return {
        auth: [...h.getContainer('nofries-browser-auth').records]
            .filter(([key]) => key.startsWith('customer-email-proofs/') || key.startsWith('browser-auth/organisation-setup/'))
            .map(([key, bytes]) => [key, bytes.toString('base64')]),
        authority: [...h.getContainer('customer-authority').records].map(([key, bytes]) => [key, bytes.toString('base64')]),
        organisations: [...h.pool.organisations], registrations: [...h.pool.registrations], receipts: [...h.pool.receipts],
        delivered: JSON.stringify(h.state.delivered)
    };
}

async function begin(h, cookie) {
    return request(h.app).get('/api/customer-auth/login').set('Cookie', cookie).set('Accept', 'text/html');
}

async function callback(h, login) {
    expect(login.status).toBe(302);
    return request(h.app).post('/api/customer-auth/callback')
        .set('Cookie', login.headers['set-cookie'][0].split(';')[0]).type('form')
        .send({ state: new URL(login.headers.location).searchParams.get('state'), code: 'synthetic-code' });
}

async function verifiedSetup(h, email) {
    const start = await h.sameOrigin(request(h.app).post('/api/organisation-setup/request')).send({ email });
    expect(start.status).toBe(202);
    const cookie = start.headers['set-cookie'][0].split(';')[0];
    const post = action => h.sameOrigin(request(h.app).post('/api/organisation-setup/' + action))
        .set('Cookie', cookie).set('X-NoFries-Setup-Request', start.body.requestId);
    const code = h.state.delivered.filter(x => x.kind === 'code').at(-1).text.match(/\b[0-9]{8}\b/)[0];
    expect((await post('verify').send({ code })).status).toBe(200);
    return { cookie, post };
}

test.each(['same mailbox', 'another mailbox'])('established returning login survives leaving verified setup for %s', async variant => {
    const h = customerProductionHarness({ organisationSetup: true, now: Date.now(), customerClientId: uid(70) });
    const user = h.addUser({ email: 'returning@example.test' });
    expect((await h.login(user)).response.status).toBe(303);
    const setup = await verifiedSetup(h, variant === 'same mailbox' ? user.authority.email : 'abandoned@example.test');
    const left = await setup.post('state').send({ action: 'leave' });
    expect(left.status).toBe(200); expect(left.body).toEqual({ state: 'start' });
    expect(left.headers['set-cookie']).toBeUndefined();
    const before = savedEvidence(h);
    // This is exactly the cookie the browser retains after Use another email.
    for (let attempt = 0; attempt < 2; attempt++) {
        expect((await setup.post('state').send({ action: 'leave' })).status).toBe(200);
        const login = await begin(h, setup.cookie);
        expect(login.status).toBe(302);
        expect(new URL(login.headers.location).hostname).toBe('login.microsoftonline.com');
        expect(h.state.authRequests.at(-1)).not.toHaveProperty('loginHint');
        const response = await callback(h, login);
        expect(response.status).toBe(303);
        expect(response.headers['set-cookie'][0]).toMatch(/^__Host-nofries-customer=/);
        const cookie = response.headers['set-cookie'][0].split(';')[0];
        expect((await request(h.app).get('/api/auth/session').set('Cookie', cookie)).body.authenticated).toBe(false);
        expect(savedEvidence(h)).toEqual(before);
    }
});

test('detaching an in-flight setup login rejects that transaction even with durable proof, but a new independent login works', async () => {
    const h = customerProductionHarness({ organisationSetup: true, now: Date.now() });
    const user = h.addUser({ email: 'returning@example.test' });
    expect((await h.login(user)).response.status).toBe(303);
    const setup = await verifiedSetup(h, user.authority.email);
    const pending = await begin(h, setup.cookie);
    expect(pending.status).toBe(302);
    expect(h.state.authRequests.at(-1).loginHint).toBe(user.authority.email);
    expect((await setup.post('state').send({ action: 'leave' })).status).toBe(200);
    const before = savedEvidence(h);
    const rejected = await callback(h, pending);
    expect(rejected.status).toBe(401);
    expect(rejected.headers['set-cookie']).toEqual([expect.stringMatching(/^__Host-nofries-customer-tx=;.*Max-Age=0/)]);
    // A callback never falls back from its abandoned signup proof to old proof.
    expect((await callback(h, pending)).status).toBeGreaterThanOrEqual(400);
    const retried = await h.login(user, { bootstrap: false, setupCookie: setup.cookie });
    expect(retried.response.status).toBe(303);
    expect(savedEvidence(h)).toEqual(before);
});

test.each(['missing proof', 'foreign subject', 'wrong email', 'wrong invitation', 'revoked authority', 'missing MFA', 'disabled MFA policy'])
('detached setup never substitutes for returning login with %s', async defect => {
    const h = customerProductionHarness({ organisationSetup: true, now: Date.now() });
    const user = h.addUser({ email: 'returning@example.test' });
    if (defect !== 'missing proof') expect((await h.login(user)).response.status).toBe(303);
    const setup = await verifiedSetup(h, user.authority.email);
    expect((await setup.post('state').send({ action: 'leave' })).status).toBe(200);
    const records = h.getContainer('nofries-browser-auth').records;
    const proofKey = [...records.keys()].find(key => key.startsWith('customer-email-proofs/'));
    if (['foreign subject', 'wrong email', 'wrong invitation'].includes(defect)) {
        const proof = JSON.parse(records.get(proofKey));
        if (defect === 'foreign subject') proof.subjectKey = uid(1) + ':' + uid(89);
        if (defect === 'wrong email') proof.email = 'someone-else@example.test';
        if (defect === 'wrong invitation') proof.invitationDigest = '0'.repeat(64);
        records.set(proofKey, Buffer.from(JSON.stringify(proof)));
    }
    if (defect === 'revoked authority') { user.authority.status = 'revoked'; user.save(); }
    if (defect === 'missing MFA') h.state.acrs = [];
    if (defect === 'disabled MFA policy') h.state.policyEnabled = false;
    const before = savedEvidence(h);
    const denied = await h.login(user, { bootstrap: false, setupCookie: setup.cookie });
    expect(denied.response.status).toBe(401);
    expect(denied.response.headers['set-cookie']).toEqual([expect.stringMatching(/^__Host-nofries-customer-tx=;.*Max-Age=0/)]);
    expect(savedEvidence(h)).toEqual(before);
});

test('a mismatching invitation cookie remains binding after detachment despite valid durable returning proof', async () => {
    const h = customerProductionHarness({ organisationSetup: true, now: Date.now() });
    const user = h.addUser({ email: 'returning@example.test' });
    expect((await h.login(user)).response.status).toBe(303);
    const other = h.addUser({ oid: uid(81), email: 'other@example.test', organisationId: 'other' });
    const setup = await verifiedSetup(h, user.authority.email);
    expect((await setup.post('state').send({ action: 'leave' })).status).toBe(200);
    const before = savedEvidence(h);
    const denied = await h.login(user, { bootstrap: false, setupCookie: setup.cookie + '; __Host-nofries-signup=' + other.invitationToken });
    expect(denied.response.status).toBe(401);
    expect(savedEvidence(h)).toEqual(before);
});

test('repeating leave for an older setup preserves a newer verified setup and its login binding', async () => {
    const h = customerProductionHarness({ organisationSetup: true, now: Date.now() });
    const user = h.addUser({ email: 'returning@example.test' });
    expect((await h.login(user)).response.status).toBe(303);
    const old = await verifiedSetup(h, 'abandoned@example.test');
    expect((await old.post('state').send({ action: 'leave' })).status).toBe(200);
    const current = await verifiedSetup(h, user.authority.email);
    const before = savedEvidence(h);
    const repeated = await old.post('state').send({ action: 'leave' });
    expect(repeated.status).toBe(200); expect(repeated.headers['set-cookie']).toBeUndefined();
    expect((await request(h.app).get('/api/organisation-setup/state').set('Cookie', current.cookie)).body.state).toBe('verified');
    const login = await h.login(user, { bootstrap: false, setupCookie: current.cookie });
    expect(login.response.status).toBe(303);
    expect(h.state.authRequests.at(-1).loginHint).toBe(user.authority.email);
    expect(savedEvidence(h)).toEqual(before);
});
