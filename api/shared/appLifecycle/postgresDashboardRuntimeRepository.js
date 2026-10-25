'use strict';

// Private, uninstalled POR010 persistence capabilities. HTTP/auth composition
// belongs to the subsequent runtime boundary, not this module.
const crypto = require('node:crypto');
const { isProxy } = require('node:util').types;
const domain = require('./dashboardOnboardingDomain');
const { createPostgresDatabase, PostgresDatabaseError } = require('../database/postgres');
const { createBootstrapOperations, dataStorage, DashboardPersistenceError } = require('./postgresDashboardBootstrap');
const { createPostgresDashboardRepository } = require('./postgresDashboardRepository');
const { createPostgresSignupAcceptanceJournal } = require('../customerSignup/postgresSignupAcceptanceJournal');
const { createPostgresSignupRegistrationStore, readSignupRegistrationLayout, lockSignupRegistrationHeader } = require('../customerSignup/postgresSignupRegistrationStore');
const customerActivation = require('../customerSignup/customerActivation');
const starterProvisioning = require('../customerSignup/starterProvisioning');
const { createPreparationDiagnostic, attachPreparationDiagnostic, queryCheckpoint } = require('../customerSignup/signupPreparationDiagnostic');
const { authority: customerAuthority } = require('../customerSignup/customerAuthority');
const { resolveActiveMembership } = require('./membershipDomain');
const { resolveOrganisation } = require('./tenantDomain');
const { resolveEntitlements } = require('./entitlementDomain');
const { copy, fields, freeze, canonical, hash, equal, uuid, digest, id, revision, instant, scope, subject, unicode,
    CURRENT_COLUMNS, prepareCurrentRow, projectCurrentRow, instanceRecordValue, normalizeInstance } = require('./dashboardRuntimeRecords');
const { RUNTIME_READ_RESOURCES, normaliseRuntimeReadEventInput, normaliseRuntimeReadAudit } = require('./dashboardRuntimeEvents');
const { normaliseSelector: administrationSelector } = require('../dashboardAdmin/service');
const { normaliseAuditEnvelope } = require('../dashboardAdmin/auditEnvelope');
const administrationAudit = require('../dashboardAdmin/postgresAuditWriter');
const { normaliseSignupAuthority } = require('../dashboardAdmin/signupAuthority');
const { normaliseSignupAuditEnvelope, createSignupAuditEnvelope } = require('../dashboardAdmin/signupAuditEnvelope');
const administrationSignupAudit = require('../dashboardAdmin/postgresSignupAuditWriter');

const MAX_OPERATION = 524288, MAX_EFFECT = 262144, MAX_SMALL = 16384;

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const fail = (code, status) => { throw new domain.DashboardOnboardingError(code, status); };
const invalid = () => fail('onboarding_input_invalid', 400);
const denied = () => fail('onboarding_access_denied', 403);
const conflict = () => fail('onboarding_conflict', 409);
const large = () => fail('onboarding_request_too_large', 413);
const bad = () => fail('onboarding_record_invalid', 503);
const unavailable = () => fail('onboarding_unavailable', 503);
const ambiguous = () => fail('onboarding_outcome_ambiguous', 503);
function retained(work) { try { return work(); } catch (_) { bad(); } }

const subjectOf = identity => identity.identityTenantId + ':' + identity.oid;
function authorityRef(value) { fields(value, ['authorityId', 'revision', 'sha256']); uuid(value.authorityId); revision(value.revision); digest(value.sha256); return value; }
function expected(value, key, hashKey) {
    if (value[key] === null || value[hashKey] === null) { if (value[key] !== null || value[hashKey] !== null) invalid(); }
    else { revision(value[key]); digest(value[hashKey]); }
}

const SESSION_OPS = ['initializeOperatorSession', 'activateCustomerSession', 'recordProofAndActivateDiscovery', 'selectBinding', 'revokeSession'];
const CASE_OPS = ['createCase', 'approveCase', 'revokeCase', 'denyCase', 'expireCase'];
const ADMISSION_OPS = ['publishAdmissionDecision', 'withdrawAdmissionDecision'];
const INSTANCE_OPS = ['initializeRuntimeInstance', 'fenceRestoreEpoch', 'enableRuntimeIngress'];
const OPERATOR_OPS = [...CASE_OPS, 'publishExistingMembershipBinding'];
const COMMAND_FIELDS = Object.freeze({
    initializeOperatorSession: ['operationId'], activateCustomerSession: ['operationId', 'bindingId'],
    recordProofAndActivateDiscovery: ['operationId'], selectBinding: ['operationId', 'bindingId', 'expectedGeneration'], revokeSession: ['operationId'],
    createCase: ['operationId', 'caseId', 'templateRef', 'template', 'acceptBefore', 'authorityRef'],
    approveCase: ['operationId', 'caseId', 'expectedRevision', 'expectedHeadSha256', 'approvalId', 'acceptBefore', 'authorityRef'],
    revokeCase: ['operationId', 'caseId', 'expectedRevision', 'expectedHeadSha256', 'authorityRef'],
    denyCase: ['operationId', 'caseId', 'expectedRevision', 'expectedHeadSha256', 'authorityRef'],
    expireCase: ['operationId', 'caseId', 'expectedRevision', 'expectedHeadSha256'],
    acceptStagedOnboarding: ['operationId', 'approvalId', 'approvalRevision'],
    publishExistingMembershipBinding: ['operationId', 'bindingId', 'scope', 'membershipId', 'invitationId', 'grantEvidenceId', 'identity', 'validFrom', 'validUntil', 'authorityRef'],
    publishAdmissionDecision: ['operationId', 'actorSubjectKey', 'authorityId', 'expectedRevision', 'expectedHeadSha256', 'payload'],
    withdrawAdmissionDecision: ['operationId', 'actorSubjectKey', 'authorityId', 'expectedRevision', 'expectedHeadSha256', 'payload'],
    initializeRuntimeInstance: ['operationId', 'actorSubjectKey', 'expectedRevision', 'expectedRecordSha256', 'restoreEpoch', 'evidenceRef', 'evidenceSha256'],
    fenceRestoreEpoch: ['operationId', 'actorSubjectKey', 'expectedRevision', 'expectedRecordSha256', 'restoreEpoch', 'evidenceRef', 'evidenceSha256'],
    enableRuntimeIngress: ['operationId', 'actorSubjectKey', 'expectedRevision', 'expectedRecordSha256', 'restoreEpoch', 'evidenceRef', 'evidenceSha256']
});
function commandInput(operationType, input) {
    const snapshot = copy(input);
    const keys = COMMAND_FIELDS[operationType];
    const value = fields(snapshot, operationType === 'activateCustomerSession' && own(snapshot, 'scope') ? [...keys, 'scope'] : keys); uuid(value.operationId);
    for (const key of ['caseId', 'bindingId', 'approvalId', 'authorityId', 'restoreEpoch']) if (own(value, key)) uuid(value[key]);
    for (const key of ['membershipId', 'invitationId', 'grantEvidenceId', 'evidenceRef']) if (own(value, key)) id(value[key]);
    for (const key of ['expectedGeneration', 'evidenceSha256']) if (own(value, key)) digest(value[key]);
    if (own(value, 'expectedHeadSha256')) expected(value, 'expectedRevision', 'expectedHeadSha256');
    if (own(value, 'expectedRecordSha256')) expected(value, 'expectedRevision', 'expectedRecordSha256');
    if (own(value, 'approvalRevision')) revision(value.approvalRevision);
    if (own(value, 'actorSubjectKey')) subject(value.actorSubjectKey);
    if (own(value, 'scope')) scope(value.scope);
    if (own(value, 'authorityRef')) authorityRef(value.authorityRef);
    for (const key of ['acceptBefore', 'validFrom', 'validUntil']) if (own(value, key)) instant(value[key]);
    if (own(value, 'identity')) value.identity = domain.normaliseStableIdentity(value.identity);
    if (own(value, 'template')) value.template = domain.normaliseTemplate(value.template);
    if (own(value, 'templateRef')) id(value.templateRef);
    if (ADMISSION_OPS.includes(operationType)) {
        const p = fields(value.payload, ['target', 'identityPolicyRef', 'approvedEffectSha256', 'evidenceRefs', 'validFrom', 'validUntil']);
        scope(p.target); fields(p.identityPolicyRef, ['policyId', 'policyRevision']); id(p.identityPolicyRef.policyId); revision(p.identityPolicyRef.policyRevision);
        digest(p.approvedEffectSha256); instant(p.validFrom); instant(p.validUntil); if (p.validFrom >= p.validUntil) invalid();
        evidence(p.evidenceRefs);
    }
    if (own(value, 'validFrom') && value.validFrom >= value.validUntil) invalid();
    return freeze(value);
}
function evidence(value) {
    if (!Array.isArray(value) || value.length > 16) invalid(); const seen = new Set();
    for (const row of value) { fields(row, ['kind', 'id', 'sha256']); if (!domain.EVIDENCE_KINDS.includes(row.kind)) invalid(); id(row.id); digest(row.sha256); const key = row.kind + ':' + row.id; if (seen.has(key)) invalid(); seen.add(key); }
    value.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id)); return value;
}

function configuration(input, maintenance) {
    const common = ['pool', 'clock', 'instanceId', 'historyBudget', 'readExternalRuntimeEpoch', 'newId'];
    if (own(input, 'beforeQuery')) common.push('beforeQuery');
    if (!maintenance && own(input, 'readCustomerActivation')) common.push('readCustomerActivation');
    if (!maintenance && own(input, 'readStarterProvisioning')) common.push('readStarterProvisioning');
    const extra = maintenance ? ['authoriseMaintenanceOperation'] : ['captureRequest', 'readVerifiedOnboardingProof', 'readPreparedCaseCapability', 'authoriseOperatorOperation', 'newGenerationToken'];
    fields(input, common.concat(extra));
    if (!input.pool || typeof input.pool.connect !== 'function' || typeof input.pool.end !== 'function') invalid();
    for (const key of ['clock', 'readExternalRuntimeEpoch', 'newId', ...extra]) if (typeof input[key] !== 'function') invalid();
    if (own(input, 'beforeQuery') && typeof input.beforeQuery !== 'function') invalid();
    if (own(input, 'readCustomerActivation') && typeof input.readCustomerActivation !== 'function') invalid();
    if (own(input, 'readStarterProvisioning') && typeof input.readStarterProvisioning !== 'function') invalid();
    uuid(input.instanceId);
    const budget = fields(copy(input.historyBudget, MAX_SMALL), ['maxRecords', 'maxBytes', 'maxDurationMs']);
    for (const [key, maximum] of [['maxRecords', 4096], ['maxBytes', 67108864], ['maxDurationMs', 60000]]) {
        revision(budget[key]); if (!budget[key] || budget[key] > maximum) invalid();
    }
    return Object.freeze({ ...input, historyBudget: freeze(budget), maintenance });
}
function newInvocation(options, request, operationType, command) {
    let last, deadline, records = 0, bytes = 0;
    const inv = { options, request, operationType, command, capture: null, externalEpoch: null, recovering: false, committed: false,
        failure: null, attempt: null };
    inv.unavailable = () => {
        if (!inv.failure) inv.failure = new domain.DashboardOnboardingError('onboarding_unavailable', 503);
        throw inv.failure;
    };
    inv.now = () => {
        if (inv.failure) throw inv.failure;
        let now; try { now = instant(options.clock()); } catch (_) { inv.unavailable(); }
        if (last && now < last) inv.unavailable(); last = now;
        if (deadline && now >= deadline) inv.unavailable();
        const attempt = inv.attempt;
        if (attempt && attempt.finalAuthority) {
            if (attempt.finalFailure) throw attempt.finalFailure;
            try { finalAuthorityAt(attempt.finalAuthority, now); }
            catch (error) { attempt.finalFailure = error; throw error; }
        }
        return now;
    };
    const start = inv.now();
    try { const n = Date.parse(start) + options.historyBudget.maxDurationMs; if (!Number.isSafeInteger(n)) inv.unavailable(); deadline = instant(new Date(n).toISOString()); } catch (_) { inv.unavailable(); }
    inv.intersect = value => { try { instant(value); } catch (_) { inv.unavailable(); } if (value < deadline) deadline = value; inv.now(); };
    inv.remainingMs = at => {
        const remaining = Date.parse(deadline) - Date.parse(at);
        if (!Number.isSafeInteger(remaining) || remaining <= 0 || remaining > options.historyBudget.maxDurationMs) inv.unavailable();
        return remaining;
    };
    inv.charge = (input, envelopes) => {
        inv.now();
        const bounded = retained(() => copy(input, 8388608));
        records += envelopes; bytes += Buffer.byteLength(canonical(bounded), 'utf8');
        if (records > options.historyBudget.maxRecords || bytes > options.historyBudget.maxBytes) inv.unavailable();
        inv.now(); return bounded;
    };
    inv.decode = (value, codec, max = MAX_EFFECT) => { const bounded = retained(() => copy(value, max)); inv.charge(bounded, 1); const result = retained(() => codec(bounded)); inv.now(); return result; };
    inv.pageSize = () => { inv.now(); const remaining = options.historyBudget.maxRecords - records; if (remaining <= 0) inv.unavailable(); return Math.min(16, remaining); };
    inv.query = async (tx, text, params = []) => {
        const diagnostic = inv.preparationDiagnostic, previous = diagnostic && diagnostic.current();
        if (diagnostic) diagnostic.mark(queryCheckpoint(text) || previous);
        try {
            inv.now(); let result;
            try { result = await tx.query(text, params); }
            catch (error) { throw error instanceof PostgresDatabaseError ? error : new PostgresDatabaseError('postgres_query_failed'); }
            inv.now(); return result;
        } catch (error) { if (diagnostic) diagnostic.fail(error); throw error; }
        finally { if (diagnostic) diagnostic.mark(previous); }
    };
    inv.provider = async (name, ...args) => { inv.now(); let value; try { value = await options[name](...args); } catch (_) { unavailable(); } inv.now(); return value; };
    inv.identifier = () => { let value; try { value = uuid(options.newId()); } catch (_) { unavailable(); } return value; };
    inv.token = () => { let value; try { value = digest(options.newGenerationToken()); } catch (_) { unavailable(); } return value; };
    return inv;
}

function captured(value, instanceId, operationType) {
    const v = fields(copy(value, MAX_SMALL), ['requestId', 'deadline', 'sessionSha256', 'kind', 'identityPayload', 'instanceId', 'restoreEpoch', 'issuedAt', 'expiresAt', 'operatorIssuanceProof', 'discovery']);
    uuid(v.requestId); instant(v.deadline); digest(v.sessionSha256); uuid(v.instanceId); uuid(v.restoreEpoch); instant(v.issuedAt); instant(v.expiresAt);
    if (v.instanceId !== instanceId || v.issuedAt >= v.expiresAt || !['operator_dashboard', 'onboarding_discovery', 'customer'].includes(v.kind)) denied();
    v.identityPayload = domain.normaliseStableIdentity(v.identityPayload);
    if (v.kind === 'onboarding_discovery') { fields(v.discovery, ['caseId', 'proofId']); uuid(v.discovery.caseId); uuid(v.discovery.proofId); }
    else if (v.discovery !== null) invalid();
    if (v.kind === 'operator_dashboard') {
        if (v.operatorIssuanceProof === null) { if (operationType !== 'revokeSession') denied(); }
        else {
            v.operatorIssuanceProof = domain.normaliseOperatorIssuanceProof(v.operatorIssuanceProof);
            const p = v.operatorIssuanceProof;
            if (p.sessionSha256 !== v.sessionSha256 || p.identitySha256 !== hash(v.identityPayload) || p.instanceId !== v.instanceId || p.restoreEpoch !== v.restoreEpoch || p.issuedAt !== v.issuedAt || p.expiresAt !== v.expiresAt) denied();
        }
    } else if (v.operatorIssuanceProof !== null) invalid();
    return freeze(v);
}
async function capture(inv) {
    const value = await inv.provider('captureRequest', inv.request); if (value === null) denied();
    let normalized; try { normalized = captured(value, inv.options.instanceId, inv.operationType); } catch (error) { if (error instanceof domain.DashboardOnboardingError && error.statusCode === 403) throw error; unavailable(); }
    if (inv.capture && !equal(inv.capture, normalized)) denied(); inv.capture = normalized; inv.intersect(normalized.deadline);
    const at = inv.now();
    if (at < normalized.issuedAt || inv.operationType !== 'revokeSession' && at >= normalized.expiresAt) denied();
    return normalized;
}
async function externalEpoch(inv) {
    const result = await inv.provider('readExternalRuntimeEpoch');
    let value; try { value = fields(copy(result, MAX_SMALL), ['instanceId', 'restoreEpoch']); uuid(value.instanceId); uuid(value.restoreEpoch); } catch (_) { unavailable(); }
    if (value.instanceId !== inv.options.instanceId || inv.capture && value.restoreEpoch !== inv.capture.restoreEpoch) denied();
    if (inv.externalEpoch && !equal(inv.externalEpoch, value)) denied(); inv.externalEpoch = freeze(value); return value;
}
function permit(predicate, value) {
    let answer; try { answer = predicate(freeze(copy(value))); } catch (_) { denied(); }
    if (answer instanceof Promise) answer.catch(() => {}); if (answer !== true) denied();
}
function purpose(inv) {
    const kind = inv.capture.kind, op = inv.operationType;
    if ((OPERATOR_OPS.includes(op) || op === 'initializeOperatorSession') && kind !== 'operator_dashboard' &&
            !(inv.starter === true && op === 'publishExistingMembershipBinding' && kind === 'customer') ||
        op === 'activateCustomerSession' && kind !== 'customer' ||
        ['recordProofAndActivateDiscovery', 'acceptStagedOnboarding', 'readOnboardingStatus'].includes(op) && kind !== 'onboarding_discovery' ||
        ['selectBinding', 'discoverBindings'].includes(op) && kind === 'onboarding_discovery' ||
        (isSelectedResourceRead(op) || op === 'readDashboardReadiness') && !['operator_dashboard', 'customer'].includes(kind)) denied();
}
function isSelectedResourceRead(action) {
    return ['readDashboardAdmission', 'readDashboardBootstrap', 'readDashboardAsset'].includes(action);
}

