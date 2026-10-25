'use strict';

// Exact-result DATA path. Genuine current capture is mandatory; historical
// trial records never authenticate. Production also requires paired SQL audit.
const crypto = require('node:crypto');
const { copy, fields, freeze, uuid, digest, revision, instant, hash, equal } = require('../appLifecycle/dashboardRuntimeRecords');
const { normaliseStableIdentity } = require('../appLifecycle/dashboardOnboardingDomain');
const { normaliseMembershipState } = require('../appLifecycle/membershipDomain');
const { resolveEntitlements } = require('../appLifecycle/entitlementDomain');
const { resolveOrganisation } = require('../appLifecycle/tenantDomain');
const { normalRole } = require('../appLifecycle/dashboardResourceAuthority');
const { normaliseNcscSelector, projectNcscDetail } = require('../ncscAssessmentService');
const { MODULE_ID, ACCEPTED_PROFILE_REF } = require('../assessmentEngine/ncscAssessmentEvaluator');
const { workEmail } = require('../organisationSetup');
const { starterAccountKey, starterAccountRecord, starterClientRecord } = require('./starterAccountAllocation');
const { THREE_MONTH_PLAN_ID, approvedStarterPlan } = require('./customerStarterPlan');
const { retainedStarterPreparation, retainedStarterActivation } = require('./starterProvisioning');
const { createPostgresRetainedTrialAssessmentStore } = require('./postgresRetainedTrialAssessmentStore');
const { createRetainedTrialReadAudit } = require('./postgresRetainedTrialReadAudit');

class RetainedTrialReadError extends Error {
    constructor(code = 'retained_read_unavailable', statusCode = 503) {
        super(code); this.name = 'RetainedTrialReadError'; this.code = code; this.statusCode = statusCode;
    }
}
const deny = () => { throw new RetainedTrialReadError('retained_read_denied', 403); };
const CAPTURE_FIELDS = ['requestId', 'deadline', 'sessionSha256', 'kind', 'identityPayload', 'instanceId',
    'restoreEpoch', 'issuedAt', 'expiresAt', 'operatorIssuanceProof', 'discovery'];

function captured(raw) {
    if (raw === null) deny();
    const c = fields(copy(raw, 16384), CAPTURE_FIELDS);
    for (const key of ['requestId', 'instanceId', 'restoreEpoch']) uuid(c[key]);
    for (const key of ['deadline', 'issuedAt', 'expiresAt']) instant(c[key]);
    digest(c.sessionSha256); c.identityPayload = normaliseStableIdentity(c.identityPayload);
    if (c.kind !== 'customer' || c.operatorIssuanceProof !== null || c.discovery !== null || c.issuedAt >= c.expiresAt) deny();
    return freeze(c);
}

// Validate the current subject index as revocation/ownership DATA. Its expiry is
// deliberately not an authentication proof and is never evaluated at an old
// clock. The separate genuine capture must pass its current identity policy.
function subjectIndex(raw, subjectKey) {
    if (raw === null) deny();
    const value = fields(copy(raw, 16384), ['schemaVersion', 'subjectKey', 'email', 'revision', 'status',
        'invitationDigest', 'invitationId', 'tenantId', 'organisationId', 'termsVersion', 'termsDigest',
        'scheduleId', 'scheduleDigest', 'bindingId', 'expiresAt', 'accountType']);
    for (const key of ['invitationDigest', 'termsDigest', 'scheduleDigest']) digest(value[key]);
    for (const key of ['tenantId', 'organisationId', 'bindingId']) uuid(value[key]);
    revision(value.revision);
    if (value.schemaVersion !== 2 || value.subjectKey !== subjectKey || value.status !== 'active' || value.revision !== 0 ||
        value.email !== workEmail(value.email) || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= 0 ||
        !['company', 'consultant'].includes(value.accountType)) deny();
    return freeze(value);
}

// Shared current ownership DATA for the read-purpose login policy and reader.
// This is neither authentication nor a tenant capability on its own.
async function readRetainedTrialOwner({ subjectKey, readSubject, accountStore }) {
    const index = subjectIndex(await readSubject(subjectKey), subjectKey);
    const found = await accountStore.load(starterAccountKey(index.email));
    if (!found) deny();
    const account = starterAccountRecord(found.record), plan = approvedStarterPlan(account.planId), own = account.organisations[0];
    if (plan.planId !== THREE_MONTH_PLAN_ID || plan.readSavedResultsAfterExpiry !== true || account.activation === null ||
        account.activation.subjectKey !== subjectKey || account.identitySubjectKey !== undefined && account.identitySubjectKey !== subjectKey ||
        account.activation.receiptId !== own.activationId || account.email !== index.email || account.accountType !== index.accountType ||
        own.bindingId !== index.bindingId || own.tenantId !== index.tenantId || own.organisationId !== index.organisationId ||
        own.scheduleId !== index.scheduleId || plan.termsVersion !== index.termsVersion || plan.termsDigest !== index.termsDigest) deny();
    return freeze({ account, index });
}

