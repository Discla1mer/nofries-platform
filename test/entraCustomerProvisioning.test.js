'use strict';
const { createEntraB2bInvitationService } = require('../api/shared/customerSignup/entraB2bInvitation');
const { uid } = require('./helpers/customerProductionHarness');

test('retained Graph provider delivers a mailbox capability to the exact new guest', async () => {
    const createInvitation = jest.fn(async () => ({ status: 'PendingAcceptance', invitedUser: { id: uid(3), mail: 'customer@example.test', userType: 'Guest' } }));
    const token = Buffer.alloc(32, 7).toString('base64url');
    const provider = createEntraB2bInvitationService({ tenantId: uid(1), redirectUrl: 'https://nofries.example.test/signup',
        bootstrapToken: token, findGuestsByEmail: async () => [], createInvitation });
    const result = await provider.resolveOrInvite({ displayName: 'Synthetic Customer', email: 'customer@example.test' });
    expect(createInvitation).toHaveBeenCalledWith({ invitedUserEmailAddress: 'customer@example.test', invitedUserDisplayName: 'Synthetic Customer',
        inviteRedirectUrl: 'https://nofries.example.test/signup#invitation=' + token, sendInvitationMessage: true });
    expect(result.subjectKey).toBe(`${uid(1)}:${uid(3)}`);
    expect(JSON.stringify(result)).not.toContain(token);
});
test('existing guest must receive the capability and Graph may not substitute another immutable guest', async () => {
    const invited = { id: uid(3), mail: 'customer@example.test', userType: 'Guest' };
    const createInvitation = jest.fn(async () => ({ status: 'PendingAcceptance', invitedUser: { ...invited, id: uid(4) } }));
    const provider = createEntraB2bInvitationService({ tenantId: uid(1), redirectUrl: 'https://nofries.example.test/signup',
        bootstrapToken: Buffer.alloc(32, 7).toString('base64url'), findGuestsByEmail: async () => [invited], createInvitation });
    await expect(provider.resolveOrInvite({ displayName: 'Synthetic', email: invited.mail })).rejects.toThrow('signup_provider_response_invalid');
    expect(createInvitation).toHaveBeenCalledTimes(1);
});

const { provisionCustomerInvitation } = require('../api/shared/customerSignup/provisionCustomerInvitation');
const { subjectHash, scheduleArchiveKey, termsOfferKey } = require('../api/shared/customerSignup/customerAuthority');
const { AzureBlobSignupInvitationStore } = require('../api/shared/customerSignup/azureBlobInvitationStore');
const { customerProductionHarness } = require('./helpers/customerProductionHarness');

// Load genuine server module setup before the timed journey; each harness still
// creates its own configured application inside the unchanged test deadline.
require('../server');

