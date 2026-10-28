'use strict';

// Fixed, uninstalled request capability. Only trusted composition receives it.
const { types: { isProxy, isPromise } } = require('node:util');
const { createPostgresDatabase, PostgresDatabaseError } = require('./postgres');
const domain = require('../appLifecycle/dashboardOnboardingDomain');
const { DashboardPersistenceError, dataStorage } = require('../appLifecycle/postgresDashboardBootstrap');
const { createDashboardAudit } = require('../appLifecycle/dashboardAudit');
const { requireTenantRequestContext } = require('../appLifecycle/tenantRequestContext');
const { MembershipDomainError, resolveActiveMembership, normaliseMembershipState } = require('../appLifecycle/membershipDomain');
const { resolveEntitlements, normaliseEntitlementState, TIERS } = require('../appLifecycle/entitlementDomain');
const { resolveOrganisation } = require('../appLifecycle/tenantDomain');
const { resolvePortalPermission, normaliseAdvisorAssignment, PortalPermissionError } = require('../appLifecycle/portalPermissions');
const { createPostgresDashboardRepository } = require('../appLifecycle/postgresDashboardRepository');
const { createDashboardBufferedService } = require('../dashboardService');
const { readDashboardUserProfile } = require('../appLifecycle/dashboardUserProfile');
const { hostResourceForRoute, normaliseRuntimeReadAudit } = require('../appLifecycle/dashboardRuntimeEvents');
const registry = require('../protectedAssets/dashboardRegistry');
const { resolveNcscAccess, resolveEvidenceAccess } = require('../appLifecycle/dashboardResourceAuthority');
const { EvidenceMetadataError } = require('../evidenceMetadataService');
const { NcscAssessmentError } = require('../ncscAssessmentService');
const { ImprovementPlanServiceError } = require('../improvementPlan/improvementPlanService');
const { ImprovementActionListError } = require('../improvementPlan/improvementActionListProjection');
const { resolveImprovementAccess } = require('../improvementPlan/improvementPlanAccess');
const { createNcscQuestionnaireMetadata } = require('../ncscQuestionnaireMetadata');
const { ACCEPTED_PROFILE_REF } = require('../assessmentEngine/ncscAssessmentEvaluator');
const records = require('../appLifecycle/dashboardRuntimeRecords');
const { copy, fields, freeze, canonical, hash, equal, uuid, digest, revision, instant, scope,
    CURRENT_COLUMNS, prepareCurrentRow, normaliseSessionRow, normaliseInstanceRow,
    normaliseBindingRow, normaliseAdmissionRow, normaliseAdmissionRows } = records;

const MAX_SMALL = 16384, MAX_ENVELOPE = 524288;
const CAPTURE_FIELDS = ['requestId', 'deadline', 'sessionSha256', 'kind', 'identityPayload', 'instanceId',
    'restoreEpoch', 'issuedAt', 'expiresAt', 'operatorIssuanceProof', 'discovery'];
const SETTINGS = ['tenant_id', 'organisation_id', 'runtime_instance_id', 'session_sha256', 'session_kind',
    'identity_sha256', 'subject_key', 'case_id', 'binding_id', 'authority_id', 'capability_sha256', 'request_id'];
const TABLES = Object.freeze({ instance: 'dashboard_runtime_instance', session: 'dashboard_session_gates',
    binding: 'dashboard_identity_bindings', authority: 'dashboard_admission_authorities', admission: 'dashboard_admission_decisions' });
const AUDIT_COLUMNS = 'event_id session_sha256 instance_id authority_id request_id tenant_id organisation_id scope_json occurred_at event_type event_sha256 operation_id payload'.split(' ');
const EVENT_FIELDS = ['schemaVersion', 'eventType', 'eventId', 'requestId', 'actorSubjectKey', 'tenantId',
    'organisationId', 'action', 'module', 'result', 'occurredAt'];
const QUOTA_SELECTION = ['tenantId', 'organisationId', 'assessmentId', 'actorSubjectKey', 'moduleId', 'profileRef',
    'productGrantId', 'agreementRef', 'expectedRevision', 'submissionRevision', 'at'];
const QUOTA_POLICY = ['schemaVersion', 'tenantId', 'organisationId', 'productGrantId', 'agreementRef', 'moduleId',
    'profileRef', 'policyId', 'policyRevision', 'validFrom', 'validUntil', 'limit', 'amount'];
const OPERATIONS = ['admission.read', 'ncsc.list', 'ncsc.read', 'ncsc.execute', 'evidence.read'];
const NCSC_OPERATIONS = ['ncsc.list', 'ncsc.read', 'ncsc.execute'];
const IMPROVEMENT_OPERATIONS = ['improvement.list', 'improvement.execute'];
const SNAPSHOT_FIELDS = ['tenantAggregate', 'membershipState', 'entitlementState', 'flags', 'advisorAssignments', 'summary'];
const deniedErrors = new WeakSet();
const unavailableErrors = new WeakSet();
const subjectOf = identity => identity.identityTenantId + ':' + identity.oid;

function privateError(denied) {
    const error = new Error(denied ? 'Private dashboard request denied' : 'Private dashboard request unavailable');
    (denied ? deniedErrors : unavailableErrors).add(error);
    return error;
}
function mapped(error, operation = 'admission.read', denial = null) {
    if (error instanceof PostgresDatabaseError &&
        ['postgres_commit_failed', 'postgres_rollback_failed'].includes(error.code)) return error;
    const isDenied = deniedErrors.has(error) || denial && deniedErrors.has(denial);
    if (operation === 'improvement.list') {
        if (isDenied) return new ImprovementActionListError('improvement_list_access_denied', 403);
        if (error instanceof ImprovementActionListError) return error;
        if (error instanceof ImprovementPlanServiceError) return error;
        return new ImprovementActionListError();
    }
    if (operation === 'improvement.execute') {
        if (isDenied) return new ImprovementPlanServiceError('improvement_access_denied', 403);
        if (error instanceof ImprovementPlanServiceError) return error;
        return new ImprovementPlanServiceError();
    }
    if (operation === 'evidence.read') {
        if (isDenied) return new EvidenceMetadataError('evidence_access_denied', 403);
        if (error instanceof EvidenceMetadataError) return error;
        return new EvidenceMetadataError('evidence_unavailable', 503);
    }
    if (NCSC_OPERATIONS.includes(operation)) {
        if (isDenied) return new NcscAssessmentError('ncsc_access_denied', 403);
        if (error instanceof NcscAssessmentError) return error;
        return new NcscAssessmentError('ncsc_unavailable', 503);
    }
    if (operation === 'host.resource') return new DashboardPersistenceError(isDenied ? 'access_denied' : 'unavailable', isDenied ? 403 : 503);
    if (isDenied || error instanceof DashboardPersistenceError && error.statusCode === 404 ||
        error instanceof MembershipDomainError && error.statusCode === 403) {
        return new DashboardPersistenceError('access_denied', 403);
    }
    return new DashboardPersistenceError('unavailable', 503);
}
function configuration(input) {
    try {
        if (!input || isProxy(input)) throw new Error();
        const optional = ['ncscEnabled', 'improvementEnabled'].filter(key => Object.prototype.hasOwnProperty.call(input, key));
        fields(input, ['pool', 'clock', 'instanceId', 'historyBudget', 'captureRequest',
            'readExternalRuntimeEpoch', 'newId', 'resolveSubmissionQuota', ...optional]);
        if (optional.some(key => input[key] !== true)) throw new Error();
        if (!input.pool || isProxy(input.pool) || typeof input.pool.connect !== 'function' || typeof input.pool.end !== 'function') throw new Error();
        for (const key of ['clock', 'captureRequest', 'readExternalRuntimeEpoch', 'newId', 'resolveSubmissionQuota']) {
            if (typeof input[key] !== 'function') throw new Error();
        }
        uuid(input.instanceId);
        const budget = fields(copy(input.historyBudget, MAX_SMALL), ['maxRecords', 'maxBytes', 'maxDurationMs']);
        for (const [key, maximum] of [['maxRecords', 4096], ['maxBytes', 67108864], ['maxDurationMs', 60000]]) {
            revision(budget[key]); if (!budget[key] || budget[key] > maximum) throw new Error();
        }
        return Object.freeze({ ...input, historyBudget: freeze(budget) });
    } catch (_) { throw new DashboardPersistenceError('dependencies_invalid', 400); }
}

function assertOperationAt(active, at) {
    if (!active.assertCurrentAt) return;
    if (active.assertionFailure) throw active.assertionFailure;
    if (active.asserting) {
        active.assertionFailure = privateError(false);
        throw active.assertionFailure;
    }
    active.asserting = true;
    try {
        const result = active.assertCurrentAt(at);
        if (result !== undefined) {
            // A trusted assertion is synchronous. Observe a returned native
            // promise's rejection without awaiting or admitting its result.
            if (isPromise(result)) Promise.prototype.then.call(result, undefined, () => {});
            throw privateError(false);
        }
        if (active.assertionFailure) throw active.assertionFailure;
    } catch (error) {
        if (!active.assertionFailure) active.assertionFailure = !isProxy(error) && error instanceof ImprovementPlanServiceError
            ? error : privateError(false);
        throw active.assertionFailure;
    } finally { active.asserting = false; }
}

function invocation(options, request, expectedGeneration, nativeAsset = false) {
    let last, deadline, count = 0, bytes = 0;
    const inv = { options, request, expectedGeneration, nativeAsset, capture: null, external: null, owner: null, failure: null };
    inv.deny = () => {
        const error = privateError(true);
        if (inv.owner) inv.owner.denial = error;
        throw error;
    };
    inv.unavailable = () => { if (!inv.failure) inv.failure = privateError(false); throw inv.failure; };
    inv.now = () => {
        if (inv.failure) throw inv.failure;
        let value; try { value = instant(options.clock()); } catch (_) { inv.unavailable(); }
        if (last && value < last) inv.unavailable();
        last = value;
        if (deadline && value >= deadline) inv.unavailable();
        const active = inv.owner && inv.owner.active;
        if (active && active.finalAuthority) {
            if (active.finalFailure) throw active.finalFailure;
            try { currentAuthorityAt(inv, inv.owner, active.finalAuthority, value); }
            catch (error) { active.finalFailure = error; throw error; }
        }
        if (active && active.phase === 'finalizing') assertOperationAt(active, value);
        return value;
    };
    const start = inv.now();
    try {
        const end = Date.parse(start) + options.historyBudget.maxDurationMs;
        if (!Number.isSafeInteger(end)) inv.unavailable();
        deadline = instant(new Date(end).toISOString());
    } catch (_) { inv.unavailable(); }
    inv.intersect = value => { if (value < deadline) deadline = value; inv.now(); };
    inv.remainingMs = at => {
        const remaining = Date.parse(deadline) - Date.parse(at);
        if (!Number.isSafeInteger(remaining) || remaining <= 0) inv.unavailable();
        return Math.min(remaining, options.historyBudget.maxDurationMs);
    };
    inv.inspect = work => {
        inv.now();
        let result; try { result = work(); } catch (error) {
            if (deniedErrors.has(error) || unavailableErrors.has(error)) throw error;
            inv.unavailable();
        }
        inv.now(); return result;
    };
    inv.charge = (value, envelopes = 1) => {
        inv.now();
        const bounded = inv.inspect(() => copy(value, MAX_ENVELOPE * envelopes));
        count += envelopes; bytes += Buffer.byteLength(canonical(bounded), 'utf8');
        if (count > options.historyBudget.maxRecords || bytes > options.historyBudget.maxBytes) inv.unavailable();
        inv.now(); return bounded;
    };
    inv.query = async (tx, sql, params = []) => {
        inv.now();
        let result;
        try { result = await tx.query(sql, params); }
        catch (error) { throw error instanceof PostgresDatabaseError ? error : new PostgresDatabaseError('postgres_query_failed'); }
        inv.now(); return result;
    };
    inv.provider = async name => {
        inv.now(); let value;
        try { value = await options[name](...(name === 'captureRequest' ? [request] : [])); }
        catch (_) { inv.unavailable(); }
        inv.now(); return value;
    };
    return inv;
}

