'use strict';

const { Readable } = require('node:stream');
const { createHash } = require('node:crypto');
const { createOrganisationSetup, setupReferenceKey } = require('../api/shared/organisationSetup');
const { provisionVerifiedOrganisationSetup, readOrganisationSetupContinuation, key } = require('../api/shared/customerSignup/organisationSetupBinding');
const { termsOfferKey, scheduleArchiveKey, subjectHash } = require('../api/shared/customerSignup/customerAuthority');
const { createEntraCustomerGraph } = require('../api/shared/customerSignup/entraCustomerGraph');
const { createMfaPolicyGuard } = require('./helpers/mfaPolicyGuard');
const copy = value => JSON.parse(JSON.stringify(value));
const hash = text => createHash('sha256').update(text).digest('hex');
function livePolicyFixture() {
    const policy = { id: '1bf6dbaa-b7f2-4571-a490-e6117f72b284', displayName: 'No Fries - Customer signup MFA context', state: 'enabled',
        conditions: { users: { includeUsers: ['All'], excludeUsers: [], excludeGroups: [], excludeRoles: [] },
            applications: { includeApplications: [], includeUserActions: [], includeAuthenticationContextClassReferences: ['c1'], excludeApplications: [] },
            clientAppTypes: ['all'], signInRiskLevels: [], userRiskLevels: [], servicePrincipalRiskLevels: [] },
        grantControls: { operator: 'OR', builtInControls: ['mfa'] } };
    const fetch = jest.fn(async () => new Response(JSON.stringify(policy), { status: 200 }));
    const provider = createEntraCustomerGraph({ credential: { getToken: async () => ({ token: 'synthetic' }) }, policyId: policy.id, fetch });
    return { policy, fetch, guard: createMfaPolicyGuard(provider, 'c1') };
}
function fixture() {
    const transient = new Map(), durable = new Map(), invites = new Map(), clock = { at: 1790500000000 }, sent = [];
    const setupStore = {
        async load(name) { return transient.has(name) ? copy(transient.get(name)) : null; },
        async create(name, record) { if (transient.has(name)) return false; transient.set(name, { record: copy(record), version: 1 }); return true; },
        async replace(name, version, record) { if (transient.get(name)?.version !== version) return false;
            transient.set(name, { record: copy(record), version: version + 1 }); return true; }
    };
    let serial = 0;
    const authorityContainer = { getBlockBlobClient(name) { return {
        async download() {
            const found = durable.get(name); if (!found) throw { statusCode: 404, code: 'BlobNotFound' };
            const bytes = Buffer.from(JSON.stringify(found.record));
            return { etag: found.etag, contentLength: bytes.length, readableStreamBody: Readable.from([bytes]) };
        },
        async uploadData(bytes, options) {
            const found = durable.get(name), c = options.conditions;
            if (c.ifNoneMatch === '*' && found || c.ifMatch && c.ifMatch !== found?.etag) throw { statusCode: 412 };
            if (h.failSubject && name.startsWith('customer-subjects/')) throw new Error('subject unavailable');
            durable.set(name, { record: JSON.parse(bytes.toString()), etag: 'etag-' + (++serial) });
        },
        getBlobLeaseClient(id) { return { async acquireLease() { return { leaseId: id }; }, async releaseLease() {} }; }
    }; } };
    const graph = { findGuestsByEmail: jest.fn(async () => []), createInvitation: jest.fn(async body => ({ status: 'PendingAcceptance',
        invitedUser: { id: '11111111-2222-4333-8444-555555555555', mail: body.invitedUserEmailAddress, userType: 'Guest' } })) };
    const invitations = { async create(record) { if (invites.has(record.tokenDigest)) throw { code: 'signup_store_conflict' };
        invites.set(record.tokenDigest, copy(record)); }, async read(sha) { return invites.get(sha) || null; } };
    const context = { identityTenantId: '947787df-88fd-4417-b6b2-99c13d8410ba', identityPolicyId: 'approved-identity-policy', publicOrigin: 'https://nofries.nz' };
    const service = createOrganisationSetup({ store: setupStore, sendEmail: async message => sent.push(message),
        origin: context.publicOrigin, now: () => clock.at,
        readContinuation: record => readOrganisationSetupContinuation({ record, authorityContainer, now: () => clock.at }) });
    const call = (route, body, cookie, setupRequestId) => service.handle({ path: '/api/organisation-setup/' + route, method: body ? 'POST' : 'GET', body,
        headers: { origin: context.publicOrigin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...(cookie ? { cookie } : {}),
            ...(setupRequestId ? { 'x-nofries-setup-request': setupRequestId } : {}) }, clientKey: 'network' });
    const h = { transient, durable, invites, clock, graph, call, setupStore, authorityContainer, failSubject: false,
        async prepare(accountType = 'company') {
            const requested = await call('request', { email: 'owner@acme.example', organisationName: 'Acme',
                ...(accountType === undefined ? {} : { accountType }) });
            const cookie = requested.headers['Set-Cookie'].split(';')[0];
            const verified = await call('verify', { code: sent[0].code }, cookie, requested.body.requestId);
            const requestId = verified.body.requestId, termsText = 'Approved terms bytes.', scheduleText = 'Approved customer schedule bytes.';
            const approval = { schemaVersion: 1, requestId, ...(accountType === undefined ? {} : { accountType }), approvalId: '22222222-2222-4222-8222-222222222222',
                representativeAuthorityEvidenceId: 'approved-representative-reference', invitationApprovalEvidenceId: 'approved-invitation-reference',
                approvedAt: clock.at, organisationName: 'Acme', expectedAuthorityRevision: null, email: 'owner@acme.example',
                displayName: 'Approved Representative', tenantId: 'approved-tenant', organisationId: 'approved-organisation',
                termsVersion: 'approved-terms', termsDigest: hash(termsText), scheduleId: 'approved-schedule', scheduleDigest: hash(scheduleText),
                expiresAt: clock.at + 3 * 86400000, authorityExpiresAt: clock.at + 4 * 86400000 };
            const put = (name, record) => durable.set(name, { record, etag: 'seed-' + (++serial) });
            put('customer-terms/' + approval.termsDigest + '.json', { termsText, termsVersion: approval.termsVersion, termsDigest: approval.termsDigest });
            put(termsOfferKey(approval.tenantId, approval.organisationId), { schemaVersion: 1, status: 'active', tenantId: approval.tenantId,
                organisationId: approval.organisationId, scheduleId: approval.scheduleId, scheduleDigest: approval.scheduleDigest,
                termsVersion: approval.termsVersion, termsDigest: approval.termsDigest, effectiveAt: clock.at, expiresAt: approval.authorityExpiresAt });
            put(scheduleArchiveKey(approval.scheduleId, approval.scheduleDigest), { schemaVersion: 1, scheduleId: approval.scheduleId, scheduleText, scheduleDigest: approval.scheduleDigest });
            return { approval, cookie };
        },
        provision(approval, options = {}) { return provisionVerifiedOrganisationSetup({ approval, setupStore, authorityContainer,
            ...context, graph, invitations, now: () => clock.at, ...options }); }
    };
    return h;
}

