'use strict';

// Pure codecs for an owner-approved activation. These functions neither approve
// a customer nor authenticate a receipt, accept terms or perform a write. The
// caller must obtain authority/registration/receipt from their trusted stores.
const records = require('../appLifecycle/dashboardRuntimeRecords');
const { canonicalDigest, normaliseStableIdentity } = require('../appLifecycle/dashboardOnboardingDomain');
const { createBootstrapOperations, dataCodec } = require('../appLifecycle/postgresDashboardBootstrap');
const { TIERS } = require('../appLifecycle/entitlementDomain');
const { authority } = require('./customerAuthority');
const { validateAcceptanceReceipt } = require('./invitationAcceptance');
const { fields, copy, freeze, uuid, digest, revision, instant, scope, subject, id, equal } = records;

const APPROVAL_FIELDS = ['schemaVersion', 'activationId', 'approvalRef', 'approvedBy', 'approvedAt', 'expiresAt',
    'authoritySha256', 'authorityRevision', 'subjectKey', 'invitationId', 'membershipId', 'termsVersion', 'termsDigest',
    'scheduleId', 'scheduleDigest', 'scope', 'identity', 'bootstrapOperationId', 'acceptOperationId',
    'publicationOperationId', 'bindingId', 'authorityRef', 'bootstrapExpectedRevisions', 'initialState'];
const REFERENCE_FIELDS = ['subjectKey', 'tenantId', 'organisationId', 'invitationId', 'termsVersion',
    'termsDigest', 'scheduleId', 'scheduleDigest'];
const PUBLICATION_FIELDS = ['operationId', 'bindingId', 'scope', 'membershipId', 'invitationId',
    'grantEvidenceId', 'identity', 'validFrom', 'validUntil', 'authorityRef'];
const fail = () => { throw new Error('customer_activation_invalid'); };
function authorityReference(value) {
    fields(value, ['authorityId', 'revision', 'sha256']);
    uuid(value.authorityId); revision(value.revision); digest(value.sha256);
    return value;
}
function publicationValue(value, withAuthorityReference) {
    const keys = withAuthorityReference ? PUBLICATION_FIELDS : PUBLICATION_FIELDS.filter(key => key !== 'authorityRef');
    const command = fields(copy(value, 16384), keys);
    uuid(command.operationId); uuid(command.bindingId); scope(command.scope);
    for (const field of ['membershipId', 'invitationId', 'grantEvidenceId']) id(command[field]);
    normaliseStableIdentity(command.identity);
    if (withAuthorityReference) authorityReference(command.authorityRef);
    if (instant(command.validFrom) >= instant(command.validUntil)) fail();
    return command;
}

// Keep this projection identical to the runtime's approved publication effect.
// Operation IDs and the admission reference are deliberately not effect fields.
function effectFor(command) {
    return freeze({ schemaVersion: 1, operationType: 'publish_existing_membership',
        bindingId: command.bindingId, scope: command.scope, membershipId: command.membershipId,
        invitationId: command.invitationId, grantEvidenceId: command.grantEvidenceId,
        identity: command.identity, validFrom: command.validFrom, validUntil: command.validUntil });
}
function publicationEffect(value) { return effectFor(publicationValue(value, true)); }
const activationKey = activationId => `customer-activations/${uuid(activationId)}.json`;
const completionKey = activationId => `browser-auth/customer-activation-completions/${uuid(activationId)}.json`;
const activationReferenceKey = current => `customer-activation-references/${canonicalDigest(customerReference(current))}.json`;
function activationReference(value) {
    const approval = normaliseActivationApproval(value);
    return freeze({ schemaVersion: 1, activationId: approval.activationId, approvalSha256: canonicalDigest(approval) });
}