const TABLE = Object.freeze({
    instance: 'dashboard_runtime_instance', authority: 'dashboard_admission_authorities', admission: 'dashboard_admission_decisions',
    case: 'dashboard_onboarding_cases', decision: 'dashboard_onboarding_decisions', proof: 'dashboard_onboarding_proofs',
    binding: 'dashboard_identity_bindings', session: 'dashboard_session_gates', receipt: 'dashboard_runtime_receipts', audit: 'dashboard_runtime_audit'
});
const COLUMNS = Object.freeze({
    instance: CURRENT_COLUMNS.instance,
    authority: CURRENT_COLUMNS.authority,
    admission: CURRENT_COLUMNS.admission,
    case: 'case_id tenant_id organisation_id capability_sha256 created_at accept_before head_revision head_sha256 status candidate_proof_id identity_sha256 approval_id approval_revision approval_sha256 accepted_receipt_id updated_at'.split(' '),
    decision: 'case_id revision tenant_id organisation_id parent_revision parent_sha256 decision decision_sha256 occurred_at actor_subject_key operation_id approval_id candidate_proof_id candidate_proof_sha256 candidate_identity_sha256 payload'.split(' '),
    proof: 'proof_id case_id tenant_id organisation_id case_revision identity_sha256 identity_payload subject_key authentication_sha256 verified_at fresh_until proof_sha256 operation_id'.split(' '),
    binding: CURRENT_COLUMNS.binding,
    session: CURRENT_COLUMNS.session,
    receipt: 'receipt_id anchor_kind anchor_session_sha256 anchor_case_id anchor_authority_id anchor_binding_id anchor_instance_id runtime_instance_id tenant_id organisation_id scope_json operation_type operation_id actor_subject_key occurred_at intent_sha256 result_sha256 audit_event_id audit_event_sha256 acceptance_case_id related_case_id related_proof_id related_identity_sha256 instance_result_revision instance_result_sha256 payload'.split(' '),
    audit: 'event_id session_sha256 instance_id authority_id request_id tenant_id organisation_id scope_json occurred_at event_type event_sha256 operation_id payload'.split(' ')
});
const PRIMARY = Object.freeze({ instance: ['instance_id'], authority: ['authority_id'], admission: ['authority_id', 'revision'], case: ['case_id'], decision: ['case_id', 'revision'], proof: ['proof_id'], binding: ['binding_id'], session: ['session_sha256'], receipt: ['receipt_id'], audit: ['event_id'] });
const MUTABLE = Object.freeze({
    instance: 'revision restore_epoch ingress_status changed_at evidence_ref evidence_sha256 record_sha256 head_receipt_id'.split(' '),
    authority: 'head_revision head_sha256 status updated_at'.split(' '),
    case: 'head_revision head_sha256 status candidate_proof_id identity_sha256 approval_id approval_revision approval_sha256 accepted_receipt_id updated_at'.split(' '),
    binding: ['revision', 'status', 'updated_at'],
    session: 'status revision selection_generation generation_token selected_binding_id selected_tenant_id selected_organisation_id updated_at revoked_at'.split(' ')
});
const JSON_COLUMNS = new Set(['payload', 'identity_payload', 'scope_json']);
const NUMBER_COLUMNS = new Set(['revision', 'head_revision', 'parent_revision', 'case_revision', 'approval_revision', 'authority_revision', 'selection_generation', 'instance_result_revision']);
const TIME_COLUMNS = new Set(['created_at', 'updated_at', 'changed_at', 'occurred_at', 'accept_before', 'verified_at', 'fresh_until', 'valid_from', 'valid_until', 'issued_at', 'expires_at', 'revoked_at']);
const snake = key => key.replace(/[A-Z]/g, c => '_' + c.toLowerCase());
const sqlScope = value => ({ tenant_id: value ? value.tenantId : null, organisation_id: value ? value.organisationId : null });
const readScope = row => row.tenant_id === null && row.organisation_id === null ? null : scope({ tenantId: row.tenant_id, organisationId: row.organisation_id });
function rowValues(kind, value, meta = {}) {
    let result;
    switch (kind) {
        case "instance": result = projectCurrentRow(kind, value, meta); break;
        case "authority": result = projectCurrentRow(kind, value, meta); break;
        case "admission": result = projectCurrentRow(kind, value, meta); break;
        case 'case': result = { case_id: value.caseId, ...sqlScope(value.scope), capability_sha256: meta.capabilitySha256,
            created_at: value.createdAt, accept_before: value.acceptBefore, head_revision: value.revision, head_sha256: value.headSha256,
            status: value.status, candidate_proof_id: value.candidateProof && value.candidateProof.proofId, identity_sha256: value.candidateProof && value.candidateProof.identitySha256,
            approval_id: value.approval && value.approval.approvalId, approval_revision: value.approval && value.approval.revision,
            approval_sha256: value.approval && value.approval.sha256, accepted_receipt_id: value.acceptanceReceipt && value.acceptanceReceipt.receiptId, updated_at: value.updatedAt }; break;
        case 'decision': {
            const last = value.decisions[value.decisions.length - 1], approval = last.command.action === 'approve';
            result = { case_id: value.caseId, revision: value.revision, ...sqlScope(value.scope), parent_revision: value.revision ? value.revision - 1 : null,
                parent_sha256: last.parentSha256, decision: last.command.action, decision_sha256: last.sha256, occurred_at: last.command.at,
                actor_subject_key: last.command.actorSubjectKey, operation_id: last.command.operationId,
                approval_id: approval ? value.approval.approvalId : null, candidate_proof_id: approval ? value.candidateProof.proofId : null,
                candidate_proof_sha256: approval ? value.candidateProof.proofSha256 : null, candidate_identity_sha256: approval ? value.candidateProof.identitySha256 : null, payload: value }; break;
        }
        case 'proof': result = { proof_id: value.proofId, case_id: value.caseId, ...sqlScope(value.scope), case_revision: value.caseRevision,
            identity_sha256: value.identitySha256, identity_payload: value.identity, subject_key: value.subjectKey, authentication_sha256: value.authenticationSha256,
            verified_at: value.verifiedAt, fresh_until: value.freshUntil, proof_sha256: value.proofSha256, operation_id: value.operationId }; break;
        case "binding": result = projectCurrentRow(kind, value, meta); break;
        case "session": result = projectCurrentRow(kind, value, meta); break;
        case 'receipt': {
            const proof = value.operationType === 'recordProofAndActivateDiscovery' ? value.originalFacts.domainReceipt.originalFacts.facts.proof : null;
            const instance = INSTANCE_OPS.includes(value.operationType) ? value.result.record : null;
            result = { receipt_id: value.receiptId, anchor_kind: value.anchorKind, anchor_session_sha256: null, anchor_case_id: null, anchor_authority_id: null, anchor_binding_id: null, anchor_instance_id: null,
                runtime_instance_id: value.instanceId, ...sqlScope(value.scope), scope_json: value.scope, operation_type: value.operationType,
                operation_id: value.operationId, actor_subject_key: value.actorSubjectKey, occurred_at: value.occurredAt, intent_sha256: value.intentSha256, result_sha256: value.resultSha256,
                audit_event_id: value.auditEventId, audit_event_sha256: value.auditEventSha256,
                acceptance_case_id: value.operationType === 'acceptStagedOnboarding' ? value.anchorId : null,
                related_case_id: proof && proof.caseId, related_proof_id: proof && proof.proofId, related_identity_sha256: proof && proof.identitySha256,
                instance_result_revision: instance && instance.revision, instance_result_sha256: instance && hash(instance), payload: value };
            result[anchorColumn(value.anchorKind)] = value.anchorId; break;
        }
        case 'audit': {
            const e = value.event;
            result = { event_id: e.eventId, session_sha256: value.sessionSha256, instance_id: value.instanceId, authority_id: value.authorityId,
                request_id: e.requestId, ...sqlScope(e.scope), scope_json: e.scope, occurred_at: e.occurredAt, event_type: e.eventType, event_sha256: hash(value), operation_id: e.operationId, payload: e }; break;
        }
        default: bad();
    }
    fields(result, COLUMNS[kind]); return result;
}
function cleanRow(kind, input) {
    if (own(CURRENT_COLUMNS, kind)) return prepareCurrentRow(kind, input).row;
    return retained(() => {
        fields(input, COLUMNS[kind]); const row = {};
        for (const key of COLUMNS[kind]) {
            const value = input[key];
            if (value === null) row[key] = null;
            else if (NUMBER_COLUMNS.has(key)) {
                if (typeof value !== 'number' && (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value))) bad();
                row[key] = revision(Number(value));
            } else if (TIME_COLUMNS.has(key)) row[key] = instant(value instanceof Date && !isProxy(value) ? value.toISOString() : value);
            else row[key] = copy(value, JSON_COLUMNS.has(key) ? MAX_EFFECT : MAX_SMALL);
        }
        return row;
    });
}
function rowAgrees(kind, row, value, meta) { if (!equal(row, rowValues(kind, value, meta))) bad(); return value; }
function sessionFromRow(inv, raw) {
    const { row, value } = prepareCurrentRow('session', raw);
    return rowAgrees('session', row, inv.decode(value, domain.normaliseSessionRecord, MAX_SMALL));
}
function bindingFromRow(inv, raw) {
    const { row, value } = prepareCurrentRow('binding', raw);
    return rowAgrees('binding', row, inv.decode(value, domain.normaliseIdentityBinding, MAX_SMALL));
}
function proofFromRow(inv, raw) {
    const row = cleanRow('proof', raw), value = { schemaVersion: 1, proofId: row.proof_id, caseId: row.case_id, scope: readScope(row), caseRevision: row.case_revision,
        identity: row.identity_payload, identitySha256: row.identity_sha256, subjectKey: row.subject_key, authenticationSha256: row.authentication_sha256,
        verifiedAt: row.verified_at, freshUntil: row.fresh_until, proofSha256: row.proof_sha256, operationId: row.operation_id };
    return rowAgrees('proof', row, inv.decode(value, domain.normaliseIdentityProof, MAX_SMALL));
}
function admissionFromRow(inv, raw) {
    const { row, value } = prepareCurrentRow('admission', raw);
    return rowAgrees('admission', row, inv.decode(value, domain.normaliseAdmissionRecord, MAX_SMALL));
}
function caseFromRows(inv, rawHead, rawDecision) {
    const head = cleanRow('case', rawHead), row = cleanRow('decision', rawDecision);
    const value = inv.decode(row.payload, domain.normaliseOnboardingState);
    rowAgrees('decision', row, value); rowAgrees('case', head, value, { capabilitySha256: head.capability_sha256 }); digest(head.capability_sha256);
    return { state: value, capabilitySha256: head.capability_sha256 };
}
function instanceFromRow(inv, raw) {
    const diagnostic = inv.preparationDiagnostic, previous = diagnostic && diagnostic.mark('instance_codec');
    try {
        const { row, value } = prepareCurrentRow('instance', raw);
        const record = inv.decode(value, normalizeInstance, MAX_SMALL); uuid(row.head_receipt_id);
        rowAgrees('instance', row, record, { receiptId: row.head_receipt_id }); return { record, receiptId: row.head_receipt_id };
    } catch (error) { if (diagnostic) diagnostic.fail(error); throw error; }
    finally { if (diagnostic) diagnostic.mark(previous); }
}
function anchorColumn(kind) {
    const column = { session: 'anchor_session_sha256', case: 'anchor_case_id', authority: 'anchor_authority_id', binding: 'anchor_binding_id', instance: 'anchor_instance_id' }[kind];
    if (!column) bad(); return column;
}
async function selectRow(inv, tx, kind, key, value) {
    // Both table and key originate from fixed callers below, never command input.
    if (!COLUMNS[kind].includes(key)) bad();
    const result = await inv.query(tx, `SELECT ${COLUMNS[kind].join(', ')} FROM nofries.${TABLE[kind]} WHERE ${key} = $1`, [value]);
    if (result.rows.length > 1) bad(); return result.rows[0] || null;
}
async function writeRow(inv, tx, kind, value, meta = {}, update = false) {
    const row = rowValues(kind, value, meta), columns = update ? MUTABLE[kind] : COLUMNS[kind];
    if (!columns) bad();
    const values = columns.map(key => JSON_COLUMNS.has(key) ? JSON.stringify(row[key]) : row[key]);
    let statement;
    if (update) {
        statement = `UPDATE nofries.${TABLE[kind]} SET ${columns.map((key, i) => key + ' = $' + (i + 1)).join(', ')} WHERE ` +
            PRIMARY[kind].map((key, i) => key + ' = $' + (columns.length + i + 1)).join(' AND ');
        values.push(...PRIMARY[kind].map(key => row[key]));
    } else statement = `INSERT INTO nofries.${TABLE[kind]} (${columns.join(', ')}) VALUES (${columns.map((_, i) => '$' + (i + 1)).join(', ')})`;
    const result = await inv.query(tx, statement + ` RETURNING ${PRIMARY[kind].join(', ')}`, values);
    if (result.rows.length !== 1) conflict();
}

const CONTEXT = ['runtime_instance_id', 'session_sha256', 'session_kind', 'identity_sha256', 'subject_key', 'organisation_id', 'case_id', 'binding_id', 'authority_id', 'capability_sha256', 'request_id'];
async function settings(inv, tx, values = {}) {
    const c = inv.capture;
    const fixed = { runtime_instance_id: inv.options.instanceId, session_sha256: c ? c.sessionSha256 : '', session_kind: c ? c.kind : '',
        identity_sha256: c ? hash(c.identityPayload) : '', subject_key: c ? subjectOf(c.identityPayload) : '', request_id: c ? c.requestId : inv.command.operationId, ...values };
    const params = CONTEXT.map(key => fixed[key] || '');
    await inv.query(tx, 'SELECT ' + CONTEXT.map((key, i) => `set_config('nofries.${key}', $${i + 1}, true)`).join(', '), params);
}
async function tenantSetting(inv, tx, value) { await inv.query(tx, "SELECT set_config('nofries.tenant_id', $1, true), set_config('nofries.organisation_id', $2, true)", value ? [value.tenantId, value.organisationId] : ['', '']); }
async function fence(inv, tx, family, key, exclusive = false) {
    const fn = exclusive ? 'pg_advisory_xact_lock' : 'pg_advisory_xact_lock_shared';
    await inv.query(tx, `SELECT ${fn}($1::integer, hashtext($2))`, [family, key]);
}
async function initialFences(inv, tx, exclusiveSession = false, exclusiveInstance = false) {
    if (inv.capture) await fence(inv, tx, 71001, inv.capture.sessionSha256, exclusiveSession);
    await fence(inv, tx, 71002, inv.options.instanceId, exclusiveInstance);
}
function beginAttempt(inv) {
    // A completed locator/reader frame must not authorize or obstruct its next
    // transaction. Recovery also retires its old frame before provider refresh.
    inv.attempt = { finalAuthority: null, finalFailure: null, commitNotSent: null, rollbackKnown: false, commitKnown: false };
    if (inv.preparationDiagnostic) inv.preparationDiagnostic.beginAttempt();
    return inv.attempt;
}
function attemptError(inv, attempt, error) {
    if (error instanceof PostgresDatabaseError) {
        if (error.code === 'postgres_rollback_failed') return error;
        if (error.code === 'postgres_commit_failed') return attempt.commitNotSent ? inv.failure || attempt.commitNotSent : error;
    }
    if (inv.failure) return inv.failure;
    if (attempt.finalFailure && (attempt.rollbackKnown || attempt.commitKnown)) return attempt.finalFailure;
    return error;
}
function checkedClient(inv, client, attempt) {
    // Capture only this attempt's fixed diagnostic state. The queue, driver
    // calls, authority samples and transaction controls retain their ownership.
    const diagnostic = inv.preparationDiagnostic, diagnosticAttempt = diagnostic && diagnostic.currentAttempt();
    let tail = Promise.resolve(), queued = 0, inTransaction = false;
    let releaseRequested = false, released = false, discardRequested = false;
    const releaseWhenSettled = () => {
        if (!releaseRequested || queued || released) return;
        released = true;
        try { client.release(discardRequested); } catch (_) { /* Settled release never exposes driver detail. */ }
    };
    async function dispatch(sql, params) {
        if (sql === 'ROLLBACK') {
            try { await client.query('SET LOCAL statement_timeout = 0'); }
            catch (_) { /* An aborted transaction can reject SET; always attempt actual rollback. */ }
            let result;
            try { result = await client.query(sql, params); }
            catch (error) {
                if (diagnostic) { diagnostic.control('rollback_failed', diagnosticAttempt); diagnostic.fail(error, 'transaction_rollback', diagnosticAttempt); }
                throw error;
            }
            inTransaction = false; attempt.rollbackKnown = true;
            if (diagnostic) diagnostic.acknowledge('ROLLBACK', result, diagnosticAttempt);
            return result;
        }
        const begin = sql === 'BEGIN' || sql === 'BEGIN READ ONLY', commit = sql === 'COMMIT';
        const checkpoint = diagnostic && (queryCheckpoint(sql) || diagnostic.current());
        try {
            const at = inv.now();
            let preparedTimeout = null;
            if (inTransaction) {
                const remaining = inv.remainingMs(at);
                // Operator I/O follows this round trip. Reserve half the budget
                // for it, then require the prepared SQL timeout still to fit the
                // actual remaining deadline. No operator hook changes the
                // existing hosted path's timeout or authority semantics.
                preparedTimeout = inv.options.beforeQuery ? Math.floor(remaining / 2) : remaining;
                if (preparedTimeout < 1) inv.unavailable();
                try { await client.query("SELECT set_config('statement_timeout', $1, true)", [String(preparedTimeout)]); }
                catch (error) { if (diagnostic) diagnostic.fail(error, 'transaction_timeout', diagnosticAttempt); unavailable(); }
            }
            // Revalidate operator context after the timeout round trip. Charge
            // synchronous guard time before the final authority/deadline sample;
            // there is no intervening await before the target/control dispatch.
            // Raw rollback above deliberately remains independent of this gate.
            if (inv.options.beforeQuery) {
                const returned = inv.options.beforeQuery(sql);
                if (returned !== undefined) {
                    // Misconfigured asynchronous guards cannot dispatch SQL or
                    // escape as unhandled rejections while rollback is running.
                    Promise.resolve(returned).catch(() => {});
                    inv.unavailable();
                }
            }
            // Final authority is sampled after timeout preparation, with no
            // intervening await before the actual target/control dispatch.
            const dispatchAt = inv.now();
            if (inv.options.beforeQuery && preparedTimeout !== null && preparedTimeout + 1000 > inv.remainingMs(dispatchAt)) inv.unavailable();
        } catch (error) {
            if (commit) attempt.commitNotSent = error;
            if (diagnostic) diagnostic.fail(error, checkpoint, diagnosticAttempt);
            throw error;
        }
        if (commit) attempt.commitNotSent = null;
        if (diagnostic && (begin || commit)) diagnostic.control(begin ? 'begin_sent' : 'commit_sent', diagnosticAttempt);
        let result;
        try { result = await client.query(sql, params); }
        catch (error) {
            // Observe the original driver code before either database adapter
            // normalization or a later clock/rollback failure can replace it.
            if (diagnostic) {
                if (commit) diagnostic.control('commit_failed', diagnosticAttempt);
                diagnostic.fail(error, checkpoint, diagnosticAttempt);
            }
            try { inv.now(); } catch (_) { /* Actual response failure keeps its provenance. */ }
            throw error;
        }
        if (begin) inTransaction = true;
        else if (commit) { inTransaction = false; attempt.commitKnown = true; }
        if (diagnostic) {
            if (begin) diagnostic.control('begin_ok', diagnosticAttempt);
            else if (commit) diagnostic.acknowledge('COMMIT', result, diagnosticAttempt);
        }
        if (begin || commit) {
            // The actual owner must learn about known control success before
            // observing a latched failure at its next dispatch or disclosure.
            try { inv.now(); } catch (_) { /* Preserve known ownership. */ }
        } else {
            try { inv.now(); }
            catch (error) { if (diagnostic) diagnostic.fail(error, checkpoint, diagnosticAttempt); throw error; }
        }
        return result;
    }
    return Object.freeze({
        query(sql, params) {
            if (releaseRequested) return Promise.reject(new PostgresDatabaseError('postgres_query_failed'));
            queued++;
            const pending = tail.then(() => dispatch(sql, params));
            const settled = () => { queued--; releaseWhenSettled(); };
            tail = pending.then(settled, settled);
            pending.catch(() => {});
            return pending;
        },
        release(discard) {
            releaseRequested = true; discardRequested = discardRequested || Boolean(discard);
            releaseWhenSettled();
        }
    });
}
function checkedPool(inv) {
    if (!inv.pool) inv.pool = Object.freeze({
        async connect() {
            const diagnostic = inv.preparationDiagnostic;
            if (diagnostic) diagnostic.mark('database_connect');
            inv.now();
            const attempt = inv.attempt; let client;
            try { client = await inv.options.pool.connect(); }
            catch (error) { if (diagnostic) diagnostic.fail(error); throw error; }
            try { inv.now(); }
            catch (error) {
                try { client.release(false); } catch (_) { /* The borrow has settled. */ }
                throw error;
            }
            return checkedClient(inv, client, attempt);
        },
        end() { unavailable(); }
    });
    return inv.pool;
}
async function rawTransaction(inv, work, readOnly = false) {
    const attempt = beginAttempt(inv);
    inv.now(); let client, started = false, discard = false;
    try { client = await checkedPool(inv).connect(); } catch (_) { unavailable(); }
    try {
        inv.now();
        try { await client.query(readOnly ? 'BEGIN READ ONLY' : 'BEGIN'); started = true; } catch (_) { discard = true; unavailable(); }
        let result;
        try { inv.now(); result = await work(client); inv.now(); }
        catch (error) {
            try { await client.query('ROLLBACK'); started = false; } catch (_) { discard = true; throw new PostgresDatabaseError('postgres_rollback_failed'); }
            throw error;
        }
        try { await client.query('COMMIT'); started = false; inv.committed = true; }
        catch (_) {
            try { await client.query('ROLLBACK'); started = false; } catch (_) { discard = true; throw new PostgresDatabaseError('postgres_rollback_failed'); }
            throw new PostgresDatabaseError('postgres_commit_failed');
        }
        inv.now(); return result;
    } catch (error) {
        throw attemptError(inv, attempt, error);
    } finally {
        if (started) { try { await client.query('ROLLBACK'); } catch (_) { discard = true; } }
        try { client.release(discard); } catch (_) { /* Settled client release never discloses a driver error. */ }
    }
}
function errorResult(error) {
    if (error instanceof domain.DashboardOnboardingError) return error;
    return new domain.DashboardOnboardingError('onboarding_unavailable', 503);
}
async function transaction(inv, target, work) {
    if (!target) return rawTransaction(inv, work);
    const attempt = beginAttempt(inv);
    if (!inv.database) inv.database = createPostgresDatabase({ pool: checkedPool(inv) });
    try {
        const result = await inv.database.withTenantTransaction(target.tenantId, async tx => {
            try { inv.now(); const value = await work(tx); inv.now(); return value; }
            // Semantic/codec failures must be recorded before the adapter's
            // rollback cleanup; the same application error is still rethrown.
            catch (error) { if (inv.preparationDiagnostic) inv.preparationDiagnostic.fail(error); throw error; }
        });
        inv.committed = true; inv.now(); return result;
    } catch (error) { throw attemptError(inv, attempt, error); }
}
async function preflight(inv, tx, values) {
    for (const [value, maximum] of values) {
        const v = copy(value, maximum); inv.now();
        const result = await inv.query(tx, 'SELECT octet_length($1::jsonb::text) AS payload_bytes', [JSON.stringify(v)]);
        let measured;
        try {
            if (result.rows.length !== 1) unavailable();
            measured = fields(copy(result.rows[0], MAX_SMALL), ['payload_bytes']).payload_bytes;
            if (!Number.isSafeInteger(measured) || measured <= 0) unavailable();
        } catch (_) { unavailable(); }
        if (measured > maximum) large();
    }
}