function assertFacts(facts, account, index, slot, capture, at) {
    const actor = `${capture.identityPayload.identityTenantId}:${capture.identityPayload.oid}`;
    const { instance, gate, accountRow } = facts;
    if (instance.instanceId !== capture.instanceId || instance.restoreEpoch !== capture.restoreEpoch ||
        instance.ingressStatus !== 'enabled' || instance.changedAt > at) deny();
    if (gate && (gate.kind !== 'customer' || gate.status !== 'active' || gate.sessionSha256 !== capture.sessionSha256 ||
        gate.subjectKey !== actor || !equal(gate.identityPayload, capture.identityPayload) ||
        gate.instanceId !== capture.instanceId || gate.restoreEpoch !== capture.restoreEpoch ||
        gate.issuedAt !== capture.issuedAt || gate.expiresAt !== capture.expiresAt || gate.updatedAt > at ||
        gate.revision !== 0 || gate.selectionGeneration !== 0 ||
        gate.selectedBindingId !== slot.bindingId || gate.selectedTenantId !== slot.tenantId ||
        gate.selectedOrganisationId !== slot.organisationId)) deny();
    const expectedEmail = crypto.createHash('sha256').update('nofries:starter-email:v1\0' + account.email).digest('hex');
    if (accountRow.account_id !== account.accountId || accountRow.email_sha256 !== expectedEmail || accountRow.subject_key !== actor ||
        accountRow.account_type !== account.accountType || accountRow.activated_at === null ||
        new Date(accountRow.activated_at).toISOString() !== account.activation.activatedAt) deny();
    function scope(current, selected) {
        const p = retainedStarterPreparation(current.retained.preparation), a = current.retained.activation;
        if (a === null) deny();
        retainedStarterActivation(p, a);
        if (p.accountId !== account.accountId || p.planId !== account.planId || p.planSha256 !== account.planSha256 ||
            p.subjectKey !== actor || p.email !== account.email || p.accountType !== account.accountType || !equal(p.slot, selected) ||
            a.validFrom !== account.activation.activatedAt || a.validUntil !== account.activation.validUntil || at < a.validUntil) deny();
        const { binding, admission, snapshot } = current;
        if (!equal(binding.identity, capture.identityPayload) || binding.subjectKey !== actor || binding.status !== 'active' ||
            binding.updatedAt > at || binding.bindingId !== selected.bindingId || !equal(binding.scope, p.scope) ||
            binding.validFrom !== a.occurredAt || binding.validUntil !== a.validUntil ||
            binding.membershipId !== selected.membershipId || binding.invitationId !== p.invitationId ||
            binding.grantEvidenceId !== p.representativeAuthorityEvidenceId ||
            !equal(binding.authorityRef, { authorityId: admission.authorityId, revision: admission.revision, sha256: admission.decisionSha256 }) ||
            !equal(admission, a.admission) || admission.payload.decision !== 'eligible') deny();
        const organisation = resolveOrganisation(snapshot.tenantAggregate, p.scope), membership = normaliseMembershipState(snapshot.membershipState);
        const member = membership.memberships.find(item => item.membershipId === selected.membershipId);
        if (snapshot.tenantAggregate.tenant.recordStatus !== 'active' || organisation.recordStatus !== 'active' ||
            membership.updatedAt > at || !member || member.status !== 'active' || member.subjectKey !== actor ||
            member.validFrom !== a.occurredAt || member.validUntil !== a.validUntil || member.invitationId !== p.invitationId ||
            member.grantEvidenceId !== p.representativeAuthorityEvidenceId || !normalRole(member, 'assessment.read')) deny();
        const currentEntitlements = resolveEntitlements(snapshot.entitlementState, snapshot.tenantAggregate, p.scope, at, snapshot.flags);
        const grant = snapshot.entitlementState.grants.find(item => item.grantId === selected.grantId);
        if (!grant || grant.status !== 'active' || grant.code !== 'dashboard_score' || grant.agreementRef !== p.schedule.scheduleId ||
            grant.validFrom !== a.validFrom || grant.validUntil !== a.validUntil ||
            !grant.modules.includes(MODULE_ID) || !grant.frameworks.some(f => f.moduleId === MODULE_ID &&
                f.profileId === ACCEPTED_PROFILE_REF.profileId && f.version === ACCEPTED_PROFILE_REF.profileVersion) ||
            currentEntitlements.product !== null ||
            snapshot.flags.enabled.dashboard !== true || snapshot.flags.enabled.cyber_security !== true ||
            !snapshot.flags.frameworks.some(f => f.moduleId === MODULE_ID && f.profileId === ACCEPTED_PROFILE_REF.profileId &&
                f.version === ACCEPTED_PROFILE_REF.profileVersion)) deny();
        return { p, a };
    }
    const own = scope(facts.original, account.organisations[0]), selected = scope(facts.selected, slot);
    if (account.activation.receiptId !== own.p.slot.activationId || index.bindingId !== own.p.slot.bindingId ||
        index.tenantId !== own.p.scope.tenantId || index.organisationId !== own.p.scope.organisationId ||
        index.invitationId !== own.p.invitationId || index.scheduleId !== own.p.schedule.scheduleId ||
        index.scheduleDigest !== own.p.schedule.scheduleDigest || index.termsVersion !== own.p.terms.termsVersion ||
        index.termsDigest !== own.p.terms.termsDigest) deny();
    return selected;
}

