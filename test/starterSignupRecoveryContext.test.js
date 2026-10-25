'use strict';

const request = require('supertest');
const { compileStarterProvisioning } = require('../api/shared/customerSignup/starterProvisioning');
const { copy, hash } = require('../api/shared/appLifecycle/dashboardRuntimeRecords');
const { accountWindow } = require('../api/shared/customerSignup/customerStarterPlan');
const { MAX_PROOF_AGE } = require('../api/shared/customerSignup/invitationAcceptance');
let mockComposed;
// Observe the genuine composed port without replacing any behaviour. The
// fixture below substitutes only Blob, Graph, email and SQL transport.
jest.mock('../lib/starterSignupProduction', () => {
    const actual = jest.requireActual('../lib/starterSignupProduction');
    return { ...actual, createStarterSignupProduction(options) {
        const instance = actual.createStarterSignupProduction(options);
        mockComposed = { instance, options }; return instance;
    } };
});
const { customerProductionHarness } = require('./helpers/customerProductionHarness');
const clone = value => JSON.parse(JSON.stringify(value));
const entries = container => [...container.records].map(([key, bytes]) => [key, bytes.toString('base64')]);
let warning;
beforeEach(() => { warning = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => warning.mockRestore());

async function fixture() {
    const h = customerProductionHarness({ starter: true, now: Date.now() });
    const email = 'saved-consultant@example.invalid';
    h.state.directoryUsers = [{ id: h.state.oid, mail: email, userPrincipalName: email,
        otherMails: [], proxyAddresses: [], userType: 'Member', accountEnabled: true }];
    const start = await h.sameOrigin(request(h.app).post('/api/organisation-setup/request'))
        .send({ email, accountType: 'consultant', organisationName: 'Saved consultant workspace' });
    expect(start.status).toBe(202);
    const setupCookie = start.headers['set-cookie'][0].split(';')[0];
    const post = action => h.sameOrigin(request(h.app).post('/api/organisation-setup/' + action))
        .set('Cookie', setupCookie).set('X-NoFries-Setup-Request', start.body.requestId);
    expect((await post('verify').send({ code: h.state.delivered[0].text.match(/\b[0-9]{8}\b/)[0] })).status).toBe(200);
    // Retain the real source-created account, delivery attempt, declaration and
    // identity authority. This transport fixture cannot execute provisioning.
    expect((await post('details').send({ name: 'Saved representative', role: 'Owner',
        address: 'Synthetic address', registrationId: '', authorityConfirmed: true })).status).toBe(503);
    const container = h.getContainer('starter-authority');
    const read = prefix => {
        const entry = [...container.records].find(([key]) => key.startsWith(prefix));
        if (!entry) throw new Error('Missing synthetic record: ' + prefix);
        return { key: entry[0], value: JSON.parse(entry[1]) };
    };
    const authority = read('customer-subjects/'), account = read('customer-starter/starter-accounts/');
    const context = read('customer-starter/contexts/'), attempt = read('customer-invitation-attempts/');
    const invitation = attempt.value.record;
    const user = { authority: authority.value,
        invitationToken: h.state.delivered.find(value => value.kind === 'member_invitation').text
            .match(/#invitation=([A-Za-z0-9_-]{43})/)[1] };
    const login = await h.login(user); expect(login.response.status).toBe(303);
    h.getContainer('nofries-browser-auth').records.delete(
        `browser-auth/customer-signup/invitations/${invitation.tokenDigest}.json`);
    const preparation = compileStarterProvisioning({ account: account.value,
        requestId: account.value.organisations[0].requestId, source: context.value.source });
    const state = { rows: [{ preparation, activation: null }], queries: 0, beforeScopeRead: null };
    const connect = h.pool.connect;
    h.pool.connect = async () => {
        const client = await connect();
        return { ...client, async query(sql, params) {
            if (sql.startsWith('SELECT preparation,activation FROM nofries.dashboard_starter_scopes')) {
                state.queries++;
                if (state.beforeScopeRead) state.beforeScopeRead(state.queries);
                return { rows: clone(state.rows), rowCount: state.rows.length };
            }
            return client.query(sql, params);
        } };
    };
    const req = { headers: { cookie: login.cookie } }, composed = mockComposed;
    const change = (entry, alter) => { alter(entry.value); container.records.set(entry.key, Buffer.from(JSON.stringify(entry.value))); };
    return { h, container, authority, account, context, attempt, invitation, preparation, state, req, composed, change, user,
        read: () => composed.instance.readRecoveryContext(req, authority.value) };
}

test('client proof can expire while its actual customer session remains valid; unknown-context reauthentication creates fresh proof without changing saved authority', async () => {
    const f = await fixture(), clients = f.composed.instance.clientOperations({ verifyIdentity: async () => { throw new Error('must not verify'); } });
    const original = await f.composed.options.readCustomer(f.req.headers.cookie);
    // This fixture intentionally has no native SQL activation. The fresh client
    // read retains that existing denial; it never manufactures admission.
    await expect(clients.list(f.req)).rejects.toThrow('starter_signup_unavailable');
    const durable = () => [...f.h.state.containers].filter(([name]) => !name.endsWith('/nofries-browser-auth') && !name.endsWith('/dashboard-proofs'))
        .map(([name, container]) => [name, entries(container)]);
    const before = durable();
    const proofs = f.h.getContainer('dashboard-proofs'), originalProofs = entries(proofs);
    const originalAuthentication = f.h.state.authRequests.at(-1);
    f.h.state.clockOffset = MAX_PROOF_AGE + 1000;
    const expiredProof = await f.composed.options.readCustomer(f.req.headers.cookie);
    expect(expiredProof.id).toBe(original.id);
    expect(Date.parse(expiredProof.details.expiresAt)).toBeGreaterThan(Date.parse(f.composed.options.dashboard.clock()));
    await expect(clients.list(f.req)).rejects.toThrow('starter_reauthentication_required');
    const entry = await request(f.h.app).get('/login?reauthenticate=1').set('Cookie', f.req.headers.cookie);
    expect(entry.status).toBe(303); expect(entry.headers.location).toBe('/api/customer-auth/login');
    expect(entry.headers['set-cookie']).toBeUndefined();
    const fresh = await f.h.login(f.user, { bootstrap: false });
    expect(fresh.response.status).toBe(303);
    const freshAuthentication = f.h.state.authRequests.at(-1);
    expect(freshAuthentication.state).not.toBe(originalAuthentication.state);
    expect(freshAuthentication.nonce).not.toBe(originalAuthentication.nonce);
    const refreshed = await f.composed.options.readCustomer(fresh.cookie);
    expect(refreshed.id).not.toBe(original.id);
    expect(refreshed.assurance.verifiedAt - original.assurance.verifiedAt).toBeGreaterThan(MAX_PROOF_AGE);
    expect(Date.parse(f.composed.options.dashboard.clock()) - refreshed.assurance.verifiedAt).toBeLessThanOrEqual(MAX_PROOF_AGE);
    await expect(clients.list({ headers: { cookie: fresh.cookie } })).rejects.toThrow('starter_signup_unavailable');
    expect(durable()).toEqual(before);
    expect(proofs.records.size).toBe(originalProofs.length + 1);
    for (const [key, bytes] of originalProofs) expect(proofs.records.get(key).toString('base64')).toBe(bytes);
    expect(f.h.pool.registrations.size).toBe(0); expect(f.h.pool.receipts.size).toBe(0);
});

test('missing own-slot invitation yields original retained evidence without recreating consent, data or trial clocks', async () => {
    const f = await fixture();
    const before = [...f.h.state.containers].map(([key, container]) => [key, entries(container)]);
    const context = await f.read();
    expect(context).toEqual({ accountId: f.account.value.accountId,
        preparationSha256: hash(f.preparation), invitation: f.invitation });
    // The recovery consent boundary applies the same strict plain-data copier;
    // an invitation validator clone from another realm must not break it.
    expect(copy(context, 65536)).toEqual(context);
    expect(f.state.queries).toBe(2);
    expect([...f.h.state.containers].map(([key, container]) => [key, entries(container)])).toEqual(before);
    expect(f.account.value.activation).toBeNull();
    expect(f.h.pool.receipts.size).toBe(0); expect(f.h.pool.registrations.size).toBe(0);
    expect(f.h.state.delivered).toHaveLength(2);
});

test('legacy authority has no starter recovery context', async () => {
    const f = await fixture();
    f.container.records.delete(f.authority.key);
    expect(await f.read()).toBeNull();
    expect(f.state.queries).toBe(0);
});

test.each([
    ['incomplete delivery', f => f.change(f.attempt, a => { a.phase = 'delivering'; })],
    ['changed provisioning intent', f => f.change(f.attempt, a => { a.intent = '0'.repeat(64); })],
    ['altered attempt authority', f => f.change(f.attempt, a => { a.entry.revision++; })],
    ['foreign result identity', f => f.change(f.attempt, a => { a.result.subjectKey = 'other'; })],
    ['foreign invitation', f => f.change(f.attempt, a => { a.record.invitationId = 'another-invitation'; })],
    ['wrong mailbox', f => f.change(f.attempt, a => { a.record.expectedEmail = 'other@example.invalid'; })],
    ['wrong identity policy', f => f.change(f.attempt, a => { a.record.identityPolicyId = 'different-policy'; })],
    ['missing MFA requirement', f => f.change(f.attempt, a => { a.record.mfaRequired = false; })],
    ['revoked archived invitation', f => f.change(f.attempt, a => { a.record.status = 'revoked'; })],
    ['changed retained declaration', f => f.change(f.context, c => { c.source.invitationId = 'another-invitation'; })],
    ['missing SQL preparation', f => { f.state.rows = []; }],
    ['activated SQL scope', f => { f.state.rows[0].activation = {}; }],
    ['different SQL preparation', f => { f.state.rows[0].preparation = { ...f.preparation, invitationId: 'other' }; }]
])('recovery evidence denies %s', async (_, change) => {
    const f = await fixture(); change(f);
    const before = entries(f.container);
    await expect(f.read()).rejects.toThrow();
    expect(entries(f.container)).toEqual(before);
    expect(f.h.pool.receipts.size).toBe(0); expect(f.h.pool.registrations.size).toBe(0);
});

test('an already activated account returns to ordinary durable continuation without changing its trial clock', async () => {
    const f = await fixture(), activatedAt = new Date().toISOString();
    f.change(f.account, a => {
        a.activation = { subjectKey: f.authority.value.subjectKey, receiptId: a.organisations[0].activationId,
            activatedAt, validUntil: accountWindow(activatedAt).validUntil };
    });
    const before = entries(f.container);
    expect(await f.read()).toBeNull();
    expect(entries(f.container)).toEqual(before);
    expect(f.state.queries).toBe(0);
});

test('recovery evidence rechecks original attempt after SQL I/O', async () => {
    const f = await fixture();
    f.state.beforeScopeRead = count => {
        if (count === 2) f.change(f.attempt, a => { a.record.status = 'revoked'; });
    };
    await expect(f.read()).rejects.toThrow();
    expect(f.state.queries).toBe(2);
});

test('recovery evidence rechecks live MFA after retained context reads', async () => {
    const f = await fixture();
    f.state.beforeScopeRead = count => { if (count === 2) f.h.state.policyEnabled = false; };
    await expect(f.read()).rejects.toThrow();
});

test('recovery evidence never extends the original invitation expiry', async () => {
    const f = await fixture();
    const expiredAt = f.invitation.createdAt + 1;
    f.change(f.attempt, a => { a.record.expiresAt = expiredAt; });
    await expect(f.read()).rejects.toThrow();
    expect(f.attempt.value.record.expiresAt).toBe(expiredAt);
});

test('client acceptance completion rejects caller-supplied terms, receipt and scope before reading or writing the selected scope', async () => {
    const f = await fixture(), clients = f.composed.instance.clientOperations({ verifyIdentity: async () => { throw new Error('must not verify'); } });
    const before = [...f.h.state.containers].map(([key, container]) => [key, entries(container)]);
    for (const field of ['terms', 'receipt', 'tenantId', 'organisationId', 'subjectKey']) {
        await expect(clients.execute(f.req, { action: 'resume_acceptance', requestId: f.account.value.organisations[0].requestId,
            [field]: 'caller-supplied' })).rejects.toThrow();
    }
    expect(f.state.queries).toBe(0);
    expect([...f.h.state.containers].map(([key, container]) => [key, entries(container)])).toEqual(before);
    expect(f.h.pool.receipts.size).toBe(0); expect(f.h.pool.registrations.size).toBe(0);
});
