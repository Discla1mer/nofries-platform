'use strict';

const { createEntraCustomerGraph } = require('../api/shared/customerSignup/entraCustomerGraph');
const { createEntraB2bInvitationService } = require('../api/shared/customerSignup/entraB2bInvitation');
const { provisionCustomerInvitation } = require('../api/shared/customerSignup/provisionCustomerInvitation');
const { createStarterInvitationEmail } = require('../lib/starterInvitationEmail');
const { AzureBlobSignupInvitationStore } = require('../api/shared/customerSignup/azureBlobInvitationStore');
const { subjectHash } = require('../api/shared/customerSignup/customerAuthority');
const { customerProductionHarness, uid } = require('./helpers/customerProductionHarness');

const email = 'synthetic@example.test';
const member = { id: uid(3), mail: email, userType: 'Member' };
const token = Buffer.alloc(32, 9).toString('base64url');
const directoryUser = () => ({ ...member, mail: null, userPrincipalName: 'synthetic@resource.example.test',
    otherMails: [email], proxyAddresses: [], accountEnabled: true });
function graphFor(payload) {
    const fetch = jest.fn(async () => new Response(JSON.stringify(payload)));
    return { fetch, graph: createEntraCustomerGraph({ credential: { getToken: async () => ({ token: 'synthetic' }) },
        policyId: uid(8), fetch }) };
}

test.each(['mail', 'userPrincipalName', 'otherMails', 'proxyAddresses'])('existing user lookup binds an exact %s mailbox to an immutable enabled identity', async field => {
    const user = { ...directoryUser(), otherMails: [] };
    user[field] = field === 'otherMails' ? [email.toUpperCase()] : field === 'proxyAddresses' ? ['SMTP:' + email] : email;
    const h = graphFor({ value: [user] });
    expect(await h.graph.findUsersByEmail(email)).toEqual([member]);
    const url = new URL(h.fetch.mock.calls[0][0]);
    expect(url.origin).toBe('https://graph.microsoft.com');
    expect(url.searchParams.get('$top')).toBe('2');
    expect(url.searchParams.get('$filter')).toContain('otherMails/any(');
});
test.each([
    { value: [directoryUser(), { ...directoryUser(), id: uid(4) }] },
    { value: [directoryUser()], '@odata.nextLink': 'https://graph.microsoft.com/next' },
    { value: [{ ...directoryUser(), accountEnabled: false }] },
    { value: [{ ...directoryUser(), accountEnabled: undefined }] },
    { value: [{ ...directoryUser(), otherMails: [] }] },
    { value: [{ ...directoryUser(), userType: 'Unknown' }] },
    { value: [{ ...directoryUser(), proxyAddresses: null }] }
])('ambiguous, disabled or unbound directory identity fails closed %#', async payload => {
    await expect(graphFor(payload).graph.findUsersByEmail(email)).rejects.toThrow('customer_graph_unavailable');
});
test('mailbox filter escapes apostrophes and only returns exact requested aliases', async () => {
    const h = graphFor({ value: [] });
    await h.graph.findUsersByEmail("o'brien@example.test");
    expect(new URL(h.fetch.mock.calls[0][0]).searchParams.get('$filter')).toContain("mail eq 'o''brien@example.test'");
});