async function enter(inv, tx, target = null, values = {}) {
    await inv.query(tx, inv.options.maintenance ? 'SET LOCAL ROLE nofries_dashboard_maintenance' : 'SET LOCAL ROLE nofries_runtime');
    await settings(inv, tx, values); await tenantSetting(inv, tx, target);
}
async function loadInstance(inv, tx) {
    const raw = await selectRow(inv, tx, 'instance', 'instance_id', inv.options.instanceId);
    return raw ? instanceFromRow(inv, raw) : null;
}
function currentInstance(inv, found, permitFenced = false) {
    if (!found || inv.now() < found.record.changedAt) denied();
    if (found.record.instanceId !== inv.options.instanceId || !inv.externalEpoch || found.record.restoreEpoch !== inv.externalEpoch.restoreEpoch ||
        !permitFenced && found.record.ingressStatus !== 'enabled') denied();
    if (inv.capture && found.record.restoreEpoch !== inv.capture.restoreEpoch) denied();
    return found.record;
}
async function loadGate(inv, tx) {
    const row = await selectRow(inv, tx, 'session', 'session_sha256', inv.capture.sessionSha256);
    return row ? sessionFromRow(inv, row) : null;
}
function currentGate(inv, gate, absent = false, terminal = false) {
    if (!gate) { if (absent) return null; denied(); }
    const c = inv.capture;
    if (gate.sessionSha256 !== c.sessionSha256 || gate.kind !== c.kind || !equal(gate.identityPayload, c.identityPayload) ||
        gate.instanceId !== c.instanceId || gate.restoreEpoch !== c.restoreEpoch || gate.issuedAt !== c.issuedAt || gate.expiresAt !== c.expiresAt) denied();
    if (c.kind === 'onboarding_discovery' && (gate.discoveryCaseId !== c.discovery.caseId || gate.discoveryProofId !== c.discovery.proofId)) denied();
    if (c.kind === 'operator_dashboard' && c.operatorIssuanceProof && gate.operatorIssuanceSha256 !== hash(c.operatorIssuanceProof)) {
        // A canonical absent-gate logout tombstone has no original issuance
        // digest. It is terminal authority only, never an initialization proof.
        if (!(terminal && gate.status === 'revoked' && gate.revision === 0 && gate.operatorIssuanceSha256 === null)) denied();
    }
    const at = inv.now();
    if (at < gate.updatedAt || !terminal && (gate.status !== 'active' || at >= gate.expiresAt)) denied(); return gate;
}
async function loadBinding(inv, tx, bindingId) {
    const raw = await selectRow(inv, tx, 'binding', 'binding_id', bindingId);
    return raw ? bindingFromRow(inv, raw) : null;
}
async function loadProof(inv, tx, proofId) {
    const raw = await selectRow(inv, tx, 'proof', 'proof_id', proofId);
    return raw ? proofFromRow(inv, raw) : null;
}
async function loadCase(inv, tx, caseId) {
    const head = await selectRow(inv, tx, 'case', 'case_id', caseId); if (!head) return null;
    const h = cleanRow('case', head); inv.charge(h, 1);
    if (h.head_revision > 4) bad();
    const required = h.head_revision + 1; if (inv.pageSize() < required) unavailable();
    const rows = await inv.query(tx, `SELECT ${COLUMNS.decision.join(', ')} FROM nofries.dashboard_onboarding_decisions WHERE case_id = $1 ORDER BY revision LIMIT $2`, [caseId, required]);
    if (rows.rows.length !== h.head_revision + 1 || rows.rows.length > 5) bad();
    let previous = null, final;
    for (const raw of rows.rows) {
        const row = cleanRow('decision', raw), state = inv.decode(row.payload, domain.normaliseOnboardingState);
        rowAgrees('decision', row, state);
        if (row.revision !== (previous ? previous.revision + 1 : 0) || previous &&
            !equal(state.decisions.slice(0, -1), previous.decisions)) bad();
        previous = state; final = state;
    }
    rowAgrees('case', h, final, { capabilitySha256: h.capability_sha256 }); digest(h.capability_sha256);
    if (inv.now() < final.updatedAt) denied();
    return { state: final, capabilitySha256: h.capability_sha256 };
}
async function loadAdmission(inv, tx, authorityId) {
    const raw = await selectRow(inv, tx, 'authority', 'authority_id', authorityId); if (!raw) return null;
    const h = cleanRow('authority', raw); inv.charge(h, 1); inv.pageSize();
    const found = await inv.query(tx, `SELECT ${COLUMNS.admission.join(', ')} FROM nofries.dashboard_admission_decisions WHERE authority_id = $1 AND revision = $2`, [authorityId, h.head_revision]);
    if (found.rows.length !== 1) bad(); const value = admissionFromRow(inv, found.rows[0]); rowAgrees('authority', h, value);
    if (inv.now() < value.payload.occurredAt) denied(); return value;
}
function currentAdmission(inv, value, target, identity, expectedEffect, terminal = false) {
    if (!value || !equal(value.scope, target)) denied();
    if (terminal) return value;
    const at = inv.now(), p = value.payload;
    if (p.decision !== 'eligible' || at < p.validFrom || at >= p.validUntil ||
        identity && (p.identityPolicyRef.policyId !== identity.policyId || p.identityPolicyRef.policyRevision !== identity.policyRevision) ||
        expectedEffect && p.approvedEffectSha256 !== expectedEffect) denied();
    return value;
}
function refMatches(ref, value) { if (!value || ref.authorityId !== value.authorityId || ref.revision !== value.revision || ref.sha256 !== value.decisionSha256) denied(); }
async function historicalAdmission(inv, tx, ref, target) {
    const result = await inv.query(tx, `SELECT ${COLUMNS.admission.join(', ')} FROM nofries.dashboard_admission_decisions WHERE authority_id = $1 AND revision = $2`, [ref.authorityId, ref.revision]);
    if (result.rows.length !== 1) bad(); const value = admissionFromRow(inv, result.rows[0]);
    if (!equal(value.scope, target) || value.decisionSha256 !== ref.sha256) bad(); return value;
}
async function canonicalAuthority(inv, tx, target, update = false) {
    inv.now(); let loaded;
    try { loaded = await (update ? dataStorage.loadSnapshotForUpdate : dataStorage.loadSnapshotForShare)(tx, target); }
    catch (error) { if (error instanceof DashboardPersistenceError && error.statusCode === 404) denied(); throw error; }
    inv.now();
    return freeze({ tenantAggregate: loaded.tenantAggregate, membershipState: loaded.membershipState, entitlementState: loaded.entitlementState,
        flags: loaded.flags, advisorAssignments: loaded.advisorAssignments });
}
function bindingCurrent(inv, binding, authority) {
    if (!binding || binding.status !== 'active' || !equal(binding.identity, inv.capture.identityPayload) || binding.subjectKey !== subjectOf(inv.capture.identityPayload)) denied();
    const at = inv.now(); if (at < binding.validFrom || at >= binding.validUntil || at < binding.updatedAt) denied();
    let member;
    try { member = resolveActiveMembership(authority.membershipState, authority.tenantAggregate, { ...binding.scope, subjectKey: binding.subjectKey }, at);
        resolveEntitlements(authority.entitlementState, authority.tenantAggregate, binding.scope, at, authority.flags); }
    catch (_) { denied(); }
    for (const key of ['membershipId', 'invitationId', 'grantEvidenceId', 'validFrom', 'validUntil']) if (member[key] !== binding[key]) denied();
    return member;
}
function bindingTiming(binding, authority) {
    // Called only after the existing charged current-authority checks succeed.
    // Retain their exact target member, never infer it from a successor gate or
    // from the operator actor of a publication for another identity.
    const member = authority.membershipState.memberships.find(row => row.membershipId === binding.membershipId);
    const organisation = authority.tenantAggregate.organisations.find(row => row.organisationId === binding.scope.organisationId);
    if (!member || !organisation) bad();
    return { binding, member: Object.freeze({ row: member, organisation, tenant: authority.tenantAggregate.tenant,
        updatedAt: authority.membershipState.updatedAt }) };
}
function acceptanceTiming(facts) {
    return { caseState: facts.caseState, proof: facts.proof, ...bindingTiming(facts.currentBinding, facts.currentAuthority) };
}
function sealFinalAuthority(inv, base, timing = {}) {
    inv.attempt.finalAuthority = Object.freeze({ capture: inv.capture, instance: base.instance, gate: base.gate || null,
        terminalSession: inv.operationType === 'revokeSession', admission: base.admission || null,
        terminalAdmission: inv.options.maintenance || ['revokeCase', 'denyCase', 'expireCase'].includes(inv.operationType),
        ...(inv.starterParent ? { starterParent: inv.starterParent } : {}), ...timing });
}
function finalAuthorityAt(frame, at) {
    // This fixed temporal projection uses no clock, provider, SQL, resolver or
    // codec. Structural identity/lineage checks stay at their charged sites.
    const { capture: c, instance, gate, admission, caseState, proof, binding, member } = frame;
    if (frame.starterParent) finalAuthorityAt(frame.starterParent, at);
    if (frame.starterProduct && (at < frame.starterProduct.validFrom || at >= frame.starterProduct.validUntil)) denied();
    if (c && (at < c.issuedAt || !frame.terminalSession && at >= c.expiresAt)) denied();
    if (instance && at < instance.changedAt) denied();
    if (gate && (at < gate.updatedAt || !frame.terminalSession && (gate.status !== 'active' || at >= gate.expiresAt))) denied();
    if (admission) {
        const p = admission.payload;
        if (at < p.occurredAt || !frame.terminalAdmission && (p.decision !== 'eligible' || at < p.validFrom || at >= p.validUntil)) denied();
    }
    if (caseState && at < caseState.updatedAt) denied();
    if (proof && (at < proof.verifiedAt || at >= proof.freshUntil)) denied();
    if (binding && (binding.status !== 'active' || at < binding.updatedAt || at < binding.validFrom || at >= binding.validUntil)) denied();
    if (member && (at < member.updatedAt || member.row.status !== 'active' || member.tenant.recordStatus !== 'active' ||
        member.organisation.recordStatus !== 'active' || at < member.row.validFrom || at >= member.row.validUntil)) denied();
    if (frame.freshCaseAcceptBefore && at >= frame.freshCaseAcceptBefore ||
        frame.freshApprovalAcceptBefore && at >= frame.freshApprovalAcceptBefore) denied();
    if (frame.freshMembership && (at < frame.freshMembership.validFrom || at >= frame.freshMembership.validUntil)) denied();
}
async function finalSessionCheck(inv, tx, gate, options = {}) {
    await capture(inv); await externalEpoch(inv);
    const instance = currentInstance(inv, await loadInstance(inv, tx), options.fenced === true);
    const current = await loadGate(inv, tx);
    currentGate(inv, current, options.absent === true, options.terminal === true);
    if (!equal(current, gate)) denied();
    inv.now(); return { instance, gate: current };
}

function receiptResource(type) {
    if (SESSION_OPS.includes(type)) return 'session'; if (CASE_OPS.includes(type) || type === 'acceptStagedOnboarding') return 'case';
    if (ADMISSION_OPS.includes(type)) return 'admission'; if (INSTANCE_OPS.includes(type)) return 'instance';
    if (type === 'publishExistingMembershipBinding') return 'binding'; bad();
}
function makeAudit(inv, eventId, at, target, authorityId, operationId = inv.command.operationId, action = inv.operationType, outcome = 'succeeded', resourceKey = receiptResource(inv.operationType)) {
    return freeze(copy({ sessionSha256: inv.capture ? inv.capture.sessionSha256 : null, instanceId: inv.options.instanceId, authorityId,
        event: { schemaVersion: 1, eventType: 'dashboard.runtime', eventId, requestId: inv.capture ? inv.capture.requestId : inv.command.operationId,
            occurredAt: at, actorSubjectKey: inv.capture ? subjectOf(inv.capture.identityPayload) : inv.command.actorSubjectKey,
            scope: target, action, outcome, resourceKey, operationId } }, MAX_SMALL));
}
async function readAudit(inv, tx, receipt) {
    const raw = await selectRow(inv, tx, 'audit', 'event_id', receipt.auditEventId); if (!raw) bad();
    const row = cleanRow('audit', raw), value = { sessionSha256: row.session_sha256, instanceId: row.instance_id, authorityId: row.authority_id, event: row.payload };
    inv.charge(value, 1); const normalized = retained(() => normalizeReceiptAudit(value, receipt)); rowAgrees('audit', row, normalized); return normalized;
}
async function readReceiptRow(inv, tx, raw) {
    const row = cleanRow('receipt', raw), receipt = inv.decode(row.payload, normalizeOuterReceipt);
    rowAgrees('receipt', row, receipt); if (receipt.instanceId !== inv.options.instanceId) bad(); await readAudit(inv, tx, receipt);
    if (receipt.originalFacts.dataReference) {
        const prepared = prepareBootstrap(inv, receipt.originalFacts.domainReceipt);
        if (!equal(prepared.prepared.expectedReference, receipt.originalFacts.dataReference)) bad();
    }
    return receipt;
}
async function findReceipt(inv, tx, anchor, anchorId, operationId) {
    const result = await inv.query(tx, `SELECT ${COLUMNS.receipt.join(', ')} FROM nofries.dashboard_runtime_receipts WHERE ${anchorColumn(anchor)} = $1 AND operation_id = $2`, [anchorId, operationId]);
    if (result.rows.length > 1) bad(); return result.rows.length ? readReceiptRow(inv, tx, result.rows[0]) : null;
}
async function receiptById(inv, tx, receiptId) {
    const row = await selectRow(inv, tx, 'receipt', 'receipt_id', receiptId); if (!row) bad(); return readReceiptRow(inv, tx, row);
}
function receiptDomain(receipt) { return receipt.originalFacts.domainReceipt; }
function resultRecord(receipt) { return receipt.operationType === 'recordProofAndActivateDiscovery' ? receipt.result.session.record : receipt.result.record; }
async function proveHistory(inv, tx, original, current) {
    const anchor = original.anchorKind;
    if (!['session', 'authority', 'instance'].includes(anchor)) bad();
    const resultSql = anchor === 'session' ? "CASE WHEN operation_type = 'recordProofAndActivateDiscovery' THEN (payload #>> '{result,session,record,revision}')::bigint ELSE (payload #>> '{result,record,revision}')::bigint END" : "(payload #>> '{result,record,revision}')::bigint";
    const previousSql = anchor === 'instance' ? "COALESCE((payload #>> '{originalFacts,operationFacts,predecessor,revision}')::bigint,-1)" : "COALESCE((payload #>> '{originalFacts,domainReceipt,originalFacts,predecessor,revision}')::bigint,-1)";
    let retainedRecord = resultRecord(original), previousReceipt = original, lastRevision = retainedRecord.revision, lastId = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
    if (retainedRecord.revision > current.revision) bad();
    const seenOps = new Set([original.operationId]), seenReceipts = new Set([original.receiptId]), seenEvents = new Set([original.auditEventId]);
    for (;;) {
        const limit = inv.pageSize();
        const result = await inv.query(tx, `SELECT ${COLUMNS.receipt.join(', ')} FROM nofries.dashboard_runtime_receipts WHERE ${anchorColumn(anchor)} = $1 AND (${resultSql}) > (${previousSql}) AND (${resultSql}) <= $2 AND ((${resultSql}), receipt_id) > ($3::bigint, $4::uuid) ORDER BY (${resultSql}), receipt_id LIMIT $5`,
            [original.anchorId, current.revision, lastRevision, lastId, limit]);
        // A page is bounded before any individual reconstruction; it never buys a sentinel row.
        retained(() => copy(result.rows.map(row => row.payload), 8388608));
        for (const raw of result.rows) {
            const next = await readReceiptRow(inv, tx, raw), record = resultRecord(next);
            if (next.anchorKind !== anchor || next.anchorId !== original.anchorId || seenOps.has(next.operationId) || seenReceipts.has(next.receiptId) || seenEvents.has(next.auditEventId)) bad();
            seenOps.add(next.operationId); seenReceipts.add(next.receiptId); seenEvents.add(next.auditEventId);
            if (record.revision !== retainedRecord.revision + 1) bad();
            if (anchor === 'instance') {
                const f = next.originalFacts.operationFacts; inv.charge({ predecessor: retainedRecord, receipt: next }, 2);
                if (!equal(f.predecessor, retainedRecord)) bad();
            } else {
                const input = { receipt: receiptDomain(previousReceipt), currentRecord: record, successorReceipts: [receiptDomain(next)] };
                inv.charge(input, 3); domain.assertTransitionIncluded(input);
            }
            retainedRecord = record; previousReceipt = next; lastRevision = record.revision; lastId = next.receiptId;
        }
        if (result.rows.length < limit) break;
    }
    if (!equal(retainedRecord, current)) bad(); return original.result;
}
function bootstrapCommand(receipt) {
    return { ...receipt.scope, operationId: receipt.operationId, actorSubjectKey: receipt.originalFacts.proof.subjectKey,
        type: 'organisation.initialise', expectedRevisions: { tenant: null, organisation: null, membership: null, entitlement: null, flags: null, advisorAssignments: [], usage: [] }, payload: {} };
}
function prepareBootstrap(inv, receipt) {
    let activeTx = null;
    const command = bootstrapCommand(receipt), operations = createBootstrapOperations({ clock: () => inv.now(),
        authoriseAdministration: (actual, snapshot) => {
            if (activeTx === null || !equal(actual, command)) return false;
            if (own(snapshot, 'proposed')) return snapshot.organisation === null && equal(snapshot.proposed, receipt.effect.initialState) &&
                (snapshot.tenant === null || equal(snapshot.tenant, receipt.effect.initialState.tenantAggregate.tenant));
            return snapshot.tenantAggregate.tenant.tenantId === receipt.scope.tenantId &&
                snapshot.tenantAggregate.organisations.length === 1 && snapshot.tenantAggregate.organisations[0].organisationId === receipt.scope.organisationId;
        } });
    const prepared = operations.prepareInitialisation(command, receipt.effect.initialState);
    return { prepared,
        async execute(tx) { if (activeTx) bad(); activeTx = tx; try { return await operations.executeInTransaction(tx, prepared); } finally { activeTx = null; } },
        async reconcile(tx) { if (activeTx) bad(); activeTx = tx; try { return await operations.reconcileInTransaction(tx, prepared); } finally { activeTx = null; } } };
}

// Fixed receipt and instance codecs; their SQL/current-authority checks remain separate.

const OUTER_INSTANCE_OPERATIONS = ['initializeRuntimeInstance', 'fenceRestoreEpoch', 'enableRuntimeIngress'];
const OUTER_SESSION_OPERATIONS = ['initializeOperatorSession', 'activateCustomerSession',
    'recordProofAndActivateDiscovery', 'selectBinding', 'revokeSession'];
const OUTER_ADMISSION_OPERATIONS = ['publishAdmissionDecision', 'withdrawAdmissionDecision'];
const OUTER_CASE_ACTIONS = Object.freeze({ createCase: 'create', approveCase: 'approve',
    revokeCase: 'revoke', denyCase: 'deny', expireCase: 'expire' });
const OUTER_INPUT_FIELDS = ['schemaVersion', 'receiptId', 'operationType', 'operationId',
    'instanceId', 'anchorKind', 'anchorId', 'scope', 'actorSubjectKey', 'occurredAt',
    'originalFacts', 'auditEventId', 'auditEventSha256'];
const OUTER_FIELDS = OUTER_INPUT_FIELDS.concat(['stableIntent', 'intentSha256',
    'result', 'resultSha256', 'receiptSha256']);
const OUTER_OPERATION_FACTS_FIELDS = ['domainReceipt', 'operationFacts', 'dataReference'];

