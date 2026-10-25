'use strict';

// Fixed read-event metadata and value codecs. SQL and current authority belong
// to each owning runtime transaction, never to this shared pure module.
const { DashboardOnboardingError } = require('./dashboardOnboardingDomain');
const { copy, fields, freeze, uuid, digest, instant, scope, subject } = require('./dashboardRuntimeRecords');

const MAX_EVENT = 16384;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const invalid = () => { throw new DashboardOnboardingError('onboarding_input_invalid', 400); };
const MODULE_KEYS = Object.freeze(['overview', 'ai_governance', 'cyber_security', 'it_optimisation',
    'improvement_plan', 'evidence', 'board_reports', 'services']);

const RUNTIME_READ_RESOURCES = freeze({
    readSession: ['session'],
    discoverBindings: ['binding'],
    readOnboardingStatus: ['case'],
    readDashboardAdmission: MODULE_KEYS.map(key => 'module:' + key),
    readDashboardBootstrap: ['bootstrap'],
    readDashboardAsset: ['asset:app.js', 'asset:dashboard.css'],
    readDashboardReadiness: ['readiness']
});

const HOST_ROUTES = freeze({
    bootstrap: { route: 'bootstrap', action: 'readDashboardBootstrap', resourceKey: 'bootstrap', moduleKey: null, requiresGeneration: true },
    'app.js': { route: 'app.js', action: 'readDashboardAsset', resourceKey: 'asset:app.js', moduleKey: null, requiresGeneration: false },
    'dashboard.css': { route: 'dashboard.css', action: 'readDashboardAsset', resourceKey: 'asset:dashboard.css', moduleKey: null, requiresGeneration: false },
    ...Object.fromEntries(MODULE_KEYS.map(key => ['modules/' + key,
        { route: 'modules/' + key, action: 'readDashboardAdmission', resourceKey: 'module:' + key, moduleKey: key, requiresGeneration: true }]))
});

function hostResourceForRoute(route) {
    if (typeof route !== 'string' || !own(HOST_ROUTES, route)) invalid();
    return HOST_ROUTES[route];
}

function readPair(value) {
    if (typeof value.action !== 'string' || typeof value.resourceKey !== 'string' || typeof value.outcome !== 'string' ||
        !own(RUNTIME_READ_RESOURCES, value.action) || !RUNTIME_READ_RESOURCES[value.action].includes(value.resourceKey) ||
        !['succeeded', 'denied', 'failed'].includes(value.outcome) || value.operationId !== null) invalid();
}

function normaliseRuntimeReadEventInput(value) {
    const input = fields(copy(value, MAX_EVENT), ['eventId', 'action', 'outcome', 'resourceKey', 'operationId']);
    uuid(input.eventId); readPair(input);
    return freeze(input);
}

function normaliseRuntimeReadAudit(value) {
    const envelope = fields(copy(value, MAX_EVENT), ['sessionSha256', 'instanceId', 'authorityId', 'event']);
    if (envelope.sessionSha256 !== null) digest(envelope.sessionSha256);
    uuid(envelope.instanceId);
    if (envelope.authorityId !== null) uuid(envelope.authorityId);
    const event = fields(envelope.event, ['schemaVersion', 'eventType', 'eventId', 'requestId', 'occurredAt',
        'actorSubjectKey', 'scope', 'action', 'outcome', 'resourceKey', 'operationId']);
    if (event.schemaVersion !== 1 || event.eventType !== 'dashboard.runtime') invalid();
    uuid(event.eventId); uuid(event.requestId); instant(event.occurredAt); subject(event.actorSubjectKey);
    if (event.scope !== null) scope(event.scope);
    readPair(event);
    return freeze(envelope);
}

module.exports = Object.freeze({ RUNTIME_READ_RESOURCES, hostResourceForRoute,
    normaliseRuntimeReadEventInput, normaliseRuntimeReadAudit });