function providerFixture(overrides = {}) {
    const createInvitation = jest.fn(), sendMemberInvitation = jest.fn(async () => {});
    const options = { tenantId: uid(1), redirectUrl: 'https://nofries.example.test/signup', bootstrapToken: token,
        findGuestsByEmail: async () => [member], createInvitation, sendMemberInvitation, ...overrides };
    return { ...options, provider: createEntraB2bInvitationService(options) };
}
test('member receives the mailbox capability without any Graph guest invitation', async () => {
    const h = providerFixture();
    const result = await h.provider.resolveOrInvite({ email, displayName: 'Synthetic' });
    expect(result).toMatchObject({ status: 'existing_member', subjectKey: `${uid(1)}:${uid(3)}`, email });
    expect(h.createInvitation).not.toHaveBeenCalled();
    expect(h.sendMemberInvitation).toHaveBeenCalledWith({ email, displayName: 'Synthetic',
        redirectUrl: 'https://nofries.example.test/signup#invitation=' + token });
    expect(JSON.stringify(result)).not.toContain(token);
});
test('legacy service does not admit a member unless member delivery is explicitly configured', async () => {
    const h = providerFixture();
    const { sendMemberInvitation, provider, ...legacy } = h;
    await expect(createEntraB2bInvitationService(legacy).resolveOrInvite({ email, displayName: 'Synthetic' })).rejects.toThrow();
    expect(sendMemberInvitation).not.toHaveBeenCalled();
});
test('member email substitution is rejected before either delivery channel', async () => {
    const h = providerFixture({ findGuestsByEmail: async () => [{ ...member, mail: 'other@example.test' }] });
    await expect(h.provider.resolveOrInvite({ email, displayName: 'Synthetic' })).rejects.toThrow();
    expect(h.sendMemberInvitation).not.toHaveBeenCalled(); expect(h.createInvitation).not.toHaveBeenCalled();
});