test('verified setup plus exact separate approval binds durably, invites once and only projects a pending next step', async () => {
    const h = fixture(), { approval, cookie } = await h.prepare();
    const before = h.durable.size;
    expect(await h.provision(approval, { inspectOnly: true })).toEqual({ requestId: approval.requestId, status: 'ready_to_provision', accessGranted: false });
    expect(h.durable.size).toBe(before); expect(h.graph.createInvitation).not.toHaveBeenCalled();
    expect((await h.call('state', undefined, cookie)).body.nextStep).toBe('pending_activation');
    const result = await h.provision(approval);
    expect(result.status).toBe('pending_admission'); expect(h.graph.createInvitation).toHaveBeenCalledTimes(1);
    expect(h.durable.get('customer-subjects/' + subjectHash(result.subjectKey) + '.json').record.bindingId).toBeNull();
    const projected = (await h.call('state', undefined, cookie)).body;
    expect(projected).toMatchObject({ state: 'verified', nextStep: 'check_invitation', accessGranted: false });
    expect(projected).not.toHaveProperty('subjectKey'); expect(projected).not.toHaveProperty('email');
    expect((await h.call('state')).body).toEqual({ state: 'start' });
    h.transient.clear(); h.clock.at += 86400001;
    expect(await h.provision(approval)).toEqual(result);
    expect(h.graph.createInvitation).toHaveBeenCalledTimes(1);
});