function applyInstanceOperation(predecessor, commandInput, factsInput) {
    // Inspect new inputs separately from the retained predecessor.
    const previous = predecessor === null ? null : normalizeInstance(predecessor);
    const command = fields(copy(commandInput, MAX_SMALL), ['schemaVersion', 'operationType',
        'operationId', 'instanceId', 'actorSubjectKey', 'expectedRevision',
        'expectedRecordSha256', 'payload']);
    if (command.schemaVersion !== 1 || !OUTER_INSTANCE_OPERATIONS.includes(command.operationType)) invalid();
    uuid(command.operationId); uuid(command.instanceId); subject(command.actorSubjectKey);
    const payload = fields(command.payload, ['restoreEpoch', 'evidenceRef', 'evidenceSha256']);
    uuid(payload.restoreEpoch); id(payload.evidenceRef); digest(payload.evidenceSha256);
    const facts = fields(copy(factsInput, MAX_SMALL), ['occurredAt']); instant(facts.occurredAt);
    if (command.expectedRevision !== null) revision(command.expectedRevision);
    if (command.expectedRecordSha256 !== null) digest(command.expectedRecordSha256);
    let outcome, ingressStatus;
    if (command.operationType === 'initializeRuntimeInstance') {
        if (previous !== null || command.expectedRevision !== null || command.expectedRecordSha256 !== null) conflict();
        outcome = 'initialized'; ingressStatus = 'fenced';
    } else {
        if (!previous || command.expectedRevision === null || command.expectedRecordSha256 === null ||
            previous.instanceId !== command.instanceId || previous.revision !== command.expectedRevision ||
            hash(previous) !== command.expectedRecordSha256 || previous.revision === Number.MAX_SAFE_INTEGER ||
            facts.occurredAt < previous.changedAt) conflict();
        if (command.operationType === 'fenceRestoreEpoch') {
            if (previous.ingressStatus === 'enabled' && payload.restoreEpoch !== previous.restoreEpoch) conflict();
            outcome = 'fenced'; ingressStatus = 'fenced';
        } else {
            if (previous.ingressStatus !== 'fenced' || payload.restoreEpoch !== previous.restoreEpoch) conflict();
            outcome = 'enabled'; ingressStatus = 'enabled';
        }
    }
    const record = instanceRecordValue({ schemaVersion: 1, instanceId: command.instanceId,
        revision: previous ? previous.revision + 1 : 0, restoreEpoch: payload.restoreEpoch,
        ingressStatus, changedAt: facts.occurredAt, evidenceRef: payload.evidenceRef,
        evidenceSha256: payload.evidenceSha256 });
    return freeze({ record, outcome });
}
function outerCaseProjection(state) {
    return { caseId: state.caseId, revision: state.revision, headSha256: state.headSha256, status: state.status };
}
function outerBindingProjection(binding) {
    return { bindingId: binding.bindingId, membershipId: binding.membershipId,
        revision: binding.revision, status: binding.status, updatedAt: binding.updatedAt };
}
function selectedOuterScope(record) {
    return record.selectedBindingId === null ? null :
        { tenantId: record.selectedTenantId, organisationId: record.selectedOrganisationId };
}
function outerDomainIntent(operationType, anchorKind, anchorId, domainIntent) {
    return { operationType, anchorKind, anchorId, domainIntent };
}
function outerNoFacts(original, allowOperationFacts = false, allowDataReference = false) {
    if (!allowOperationFacts && original.operationFacts !== null ||
        !allowDataReference && original.dataReference !== null) invalid();
}
function outerCaseCommand(value) {
    const supplied = fields(value, ['action', 'operationId', 'expectedRevision', 'actorSubjectKey', 'at', 'payload']);
    let payload = supplied.payload;
    if (supplied.action === 'revoke') {
        const parts = fields(payload, ['authorityRef', 'predecessor']);
        payload = { authorityRef: parts.authorityRef, predecessor: parts.predecessor === null ? null :
            retained(() => copy(parts.predecessor, MAX_EFFECT)) };
    }
    const command = copy({ ...supplied, payload }, MAX_OPERATION);
    uuid(command.operationId); subject(command.actorSubjectKey); instant(command.at);
    if (command.expectedRevision !== null) revision(command.expectedRevision);
    return command;
}
function outerFreshCaseOperation(state, command) {
    if (state.decisions.some(row => row.command.operationId === command.operationId)) bad();
    if (command.expectedRevision !== state.revision) conflict();
}
function reconstructOuterCase(operationType, input) {
    const supplied = fields(input, ['predecessor', 'command', 'bindingPredecessor', 'capabilitySha256']);
    const previous = supplied.predecessor === null ? null : domain.normaliseOnboardingState(supplied.predecessor);
    const binding = supplied.bindingPredecessor === null ? null : domain.normaliseIdentityBinding(supplied.bindingPredecessor);
    const command = outerCaseCommand(supplied.command);
    if (command.action !== OUTER_CASE_ACTIONS[operationType]) invalid();
    let next, nextBinding = null;
    if (operationType === 'createCase') {
        if (previous !== null || binding !== null || command.expectedRevision !== null) invalid();
        digest(supplied.capabilitySha256);
        fields(command.payload, ['caseId', 'templateRef', 'template', 'acceptBefore', 'authorityRef']);
        next = domain.createOnboardingCase({ ...command.payload,
            initiatorSubjectKey: command.actorSubjectKey, operationId: command.operationId, createdAt: command.at });
    } else {
        if (previous === null || supplied.capabilitySha256 !== null) invalid();
        outerFreshCaseOperation(previous, command);
        const acceptedRevocation = operationType === 'revokeCase' && previous.status === 'accepted';
        if (acceptedRevocation) {
            if (!binding) invalid();
            const originalBinding = domain.createStagedIdentityBinding(previous.acceptanceReceipt);
            // 1A active bindings have revision zero and unchanged birth facts.
            if (!equal(originalBinding, binding)) bad();
            nextBinding = domain.revokeIdentityBinding({ predecessor: binding,
                expectedRevision: binding.revision, authorityRef: command.payload.authorityRef, at: command.at });
        } else if (binding !== null) invalid();
        // This also reconstructs accepted revocation's exact canonical membership
        // effect, including preserved removal. The owner persists that effect.
        next = domain.applyOnboardingCommand(previous, command);
    }
    const { at, ...commandIntent } = command;
    return { originalFacts: { predecessor: previous, command, bindingPredecessor: binding,
        capabilitySha256: supplied.capabilitySha256 }, next, nextBinding,
        stableIntent: { operationType, caseId: next.caseId, commandIntent,
            expectedHeadSha256: previous ? previous.headSha256 : null,
            capabilitySha256: supplied.capabilitySha256,
            bindingRef: binding ? { bindingId: binding.bindingId, revision: binding.revision, sha256: hash(binding) } : null },
        result: { case: outerCaseProjection(next), binding: nextBinding ? outerBindingProjection(nextBinding) : null } };
}
function reconstructCompoundProof(inner, originalCaseInput) {
    const state = domain.normaliseOnboardingState(originalCaseInput);
    const proof = inner.originalFacts.facts.proof, at = inner.originalFacts.facts.occurredAt;
    if (proof.operationId !== inner.operationId || proof.caseId !== state.caseId ||
        !equal(proof.scope, state.scope) || proof.caseRevision !== state.revision ||
        proof.verifiedAt < state.createdAt || proof.verifiedAt > at || proof.freshUntil <= at ||
        at < state.updatedAt || inner.actorSubjectKey !== proof.subjectKey ||
        state.candidateProof && !equal(state.candidateProof.identity, proof.identity)) denied();
    if (['revoked', 'denied', 'expired'].includes(state.status)) denied();
    if (state.status !== 'accepted' && (at >= state.acceptBefore ||
        state.approval && at >= state.approval.acceptBefore)) denied();
    if (state.decisions.some(row => row.command.operationId === inner.operationId)) bad();
    const known = [state.candidateProof, state.acceptanceReceipt && state.acceptanceReceipt.originalFacts.proof].filter(Boolean);
    for (const occurrence of known) {
        if (occurrence.proofId === proof.proofId || occurrence.operationId === proof.operationId ||
            occurrence.authenticationSha256 === proof.authenticationSha256) denied();
    }
    const next = state.status === 'awaiting_identity' ? domain.applyOnboardingCommand(state, {
        action: 'bind_identity', operationId: inner.operationId, expectedRevision: state.revision,
        actorSubjectKey: proof.subjectKey, at, payload: { proof } }) : state;
    return { state, next, proof,
        result: { session: inner.result, case: outerCaseProjection(next),
            proof: { proofId: proof.proofId, proofSha256: proof.proofSha256 },
            caseOutcome: next === state ? 'preserved' : 'bound' } };
}
function outerDataReference(value, inner) {
    if (inner.effect.kind !== 'bootstrap') { if (value !== null) invalid(); return null; }
    const reference = fields(copy(value, MAX_SMALL), ['schemaVersion', 'operationType', 'tenantId',
        'organisationId', 'operationId', 'intentSha256', 'resultSha256']);
    if (reference.schemaVersion !== 1 || reference.operationType !== 'organisation.initialise' ||
        reference.tenantId !== inner.scope.tenantId || reference.organisationId !== inner.scope.organisationId ||
        reference.operationId !== inner.operationId) invalid();
    digest(reference.intentSha256); digest(reference.resultSha256);
    return reference;
}
function makeOuterReceipt(input) {
    // Do not detach the complete object until retained fields have passed their
    // retained codecs, so a getter/corruption in retained facts remains 503.
    const supplied = fields(input, OUTER_INPUT_FIELDS);
    const original = fields(supplied.originalFacts, OUTER_OPERATION_FACTS_FIELDS);
    const header = copy(Object.fromEntries(OUTER_INPUT_FIELDS.filter(key => key !== 'originalFacts')
        .map(key => [key, supplied[key]])), MAX_SMALL);
    if (header.schemaVersion !== 1) invalid();
    uuid(header.receiptId); uuid(header.operationId); uuid(header.instanceId);
    uuid(header.auditEventId); digest(header.auditEventSha256);
    subject(header.actorSubjectKey); instant(header.occurredAt);
    if (header.scope !== null) scope(header.scope);
    let stableIntent, result, normalizedOriginal, anchorKind, anchorId, resultScope, actor, at, operationId;
    const op = header.operationType;
    if (OUTER_SESSION_OPERATIONS.includes(op) || OUTER_ADMISSION_OPERATIONS.includes(op)) {
        outerNoFacts(original, op === 'recordProofAndActivateDiscovery');
        const inner = domain.normaliseTransitionReceipt(original.domainReceipt);
        if (inner.operationType !== op || inner.receiptId !== header.receiptId ||
            inner.auditEventId !== header.auditEventId) invalid();
        anchorKind = inner.anchorKind; anchorId = inner.anchorId;
        actor = inner.actorSubjectKey; operationId = inner.operationId; at = inner.originalFacts.facts.occurredAt;
        stableIntent = outerDomainIntent(op, anchorKind, anchorId, inner.stableIntent); result = inner.result;
        normalizedOriginal = { domainReceipt: inner, operationFacts: null, dataReference: null };
        if (OUTER_ADMISSION_OPERATIONS.includes(op)) resultScope = inner.result.record.scope;
        else {
            if (inner.result.record.instanceId !== header.instanceId) invalid();
            resultScope = selectedOuterScope(inner.result.record);
            if (op === 'recordProofAndActivateDiscovery') {
                const extra = fields(original.operationFacts, ['caseState']);
                const compound = reconstructCompoundProof(inner, extra.caseState);
                resultScope = compound.proof.scope;
                normalizedOriginal.operationFacts = { caseState: compound.state };
                stableIntent = { ...stableIntent, caseId: compound.state.caseId,
                    caseRevision: compound.state.revision, caseSha256: compound.state.headSha256,
                    proofSha256: compound.proof.proofSha256 };
                result = compound.result;
            }
        }
    } else if (Object.prototype.hasOwnProperty.call(OUTER_CASE_ACTIONS, op)) {
        if (original.domainReceipt !== null || original.dataReference !== null) invalid();
        const reconstruction = reconstructOuterCase(op, original.operationFacts);
        normalizedOriginal = { domainReceipt: null, operationFacts: reconstruction.originalFacts, dataReference: null };
        stableIntent = reconstruction.stableIntent; result = reconstruction.result;
        anchorKind = 'case'; anchorId = reconstruction.next.caseId; resultScope = reconstruction.next.scope;
        actor = reconstruction.originalFacts.command.actorSubjectKey;
        operationId = reconstruction.originalFacts.command.operationId; at = reconstruction.originalFacts.command.at;
    } else if (op === 'acceptStagedOnboarding') {
        outerNoFacts(original, false, true);
        const inner = domain.normaliseAcceptanceReceipt(original.domainReceipt), state = inner.originalFacts.caseState;
        if (inner.receiptId !== header.receiptId) invalid();
        const accepted = domain.applyOnboardingCommand(state, { action: 'accept', operationId: inner.operationId,
            expectedRevision: state.revision, actorSubjectKey: inner.originalFacts.proof.subjectKey,
            at: inner.effect.acceptedAt, payload: { receipt: inner } });
        const binding = domain.createStagedIdentityBinding(inner);
        anchorKind = 'case'; anchorId = inner.caseId; resultScope = inner.scope;
        actor = inner.originalFacts.proof.subjectKey; operationId = inner.operationId; at = inner.effect.acceptedAt;
        stableIntent = outerDomainIntent(op, anchorKind, anchorId, inner.intent);
        normalizedOriginal = { domainReceipt: inner, operationFacts: null,
            dataReference: outerDataReference(original.dataReference, inner) };
        result = { case: outerCaseProjection(accepted), binding: outerBindingProjection(binding), acceptedAt: at };
    } else if (op === 'publishExistingMembershipBinding') {
        outerNoFacts(original);
        const inner = domain.normalisePublicationReceipt(original.domainReceipt);
        if (inner.receiptId !== header.receiptId) invalid();
        anchorKind = 'binding'; anchorId = inner.binding.bindingId; resultScope = inner.binding.scope;
        actor = inner.originalFacts.actorSubjectKey; operationId = inner.operationId; at = inner.originalFacts.at;
        stableIntent = outerDomainIntent(op, anchorKind, anchorId, inner.intent);
        normalizedOriginal = { domainReceipt: inner, operationFacts: null, dataReference: null };
        result = { binding: outerBindingProjection(inner.binding) };
    } else if (OUTER_INSTANCE_OPERATIONS.includes(op)) {
        if (original.domainReceipt !== null || original.dataReference !== null) invalid();
        const extra = fields(original.operationFacts, ['predecessor', 'command', 'facts']);
        result = applyInstanceOperation(extra.predecessor, extra.command, extra.facts);
        const command = copy(extra.command, MAX_SMALL), facts = copy(extra.facts, MAX_SMALL);
        if (command.operationType !== op || command.instanceId !== header.instanceId) invalid();
        normalizedOriginal = { domainReceipt: null, operationFacts: {
            predecessor: extra.predecessor === null ? null : normalizeInstance(extra.predecessor), command, facts }, dataReference: null };
        stableIntent = command; anchorKind = 'instance'; anchorId = command.instanceId; resultScope = null;
        actor = command.actorSubjectKey; operationId = command.operationId; at = facts.occurredAt;
    } else invalid();
    if (header.anchorKind !== anchorKind || header.anchorId !== anchorId || !equal(header.scope, resultScope) ||
        header.actorSubjectKey !== actor || header.operationId !== operationId || header.occurredAt !== at) invalid();
    const base = copy({ ...header, stableIntent, intentSha256: hash(stableIntent), originalFacts: normalizedOriginal,
        result, resultSha256: hash(result) }, MAX_OPERATION);
    return freeze(copy({ ...base, receiptSha256: hash(base) }, MAX_EFFECT));
}
function normalizeOuterReceipt(value) {
    return retained(() => {
        const supplied = fields(copy(value, MAX_EFFECT), OUTER_FIELDS);
        digest(supplied.intentSha256); digest(supplied.resultSha256); digest(supplied.receiptSha256);
        const expected = makeOuterReceipt(Object.fromEntries(OUTER_INPUT_FIELDS.map(key => [key, supplied[key]])));
        if (!equal(expected, supplied)) bad();
        return expected;
    });
}

function receiptAuditAuthority(outer) {
    const op = outer.operationType, original = outer.originalFacts, inner = original.domainReceipt;
    if (OUTER_INSTANCE_OPERATIONS.includes(op) || ['initializeOperatorSession', 'revokeSession'].includes(op)) return null;
    if (OUTER_ADMISSION_OPERATIONS.includes(op)) return inner.anchorId;
    if (['activateCustomerSession', 'selectBinding'].includes(op)) return inner.originalFacts.facts.binding.authorityRef.authorityId;
    if (op === 'publishExistingMembershipBinding') return inner.binding.authorityRef.authorityId;
    if (op === 'acceptStagedOnboarding') return inner.originalFacts.caseState.approval.authorityRef.authorityId;
    if (op === 'recordProofAndActivateDiscovery') {
        const state = original.operationFacts.caseState;
        return (state.approval ? state.approval.authorityRef : state.authorityRef).authorityId;
    }
    const facts = original.operationFacts;
    if (op === 'expireCase') return (facts.predecessor.approval ?
        facts.predecessor.approval.authorityRef : facts.predecessor.authorityRef).authorityId;
    return facts.command.payload.authorityRef.authorityId;
}
function normalizeReceiptAudit(value, normalizedOuter) {
    // normalizedOuter MUST already be the owning store's checked outer receipt.
    // The audit envelope is separately fetched/charged; no new receipt recursion.
    return retained(() => {
        const envelope = fields(copy(value, MAX_SMALL), ['sessionSha256', 'instanceId', 'authorityId', 'event']);
        const outer = normalizedOuter, maintenance = OUTER_INSTANCE_OPERATIONS.includes(outer.operationType) ||
            OUTER_ADMISSION_OPERATIONS.includes(outer.operationType);
        if (maintenance) { if (envelope.sessionSha256 !== null) bad(); }
        else digest(envelope.sessionSha256);
        uuid(envelope.instanceId); if (envelope.authorityId !== null) uuid(envelope.authorityId);
        if (envelope.instanceId !== outer.instanceId || envelope.authorityId !== receiptAuditAuthority(outer) ||
            outer.anchorKind === 'session' && envelope.sessionSha256 !== outer.anchorId) bad();
        const event = fields(envelope.event, ['schemaVersion', 'eventType', 'eventId', 'requestId', 'occurredAt',
            'actorSubjectKey', 'scope', 'action', 'outcome', 'resourceKey', 'operationId']);
        uuid(event.requestId);
        const resourceKey = outer.anchorKind === 'authority' ? 'admission' : outer.anchorKind;
        if (event.schemaVersion !== 1 || event.eventType !== 'dashboard.runtime' ||
            event.eventId !== outer.auditEventId || event.operationId !== outer.operationId ||
            event.actorSubjectKey !== outer.actorSubjectKey || event.occurredAt !== outer.occurredAt ||
            !equal(event.scope, outer.scope) || event.action !== outer.operationType ||
            event.outcome !== 'succeeded' || event.resourceKey !== resourceKey ||
            maintenance && event.requestId !== outer.operationId || hash(envelope) !== outer.auditEventSha256) bad();
        return freeze(envelope);
    });
}

