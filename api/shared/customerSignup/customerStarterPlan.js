'use strict';

// The owner-approved default is configuration, never a browser-supplied plan.
// These pure compilers describe finite scope; they do not authenticate a person,
// approve an existing organisation, accept terms or publish an access binding.
const crypto = require('node:crypto');
const configured = require('./starterPlan.json');
const trialConfigured = require('./starterTrialPlan.json');
const { fields, copy, freeze, uuid, subject, instant, id, hash } = require('../appLifecycle/dashboardRuntimeRecords');
const { createTenantAggregate } = require('../appLifecycle/tenantDomain');
const { createMembershipState, applyMembershipCommand } = require('../appLifecycle/membershipDomain');
const { normaliseEntitlementState, resolveEntitlements, consumeEntitlementLimit } = require('../appLifecycle/entitlementDomain');
const { validateAcceptanceReceipt } = require('./invitationAcceptance');
const { workEmail } = require('../organisationSetup');
const DAY = 86400000;
const LEGACY_PLAN_ID = 'nf-starter-2026-09-r1';
const THREE_MONTH_PLAN_ID = 'nf-starter-2026-10-r2';
// An additive schedule policy leaves every retained plan, agreement and offer
// digest reproducible. New schedules select it in trusted server composition.
const CONSULTANT_ORGANISATION_POLICY = 'unlimited-v1';
function usesUnlimitedConsultantPolicy(input) {
    return !!input && input.accountType === 'consultant' &&
        input.consultantOrganisationPolicy === CONSULTANT_ORGANISATION_POLICY;
}
const preparations = new WeakMap();
const sha = value => crypto.createHash('sha256').update(value, 'utf8').digest('hex');
const fail = () => { throw new Error('starter_plan_invalid'); };
const PLAN_KEYS = ['schemaVersion', 'planId', 'approvalRef', 'approvedAt', 'durationDays',
    'assessmentSubmissionsPerOrganisation', 'usersPerOrganisation', 'companyOrganisations',
    'consultantWorkspaces', 'consultantClientOrganisations', 'priceNzd', 'automaticPaidConversion',
    'aiRequests', 'evidenceBytes', 'reportExports', 'deleteDataAtExpiry', 'termsVersion', 'termsDigest'];

// A missing selector retains the historical contract. Enabling a new offer is a
// separate server-owned choice after its schema/archive/release gates pass.
function approvedStarterPlan(planId = LEGACY_PLAN_ID) {
    if (![LEGACY_PLAN_ID, THREE_MONTH_PLAN_ID].includes(planId)) fail();
    const legacy = planId === LEGACY_PLAN_ID;
    const keys = legacy ? PLAN_KEYS : [...PLAN_KEYS.filter(k => k !== 'durationDays'), 'durationMonths', 'readSavedResultsAfterExpiry'];
    const plan = fields(copy(legacy ? configured : trialConfigured, 8192), keys);
    if (plan.planId !== planId || plan.schemaVersion !== (legacy ? 1 : 2) ||
        (legacy ? plan.approvalRef !== 'github:Discla1mer/NoFries:274:5880195870' ||
            plan.durationDays !== 14 || plan.assessmentSubmissionsPerOrganisation !== 5 :
            plan.approvalRef !== 'chatgpt-page:page_30c4fb5854a08191afa936c73b226f69:sequence21:7380e89b-bd54-42e9-bc63-e7e69f4b607f' ||
            plan.durationMonths !== 3 || plan.assessmentSubmissionsPerOrganisation !== null || plan.readSavedResultsAfterExpiry !== true) ||
        plan.usersPerOrganisation !== 1 || plan.companyOrganisations !== 1 ||
        plan.consultantWorkspaces !== 1 || plan.consultantClientOrganisations !== 3 ||
        plan.priceNzd !== 0 || plan.automaticPaidConversion !== false || plan.aiRequests !== 0 ||
        plan.evidenceBytes !== 0 || plan.reportExports !== 0 || plan.deleteDataAtExpiry !== false ||
        plan.termsVersion !== (legacy ? 'nf-dashboard-2026-09-r2' : 'nf-dashboard-2026-10-r3') ||
        plan.termsDigest !== (legacy ? '257fdd66a5359392428c0e5f16734a7ac64ff886e9b359218e4e87b4c7f68acc' :
            '441ae6d803002238cb742349e0789617ba141c2e8cc9c83c524c83015c89bf87')) fail();
    instant(plan.approvedAt);
    return freeze({ ...plan, sha256: hash(plan) });
}