async function capture(inv) {
    const raw = await inv.provider('captureRequest');
    if (raw === null) inv.deny();
    const value = inv.inspect(() => {
        const v = fields(copy(raw, MAX_SMALL), CAPTURE_FIELDS);
        uuid(v.requestId); instant(v.deadline); digest(v.sessionSha256); uuid(v.instanceId); uuid(v.restoreEpoch);
        instant(v.issuedAt); instant(v.expiresAt);
        if (v.issuedAt >= v.expiresAt) throw new Error();
        v.identityPayload = domain.normaliseStableIdentity(v.identityPayload);
        if (!['operator_dashboard', 'customer', 'onboarding_discovery'].includes(v.kind)) throw new Error();
        if (v.instanceId !== inv.options.instanceId || v.kind === 'onboarding_discovery') inv.deny();
        if (v.discovery !== null) throw new Error();
        if (v.kind === 'operator_dashboard') {
            if (v.operatorIssuanceProof === null) inv.deny();
            v.operatorIssuanceProof = domain.normaliseOperatorIssuanceProof(v.operatorIssuanceProof);
            const p = v.operatorIssuanceProof;
            if (p.sessionSha256 !== v.sessionSha256 || p.identitySha256 !== hash(v.identityPayload) ||
                p.instanceId !== v.instanceId || p.restoreEpoch !== v.restoreEpoch ||
                p.issuedAt !== v.issuedAt || p.expiresAt !== v.expiresAt) inv.deny();
        } else if (v.operatorIssuanceProof !== null) throw new Error();
        return freeze(v);
    });
    if (inv.capture && !equal(inv.capture, value)) inv.deny();
    inv.capture = value; inv.intersect(value.deadline);
    const at = inv.now(); if (at < value.issuedAt || at >= value.expiresAt) inv.deny();
    return value;
}
async function externalEpoch(inv) {
    const raw = await inv.provider('readExternalRuntimeEpoch');
    const value = inv.inspect(() => {
        const v = fields(copy(raw, MAX_SMALL), ['instanceId', 'restoreEpoch']); uuid(v.instanceId); uuid(v.restoreEpoch); return freeze(v);
    });
    if (value.instanceId !== inv.options.instanceId || value.restoreEpoch !== inv.capture.restoreEpoch ||
        inv.external && !equal(value, inv.external)) inv.deny();
    inv.external = value;
}
async function settings(inv, tx, target = null, bindingId = '', authorityId = '') {
    const c = inv.capture;
    const values = { tenant_id: target ? target.tenantId : '', organisation_id: target ? target.organisationId : '',
        runtime_instance_id: inv.options.instanceId, session_sha256: c.sessionSha256, session_kind: c.kind,
        identity_sha256: hash(c.identityPayload), subject_key: subjectOf(c.identityPayload), request_id: c.requestId,
        binding_id: bindingId, authority_id: authorityId, case_id: '', capability_sha256: '' };
    await inv.query(tx, 'SELECT ' + SETTINGS.map((key, i) => `set_config('nofries.${key}', $${i + 1}, true)`).join(', '), SETTINGS.map(key => values[key]));
}
async function enter(inv, tx, target = null, bindingId = '') {
    await inv.query(tx, 'SET LOCAL ROLE nofries_runtime');
    await settings(inv, tx, target, bindingId);
}
async function fence(inv, tx, family, key) {
    await inv.query(tx, 'SELECT pg_advisory_xact_lock_shared($1::integer, hashtext($2))', [family, key]);
}
async function firstFences(inv, tx) {
    await fence(inv, tx, 71001, inv.capture.sessionSha256);
    await fence(inv, tx, 71002, inv.options.instanceId);
}
function rows(inv, result) {
    if (!result || isProxy(result)) inv.unavailable();
    const descriptor = Object.getOwnPropertyDescriptor(result, 'rows');
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') || !Array.isArray(descriptor.value) ||
        isProxy(descriptor.value) || descriptor.value.length > 1) inv.unavailable();
    if (!descriptor.value.length) return null;
    const row = Object.getOwnPropertyDescriptor(descriptor.value, '0');
    if (!row || !Object.prototype.hasOwnProperty.call(row, 'value')) inv.unavailable();
    return row.value;
}
async function readRow(inv, tx, kind, where, values) {
    return rows(inv, await inv.query(tx, `SELECT ${CURRENT_COLUMNS[kind].join(', ')} FROM nofries.${TABLES[kind]} WHERE ${where}`, values));
}
function preparedRow(inv, kind, raw) {
    if (!raw) return null;
    const prepared = inv.inspect(() => prepareCurrentRow(kind, raw));
    return inv.charge(prepared.row);
}
function decodedRow(inv, kind, raw, codec) {
    if (!raw) return null;
    const prepared = preparedRow(inv, kind, raw);
    return inv.inspect(() => codec(prepared));
}
async function loadGate(inv, tx) {
    return decodedRow(inv, 'session', await readRow(inv, tx, 'session', 'session_sha256 = $1', [inv.capture.sessionSha256]), normaliseSessionRow);
}
async function loadInstance(inv, tx) {
    return decodedRow(inv, 'instance', await readRow(inv, tx, 'instance', 'instance_id = $1', [inv.options.instanceId]), normaliseInstanceRow);
}
async function loadBinding(inv, tx, bindingId) {
    return decodedRow(inv, 'binding', await readRow(inv, tx, 'binding', 'binding_id = $1', [bindingId]), normaliseBindingRow);
}
async function loadAdmissions(inv, tx, binding, target) {
    const ref = binding.authorityRef;
    const head = preparedRow(inv, 'authority', await readRow(inv, tx, 'authority', 'authority_id = $1', [ref.authorityId]));
    if (!head) inv.deny();
    const decision = preparedRow(inv, 'admission', await readRow(inv, tx, 'admission', 'authority_id = $1 AND revision = $2', [ref.authorityId, head.head_revision]));
    if (!decision) inv.unavailable();
    const pair = inv.charge({ head, decision }, 2);
    const current = inv.inspect(() => normaliseAdmissionRows(pair));
    const birth = decodedRow(inv, 'admission', await readRow(inv, tx, 'admission', 'authority_id = $1 AND revision = $2', [ref.authorityId, ref.revision]), normaliseAdmissionRow);
    if (!birth || birth.authorityId !== ref.authorityId || birth.revision !== ref.revision ||
        birth.decisionSha256 !== ref.sha256 || !equal(birth.scope, target)) inv.unavailable();
    return { current, birth };
}
function currentInstance(inv, found, at) {
    if (!found || found.record.instanceId !== inv.options.instanceId || found.record.restoreEpoch !== inv.external.restoreEpoch ||
        found.record.restoreEpoch !== inv.capture.restoreEpoch || found.record.ingressStatus !== 'enabled' || at < found.record.changedAt) inv.deny();
}
function currentGate(inv, gate, at) {
    const c = inv.capture;
    if (!gate || gate.sessionSha256 !== c.sessionSha256 || gate.kind !== c.kind ||
        !equal(gate.identityPayload, c.identityPayload) || gate.instanceId !== c.instanceId || gate.restoreEpoch !== c.restoreEpoch ||
        gate.issuedAt !== c.issuedAt || gate.expiresAt !== c.expiresAt || gate.status !== 'active' ||
        at < c.issuedAt || at < gate.updatedAt || at >= gate.expiresAt || !gate.selectedBindingId ||
        (!(inv.nativeAsset && inv.expectedGeneration === null) && gate.generationToken !== inv.expectedGeneration)) inv.deny();
    if (c.kind === 'operator_dashboard' && gate.operatorIssuanceSha256 !== hash(c.operatorIssuanceProof)) inv.deny();
    // The native asset exception omits transport only. Pin the first fully
    // checked selected gate once; every later fence checks that same generation.
    if (inv.nativeAsset && inv.expectedGeneration === null) inv.expectedGeneration = gate.generationToken;
}
function currentBinding(inv, binding, target, at) {
    if (!binding || !equal(binding.scope, target) || binding.status !== 'active' ||
        !equal(binding.identity, inv.capture.identityPayload) || binding.subjectKey !== subjectOf(inv.capture.identityPayload) ||
        at < binding.updatedAt || at < binding.validFrom || at >= binding.validUntil) inv.deny();
}
function currentAdmission(inv, admissions, target, binding, at) {
    const a = admissions.current, birth = admissions.birth, p = a.payload;
    if (!equal(a.scope, target) || a.authorityId !== binding.authorityRef.authorityId ||
        p.decision !== 'eligible' || at < p.occurredAt || at < p.validFrom || at >= p.validUntil ||
        p.identityPolicyRef.policyId !== binding.identity.policyId || p.identityPolicyRef.policyRevision !== binding.identity.policyRevision ||
        p.approvedEffectSha256 !== birth.payload.approvedEffectSha256) inv.deny();
}
function currentMember(inv, authority, binding, at) {
    let member;
    try {
        member = resolveActiveMembership(authority.membershipState, authority.tenantAggregate,
            { ...binding.scope, subjectKey: binding.subjectKey }, at);
        resolveEntitlements(authority.entitlementState, authority.tenantAggregate, binding.scope, at, authority.flags);
    } catch (_) { inv.deny(); }
    for (const key of ['membershipId', 'invitationId', 'grantEvidenceId', 'validFrom', 'validUntil']) {
        if (member[key] !== binding[key]) inv.deny();
    }
}
function currentImprovement(inv, operation, authority, at) {
    if (!IMPROVEMENT_OPERATIONS.includes(operation.name)) return;
    try { resolveImprovementAccess(authority, operation.context,
        operation.name === 'improvement.execute' ? 'improvement.write' : 'improvement.read', at); }
    catch (_) { inv.deny(); }
}
async function locator(inv) {
    let client, started = false, discard = false;
    inv.now();
    try { client = checkedClient(inv, await inv.options.pool.connect()); } catch (_) { inv.unavailable(); }
    try {
        inv.now();
        try { await client.query('BEGIN READ ONLY'); started = true; }
        catch (_) { discard = true; inv.unavailable(); }
        await enter(inv, client); await firstFences(inv, client);
        const instance = await loadInstance(inv, client), gate = await loadGate(inv, client), at = inv.now();
        currentInstance(inv, instance, at); currentGate(inv, gate, at);
        const selected = inv.inspect(() => freeze(scope({ tenantId: gate.selectedTenantId, organisationId: gate.selectedOrganisationId })));
        inv.now();
        try { await client.query('COMMIT'); started = false; }
        catch (_) { inv.unavailable(); }
        inv.now(); return { gate, instance, scope: selected };
    } finally {
        if (started) { try { await client.query('ROLLBACK'); } catch (_) { discard = true; } }
        try { client.release(discard); } catch (_) { /* No driver detail crosses the boundary. */ }
    }
}
async function businessContext(inv, tx, routing) {
    const bindingId = routing.portfolio ? routing.bindingId : routing.gate.selectedBindingId;
    await enter(inv, tx, routing.scope, bindingId); await firstFences(inv, tx);
    const instance = await loadInstance(inv, tx), gate = await loadGate(inv, tx);
    currentInstance(inv, instance, inv.now()); currentGate(inv, gate, inv.now());
    if (!equal(gate, routing.gate) || !equal(instance, routing.instance)) inv.deny();
    const hint = await loadBinding(inv, tx, bindingId);
    currentBinding(inv, hint, routing.scope, inv.now());
    await settings(inv, tx, routing.scope, bindingId, hint.authorityRef.authorityId);
    await fence(inv, tx, 71003, hint.authorityRef.authorityId);
    const admissions = await loadAdmissions(inv, tx, hint, routing.scope);
    const binding = await loadBinding(inv, tx, bindingId);
    if (!equal(binding, hint)) inv.deny();
    const at = inv.now(); currentBinding(inv, binding, routing.scope, at); currentAdmission(inv, admissions, routing.scope, binding, at);
    return { tx, gate, instance, binding, admissions, scope: routing.scope };
}
async function loadAuthority(inv, operation, context, shared = false) {
    try {
        return await (!shared && ['ncsc.execute', 'evidence.read', ...IMPROVEMENT_OPERATIONS].includes(operation.name) ? dataStorage.loadSnapshotForUpdate : dataStorage.loadSnapshotForShare)(
            Object.freeze({ query: (sql, params) => inv.query(context.tx, sql, params) }), context.scope);
    } catch (error) {
        if (error instanceof DashboardPersistenceError && error.statusCode === 404) inv.deny();
        throw error;
    }
}
async function finalCheck(inv, operation, context, resolvedAt) {
    await capture(inv); await externalEpoch(inv);
    const instance = await loadInstance(inv, context.tx), gate = await loadGate(inv, context.tx);
    const binding = await loadBinding(inv, context.tx, context.binding.bindingId);
    if (!equal(gate, context.gate) || !equal(instance, context.instance) || !equal(binding, context.binding)) inv.deny();
    const admissions = await loadAdmissions(inv, context.tx, binding, context.scope);
    if (!equal(admissions, context.admissions)) inv.deny();
    const authority = await loadAuthority(inv, operation, context);
    // Retain only this attempt's final validated evidence. Later clock samples,
    // including control settlement/disclosure, must use these same predicates.
    operation.active.finalAuthority = Object.freeze({ instance, gate, binding, admissions, authority,
        scope: context.scope, resolvedAt, quota: operation.quota });
    inv.now();
    inv.now();
}
function currentAuthorityAt(inv, operation, evidence, at) {
    if (operation.name === 'portfolio.finish') {
        currentInstance(inv, evidence.instance, at); currentGate(inv, evidence.gate, at);
        for (const target of evidence.targets) currentAuthorityAt(inv, target.operation, target.evidence, at);
        return;
    }
    if (operation.name === 'host.resource') return hostAuthorityAt(inv, operation, evidence, at);
    const { instance, gate, binding, admissions, authority, scope: target, resolvedAt, quota } = evidence;
    currentInstance(inv, instance, at); currentGate(inv, gate, at);
    currentBinding(inv, binding, target, at); currentAdmission(inv, admissions, target, binding, at);
    currentMember(inv, authority, binding, at);
    currentImprovement(inv, operation, authority, at);
    if (operation.name === 'evidence.read') {
        try { resolveEvidenceAccess(authority, { scope: target,
            identity: { authenticated: true, subjectKey: subjectOf(inv.capture.identityPayload) }, resolvedAt }, at); }
        catch (_) { inv.deny(); }
    }
    if (NCSC_OPERATIONS.includes(operation.name)) {
        let decision;
        try { decision = resolveNcscAccess(authority, { scope: target,
            identity: { authenticated: true, subjectKey: subjectOf(inv.capture.identityPayload) }, resolvedAt },
        operation.name === 'ncsc.execute' ? 'assessment.write' : 'assessment.read', at); }
        catch (_) { inv.deny(); }
        if (quota) {
            const { selection, policy } = quota;
            const product = authority.entitlementState.grants.find(item => item.grantId === selection.productGrantId);
            if (!product || decision.product.grantId !== selection.productGrantId || product.agreementRef !== selection.agreementRef ||
                policy.productGrantId !== product.grantId || policy.agreementRef !== product.agreementRef ||
                !(product.validFrom <= at && at < product.validUntil) || !(policy.validFrom <= at && at < policy.validUntil)) inv.deny();
        }
    }
}