function publicationEffect(command) {
    return { schemaVersion: 1, operationType: 'publish_existing_membership', bindingId: command.bindingId, scope: command.scope,
        membershipId: command.membershipId, invitationId: command.invitationId, grantEvidenceId: command.grantEvidenceId,
        identity: command.identity, validFrom: command.validFrom, validUntil: command.validUntil };
}
async function routeScope(inv) {
    const op = inv.operationType, command = inv.command;
    if (op === 'createCase') return command.template.scope;
    if (op === 'publishExistingMembershipBinding') return command.scope;
    if (op === 'recordProofAndActivateDiscovery') return inv.proof.scope;
    const byBinding = ['activateCustomerSession', 'selectBinding'].includes(op);
    const byCase = ['approveCase', 'revokeCase', 'denyCase', 'expireCase', 'acceptStagedOnboarding', 'readOnboardingStatus'].includes(op);
    const selected = op === 'readSession' || isSelectedResourceRead(op);
    if (!byBinding && !byCase && !selected) return null;
    return rawTransaction(inv, async tx => {
        const caseId = byCase ? command.caseId || inv.capture.discovery.caseId : null;
        await enter(inv, tx, null, { case_id: caseId || '', binding_id: byBinding ? command.bindingId : '' });
        await initialFences(inv, tx); const instance = currentInstance(inv, await loadInstance(inv, tx));
        const gate = await loadGate(inv, tx);
        currentGate(inv, gate, op === 'activateCustomerSession' || op === 'readSession' && ['operator_dashboard', 'customer'].includes(inv.capture.kind));
        if (selected) {
            if (isSelectedResourceRead(op) && (!gate || !gate.selectedBindingId)) denied();
            await capture(inv); inv.routeGate = gate;
            sealFinalAuthority(inv, { instance, gate });
            return gate && gate.selectedBindingId ? { tenantId: gate.selectedTenantId, organisationId: gate.selectedOrganisationId } : null;
        }
        await inv.query(tx, 'SET LOCAL ROLE nofries_dashboard_subject_reader');
        let result;
        if (byBinding) result = await inv.query(tx, 'SELECT binding_id, tenant_id, organisation_id FROM nofries.dashboard_identity_bindings WHERE binding_id = $1 AND identity_sha256 = $2 AND subject_key = $3', [command.bindingId, hash(inv.capture.identityPayload), subjectOf(inv.capture.identityPayload)]);
        else result = await inv.query(tx, 'SELECT case_id, tenant_id, organisation_id FROM nofries.dashboard_onboarding_cases WHERE case_id = $1', [caseId]);
        if (result.rows.length !== 1) denied();
        let target; retained(() => {
            const row = fields(result.rows[0], [byBinding ? 'binding_id' : 'case_id', 'tenant_id', 'organisation_id']);
            if (row[byBinding ? 'binding_id' : 'case_id'] !== (byBinding ? command.bindingId : caseId)) bad();
            target = scope({ tenantId: row.tenant_id, organisationId: row.organisation_id });
        });
        if (op === 'activateCustomerSession' && command.scope && !equal(command.scope, target)) denied();
        await capture(inv); await externalEpoch(inv); inv.routeGate = gate;
        sealFinalAuthority(inv, { instance, gate }); return freeze(target);
    });
}
async function currentProofFor(inv, tx, state) {
    const proof = await loadProof(inv, tx, inv.capture.discovery.proofId);
    if (!proof || proof.caseId !== state.caseId || proof.proofId !== inv.capture.discovery.proofId || !equal(proof.scope, state.scope) ||
        !equal(proof.identity, inv.capture.identityPayload) || proof.verifiedAt > inv.now() || proof.freshUntil <= inv.now()) denied();
    return proof;
}
function sessionCommand(inv, gate, original = null) {
    const c = inv.capture, op = inv.operationType, input = inv.command;
    const seed = { identityPayload: c.identityPayload, instanceId: c.instanceId, restoreEpoch: c.restoreEpoch, issuedAt: c.issuedAt, expiresAt: c.expiresAt };
    let payload;
    if (op === 'initializeOperatorSession') payload = { seed, operatorIssuanceSha256: hash(c.operatorIssuanceProof) };
    else if (op === 'activateCustomerSession') payload = { seed, bindingId: input.bindingId };
    else if (op === 'recordProofAndActivateDiscovery') payload = { seed, caseId: c.discovery.caseId, proofId: c.discovery.proofId };
    else if (op === 'revokeSession') payload = { seed };
    else payload = { bindingId: input.bindingId, expectedRevision: original ? original.payload.expectedRevision : gate.revision,
        expectedSelectionGeneration: original ? original.payload.expectedSelectionGeneration : gate.selectionGeneration, expectedGeneration: input.expectedGeneration };
    return { schemaVersion: 1, operationType: op, operationId: input.operationId, sessionSha256: c.sessionSha256, actorSubjectKey: subjectOf(c.identityPayload), payload };
}
function caseCommand(inv, state, at, authority, original = null) {
    const command = inv.command, action = OUTER_CASE_ACTIONS[inv.operationType]; let payload;
    if (action === 'create') payload = { caseId: command.caseId, templateRef: command.templateRef, template: command.template, acceptBefore: command.acceptBefore, authorityRef: command.authorityRef };
    else if (action === 'approve') payload = { approvalId: command.approvalId, acceptBefore: command.acceptBefore, authorityRef: command.authorityRef };
    else if (action === 'revoke') payload = { authorityRef: command.authorityRef, predecessor: original ? original.payload.predecessor : state.status === 'accepted' ? authority : null };
    else if (action === 'deny') payload = { authorityRef: command.authorityRef };
    else payload = {};
    return { action, operationId: command.operationId, expectedRevision: action === 'create' ? null : command.expectedRevision,
        actorSubjectKey: subjectOf(inv.capture.identityPayload), at, payload };
}
function commandBusiness(value) { const { at, ...business } = value; return business; }
function scopedContext(inv, target, extra = {}) {
    return { organisation_id: target ? target.organisationId : '', case_id: inv.command.caseId || (inv.capture && inv.capture.discovery ? inv.capture.discovery.caseId : ''),
        binding_id: inv.command.bindingId || '', ...extra };
}
async function optionalAuthority(inv, tx, target, update) {
    const result = await inv.query(tx, 'SELECT organisation_id FROM nofries.dashboard_organisations WHERE tenant_id = $1 AND organisation_id = $2', [target.tenantId, target.organisationId]);
    if (result.rows.length > 1) bad(); return result.rows.length ? canonicalAuthority(inv, tx, target, update) : null;
}
async function runtimeContext(inv, tx, target) {
    const op = inv.operationType, command = inv.command;
    let ctx = scopedContext(inv, target);
    await enter(inv, tx, target, ctx); await initialFences(inv, tx, SESSION_OPS.includes(op));
    const instance = currentInstance(inv, await loadInstance(inv, tx));
    const gate = await loadGate(inv, tx), allowAbsent = inv.starter === true || ['initializeOperatorSession', 'activateCustomerSession', 'recordProofAndActivateDiscovery', 'revokeSession'].includes(op);
    currentGate(inv, gate, allowAbsent, op === 'revokeSession');
    if (!gate && op === 'revokeSession' && inv.capture.kind !== 'operator_dashboard') denied();
    let caseEntry = ctx.case_id ? await loadCase(inv, tx, ctx.case_id) : null;
    let binding = ctx.binding_id ? await loadBinding(inv, tx, ctx.binding_id) : null;
    if (caseEntry && target && !equal(caseEntry.state.scope, target) || binding && target && !equal(binding.scope, target)) denied();
    if (CASE_OPS.includes(op) && op !== 'createCase' && !caseEntry || ['acceptStagedOnboarding', 'recordProofAndActivateDiscovery'].includes(op) && !caseEntry ||
        ['selectBinding', 'activateCustomerSession'].includes(op) && !binding) denied();
    const authorityId = command.authorityRef ? command.authorityRef.authorityId : binding ? binding.authorityRef.authorityId :
        caseEntry ? (caseEntry.state.approval || caseEntry.state).authorityRef.authorityId : null;
    ctx = { ...ctx, authority_id: authorityId || '' };
    await settings(inv, tx, ctx); await tenantSetting(inv, tx, target);
    let admission = null;
    if (authorityId) { await fence(inv, tx, 71003, authorityId); admission = await loadAdmission(inv, tx, authorityId); }
    if (ctx.case_id) {
        await fence(inv, tx, 71004, ctx.case_id, true);
        caseEntry = await loadCase(inv, tx, ctx.case_id);
        if (caseEntry && target && !equal(caseEntry.state.scope, target)) denied();
    }
    const anchor = SESSION_OPS.includes(op) ? 'session' : op === 'publishExistingMembershipBinding' ? 'binding' : 'case';
    const anchorId = anchor === 'session' ? inv.capture.sessionSha256 : anchor === 'binding' ? command.bindingId : ctx.case_id;
    const receipt = await findReceipt(inv, tx, anchor, anchorId, command.operationId);
    if (receipt && (receipt.operationType !== op || receipt.instanceId !== inv.options.instanceId)) conflict();
    if (inv.recovering && !receipt) ambiguous();
    if (!receipt && own(inv, 'routeGate') && !equal(inv.routeGate, gate)) { if (op === 'selectBinding') conflict(); denied(); }
    const state = caseEntry && caseEntry.state;
    let authority = null;
    if (target) {
        if (['selectBinding', 'activateCustomerSession', 'publishExistingMembershipBinding'].includes(op) ||
            op === 'acceptStagedOnboarding' && (receipt || state.template.kind === 'existing_organisation') ||
            op === 'revokeCase' && state && state.status === 'accepted') authority = await canonicalAuthority(inv, tx, target, !['selectBinding', 'activateCustomerSession'].includes(op));
        else if (CASE_OPS.includes(op)) authority = await optionalAuthority(inv, tx, target, op === 'revokeCase');
    }
    if (ctx.binding_id) binding = await loadBinding(inv, tx, ctx.binding_id);
    const terminal = ['revokeCase', 'denyCase', 'expireCase'].includes(op);
    const expectedEffect = op === 'createCase' ? hash(command.template) : state ? state.templateSha256 : op === 'publishExistingMembershipBinding' ? hash(publicationEffect(command)) : null;
    const policyIdentity = op === 'publishExistingMembershipBinding' ? command.identity : state && state.candidateProof ? state.candidateProof.identity : binding ? binding.identity : null;
    if (authorityId) currentAdmission(inv, admission, target, policyIdentity, expectedEffect, terminal);
    if (command.authorityRef) refMatches(command.authorityRef, admission);
    if (OPERATOR_OPS.includes(op) && inv.starter !== true) permit(inv.options.authoriseOperatorOperation, { operationType: inv.activation ? 'customerActivation' : op,
        ...(inv.activation ? { activationId: inv.activation.approval.activationId, phase: inv.activation.phase } : {}), capture: inv.capture,
        command, instance, admission, caseState: state, currentAuthority: authority });
    if (['selectBinding', 'activateCustomerSession'].includes(op)) {
        const originalAdmission = await historicalAdmission(inv, tx, binding.authorityRef, target);
        currentAdmission(inv, admission, target, binding.identity, originalAdmission.payload.approvedEffectSha256);
        bindingCurrent(inv, binding, authority);
    }
    const timing = { caseState: state };
    if (['selectBinding', 'activateCustomerSession'].includes(op)) Object.assign(timing, bindingTiming(binding, authority));
    return { tx, target, ctx, instance, gate, caseEntry, state, binding, authorityId, admission, authority, anchor, anchorId, receipt, timing };
}
async function updateCase(inv, tx, next, entry) {
    await writeRow(inv, tx, 'case', next, { capabilitySha256: entry.capabilitySha256 }, true);
    await writeRow(inv, tx, 'decision', next);
}
async function finalRuntime(inv, context, gate = context.gate) {
    const { tx, target, authorityId } = context;
    const base = await finalSessionCheck(inv, tx, gate, { absent: gate === null, terminal: inv.operationType === 'revokeSession' });
    if (authorityId) {
        const current = await loadAdmission(inv, tx, authorityId);
        if (!equal(current, context.admission)) denied();
        const state = context.state, op = inv.operationType;
        currentAdmission(inv, current, target, op === 'publishExistingMembershipBinding' ? inv.command.identity :
            state && state.candidateProof ? state.candidateProof.identity : context.binding ? context.binding.identity : null,
        op === 'createCase' ? hash(inv.command.template) : state ? state.templateSha256 :
            op === 'publishExistingMembershipBinding' ? hash(publicationEffect(inv.command)) : null,
        ['revokeCase', 'denyCase', 'expireCase'].includes(op));
        base.admission = current;
    }
    sealFinalAuthority(inv, base, context.timing);
    inv.now();
}
async function saveOuter(inv, context, outer, audit) {
    await writeRow(inv, context.tx, 'audit', audit);
    await writeRow(inv, context.tx, 'receipt', outer);
}
function chargeOuterFacts(inv, facts) {
    const operation = facts.operationFacts;
    const count = (facts.domainReceipt ? 1 : 0) + (operation && operation.predecessor ? 1 : 0) +
        (operation && operation.caseState ? 1 : 0) + (operation && operation.bindingPredecessor ? 1 : 0) +
        (operation && operation.command && operation.command.payload && operation.command.payload.predecessor ? 1 : 0);
    inv.charge(facts, count);
}
function outerFor(inv, context, ids, at, facts, target = context.target, auditAuthority = context.authorityId) {
    chargeOuterFacts(inv, facts);
    const audit = makeAudit(inv, ids.auditEventId, at, target, auditAuthority);
    const outer = makeOuterReceipt({ schemaVersion: 1, receiptId: ids.receiptId, operationType: inv.operationType, operationId: inv.command.operationId,
        instanceId: inv.options.instanceId, anchorKind: context.anchor, anchorId: context.anchorId, scope: target,
        actorSubjectKey: subjectOf(inv.capture.identityPayload), occurredAt: at, originalFacts: facts, auditEventId: ids.auditEventId, auditEventSha256: hash(audit) });
    return { outer, audit };
}
async function replayRuntime(inv, context) {
    const { receipt, tx, state, gate, authority, target } = context, op = inv.operationType, input = inv.command;
    if (receipt.actorSubjectKey !== subjectOf(inv.capture.identityPayload)) conflict();
    if (SESSION_OPS.includes(op)) {
        const inner = receiptDomain(receipt), expectedCommand = sessionCommand(inv, gate, inner.stableIntent);
        if (!equal(expectedCommand, inner.stableIntent)) conflict();
        await proveHistory(inv, tx, receipt, gate);
        if (op === 'recordProofAndActivateDiscovery') {
            const originalProof = inner.originalFacts.facts.proof, storedProof = await loadProof(inv, tx, originalProof.proofId);
            if (!storedProof || !equal(storedProof, originalProof) || !equal(inv.proof, originalProof) || !state || !equal(state.scope, originalProof.scope)) bad();
            inv.charge({ receipt: inner, caseState: receipt.originalFacts.operationFacts.caseState }, 2);
            const next = reconstructCompoundProof(inner, receipt.originalFacts.operationFacts.caseState).next;
            if (!equal(state.decisions.slice(0, next.decisions.length), next.decisions)) bad();
            if (state.status === 'accepted') {
                const currentAuthority = await canonicalAuthority(inv, tx, target);
                await settings(inv, tx, { ...context.ctx, binding_id: state.template.bindingId });
                const binding = await loadBinding(inv, tx, state.template.bindingId), proof = await currentProofFor(inv, tx, state);
                inv.charge({ receipt: state.acceptanceReceipt, caseState: state, proof, currentAuthority, currentBinding: binding, at: inv.now() }, 5);
                domain.reconcileAcceptanceReceipt({ receipt: state.acceptanceReceipt, caseState: state, proof, currentAuthority, currentBinding: binding, at: inv.now() });
                Object.assign(context.timing, acceptanceTiming({ caseState: state, proof, currentAuthority, currentBinding: binding }));
            } else if (['revoked', 'expired', 'denied'].includes(state.status) || inv.now() >= state.acceptBefore || state.approval && inv.now() >= state.approval.acceptBefore) denied();
            if (state.status !== 'accepted') Object.assign(context.timing, { proof: inv.proof,
                freshCaseAcceptBefore: state.acceptBefore, freshApprovalAcceptBefore: state.approval && state.approval.acceptBefore });
        }
    } else if (CASE_OPS.includes(op)) {
        const original = receipt.originalFacts.operationFacts, expectedCommand = caseCommand(inv, state, original.command.at, authority, original.command);
        if (!equal(commandBusiness(expectedCommand), commandBusiness(original.command)) || op !== 'createCase' && input.expectedHeadSha256 !== receipt.stableIntent.expectedHeadSha256) conflict();
        if (op === 'createCase') {
            if (inv.capability.capabilitySha256 !== original.capabilitySha256 || context.caseEntry.capabilitySha256 !== original.capabilitySha256) conflict();
        }
        inv.charge(original, (original.predecessor ? 1 : 0) + (original.bindingPredecessor ? 1 : 0) + (original.command.payload.predecessor ? 1 : 0));
        const reconstructed = reconstructOuterCase(op, original);
        if (!state || !equal(state.decisions.slice(0, reconstructed.next.decisions.length), reconstructed.next.decisions)) bad();
        if (reconstructed.nextBinding) {
            await settings(inv, tx, { ...context.ctx, binding_id: reconstructed.nextBinding.bindingId });
            const currentBinding = await loadBinding(inv, tx, reconstructed.nextBinding.bindingId);
            if (!equal(currentBinding, reconstructed.nextBinding)) bad();
            const currentAuthority = authority || await canonicalAuthority(inv, tx, target);
            inv.charge({ receipt: reconstructed.next.acceptanceReceipt, currentAuthority }, 2);
            domain.assertAcceptanceIncluded(reconstructed.next.acceptanceReceipt, currentAuthority);
            const member = currentAuthority.membershipState.memberships.find(row => row.membershipId === reconstructed.next.template.membership.membershipId);
            if (!member || member.status !== 'removed') bad();
        }
    } else if (op === 'acceptStagedOnboarding') {
        const original = receiptDomain(receipt), approved = original.originalFacts.caseState.approval;
        if (input.approvalId !== approved.approvalId || input.approvalRevision !== approved.revision) conflict();
        await settings(inv, tx, { ...context.ctx, binding_id: original.effect.bindingId });
        const binding = await loadBinding(inv, tx, original.effect.bindingId), proof = await currentProofFor(inv, tx, state);
        const facts = { receipt: original, caseState: state, proof, currentAuthority: authority, currentBinding: binding, at: inv.now() };
        inv.charge(facts, 5); domain.reconcileAcceptanceReceipt(facts);
        Object.assign(context.timing, acceptanceTiming(facts));
        if (original.effect.kind === 'bootstrap') {
            const actual = await prepareBootstrap(inv, original).reconcile(tx);
            if (!equal(actual.reference, receipt.originalFacts.dataReference)) bad();
        }
    } else {
        const original = receiptDomain(receipt), expectedIntent = { schemaVersion: 1, operationType: 'publish_existing_membership', ...input, actorSubjectKey: subjectOf(inv.capture.identityPayload) };
        if (!equal(expectedIntent, original.intent)) conflict();
        const facts = { receipt: original, currentAuthority: authority, currentBinding: context.binding, at: inv.now() };
        inv.charge(facts, 3); domain.reconcilePublicationReceipt(facts);
        Object.assign(context.timing, bindingTiming(context.binding, authority));
    }
    await finalRuntime(inv, context); return receipt.result;
}