test('replacement invitation updates the reviewed subject revision and lost finalization can resume without resending', async () => {
    // Temporary opt-in synthetic checkpoints. Only fixed labels and monotonic
    // elapsed milliseconds are emitted; never print arguments or exceptions.
    const started = process.env.NOFRIES_TEST_TIMING_DIAGNOSTICS === '1' ? process.hrtime.bigint() : null;
    const allowed = new Set(['harness_start', 'original_login_start', 'original_login_done',
        'original_consent_start', 'original_consent_done', 'first_provision_start', 'first_provision_done',
        'retry_provision_start', 'retry_provision_done', 'replay_provision_start', 'replay_provision_done',
        'replacement_login_start', 'replacement_login_done', 'waiting_state_start', 'waiting_state_done',
        'replacement_consent_start', 'replacement_consent_done', 'resumed_state_start', 'resumed_state_done']);
    let emitted = 0;
    const mark = label => {
        if (started === null || emitted >= 256) return;
        if (!allowed.has(label)) throw new Error('unexpected synthetic timing label');
        const safeLabel = emitted === 255 ? 'trace_limit' : label;
        emitted++;
        process.stderr.write(`SYNTHETIC_INVITATION_TIMING ${safeLabel} ${Number((process.hrtime.bigint() - started) / 1000000n)}ms\n`);
    };
    mark('harness_start');
    const h = customerProductionHarness(), existing = h.addUser();
    mark('original_login_start');
    const originalLogin = await h.login(existing);
    mark('original_login_done');
    mark('original_consent_start');
    expect((await h.consent(originalLogin.cookie)).response.status).toBe(200);
    mark('original_consent_done');
    const authorityContainer = h.getContainer('customer-authority');
    const base = authorityContainer.getBlockBlobClient.bind(authorityContainer);
    let loseFinalization = true;
    authorityContainer.getBlockBlobClient = key => {
        const blob = base(key);
        return { ...blob, async uploadData(bytes, options) {
            if (loseFinalization && key === `customer-subjects/${subjectHash(existing.authority.subjectKey)}.json`) {
                loseFinalization = false; throw new Error('synthetic lost finalization');
            }
            return blob.uploadData(bytes, options);
        } };
    };
    const guest = { id: uid(3), mail: existing.authority.email, userType: 'Guest' };
    const graph = { findGuestsByEmail: jest.fn(async () => [guest]),
        createInvitation: jest.fn(async () => ({ status: 'PendingAcceptance', invitedUser: guest })) };
    const scheduleId = 'synthetic-schedule-second-org';
    const scheduleText = 'Synthetic schedule for second-org. Not a customer agreement.';
    const scheduleDigest = require('node:crypto').createHash('sha256').update(scheduleText).digest('hex');
    authorityContainer.records.set(scheduleArchiveKey(scheduleId, scheduleDigest), Buffer.from(JSON.stringify({
        schemaVersion: 1, scheduleId, scheduleText, scheduleDigest })));
    authorityContainer.records.set(termsOfferKey('second-tenant', 'second-org'), Buffer.from(JSON.stringify({ schemaVersion: 1,
        status: 'active', tenantId: 'second-tenant', organisationId: 'second-org', scheduleId, scheduleDigest,
        termsVersion: h.termsVersion, termsDigest: h.termsDigest,
        effectiveAt: h.state.now - 1000, expiresAt: h.state.now + 86400000 })));
    const input = { requestId: uid(40), expectedAuthorityRevision: 0,
        approval: { email: guest.mail, displayName: 'Synthetic', tenantId: 'second-tenant', organisationId: 'second-org',
            termsVersion: h.termsVersion, termsDigest: h.termsDigest,
            scheduleId, scheduleDigest,
            expiresAt: h.state.now + 3600000, authorityExpiresAt: h.state.now + 86400000 },
        identityTenantId: uid(1), identityPolicyId: 'customer-policy', publicOrigin: h.env.NOFRIES_PUBLIC_URL,
        graph, invitations: new AzureBlobSignupInvitationStore({ containerClient: h.getContainer('nofries-browser-auth') }),
        authorityContainer, now: () => h.state.now };
    mark('first_provision_start');
    await expect(provisionCustomerInvitation(input)).rejects.toThrow();
    mark('first_provision_done');
    mark('retry_provision_start');
    const result = await provisionCustomerInvitation(input);
    mark('retry_provision_done');
    expect(result.subjectKey).toBe(existing.authority.subjectKey);
    expect(graph.createInvitation).toHaveBeenCalledTimes(1);
    const stored = JSON.parse(authorityContainer.records.get(`customer-subjects/${subjectHash(result.subjectKey)}.json`));
    const deliveredToken = new URL(graph.createInvitation.mock.calls[0][0].inviteRedirectUrl).hash.slice('#invitation='.length);
    expect(stored).not.toHaveProperty('invitationToken');
    for (const bytes of authorityContainer.records.values()) expect(bytes.toString()).not.toContain(deliveredToken);
    expect(stored.revision).toBe(1); expect(stored.organisationId).toBe('second-org');
    mark('replay_provision_start');
    expect(await provisionCustomerInvitation(input)).toEqual(result);
    mark('replay_provision_done');
    expect(graph.createInvitation).toHaveBeenCalledTimes(1);
    const replacement = { invitationToken: deliveredToken, authority: stored };
    mark('replacement_login_start');
    const login = await h.login(replacement); expect(login.response.status).toBe(303);
    mark('replacement_login_done');
    mark('waiting_state_start');
    const waiting = await require('supertest')(h.app).get('/api/customer-signup/state').set('Cookie', login.cookie);
    mark('waiting_state_done');
    expect(waiting.body.state).toEqual({ status: 'pending_preparation' });
    expect(waiting.body.csrfToken).toBeUndefined();
    expect(h.pool.receipts.size).toBe(1);
    // Invitation replacement does not prepare its new canonical organisation.
    // Represent that separately approved preparation in this SQL-only fixture.
    h.prepareUser(replacement);
    mark('replacement_consent_start');
    const replacementConsent = await h.consent(login.cookie);
    mark('replacement_consent_done');
    expect(replacementConsent.before.body.state).toEqual(expect.objectContaining({ status: 'terms',
        scheduleId, scheduleDigest }));
    expect(replacementConsent.response.body).toEqual({ state: { status: 'pending_admission' } });
    const { tokenDigest } = require('../api/shared/customerSignup/invitationAcceptance');
    h.getContainer('nofries-browser-auth').records.delete(`browser-auth/customer-signup/invitations/${tokenDigest(deliveredToken)}.json`);
    mark('resumed_state_start');
    const resumed = await require('supertest')(h.app).get('/api/customer-signup/state').set('Cookie', login.cookie);
    mark('resumed_state_done');
    expect(resumed.body.state.status).toBe('pending_admission');
    expect(h.pool.receipts.size).toBe(2);

}, 20000); // Full synthetic multi-request journey; production deadlines are unchanged.

test('an already redeemed exact guest can receive a capability without resetting redemption', async () => {
    const existing = { id: uid(3), mail: 'customer@example.test', userType: 'Guest' };
    const send = jest.fn(async () => ({ status: 'Completed', invitedUser: existing }));
    const provider = createEntraB2bInvitationService({ tenantId: uid(1), redirectUrl: 'https://nofries.example.test/signup',
        bootstrapToken: Buffer.alloc(32, 7).toString('base64url'), findGuestsByEmail: async () => [existing], createInvitation: send });
    expect((await provider.resolveOrInvite({ displayName: 'Synthetic', email: existing.mail })).subjectKey).toBe(`${uid(1)}:${uid(3)}`);
    expect(send.mock.calls[0][0].sendInvitationMessage).toBe(true);
    expect(send.mock.calls[0][0]).not.toHaveProperty('resetRedemption');
});