function text(value, maximum) {
    if (typeof value !== 'string' || !value || value.length > maximum ||
        value !== value.trim().normalize('NFC') || /[\u0000-\u001f\u007f-\u009f<>]/u.test(value)) fail();
    return value;
}
function selectedType(value) { if (!['company', 'consultant'].includes(value)) fail(); return value; }
function accountWindow(activatedAt, planId = LEGACY_PLAN_ID) {
    const plan = approvedStarterPlan(planId), start = Date.parse(instant(activatedAt));
    if (start < Date.parse(plan.approvedAt)) fail();
    let end;
    if (planId === LEGACY_PLAN_ID) end = new Date(start + plan.durationDays * DAY).toISOString();
    else {
        // Work in UTC and move from day 1 before restoring/clamping the day.
        // setUTCMonth on January 31 directly would overflow into May.
        const target = new Date(start), day = target.getUTCDate();
        target.setUTCDate(1); target.setUTCMonth(target.getUTCMonth() + plan.durationMonths);
        const last = new Date(target.getTime()); last.setUTCMonth(last.getUTCMonth() + 1); last.setUTCDate(0);
        target.setUTCDate(Math.min(day, last.getUTCDate()));
        end = target.toISOString();
    }
    instant(end);
    return freeze({ validFrom: activatedAt, validUntil: end });
}

function starterOfferPlan(input) {
    if (Object.hasOwn(input, 'planId') && typeof input.planId !== 'string') fail();
    return approvedStarterPlan(Object.hasOwn(input, 'planId') ? input.planId : LEGACY_PLAN_ID);
}

// Cover every trial starting before the invitation deadline. Clamping can map
// consecutive source dates to one target date, so an earlier day's later time
// may end after the deadline's own projection. No trial or guard is extended.
function starterAuthorityExpiry(offerExpiresAt, planId = LEGACY_PLAN_ID) {
    if (!Number.isSafeInteger(offerExpiresAt) || offerExpiresAt < 0) fail();
    const plan = approvedStarterPlan(planId);
    if (plan.planId === LEGACY_PLAN_ID) return offerExpiresAt + plan.durationDays * DAY;
    const end = Date.parse(accountWindow(new Date(offerExpiresAt).toISOString(), planId).validUntil);
    const day = new Date(offerExpiresAt); day.setUTCHours(0, 0, 0, 0);
    const previousDayEnd = day.getTime() - 1;
    if (previousDayEnd < Date.parse(plan.approvedAt)) return end;
    // Within a source day the projection increases with time; earlier target
    // dates cannot exceed this previous day's final millisecond. The maximum
    // adds less than one UTC day, only where adjacent dates clamp together.
    return Math.max(end, Date.parse(accountWindow(new Date(previousDayEnd).toISOString(), planId).validUntil));
}

