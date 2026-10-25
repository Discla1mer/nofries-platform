'use strict';

const { fields, copy, freeze, uuid, subject, instant, hash, equal } = require('../appLifecycle/dashboardRuntimeRecords');
const { starterAccountRecord, STARTER_SLOT_FIELDS } = require('./starterAccountAllocation');
const { compileStarterPreparation, compileStarterActivation, approvedStarterPlan, CONSULTANT_ORGANISATION_POLICY } = require('./customerStarterPlan');
const { applyAdmissionCommand, normaliseStableIdentity } = require('../appLifecycle/dashboardOnboardingDomain');
const { validateAcceptanceReceipt } = require('./invitationAcceptance');
const fail = () => { throw new Error('starter_provisioning_invalid'); };
const absent = { tenant: null, organisation: null, membership: null, entitlement: null, flags: null, advisorAssignments: [], usage: [] };

// Structural compilers only. The composition root loads the real verified setup,
// provider subject and declaration; runtime activation loads consent from SQL.
function compileStarterProvisioning(input) {
    const detached = Object.hasOwn(input, 'slot');
    const value = fields(copy(input, 131072), ['account', 'requestId', 'source', ...(detached ? ['slot'] : [])]);
    const account = starterAccountRecord(value.account); uuid(value.requestId);
    // New client reservations are independent bounded records. Their ordinal
    // marks the client kind, rather than a position in a growing account array.
    const ordinal = detached ? 1 : account.organisations.findIndex(s => s.requestId === value.requestId);
    if (ordinal < 0) fail();
    const slot = detached ? fields(value.slot, STARTER_SLOT_FIELDS) : account.organisations[ordinal], source = value.source;
    const preparation = compileStarterPreparation(source), offer = source.offerInput;
    if (detached) {
        if (account.accountType !== 'consultant' || !account.activation || slot.kind !== 'client' ||
            slot.requestId !== value.requestId || offer.consultantOrganisationPolicy !== CONSULTANT_ORGANISATION_POLICY) fail();
        const used = new Set([account.accountId, ...account.organisations.flatMap(s => STARTER_SLOT_FIELDS
            .filter(k => !['kind', 'organisationName'].includes(k)).map(k => s[k]))]);
        for (const key of STARTER_SLOT_FIELDS.filter(k => !['kind', 'organisationName'].includes(k))) {
            uuid(slot[key]); if (used.has(slot[key])) fail(); used.add(slot[key]);
        }
    }
    subject(source.subjectKey);
    if (preparation.planId !== account.planId || preparation.planSha256 !== account.planSha256 ||
        source.issuerSubjectKey !== source.subjectKey || offer.contact.email !== account.email ||
        ['tenantId', 'organisationId', 'organisationName', 'grantId', 'scheduleId', 'kind'].some(k => offer[k] !== slot[k]) ||
        offer.accountType !== account.accountType || account.activation && account.activation.subjectKey !== source.subjectKey ||
        source.createdAt < account.createdAt) fail();
    const result = { ...preparation, accountId: account.accountId, email: account.email, ordinal, slot, source };
    return freeze(result);
}
function retainedStarterPreparation(input) {
    const value = fields(copy(input, 131072), ['planId', 'planSha256', 'accountType', 'kind', 'scope', 'subjectKey',
        'invitationId', 'createdAt', 'schedule', 'terms', 'representativeAuthorityEvidenceId', 'initialState',
        'accountId', 'email', 'ordinal', 'slot', 'source']);
    uuid(value.accountId);
    fields(value.slot, STARTER_SLOT_FIELDS);
    const ids = STARTER_SLOT_FIELDS.filter(k => !['kind', 'organisationName'].includes(k));
    ids.forEach(k => uuid(value.slot[k]));
    if (new Set([value.accountId, ...ids.map(k => value.slot[k])]).size !== ids.length + 1) fail();
    const unlimited = value.source?.offerInput?.consultantOrganisationPolicy === CONSULTANT_ORGANISATION_POLICY;
    if (!Number.isSafeInteger(value.ordinal) || value.ordinal < 0 ||
        value.ordinal > (value.accountType === 'consultant' ? unlimited ? Number.MAX_SAFE_INTEGER : 3 : 0) ||
        value.kind !== (value.ordinal === 0 ? 'own' : 'client') || value.slot.kind !== value.kind) fail();
    const preparation = compileStarterPreparation(value.source);
    for (const key of Object.keys(preparation)) if (!equal(value[key], preparation[key])) fail();
    if (value.email !== value.source.offerInput.contact.email || value.source.issuerSubjectKey !== value.subjectKey ||
        ['tenantId', 'organisationId', 'organisationName', 'grantId', 'scheduleId', 'kind'].some(k => value.source.offerInput[k] !== value.slot[k])) fail();
    for (const k of ['requestId', 'activationId', 'bootstrapOperationId', 'acceptOperationId', 'publicationOperationId',
        'bindingId', 'authorityId', 'membershipId', 'admissionOperationId']) uuid(value.slot[k]);
    return freeze(value);
}
function starterBootstrapCommand(input) {
    const p = retainedStarterPreparation(input);
    return freeze({ ...p.scope, operationId: p.slot.bootstrapOperationId, actorSubjectKey: p.subjectKey,
        type: 'organisation.initialise', expectedRevisions: absent, payload: {} });
}
function compileStarterAdmission({ preparation: raw, acceptance, identity: rawIdentity, occurredAt, accountActivatedAt }) {
    const p = retainedStarterPreparation(raw), identity = normaliseStableIdentity(rawIdentity);
    if (`${identity.identityTenantId}:${identity.oid}` !== p.subjectKey) fail();
    const receipt = validateAcceptanceReceipt(copy(acceptance, 16384));
    const compiled = compileStarterActivation({ preparation: compileStarterPreparation(p.source), accountId: p.accountId,
        activationId: p.slot.activationId, membershipId: p.slot.membershipId, acceptance: receipt,
        occurredAt, accountActivatedAt });
    const command = { operationId: p.slot.publicationOperationId, bindingId: p.slot.bindingId, scope: p.scope,
        membershipId: p.slot.membershipId, invitationId: p.invitationId,
        grantEvidenceId: p.representativeAuthorityEvidenceId, identity, validFrom: occurredAt,
        validUntil: compiled.activationIntent.validUntil };
    const effect = { schemaVersion: 1, operationType: 'publish_existing_membership',
        ...Object.fromEntries(Object.entries(command).filter(([k]) => k !== 'operationId')) };
    const plan = approvedStarterPlan(p.planId);
    const admission = applyAdmissionCommand({ predecessor: null, command: { schemaVersion: 1,
        operationType: 'publishAdmissionDecision', operationId: p.slot.admissionOperationId,
        actorSubjectKey: p.subjectKey, authorityId: p.slot.authorityId, expectedRevision: null, expectedHeadSha256: null,
        payload: { target: p.scope, identityPolicyRef: { policyId: identity.policyId, policyRevision: identity.policyRevision },
            approvedEffectSha256: hash(effect), evidenceRefs: [
                { kind: 'approval', id: plan.approvalRef, sha256: plan.sha256 },
                { kind: 'approval', id: receipt.receiptId, sha256: hash(receipt) },
                { kind: 'effect', id: p.slot.activationId, sha256: hash(compiled.activationIntent) }
            ], validFrom: occurredAt, validUntil: compiled.activationIntent.validUntil } }, facts: { occurredAt } }).record;
    return freeze({ ...compiled, command: { ...command, authorityRef: { authorityId: admission.authorityId,
        revision: admission.revision, sha256: admission.decisionSha256 } },
        activation: { schemaVersion: 1, planId: plan.planId, subjectKey: p.subjectKey, scope: p.scope,
            bindingId: p.slot.bindingId, occurredAt, validFrom: compiled.activationIntent.accountActivatedAt,
            validUntil: compiled.activationIntent.validUntil, acceptance: receipt, admission,
            intent: compiled.activationIntent, identity } });
}
function retainedStarterActivation(preparation, input) {
    const a = fields(copy(input, 262144), ['schemaVersion', 'planId', 'subjectKey', 'scope', 'bindingId',
        'occurredAt', 'validFrom', 'validUntil', 'acceptance', 'admission', 'intent', 'identity']);
    instant(a.occurredAt); instant(a.validFrom); instant(a.validUntil);
    const p = retainedStarterPreparation(preparation);
    const expected = compileStarterAdmission({ preparation: p, acceptance: a.acceptance, identity: a.identity,
        occurredAt: a.occurredAt, accountActivatedAt: p.kind === 'own' ? null : a.validFrom });
    if (!equal(a, expected.activation)) fail();
    return expected;
}
function starterActivationCommands(raw, compiled) {
    const p = retainedStarterPreparation(raw), state = compiled.nextState, invitation = state.membershipState.invitations[0];
    let revisions = { tenant: 0, organisation: 0, membership: 0, entitlement: 0, flags: 0, advisorAssignments: [], usage: [] };
    const commands = [];
    function add(suffix, type, payload, next) {
        commands.push({ ...p.scope, operationId: `starter:${p.slot.activationId}:${suffix}`, actorSubjectKey: p.subjectKey,
            type, expectedRevisions: revisions, payload });
        revisions = { ...revisions, ...next };
    }
    add('grant', 'entitlement.update', state.entitlementState, { entitlement: 1, usage: [{ grantId: p.slot.grantId, revision: 0 }] });
    add('flags', 'flags.update', state.flags, { flags: 1 });
    add('invite', 'membership.command', { action: 'invite', payload: {
        invitationId: p.invitationId, subjectKey: p.subjectKey, roles: ['admin'], validFrom: invitation.validFrom,
        validUntil: invitation.validUntil, grantEvidenceId: invitation.grantEvidenceId, expiresAt: invitation.expiresAt
    } }, { membership: 1 });
    add('accept', 'membership.command', { action: 'accept', payload: { invitationId: p.invitationId,
        membershipId: p.slot.membershipId } }, { membership: 2 });
    add('seat', 'usage.reserve', { grantId: p.slot.grantId, moduleId: 'overview', limit: 'memberships', amount: 1, framework: null },
        { usage: [{ grantId: p.slot.grantId, revision: 1 }] });
    return freeze(commands);
}
module.exports = { compileStarterProvisioning, retainedStarterPreparation, starterBootstrapCommand,
    compileStarterAdmission, retainedStarterActivation, starterActivationCommands };
