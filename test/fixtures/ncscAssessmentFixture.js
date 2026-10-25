'use strict';

// Synthetic source-test composition only. No production policy or service default.
const crypto = require('node:crypto');
const { fixture: dashboardFixture, SUBJECT } = require('./dashboardFixture');
const { createTenantRequestContext } = require('../../api/shared/appLifecycle/tenantRequestContext');
const { createDashboardAudit } = require('../../api/shared/appLifecycle/dashboardAudit');
const { acceptedProfile } = require('../../api/shared/assessmentLifecycle/ncscAssessmentSubmission');
const { ACCEPTED_PROFILE_REF } = require('../../api/shared/assessmentEngine/ncscAssessmentEvaluator');

const NOW = '2026-09-07T09:00:00.000Z';
const EMPTY_REVISIONS = Object.freeze({ tenant: null, organisation: null, membership: null,
    entitlement: null, flags: null, advisorAssignments: [], usage: [] });
const clone = value => JSON.parse(JSON.stringify(value));

function ncscFixture(options = {}) {
    const now = options.now || NOW;
    const source = dashboardFixture({ now, role: options.role || 'admin',
        service: options.service ? 'fractional_advisory' : undefined,
        organisationId: options.organisationId || 'shared-organisation',
        modules: ['overview', 'cyber_security', 'services'] });
    const initial = replaceTenant(source, options.tenantId || 'synthetic-ncsc-tenant');
    const frameworks = [{ moduleId: 'cyber_security', profileId: ACCEPTED_PROFILE_REF.profileId,
        version: ACCEPTED_PROFILE_REF.profileVersion }];
    const product = initial.entitlementState.grants.find(grant => grant.grantId === 'synthetic-product');
    product.frameworks = clone(frameworks);
    product.limits.assessment_runs = options.capacity ?? 2;
    if (options.grantEndsAt) product.validUntil = options.grantEndsAt;
    if (options.serviceEndsAt) initial.entitlementState.grants.find(grant => grant.code === 'fractional_advisory').validUntil = options.serviceEndsAt;
    initial.flags.frameworks = clone(frameworks);
    if (options.withAdvisor && !Object.keys(initial.advisorAssignments).length) {
        initial.advisorAssignments = replaceTenant(dashboardFixture({ now, role: 'fractional_advisor',
            organisationId: initial.scope.organisationId }).advisorAssignments, initial.scope.tenantId);
    }
    for (const assignment of Object.values(initial.advisorAssignments)) assignment.permissions = ['assessment.read', 'assessment.write'];
    for (const grant of initial.entitlementState.grants) {
        grant.modules.sort(); grant.coverage.sort(); grant.actions.sort();
        grant.frameworks.sort((a, b) => a.moduleId < b.moduleId ? -1 : 1);
    }
    initial.entitlementState.grants.sort((a, b) => a.grantId < b.grantId ? -1 : 1);
    const state = { tenantAggregate: initial.tenantAggregate, membershipState: initial.membershipState,
        entitlementState: initial.entitlementState, flags: initial.flags,
        advisorAssignments: Object.values(initial.advisorAssignments) };
    return { scope: initial.scope, state, subjectKey: SUBJECT, now };
}
function replaceTenant(value, tenantId) {
    if (Array.isArray(value)) return value.map(item => replaceTenant(item, tenantId));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
        .map(([key, item]) => [key, key === 'tenantId' ? tenantId : replaceTenant(item, tenantId)]));
    return value;
}
function createClock(at = NOW) {
    let current = at;
    return { now: () => current, set: value => { current = value; },
        advance: milliseconds => { current = new Date(Date.parse(current) + milliseconds).toISOString(); return current; } };
}
async function createContext(scope, clock, subjectKey = SUBJECT) {
    return createTenantRequestContext({ authenticate: async () => ({ authenticated: true, subjectKey }),
        resolveScope: async () => ({ ...scope }), clock: clock.now,
        createRequestId: () => crypto.randomUUID() }).resolve({ synthetic: true });
}
function createNcscAdapters(clock, options = {}) {
    const events = [], policySelections = [];
    const audit = createDashboardAudit({ clock: clock.now, createEventId: () => crypto.randomUUID(),
        writeEvent: options.writeEvent || (async event => { events.push(clone(event)); }) });
    function resolveSubmissionQuota(selection) {
        policySelections.push(clone(selection));
        // Explicit test policy: one run, fixed revision, finite validity interval.
        return { schemaVersion: 1, tenantId: selection.tenantId, organisationId: selection.organisationId,
            productGrantId: selection.productGrantId, agreementRef: selection.agreementRef,
            moduleId: 'cyber_security', profileRef: clone(ACCEPTED_PROFILE_REF),
            policyId: 'synthetic-ncsc-policy', policyRevision: 1,
            validFrom: options.validFrom || '2026-09-01T00:00:00.000Z',
            validUntil: options.validUntil || '2027-01-01T00:00:00.000Z',
            limit: 'assessment_runs', amount: options.amount ?? 1 };
    }
    return { audit, resolveSubmissionQuota, events, policySelections };
}
function initialiseNcsc(repository, example, operationId = 'bootstrap-ncsc') {
    return repository.initialiseOrganisation({ ...example.scope, operationId, actorSubjectKey: SUBJECT,
        type: 'organisation.initialise', expectedRevisions: clone(EMPTY_REVISIONS), payload: {} }, clone(example.state));
}
function allResponses(optionId = 'yes') {
    return acceptedProfile.questions.map(({ id }) => ({ itemId: id, optionId,
        rationale: optionId === 'not_applicable' ? { text: 'Synthetic claim awaiting independent review.' } : null }));
}
function createCommand(assessmentId = 'assessment-a', idempotencyKey = 'create-a', description = 'Synthetic office and cloud services.') {
    return { assessmentId, action: 'create', idempotencyKey, expectedRevision: null, payload: { scopePopulation: { description } } };
}
function saveCommand(assessmentId = 'assessment-a', expectedRevision = 0, idempotencyKey = 'save-a', responses = allResponses()) {
    return { assessmentId, action: 'save', idempotencyKey, expectedRevision, payload: { responses } };
}
function submitCommand(assessmentId = 'assessment-a', expectedRevision = 1, idempotencyKey = 'submit-a') {
    return { assessmentId, action: 'submit', idempotencyKey, expectedRevision, payload: {} };
}

module.exports = { ncscFixture, createClock, createContext, createNcscAdapters, initialiseNcsc,
    allResponses, createCommand, saveCommand, submitCommand, NOW, SUBJECT, EMPTY_REVISIONS, clone };