function provisionFixture() {
    const h = customerProductionHarness(), authorityContainer = h.getContainer('starter-authority');
    const sendMemberInvitation = jest.fn(async () => {});
    const input = { requestId: uid(40), identityTenantId: uid(1), identityPolicyId: 'customer-policy',
        publicOrigin: h.env.NOFRIES_PUBLIC_URL, authorityContainer, now: () => h.state.now,
        invitations: new AzureBlobSignupInvitationStore({ containerClient: h.getContainer('nofries-browser-auth') }),
        graph: { findUsersByEmail: jest.fn(async () => [member]), createInvitation: jest.fn() }, sendMemberInvitation,
        approval: { email, displayName: 'Synthetic', tenantId: 'synthetic-tenant', organisationId: 'synthetic-org',
            termsVersion: h.termsVersion, termsDigest: h.termsDigest, scheduleId: 'synthetic-schedule', scheduleDigest: 'a'.repeat(64),
            expiresAt: h.state.now + 3600000, authorityExpiresAt: h.state.now + 86400000 } };
    return { h, input, authorityContainer, sendMemberInvitation };
}
test('acknowledged member delivery finalizes once, retains immutable subject, and permits only that subject to sign in', async () => {
    const { h, input, authorityContainer, sendMemberInvitation } = provisionFixture();
    const first = await provisionCustomerInvitation(input);
    expect(await provisionCustomerInvitation(input)).toEqual(first);
    expect(sendMemberInvitation).toHaveBeenCalledTimes(1); expect(input.graph.createInvitation).not.toHaveBeenCalled();
    const deliveredToken = new URL(sendMemberInvitation.mock.calls[0][0].redirectUrl).hash.slice('#invitation='.length);
    for (const bytes of authorityContainer.records.values()) expect(bytes.toString()).not.toContain(deliveredToken);
    const record = JSON.parse(authorityContainer.records.get(`customer-subjects/${subjectHash(first.subjectKey)}.json`));
    expect(record.bindingId).toBeNull();
    // Exercise the unchanged real customer-policy/MSAL callback composition.
    h.getContainer('customer-authority').records.set(`customer-subjects/${subjectHash(first.subjectKey)}.json`, Buffer.from(JSON.stringify(record)));
    const user = { authority: record, invitationToken: deliveredToken };
    expect((await h.login(user)).response.status).toBe(303);
    expect((await h.login({ ...user, authority: { ...record, subjectKey: `${uid(1)}:${uid(4)}` } })).response.status).not.toBe(303);
    h.state.acrs = [];
    expect((await h.login(user)).response.status).not.toBe(303);
    expect(h.pool.receipts.size).toBe(0);
});
test('uncertain member mail delivery cannot resend or publish authority on retry', async () => {
    const { input, authorityContainer, sendMemberInvitation } = provisionFixture();
    sendMemberInvitation.mockRejectedValue(new Error('synthetic transport failure'));
    await expect(provisionCustomerInvitation(input)).rejects.toThrow();
    await expect(provisionCustomerInvitation(input)).rejects.toThrow('signup_invitation_reconciliation_required');
    expect(sendMemberInvitation).toHaveBeenCalledTimes(1);
    expect([...authorityContainer.records.keys()].some(k => k.startsWith('customer-subjects/'))).toBe(false);
});
test('member delivery cannot overwrite an existing or foreign authority', async () => {
    const { input, sendMemberInvitation } = provisionFixture(); input.readOtherAuthority = async () => ({ status: 'active' });
    await expect(provisionCustomerInvitation(input)).rejects.toThrow(); expect(sendMemberInvitation).not.toHaveBeenCalled();
});
test('lost member authority finalization can resume without resending', async () => {
    const { input, authorityContainer, sendMemberInvitation } = provisionFixture();
    const original = authorityContainer.getBlockBlobClient.bind(authorityContainer); let failOnce = true;
    authorityContainer.getBlockBlobClient = key => { const blob = original(key); return { ...blob, async uploadData(bytes, options) {
        if (failOnce && key.startsWith('customer-subjects/')) { failOnce = false; throw new Error('synthetic failure'); }
        return blob.uploadData(bytes, options);
    } }; };
    await expect(provisionCustomerInvitation(input)).rejects.toThrow();
    expect((await provisionCustomerInvitation(input)).status).toBe('pending_admission');
    expect(sendMemberInvitation).toHaveBeenCalledTimes(1);
});
test('member continuation mail uses the existing fixed provider, sender, recipient and fragment token', async () => {
    const fetch = jest.fn(async () => new Response('{}'));
    const send = createStarterInvitationEmail({ env: { RESEND_API_KEY: 'synthetic', NOFRIES_SCOPE_EMAIL_FROM: 'synthetic@nofries.example.test',
        NOFRIES_PUBLIC_URL: 'https://nofries.nz' }, fetch });
    await send({ email, redirectUrl: 'https://nofries.nz/signup#invitation=' + token });
    expect(fetch.mock.calls[0][0]).toBe('https://api.resend.com/emails');
    const options = fetch.mock.calls[0][1], body = JSON.parse(options.body);
    expect(options.redirect).toBe('error'); expect(body.to).toEqual([email]);
    expect(body.text).toContain('https://nofries.nz/signup#invitation=' + token);
    await expect(send({ email, redirectUrl: 'https://foreign.example.test/signup#invitation=' + token })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockResolvedValue(new Response('{}', { status: 503 }));
    await expect(send({ email, redirectUrl: 'https://nofries.nz/signup#invitation=' + token })).rejects.toThrow('setup_delivery_unconfirmed');
});

test('production setup can leave an uncertain invitation and verify another email without changing the saved attempt', async () => {
    const request = require('supertest'), h = customerProductionHarness({ starter: true });
    h.state.directoryUsers = [{ ...directoryUser(), id: h.state.oid }]; h.state.failMemberDelivery = true;
    const post = (path, cookie, body, setupRequestId) => {
        const pending = h.sameOrigin(request(h.app).post('/api/organisation-setup/' + path)).set('Cookie', cookie || '');
        if (setupRequestId) pending.set('X-NoFries-Setup-Request', setupRequestId);
        return pending.send(body);
    };
    const start = await post('request', '', { organisationName: 'Synthetic Consultancy', email, accountType: 'consultant' });
    expect(start.status).toBe(202);
    const cookie = start.headers['set-cookie'][0].split(';')[0], code = h.state.delivered[0].text.match(/\b\d{8}\b/)[0];
    const verified = await post('verify', cookie, { code }, start.body.requestId);
    expect(verified.body.nextStep).toBe('details_required');
    const details = { name: 'Synthetic', role: 'Owner', address: 'Synthetic', registrationId: '', authorityConfirmed: true };
    expect((await post('details', cookie, details, verified.body.requestId)).status).toBe(503);
    const state = await request(h.app).get('/api/organisation-setup/state').set('Cookie', cookie);
    expect(state.status).toBe(200);
    expect(state.body).toMatchObject({ state: 'verified', nextStep: 'setup_review_required', accessGranted: false });
    expect((await post('details', cookie, details, verified.body.requestId)).status).toBe(503);
    expect(h.state.delivered.filter(d => d.kind === 'member_invitation')).toHaveLength(1);

    // Capture the real production-composition stores, including representative
    // details, account reservation, delivery lease and code-delivery budgets.
    const snapshot = () => [...h.state.containers].map(([name, container]) =>
        [name, [...container.records].filter(([key]) => !key.includes('/detached/')).map(([key, bytes]) => [key, bytes.toString('base64')])]);
    const before = snapshot(), sentBefore = h.state.delivered.length;
    const left = await post('state', cookie, { action: 'leave' }, verified.body.requestId);
    expect(left.status).toBe(200); expect(left.body).toEqual({ state: 'start' });
    expect(left.headers['set-cookie']).toBeUndefined();
    expect(snapshot()).toEqual(before); expect(h.state.delivered).toHaveLength(sentBefore);
    expect((await request(h.app).get('/api/organisation-setup/state')).body).toEqual({ state: 'start' });
    expect((await post('details', '', details)).body.code).toBe('setup_session_required');
    expect((await post('details', cookie, details, verified.body.requestId)).body.code).toBe('setup_expired');
    const detached = [...h.state.containers.values()].flatMap(container => [...container.records].filter(([key]) => key.includes('/detached/')));
    expect(detached).toHaveLength(1);
    expect(Object.keys(JSON.parse(detached[0][1].toString())).sort()).toEqual(['expiresAt', 'schemaVersion']);

    const next = await post('request', '', { organisationName: 'Different Consultancy', email: 'different@example.test', accountType: 'consultant' });
    expect(next.status).toBe(202); expect(next.body.state).toBe('awaiting_code');
    const nextCookie = next.headers['set-cookie'][0].split(';')[0];
    expect(nextCookie).not.toBe(cookie);
    const staleLeave = await post('state', nextCookie, { action: 'leave' }, verified.body.requestId);
    expect(staleLeave.status).toBe(409); expect(staleLeave.headers['set-cookie']).toBeUndefined();
    expect((await post('details', nextCookie, details)).body.code).toBe('setup_verification_required');
    const nextCode = h.state.delivered.at(-1).text.match(/\b\d{8}\b/)[0];
    const beforeStaleCode = snapshot();
    expect((await post('verify', nextCookie, { code }, verified.body.requestId)).body.code).toBe('setup_changed');
    expect((await post('verify', nextCookie, { code: nextCode })).body.code).toBe('setup_changed');
    expect(snapshot()).toEqual(beforeStaleCode);
    // The Graph SDK fixture returns this query's results, not its directory:
    // the second mailbox has no matching immutable directory object yet.
    h.state.directoryUsers = [];
    expect((await post('verify', nextCookie, { code: nextCode }, next.body.requestId)).body).toMatchObject({
        state: 'verified', organisationName: 'Different Consultancy', accountType: 'consultant', nextStep: 'details_required', accessGranted: false
    });
    const beforeStaleDetails = snapshot();
    expect((await post('details', nextCookie, details, verified.body.requestId)).body.code).toBe('setup_changed');
    expect((await post('details', nextCookie, details)).body.code).toBe('setup_changed');
    expect(snapshot()).toEqual(beforeStaleDetails);
    expect((await request(h.app).get('/api/organisation-setup/state').set('Cookie', cookie)).body).toEqual({ state: 'start' });
    for (const [containerName, records] of before) for (const [key, bytes] of records) {
        if (!key.includes('/budget/')) expect(h.state.containers.get(containerName).records.get(key).toString('base64')).toBe(bytes);
    }
    expect(h.state.delivered.filter(d => d.kind === 'member_invitation')).toHaveLength(1);
    expect(h.pool.registrations.size).toBe(0); expect(h.pool.receipts.size).toBe(0);
});