test.each(['email', 'organisationName', 'tenantId', 'scheduleDigest', 'representativeAuthorityEvidenceId', 'invitationApprovalEvidenceId'])('changed %s cannot retarget a durable approved request', async field => {
    const h = fixture(), { approval } = await h.prepare(); await h.provision(approval);
    const altered = { ...approval, [field]: field === 'email' ? 'another@acme.example' : field === 'scheduleDigest' ? 'a'.repeat(64) : 'another-approved-value' };
    await expect(h.provision(altered)).rejects.toThrow(); expect(h.graph.createInvitation).toHaveBeenCalledTimes(1);
});

test.each(['unverified', 'expired', 'wrong_reference', 'wrong_mailbox', 'wrong_organisation', 'missing_schedule', 'inactive_offer'])('%s denies a fresh binding before any invitation', async reason => {
    const h = fixture(), { approval } = await h.prepare(), ref = h.transient.get(setupReferenceKey(approval.requestId)).record;
    const source = h.transient.get(ref.requestKey).record;
    if (reason === 'unverified') { source.status = 'pending_email'; source.verifiedAt = null; }
    if (reason === 'expired') h.clock.at = source.expiresAt;
    if (reason === 'wrong_reference') ref.requestId = '33333333-3333-4333-8333-333333333333';
    if (reason === 'wrong_mailbox') approval.email = 'another@acme.example';
    if (reason === 'wrong_organisation') approval.organisationName = 'Another';
    if (reason === 'missing_schedule') h.durable.delete(scheduleArchiveKey(approval.scheduleId, approval.scheduleDigest));
    if (reason === 'inactive_offer') h.durable.get(termsOfferKey(approval.tenantId, approval.organisationId)).record.status = 'revoked';
    await expect(h.provision(approval)).rejects.toThrow(); expect(h.graph.createInvitation).not.toHaveBeenCalled();
    expect(h.durable.has(key('bindings', approval.requestId))).toBe(false);
});

test('an uncertain invitation send remains fenced across retries', async () => {
    const h = fixture(), { approval, cookie } = await h.prepare();
    h.graph.createInvitation.mockRejectedValue(new Error('delivery uncertain'));
    await expect(h.provision(approval)).rejects.toThrow();
    await expect(h.provision(approval)).rejects.toThrow();
    expect(h.graph.createInvitation).toHaveBeenCalledTimes(1);
    expect((await h.call('state', undefined, cookie)).body.nextStep).toBe('pending_activation');
    expect(h.durable.get('customer-invitation-attempts/' + approval.requestId + '.json').record).not.toHaveProperty('invitationToken');
});

test('acknowledged delivery resumes finalisation after transient request cleanup without resending', async () => {
    const h = fixture(), { approval } = await h.prepare(); h.failSubject = true;
    await expect(h.provision(approval)).rejects.toThrow();
    expect(h.durable.get('customer-invitation-attempts/' + approval.requestId + '.json').record.phase).toBe('delivered');
    h.transient.clear(); h.clock.at += 86400001; h.failSubject = false;
    expect((await h.provision(approval)).status).toBe('pending_admission');
    expect(h.graph.createInvitation).toHaveBeenCalledTimes(1);
});

test('existing Member identity stays unsupported and is never converted or invited', async () => {
    const h = fixture(), { approval } = await h.prepare();
    h.graph.findGuestsByEmail.mockResolvedValue([{ id: '11111111-2222-4333-8444-555555555555', mail: approval.email, userType: 'Member' }]);
    await expect(h.provision(approval)).rejects.toThrow();
    expect(h.graph.createInvitation).not.toHaveBeenCalled();
    expect([...h.durable.keys()].some(name => name.startsWith('customer-subjects/'))).toBe(false);
});

test('revoked or organisation-mismatched current authority cannot expose ready continuation', async () => {
    const h = fixture(), { approval, cookie } = await h.prepare(), result = await h.provision(approval);
    const current = h.durable.get('customer-subjects/' + subjectHash(result.subjectKey) + '.json').record;
    current.organisationId = 'another-organisation';
    expect((await h.call('state', undefined, cookie)).status).toBe(503);
    current.organisationId = approval.organisationId; current.status = 'revoked';
    expect((await h.call('state', undefined, cookie)).status).toBe(503);
});

