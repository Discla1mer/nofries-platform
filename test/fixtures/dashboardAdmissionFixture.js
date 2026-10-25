'use strict';

const { fixture, NOW, SUBJECT } = require('./dashboardFixture');

// Synthetic trusted-adapter harness. Never imported by runtime composition.
function admissionFixture(options = {}) {
    const input = JSON.parse(JSON.stringify(fixture(options)));
    const state = { input, authenticated: true, subjectKey: SUBJECT, now: NOW,
        scope: { ...input.scope }, calls: [] };
    const adapters = {
        authenticate: async () => {
            state.calls.push('authenticate');
            return { authenticated: state.authenticated, subjectKey: state.subjectKey };
        },
        resolveScope: async (request, principal) => {
            state.calls.push('resolveScope');
            if (!Object.isFrozen(principal)) throw new Error('mutable principal');
            return state.scope;
        },
        loadSnapshot: async (scope, principal) => {
            state.calls.push('loadSnapshot');
            if (!Object.isFrozen(scope) || !Object.isFrozen(principal)) throw new Error('mutable selection');
            const { tenantAggregate, membershipState, entitlementState, flags, advisorAssignments, summary } = state.input;
            return { tenantAggregate, membershipState, entitlementState, flags, advisorAssignments, summary: summary ?? null };
        },
        clock: () => { state.calls.push('clock'); return state.now; }
    };
    return { state, adapters };
}

module.exports = { admissionFixture, NOW, SUBJECT };
