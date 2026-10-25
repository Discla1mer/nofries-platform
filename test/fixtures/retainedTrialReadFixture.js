'use strict';

// Synthetic trusted-port and database data only; never evidence of live login.
const crypto = require('node:crypto');
const domain = require('../../api/shared/appLifecycle/dashboardOnboardingDomain');
const { projectCurrentRow, hash } = require('../../api/shared/appLifecycle/dashboardRuntimeRecords');
const { createStarterAccountAllocator } = require('../../api/shared/customerSignup/starterAccountAllocation');
const { compileStarterProvisioning, compileStarterAdmission } = require('../../api/shared/customerSignup/starterProvisioning');
const { THREE_MONTH_PLAN_ID } = require('../../api/shared/customerSignup/customerStarterPlan');
const { ACCEPTED_PROFILE_REF } = require('../../api/shared/assessmentEngine/ncscAssessmentEvaluator');
const ncsc = require('../../api/shared/assessmentLifecycle/postgresNcscAssessmentStore');
const { allResponses, createCommand, saveCommand, submitCommand } = require('./ncscAssessmentFixture');
const clone = value => JSON.parse(JSON.stringify(value));
const START = '2026-11-01T12:00:00.000Z', NOW = '2027-02-02T12:00:00.000Z';

async function retainedTrialFixture({ client = false, identity: suppliedIdentity, planId = THREE_MONTH_PLAN_ID, email = 'synthetic@example.test' } = {}) {
    const identity = suppliedIdentity || { policyId: 'synthetic-retained-trial', policyRevision: 1, issuer: 'https://identity.example.test/v2.0',
        identityTenantId: crypto.randomUUID(), oid: crypto.randomUUID(), audience: 'synthetic-audience' };
    const actor = identity.identityTenantId + ':' + identity.oid;
    let row, at = Date.parse(START), activationFact;
    const allocator = createStarterAccountAllocator({ planId, now: () => at,
        captureOwner: async () => ({ subjectKey: actor, email }), readActivation: async () => activationFact,
        store: { load: async () => row ? clone(row) : null, create: async (_, record) => { row = { record: clone(record), version: 1 }; return true; },
            replace: async (_, version, record) => { if (row.version !== version) return false; row = { record: clone(record), version: version + 1 }; return true; } } });
    const requestId = crypto.randomUUID();
    const proof = { schemaVersion: 1, source: 'external-id-signup', requestId, subjectKey: actor,
        providerKey: 'a'.repeat(64), authenticationSha256: 'b'.repeat(64), email, organisationName: 'Synthetic retained trial',
        accountType: client ? 'consultant' : 'company', createdAt: at, verifiedAt: at, expiresAt: at + 3600000 };
    let account = await allocator.reserveInitial(proof);
    const scopes = new Map();
    function prepare(slot, occurredAt) {
        const p = compileStarterProvisioning({ account, requestId: slot.requestId, source: {
            offerInput: { ...(planId === THREE_MONTH_PLAN_ID ? { planId } : {}),
                ...Object.fromEntries(['tenantId', 'organisationId', 'organisationName', 'grantId', 'scheduleId', 'kind'].map(k => [k, slot[k]])),
                accountType: account.accountType, contact: { name: 'Synthetic Owner', role: 'Owner', address: 'Synthetic address', registrationId: null,
                    email, authorityEvidenceId: crypto.randomUUID() }, framework: { moduleId: 'cyber_security', profileId: ACCEPTED_PROFILE_REF.profileId,
                    version: ACCEPTED_PROFILE_REF.profileVersion, scoringVersion: 'synthetic' } },
            subjectKey: actor, issuerSubjectKey: actor, invitationId: crypto.randomUUID(), createdAt: occurredAt } });
        const acceptance = { receiptId: crypto.randomUUID(), invitationId: p.invitationId, subjectKey: actor, ...p.scope, ...p.terms,
            scheduleId: p.schedule.scheduleId, scheduleDigest: p.schedule.scheduleDigest, acceptedAt: Date.parse(occurredAt), status: 'pending_admission', dashboardAccess: false };
        const compiled = compileStarterAdmission({ preparation: p, acceptance, identity, occurredAt,
            accountActivatedAt: slot.kind === 'own' ? null : START });
        const { usage, ...currentAuthority } = compiled.nextState;
        const binding = domain.publishExistingMembershipBinding({ receiptId: crypto.randomUUID(), operationId: slot.publicationOperationId,
            scope: p.scope, membershipId: slot.membershipId, invitationId: p.invitationId, grantEvidenceId: p.representativeAuthorityEvidenceId,
            identity, bindingId: slot.bindingId, validFrom: occurredAt, validUntil: compiled.activation.validUntil,
            authorityRef: compiled.command.authorityRef, actorSubjectKey: actor, at: occurredAt, currentAuthority }).binding;
        const fact = { retained: { preparation: clone(p), activation: clone(compiled.activation) }, binding: clone(binding),
            admission: clone(compiled.activation.admission), snapshot: clone(compiled.nextState) };
        scopes.set(slot.tenantId, fact); return fact;
    }
    const original = prepare(account.organisations[0], START);
    activationFact = { email, subjectKey: actor, accountId: account.accountId, organisationId: account.organisations[0].organisationId,
        receiptId: account.organisations[0].activationId, activatedAt: START };
    account = await allocator.activate({});
    if (client) {
        at += 3600000;
        const slot = await allocator.reserveClient({}, { requestId: crypto.randomUUID(), organisationName: 'Synthetic client' });
        account = clone(row.record); prepare(slot, new Date(at).toISOString());
    }
    const slot = account.organisations.at(-1), selected = scopes.get(slot.tenantId);
    const scope = { ...selected.retained.preparation.scope, assessmentId: 'saved-assessment' };
    let previous = null;
    const versions = [createCommand(), saveCommand(), submitCommand()].map((raw, i) => {
        const intent = { ...scope, actorSubjectKey: actor, action: raw.action, expectedRevision: raw.expectedRevision, payload: raw.payload };
        previous = ncsc.makeVersion(intent, raw.idempotencyKey, previous, selected.snapshot.tenantAggregate,
            new Date(Date.parse(START) + 86400000 + i * 1000).toISOString());
        return previous;
    });
    const head = { tenant_id: slot.tenantId, organisation_id: slot.organisationId, assessment_id: scope.assessmentId,
        schema_version: 1, revision: 2, payload_sha256: versions[2].revisionSha256 };
    const versionRows = versions.map(v => ({ tenant_id: slot.tenantId, organisation_id: slot.organisationId,
        assessment_id: scope.assessmentId, schema_version: 1, revision: v.envelope.revision, payload_sha256: v.revisionSha256,
        parent_revision: v.parentRevision, parent_sha256: v.parentSha256, payload: v.envelope }));
    const instance = { schemaVersion: 1, instanceId: crypto.randomUUID(), revision: 1, restoreEpoch: crypto.randomUUID(),
        ingressStatus: 'enabled', changedAt: START, evidenceRef: 'synthetic-retained-read', evidenceSha256: 'e'.repeat(64) };
    const state = { now: NOW, subject: { schemaVersion: 2, subjectKey: actor, email, revision: 0, status: 'active',
        invitationDigest: 'd'.repeat(64), invitationId: original.retained.preparation.invitationId,
        tenantId: original.binding.scope.tenantId, organisationId: original.binding.scope.organisationId,
        ...original.retained.preparation.terms, scheduleId: original.retained.preparation.schedule.scheduleId,
        scheduleDigest: original.retained.preparation.schedule.scheduleDigest, bindingId: original.binding.bindingId,
        expiresAt: Date.parse('2027-02-08T12:00:00.000Z'), accountType: account.accountType },
        account: clone(account), capture: { requestId: crypto.randomUUID(), deadline: '2027-02-02T12:00:30.000Z',
            sessionSha256: 'c'.repeat(64), kind: 'customer', identityPayload: identity, instanceId: instance.instanceId,
            restoreEpoch: instance.restoreEpoch, issuedAt: '2027-02-02T11:59:00.000Z', expiresAt: '2027-02-02T13:00:00.000Z',
            operatorIssuanceProof: null, discovery: null }, instance, gate: null, missingHead: false, ambiguous: false, hook: null };
    const queries = []; let tenant;
    function records(table) {
        const f = scopes.get(tenant);
        if (table === 'dashboard_runtime_instance') return [projectCurrentRow('instance', state.instance, { receiptId: '30000000-0000-4000-8000-000000000001' })];
        if (table === 'dashboard_session_gates') return state.gate ? [projectCurrentRow('session', state.gate)] : [];
        if (table === 'dashboard_starter_accounts') return [{ account_id: account.accountId,
            email_sha256: crypto.createHash('sha256').update('nofries:starter-email:v1\0' + email).digest('hex'),
            subject_key: actor, account_type: account.accountType, activated_at: START }];
        if (table === 'dashboard_starter_scopes') return [f.retained];
        if (table === 'dashboard_identity_bindings') return [projectCurrentRow('binding', f.binding)];
        if (table === 'dashboard_admission_authorities') return [projectCurrentRow('authority', f.admission)];
        if (table === 'dashboard_admission_decisions') return [projectCurrentRow('admission', f.admission)];
        const s = f?.snapshot;
        const rowFor = payload => [{ tenant_id: tenant, organisation_id: f.binding.scope.organisationId, schema_version: 1, revision: payload.revision, payload }];
        if (table === 'dashboard_tenants') return [{ tenant_id: tenant, schema_version: 1, revision: s.tenantAggregate.tenant.revision, payload: s.tenantAggregate.tenant }];
        if (table === 'dashboard_organisations') return rowFor(s.tenantAggregate.organisations[0]);
        if (table === 'dashboard_membership_states') return rowFor(s.membershipState);
        if (table === 'dashboard_entitlement_states') return rowFor(s.entitlementState);
        if (table === 'dashboard_feature_flags') return rowFor(s.flags);
        if (table === 'dashboard_advisor_assignments') return [];
        if (table === 'dashboard_usage') return s.usage.map(payload => ({ tenant_id: tenant, organisation_id: f.binding.scope.organisationId,
            grant_id: payload.grantId, schema_version: 1, revision: payload.revision, payload }));
        throw new Error('unexpected fixture table: ' + table);
    }
    const query = async (sql, params) => {
        queries.push({ sql, params });
        if (state.hook) await state.hook(sql, params);
        if (sql.includes('pg_advisory_xact_lock_shared')) return { rows: [] };
        if (sql.includes('set_config')) { tenant = params[0]; return { rows: [] }; }
        const table = /FROM nofries\.([a-z_]+)/.exec(sql)?.[1];
        if (table === 'dashboard_ncsc_assessments') return { rows: state.missingHead || params[2] !== scope.assessmentId ? [] : [clone(head)] };
        if (table === 'dashboard_ncsc_assessment_revisions') return { rows: params[2] !== scope.assessmentId ? [] : clone(versionRows.filter(v => v.revision >= params[3]).slice(0, 16)) };
        return { rows: clone(records(table)) };
    };
    const options = { captureRequest: async () => clone(state.capture), readSubject: async () => clone(state.subject),
        accountStore: { load: async () => ({ record: clone(state.account), version: 1 }) }, clock: () => state.now,
        database: { async withTenantTransaction(id, work) { tenant = id; const result = await work({ query });
            if (state.ambiguous) throw new Error('synthetic ambiguous COMMIT'); return result; } } };
    return { options, state, account, actor, identity, email, slot, scopes, original, selected, versions, head, versionRows, queries,
        input: { bindingId: slot.bindingId, assessmentId: scope.assessmentId }, records, allResponses, hash };
}

module.exports = { retainedTrialFixture, clone, START, NOW };