function checkedClient(inv, client) {
    // Own each timeout SET and its target as one FIFO unit. The setter bypasses
    // this boundary; queued work calculates allowance only when it can run.
    let tail = Promise.resolve(), queued = 0, inTransaction = false;
    let releaseRequested = false, released = false, discardRequested = false;
    const releaseWhenSettled = () => {
        if (!releaseRequested || queued || released) return;
        released = true;
        try { client.release(discardRequested); } catch (_) { /* No driver detail crosses the boundary. */ }
    };
    async function dispatch(sql, params) {
        if (sql === 'ROLLBACK') {
            try { await client.query('SET LOCAL statement_timeout = 0'); }
            catch (_) { /* An aborted transaction can reject SET; always attempt actual rollback. */ }
            const result = await client.query(sql, params);
            inTransaction = false;
            return result;
        }
        const active = inv.owner && inv.owner.active;
        const begin = sql === 'BEGIN' || sql === 'BEGIN READ ONLY', commit = sql === 'COMMIT';
        try {
            const at = inv.now();
            if (inTransaction) {
                const remaining = inv.remainingMs(at);
                try { await client.query("SELECT set_config('statement_timeout', $1, true)", [String(remaining)]); }
                catch (_) { inv.unavailable(); }
            }
            // In particular, recheck final authority after awaited preparation,
            // immediately before actual COMMIT. No await separates this dispatch.
            inv.now();
        } catch (error) {
            if (commit && active) active.commitNotSent = error;
            throw error;
        }
        if (commit && active) active.commitNotSent = null;
        let result;
        try { result = await client.query(sql, params); }
        catch (error) {
            // A real control response failure keeps its uncertainty even when
            // a later sample also latches an authority or invocation failure.
            try { inv.now(); } catch (_) { /* The original response failure wins. */ }
            throw error;
        }
        if (begin) inTransaction = true;
        else if (commit) inTransaction = false;
        if (begin || commit) {
            // The helper must learn that BEGIN/COMMIT actually succeeded. The
            // next dispatch/disclosure observes the latched failure instead.
            try { inv.now(); } catch (_) { /* Preserve known transaction ownership. */ }
        } else inv.now();
        return result;
    }
    return Object.freeze({
        query(sql, params) {
            if (releaseRequested) return Promise.reject(privateError(false));
            queued++;
            const pending = tail.then(() => dispatch(sql, params));
            const settled = () => { queued--; releaseWhenSettled(); };
            tail = pending.then(settled, settled);
            // Cleanup/FIFO ownership must not create an unobserved rejection
            // if a trusted caller returns before awaiting its query result.
            pending.catch(() => {});
            return pending;
        },
        release(discard) {
            releaseRequested = true; discardRequested = discardRequested || Boolean(discard);
            releaseWhenSettled();
        }
    });
}

function checkedDatabase(inv) {
    // The unchanged helper owns transaction control. This private pool view only
    // checks the same invocation around its otherwise hidden acquire/control I/O.
    const pool = Object.freeze({
        async connect() {
            inv.now();
            const client = await inv.options.pool.connect();
            try { inv.now(); }
            catch (error) {
                try { client.release(false); } catch (_) { /* The borrow settled. */ }
                throw error;
            }
            return checkedClient(inv, client);
        },
        end() { throw privateError(false); }
    });
    return createPostgresDatabase({ pool });
}