async function freshSession(inv, context) {
    const { tx, gate, state } = context, op = inv.operationType;
    const ids = { receiptId: inv.identifier(), auditEventId: inv.identifier() }, at = inv.now();
    const facts = { occurredAt: at, generationToken: inv.token() };
    if (op === 'initializeOperatorSession') facts.operatorIssuanceProof = inv.capture.operatorIssuanceProof;
    if (['selectBinding', 'activateCustomerSession'].includes(op)) facts.binding = context.binding;
    if (op === 'recordProofAndActivateDiscovery') facts.proof = inv.proof;
    const input = { ...ids, predecessor: gate, command: sessionCommand(inv, gate), facts };
    inv.charge(input, (gate ? 1 : 0) + (facts.binding || facts.proof || facts.operatorIssuanceProof ? 1 : 0));
    const inner = domain.createTransitionReceipt(input);
    let compound = null;
    if (op === 'recordProofAndActivateDiscovery') {
        const duplicate = await inv.query(tx, 'SELECT proof_id FROM nofries.dashboard_onboarding_proofs WHERE case_id = $1 AND (proof_id = $2 OR authentication_sha256 = $3 OR operation_id = $4)', [state.caseId, inv.proof.proofId, inv.proof.authenticationSha256, inv.proof.operationId]);
        if (duplicate.rows.length) conflict();
        inv.charge({ receipt: inner, caseState: state }, 2); compound = reconstructCompoundProof(inner, state);
        if (state.status === 'accepted') {
            const authority = await canonicalAuthority(inv, tx, context.target);
            await settings(inv, tx, { ...context.ctx, binding_id: state.template.bindingId });
            const binding = await loadBinding(inv, tx, state.template.bindingId);
            const reconcile = { receipt: state.acceptanceReceipt, caseState: state, proof: inv.proof, currentAuthority: authority, currentBinding: binding, at: inv.now() };
            inv.charge(reconcile, 5); domain.reconcileAcceptanceReceipt(reconcile);
            Object.assign(context.timing, acceptanceTiming(reconcile));
        }
    }
    const target = compound ? inv.proof.scope : selectedOuterScope(inner.result.record);
    const originalFacts = { domainReceipt: inner, operationFacts: compound ? { caseState: state } : null, dataReference: null };
    const built = outerFor(inv, context, ids, at, originalFacts, target, ['initializeOperatorSession', 'revokeSession'].includes(op) ? null : context.authorityId);
    const limits = [[inner.result.record, MAX_SMALL], [built.outer, MAX_EFFECT], [built.audit, MAX_SMALL]];
    if (compound) limits.push([inv.proof, MAX_SMALL], [compound.next, MAX_EFFECT]);
    await preflight(inv, tx, limits);
    if (compound) {
        await writeRow(inv, tx, 'proof', inv.proof);
        if (!equal(compound.next, state)) await updateCase(inv, tx, compound.next, context.caseEntry);
    }
    if (!equal(gate, inner.result.record)) await writeRow(inv, tx, 'session', inner.result.record, {}, gate !== null);
    await tenantSetting(inv, tx, target);
    await saveOuter(inv, context, built.outer, built.audit);
    if (compound) {
        const currentAt = inv.now();
        if (currentAt >= inv.proof.freshUntil || state.status !== 'accepted' &&
            (currentAt >= state.acceptBefore || state.approval && currentAt >= state.approval.acceptBefore)) denied();
        Object.assign(context.timing, { caseState: compound.next, proof: inv.proof });
        if (state.status !== 'accepted') Object.assign(context.timing, { freshCaseAcceptBefore: state.acceptBefore,
            freshApprovalAcceptBefore: state.approval && state.approval.acceptBefore });
    }
    if (context.binding && context.authority) bindingCurrent(inv, context.binding, context.authority);
    await finalRuntime(inv, context, inner.result.record); return built.outer.result;
}
async function freshCase(inv, context) {
    const { tx, state, authority } = context, op = inv.operationType, input = inv.command;
    if (op === 'createCase') { if (state) conflict(); }
    else if (!state || input.expectedRevision !== state.revision || input.expectedHeadSha256 !== state.headSha256) conflict();
    const ids = { receiptId: inv.identifier(), auditEventId: inv.identifier() }, at = inv.now();
    let previousBinding = null;
    if (op === 'revokeCase' && state.status === 'accepted') {
        await settings(inv, tx, { ...context.ctx, binding_id: state.template.bindingId });
        previousBinding = await loadBinding(inv, tx, state.template.bindingId); if (!previousBinding) bad();
    }
    const command = caseCommand(inv, state, at, authority);
    const operationFacts = { predecessor: state, command, bindingPredecessor: previousBinding,
        capabilitySha256: op === 'createCase' ? inv.capability.capabilitySha256 : null };
    inv.charge(operationFacts, (state ? 1 : 0) + (previousBinding ? 1 : 0) + (command.action === 'revoke' && command.payload.predecessor ? 1 : 0));
    const next = reconstructOuterCase(op, operationFacts);
    const built = outerFor(inv, context, ids, at, { domainReceipt: null, operationFacts, dataReference: null });
    const limits = [[next.next, MAX_EFFECT], [built.outer, MAX_EFFECT], [built.audit, MAX_SMALL]];
    if (next.nextBinding) limits.push([next.nextBinding, MAX_SMALL], [next.next.revocationEffect.nextMembershipState, MAX_EFFECT]);
    await preflight(inv, tx, limits);
    if (next.next.revocationEffect && next.nextBinding) {
        const effect = next.next.revocationEffect;
        if (!equal(effect.nextMembershipState, effect.predecessor.membershipState)) {
            inv.now(); await dataStorage.updateMembershipState(tx, effect.nextMembershipState); inv.now();
        }
        await writeRow(inv, tx, 'binding', next.nextBinding, {}, true);
    }
    if (state) await updateCase(inv, tx, next.next, context.caseEntry);
    else {
        await writeRow(inv, tx, 'case', next.next, { capabilitySha256: inv.capability.capabilitySha256 });
        await writeRow(inv, tx, 'decision', next.next);
    }
    await saveOuter(inv, context, built.outer, built.audit);
    if (['createCase', 'approveCase'].includes(op) && inv.now() >= input.acceptBefore) denied();
    context.timing.caseState = next.next;
    if (['createCase', 'approveCase'].includes(op)) context.timing.freshCaseAcceptBefore = input.acceptBefore;
    await finalRuntime(inv, context); return built.outer.result;
}
async function freshAcceptance(inv, context) {
    const { tx, state, authority, target } = context, input = inv.command;
    if (!state || state.status !== 'approved' || state.approval.approvalId !== input.approvalId || state.approval.revision !== input.approvalRevision) conflict();
    const proof = await currentProofFor(inv, tx, state), at = inv.now();
    const ids = { receiptId: inv.identifier(), auditEventId: inv.identifier() };
    if (state.template.kind === 'bootstrap') {
        const exists = await inv.query(tx, 'SELECT tenant_id FROM nofries.dashboard_tenants WHERE tenant_id = $1 FOR UPDATE', [target.tenantId]);
        if (exists.rows.length) conflict();
    }
    const originalInput = { receiptId: ids.receiptId, caseState: state, proof, operationId: input.operationId, acceptedAt: at,
        predecessor: state.template.kind === 'bootstrap' ? null : authority };
    inv.charge(originalInput, 2 + (authority ? 1 : 0));
    const inner = domain.createAcceptanceReceipt(originalInput);
    inv.charge(inner, 1); const binding = domain.createStagedIdentityBinding(inner);
    const acceptCommand = { action: 'accept', operationId: input.operationId, expectedRevision: state.revision, actorSubjectKey: proof.subjectKey, at, payload: { receipt: inner } };
    inv.charge({ state, command: acceptCommand }, 2); const next = domain.applyOnboardingCommand(state, acceptCommand);
    await settings(inv, tx, { ...context.ctx, binding_id: binding.bindingId });
    if (await loadBinding(inv, tx, binding.bindingId)) conflict();
    const bootstrap = inner.effect.kind === 'bootstrap' ? prepareBootstrap(inv, inner) : null;
    const dataReference = bootstrap ? bootstrap.prepared.expectedReference : null;
    const built = outerFor(inv, context, ids, at, { domainReceipt: inner, operationFacts: null, dataReference });
    await preflight(inv, tx, [[inner, MAX_EFFECT], [next, MAX_EFFECT], [binding, MAX_SMALL], [built.outer, MAX_EFFECT], [built.audit, MAX_SMALL],
        [inner.effect.kind === 'bootstrap' ? inner.effect.initialState : inner.effect.nextMembershipState, MAX_EFFECT]]);
    if (bootstrap) {
        const actual = await bootstrap.execute(tx);
        if (!equal(actual.reference, dataReference)) bad();
        // The predicted value is replaced only by its verified equal actual reference.
        if (!equal(built.outer.originalFacts.dataReference, actual.reference)) bad();
    } else { inv.now(); await dataStorage.updateMembershipState(tx, inner.effect.nextMembershipState); inv.now(); }
    await updateCase(inv, tx, next, context.caseEntry); await writeRow(inv, tx, 'binding', binding);
    await saveOuter(inv, context, built.outer, built.audit);
    const finalAt = inv.now();
    if (finalAt >= state.acceptBefore || finalAt >= state.approval.acceptBefore || finalAt >= proof.freshUntil ||
        finalAt < state.template.membership.validFrom || finalAt >= state.template.membership.validUntil) denied();
    const current = await canonicalAuthority(inv, tx, target);
    const check = { receipt: inner, caseState: next, proof, currentAuthority: current, currentBinding: binding, at: inv.now() };
    inv.charge(check, 5); domain.reconcileAcceptanceReceipt(check);
    Object.assign(context.timing, acceptanceTiming(check), { freshCaseAcceptBefore: state.acceptBefore,
        freshApprovalAcceptBefore: state.approval.acceptBefore, freshMembership: state.template.membership });
    await finalRuntime(inv, context); return built.outer.result;
}
async function freshPublication(inv, context) {
    if (context.binding) conflict();
    const ids = { receiptId: inv.identifier(), auditEventId: inv.identifier() }, at = inv.now();
    const facts = { receiptId: ids.receiptId, ...inv.command, actorSubjectKey: subjectOf(inv.capture.identityPayload), at, currentAuthority: context.authority };
    inv.charge(facts, 1); const inner = domain.publishExistingMembershipBinding(facts);
    const built = outerFor(inv, context, ids, at, { domainReceipt: inner, operationFacts: null, dataReference: null });
    await preflight(inv, context.tx, [[inner.binding, MAX_SMALL], [inner, MAX_EFFECT], [built.outer, MAX_EFFECT], [built.audit, MAX_SMALL]]);
    await writeRow(inv, context.tx, 'binding', inner.binding); await saveOuter(inv, context, built.outer, built.audit);
    const check = { receipt: inner, currentAuthority: context.authority, currentBinding: inner.binding, at: inv.now() };
    inv.charge(check, 3); domain.reconcilePublicationReceipt(check);
    Object.assign(context.timing, bindingTiming(inner.binding, context.authority));
    await finalRuntime(inv, context); return built.outer.result;
}
async function runtimeMutation(inv) {
    await capture(inv); purpose(inv); await externalEpoch(inv);
    if (inv.operationType === 'recordProofAndActivateDiscovery') {
        const supplied = await inv.provider('readVerifiedOnboardingProof', inv.request);
        try { inv.proof = domain.createIdentityProof(copy(supplied, MAX_SMALL)); } catch (_) { unavailable(); }
        if (inv.proof.operationId !== inv.command.operationId || inv.proof.caseId !== inv.capture.discovery.caseId ||
            inv.proof.proofId !== inv.capture.discovery.proofId || !equal(inv.proof.identity, inv.capture.identityPayload)) denied();
    }
    if (inv.operationType === 'createCase') {
        const supplied = await inv.provider('readPreparedCaseCapability', inv.request, { caseId: inv.command.caseId, operationId: inv.command.operationId });
        try { inv.capability = freeze(fields(copy(supplied, MAX_SMALL), ['caseId', 'operationId', 'capabilitySha256'])); uuid(inv.capability.caseId); uuid(inv.capability.operationId); digest(inv.capability.capabilitySha256); } catch (_) { unavailable(); }
        if (inv.capability.caseId !== inv.command.caseId || inv.capability.operationId !== inv.command.operationId) denied();
    }
    const target = await routeScope(inv); inv.committed = false;
    const work = async tx => {
        const context = await runtimeContext(inv, tx, target);
        if (context.receipt) return replayRuntime(inv, context);
        if (SESSION_OPS.includes(inv.operationType)) return freshSession(inv, context);
        if (CASE_OPS.includes(inv.operationType)) return freshCase(inv, context);
        if (inv.operationType === 'acceptStagedOnboarding') return freshAcceptance(inv, context);
        return freshPublication(inv, context);
    };
    try { return await transaction(inv, target, work); }
    catch (error) {
        if (!(error instanceof PostgresDatabaseError) || !['postgres_commit_failed', 'postgres_rollback_failed'].includes(error.code)) throw error;
        inv.attempt = null; inv.recovering = true; inv.committed = false;
        try {
            inv.now(); await capture(inv); await externalEpoch(inv);
            // Only the prior routing capture may continue; no new hint/selection is adopted.
            return await transaction(inv, target, work);
        } catch (recovery) {
            if (recovery instanceof domain.DashboardOnboardingError && ['onboarding_access_denied', 'onboarding_conflict', 'onboarding_unavailable'].includes(recovery.code)) throw recovery;
            ambiguous();
        }
    }
}

function maintenanceCommand(inv) {
    const c = inv.command;
    if (ADMISSION_OPS.includes(inv.operationType)) return { schemaVersion: 1, operationType: inv.operationType, ...c };
    return { schemaVersion: 1, operationType: inv.operationType, operationId: c.operationId, instanceId: inv.options.instanceId,
        actorSubjectKey: c.actorSubjectKey, expectedRevision: c.expectedRevision, expectedRecordSha256: c.expectedRecordSha256,
        payload: { restoreEpoch: c.restoreEpoch, evidenceRef: c.evidenceRef, evidenceSha256: c.evidenceSha256 } };
}
async function maintenanceWork(inv, tx) {
    const op = inv.operationType, input = inv.command, instanceOp = INSTANCE_OPS.includes(op), target = instanceOp ? null : input.payload.target;
    await enter(inv, tx, target, { authority_id: instanceOp ? '' : input.authorityId });
    await initialFences(inv, tx, false, instanceOp);
    const found = await loadInstance(inv, tx), instance = found && found.record;
    if (instance && inv.now() < instance.changedAt) denied();
    let admission = null;
    if (!instanceOp) { currentInstance(inv, found, true); await fence(inv, tx, 71003, input.authorityId, true); admission = await loadAdmission(inv, tx, input.authorityId); }
    const anchorKind = instanceOp ? 'instance' : 'authority', anchorId = instanceOp ? inv.options.instanceId : input.authorityId;
    const original = await findReceipt(inv, tx, anchorKind, anchorId, input.operationId);
    const command = maintenanceCommand(inv);
    if (original && original.operationType !== op) conflict(); if (inv.recovering && !original) ambiguous();
    if (instanceOp && !original) {
        if (command.payload.restoreEpoch !== inv.externalEpoch.restoreEpoch) denied();
        if (op === 'initializeRuntimeInstance' && instance !== null) conflict();
        if (op !== 'initializeRuntimeInstance' && !instance) conflict();
        if (instance && instance.restoreEpoch !== inv.externalEpoch.restoreEpoch && !(op === 'fenceRestoreEpoch' && instance.ingressStatus === 'fenced')) denied();
    } else if (instanceOp) currentInstance(inv, found, true);
    permit(inv.options.authoriseMaintenanceOperation, { operationType: op, command: input, instance, admission, externalEpoch: inv.externalEpoch });
    if (original) {
        const priorCommand = instanceOp ? original.originalFacts.operationFacts.command : receiptDomain(original).stableIntent;
        if (!equal(command, priorCommand)) conflict();
        await proveHistory(inv, tx, original, instanceOp ? instance : admission);
        await externalEpoch(inv); const current = currentInstance(inv, await loadInstance(inv, tx), true);
        sealFinalAuthority(inv, { instance: current, admission }); inv.now(); return original.result;
    }
    const at = inv.now(), receiptId = inv.identifier(), auditEventId = inv.identifier();
    let facts, result;
    if (instanceOp) {
        inv.charge({ predecessor: instance, command, facts: { occurredAt: at } }, instance ? 1 : 0);
        result = applyInstanceOperation(instance, command, { occurredAt: at });
        facts = { domainReceipt: null, operationFacts: { predecessor: instance, command, facts: { occurredAt: at } }, dataReference: null };
    } else {
        const innerInput = { receiptId, auditEventId, predecessor: admission, command, facts: { occurredAt: at } };
        inv.charge(innerInput, admission ? 1 : 0); const inner = domain.createTransitionReceipt(innerInput); result = inner.result;
        facts = { domainReceipt: inner, operationFacts: null, dataReference: null };
    }
    const audit = makeAudit(inv, auditEventId, at, target, instanceOp ? null : input.authorityId);
    chargeOuterFacts(inv, facts);
    const outer = makeOuterReceipt({ schemaVersion: 1, receiptId, operationType: op, operationId: input.operationId, instanceId: inv.options.instanceId,
        anchorKind, anchorId, scope: target, actorSubjectKey: input.actorSubjectKey, occurredAt: at, originalFacts: facts, auditEventId, auditEventSha256: hash(audit) });
    await preflight(inv, tx, [[result.record, MAX_SMALL], [outer, MAX_EFFECT], [audit, MAX_SMALL]]);
    if (instanceOp) await writeRow(inv, tx, 'instance', result.record, { receiptId }, instance !== null);
    else { await writeRow(inv, tx, 'authority', result.record, {}, admission !== null); await writeRow(inv, tx, 'admission', result.record); }
    await writeRow(inv, tx, 'audit', audit); await writeRow(inv, tx, 'receipt', outer);
    await externalEpoch(inv); const current = currentInstance(inv, await loadInstance(inv, tx), true);
    sealFinalAuthority(inv, { instance: current, admission: instanceOp ? null : result.record }); inv.now(); return outer.result;
}
async function maintenanceMutation(inv) {
    await externalEpoch(inv);
    try { return await rawTransaction(inv, tx => maintenanceWork(inv, tx)); }
    catch (error) {
        if (!(error instanceof PostgresDatabaseError) || !['postgres_commit_failed', 'postgres_rollback_failed'].includes(error.code)) throw error;
        inv.attempt = null; inv.recovering = true; inv.committed = false;
        try { inv.now(); await externalEpoch(inv); return await rawTransaction(inv, tx => maintenanceWork(inv, tx)); }
        catch (recovery) {
            if (recovery instanceof domain.DashboardOnboardingError && ['onboarding_access_denied', 'onboarding_conflict', 'onboarding_unavailable'].includes(recovery.code)) throw recovery;
            ambiguous();
        }
    }
}