// This offer can be archived and accepted before activation. It deliberately has
// no activation timestamp; the canonical activation receipt later fixes the term.
function compileStarterSchedule(input) {
    const value = fields(copy(input, 16384), ['tenantId', 'organisationId', 'organisationName',
        'accountType', 'kind', 'grantId', 'scheduleId', 'contact', 'framework', ...(Object.hasOwn(input, 'planId') ? ['planId'] : []),
        ...(Object.hasOwn(input, 'consultantOrganisationPolicy') ? ['consultantOrganisationPolicy'] : [])]);
    uuid(value.tenantId); uuid(value.organisationId); uuid(value.grantId); uuid(value.scheduleId);
    if (new Set([value.tenantId, value.organisationId, value.grantId, value.scheduleId]).size !== 4) fail();
    text(value.organisationName, 120); selectedType(value.accountType);
    if (!['own', 'client'].includes(value.kind) || value.kind === 'client' && value.accountType !== 'consultant') fail();
    const unlimited = Object.hasOwn(value, 'consultantOrganisationPolicy');
    if (unlimited && (value.consultantOrganisationPolicy !== CONSULTANT_ORGANISATION_POLICY || value.accountType !== 'consultant')) fail();
    const contact = fields(value.contact, ['name', 'role', 'email', 'address', 'registrationId', 'authorityEvidenceId']);
    text(contact.name, 160); text(contact.role, 120); text(contact.address, 500); id(contact.authorityEvidenceId);
    if (contact.email !== workEmail(contact.email)) fail();
    if (contact.registrationId !== null) text(contact.registrationId, 160);
    const framework = fields(value.framework, ['moduleId', 'profileId', 'version', 'scoringVersion']);
    if (framework.moduleId !== 'cyber_security') fail();
    id(framework.profileId); id(framework.version); id(framework.scoringVersion);
    const plan = starterOfferPlan(value), legacy = plan.planId === LEGACY_PLAN_ID;
    // The reusable price/allowance decision is not evidence of this person's
    // authority to administer this particular organisation.
    if ([LEGACY_PLAN_ID, THREE_MONTH_PLAN_ID].some(planId => {
        const generic = approvedStarterPlan(planId);
        return [generic.approvalRef, generic.planId].includes(contact.authorityEvidenceId);
    })) fail();
    const quote = value => JSON.stringify(value); // Keep customer text as data in the immutable text archive.
    const scheduleText = [
        'No Fries complimentary starter dashboard schedule',
        `Schedule: ${value.scheduleId}; version: ${plan.planId}`,
        `Organisation: ${quote(value.organisationName)}`,
        `Organisation ID: ${value.organisationId}`,
        `Account: ${value.accountType}; organisation kind: ${value.kind}`,
        `Registration identifier: ${contact.registrationId === null ? 'Not applicable' : quote(contact.registrationId)}`,
        `Principal address: ${quote(contact.address)}`,
        `Representative: ${quote(contact.name)}; role: ${quote(contact.role)}; verified email: ${quote(contact.email)}`,
        `Representative authority evidence: ${quote(contact.authorityEvidenceId)}`,
        legacy ? `Access period: ${plan.durationDays} days from account activation, as recorded in the canonical activation receipt.` :
            'Access period: 3 calendar months from account activation at the same UTC time, clamped to the final day of the target month, as recorded in the canonical activation receipt.',
        'Client organisations share the original account expiry; adding a client does not start another period.',
        `Included: Overview, manual Cyber Security assessment and Improvement Plan.`,
        `Assessment: ${quote(framework.profileId)}; version: ${quote(framework.version)}; scoring: ${quote(framework.scoringVersion)}.`,
        legacy ? `Allowance: ${plan.assessmentSubmissionsPerOrganisation} assessment submissions and ${plan.usersPerOrganisation} user per organisation for this access period.` :
            `Allowance: no assessment or submission cap; ${plan.usersPerOrganisation} user per organisation for this access period. Editing the same assessment consumes no additional assessment run.`,
        value.accountType === 'company' ? `Company allowance: ${plan.companyOrganisations} organisation.` :
            unlimited ? `Consultant organisation policy: ${CONSULTANT_ORGANISATION_POLICY}. No product limit on the number of client organisations managed. This replaces the organisation-count allowance for this schedule; each organisation still requires its own authority, accepted scope and active access.` :
                `Consultant allowance: ${plan.consultantWorkspaces} workspace plus up to ${plan.consultantClientOrganisations} client organisations.`,
        'Price: NZ$0. No payment authority, automatic renewal or conversion to paid access.',
        'AI, evidence uploads and report exports: disabled. Extra services require separate express agreement.',
        'Excluded: managed IT, monitoring, incident response, remediation, audit and certification.',
        'Support, availability and recovery: the standard dashboard agreement applies; no additional commitment.',
        legacy ? 'Expiry ends this allowance; it does not delete saved work. Existing retention and lawful-hold rules apply.' :
            'Expiry ends creating, editing and submitting assessments. Authorised users retain read-only access to saved results. Existing retention and lawful-hold rules apply.',
        'Providers: application/assessment data — Microsoft Azure, New Zealand North; authentication sessions,',
        'invitations and agreement/access archives — private Azure Storage, Australia East; identity — Microsoft Entra ID;',
        'invitation messages — Microsoft Entra B2B through Microsoft Graph; verification email — Resend.',
        'Manual assessment and deterministic results require no AI processing.',
        'Privacy notice: privacy.html, 29 September 2026.',
        `Agreement: ${plan.termsVersion}; SHA-256: ${plan.termsDigest}.`,
        'Acceptance must be the authenticated representative’s deliberate action. This schedule records no acceptance.',
        ''
    ].join('\n');
    const scheduleDigest = sha(scheduleText);
    return freeze({ schedule: { schemaVersion: 1, scheduleId: value.scheduleId, scheduleText, scheduleDigest },
        terms: { termsVersion: plan.termsVersion, termsDigest: plan.termsDigest },
        representativeAuthorityEvidenceId: contact.authorityEvidenceId });
}