function auditProjection(inv, context, event) {
    const envelope = { sessionSha256: inv.capture.sessionSha256, instanceId: inv.options.instanceId,
        authorityId: context.binding.authorityRef.authorityId, event };
    return { envelope, row: { event_id: event.eventId, session_sha256: envelope.sessionSha256, instance_id: envelope.instanceId,
        authority_id: envelope.authorityId, request_id: event.requestId, tenant_id: event.tenantId, organisation_id: event.organisationId,
        scope_json: { tenantId: event.tenantId, organisationId: event.organisationId }, occurred_at: event.occurredAt,
        event_type: event.eventType, event_sha256: hash(envelope), operation_id: null, payload: event } };
}
function readAuditRow(inv, raw) {
    return inv.inspect(() => {
        fields(raw, AUDIT_COLUMNS);
        const descriptor = Object.getOwnPropertyDescriptor(raw, 'occurred_at');
        const time = descriptor.value instanceof Date && !isProxy(descriptor.value) ? descriptor.value.toISOString() : descriptor.value;
        const row = copy({ ...raw, occurred_at: instant(time) }, MAX_ENVELOPE);
        inv.charge(row); return row;
    });
}
async function writeAudit(inv, operation, event) {
    const active = operation.active;
    if (inv.owner !== operation || operation.finished || !active || active.phase !== 'work' || !operation.events.has(event)) throw privateError(false);
    const c = active.context, value = inv.inspect(() => fields(copy(event, MAX_SMALL), EVENT_FIELDS));
    if (value.requestId !== inv.capture.requestId || value.actorSubjectKey !== subjectOf(inv.capture.identityPayload) ||
        value.tenantId !== c.scope.tenantId || value.organisationId !== c.scope.organisationId) inv.deny();
    const evidenceRead = operation.name === 'evidence.read';
    const improvement = IMPROVEMENT_OPERATIONS.includes(operation.name);
    const action = improvement ? operation.name === 'improvement.execute' ? 'improvement.write' : 'improvement.read'
        : evidenceRead ? 'evidence.read' : 'assessment.read';
    if (!['ncsc.list', 'ncsc.read', 'evidence.read', ...IMPROVEMENT_OPERATIONS].includes(operation.name) ||
        value.schemaVersion !== 1 || value.eventType !== 'dashboard.operation' || value.action !== action ||
        value.module !== (improvement ? 'improvement_plan' : evidenceRead ? 'evidence' : 'cyber_security') ||
        value.result !== 'succeeded') inv.unavailable();
    const current = () => {
        if (inv.owner !== operation || operation.finished || operation.active !== active || active.phase !== 'work') throw privateError(false);
        const at = inv.now(); currentInstance(inv, c.instance, at); currentGate(inv, c.gate, at);
        currentBinding(inv, c.binding, c.scope, at); currentAdmission(inv, c.admissions, c.scope, c.binding, at);
        if (at < value.occurredAt || value.occurredAt < operation.resolvedAt) inv.unavailable();
    };
    current();
    const projected = inv.inspect(() => auditProjection(inv, c, value));
    inv.inspect(() => copy(projected.envelope, MAX_SMALL));
    const found = rows(inv, await inv.query(c.tx, `SELECT ${AUDIT_COLUMNS.join(', ')} FROM nofries.dashboard_runtime_audit WHERE event_id = $1`, [value.eventId]));
    current();
    if (found) {
        if (!equal(readAuditRow(inv, found), projected.row)) inv.unavailable();
        current(); return;
    }
    const measured = rows(inv, await inv.query(c.tx, 'SELECT octet_length($1::jsonb::text) AS payload_bytes', [JSON.stringify(value)]));
    inv.inspect(() => {
        fields(measured, ['payload_bytes']);
        if (!Number.isSafeInteger(measured.payload_bytes) || measured.payload_bytes <= 0 || measured.payload_bytes > MAX_SMALL) throw new Error();
    });
    current();
    const parameters = AUDIT_COLUMNS.map(key => ['payload', 'scope_json'].includes(key) ? JSON.stringify(projected.row[key]) : projected.row[key]);
    await inv.query(c.tx, `INSERT INTO nofries.dashboard_runtime_audit (${AUDIT_COLUMNS.join(', ')}) VALUES (${AUDIT_COLUMNS.map((_, i) => '$' + (i + 1)).join(', ')})`, parameters);
    current();
}

function operationPair(inv, database, routing, resolvedAt, name, context) {
    const known = OPERATIONS.includes(name) || IMPROVEMENT_OPERATIONS.includes(name);
    if (!known || IMPROVEMENT_OPERATIONS.includes(name) && inv.options.improvementEnabled !== true || inv.owner ||
        routing.portfolio && name !== 'improvement.list') {
        throw mapped(privateError(false), known ? name : 'admission.read');
    }
    try { inv.now(); } catch (error) { throw mapped(error, name); }
    if (IMPROVEMENT_OPERATIONS.includes(name)) {
        try {
            requireTenantRequestContext(context);
            if (context.requestId !== inv.capture.requestId || !equal(context.scope, routing.scope) ||
                context.identity.subjectKey !== subjectOf(inv.capture.identityPayload) || context.resolvedAt !== resolvedAt) throw privateError(true);
        } catch (_) { throw mapped(privateError(true), name); }
    }
    const operation = { name, context, active: null, finished: false, denial: null, quota: null, events: new WeakSet(), resolvedAt };
    inv.owner = operation;
    const available = () => {
        if (inv.owner !== operation || operation.finished) throw privateError(false);
    };
    const clock = () => {
        try { available(); return inv.now(); } catch (error) { throw mapped(error, name, operation.denial); }
    };
    const auditFactory = createDashboardAudit({ clock,
        createEventId: () => inv.inspect(() => uuid(inv.options.newId())),
        writeEvent: event => writeAudit(inv, operation, event)
    });
    const audit = Object.freeze({
        createEvent(context, action) {
            try {
                available();
                if (!operation.active || operation.active.phase !== 'work') throw privateError(false);
                requireTenantRequestContext(context);
                if (context.requestId !== inv.capture.requestId || !equal(context.scope, routing.scope) ||
                    context.identity.subjectKey !== subjectOf(inv.capture.identityPayload) || context.resolvedAt !== resolvedAt) inv.deny();
                const event = auditFactory.createEvent(context, action); operation.events.add(event); return event;
            } catch (error) { throw mapped(error, name, operation.denial); }
        },
        writeEvent(event) {
            try { available(); } catch (error) { return Promise.reject(mapped(error, name)); }
            const active = operation.active;
            if (!active || active.phase !== 'work' || !operation.events.has(event)) return Promise.reject(mapped(privateError(false), name));
            const pending = auditFactory.writeEvent(event)
                .catch(error => { if (!active.failure) active.failure = error; throw error; })
                .finally(() => active.pending.delete(pending));
            active.pending.add(pending);
            // A premature callback return cannot create an unobserved rejection
            // while the owning transaction drains its still-pending work.
            pending.catch(() => {});
            return pending;
        }
    });
    const guardedDatabase = Object.freeze({
        async withTenantTransaction(tenantId, work, assertCurrentAt) {
            try { available(); } catch (error) { throw mapped(error, name); }
            if (operation.active || typeof work !== 'function') throw mapped(privateError(false), name);
            if (assertCurrentAt !== undefined && (!IMPROVEMENT_OPERATIONS.includes(name) || typeof assertCurrentAt !== 'function')) {
                throw mapped(privateError(false), name);
            }
            if (tenantId !== routing.scope.tenantId) { try { inv.deny(); } catch (error) { throw mapped(error, name, operation.denial); } }
            const active = { phase: 'entering', context: null, pending: new Set(), failure: null,
                commitNotSent: null, finalAuthority: null, finalFailure: null,
                assertCurrentAt: null, assertionFailure: null, asserting: false };
            operation.active = active; operation.quota = null; operation.quotaPending = false; operation.denial = null;
            try {
                inv.now();
                const result = await database.withTenantTransaction(tenantId, async tx => {
                    await capture(inv); await externalEpoch(inv);
                    active.context = await businessContext(inv, tx, routing);
                    // Take the final lock mode directly; no SHARE-to-UPDATE
                    // upgrade. Exact retained membership lineage gates all DATA
                    // work, including quota providers and audit construction.
                    const authority = await loadAuthority(inv, operation, active.context);
                    const at = inv.now();
                    currentInstance(inv, active.context.instance, at); currentGate(inv, active.context.gate, at);
                    currentBinding(inv, active.context.binding, routing.scope, at);
                    currentAdmission(inv, active.context.admissions, routing.scope, active.context.binding, at);
                    currentMember(inv, authority, active.context.binding, at);
                    currentImprovement(inv, operation, authority, at);
                    active.phase = 'work';
                    const client = Object.freeze({
                        query(sql, params) {
                            if (operation.active !== active || inv.owner !== operation || operation.finished || active.phase !== 'work') return Promise.reject(mapped(privateError(false), name));
                            if (active.failure) return Promise.reject(active.failure);
                            // Portfolio consumers receive retained-read ports only.
                            // The separately paired audit sink owns its fixed INSERT.
                            if (routing.portfolio && (typeof sql !== 'string' || !/^\s*SELECT\b/i.test(sql) || sql.includes(';'))) {
                                active.failure = mapped(privateError(false), name);
                                return Promise.reject(active.failure);
                            }
                            const pending = inv.query(tx, sql, params)
                                .catch(error => { if (!active.failure) active.failure = error; throw error; })
                                .finally(() => active.pending.delete(pending));
                            active.pending.add(pending);
                            pending.catch(() => {});
                            return pending;
                        }
                    });
                    let value, failure;
                    try { value = await work(client); } catch (error) { failure = error; }
                    // A callback cannot return a client while its continuation is still pending.
                    active.phase = 'finalizing';
                    if (active.pending.size) {
                        await Promise.allSettled([...active.pending]);
                        if (!failure) failure = privateError(false);
                    }
                    if (failure || active.failure) throw failure || active.failure;
                    // Source-derived command/owner predicates join every final
                    // clock sample, including after awaited timeout preparation
                    // immediately before COMMIT and after transaction settlement.
                    active.assertCurrentAt = assertCurrentAt || null;
                    await finalCheck(inv, operation, active.context, resolvedAt);
                    inv.now(); return value;
                });
                inv.now();
                if (routing.portfolio) routing.readContext = context;
                return result;
            } catch (error) {
                // A later invocation failure outranks this attempt's final
                // authority latch, but never erases real control uncertainty.
                const finalUnavailable = active.finalAuthority && inv.failure;
                const denial = finalUnavailable ? null : operation.denial;
                if (active.commitNotSent && error instanceof PostgresDatabaseError && error.code === 'postgres_commit_failed') {
                    throw mapped(finalUnavailable || active.commitNotSent, name, denial);
                }
                throw mapped(error instanceof PostgresDatabaseError ? error : finalUnavailable || error, name, denial);
            }
            finally {
                active.phase = 'settled';
                active.finalAuthority = null; active.finalFailure = null;
                active.assertCurrentAt = null; active.assertionFailure = null;
                if (operation.active === active) operation.active = null;
            }
        }
    });
    function resolveSubmissionQuota(selectionInput) {
        try {
            available();
            const active = operation.active;
            if (!active || active.phase !== 'work' || name !== 'ncsc.execute' || operation.quota || operation.quotaPending) throw privateError(false);
            inv.now();
            const selection = inv.inspect(() => freeze(fields(copy(selectionInput, MAX_SMALL), QUOTA_SELECTION)));
            if (selection.tenantId !== routing.scope.tenantId || selection.organisationId !== routing.scope.organisationId ||
                selection.actorSubjectKey !== subjectOf(inv.capture.identityPayload)) inv.deny();
            operation.quotaPending = true;
            function failed(error) {
                // No-policy is a concrete pre-write refusal. Other provider
                // failures disclose no details and remain unavailable.
                inv.now();
                if (!isProxy(error) && error instanceof Error && error.message === 'ncsc_submission_policy_unavailable' &&
                    Object.getOwnPropertyDescriptor(error, 'code')?.value === 'ncsc_submission_unavailable')
                    throw new NcscAssessmentError('ncsc_submission_unavailable', 409);
                inv.unavailable();
            }
            function complete(result) {
                available();
                if (operation.active !== active || active.phase !== 'work' || !operation.quotaPending) throw privateError(false);
                inv.now();
                const policy = inv.inspect(() => freeze(fields(copy(result, MAX_SMALL), QUOTA_POLICY)));
                const at = inv.now(), context = active.context;
                currentInstance(inv, context.instance, at); currentGate(inv, context.gate, at);
                currentBinding(inv, context.binding, routing.scope, at);
                currentAdmission(inv, context.admissions, routing.scope, context.binding, at);
                operation.quotaPending = false; operation.quota = { selection, policy }; return policy;
            }
            let result;
            try { result = inv.options.resolveSubmissionQuota(selection); } catch (error) { return failed(error); }
            if (!isPromise(result)) return complete(result);
            // Bound the external read independently of SQL timeouts. Register
            // pending work so a caller cannot commit without awaiting it.
            const maximumMs = Math.min(10000, inv.remainingMs(inv.now()));
            const observed = new Promise((resolve, reject) => {
                let settled = false;
                const settle = (work) => {
                    if (settled) return;
                    settled = true; clearTimeout(timer);
                    try { resolve(work()); } catch (error) { reject(mapped(error, name, operation.denial)); }
                };
                const timer = setTimeout(() => settle(() => inv.unavailable()), maximumMs);
                Promise.prototype.then.call(result, value => settle(() => complete(value)), error => settle(() => failed(error)));
            });
            const pending = observed.catch(error => { if (!active.failure) active.failure = error; throw error; })
                .finally(() => active.pending.delete(pending));
            active.pending.add(pending); pending.catch(() => {}); return pending;
        } catch (error) { throw mapped(error, name, operation.denial); }
    }
    function finish() {
        if (inv.owner !== operation || operation.finished || operation.active) throw mapped(privateError(false), name);
        operation.finished = true; operation.quota = null; inv.owner = null;
    }
    return Object.freeze({ database: guardedDatabase, audit, clock, resolveSubmissionQuota, finish });
}