function directoryInput(value) {
    const snapshot = copy(value, MAX_SMALL);
    const input = fields(snapshot, ['limit', 'afterBindingId', ...(own(snapshot, 'bindingId') ? ['bindingId'] : [])]);
    if (own(input, 'bindingId')) uuid(input.bindingId);
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) invalid();
    if (input.afterBindingId !== null) uuid(input.afterBindingId); return freeze(input);
}
function eventInput(value) {
    return normaliseRuntimeReadEventInput(value);
}
function capabilityInput(value) {
    const input = fields(copy(value, MAX_SMALL), ['capability']);
    if (typeof input.capability !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.capability)) invalid();
    const decoded = Buffer.from(input.capability, 'base64url');
    if (decoded.length !== 32 || decoded.toString('base64url') !== input.capability) invalid();
    return crypto.createHash('sha256').update(decoded).digest('hex');
}
async function readContext(inv, tx, target, allowInitialization = false) {
    let ctx = scopedContext(inv, target);
    await enter(inv, tx, target, ctx); await initialFences(inv, tx);
    const instance = currentInstance(inv, await loadInstance(inv, tx));
    const gate = await loadGate(inv, tx);
    currentGate(inv, gate, allowInitialization && ['operator_dashboard', 'customer'].includes(inv.capture.kind));
    if (isSelectedResourceRead(inv.operationType) && (!gate || !gate.selectedBindingId || !target)) denied();
    if (own(inv, 'routeGate') && !equal(gate, inv.routeGate)) denied();
    let state = null, binding = null, authority = null, admission = null, authorityId = null, proof = null;
    if (inv.operationType === 'readOnboardingStatus') {
        const entry = await loadCase(inv, tx, inv.capture.discovery.caseId); if (!entry || !equal(entry.state.scope, target)) denied();
        authorityId = (entry.state.approval || entry.state).authorityRef.authorityId;
        ctx = { ...ctx, authority_id: authorityId };
        await settings(inv, tx, ctx); await tenantSetting(inv, tx, target);
        await fence(inv, tx, 71003, authorityId); admission = await loadAdmission(inv, tx, authorityId);
        await fence(inv, tx, 71004, entry.state.caseId);
        const current = await loadCase(inv, tx, entry.state.caseId); if (!current || !equal(current.state, entry.state)) bad(); state = current.state;
        proof = await currentProofFor(inv, tx, state);
        if (state.candidateProof && !equal(state.candidateProof.identity, inv.capture.identityPayload)) denied();
        currentAdmission(inv, admission, target, inv.capture.identityPayload, state.templateSha256);
        if (state.template.kind === 'existing_organisation' && !state.acceptanceReceipt) authority = await canonicalAuthority(inv, tx, target);
        if (state.acceptanceReceipt) {
            authority = await canonicalAuthority(inv, tx, target);
            ctx = { ...ctx, binding_id: state.template.bindingId }; await settings(inv, tx, ctx);
            binding = await loadBinding(inv, tx, state.template.bindingId);
            const outer = await receiptById(inv, tx, state.acceptanceReceipt.receiptId);
            if (outer.operationType !== 'acceptStagedOnboarding' || !equal(receiptDomain(outer), state.acceptanceReceipt)) bad();
            const facts = { receipt: state.acceptanceReceipt, caseState: state, proof, currentAuthority: authority, currentBinding: binding, at: inv.now() };
            inv.charge(facts, 5); domain.reconcileAcceptanceReceipt(facts);
            if (state.acceptanceReceipt.effect.kind === 'bootstrap') {
                const actual = await prepareBootstrap(inv, state.acceptanceReceipt).reconcile(tx);
                if (!equal(actual.reference, outer.originalFacts.dataReference)) bad();
            }
        }
    } else if (gate && gate.selectedBindingId && (inv.operationType === 'readSession' || isSelectedResourceRead(inv.operationType))) {
        if (!target || target.tenantId !== gate.selectedTenantId || target.organisationId !== gate.selectedOrganisationId) denied();
        ctx = { ...ctx, binding_id: gate.selectedBindingId }; await settings(inv, tx, ctx);
        binding = await loadBinding(inv, tx, gate.selectedBindingId); if (!binding || !equal(binding.scope, target)) denied();
        authorityId = binding.authorityRef.authorityId; ctx = { ...ctx, authority_id: authorityId }; await settings(inv, tx, ctx);
        await fence(inv, tx, 71003, authorityId); admission = await loadAdmission(inv, tx, authorityId);
        const birth = await historicalAdmission(inv, tx, binding.authorityRef, target);
        currentAdmission(inv, admission, target, binding.identity, birth.payload.approvedEffectSha256);
        authority = await canonicalAuthority(inv, tx, target); binding = await loadBinding(inv, tx, gate.selectedBindingId); bindingCurrent(inv, binding, authority);
    }
    return { tx, target, ctx, instance, gate, state, binding, authority, authorityId, admission, proof };
}
async function finalRead(inv, context) {
    const base = await finalSessionCheck(inv, context.tx, context.gate, { absent: context.gate === null });
    const timing = { caseState: context.state, proof: context.proof };
    if (context.admission) {
        const current = await loadAdmission(inv, context.tx, context.authorityId);
        if (!equal(current, context.admission)) denied();
        currentAdmission(inv, current, context.target, context.state ? inv.capture.identityPayload : context.binding.identity,
            context.state ? context.state.templateSha256 : null);
        base.admission = current;
    }
    if (context.state && context.state.acceptanceReceipt) {
        const facts = { receipt: context.state.acceptanceReceipt, caseState: context.state, proof: context.proof,
            currentAuthority: context.authority, currentBinding: context.binding, at: inv.now() };
        inv.charge(facts, 5); domain.reconcileAcceptanceReceipt(facts);
        Object.assign(timing, acceptanceTiming(facts));
    } else if (context.binding) {
        bindingCurrent(inv, context.binding, context.authority);
        Object.assign(timing, bindingTiming(context.binding, context.authority));
    }
    sealFinalAuthority(inv, base, timing);
    inv.now();
}
async function storeReadEvent(inv, context, input, requireExisting = false) {
    if (!context.gate) denied();
    const raw = await selectRow(inv, context.tx, 'audit', 'event_id', input.eventId);
    if (raw) {
        const row = cleanRow('audit', raw), supplied = { sessionSha256: row.session_sha256, instanceId: row.instance_id, authorityId: row.authority_id, event: row.payload };
        inv.charge(supplied, 1);
        retained(() => {
            const event = fields(supplied.event, ['schemaVersion', 'eventType', 'eventId', 'requestId', 'occurredAt',
                'actorSubjectKey', 'scope', 'action', 'outcome', 'resourceKey', 'operationId']);
            if (typeof event.action === 'string' && own(RUNTIME_READ_RESOURCES, event.action)) {
                normaliseRuntimeReadAudit(supplied);
            } else {
                if (supplied.sessionSha256 !== null) digest(supplied.sessionSha256); uuid(supplied.instanceId);
                if (supplied.authorityId !== null) uuid(supplied.authorityId);
                if (event.schemaVersion !== 1 || event.eventType !== 'dashboard.runtime') bad();
                uuid(event.eventId); uuid(event.requestId); instant(event.occurredAt); subject(event.actorSubjectKey);
                if (event.scope !== null) scope(event.scope);
                if (!own(COMMAND_FIELDS, event.action) || event.resourceKey !== receiptResource(event.action) || event.outcome !== 'succeeded') bad();
                uuid(event.operationId);
            }
            rowAgrees('audit', row, supplied);
        });
        const originalRequestId = retained(() => uuid(row.payload.requestId));
        const originalTime = retained(() => instant(row.payload.occurredAt));
        const candidate = makeAudit(inv, input.eventId, originalTime, context.target, context.authorityId,
            null, input.action, input.outcome, input.resourceKey);
        const expected = { ...candidate, event: { ...candidate.event, requestId: originalRequestId } };
        if (!equal(supplied, expected)) conflict(); return;
    }
    if (requireExisting) ambiguous();
    const event = makeAudit(inv, input.eventId, inv.now(), context.target, context.authorityId, null, input.action, input.outcome, input.resourceKey);
    await preflight(inv, context.tx, [[event, MAX_SMALL]]); await writeRow(inv, context.tx, 'audit', event);
}
function successfulReadEvent(inv) { return { eventId: inv.identifier(), action: inv.operationType, outcome: 'succeeded', resourceKey: RUNTIME_READ_RESOURCES[inv.operationType][0], operationId: null }; }
async function readSession(inv) {
    await capture(inv); purpose(inv); await externalEpoch(inv); const target = await routeScope(inv);
    return transaction(inv, target, async tx => {
        const context = await readContext(inv, tx, target, true);
        if (!context.gate) { await finalRead(inv, context); return freeze({ schemaVersion: 1, state: 'initialization_required' }); }
        const gate = context.gate;
        const result = freeze({ schemaVersion: 1, state: 'ready', purpose: gate.kind, expiresAt: gate.expiresAt,
            generation: gate.generationToken, selectedBindingId: gate.selectedBindingId });
        await storeReadEvent(inv, context, successfulReadEvent(inv)); await finalRead(inv, context); return result;
    });
}
async function readOnboardingStatus(inv) {
    await capture(inv); purpose(inv); await externalEpoch(inv); const target = await routeScope(inv);
    return transaction(inv, target, async tx => {
        const context = await readContext(inv, tx, target), state = context.state;
        const result = freeze({ schemaVersion: 1, status: state.status,
            approval: state.approval ? { approvalId: state.approval.approvalId, revision: state.approval.revision,
                organisationLabel: resolveOrganisation(state.template.kind === 'bootstrap' ? state.template.bootstrap.tenantAggregate : context.authority.tenantAggregate, state.scope).displayName, roles: copy(state.template.membership.roles), acceptBefore: state.approval.acceptBefore } : null,
            receipt: state.acceptanceReceipt ? { operationId: state.acceptanceReceipt.operationId, acceptedAt: state.acceptanceReceipt.effect.acceptedAt } : null });
        await storeReadEvent(inv, context, successfulReadEvent(inv)); await finalRead(inv, context); return result;
    });
}
async function discoverBindings(inv) {
    await capture(inv); purpose(inv); await externalEpoch(inv);
    const result = await rawTransaction(inv, async tx => {
        const context = await readContext(inv, tx, null); inv.routeGate = context.gate;
        await inv.query(tx, 'SET LOCAL ROLE nofries_dashboard_subject_reader');
        const restricted = own(inv.command, 'bindingId');
        const query = await inv.query(tx, 'SELECT binding_id, organisation_label FROM nofries.dashboard_identity_bindings WHERE identity_sha256 = $1 AND subject_key = $2 AND ($3::uuid IS NULL OR binding_id > $3::uuid)' +
            (restricted ? ' AND binding_id = $5::uuid' : '') + ' ORDER BY binding_id LIMIT $4',
            [hash(inv.capture.identityPayload), subjectOf(inv.capture.identityPayload), inv.command.afterBindingId, inv.command.limit + 1,
                ...(restricted ? [inv.command.bindingId] : [])]);
        if (query.rows.length > inv.command.limit + 1) bad();
        const rows = retained(() => query.rows.map(raw => {
            const row = fields(copy(raw, MAX_SMALL), ['binding_id', 'organisation_label']); uuid(row.binding_id); if (typeof row.organisation_label !== 'string' || !row.organisation_label || row.organisation_label.length > 200) bad(); unicode(row.organisation_label);
            if (restricted && row.binding_id !== inv.command.bindingId) bad();
            return { bindingId: row.binding_id, organisationLabel: row.organisation_label };
        }));
        for (let i = 0; i < rows.length; i++) if (i && rows[i - 1].bindingId >= rows[i].bindingId || inv.command.afterBindingId && rows[i].bindingId <= inv.command.afterBindingId) bad();
        await capture(inv); await externalEpoch(inv);
        sealFinalAuthority(inv, { instance: context.instance, gate: context.gate }); inv.now();
        return freeze({ schemaVersion: 1, bindings: rows.slice(0, inv.command.limit), nextAfterBindingId: rows.length > inv.command.limit ? rows[inv.command.limit - 1].bindingId : null });
    });
    // The SELECT-only client is settled and released before this same-invocation continuation.
    await rawTransaction(inv, async tx => {
        const context = await readContext(inv, tx, null);
        await storeReadEvent(inv, context, successfulReadEvent(inv)); await finalRead(inv, context);
    });
    inv.now(); return result;
}
async function lookupCaseCapability(inv, capabilitySha256) {
    return rawTransaction(inv, async tx => {
        await enter(inv, tx, null, { capability_sha256: capabilitySha256 });
        await inv.query(tx, 'SET LOCAL ROLE nofries_dashboard_capability_reader');
        const result = await inv.query(tx, 'SELECT case_id, tenant_id, organisation_id, status, accept_before, capability_sha256 FROM nofries.dashboard_onboarding_cases WHERE capability_sha256 = $1', [capabilitySha256]);
        if (result.rows.length > 1) bad(); if (!result.rows.length) return null;
        return retained(() => {
            const row = fields(result.rows[0], ['case_id', 'tenant_id', 'organisation_id', 'status', 'accept_before', 'capability_sha256']);
            uuid(row.case_id); if (row.capability_sha256 !== capabilitySha256 || !['awaiting_identity', 'identity_verified', 'approved', 'accepted', 'denied', 'expired', 'revoked'].includes(row.status)) bad();
            const acceptBefore = instant(row.accept_before instanceof Date ? row.accept_before.toISOString() : row.accept_before);
            return freeze({ caseId: row.case_id, scope: scope({ tenantId: row.tenant_id, organisationId: row.organisation_id }), status: row.status, acceptBefore });
        });
    });
}
async function recordRuntimeEvent(inv, input) {
    await capture(inv); purpose(inv); await externalEpoch(inv); const target = await routeScope(inv);
    const work = async tx => {
        const context = await readContext(inv, tx, target);
        await storeReadEvent(inv, context, input, inv.recovering); await finalRead(inv, context);
        return freeze({ schemaVersion: 1, eventId: input.eventId, recorded: true });
    };
    try { return await transaction(inv, target, work); }
    catch (error) {
        if (!(error instanceof PostgresDatabaseError) || !['postgres_commit_failed', 'postgres_rollback_failed'].includes(error.code)) throw error;
        inv.attempt = null; inv.recovering = true;
        try { await capture(inv); await externalEpoch(inv); return await transaction(inv, target, work); }
        catch (recovery) {
            if (recovery instanceof domain.DashboardOnboardingError && ['onboarding_access_denied', 'onboarding_conflict', 'onboarding_unavailable'].includes(recovery.code)) throw recovery;
            ambiguous();
        }
    }
}
// A distinct fixed-plan path. It can initialise only a new reserved scope and
// publish its first binding after genuine customer MFA/consent. SQL additionally
// limits this lane to the starter product and account/client capacities.
async function requireLegacySignupRegistration(inv, tx, target, subjectKey) {
    await inv.query(tx, "SELECT set_config('nofries.tenant_id',$1,true),set_config('nofries.signup_subject_key',$2,true)",
        [subjectKey.slice(0, 36), subjectKey]);
    const bound = { query: (sql, params) => inv.query(tx, sql, params) };
    const layout = await readSignupRegistrationLayout(bound);
    if (layout === 'legacy') await lockSignupRegistrationHeader(bound, subjectKey);
    await tenantSetting(inv, tx, target);
    // After SQL0015 every fresh lifecycle stays closed, including historical
    // v1 headers and subjects without a registration yet. Ready reads remain
    // passive in the production composition.
    if (layout === 'scoped') denied();
}
async function starterCustomerMutation(options, request, input, diagnostic) {
    const selector = fields(copy(input, MAX_SMALL), ['requestId', 'phase']); uuid(selector.requestId);
    if (!['prepare', 'activate'].includes(selector.phase) || !options.readStarterProvisioning) denied();
    if (selector.phase === 'prepare') { diagnostic.enable(); diagnostic.mark('request_validation'); }
    const inv = newInvocation(options, request, 'publishExistingMembershipBinding', freeze({ operationId: selector.requestId }));
    if (selector.phase === 'prepare') inv.preparationDiagnostic = diagnostic;
    inv.starter = true;
    if (selector.phase === 'activate') { await capture(inv); if (inv.capture.kind !== 'customer') denied(); purpose(inv); }
    let original;
    async function approved() {
        diagnostic.mark(original ? 'provider_recheck' : 'provider_read');
        const raw = fields(copy(await inv.provider('readStarterProvisioning', request, selector), MAX_OPERATION), ['provisioning', 'deadline']);
        diagnostic.mark(original ? 'provider_recheck' : 'provider_compile');
        const p = starterProvisioning.compileStarterProvisioning(raw.provisioning); instant(raw.deadline);
        if (p.slot.requestId !== selector.requestId || raw.deadline <= inv.now() ||
            inv.capture && p.subjectKey !== subjectOf(inv.capture.identityPayload)) denied();
        inv.intersect(raw.deadline);
        if (original && !equal(original, p)) denied();
        return p;
    }
    const p = original = await approved(), target = p.scope, slot = p.slot;
    if (p.kind === 'client' && !inv.capture) {
        await capture(inv); if (inv.capture.kind !== 'customer' || p.subjectKey !== subjectOf(inv.capture.identityPayload)) denied();
        purpose(inv);
    }
    diagnostic.mark('external_epoch'); await externalEpoch(inv);
    diagnostic.mark('bootstrap_initialisation');
    const bootstrapCommand = starterProvisioning.starterBootstrapCommand(p);
    const work = async tx => {
        inv.operationType = 'publishExistingMembershipBinding';
        inv.command = freeze({ operationId: selector.requestId });
        inv.starterParent = null;
        diagnostic.mark('database_context');
        await enter(inv, tx, target, { subject_key: p.subjectKey, binding_id: slot.bindingId, authority_id: slot.authorityId });
        await requireLegacySignupRegistration(inv, tx, target, p.subjectKey);
        diagnostic.mark('instance_fence');
        await initialFences(inv, tx, selector.phase === 'activate');
        diagnostic.mark('instance_read');
        const instance = currentInstance(inv, await loadInstance(inv, tx));
        // Lock ordering is account, then organisation, then admission/binding.
        // Unique email/subject and account ordinal constraints fence other workers.
        const emailSha = crypto.createHash('sha256').update('nofries:starter-email:v1\0' + p.email).digest('hex');
        if (selector.phase === 'prepare') {
            diagnostic.mark('starter_account_insert');
            await inv.query(tx, 'INSERT INTO nofries.dashboard_starter_accounts (account_id,email_sha256,subject_key,account_type) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
                [p.accountId, emailSha, p.subjectKey, p.accountType]);
        }
        diagnostic.mark('starter_account_lock');
        const rows = await inv.query(tx, 'SELECT account_id,email_sha256,subject_key,account_type,activated_at FROM nofries.dashboard_starter_accounts WHERE account_id=$1 FOR UPDATE', [p.accountId]);
        if (rows.rows.length !== 1) denied();
        const account = rows.rows[0];
        if (account.account_id !== p.accountId || account.email_sha256 !== emailSha || account.subject_key !== p.subjectKey || account.account_type !== p.accountType) denied();
        if (p.kind === 'client') {
            // Hold the original workspace's authority locks until COMMIT. A
            // revoked parent cannot admit new clients through a still-valid BFF.
            const own = await inv.query(tx, 'SELECT preparation,activation FROM nofries.dashboard_starter_scopes WHERE account_id=$1 AND ordinal=0', [p.accountId]);
            if (own.rows.length !== 1 || !own.rows[0].activation) denied();
            const parent = starterProvisioning.retainedStarterPreparation(own.rows[0].preparation);
            starterProvisioning.retainedStarterActivation(parent, own.rows[0].activation);
            if (parent.accountId !== p.accountId || parent.subjectKey !== p.subjectKey || parent.accountType !== 'consultant' ||
                parent.planId !== p.planId || parent.planSha256 !== p.planSha256) denied();
            await enter(inv, tx, parent.scope, { subject_key: p.subjectKey,
                binding_id: parent.slot.bindingId, authority_id: parent.slot.authorityId });
            await fence(inv, tx, 71003, parent.slot.authorityId);
            await inv.query(tx, 'SELECT binding_id FROM nofries.dashboard_identity_bindings WHERE binding_id=$1 FOR SHARE', [parent.slot.bindingId]);
            const parentBinding = await loadBinding(inv, tx, parent.slot.bindingId);
            const parentAdmission = await loadAdmission(inv, tx, parent.slot.authorityId);
            const parentAuthority = await canonicalAuthority(inv, tx, parent.scope);
            currentAdmission(inv, parentAdmission, parent.scope, inv.capture.identityPayload, own.rows[0].activation.admission.payload.approvedEffectSha256);
            bindingCurrent(inv, parentBinding, parentAuthority);
            const eligibility = resolveEntitlements(parentAuthority.entitlementState, parentAuthority.tenantAggregate,
                parent.scope, inv.now(), parentAuthority.flags);
            if (eligibility.product?.grantId !== parent.slot.grantId || eligibility.product.agreementRef !== parent.slot.scheduleId ||
                !eligibility.modules.overview.eligible) denied();
            inv.starterParent = { admission: parentAdmission, starterProduct: eligibility.product, ...bindingTiming(parentBinding, parentAuthority) };
            await enter(inv, tx, target, { subject_key: p.subjectKey, binding_id: slot.bindingId, authority_id: slot.authorityId });
        }
        // The account row already serializes this account's scope mutations.
        // SELECT FOR UPDATE would apply the activation-only UPDATE policy and
        // hide committed scopes, breaking retries and lost-COMMIT recovery.
        diagnostic.mark('starter_scope_read');
        const found = await inv.query(tx, 'SELECT preparation,activation FROM nofries.dashboard_starter_scopes WHERE tenant_id=$1 AND organisation_id=$2', [target.tenantId, target.organisationId]);
        if (found.rows.length > 1 || selector.phase === 'activate' && !found.rows.length) denied();
        let saved = found.rows[0];
        if (saved && !equal(starterProvisioning.retainedStarterPreparation(saved.preparation), p)) denied();
        if (!saved) {
            diagnostic.mark('starter_scope_insert');
            await inv.query(tx, 'INSERT INTO nofries.dashboard_starter_scopes (tenant_id,organisation_id,account_id,account_type,subject_key,ordinal,authority_id,binding_id,preparation) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)',
                [target.tenantId, target.organisationId, p.accountId, p.accountType, p.subjectKey, p.ordinal, slot.authorityId, slot.bindingId, JSON.stringify(p)]);
            saved = { preparation: p, activation: null };
        }
        const bound = Object.freeze({ query: (sql, params) => inv.query(tx, sql, params) });
        const bootstrap = createBootstrapOperations({ clock: () => inv.now(), authoriseAdministration(command, snapshot) {
            return equal(command, bootstrapCommand) && (own(snapshot, 'proposed')
                ? snapshot.organisation === null && equal(snapshot.proposed, p.initialState)
                : snapshot.tenantAggregate.tenant.tenantId === target.tenantId && snapshot.tenantAggregate.organisations.length === 1 &&
                    snapshot.tenantAggregate.organisations[0].organisationId === target.organisationId);
        } });
        diagnostic.mark('bootstrap_initialisation');
        const prepared = bootstrap.prepareInitialisation(bootstrapCommand, p.initialState);
        if (selector.phase === 'prepare') {
            diagnostic.mark('bootstrap_execute');
            const result = await bootstrap[found.rows.length || inv.recovering ? 'reconcileInTransaction' : 'executeInTransaction'](bound, prepared);
            await approved(); diagnostic.mark('external_epoch'); await externalEpoch(inv);
            diagnostic.mark('final_instance_check');
            const final = currentInstance(inv, await loadInstance(inv, tx));
            diagnostic.mark('final_instance_check');
            if (!equal(final, instance)) denied();
            sealFinalAuthority(inv, { instance: final });
            return freeze({ status: 'prepared', scope: target, bootstrapReference: result.reference });
        }
        await bootstrap.reconcileInTransaction(bound, prepared);
        const identityTenant = p.subjectKey.slice(0, 36);
        const acceptanceDatabase = Object.freeze({ async withTenantTransaction(tenantId, callback) {
            if (![identityTenant, target.tenantId].includes(tenantId)) denied();
            await inv.query(tx, "SELECT set_config('nofries.tenant_id',$1,true),set_config('nofries.signup_subject_key',$2,true)", [tenantId, p.subjectKey]);
            try { return await callback(bound); } finally { await tenantSetting(inv, tx, target); }
        } });
        await inv.query(tx, "SELECT set_config('nofries.tenant_id',$1,true),set_config('nofries.signup_subject_key',$2,true)", [identityTenant, p.subjectKey]);
        const locked = await lockSignupRegistrationHeader({ query: (sql, params) => inv.query(tx, sql, params) }, p.subjectKey);
        if (!locked || locked.subjectKey !== p.subjectKey) denied();
        await tenantSetting(inv, tx, target);
        const journal = createPostgresSignupAcceptanceJournal({ database: acceptanceDatabase });
        const registrations = createPostgresSignupRegistrationStore({ database: acceptanceDatabase });
        const ref = { ...target, invitationId: p.invitationId };
        const receipt = await journal.readForInvitation(ref);
        const registration = await registrations.readForInvitation({ ...ref, subjectKey: p.subjectKey });
        if (!receipt || !registration || registration.status !== 'pending_admission' || registration.receiptId !== receipt.receiptId ||
            ['subjectKey','tenantId','organisationId','invitationId','termsVersion','termsDigest','scheduleId','scheduleDigest'].some(k => receipt[k] !== registration[k])) denied();
        let compiled;
        if (saved.activation !== null) {
            compiled = starterProvisioning.retainedStarterActivation(p, saved.activation);
            if (!equal(compiled.activation.acceptance, receipt) || !equal(compiled.activation.identity, inv.capture.identityPayload)) denied();
        } else {
            if (inv.recovering) ambiguous();
            const clock = await inv.query(tx, `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS occurred_at`);
            const at = instant(clock.rows[0]?.occurred_at);
            const startedAt = account.activated_at === null ? null : new Date(account.activated_at).toISOString();
            if (p.kind === 'own' && startedAt !== null || p.kind === 'client' && startedAt === null) denied();
            compiled = starterProvisioning.compileStarterAdmission({ preparation: p, acceptance: receipt,
                identity: inv.capture.identityPayload, occurredAt: at, accountActivatedAt: p.kind === 'own' ? null : startedAt });
            if (p.kind === 'own') {
                const changed = await inv.query(tx, 'UPDATE nofries.dashboard_starter_accounts SET activated_at=$1 WHERE account_id=$2 AND activated_at IS NULL RETURNING account_id', [at, p.accountId]);
                if (changed.rows.length !== 1) conflict();
            }
        }
        const commands = starterProvisioning.starterActivationCommands(p, compiled);
        const data = createPostgresDashboardRepository({ database: { async withTenantTransaction(tenantId, callback) {
            if (tenantId !== target.tenantId) denied(); return callback(bound);
        } }, clock: () => compiled.activation.occurredAt,
        authoriseAdministration: command => commands.some(allowed => equal(command, allowed)) });
        for (const command of commands) {
            if (command.type === 'usage.reserve') await data.reserveInitialMembership(command);
            else await data.executeAuthorityCommand(command);
        }
        if (saved.activation === null) {
            const actual = await dataStorage.loadSnapshotForShare(bound, target);
            if (!equal(actual, compiled.nextState)) denied();
            const changed = await inv.query(tx, 'UPDATE nofries.dashboard_starter_scopes SET activation=$1::jsonb WHERE tenant_id=$2 AND organisation_id=$3 AND activation IS NULL RETURNING tenant_id',
                [JSON.stringify(compiled.activation), target.tenantId, target.organisationId]);
            if (changed.rows.length !== 1) conflict();
            await writeRow(inv, tx, 'authority', compiled.activation.admission);
            await writeRow(inv, tx, 'admission', compiled.activation.admission);
        }
        inv.command = commandInput('publishExistingMembershipBinding', compiled.command);
        const context = await runtimeContext(inv, tx, target);
        const publication = context.receipt ? await replayRuntime(inv, context) : await freshPublication(inv, context);
        await approved(); await finalRuntime(inv, context);
        if (!context.gate) {
            // Publication audit records reference the genuine customer session.
            // Create its first selected gate in this same transaction, after the
            // binding exists and before the deferred audit FK is checked.
            inv.operationType = 'activateCustomerSession';
            inv.command = commandInput(inv.operationType, { operationId: slot.acceptOperationId, bindingId: slot.bindingId });
            const sessionContext = await runtimeContext(inv, tx, target);
            await freshSession(inv, sessionContext);
        }
        return freeze({ status: 'activated', accountId: p.accountId, scope: target, subjectKey: p.subjectKey,
            receiptId: slot.activationId, activatedAt: compiled.activation.validFrom, validUntil: compiled.activation.validUntil,
            bindingId: slot.bindingId, publication });
    };
    try { return await transaction(inv, target, work); }
    catch (error) {
        if (!(error instanceof PostgresDatabaseError) || !['postgres_commit_failed','postgres_rollback_failed'].includes(error.code)) throw error;
        inv.attempt = null; inv.recovering = true; inv.committed = false;
        try { if (selector.phase === 'activate') await capture(inv); await approved(); diagnostic.mark('external_epoch'); await externalEpoch(inv); return await transaction(inv, target, work); }
        catch (recovery) { if (recovery instanceof domain.DashboardOnboardingError && recovery.statusCode === 403) throw recovery; ambiguous(); }
    }
}

