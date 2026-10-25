'use strict';

const { createTenantAggregate } = require('../../api/shared/appLifecycle/tenantDomain');
const { createFrameworkRegistry, calculateFrameworkProfileSha256 } = require('../../api/shared/assessmentEngine/frameworkProfileRegistry');
const definition = require('./syntheticFrameworkProfile.json');
const { createAssessment, applyAssessmentCommand } = require('../../api/shared/assessmentLifecycle/assessmentDomain');

const ACTOR = '10000000-0000-4000-8000-000000000000:10000000-0000-4000-8000-000000000001';
const OTHER_ACTOR = '10000000-0000-4000-8000-000000000000:10000000-0000-4000-8000-000000000002';
const NOW = '2026-09-06T00:00:00.000Z';
const LATER = '2026-09-06T01:00:00.000Z';
const SCOPE = { tenantId: 'tenant-a', organisationId: 'org-a', assessmentId: 'assessment-a' };
const clone = value => JSON.parse(JSON.stringify(value));
function fixture() {
    const profile = clone(definition);
    profile.responseOptions.push({ id: 'unknown', label: 'Unknown', applicable: true, implementationFactor: null });
    profile.questions.forEach(row => {
        row.responseOptionIds.push('unknown');
        row.weight *= 4; // Preserve proportions using evaluator-compatible integer weights.
    });
    profile.catalogueSha256 = calculateFrameworkProfileSha256(profile);
    const registry = createFrameworkRegistry([profile]);
    return { profile, registry, aggregate: tenant() };
}
function tenant(tenantId = SCOPE.tenantId) {
    return createTenantAggregate({ tenant: { tenantId, displayName: 'Synthetic tenant' },
        organisations: ['org-a', 'org-b'].map(organisationId => ({ tenantId, organisationId, displayName: 'Synthetic organisation' })) });
}
function reference(profile) {
    return { frameworkId: profile.framework.id, frameworkVersion: profile.framework.version,
        profileId: profile.profile.id, profileVersion: profile.profile.version, catalogueSha256: profile.catalogueSha256,
        ...(profile.sourceCatalogueSha256 ? { sourceCatalogueSha256: profile.sourceCatalogueSha256 } : {}) };
}
function creation(profile, overrides = {}) {
    return { ...SCOPE, action: 'create', payload: { moduleId: 'module-a', profileRef: reference(profile),
        scopePopulationSha256: 'a'.repeat(64) }, expectedRevision: null, actorSubjectKey: ACTOR,
        now: NOW, idempotencyKey: 'create-a', ...overrides };
}
function command(state, action, payload = {}, overrides = {}) {
    return { tenantId: state.tenantId, organisationId: state.organisationId, assessmentId: state.assessmentId,
        action, payload, expectedRevision: state.revision, actorSubjectKey: ACTOR, now: LATER,
        idempotencyKey: `${action}-${state.revision}`, ...overrides };
}
function response(itemId = 'SYN-Q-01', optionId = 'met', applicabilityRationaleSha256 = null) {
    return { itemId, optionId, applicabilityRationaleSha256 };
}
function created(f = fixture()) { return createAssessment(f.aggregate, creation(f.profile), f.registry); }
function act(f, state, action, payload = {}, overrides = {}) {
    return applyAssessmentCommand(state, f.aggregate, command(state, action, payload, overrides), f.registry);
}
function answered(f, state = created(f)) {
    return act(f, state, 'save', { responses: f.profile.questions.map(row => response(row.id)) });
}

module.exports = { ACTOR, OTHER_ACTOR, NOW, LATER, SCOPE, clone, fixture, tenant,
    reference, creation, command, response, created, act, answered };