function hostBaseFacts(inv, context, input) {
    const snapshot = inv.charge(input);
    return inv.inspect(() => {
        const at = inv.now(), target = context.scope;
        const organisation = resolveOrganisation(inv.charge(snapshot.tenantAggregate), target);
        const state = normaliseMembershipState(inv.charge(snapshot.membershipState));
        if (state.tenantId !== target.tenantId || state.organisationId !== target.organisationId || state.updatedAt > at) throw privateError(false);
        // Validate the entire grant/flag input, including absence and future
        // products. A domain exception is never a base-refusal witness here.
        const retained = inv.charge({ state: snapshot.entitlementState, aggregate: snapshot.tenantAggregate,
            scope: target, flags: snapshot.flags });
        resolveEntitlements(retained.state, retained.aggregate, retained.scope, at, retained.flags);
        const grants = normaliseEntitlementState(inv.charge(snapshot.entitlementState), inv.charge(snapshot.tenantAggregate)).grants;
        if (snapshot.tenantAggregate.tenant.recordStatus !== 'active' || organisation.recordStatus !== 'active') inv.deny();
        const member = state.memberships.find(row => row.subjectKey === context.binding.subjectKey && row.status === 'active' &&
            row.validFrom <= at && at < row.validUntil);
        if (!member) inv.deny();
        for (const key of ['membershipId', 'invitationId', 'grantEvidenceId', 'validFrom', 'validUntil']) {
            if (member[key] !== context.binding[key]) inv.deny();
        }
        return { snapshot, state, member, grants };
    });
}

function prepareHostFacts(inv, context, input, resource, writeAuthority = null, currentUserProfile = null) {
    const value = inv.inspect(() => fields(inv.charge(input), SNAPSHOT_FIELDS));
    // This fixed DATA method supplies no summary rows. Its source-owned null
    // cannot become a new unbounded display/history input to this guard.
    if (value.summary !== null) inv.unavailable();
    const base = hostBaseFacts(inv, context, value);
    const snapshot = freeze({ ...base.snapshot, currentUserProfile });
    const advisors = {}, normal = {}, at = inv.now();
    let ncscNormalWrite = false, ncscWriteAdvisors = [];
    inv.inspect(() => {
        fields(snapshot.advisorAssignments, Object.keys(snapshot.advisorAssignments));
        if (Object.keys(snapshot.advisorAssignments).some(key => !registry.modules.some(item => item.key === key))) throw privateError(false);
        for (const item of registry.modules) {
            const raw = snapshot.advisorAssignments[item.key] ?? null;
            const assignment = raw === null ? null : normaliseAdvisorAssignment(inv.charge(raw));
            if (assignment && (assignment.tenantId !== context.scope.tenantId || assignment.organisationId !== context.scope.organisationId)) throw privateError(false);
            advisors[item.key] = assignment;
            // A normal-role permission is retained only from the real resolver.
            // Null deliberately excludes advisor authority from this proof.
            const supplied = inv.charge({ state: base.state, aggregate: snapshot.tenantAggregate,
                selector: { ...context.scope, subjectKey: context.binding.subjectKey, permission: item.permission, module: item.key } });
            try {
                const decision = resolvePortalPermission(supplied.state, supplied.aggregate, supplied.selector, null, at);
                normal[item.key] = ['admin', 'editor', 'viewer'].includes(decision.role);
            } catch (error) {
                if (!(error instanceof PortalPermissionError)) throw error;
                normal[item.key] = false;
            }
        }
        if (inv.options.ncscEnabled === true && resource.moduleKey === 'cyber_security') {
            // The typed admission snapshot selects a READ grant. A distinct
            // WRITE grant is valid and must come from the same locked canonical
            // source, never from the read assignment's permission list.
            const authority = fields(inv.charge(writeAuthority),
                ['tenantAggregate', 'membershipState', 'entitlementState', 'flags', 'advisorAssignments', 'usage']);
            for (const key of ['tenantAggregate', 'membershipState', 'entitlementState', 'flags']) {
                if (!equal(authority[key], snapshot[key])) throw privateError(false);
            }
            if (!Array.isArray(authority.advisorAssignments)) throw privateError(false);
            const assignments = authority.advisorAssignments.map(row => normaliseAdvisorAssignment(row));
            if (new Set(assignments.map(row => row.assignmentId)).size !== assignments.length) throw privateError(false);
            for (const row of assignments) {
                if (row.tenantId !== context.scope.tenantId || row.organisationId !== context.scope.organisationId ||
                    !base.state.memberships.some(member => member.membershipId === row.membershipId && member.subjectKey === row.subjectKey)) throw privateError(false);
            }
            for (const row of Object.values(advisors)) {
                if (row !== null && !assignments.some(candidate => equal(candidate, row))) throw privateError(false);
            }
            // Retain future candidates too: later clock samples must observe
            // both activation and ambiguity without new I/O or policy calls.
            ncscWriteAdvisors = assignments.filter(row => row.subjectKey === base.member.subjectKey &&
                row.membershipId === base.member.membershipId && row.modules.includes('cyber_security') &&
                row.permissions.includes('assessment.write'));
            try {
                const decision = resolvePortalPermission(base.state, snapshot.tenantAggregate,
                    { ...context.scope, subjectKey: context.binding.subjectKey, permission: 'assessment.write', module: 'cyber_security' }, null, at);
                ncscNormalWrite = ['admin', 'editor', 'viewer'].includes(decision.role);
            } catch (error) { if (!(error instanceof PortalPermissionError)) throw error; }
        }
    });
    return freeze({ capture: inv.capture, instance: context.instance.record, gate: context.gate, binding: context.binding,
        admission: context.admissions.current.payload, scope: context.scope, member: base.member,
        membershipUpdatedAt: base.state.updatedAt, grants: base.grants, flags: snapshot.flags,
        advisors, normal, resource, snapshot, jobTitle: currentUserProfile?.jobTitle ?? null,
        ncscEnabled: inv.options.ncscEnabled === true, ncscNormalWrite, ncscWriteAdvisors,
        improvementEnabled: inv.options.improvementEnabled === true });
}