function commandsFor(approval) {
    const initial = approval.initialState, invitation = initial.membershipState.invitations[0];
    const expectedRevisions = {
        tenant: initial.tenantAggregate.tenant.revision,
        organisation: initial.tenantAggregate.organisations[0].revision,
        membership: initial.membershipState.revision,
        entitlement: initial.entitlementState.revision,
        flags: initial.flags.revision,
        advisorAssignments: [],
        usage: initial.entitlementState.grants.filter(grant => Object.hasOwn(TIERS, grant.code))
            .map(grant => ({ grantId: grant.grantId, revision: 0 }))
            .sort((a, b) => a.grantId < b.grantId ? -1 : a.grantId > b.grantId ? 1 : 0)
    };
    return {
        bootstrap: { ...approval.scope, operationId: approval.bootstrapOperationId,
            actorSubjectKey: approval.approvedBy, type: 'organisation.initialise',
            expectedRevisions: approval.bootstrapExpectedRevisions, payload: {} },
        accept: { ...approval.scope, operationId: approval.acceptOperationId,
            actorSubjectKey: approval.subjectKey, type: 'membership.command', expectedRevisions,
            payload: { action: 'accept', payload: { invitationId: approval.invitationId, membershipId: approval.membershipId } } },
        // A deterministic, distinct DATA operation charges the initial user in
        // the same transaction as membership acceptance and binding publication.
        // Retrying this activation reconciles this receipt, never another seat.
        reserveMembership: { ...approval.scope, operationId: `initial-member:${approval.acceptOperationId}`,
            actorSubjectKey: approval.subjectKey, type: 'usage.reserve',
            expectedRevisions: { ...expectedRevisions, membership: expectedRevisions.membership + 1 },
            payload: { grantId: expectedRevisions.usage[0].grantId, moduleId: 'overview',
                limit: 'memberships', amount: 1, framework: null } },
        pub: { operationId: approval.publicationOperationId, bindingId: approval.bindingId,
            scope: approval.scope, membershipId: approval.membershipId, invitationId: approval.invitationId,
            grantEvidenceId: invitation.grantEvidenceId, identity: approval.identity,
            validFrom: invitation.validFrom, validUntil: invitation.validUntil,
            ...(Object.hasOwn(approval, 'authorityRef') ? { authorityRef: approval.authorityRef } : {}) }
    };
}

function activationValue(value, withAuthorityReference) {
    const keys = withAuthorityReference ? APPROVAL_FIELDS : APPROVAL_FIELDS.filter(key => key !== 'authorityRef');
    const approval = fields(copy(value, 262144), keys);
    if (approval.schemaVersion !== 1) fail();
    for (const key of ['activationId', 'bootstrapOperationId', 'acceptOperationId', 'publicationOperationId', 'bindingId']) uuid(approval[key]);
    const operationIds = [approval.bootstrapOperationId, approval.acceptOperationId, approval.publicationOperationId];
    if (new Set(operationIds).size !== operationIds.length) fail();
    for (const key of ['approvalRef', 'invitationId', 'membershipId', 'termsVersion', 'scheduleId']) id(approval[key]);
    for (const key of ['authoritySha256', 'termsDigest', 'scheduleDigest']) digest(approval[key]);
    revision(approval.authorityRevision); subject(approval.approvedBy); subject(approval.subjectKey);
    if (approval.authorityRevision === Number.MAX_SAFE_INTEGER) fail();
    if (instant(approval.approvedAt) >= instant(approval.expiresAt)) fail();
    scope(approval.scope); normaliseStableIdentity(approval.identity);
    if (withAuthorityReference) authorityReference(approval.authorityRef);
    if (`${approval.identity.identityTenantId}:${approval.identity.oid}` !== approval.subjectKey) fail();

    const initial = fields(approval.initialState, ['tenantAggregate', 'membershipState', 'entitlementState', 'flags', 'advisorAssignments']);
    const expected = fields(approval.bootstrapExpectedRevisions,
        ['tenant', 'organisation', 'membership', 'entitlement', 'flags', 'advisorAssignments', 'usage']);
    if (expected.tenant !== null && expected.tenant !== initial.tenantAggregate.tenant.revision ||
        ['organisation', 'membership', 'entitlement', 'flags'].some(key => expected[key] !== null) ||
        !Array.isArray(expected.advisorAssignments) || expected.advisorAssignments.length ||
        !Array.isArray(expected.usage) || expected.usage.length ||
        !Array.isArray(initial.membershipState.memberships) || initial.membershipState.memberships.length ||
        !Array.isArray(initial.membershipState.invitations) || initial.membershipState.invitations.length !== 1 ||
        !Array.isArray(initial.advisorAssignments) || initial.advisorAssignments.length) fail();
    const invitation = initial.membershipState.invitations[0];
    if (initial.membershipState.revision === Number.MAX_SAFE_INTEGER || invitation.status !== 'pending' || invitation.membershipId !== null ||
        invitation.subjectKey !== approval.subjectKey || invitation.invitationId !== approval.invitationId ||
        invitation.createdBy !== approval.approvedBy || invitation.updatedBy !== approval.approvedBy ||
        invitation.createdAt !== invitation.updatedAt || initial.membershipState.updatedAt !== invitation.createdAt ||
        invitation.createdAt > approval.approvedAt || approval.expiresAt > invitation.expiresAt) fail();
    if (initial.tenantAggregate.tenant.recordStatus !== 'active' ||
        initial.tenantAggregate.organisations.length !== 1 || initial.tenantAggregate.organisations[0].recordStatus !== 'active') fail();
    const products = initial.entitlementState.grants.filter(grant => Object.hasOwn(TIERS, grant.code));
    if (products.length !== 1) fail();
    for (const grant of products) {
        if (grant.status !== 'active' || grant.validFrom > approval.approvedAt || grant.validUntil < approval.expiresAt ||
            !Number.isSafeInteger(grant.limits.memberships) || grant.limits.memberships < 1 ||
            grant.modules.includes('cyber_security') &&
                (!Number.isSafeInteger(grant.limits.assessment_runs) || grant.limits.assessment_runs < 1)) fail();
    }
    const commands = commandsFor(approval);
    // Reuse the installed DATA codec. Preparation validates explicit scope,
    // grants, flags, dates and revision vectors without authorising any effect.
    createBootstrapOperations({ clock: () => approval.approvedAt, authoriseAdministration: () => false })
        .prepareInitialisation(commands.bootstrap, initial);
    publicationValue(commands.pub, withAuthorityReference);
    return freeze(approval);
}