// IDs, actual activation time and profile come from trusted durable records.
// The accepted offer's bytes remain identical when the term is fixed later.
function compileStarterOrganisation(input) {
    const value = fields(copy(input, 16384), ['tenantId', 'organisationId', 'organisationName',
        'accountType', 'kind', 'activatedAt', 'grantId', 'scheduleId', 'contact', 'framework', ...(Object.hasOwn(input, 'planId') ? ['planId'] : []),
        ...(Object.hasOwn(input, 'consultantOrganisationPolicy') ? ['consultantOrganisationPolicy'] : [])]);
    const { activatedAt, ...scheduleInput } = value;
    const offer = compileStarterSchedule(scheduleInput);
    const plan = starterOfferPlan(value), window = accountWindow(activatedAt, plan.planId), framework = value.framework;
    const scope = { tenantId: value.tenantId, organisationId: value.organisationId };
    const tenantAggregate = createTenantAggregate({ tenant: { tenantId: scope.tenantId, displayName: value.organisationName },
        organisations: [{ ...scope, displayName: value.organisationName }] });
    const modules = ['overview', 'cyber_security', 'improvement_plan'];
    const frameworks = [{ moduleId: framework.moduleId, profileId: framework.profileId, version: framework.version }];
    const entitlementState = normaliseEntitlementState({ schemaVersion: 1, ...scope, revision: 1, grants: [{
        ...scope, grantId: value.grantId, code: 'dashboard_score', status: 'active', ...window,
        agreementRef: value.scheduleId, modules, frameworks, limits: {
            assessment_runs: plan.assessmentSubmissionsPerOrganisation, memberships: plan.usersPerOrganisation,
            ai_requests: plan.aiRequests, evidence_bytes: plan.evidenceBytes, report_exports: plan.reportExports
        }, coverage: [], actions: [] }] }, tenantAggregate);
    // The global deployment/profile registry is independently required at use.
    const flags = { ...scope, revision: 1, enabled: { dashboard: true, overview: true, cyber_security: true,
        improvement_plan: true, evidence: false, board_reports: false, ai_governance: false,
        it_optimisation: false, services: false, ai_drafting: false, governance_workflow: false }, frameworks };
    resolveEntitlements(entitlementState, tenantAggregate, scope, window.validFrom, flags);
    const result = freeze({ planId: plan.planId, planSha256: plan.sha256, approvalRef: plan.approvalRef,
        accountType: value.accountType, kind: value.kind, scope, ...window,
        ...offer,
        tenantAggregate, entitlementState, flags });
    return result;
}

// Preparation creates no grant, membership invitation, usage allowance or trial
// clock. The provider invitation and immutable offer can safely precede consent.
function compileStarterPreparation(input) {
    const value = fields(copy(input, 16384), ['offerInput', 'subjectKey', 'invitationId', 'issuerSubjectKey', 'createdAt']);
    subject(value.subjectKey); subject(value.issuerSubjectKey); id(value.invitationId); instant(value.createdAt);
    const plan = starterOfferPlan(value.offerInput), offer = compileStarterSchedule(value.offerInput);
    if (value.createdAt < plan.approvedAt) fail();
    const { tenantId, organisationId, organisationName, accountType, kind } = value.offerInput;
    const scope = { tenantId, organisationId };
    const tenantAggregate = createTenantAggregate({ tenant: { tenantId, displayName: organisationName },
        organisations: [{ ...scope, displayName: organisationName }] });
    const initialState = { tenantAggregate,
        membershipState: createMembershipState(tenantAggregate, scope, value.createdAt),
        entitlementState: normaliseEntitlementState({ schemaVersion: 1, ...scope, revision: 0, grants: [] }, tenantAggregate),
        flags: { ...scope, revision: 0, enabled: {}, frameworks: [] }, advisorAssignments: [] };
    resolveEntitlements(initialState.entitlementState, tenantAggregate, scope, value.createdAt, initialState.flags);
    const result = freeze({ planId: plan.planId, planSha256: plan.sha256, accountType, kind, scope,
        subjectKey: value.subjectKey, invitationId: value.invitationId, createdAt: value.createdAt, ...offer, initialState });
    preparations.set(result, freeze(value));
    return result;
}