function hostProjectionAt(frame, at, configured = true) {
    const live = grant => grant.status === 'active' && grant.validFrom <= at && at < grant.validUntil;
    const product = frame.grants.find(grant => Object.prototype.hasOwnProperty.call(TIERS, grant.code) && live(grant));
    const service = code => code !== 'managed_it_core' && frame.grants.some(grant => grant.code === code && live(grant));
    const fractional = service('fractional_advisory') && frame.flags.enabled['service:fractional_advisory'] === true;
    const ncscReady = configured && frame.ncscEnabled && Boolean(product && product.frameworks.some(ref =>
        ref.moduleId === 'cyber_security' && ref.profileId === ACCEPTED_PROFILE_REF.profileId &&
        ref.version === ACCEPTED_PROFILE_REF.profileVersion && frame.flags.frameworks.some(flag =>
            flag.moduleId === ref.moduleId && flag.profileId === ref.profileId && flag.version === ref.version)));
    const improvementReady = configured && frame.improvementEnabled;
    let presentationMode = null;
    const modules = registry.modules.map(item => {
        const entitled = Boolean(product && product.modules.includes(item.key));
        const profile = !['ai_governance', 'cyber_security', 'it_optimisation'].includes(item.key) || Boolean(product &&
            product.frameworks.some(reference => reference.moduleId === item.key && frame.flags.frameworks.some(flag =>
                flag.moduleId === reference.moduleId && flag.profileId === reference.profileId && flag.version === reference.version)));
        const eligible = entitled && frame.flags.enabled.dashboard === true && frame.flags.enabled[item.key] === true && profile;
        const assignment = frame.advisors[item.key], member = frame.member;
        const advisor = member.roles.includes('fractional_advisor') && fractional && assignment !== null &&
            assignment.status === 'active' && assignment.tenantId === frame.scope.tenantId && assignment.organisationId === frame.scope.organisationId &&
            assignment.subjectKey === member.subjectKey && assignment.membershipId === member.membershipId && assignment.updatedAt <= at &&
            assignment.validFrom >= member.validFrom && assignment.validUntil <= member.validUntil &&
            assignment.validFrom <= at && at < assignment.validUntil && assignment.modules.includes(item.key) && assignment.permissions.includes(item.permission);
        const permitted = frame.normal[item.key] || advisor;
        if (item.key === 'cyber_security' && ncscReady && eligible && permitted && frame.resource.moduleKey === item.key) {
            const writeAdvisors = member.roles.includes('fractional_advisor') && fractional
                ? frame.ncscWriteAdvisors.filter(row => row.status === 'active' && row.updatedAt <= at &&
                    row.validFrom >= member.validFrom && row.validUntil <= member.validUntil &&
                    row.validFrom <= at && at < row.validUntil) : [];
            presentationMode = frame.ncscNormalWrite || writeAdvisors.length === 1 ? 'editable' : 'read-only';
        }
        return { key: item.key, entitled, eligible, permitted, state: !eligible ? 'disabled' :
            ['overview', 'services'].includes(item.key) || item.key === 'cyber_security' && ncscReady ||
                item.key === 'improvement_plan' && improvementReady ? 'ready' : 'planned' };
    });
    const readable = item => item.eligible && item.permitted;
    const succeeded = Boolean(product && frame.flags.enabled.dashboard === true && (frame.resource.moduleKey === null
        ? modules.some(readable) : modules.some(item => item.key === frame.resource.moduleKey && readable(item))));
    if (!succeeded) return { outcome: 'denied', vector: null };
    const assets = !frame.resource.requiresGeneration;
    const selected = frame.resource.moduleKey;
    const included = assets ? [] : modules.filter(item => item.entitled && item.permitted && (selected === null || item.key === selected))
        .map(item => ({ key: item.key, state: item.state }));
    const showServices = !assets && (selected === null || selected === 'services') && modules.some(item => item.key === 'services' && readable(item));
    const services = showServices ? registry.services.map(item => {
        const entitled = service(item.key), enabled = entitled && frame.flags.enabled['service:' + item.key] === true;
        return { key: item.key, state: !entitled ? 'not_included' : !enabled ? 'disabled' : 'setup_required', operational: false };
    }) : [];
    return { outcome: 'succeeded', vector: { subscription: !assets && selected === null
        ? product.code === 'dashboard_govern' ? 'Govern' : 'Score' : null,
        jobTitle: !assets && selected === null ? frame.jobTitle : null, modules: included, services, presentationMode } };
}
function sameHostVector(left, right) {
    if (left === null || right === null) return left === right;
    return left.subscription === right.subscription && left.jobTitle === right.jobTitle &&
        left.presentationMode === right.presentationMode && left.modules.length === right.modules.length &&
        left.modules.every((item, i) => item.key === right.modules[i].key && item.state === right.modules[i].state) &&
        left.services.length === right.services.length && left.services.every((item, i) =>
            item.key === right.services[i].key && item.state === right.services[i].state && item.operational === right.services[i].operational);
}
function bufferedHostVector(resource, buffered) {
    if (buffered.outcome === 'denied') return null;
    if (!resource.requiresGeneration) return { subscription: null, jobTitle: null, modules: [], services: [], presentationMode: null };
    const body = buffered.response.body;
    return { subscription: resource.moduleKey === null ? body.subscription : null,
        jobTitle: resource.moduleKey === null ? body.currentUser?.jobTitle ?? null : null, presentationMode: body.presentationMode ?? null,
        modules: (resource.moduleKey === null ? body.modules : [body.module]).map(item => ({ key: item.key, state: item.state })),
        services: body.services.map(item => ({ key: item.key, state: item.state, operational: item.operational })) };
}
function hostBaseAt(inv, frame, at) {
    const c = frame.capture, g = frame.gate, b = frame.binding, a = frame.admission, m = frame.member;
    if (at < c.issuedAt || at < frame.instance.changedAt || at < g.updatedAt || at >= g.expiresAt ||
        at < b.updatedAt || at < b.validFrom || at >= b.validUntil || at < a.occurredAt ||
        at < a.validFrom || at >= a.validUntil || at < frame.membershipUpdatedAt || at < m.validFrom || at >= m.validUntil) inv.deny();
}
function hostAuthorityAt(inv, operation, frame, at) {
    // Every identity/shape/hash agreement was proved before sealing. Later
    // samples use only these bounded facts: no codec, policy call, I/O or hash.
    hostBaseAt(inv, frame, at);
    const current = hostProjectionAt(frame, at);
    if (current.outcome !== frame.originalOutcome) {
        if (frame.recovery && frame.originalOutcome === 'succeeded' && current.outcome === 'denied') inv.deny();
        throw privateError(false);
    }
    if (current.outcome === 'succeeded' && !sameHostVector(current.vector, frame.vector)) throw privateError(false);
}

function hostAuditProjection(envelope) {
    const event = envelope.event;
    return { event_id: event.eventId, session_sha256: envelope.sessionSha256, instance_id: envelope.instanceId,
        authority_id: envelope.authorityId, request_id: event.requestId, tenant_id: event.scope.tenantId,
        organisation_id: event.scope.organisationId, scope_json: event.scope, occurred_at: event.occurredAt,
        event_type: event.eventType, event_sha256: hash(envelope), operation_id: null, payload: event };
}
function hostEvent(inv, context, resource, outcome) {
    const eventId = inv.inspect(() => uuid(inv.options.newId())), occurredAt = inv.now();
    return inv.inspect(() => normaliseRuntimeReadAudit(inv.charge({ sessionSha256: inv.capture.sessionSha256,
        instanceId: inv.options.instanceId, authorityId: context.binding.authorityRef.authorityId,
        event: { schemaVersion: 1, eventType: 'dashboard.runtime', eventId, requestId: inv.capture.requestId,
            occurredAt, actorSubjectKey: subjectOf(inv.capture.identityPayload), scope: context.scope,
            action: resource.action, outcome, resourceKey: resource.resourceKey, operationId: null } })));
}
async function hostAudit(inv, operation, recovery) {
    const active = operation.active, context = active.context, envelope = operation.event;
    const current = () => {
        if (inv.owner !== operation || operation.finished || operation.active !== active || active.phase !== 'work') throw privateError(false);
        const at = inv.now();
        currentInstance(inv, context.instance, at); currentGate(inv, context.gate, at);
        currentBinding(inv, context.binding, context.scope, at);
        currentAdmission(inv, context.admissions, context.scope, context.binding, at);
        if (envelope.sessionSha256 !== inv.capture.sessionSha256 || envelope.instanceId !== inv.options.instanceId ||
            envelope.authorityId !== context.binding.authorityRef.authorityId || envelope.event.requestId !== inv.capture.requestId ||
            envelope.event.actorSubjectKey !== subjectOf(inv.capture.identityPayload) || !equal(envelope.event.scope, context.scope) ||
            envelope.event.occurredAt > at) inv.unavailable();
    };
    current();
    const expected = inv.inspect(() => hostAuditProjection(envelope));
    const found = rows(inv, await inv.query(context.tx,
        `SELECT ${AUDIT_COLUMNS.join(', ')} FROM nofries.dashboard_runtime_audit WHERE event_id = $1`, [envelope.event.eventId]));
    current();
    if (found) {
        const row = readAuditRow(inv, found);
        const retained = inv.inspect(() => normaliseRuntimeReadAudit(inv.charge({ sessionSha256: row.session_sha256,
            instanceId: row.instance_id, authorityId: row.authority_id, event: row.payload })));
        if (!equal(inv.inspect(() => hostAuditProjection(retained)), row) || !equal(retained, envelope) || !equal(row, expected)) inv.unavailable();
        current(); return;
    }
    if (recovery) throw new DashboardPersistenceError('outcome_ambiguous', 503);
    const measured = rows(inv, await inv.query(context.tx, 'SELECT octet_length($1::jsonb::text) AS payload_bytes', [JSON.stringify(envelope.event)]));
    inv.inspect(() => {
        fields(measured, ['payload_bytes']);
        if (!Number.isSafeInteger(measured.payload_bytes) || measured.payload_bytes <= 0 || measured.payload_bytes > MAX_SMALL) throw new Error();
    });
    current();
    const parameters = AUDIT_COLUMNS.map(key => ['payload', 'scope_json'].includes(key) ? JSON.stringify(expected[key]) : expected[key]);
    await inv.query(context.tx, `INSERT INTO nofries.dashboard_runtime_audit (${AUDIT_COLUMNS.join(', ')}) VALUES (${AUDIT_COLUMNS.map((_, i) => '$' + (i + 1)).join(', ')})`, parameters);
    current();
}

async function refreshHostContext(inv, context) {
    await capture(inv); await externalEpoch(inv);
    const instance = await loadInstance(inv, context.tx), gate = await loadGate(inv, context.tx);
    const binding = await loadBinding(inv, context.tx, context.gate.selectedBindingId);
    if (!equal(instance, context.instance) || !equal(gate, context.gate) || !equal(binding, context.binding)) inv.deny();
    const admissions = await loadAdmissions(inv, context.tx, binding, context.scope);
    if (!equal(admissions, context.admissions)) inv.deny();
    const at = inv.now();
    currentInstance(inv, instance, at); currentGate(inv, gate, at);
    currentBinding(inv, binding, context.scope, at); currentAdmission(inv, admissions, context.scope, binding, at);
    return { ...context, instance, gate, binding, admissions };
}

async function bufferedHost(inv, operation, facts) {
    const active = operation.active, identity = Object.freeze({ authenticated: true, subjectKey: facts.binding.subjectKey });
    const current = () => {
        if (inv.owner !== operation || operation.finished || operation.active !== active || active.phase !== 'work') throw privateError(false);
        const at = inv.now(); hostBaseAt(inv, facts, at); return at;
    };
    let evaluatedAt;
    const service = createDashboardBufferedService({
        authenticate(request) {
            current(); if (request !== inv.request) inv.deny(); return identity;
        },
        resolveScope(request, principal) {
            current(); if (request !== inv.request || !equal(principal, identity)) inv.deny(); return facts.scope;
        },
        loadSnapshot(target, principal) {
            current(); if (!equal(target, facts.scope) || !equal(principal, identity)) inv.deny();
            // Charge the complete supplied typed-service envelope at this real
            // boundary; its unchanged internal normalizers need no hooks.
            return inv.charge(facts.snapshot);
        },
        clock() { evaluatedAt = current(); return evaluatedAt; }
    });
    let buffered = await service.handleResource(inv.request, operation.resource.route);
    // No clock or retained-input normalization between the genuine decision and
    // sealing. The next sampler observes the already checked final facts.
    if (typeof evaluatedAt !== 'string') throw privateError(false);
    // First prove the unchanged typed admission projection against independent facts.
    const original = bufferedHostVector(operation.resource, buffered), baseline = hostProjectionAt(facts, evaluatedAt, false);
    if (baseline.outcome !== buffered.outcome || !sameHostVector(baseline.vector, original)) throw privateError(false);
    const projected = hostProjectionAt(facts, evaluatedAt);
    if (buffered.outcome === 'succeeded' && operation.resource.requiresGeneration && (facts.ncscEnabled || facts.improvementEnabled)) {
        const body = copy(buffered.response.body, MAX_ENVELOPE);
        const modules = operation.resource.moduleKey === null ? body.modules : [body.module];
        for (const item of modules) {
            const expected = projected.vector.modules.find(row => row.key === item.key);
            if (['cyber_security', 'improvement_plan'].includes(item.key) && expected.state === 'ready') item.state = 'ready';
        }
        if (projected.vector.presentationMode !== null) {
            body.metadata = createNcscQuestionnaireMetadata();
            body.presentationMode = projected.vector.presentationMode;
        }
        buffered = freeze({ ...buffered, response: { ...buffered.response, body } });
    }
    const vector = freeze(bufferedHostVector(operation.resource, buffered));
    if (projected.outcome !== buffered.outcome || !sameHostVector(projected.vector, vector)) throw privateError(false);
    return { buffered, vector };
}

