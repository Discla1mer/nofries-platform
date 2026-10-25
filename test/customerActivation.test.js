'use strict';

// Synthetic authority and customer receipts only. These tests do not establish
// actual identity, commercial approval, accepted terms or production admission.
const { normaliseActivationApproval, normaliseActivationCandidate, activationPublicationEffect,
    publicationEffect, activationKey, completionKey,
    customerReference, validateCustomerAcceptance, buildActivationCommands } = require('../api/shared/customerSignup/customerActivation');
const { canonicalDigest, publishExistingMembershipBinding } = require('../api/shared/appLifecycle/dashboardOnboardingDomain');
const { createMembershipState, applyMembershipCommand, resolveActiveMembership } = require('../api/shared/appLifecycle/membershipDomain');
const { createInvitation, createInvitationAcceptance } = require('../api/shared/customerSignup/invitationAcceptance');
const { fixture, NOW, SUBJECT } = require('./fixtures/dashboardFixture');
const uuid = n => `50000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const OPERATOR = `${uuid(1)}:${uuid(2)}`;
const AT = Date.parse(NOW), APPROVED = AT - 3600000, ACCEPTED = AT - 1800000, EXPIRES = AT + 3600000;
const iso = time => new Date(time).toISOString();
const clone = value => JSON.parse(JSON.stringify(value));

function sample() {
    const source = fixture();
    const initialState = clone({ tenantAggregate: source.tenantAggregate,
        membershipState: createMembershipState(source.tenantAggregate, source.scope, iso(APPROVED)),
        entitlementState: source.entitlementState, flags: source.flags, advisorAssignments: [] });
    initialState.membershipState = applyMembershipCommand(initialState.membershipState, source.tenantAggregate,
        { ...source.scope, expectedRevision: 0, actorSubjectKey: OPERATOR, now: iso(APPROVED), action: 'invite',
            payload: { invitationId: uuid(3), subjectKey: SUBJECT, roles: ['admin'],
                validFrom: iso(APPROVED), validUntil: iso(EXPIRES + 3600000),
                grantEvidenceId: 'synthetic-role-approval', expiresAt: iso(EXPIRES) } });
    const current = { schemaVersion: 2, subjectKey: SUBJECT, email: 'synthetic@example.test', revision: 0, status: 'active',
        invitationDigest: 'a'.repeat(64), invitationId: uuid(3), ...source.scope,
        termsVersion: 'synthetic-terms', termsDigest: 'b'.repeat(64), scheduleId: 'synthetic-schedule',
        scheduleDigest: 'c'.repeat(64), bindingId: null, expiresAt: EXPIRES };
    const approval = { schemaVersion: 1, activationId: uuid(4), approvalRef: 'synthetic-approval',
        approvedBy: OPERATOR, approvedAt: iso(APPROVED), expiresAt: iso(EXPIRES),
        authoritySha256: canonicalDigest(current), authorityRevision: 0,
        subjectKey: SUBJECT, invitationId: uuid(3), membershipId: 'synthetic-member',
        termsVersion: current.termsVersion, termsDigest: current.termsDigest,
        scheduleId: current.scheduleId, scheduleDigest: current.scheduleDigest,
        scope: source.scope, identity: { policyId: 'synthetic-policy', policyRevision: 0,
            issuer: 'https://identity.example.test/v2.0', identityTenantId: SUBJECT.slice(0, 36),
            oid: SUBJECT.slice(37), audience: 'synthetic-client' },
        bootstrapOperationId: uuid(5), acceptOperationId: uuid(6), publicationOperationId: uuid(7),
        bindingId: uuid(8), authorityRef: { authorityId: uuid(9), revision: 0, sha256: 'd'.repeat(64) },
        bootstrapExpectedRevisions: { tenant: null, organisation: null, membership: null, entitlement: null,
            flags: null, advisorAssignments: [], usage: [] }, initialState };
    const receipt = { ...customerReference(current), receiptId: uuid(10), acceptedAt: ACCEPTED,
        status: 'pending_admission', dashboardAccess: false };
    const registration = { ...customerReference(current), receiptId: receipt.receiptId, status: 'pending_admission', revision: 1 };
    return clone({ approval, current, receipt, registration });
}

describe('closed owner approval for customer activation', () => {
    test('is detached/frozen and has no pre-consent membership', () => {
        const { approval } = sample(), normal = normaliseActivationApproval(approval);
        expect(normal).toEqual(approval);
        expect(Object.isFrozen(normal.initialState.entitlementState.grants[0].limits)).toBe(true);
        approval.initialState.entitlementState.grants[0].limits.memberships = 999;
        expect(normal.initialState.entitlementState.grants[0].limits.memberships).toBe(10);
        expect(normal.initialState.membershipState.memberships).toEqual([]);
        expect(() => resolveActiveMembership(normal.initialState.membershipState, normal.initialState.tenantAggregate,
            { ...normal.scope, subjectKey: normal.subjectKey }, NOW)).toThrow();
    });

    test.each([
        ['unknown approval field', value => { value.accessGranted = true; }],
        ['missing commercial schedule', value => { delete value.scheduleDigest; }],
        ['identity mismatch', value => { value.identity.oid = uuid(31); }],
        ['noncanonical subject', value => { value.subjectKey = 'email@example.test'; }],
        ['unbounded membership', value => { delete value.initialState.entitlementState.grants[0].limits.memberships; }],
        ['zero membership capacity', value => { value.initialState.entitlementState.grants[0].limits.memberships = 0; }],
        ['missing assessment capacity', value => { delete value.initialState.entitlementState.grants[0].limits.assessment_runs; }],
        ['missing framework', value => { value.initialState.entitlementState.grants[0].frameworks = []; }],
        ['foreign grant', value => { value.initialState.entitlementState.grants[0].organisationId = 'foreign'; }],
        ['foreign invitation', value => { value.initialState.membershipState.invitations[0].organisationId = 'foreign'; }],
        ['foreign invitation subject', value => { value.initialState.membershipState.invitations[0].subjectKey = OPERATOR; }],
        ['extra invitation', value => { value.initialState.membershipState.invitations.push(value.initialState.membershipState.invitations[0]); }],
        ['active membership seed', value => { value.initialState.membershipState.memberships = [{}]; }],
        ['advisor seed', value => { value.initialState.advisorAssignments = [{}]; }],
        ['revoked invitation', value => { value.initialState.membershipState.invitations[0].status = 'revoked'; }],
        ['reused operation', value => { value.acceptOperationId = value.bootstrapOperationId; }],
        ['exhausted customer authority revision', value => { value.authorityRevision = Number.MAX_SAFE_INTEGER; }],
        ['exhausted membership revision', value => { value.initialState.membershipState.revision = Number.MAX_SAFE_INTEGER; }],
        ['expired approval interval', value => { value.expiresAt = value.approvedAt; }],
        ['missing explicit bootstrap vector', value => { delete value.bootstrapExpectedRevisions; }],
        ['existing organisation revision', value => { value.bootstrapExpectedRevisions.organisation = 0; }],
        ['wrong existing tenant revision', value => { value.bootstrapExpectedRevisions.tenant = 5; }],
        ['hidden authority reference', value => { value.authorityRef.extra = 'approval'; }]
    ])('rejects %s before constructing effects', (_, change) => {
        const { approval } = sample(); change(approval);
        expect(() => normaliseActivationApproval(approval)).toThrow();
    });

    test('rejects exotic/accessor/proxy records without invoking accessors', () => {
        const { approval } = sample(), getter = jest.fn();
        Object.defineProperty(approval, 'approvedBy', { get: getter, enumerable: true });
        expect(() => normaliseActivationApproval(approval)).toThrow(); expect(getter).not.toHaveBeenCalled();
        expect(() => normaliseActivationApproval(new Proxy(sample().approval, {}))).toThrow();
        expect(() => normaliseActivationApproval(Object.assign(new Date(), sample().approval))).toThrow();
    });

    test('explicitly supports a new organisation under a current canonical tenant', () => {
        const { approval } = sample(); approval.initialState.tenantAggregate.tenant.revision = 3;
        approval.bootstrapExpectedRevisions.tenant = 3;
        expect(buildActivationCommands(approval).bootstrap.expectedRevisions.tenant).toBe(3);
    });

    test('builders preserve approved intent and match the installed publication contract', () => {
        const { approval } = sample(), { bootstrap, accept, reserveMembership, pub } = buildActivationCommands(approval);
        expect(bootstrap.expectedRevisions).toEqual(approval.bootstrapExpectedRevisions);
        expect(accept.actorSubjectKey).toBe(SUBJECT);
        expect(accept.payload).toEqual({ action: 'accept', payload: { invitationId: approval.invitationId, membershipId: approval.membershipId } });
        expect(accept.expectedRevisions.usage).toEqual([{ grantId: 'synthetic-product', revision: 0 }]);
        expect(reserveMembership.operationId).toBe(`initial-member:${approval.acceptOperationId}`);
        expect(reserveMembership.expectedRevisions).toEqual({ ...accept.expectedRevisions,
            membership: accept.expectedRevisions.membership + 1 });
        expect(reserveMembership.payload).toEqual({ grantId: 'synthetic-product', moduleId: 'overview',
            limit: 'memberships', amount: 1, framework: null });
        expect(reserveMembership.actorSubjectKey).toBe(SUBJECT);
        const currentAuthority = clone(approval.initialState);
        currentAuthority.membershipState = applyMembershipCommand(currentAuthority.membershipState, currentAuthority.tenantAggregate,
            { ...approval.scope, actorSubjectKey: SUBJECT, expectedRevision: accept.expectedRevisions.membership,
                ...accept.payload, now: iso(ACCEPTED) });
        const result = publishExistingMembershipBinding({ ...pub, receiptId: uuid(20), actorSubjectKey: OPERATOR,
            at: iso(ACCEPTED), currentAuthority });
        const effect = publicationEffect(pub);
        for (const field of ['bindingId', 'scope', 'membershipId', 'invitationId', 'grantEvidenceId', 'identity', 'validFrom', 'validUntil']) {
            expect(effect[field]).toEqual(result.binding[field]);
        }
        expect(effect).not.toHaveProperty('authorityRef');
        expect(effect).not.toHaveProperty('operationId');
        expect(() => publicationEffect({ ...pub, unexpected: true })).toThrow();
    });

    test('storage keys accept only the immutable activation UUID', () => {
        expect(activationKey(uuid(4))).toBe(`customer-activations/${uuid(4)}.json`);
        expect(completionKey(uuid(4))).toBe(`browser-auth/customer-activation-completions/${uuid(4)}.json`);
        for (const invalid of ['../authority', 'someone@example.test', `${uuid(4)}/extra`, uuid(4).toUpperCase()]) {
            // This numeric-only UUID has no letter case distinction.
            if (invalid === uuid(4)) continue;
            expect(() => activationKey(invalid)).toThrow(); expect(() => completionKey(invalid)).toThrow();
        }
    });

    test('pre-admission candidates derive the exact effect without a fabricated reference', () => {
        const { approval } = sample(), { authorityRef, ...candidate } = approval;
        const normal = normaliseActivationCandidate(candidate);
        expect(normal).toEqual(candidate);
        expect(normal).not.toHaveProperty('authorityRef');
        expect(Object.isFrozen(normal.initialState.membershipState)).toBe(true);
        expect(activationPublicationEffect(candidate)).toEqual(publicationEffect(buildActivationCommands(approval).pub));
        candidate.initialState.membershipState.invitations[0].validUntil = iso(EXPIRES + 7200000);
        expect(normal.initialState.membershipState.invitations[0].validUntil).toBe(iso(EXPIRES + 3600000));
        expect(() => normaliseActivationApproval(normal)).toThrow();
        expect(() => buildActivationCommands(normal)).toThrow();
        expect(() => normaliseActivationCandidate({ ...normal, authorityRef })).toThrow();
        expect(() => activationPublicationEffect({ ...normal, authorityRef })).toThrow();
    });

    test.each([
        ['unknown field', value => { value.authorityRef = null; }],
        ['missing schedule', value => { delete value.scheduleDigest; }],
        ['foreign scope', value => { value.scope.organisationId = 'foreign'; }],
        ['missing finite capacity', value => { delete value.initialState.entitlementState.grants[0].limits.memberships; }],
        ['pre-existing membership', value => { value.initialState.membershipState.memberships.push({}); }],
        ['identity mismatch', value => { value.identity.oid = uuid(31); }]
    ])('candidate/effect rejects %s with the same approval invariants', (_, mutate) => {
        const { authorityRef: omitted, ...candidate } = sample().approval;
        mutate(candidate);
        expect(() => normaliseActivationCandidate(candidate)).toThrow();
        expect(() => activationPublicationEffect(candidate)).toThrow();
    });
});

describe('current authority and real acceptance boundary', () => {
    test('only returns the exact pending human receipt and projects no email/capability', () => {
        const s = sample();
        expect(validateCustomerAcceptance(s.approval, s.current, s.receipt, s.registration, AT)).toEqual(s.receipt);
        const ref = customerReference(s.current);
        expect(ref).not.toHaveProperty('email'); expect(ref).not.toHaveProperty('invitationDigest');
    });

    test.each([
        ['revoked customer authority', s => { s.current.status = 'revoked'; }],
        ['expired authority', s => { s.current.expiresAt = AT; }],
        ['revised authority', s => { s.current.revision += 1; }],
        ['changed authority email', s => { s.current.email = 'changed@example.test'; }],
        ['already published pointer', s => { s.current.bindingId = s.approval.bindingId; }],
        ['foreign receipt organisation', s => { s.receipt.organisationId = 'foreign'; }],
        ['foreign receipt subject', s => { s.receipt.subjectKey = OPERATOR; }],
        ['new terms version', s => { s.receipt.termsVersion = 'new-terms'; }],
        ['new terms digest', s => { s.receipt.termsDigest = 'e'.repeat(64); }],
        ['wrong schedule', s => { s.receipt.scheduleDigest = 'e'.repeat(64); }],
        ['unscheduled receipt', s => { delete s.receipt.scheduleDigest; delete s.receipt.scheduleId; }],
        ['false access assertion', s => { s.receipt.dashboardAccess = true; }],
        ['revoked registration', s => { s.registration.status = 'revoked'; }],
        ['foreign registration', s => { s.registration.organisationId = 'foreign'; }],
        ['different receipt registration', s => { s.registration.receiptId = uuid(22); }],
        ['missing registration revision', s => { delete s.registration.revision; }],
        ['receipt before preparation', s => { s.receipt.acceptedAt = APPROVED - 1; }],
        ['receipt after current time', s => { s.receipt.acceptedAt = AT + 1; }],
        ['receipt at invitation expiry', s => { s.receipt.acceptedAt = EXPIRES; }]
    ])('rejects %s', (_, mutate) => {
        const s = sample(); mutate(s);
        expect(() => validateCustomerAcceptance(s.approval, s.current, s.receipt, s.registration, AT)).toThrow();
    });

    test('rechecks approval expiry and permits retained codec validation without live time', () => {
        const s = sample(); expect(normaliseActivationApproval(s.approval)).toBeTruthy();
        for (const at of [APPROVED - 1, EXPIRES, NaN, undefined]) {
            expect(() => validateCustomerAcceptance(s.approval, s.current, s.receipt, s.registration, at)).toThrow();
        }
    });

    test('accepts an actual synthetic invitation-service receipt, without creating access', async () => {
        const s = sample();
        const issued = createInvitation({ email: s.current.email, ...s.approval.scope,
            identityPolicyId: 'synthetic-policy', termsVersion: s.current.termsVersion, termsDigest: s.current.termsDigest,
            scheduleId: s.current.scheduleId, scheduleDigest: s.current.scheduleDigest, mfaRequired: true,
            createdAt: APPROVED, expiresAt: EXPIRES }, { now: () => APPROVED });
        s.current.invitationId = issued.record.invitationId; s.current.invitationDigest = issued.record.tokenDigest;
        s.approval.invitationId = issued.record.invitationId;
        s.approval.initialState.membershipState.invitations[0].invitationId = issued.record.invitationId;
        s.approval.authoritySha256 = canonicalDigest(s.current);
        let retained = issued.record;
        const service = createInvitationAcceptance({ contextMode: 'verified-digest', now: () => ACCEPTED,
            store: { async transact(_, change) { const next = change(retained); retained = next.record; return clone(next.result); } },
            verifyIdentity: async () => ({ subjectKey: SUBJECT, email: s.current.email, emailVerified: true,
                identityPolicyId: 'synthetic-policy', mfaSatisfied: true, invitationDigest: issued.record.tokenDigest,
                verifiedAt: ACCEPTED, expiresAt: ACCEPTED + 300000 }) });
        const receipt = await service.accept({ invitationDigest: issued.record.tokenDigest,
            identityProofHandle: 'synthetic-authenticated-session', termsVersion: s.current.termsVersion,
            termsDigest: s.current.termsDigest, scheduleId: s.current.scheduleId, scheduleDigest: s.current.scheduleDigest, accepted: true });
        const registration = { ...customerReference(s.current), receiptId: receipt.receiptId, status: 'pending_admission', revision: 1 };
        expect(validateCustomerAcceptance(s.approval, s.current, receipt, registration, AT)).toEqual(receipt);
        expect(receipt.dashboardAccess).toBe(false);
        expect(s.approval.initialState.membershipState.memberships).toEqual([]);
    });
});