test('last-moment operation guard failure creates no binding or delivery', async () => {
    const h = fixture(), { approval } = await h.prepare();
    await expect(h.provision(approval, { beforeMutation: async () => { throw new Error('operation changed'); } })).rejects.toThrow();
    expect(h.durable.has(key('bindings', approval.requestId))).toBe(false); expect(h.graph.createInvitation).not.toHaveBeenCalled();
});

test.each(['revoked', 'expired'])('an offer %s during cloud checks cannot cause an invitation', async mode => {
    const h = fixture(), { approval } = await h.prepare(); let calls = 0;
    const beforeMutation = async () => { if (++calls === 2) {
        const offer = h.durable.get(termsOfferKey(approval.tenantId, approval.organisationId)).record;
        if (mode === 'revoked') offer.status = 'revoked'; else offer.expiresAt = h.clock.at;
    } };
    await expect(h.provision(approval, { beforeMutation })).rejects.toThrow();
    expect(h.graph.createInvitation).not.toHaveBeenCalled();
});

test('inspect rejects an existing Member and missing predecessor authority without writes', async () => {
    const h = fixture(), { approval } = await h.prepare(), before = h.durable.size;
    h.graph.findGuestsByEmail.mockResolvedValue([{ id: '11111111-2222-4333-8444-555555555555', mail: approval.email, userType: 'Member' }]);
    await expect(h.provision(approval, { inspectOnly: true })).rejects.toThrow();
    h.graph.findGuestsByEmail.mockResolvedValue([]);
    await expect(h.provision({ ...approval, expectedAuthorityRevision: 0 }, { inspectOnly: true })).rejects.toThrow();
    expect(h.durable.size).toBe(before); expect(h.invites.size).toBe(0); expect(h.graph.createInvitation).not.toHaveBeenCalled();
});

test.each(['disabled', 'edited', 'unavailable', 'and-device', 'and-mfa', 'extra-context', 'session-controls',
    'custom-grant', 'terms-grant', 'partial-rollout'].flatMap(fault => [[fault, false], [fault, true]]))
    ('live MFA policy %s blocks inspectOnly=%s before any provision write or invitation', async (fault, inspectOnly) => {
    const h = fixture(), { approval } = await h.prepare(), live = livePolicyFixture(), before = copy([...h.durable]);
    if (fault === 'disabled') live.policy.state = 'disabled';
    if (fault === 'edited') live.policy.conditions.users.excludeGroups.push('excluded-group');
    if (fault === 'unavailable') live.fetch.mockRejectedValue(new Error('provider unavailable'));
    if (fault === 'and-device') { live.policy.grantControls.operator = 'AND'; live.policy.grantControls.builtInControls.push('compliantDevice'); }
    if (fault === 'and-mfa') live.policy.grantControls.operator = 'AND';
    if (fault === 'extra-context') live.policy.conditions.applications.includeAuthenticationContextClassReferences.push('c2');
    if (fault === 'session-controls') live.policy.sessionControls = { signInFrequency: { value: 1, type: 'hours', isEnabled: true } };
    if (fault === 'custom-grant') live.policy.grantControls.customAuthenticationFactors = ['unreviewed'];
    if (fault === 'terms-grant') live.policy.grantControls.termsOfUse = ['unreviewed'];
    if (fault === 'partial-rollout') live.policy.partialEnablementStrategy = { partialEnablementStrategyTargets: [] };
    await expect(h.provision(approval, { beforeMutation: live.guard, inspectOnly })).rejects.toThrow('customer_setup_provisioning_blocked');
    expect([...h.durable]).toEqual(before); expect(h.invites.size).toBe(0);
    expect(h.graph.createInvitation).not.toHaveBeenCalled();
});