async function hostOperation(inv, routing, resource) {
    const operation = { name: 'host.resource', resource, active: null, finished: false, denial: null, event: null };
    inv.owner = operation;
    const database = checkedDatabase(inv);
    function retire() {
        if (operation.active) {
            operation.active.finalAuthority = null; operation.active.finalFailure = null;
        }
        operation.active = null; operation.denial = null;
    }
    function hostError(error, active) {
        if (error instanceof PostgresDatabaseError && ['postgres_commit_failed', 'postgres_rollback_failed'].includes(error.code)) {
            if (active.commitNotSent && error.code === 'postgres_commit_failed') {
                return mapped(inv.failure || active.commitNotSent, 'host.resource', inv.failure ? null : operation.denial);
            }
            return error;
        }
        if (error instanceof DashboardPersistenceError && error.code === 'dashboard_outcome_ambiguous') return error;
        const failed = inv.failure || active.failure;
        return mapped(failed || error, 'host.resource', failed && !deniedErrors.has(failed) ? null : operation.denial);
    }
    async function attempt(recovery) {
        const active = { phase: 'entering', context: null, pending: new Set(), failure: null, baseFacts: null,
            commitNotSent: null, finalAuthority: null, finalFailure: null, eventProved: false };
        operation.active = active;
        const guardedDatabase = Object.freeze({
            async withTenantTransaction(tenantId, work) {
                if (tenantId !== routing.scope.tenantId || typeof work !== 'function') inv.deny();
                return database.withTenantTransaction(tenantId, async tx => {
                    await capture(inv); await externalEpoch(inv);
                    active.context = await businessContext(inv, tx, routing);
                    // The exact canonical member is a precondition to DATA's
                    // advisor selection and to every audit or buffered decision.
                    const authority = await loadAuthority(inv, operation, active.context);
                    const base = hostBaseFacts(inv, active.context, authority);
                    active.baseFacts = { capture: inv.capture, instance: active.context.instance.record, gate: active.context.gate,
                        binding: active.context.binding, admission: active.context.admissions.current.payload,
                        membershipUpdatedAt: base.state.updatedAt, member: base.member };
                    hostBaseAt(inv, active.baseFacts, inv.now());
                    active.phase = 'work';
                    if (recovery) { await hostAudit(inv, operation, true); active.eventProved = true; }
                    const client = Object.freeze({
                        query(sql, params) {
                            if (operation.active !== active || inv.owner !== operation || operation.finished || active.phase !== 'work') return Promise.reject(privateError(false));
                            if (active.failure) return Promise.reject(active.failure);
                            const pending = inv.query(tx, sql, params)
                                .catch(error => { if (!active.failure) active.failure = error; throw error; })
                                .finally(() => active.pending.delete(pending));
                            active.pending.add(pending); pending.catch(() => {}); return pending;
                        }
                    });
                    async function dataWork() {
                        let snapshot, failure;
                        try { snapshot = await work(client); } catch (error) { failure = error; }
                        if (active.pending.size) {
                            await Promise.allSettled([...active.pending]);
                            if (!failure) failure = privateError(false);
                        }
                        if (failure || active.failure) throw failure || active.failure;
                        return snapshot;
                    }
                    async function presentationFacts() {
                        const snapshot = await dataWork();
                        const writeAuthority = inv.options.ncscEnabled === true && resource.moduleKey === 'cyber_security'
                            ? await loadAuthority(inv, operation, active.context) : null;
                        let profile = null;
                        if (resource.route === 'bootstrap') {
                            const binding = active.context.binding;
                            hostBaseAt(inv, active.baseFacts, inv.now());
                            profile = await readDashboardUserProfile({ async query(sql, params) {
                                const row = rows(inv, await inv.query(tx, sql, params));
                                return { rows: row === null ? [] : [inv.charge(row)] };
                            } }, { scope: active.context.scope, subjectKey: binding.subjectKey,
                                bindingId: binding.bindingId, authorityId: binding.authorityRef.authorityId,
                                ...Object.fromEntries(['membershipId', 'invitationId', 'grantEvidenceId', 'validFrom', 'validUntil']
                                    .map(key => [key, binding[key]])) }, inv.now());
                        }
                        return prepareHostFacts(inv, active.context, snapshot, resource, writeAuthority, profile);
                    }
                    if (!recovery) {
                        const initial = await presentationFacts();
                        const decision = await bufferedHost(inv, operation, initial);
                        if (active.failure) throw active.failure;
                        operation.event = hostEvent(inv, active.context, resource, decision.buffered.outcome);
                        await hostAudit(inv, operation, false);
                    }
                    active.context = await refreshHostContext(inv, active.context);
                    const finalFacts = await presentationFacts();
                    active.baseFacts = finalFacts;
                    const final = await bufferedHost(inv, operation, finalFacts);
                    if (active.pending.size) {
                        active.phase = 'finalizing';
                        await Promise.allSettled([...active.pending]);
                        throw active.failure || privateError(false);
                    }
                    if (active.failure) throw active.failure;
                    const { snapshot: ignoredSnapshot, ...retained } = finalFacts;
                    active.finalAuthority = Object.freeze({ ...retained, originalOutcome: operation.event.event.outcome,
                        recovery, vector: final.vector });
                    active.phase = 'finalizing';
                    inv.now();
                    inv.now();
                    return final.buffered.response;
                });
            }
        });
        const clock = () => {
            if (operation.active !== active || operation.finished || active.phase !== 'work') throw privateError(false);
            const at = inv.now(); hostBaseAt(inv, active.baseFacts, at); return at;
        };
        const repository = createPostgresDashboardRepository({ database: guardedDatabase, clock, authoriseAdministration: () => false });
        try {
            inv.now();
            const response = await repository.readAdmissionSnapshot(routing.scope,
                Object.freeze({ authenticated: true, subjectKey: subjectOf(inv.capture.identityPayload) }));
            // Keep the sealed frame through helper release and this last outer
            // disclosure observation. A known COMMIT never enables recovery.
            inv.now(); return response;
        } catch (error) {
            const result = hostError(error, active);
            // An authority denial cannot establish an uncertain commit's audit
            // outcome. Preserve ambiguity until the original event is proved.
            if (recovery && !(result instanceof PostgresDatabaseError) && !active.eventProved) {
                throw new DashboardPersistenceError('outcome_ambiguous', 503);
            }
            throw result;
        } finally { active.phase = 'settled'; }
    }
    try {
        try { return await attempt(false); }
        catch (error) {
            if (!(error instanceof PostgresDatabaseError) || !['postgres_commit_failed', 'postgres_rollback_failed'].includes(error.code)) throw error;
            // A rollback may have failed before any decision/event existed. No
            // invented slot can prove that uncertain transaction's outcome.
            if (!operation.event) throw new DashboardPersistenceError('outcome_ambiguous', 503);
            retire();
            try { return await attempt(true); }
            catch (recoveryError) {
                if (recoveryError instanceof PostgresDatabaseError) throw new DashboardPersistenceError('outcome_ambiguous', 503);
                throw recoveryError;
            }
        }
    } finally { retire(); operation.finished = true; inv.owner = null; }
}