function normaliseRetainedTrialReadSelection(raw) {
    const selection = fields(copy(raw, 16384), ['bindingId', 'assessmentId']);
    uuid(selection.bindingId); normaliseNcscSelector({ assessmentId: selection.assessmentId });
    return freeze(selection);
}

function createRetainedTrialAssessmentReader({ captureRequest, readSubject, accountStore, database, clock, auditRead = false }) {
    if (typeof auditRead !== 'boolean' || [captureRequest, readSubject, clock, accountStore?.load].some(fn => typeof fn !== 'function'))
        throw new RetainedTrialReadError('retained_read_configuration_invalid', 400);
    const store = createPostgresRetainedTrialAssessmentStore(database), pending = new WeakMap(), attempts = new WeakMap();
    async function perform(request, selection) {
        let last = null, capture;
        function time() {
            const at = instant(clock());
            if (last !== null && at < last) throw new RetainedTrialReadError();
            last = at;
            if (capture && (at < capture.issuedAt || at >= capture.expiresAt || at >= capture.deadline)) deny();
            return at;
        }
        time(); capture = captured(await captureRequest(request)); time();
        const actor = `${capture.identityPayload.identityTenantId}:${capture.identityPayload.oid}`;
        async function external() {
            const current = captured(await captureRequest(request)); time();
            if (!equal(current, capture)) deny();
            const { account, index } = await readRetainedTrialOwner({ subjectKey: actor,
                readSubject: async key => { const result = await readSubject(key); time(); return result; },
                accountStore: { load: async key => { const result = await accountStore.load(key); time(); return result; } } });
            let slot = account.organisations.find(item => item.bindingId === selection.bindingId);
            if (!slot && account.accountType === 'consultant' && typeof accountStore.loadClientByBinding === 'function') {
                // Exact account/binding lookup of an independent reservation;
                // never enumerate a consultant's whole organisation directory.
                const raw = await accountStore.loadClientByBinding(account.accountId, selection.bindingId); time();
                if (raw !== null) slot = starterClientRecord(account.accountId, raw);
                if (slot && slot.bindingId !== selection.bindingId) deny();
            }
            if (!slot) deny();
            return { account, index, slot };
        }
        const initial = await external();
        let audit = null;
        if (auditRead) {
            const binding = hash({ capture, initial, selection });
            let attempt = attempts.get(request);
            if (attempt && attempt.binding !== binding) deny();
            if (!attempt) {
                attempt = { binding, audit: await createRetainedTrialReadAudit({ capture, slot: initial.slot, clock: time }) };
                attempts.set(request, attempt);
            }
            audit = attempt.audit;
        }
        const result = await store.read({ capture, ...initial, assessmentId: selection.assessmentId }, async (facts, version, complete) => {
            const selected = assertFacts(facts, initial.account, initial.index, initial.slot, capture, time());
            if (!complete) return;
            const latest = await external();
            if (!equal(latest, initial)) deny();
            assertFacts(facts, initial.account, initial.index, initial.slot, capture, time());
            if (version === null) throw new RetainedTrialReadError('retained_read_not_found', 404);
            if (version.envelope.state.status !== 'submitted' || version.envelope.submission === null ||
                version.envelope.state.createdAt < selected.a.occurredAt || version.envelope.state.updatedAt >= selected.a.validUntil) deny();
            return freeze({ schemaVersion: 1, readOnly: true, trialEndedAt: selected.a.validUntil, assessment: projectNcscDetail(version) });
        }, time, audit);
        // Transaction acknowledgement can itself outlast or revoke the current
        // browser session. Recheck genuine current authentication/owner DATA
        // once more before releasing the buffered result.
        const final = await external();
        if (!equal(final, initial)) deny();
        time(); return result;
    }
    return Object.freeze({ read(request, raw) {
        let selection;
        try {
            if (!request || typeof request !== 'object') deny();
            selection = normaliseRetainedTrialReadSelection(raw);
        } catch (_) { return Promise.reject(new RetainedTrialReadError('retained_read_input_invalid', 400)); }
        const key = hash(selection), active = pending.get(request);
        if (active) return active.key === key ? active.promise : Promise.reject(new RetainedTrialReadError('retained_read_denied', 403));
        const promise = Promise.resolve().then(() => perform(request, selection)).catch(error => {
            if (error instanceof RetainedTrialReadError) throw error;
            throw new RetainedTrialReadError();
        }).finally(() => { pending.delete(request); });
        pending.set(request, { key, promise }); return promise;
    } });
}

module.exports = { createRetainedTrialAssessmentReader, readRetainedTrialOwner, normaliseRetainedTrialReadSelection, RetainedTrialReadError };
