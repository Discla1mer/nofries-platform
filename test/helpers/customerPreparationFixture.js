'use strict';
// Canonical synthetic DATA rows for the SQL-only HTTP harness. Native tests
// create these records through the genuine protected preparation operation.
const crypto = require('node:crypto');
const { fixture } = require('../fixtures/dashboardFixture');
const { createMembershipState, applyMembershipCommand } = require('../../api/shared/appLifecycle/membershipDomain');
const { createBootstrapOperations, dataCodec } = require('../../api/shared/appLifecycle/postgresDashboardBootstrap');
const { normaliseActivationApproval, buildActivationCommands } = require('../../api/shared/customerSignup/customerActivation');
const { canonicalDigest: hash } = require('../../api/shared/appLifecycle/dashboardOnboardingDomain');
const { TIERS } = require('../../api/shared/appLifecycle/entitlementDomain');
const clone = value => JSON.parse(JSON.stringify(value));
function preparationFixture(current, identity, now, operator) {
    const at = new Date(now - 1000).toISOString(), end = new Date(Math.min(current.expiresAt, now + 3600000)).toISOString();
    const scope = { tenantId: current.tenantId, organisationId: current.organisationId };
    const source = fixture({ now: new Date(now).toISOString(), organisationId: current.organisationId });
    function reScope(value) {
        if (Array.isArray(value)) return value.map(reScope);
        if (!value || typeof value !== 'object') return value;
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
            key === 'tenantId' ? scope.tenantId : key === 'organisationId' ? scope.organisationId : reScope(item)]));
    }
    const initialState = reScope({ tenantAggregate: source.tenantAggregate, membershipState: {},
        entitlementState: source.entitlementState, flags: source.flags, advisorAssignments: [] });
    initialState.membershipState = applyMembershipCommand(createMembershipState(initialState.tenantAggregate, scope, at),
        initialState.tenantAggregate, { ...scope, expectedRevision: 0, actorSubjectKey: operator, now: at,
            action: 'invite', payload: { invitationId: current.invitationId, subjectKey: current.subjectKey, roles: ['admin'],
                validFrom: at, validUntil: end, grantEvidenceId: 'synthetic-approved-role', expiresAt: end } });
    const approval = normaliseActivationApproval({ schemaVersion: 1, activationId: crypto.randomUUID(),
        approvalRef: 'synthetic-approved-preparation', approvedBy: operator, approvedAt: at, expiresAt: end,
        authoritySha256: hash(current), authorityRevision: current.revision, subjectKey: current.subjectKey,
        invitationId: current.invitationId, membershipId: 'synthetic-member', termsVersion: current.termsVersion,
        termsDigest: current.termsDigest, scheduleId: current.scheduleId, scheduleDigest: current.scheduleDigest,
        scope, identity: { ...identity, oid: current.subjectKey.split(':')[1],
            issuer: `https://login.microsoftonline.com/${identity.identityTenantId}/v2.0` },
        bootstrapOperationId: crypto.randomUUID(), acceptOperationId: crypto.randomUUID(),
        publicationOperationId: crypto.randomUUID(), bindingId: current.bindingId || crypto.randomUUID(),
        authorityRef: { authorityId: crypto.randomUUID(), revision: 0, sha256: 'a'.repeat(64) },
        bootstrapExpectedRevisions: { tenant: null, organisation: null, membership: null, entitlement: null,
            flags: null, advisorAssignments: [], usage: [] }, initialState });
    const command = buildActivationCommands(approval).bootstrap;
    const reference = createBootstrapOperations({ clock: () => at, authoriseAdministration: () => false })
        .prepareInitialisation(command, initialState).expectedReference;
    const snapshot = { ...clone(initialState), usage: initialState.entitlementState.grants
        .filter(grant => Object.hasOwn(TIERS, grant.code)).map(dataCodec.newUsage) };
    const revisions = dataCodec.revisionVector(snapshot);
    const result = { operationId: command.operationId, type: command.type, reserved: false, resultRevisions: revisions, usage: null };
    if (hash(result) !== reference.resultSha256) throw new Error('Synthetic preparation result mismatch');
    const payload = { schemaVersion: 1, ...scope, operationId: command.operationId, actorSubjectKey: operator,
        operationType: command.type, intentSha256: reference.intentSha256, resultSha256: reference.resultSha256,
        occurredAt: at, expectedRevisions: command.expectedRevisions, resultRevisions: revisions, result,
        event: { schemaVersion: 1, category: 'dashboard_transaction', outcome: 'committed', action: command.type,
            actorSubjectKey: operator, ...scope, operationId: command.operationId, effect: 'authority_changed' } };
    if (current.bindingId) snapshot.membershipState = applyMembershipCommand(snapshot.membershipState,
        snapshot.tenantAggregate, { ...scope, expectedRevision: snapshot.membershipState.revision,
            actorSubjectKey: current.subjectKey, now: at, action: 'accept',
            payload: { invitationId: current.invitationId, membershipId: 'synthetic-member' } });
    const row = value => ({ tenant_id: scope.tenantId, organisation_id: scope.organisationId,
        schema_version: 1, revision: String(value.revision), payload: clone(value) });
    const tables = {
        dashboard_tenants: [row(snapshot.tenantAggregate.tenant)],
        dashboard_organisations: [row(snapshot.tenantAggregate.organisations[0])],
        dashboard_membership_states: [row(snapshot.membershipState)],
        dashboard_entitlement_states: [row(snapshot.entitlementState)],
        dashboard_feature_flags: [row(snapshot.flags)], dashboard_advisor_assignments: [],
        dashboard_usage: snapshot.usage.map(value => ({ ...row(value), grant_id: value.grantId })),
        dashboard_operation_receipts: [{ tenant_id: scope.tenantId, organisation_id: scope.organisationId,
            schema_version: 1, operation_id: command.operationId, intent_sha256: reference.intentSha256,
            result_sha256: reference.resultSha256, payload }]
    };
    return { approval, reference, tables };
}
module.exports = { preparationFixture };