// A portfolio invocation retains the original gate, not a synthetic selection.
// Routing identifiers come only from the subject-restricted directory and never
// turn a directory row into permission. Every read uses the ordinary scoped
// authority evaluator. Final disclosure rechecks all read targets under locks
// held in one transaction, so another target's awaited I/O cannot expose a
// previously revoked client's data.
async function portfolioParent(inv, tx, routing) {
    await capture(inv); await externalEpoch(inv);
    await enter(inv, tx); await firstFences(inv, tx);
    const instance = await loadInstance(inv, tx), gate = await loadGate(inv, tx), at = inv.now();
    currentInstance(inv, instance, at); currentGate(inv, gate, at);
    if (!equal(instance, routing.instance) || !equal(gate, routing.gate)) inv.deny();
    return { instance, gate };
}
async function portfolioTransaction(inv, routing, work, seal) {
    if (inv.owner) throw mapped(privateError(false), 'improvement.list');
    const operation = { name: 'portfolio.finish', active: { finalAuthority: null, finalFailure: null,
        phase: 'entering', commitNotSent: null }, finished: false, denial: null };
    inv.owner = operation;
    let client, started = false, discard = false;
    try {
        inv.now();
        client = checkedClient(inv, await inv.options.pool.connect()); inv.now();
        try { await client.query('BEGIN'); started = true; }
        catch (_) { discard = true; inv.unavailable(); }
        const parent = await portfolioParent(inv, client, routing);
        const result = await work(client, operation, parent);
        const finalParent = await portfolioParent(inv, client, routing);
        operation.active.finalAuthority = Object.freeze({ ...finalParent,
            targets: operation.active.finalAuthority?.targets || [] });
        operation.active.phase = 'finalizing'; inv.now();
        try { await client.query('COMMIT'); started = false; }
        catch (error) {
            if (operation.active.commitNotSent) throw operation.active.commitNotSent;
            throw error instanceof PostgresDatabaseError ? error : new PostgresDatabaseError('postgres_commit_failed');
        }
        inv.now();
        if (seal) seal(operation.active.finalAuthority);
        return result;
    } catch (error) { throw mapped(error, 'improvement.list', operation.denial); }
    finally {
        if (started && client) { try { await client.query('ROLLBACK'); } catch (_) { discard = true; } }
        if (client) { try { client.release(discard); } catch (_) { /* No driver detail crosses the boundary. */ } }
        operation.active.phase = 'settled'; operation.finished = true; inv.owner = null;
    }
}
function portfolioBinding(inv, routing, resolvedAt) {
    const database = checkedDatabase(inv), targets = new Map();
    const identity = freeze({ authenticated: true, subjectKey: subjectOf(inv.capture.identityPayload) });
    let closed = false, busy = false, disclosure = null, disclosureFailure = null;
    function available() {
        if (closed || busy || inv.owner) throw mapped(privateError(false), 'improvement.list');
        try { inv.now(); } catch (error) { throw mapped(error, 'improvement.list'); }
    }
    return Object.freeze({ requestId: inv.capture.requestId, identity, resolvedAt,
        async listBindings(input) {
            available();
            let page;
            try {
                page = fields(copy(input, MAX_SMALL), ['afterBindingId', 'limit']);
                if (page.afterBindingId !== null) uuid(page.afterBindingId);
                if (!Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > 10) throw new Error();
            } catch (_) { throw new ImprovementActionListError('improvement_list_input_invalid', 400); }
            busy = true;
            try {
                return await portfolioTransaction(inv, routing, async tx => {
                    await inv.query(tx, 'SET LOCAL ROLE nofries_dashboard_subject_reader');
                    const result = await inv.query(tx, 'SELECT binding_id, organisation_label, tenant_id, organisation_id, identity_sha256, subject_key ' +
                        'FROM nofries.dashboard_identity_bindings WHERE identity_sha256 = $1 AND subject_key = $2 ' +
                        'AND ($3::uuid IS NULL OR binding_id > $3::uuid) ORDER BY binding_id LIMIT $4',
                    [hash(inv.capture.identityPayload), subjectOf(inv.capture.identityPayload), page.afterBindingId, page.limit + 1]);
                    const selected = inv.inspect(() => {
                        if (!result || isProxy(result)) throw new Error();
                        const descriptor = Object.getOwnPropertyDescriptor(result, 'rows');
                        if (!descriptor || !Object.hasOwn(descriptor, 'value') || isProxy(descriptor.value) ||
                            !Array.isArray(descriptor.value) || descriptor.value.length > page.limit + 1) throw new Error();
                        return copy(descriptor.value, MAX_SMALL * (page.limit + 1));
                    });
                    let after = page.afterBindingId;
                    const admitted = selected.map(raw => inv.inspect(() => {
                        const row = fields(raw, ['binding_id', 'organisation_label', 'tenant_id', 'organisation_id', 'identity_sha256', 'subject_key']);
                        uuid(row.binding_id);
                        const targetScope = freeze(scope({ tenantId: row.tenant_id, organisationId: row.organisation_id }));
                        if (row.identity_sha256 !== hash(inv.capture.identityPayload) || row.subject_key !== identity.subjectKey ||
                            after !== null && row.binding_id <= after || typeof row.organisation_label !== 'string' ||
                            !row.organisation_label || row.organisation_label.length > 200 || /[\u0000-\u001f\u007f]/.test(row.organisation_label)) throw new Error();
                        after = row.binding_id;
                        inv.charge(row);
                        return { bindingId: row.binding_id, organisationLabel: row.organisation_label, scope: targetScope };
                    }));
                    for (const target of admitted.slice(0, page.limit)) {
                        const previous = targets.get(target.bindingId);
                        if (previous && (!equal(previous.scope, target.scope) || previous.organisationLabel !== target.organisationLabel)) inv.deny();
                        if (!previous) targets.set(target.bindingId, { ...routing, ...target, portfolio: true, readContext: null });
                    }
                    return freeze({ schemaVersion: 1, bindings: admitted.slice(0, page.limit).map(({ bindingId, organisationLabel }) => ({ bindingId, organisationLabel })),
                        nextAfterBindingId: admitted.length > page.limit ? admitted[page.limit - 1].bindingId : null });
                });
            } finally { busy = false; }
        },
        async bindTarget(bindingId) {
            available();
            const target = targets.get(bindingId);
            if (!target) throw mapped(privateError(true), 'improvement.list');
            return Object.freeze({ requestId: inv.capture.requestId, identity, scope: target.scope, resolvedAt,
                createOperation(name, context) {
                    available();
                    return operationPair(inv, database, target, resolvedAt, name, context);
                } });
        },
        async finish() {
            available(); busy = true;
            try {
                await portfolioTransaction(inv, routing, async (tx, operation, parent) => {
                    const evidence = [];
                    const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
                    // Different consultants have different binding IDs for the
                    // same clients. Lock shared tenant rows in scope order.
                    const ordered = [...targets.values()].filter(value => value.readContext).sort((a, b) =>
                        compare(a.scope.tenantId, b.scope.tenantId) || compare(a.scope.organisationId, b.scope.organisationId) || compare(a.bindingId, b.bindingId));
                    for (const target of ordered) {
                        const child = { name: 'improvement.list', context: target.readContext, quota: null };
                        const context = await businessContext(inv, tx, target);
                        // Final disclosure only reads authority and never upgrades
                        // these locks. SHARE excludes mutations while remaining
                        // compatible with starter-client retries, which hold the
                        // consultant's parent SHARE before locking their client.
                        const authority = await loadAuthority(inv, child, context, true);
                        const frame = { instance: context.instance, gate: context.gate, binding: context.binding,
                            admissions: context.admissions, authority, scope: context.scope, resolvedAt, quota: null };
                        currentAuthorityAt(inv, child, frame, inv.now());
                        evidence.push({ operation: child, evidence: frame });
                        // Time predicates for earlier targets remain live during
                        // every later awaited read, through COMMIT and disclosure.
                        operation.active.finalAuthority = Object.freeze({ ...parent, targets: evidence.slice() });
                    }
                }, evidence => { disclosure = evidence; });
            } finally { busy = false; closed = true; }
        },
        assertDisclosure() {
            if (disclosureFailure) throw disclosureFailure;
            try {
                if (!closed || busy || !disclosure || inv.owner) throw privateError(false);
                const at = inv.now();
                currentAuthorityAt(inv, { name: 'portfolio.finish' }, disclosure, at);
                return at;
            } catch (error) {
                disclosureFailure = mapped(error, 'improvement.list');
                throw disclosureFailure;
            }
        }
    });
}

function createDashboardRequestDatabase(input) {
    const options = configuration(input), requests = new WeakMap();
    function bindRequest(request, transport) {
        let expectedGeneration;
        try {
            if (!request || typeof request !== 'object') throw privateError(true);
            expectedGeneration = digest(fields(copy(transport, MAX_SMALL), ['expectedGeneration']).expectedGeneration);
        } catch (_) { return Promise.reject(new DashboardPersistenceError('access_denied', 403)); }
        const existing = requests.get(request);
        if (existing) return existing.mode === 'binding' && existing.expectedGeneration === expectedGeneration ? existing.promise :
            Promise.reject(new DashboardPersistenceError('access_denied', 403));
        let resolveBinding, rejectBinding;
        const entry = { mode: 'binding', expectedGeneration, promise: new Promise((resolve, reject) => { resolveBinding = resolve; rejectBinding = reject; }) };
        // Even an invalid first clock sample belongs to this original request.
        // Install before sampling so a reentrant trusted clock cannot reset it.
        requests.set(request, entry);
        let inv;
        try { inv = invocation(options, request, expectedGeneration); }
        catch (error) { rejectBinding(mapped(error)); return entry.promise; }
        Promise.resolve().then(async () => {
            try {
                await capture(inv); await externalEpoch(inv);
                const routing = await locator(inv), resolvedAt = inv.now();
                const database = checkedDatabase(inv);
                const identity = freeze({ authenticated: true, subjectKey: subjectOf(inv.capture.identityPayload) });
                return Object.freeze({ requestId: inv.capture.requestId, identity, scope: routing.scope, resolvedAt,
                    createOperation: (name, context) => operationPair(inv, database, routing, resolvedAt, name, context) });
            } catch (error) { throw mapped(error); }
        }).then(resolveBinding, rejectBinding);
        return entry.promise;
    }
    function bindPortfolioRequest(request, transport) {
        let expectedGeneration;
        try {
            if (!request || typeof request !== 'object' || isProxy(request) || options.improvementEnabled !== true) throw privateError(true);
            expectedGeneration = digest(fields(copy(transport, MAX_SMALL), ['expectedGeneration']).expectedGeneration);
        } catch (_) { return Promise.reject(mapped(privateError(true), 'improvement.list')); }
        const existing = requests.get(request);
        if (existing) return existing.mode === 'portfolio' && existing.expectedGeneration === expectedGeneration ? existing.promise :
            Promise.reject(mapped(privateError(true), 'improvement.list'));
        let resolveBinding, rejectBinding;
        const entry = { mode: 'portfolio', expectedGeneration, promise: new Promise((resolve, reject) => { resolveBinding = resolve; rejectBinding = reject; }) };
        requests.set(request, entry);
        let inv;
        try { inv = invocation(options, request, expectedGeneration); }
        catch (error) { rejectBinding(mapped(error, 'improvement.list')); return entry.promise; }
        Promise.resolve().then(async () => {
            try {
                await capture(inv);
                if (inv.capture.kind !== 'customer') inv.deny();
                await externalEpoch(inv);
                const routing = await locator(inv), resolvedAt = inv.now();
                return portfolioBinding(inv, routing, resolvedAt);
            } catch (error) { throw mapped(error, 'improvement.list'); }
        }).then(resolveBinding, rejectBinding);
        return entry.promise;
    }
    function handleHostResource(request, transport) {
        let selected, resource;
        try {
            if (!request || typeof request !== 'object' || isProxy(request)) throw privateError(true);
            selected = fields(copy(transport, MAX_SMALL), ['route', 'expectedGeneration']);
            resource = hostResourceForRoute(selected.route);
            if (resource.requiresGeneration) digest(selected.expectedGeneration);
            else if (selected.expectedGeneration !== null) throw privateError(true);
            selected = freeze(selected);
        } catch (_) { return Promise.reject(new DashboardPersistenceError('access_denied', 403)); }
        const existing = requests.get(request);
        if (existing) return existing.mode === 'host' && existing.route === selected.route && existing.expectedGeneration === selected.expectedGeneration
            ? existing.promise : Promise.reject(new DashboardPersistenceError('access_denied', 403));
        let resolveHost, rejectHost;
        const entry = { mode: 'host', route: selected.route, expectedGeneration: selected.expectedGeneration,
            promise: new Promise((resolve, reject) => { resolveHost = resolve; rejectHost = reject; }) };
        requests.set(request, entry);
        let inv;
        try { inv = invocation(options, request, selected.expectedGeneration, !resource.requiresGeneration); }
        catch (error) { rejectHost(mapped(error, 'host.resource')); return entry.promise; }
        Promise.resolve().then(async () => {
            try {
                await capture(inv); await externalEpoch(inv);
                const routing = await locator(inv);
                return await hostOperation(inv, routing, resource);
            } catch (error) {
                if (error instanceof DashboardPersistenceError &&
                    (error.code === 'dashboard_access_denied' && error.statusCode === 403 ||
                     ['dashboard_unavailable', 'dashboard_outcome_ambiguous'].includes(error.code) && error.statusCode === 503)) throw error;
                throw mapped(error, 'host.resource');
            }
        }).then(resolveHost, rejectHost);
        return entry.promise;
    }
    return Object.freeze({ bindRequest, handleHostResource, bindPortfolioRequest });
}

module.exports = { createDashboardRequestDatabase };