function normaliseActivationApproval(value) { return activationValue(value, true); }

// A candidate describes an exact proposed effect for the separate maintenance
// admission decision. It intentionally has no admission reference and cannot be
// supplied to buildActivationCommands or used as a completed approval.
function normaliseActivationCandidate(value) { return activationValue(value, false); }
function activationPublicationEffect(value) {
    const candidate = normaliseActivationCandidate(value);
    return effectFor(publicationValue(commandsFor(candidate).pub, false));
}

function buildActivationCommands(value) {
    return freeze(commandsFor(normaliseActivationApproval(value)));
}

// Structural validation only. The production completion producer separately
// reads this result from the committed SQL operation receipt before attesting it.
function validateMembershipReservationResult(approvalInput, input) {
    const approval = normaliseActivationApproval(approvalInput), command = commandsFor(approval).reserveMembership;
    const grant = approval.initialState.entitlementState.grants.find(row => row.grantId === command.payload.grantId);
    const usage = dataCodec.newUsage(grant);
    usage.revision = 1; usage.counters.memberships = 1;
    const expected = { operationId: command.operationId, type: 'usage.reserve', reserved: true,
        resultRevisions: { ...command.expectedRevisions, usage: [{ grantId: grant.grantId, revision: 1 }] }, usage };
    const result = copy(input, 32768);
    if (!equal(result, expected)) fail();
    return freeze(result);
}

function customerReference(value) {
    const raw = copy(value, 16384);
    // This helper is structural. Live callers must separately validate expiry
    // against their trusted clock, as validateCustomerAcceptance does below.
    const record = authority(raw, subject(raw.subjectKey), 0);
    if (record.schemaVersion !== 2) fail();
    return freeze(Object.fromEntries(REFERENCE_FIELDS.map(key => [key, record[key]])));
}

function validateCustomerAcceptance(approvalInput, authorityInput, receiptInput, registrationInput, now) {
    const approval = normaliseActivationApproval(approvalInput);
    if (!Number.isSafeInteger(now) || now < Date.parse(approval.approvedAt) || now >= Date.parse(approval.expiresAt)) fail();
    const current = authority(authorityInput, approval.subjectKey, now);
    if (current.schemaVersion !== 2 || current.bindingId !== null || current.revision !== approval.authorityRevision ||
        canonicalDigest(current) !== approval.authoritySha256) fail();
    const expected = { subjectKey: approval.subjectKey, ...approval.scope, invitationId: approval.invitationId,
        termsVersion: approval.termsVersion, termsDigest: approval.termsDigest,
        scheduleId: approval.scheduleId, scheduleDigest: approval.scheduleDigest };
    if (!equal(customerReference(current), expected)) fail();
    const receipt = validateAcceptanceReceipt(copy(receiptInput, 16384));
    const registration = fields(copy(registrationInput, 16384), [...REFERENCE_FIELDS, 'receiptId', 'status', 'revision']);
    revision(registration.revision);
    if (registration.status !== 'pending_admission' || registration.receiptId !== receipt.receiptId ||
        REFERENCE_FIELDS.some(key => receipt[key] !== expected[key] || registration[key] !== expected[key])) fail();
    const invitation = approval.initialState.membershipState.invitations[0];
    if (receipt.acceptedAt < Date.parse(invitation.createdAt) || receipt.acceptedAt < Date.parse(approval.approvedAt) ||
        receipt.acceptedAt >= Date.parse(invitation.expiresAt) || receipt.acceptedAt > now) fail();
    return freeze(receipt);
}

module.exports = Object.freeze({ normaliseActivationApproval, normaliseActivationCandidate, activationPublicationEffect,
    publicationEffect, activationKey, completionKey, activationReferenceKey, activationReference,
    customerReference, validateCustomerAcceptance, buildActivationCommands, validateMembershipReservationResult });