test('policy is checked again for pending finalisation but cannot replay or erase exact completed history', async () => {
    const h = fixture(), { approval } = await h.prepare(), live = livePolicyFixture(); h.failSubject = true;
    await expect(h.provision(approval, { beforeMutation: live.guard })).rejects.toThrow();
    expect(h.graph.createInvitation).toHaveBeenCalledTimes(1);
    expect(h.durable.get('customer-invitation-attempts/' + approval.requestId + '.json').record.phase).toBe('delivered');
    const before = copy([...h.durable]); live.policy.state = 'disabled'; h.failSubject = false;
    await expect(h.provision(approval, { beforeMutation: live.guard })).rejects.toThrow('customer_setup_provisioning_blocked');
    await expect(h.provision(approval, { beforeMutation: live.guard, inspectOnly: true })).rejects.toThrow('customer_setup_provisioning_blocked');
    expect([...h.durable]).toEqual(before); expect(h.graph.createInvitation).toHaveBeenCalledTimes(1);
    live.policy.state = 'enabled'; const result = await h.provision(approval, { beforeMutation: live.guard });
    expect(result.status).toBe('pending_admission'); expect(h.graph.createInvitation).toHaveBeenCalledTimes(1);
    live.policy.state = 'disabled'; live.fetch.mockClear();
    expect(await h.provision(approval, { beforeMutation: live.guard })).toEqual(result);
    expect(await h.provision(approval, { beforeMutation: live.guard, inspectOnly: true })).toEqual(result);
    expect(live.fetch).not.toHaveBeenCalled(); expect(h.graph.createInvitation).toHaveBeenCalledTimes(1);
});

test.each(['x'.repeat(161), '界'.repeat(107), 'e\u0301'])('provider-incompatible display name is rejected before reserving a binding', async displayName => {
    const h = fixture(), { approval } = await h.prepare();
    await expect(h.provision({ ...approval, displayName })).rejects.toThrow();
    expect(h.durable.has(key('bindings', approval.requestId))).toBe(false);
    expect(h.invites.size).toBe(0); expect(h.graph.createInvitation).not.toHaveBeenCalled();
});

test.each(['company', 'consultant'])('approved %s type is bound from mailbox proof through durable authority', async accountType => {
    const h = fixture(), { approval, cookie } = await h.prepare(accountType);
    const result = await h.provision(approval);
    const subject = h.durable.get('customer-subjects/' + subjectHash(result.subjectKey) + '.json').record;
    expect(subject.accountType).toBe(accountType);
    const binding = h.durable.get(key('bindings', approval.requestId)).record;
    expect(binding.request.accountType).toBe(accountType); expect(binding.approval.accountType).toBe(accountType);
    expect((await h.call('state', undefined, cookie)).body).toMatchObject({ accountType, nextStep: 'check_invitation', accessGranted: false });
    subject.accountType = accountType === 'consultant' ? 'company' : 'consultant';
    expect((await h.call('state', undefined, cookie)).status).toBe(503);
});
test.each([undefined, 'company', 'staff'])('consultant proof cannot be provisioned with a different or missing approved type %p', async approvedType => {
    const h = fixture(), { approval } = await h.prepare('consultant');
    if (approvedType === undefined) delete approval.accountType; else approval.accountType = approvedType;
    await expect(h.provision(approval)).rejects.toThrow();
    expect(h.graph.createInvitation).not.toHaveBeenCalled();
    expect(h.durable.has(key('bindings', approval.requestId))).toBe(false);
});
test('legacy company proof and approval retain their original durable shape', async () => {
    const h = fixture(), { approval, cookie } = await h.prepare();
    const ref = h.transient.get(setupReferenceKey(approval.requestId)).record;
    delete h.transient.get(ref.requestKey).record.accountType;
    delete approval.accountType;
    await h.provision(approval);
    expect(h.durable.get(key('bindings', approval.requestId)).record.request).not.toHaveProperty('accountType');
    expect((await h.call('state', undefined, cookie)).body.accountType).toBe('company');
});

test('new company proof requires an explicitly typed approval before durable binding or delivery', async () => {
    const h = fixture(), { approval } = await h.prepare('company');
    delete approval.accountType;
    await expect(h.provision(approval, { inspectOnly: true })).rejects.toThrow();
    await expect(h.provision(approval)).rejects.toThrow();
    expect(h.durable.has(key('bindings', approval.requestId))).toBe(false);
    expect(h.graph.createInvitation).not.toHaveBeenCalled();
});
test('legacy proof cannot be paired with a newly typed approval', async () => {
    const h = fixture(), { approval } = await h.prepare('company');
    const ref = h.transient.get(setupReferenceKey(approval.requestId)).record;
    delete h.transient.get(ref.requestKey).record.accountType;
    await expect(h.provision(approval)).rejects.toThrow();
    expect(h.graph.createInvitation).not.toHaveBeenCalled();
    expect(h.durable.has(key('bindings', approval.requestId))).toBe(false);
});