// A pure transaction proposal, not proof of a commit or permission to publish.
// The scoped provisioner must load genuine consent/current identity, supply its
// transaction time and retained parent activation, and atomically commit these
// states plus activationIntent. On retries it must read the committed intent.
function compileStarterActivation(input) {
    const value = fields(input, ['preparation', 'accountId', 'activationId', 'membershipId', 'acceptance', 'occurredAt', 'accountActivatedAt']);
    const prepared = preparations.get(value.preparation);
    if (!prepared) fail();
    const preparation = value.preparation;
    uuid(value.accountId); uuid(value.activationId); uuid(value.membershipId); instant(value.occurredAt);
    const receipt = validateAcceptanceReceipt(copy(value.acceptance, 8192));
    for (const [key, expected] of Object.entries({ ...preparation.scope, subjectKey: preparation.subjectKey,
        invitationId: preparation.invitationId, ...preparation.terms, scheduleId: preparation.schedule.scheduleId,
        scheduleDigest: preparation.schedule.scheduleDigest })) if (receipt[key] !== expected) fail();
    if (receipt.acceptedAt < Date.parse(preparation.createdAt) || receipt.acceptedAt > Date.parse(value.occurredAt)) fail();
    let activatedAt;
    if (preparation.kind === 'own') {
        if (value.accountActivatedAt !== null) fail();
        activatedAt = value.occurredAt;
    } else {
        activatedAt = instant(value.accountActivatedAt);
        if (activatedAt > value.occurredAt) fail();
    }
    const organisation = compileStarterOrganisation({ ...prepared.offerInput, activatedAt });
    if (value.occurredAt >= organisation.validUntil) fail();
    const scope = preparation.scope, at = value.occurredAt, aggregate = preparation.initialState.tenantAggregate;
    const invited = applyMembershipCommand(preparation.initialState.membershipState, aggregate, {
        ...scope, expectedRevision: 0, actorSubjectKey: prepared.issuerSubjectKey, now: at, action: 'invite', payload: {
            invitationId: preparation.invitationId, subjectKey: preparation.subjectKey, roles: ['admin'],
            validFrom: at, validUntil: organisation.validUntil,
            grantEvidenceId: preparation.representativeAuthorityEvidenceId, expiresAt: organisation.validUntil } });
    const membershipState = applyMembershipCommand(invited, aggregate, { ...scope, expectedRevision: 1,
        actorSubjectKey: preparation.subjectKey, now: at, action: 'accept', payload: {
            invitationId: preparation.invitationId, membershipId: value.membershipId } });
    const grantId = prepared.offerInput.grantId;
    const emptyUsage = { schemaVersion: 1, ...scope, grantId, revision: 0,
        counters: { assessment_runs: 0, memberships: 0, ai_requests: 0, evidence_bytes: 0, report_exports: 0 } };
    const usage = consumeEntitlementLimit(organisation.entitlementState, aggregate, emptyUsage, { ...scope,
        grantId, expectedEntitlementRevision: 1, expectedFlagRevision: 1, expectedUsageRevision: 0,
        moduleId: 'overview', limit: 'memberships', amount: 1, framework: null }, at, organisation.flags);
    const nextState = { tenantAggregate: aggregate, membershipState, entitlementState: organisation.entitlementState,
        flags: organisation.flags, advisorAssignments: [], usage: [usage] };
    const activationIntent = { schemaVersion: 1, activationId: value.activationId, accountId: value.accountId,
        planId: preparation.planId, planSha256: preparation.planSha256, ...scope, subjectKey: preparation.subjectKey,
        membershipId: value.membershipId, acceptanceReceiptId: receipt.receiptId, acceptanceSha256: hash(receipt),
        scheduleId: preparation.schedule.scheduleId, scheduleDigest: preparation.schedule.scheduleDigest,
        occurredAt: at, accountActivatedAt: activatedAt, validUntil: organisation.validUntil,
        initialStateSha256: hash(preparation.initialState), nextStateSha256: hash(nextState) };
    return freeze({ nextState, activationIntent });
}

module.exports = { LEGACY_PLAN_ID, THREE_MONTH_PLAN_ID, CONSULTANT_ORGANISATION_POLICY, usesUnlimitedConsultantPolicy, approvedStarterPlan, starterOfferPlan, accountWindow,
    starterAuthorityExpiry, compileStarterSchedule, compileStarterPreparation, compileStarterActivation };