// Administrative preparation uses a genuine operator session, not an invented
// customer or operator proof. The approval loader is a server-owned Reader port.
// DATA receipts retain their existing types; binding publication retains its
// existing runtime receipt/audit contract and executes in the same transaction.
async function approvedCustomerMutation(options, request, input) {
    const selector = fields(copy(input, MAX_SMALL), ['activationId', 'phase']);
    uuid(selector.activationId);
    if (!['prepare', 'activate'].includes(selector.phase) || !options.readCustomerActivation) denied();
    const inv = newInvocation(options, request, 'publishExistingMembershipBinding', freeze({ operationId: selector.activationId }));
    await capture(inv); purpose(inv); await externalEpoch(inv);
    const permitAction = () => permit(options.authoriseOperatorOperation, { operationType: 'customerActivation',
        activationId: selector.activationId, phase: selector.phase, capture: inv.capture });
    permitAction(); // Do not expose approval or customer records to non-admins.
    let original;
    async function approved() {
        const raw = fields(copy(await inv.provider('readCustomerActivation', request, selector.activationId), MAX_OPERATION), ['approval', 'authority']);
        const approval = customerActivation.normaliseActivationApproval(raw.approval);
        if (approval.activationId !== selector.activationId || approval.approvedBy !== subjectOf(inv.capture.identityPayload) ||
            inv.now() < approval.approvedAt || inv.now() >= approval.expiresAt) denied();
        const authority = customerAuthority(raw.authority, approval.subjectKey, Date.parse(inv.now()));
        if (authority.bindingId !== null || authority.revision !== approval.authorityRevision || hash(authority) !== approval.authoritySha256) denied();
        const value = freeze({ approval, authority });
        if (original && !equal(original, value)) denied();
        return value;
    }
    original = await approved();
    const approval = original.approval, commands = customerActivation.buildActivationCommands(approval), target = approval.scope;
    // Keep both independent approvals live through the driver's final COMMIT
    // dispatch, including timeout-setting I/O after the last Blob read.
    inv.intersect(approval.expiresAt);
    inv.intersect(new Date(original.authority.expiresAt).toISOString());
    inv.command = commandInput('publishExistingMembershipBinding', commands.pub);
    inv.activation = { approval, phase: selector.phase };
    const work = async tx => {
        await enter(inv, tx, target, { binding_id: approval.bindingId, authority_id: approval.authorityRef.authorityId });
        await requireLegacySignupRegistration(inv, tx, target, approval.subjectKey);
        await initialFences(inv, tx);
        const instance = currentInstance(inv, await loadInstance(inv, tx)), gate = currentGate(inv, await loadGate(inv, tx));
        await fence(inv, tx, 71003, approval.authorityRef.authorityId);
        const admission = await loadAdmission(inv, tx, approval.authorityRef.authorityId);
        currentAdmission(inv, admission, target, approval.identity, hash(publicationEffect(inv.command)));
        refMatches(approval.authorityRef, admission); permitAction();
        const query = (sql, params) => inv.query(tx, sql, params);
        const boundTx = Object.freeze({ query });
        const database = Object.freeze({ async withTenantTransaction(tenantId, callback) {
            if (tenantId !== target.tenantId) denied();
            return callback(boundTx);
        } });
        const bootstrap = createBootstrapOperations({ clock: () => inv.now(),
            authoriseAdministration: (command, snapshot) => equal(command, commands.bootstrap) &&
                (own(snapshot, 'proposed') ? snapshot.organisation === null && equal(snapshot.proposed, approval.initialState) :
                    snapshot.tenantAggregate.tenant.tenantId === target.tenantId &&
                    snapshot.tenantAggregate.organisations.length === 1 &&
                    snapshot.tenantAggregate.organisations[0].organisationId === target.organisationId) });
        const prepared = bootstrap.prepareInitialisation(commands.bootstrap, approval.initialState);
        if (selector.phase === 'prepare') {
            const result = await bootstrap[inv.recovering ? 'reconcileInTransaction' : 'executeInTransaction'](boundTx, prepared);
            await approved();
            const final = await finalSessionCheck(inv, tx, gate);
            const current = await loadAdmission(inv, tx, approval.authorityRef.authorityId);
            if (!equal(current, admission)) denied();
            currentAdmission(inv, current, target, approval.identity, hash(publicationEffect(inv.command)));
            sealFinalAuthority(inv, { ...final, instance, admission: current });
            return freeze({ schemaVersion: 1, activationId: approval.activationId, phase: 'prepared',
                approvalSha256: hash(approval), bootstrapReference: result.reference });
        }
        // Preparation must already be durable. Activation never manufactures a
        // missing organisation after accepting an invitation that could not save.
        const bootstrapResult = await bootstrap.reconcileInTransaction(boundTx, prepared);
        const identityTenant = approval.subjectKey.slice(0, 36);
        const acceptanceDatabase = Object.freeze({ async withTenantTransaction(tenantId, callback) {
            if (![target.tenantId, identityTenant].includes(tenantId)) denied();
            await query("SELECT set_config('nofries.tenant_id',$1,true)", [tenantId]);
            try { return await callback(boundTx); }
            finally { await tenantSetting(inv, tx, target); }
        } });
        await query("SELECT set_config('nofries.tenant_id',$1,true),set_config('nofries.signup_subject_key',$2,true)", [identityTenant, approval.subjectKey]);
        const locked = await lockSignupRegistrationHeader({ query }, approval.subjectKey);
        if (!locked || locked.subjectKey !== approval.subjectKey) denied();
        await tenantSetting(inv, tx, target);
        const journal = createPostgresSignupAcceptanceJournal({ database: acceptanceDatabase });
        const registrations = createPostgresSignupRegistrationStore({ database: acceptanceDatabase });
        const reference = { ...target, invitationId: approval.invitationId };
        const receipt = await journal.readForInvitation(reference);
        const registration = await registrations.readForInvitation({ ...reference, subjectKey: approval.subjectKey });
        customerActivation.validateCustomerAcceptance(approval, original.authority, receipt, registration, Date.parse(inv.now()));
        if (inv.recovering) {
            const prior = await query('SELECT operation_id FROM nofries.dashboard_operation_receipts WHERE tenant_id=$1 AND organisation_id=$2 AND operation_id=$3',
                [target.tenantId, target.organisationId, commands.accept.operationId]);
            if (prior.rows.length !== 1) ambiguous();
            const reserved = await query('SELECT operation_id FROM nofries.dashboard_operation_receipts WHERE tenant_id=$1 AND organisation_id=$2 AND operation_id=$3',
                [target.tenantId, target.organisationId, commands.reserveMembership.operationId]);
            if (reserved.rows.length !== 1) ambiguous();
        }
        // This is processing of the immutable human acceptance, not an owner
        // pretending to accept. Its original event time and subject are retained.
        const data = createPostgresDashboardRepository({ database, clock: () => new Date(receipt.acceptedAt).toISOString(),
            authoriseAdministration: command => equal(command, commands.accept) || equal(command, commands.reserveMembership) });
        const membershipResult = await data.executeAuthorityCommand(commands.accept);
        const membershipReservation = await data.reserveInitialMembership(commands.reserveMembership);
        const context = await runtimeContext(inv, tx, target);
        const publication = context.receipt ? await replayRuntime(inv, context) : await freshPublication(inv, context);
        const latest = await approved();
        customerActivation.validateCustomerAcceptance(approval, latest.authority, receipt, registration, Date.parse(inv.now()));
        await finalRuntime(inv, context);
        return freeze({ schemaVersion: 2, activationId: approval.activationId, phase: 'activated',
            approvalSha256: hash(approval), bootstrapReference: bootstrapResult.reference,
            membershipOperationId: commands.accept.operationId, membershipResultSha256: hash(membershipResult),
            membershipReservationOperationId: commands.reserveMembership.operationId,
            membershipReservationResultSha256: hash(membershipReservation),
            membershipReservationResult: membershipReservation,
            publicationOperationId: commands.pub.operationId, publicationResultSha256: hash(publication),
            bindingId: approval.bindingId, acceptanceReceiptId: receipt.receiptId,
            acceptanceSha256: hash(receipt), authorityRevision: approval.authorityRevision,
            authoritySha256: approval.authoritySha256, observedAt: inv.now() });
    };
    try { return await transaction(inv, target, work); }
    catch (error) {
        if (!(error instanceof PostgresDatabaseError) || !['postgres_commit_failed', 'postgres_rollback_failed'].includes(error.code)) throw error;
        inv.attempt = null; inv.recovering = true; inv.committed = false;
        try { await capture(inv); await externalEpoch(inv); await approved(); return await transaction(inv, target, work); }
        catch (recovery) {
            if (recovery instanceof domain.DashboardOnboardingError && ['onboarding_access_denied', 'onboarding_conflict'].includes(recovery.code)) throw recovery;
            ambiguous();
        }
    }
}

function createPostgresDashboardRuntimeRepository(input) {
    const options = configuration(input, false), api = {};
    for (const op of [...SESSION_OPS, ...CASE_OPS, 'acceptStagedOnboarding', 'publishExistingMembershipBinding']) api[op] = async (request, command) => {
        try { const normalized = commandInput(op, command), inv = newInvocation(options, request, op, normalized); return await runtimeMutation(inv); }
        catch (error) { throw errorResult(error); }
    };
    for (const op of ['readSession', 'readOnboardingStatus']) api[op] = async request => {
        try { const inv = newInvocation(options, request, op, freeze({})); return await (op === 'readSession' ? readSession(inv) : readOnboardingStatus(inv)); }
        catch (error) { throw errorResult(error); }
    };
    api.discoverBindings = async (request, input) => {
        try { const normalized = directoryInput(input); return await discoverBindings(newInvocation(options, request, 'discoverBindings', normalized)); }
        catch (error) { throw errorResult(error); }
    };
    api.lookupCaseCapability = async input => {
        try { const capabilitySha256 = capabilityInput(input); return await lookupCaseCapability(newInvocation(options, null, 'lookupCaseCapability', freeze({})), capabilitySha256); }
        catch (error) { throw errorResult(error); }
    };
    api.recordRuntimeEvent = async (request, input) => {
        try { const normalized = eventInput(input); return await recordRuntimeEvent(newInvocation(options, request, normalized.action, freeze({})), normalized); }
        catch (error) { throw errorResult(error); }
    };
    if (options.readCustomerActivation) api.customerActivation = async (request, input) => {
        try { return await approvedCustomerMutation(options, request, input); }
        catch (error) { throw errorResult(error); }
    };
    if (options.readStarterProvisioning) api.starterProvisioning = async (request, input) => {
        const diagnostic = createPreparationDiagnostic();
        try { return await starterCustomerMutation(options, request, input, diagnostic); }
        catch (error) {
            diagnostic.fail(error);
            const result = errorResult(error);
            // No event is emitted here. Only a failed original operation can
            // enrich the existing signup reporter; recovered success discards it.
            attachPreparationDiagnostic(result, diagnostic);
            throw result;
        }
    };
    return Object.freeze(api);
}
function createPostgresDashboardMaintenanceRepository(input) {
    const options = configuration(input, true), api = {};
    for (const op of [...ADMISSION_OPS, ...INSTANCE_OPS]) api[op] = async command => {
        try { const normalized = commandInput(op, command); return await maintenanceMutation(newInvocation(options, null, op, normalized)); }
        catch (error) { throw errorResult(error); }
    };
    return Object.freeze(api);
}

// Separate dormant capability: no existing runtime operation, customer policy,
// public readSession audit or maintenance role is selected by this factory.
function administrationConfiguration(input) {
    if (!input || typeof input !== 'object' || isProxy(input)) invalid();
    const keys = ['pool', 'clock', 'instanceId', 'historyBudget', 'readExternalRuntimeEpoch',
        'newId', 'captureRequest', 'authoriseAdministration'];
    if (own(input, 'beforeQuery')) keys.push('beforeQuery');
    if (own(input, 'authoriseSignupList')) keys.push('authoriseSignupList');
    fields(input, keys);
    if (!input.pool || isProxy(input.pool) || typeof input.pool.connect !== 'function' || typeof input.pool.end !== 'function') invalid();
    for (const key of ['clock', 'readExternalRuntimeEpoch', 'newId', 'captureRequest', 'authoriseAdministration',
        ...(own(input, 'beforeQuery') ? ['beforeQuery'] : []),
        ...(own(input, 'authoriseSignupList') ? ['authoriseSignupList'] : [])]) {
        if (typeof input[key] !== 'function' || isProxy(input[key])) invalid();
    }
    uuid(input.instanceId);
    const budget = fields(copy(input.historyBudget, MAX_SMALL), ['maxRecords', 'maxBytes', 'maxDurationMs']);
    for (const [key, maximum] of [['maxRecords', 4096], ['maxBytes', 67108864], ['maxDurationMs', 60000]]) {
        revision(budget[key]); if (!budget[key] || budget[key] > maximum) invalid();
    }
    return Object.freeze({ ...input, historyBudget: freeze(budget), maintenance: false });
}

function createPostgresDashboardAdministrationRepository(input) {
    const options = administrationConfiguration(input);

    async function approve(inv, selector) {
        const allowed = await inv.provider('authoriseAdministration', Object.freeze({ request: inv.request,
            capture: inv.capture, selector, operationType: inv.operationType, at: inv.now() }));
        if (allowed !== true) denied();
        inv.now();
    }
    async function prepare(request, selectorInput, operationType, nullable = false) {
        if (!request || typeof request !== 'object' || isProxy(request)) denied();
        const selector = nullable && selectorInput === null ? null : administrationSelector(selectorInput);
        const inv = newInvocation(options, request, operationType, freeze({}));
        await capture(inv);
        if (inv.capture.kind !== 'operator_dashboard' || inv.capture.operatorIssuanceProof === null) denied();
        await externalEpoch(inv);
        await approve(inv, selector);
        return { inv, selector };
    }
    async function run(inv, selector, work, readOnly, approval = approve) {
        const target = selector && freeze({ tenantId: selector.tenantId, organisationId: selector.organisationId });
        const value = await rawTransaction(inv, async tx => {
            // New finite operation names intentionally avoid readSession's
            // selected-customer binding and its implicit audit append.
            const context = await readContext(inv, tx, target, false);
            await approval(inv, selector);
            const result = await work(tx, context, target);
            await approval(inv, selector);
            await finalRead(inv, context);
            await approval(inv, selector);
            inv.now();
            return result;
        }, readOnly);
        await approval(inv, selector);
        inv.now();
        return value;
    }
    function auditBinding(inv, selector, envelopeInput) {
        const envelope = normaliseAuditEnvelope(envelopeInput), event = envelope.event;
        if (envelope.sessionSha256 !== inv.capture.sessionSha256 || envelope.instanceId !== inv.capture.instanceId ||
            event.requestId !== inv.capture.requestId || event.actorSubjectKey !== subjectOf(inv.capture.identityPayload) ||
            !equal(event.scope, { tenantId: selector.tenantId, organisationId: selector.organisationId }) ||
            event.targetSha256 !== crypto.createHash('sha256').update(JSON.stringify(selector)).digest('hex') ||
            event.occurredAt < inv.capture.issuedAt || event.occurredAt > inv.now()) denied();
        return envelope;
    }
    async function audit(request, envelopeInput, selectorInput, attemptInput, reconciliation) {
        try {
            const { inv, selector } = await prepare(request, selectorInput,
                reconciliation ? 'administration.audit.reconcile' : 'administration.audit.persist');
            const envelope = auditBinding(inv, selector, envelopeInput);
            const attempt = attemptInput === null ? null : auditBinding(inv, selector, attemptInput);
            await run(inv, selector, async tx => {
                const bound = Object.freeze({ query: (sql, params) => inv.query(tx, sql, params) });
                await administrationAudit[reconciliation ? 'reconcileAudit' : 'persistAudit'](bound, envelope, attempt);
                inv.now();
                return true;
            }, reconciliation);
            return true;
        } catch (error) {
            // No insert retry, replacement envelope or snapshot re-execution.
            // The owner may make one exact SELECT-only reconciliation call.
            if (!reconciliation && error instanceof PostgresDatabaseError &&
                ['postgres_commit_failed', 'postgres_rollback_failed'].includes(error.code)) ambiguous();
            throw errorResult(error);
        }
    }
    async function approveSignup(inv) {
        const at = inv.now();
        // The trusted policy must recheck the exact pinned finite authority. No
        // selected organisation or implicit lookup grant substitutes for it.
        const authority = normaliseSignupAuthority(inv.signupAuthority, {
            actorSubjectKey: subjectOf(inv.capture.identityPayload), now: at });
        const allowed = await inv.provider('authoriseSignupList', Object.freeze({ request: inv.request,
            capture: inv.capture, authority, operationType: inv.operationType, at }));
        if (allowed !== true) denied();
        normaliseSignupAuthority(authority, { actorSubjectKey: subjectOf(inv.capture.identityPayload), now: inv.now() });
    }
    async function prepareSignup(request, authorityInput, operationType) {
        if (!request || typeof request !== 'object' || isProxy(request) || !own(options, 'authoriseSignupList')) denied();
        const inv = newInvocation(options, request, operationType, freeze({}));
        let suppliedAuthority;
        try { suppliedAuthority = normaliseSignupAuthority(authorityInput); } catch (_) { denied(); }
        await capture(inv);
        if (inv.capture.kind !== 'operator_dashboard' || inv.capture.operatorIssuanceProof === null) denied();
        try { inv.signupAuthority = normaliseSignupAuthority(suppliedAuthority, {
            actorSubjectKey: subjectOf(inv.capture.identityPayload), now: inv.now() }); }
        catch (_) { denied(); }
        inv.intersect(inv.signupAuthority.expiresAt);
        await externalEpoch(inv);
        await approveSignup(inv);
        return inv;
    }
    function signupAuditBinding(inv, input) {
        const envelope = normaliseSignupAuditEnvelope(input), event = envelope.event;
        if (event.occurredAt < inv.capture.issuedAt || event.occurredAt > inv.now()) denied();
        const expected = createSignupAuditEnvelope({ serviceEvent: event.serviceEvent,
            authority: inv.signupAuthority, eventId: event.eventId, nativeBinding: {
                requestId: inv.capture.requestId, sessionSha256: inv.capture.sessionSha256,
                instanceId: inv.capture.instanceId, actorSubjectKey: subjectOf(inv.capture.identityPayload) } });
        if (!equal(expected, envelope)) denied();
        return expected;
    }
    async function signupAudit(request, envelopeInput, authorityInput, attemptInput, reconciliation) {
        try {
            const suppliedEnvelope = normaliseSignupAuditEnvelope(envelopeInput);
            const suppliedAttempt = attemptInput === null ? null : normaliseSignupAuditEnvelope(attemptInput);
            const inv = await prepareSignup(request, authorityInput,
                reconciliation ? 'administration.signup.audit.reconcile' : 'administration.signup.audit.persist');
            const envelope = signupAuditBinding(inv, suppliedEnvelope);
            const attempt = suppliedAttempt === null ? null : signupAuditBinding(inv, suppliedAttempt);
            await run(inv, null, async tx => {
                const bound = Object.freeze({ query: (sql, params) => inv.query(tx, sql, params) });
                await administrationSignupAudit[reconciliation ? 'reconcileSignupAudit' : 'persistSignupAudit'](bound, envelope, attempt);
                inv.now();
                return true;
            }, reconciliation, approveSignup);
            return true;
        } catch (error) {
            if (!reconciliation && error instanceof PostgresDatabaseError &&
                ['postgres_commit_failed', 'postgres_rollback_failed'].includes(error.code)) ambiguous();
            throw errorResult(error);
        }
    }
    return Object.freeze({
        async validateSignupSession(request, authorityInput) {
            try {
                const inv = await prepareSignup(request, authorityInput, 'administration.signup.session');
                return await run(inv, null, async () => freeze({ schemaVersion: 1, state: 'ready',
                    purpose: 'operator_dashboard', capture: inv.capture }), true, approveSignup);
            } catch (error) { throw errorResult(error); }
        },
        persistSignupAudit(request, envelope, authority, attempt = null) {
            return signupAudit(request, envelope, authority, attempt, false);
        },
        reconcileSignupAudit(request, envelope, authority, attempt = null) {
            return signupAudit(request, envelope, authority, attempt, true);
        },
        async validateSession(request, selectorInput = null) {
            try {
                const { inv, selector } = await prepare(request, selectorInput, 'administration.session', true);
                return await run(inv, selector, async () => freeze({ schemaVersion: 1, state: 'ready',
                    purpose: 'operator_dashboard', capture: inv.capture }), true);
            } catch (error) { throw errorResult(error); }
        },
        async readAuthoritySnapshot(request, selectorInput) {
            try {
                const { inv, selector } = await prepare(request, selectorInput, 'administration.snapshot');
                return await run(inv, selector, async (tx, _context, target) => {
                    const command = freeze({ ...target, actorSubjectKey: subjectOf(inv.capture.identityPayload), type: 'authority.read' });
                    let active = true;
                    const database = Object.freeze({ async withTenantTransaction(tenantId, work) {
                        if (!active || tenantId !== target.tenantId) denied();
                        return work(Object.freeze({ query(sql, params) {
                            if (!active) denied();
                            return inv.query(tx, sql, params);
                        } }));
                    } });
                    try {
                        const repository = createPostgresDashboardRepository({ database, clock: () => inv.now(),
                            authoriseAdministration(actual) { if (!active) return false; inv.now(); return equal(actual, command); } });
                        const result = await repository.readAuthoritySnapshot(target,
                            freeze({ authenticated: true, subjectKey: command.actorSubjectKey }));
                        return inv.charge(result, 1);
                    } finally { active = false; }
                }, false);
            } catch (error) { throw errorResult(error); }
        },
        persistAudit(request, envelope, selector, attempt = null) { return audit(request, envelope, selector, attempt, false); },
        reconcileAudit(request, envelope, selector, attempt = null) { return audit(request, envelope, selector, attempt, true); }
    });
}
module.exports = { createPostgresDashboardRuntimeRepository, createPostgresDashboardMaintenanceRepository,
    createPostgresDashboardAdministrationRepository };
