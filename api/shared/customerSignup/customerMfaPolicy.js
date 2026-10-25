'use strict';

// Exact context candidate from dashboard-conditional-access-candidate.js.
// Keep that offline validator self-contained for its immutable-source digest;
// parity tests bind this runtime-only predicate to the same reviewed shape.
const { isDeepStrictEqual: equal } = require('node:util');
const CUSTOMER_MFA_POLICY = Object.freeze({
    id: '1bf6dbaa-b7f2-4571-a490-e6117f72b284',
    name: 'No Fries - Customer signup MFA context', context: 'c1'
});
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const absent = v => v === null || v === undefined;
const empty = v => absent(v) || equal(v, []);
const keys = (v, allowed) => object(v) && Object.keys(v).every(k => allowed.includes(k));

function isCustomerMfaPolicy(value, policyId, context) {
    if (policyId !== CUSTOMER_MFA_POLICY.id || context !== CUSTOMER_MFA_POLICY.context) return false;
    const p = object(value) ? value : {}, c = object(p.conditions) ? p.conditions : {};
    const u = object(c.users) ? c.users : {}, a = object(c.applications) ? c.applications : {};
    const g = object(p.grantControls) ? p.grantControls : {};
    return keys(value, ['@odata.context', 'id', 'displayName', 'description', 'state', 'createdDateTime',
        'modifiedDateTime', 'deletedDateTime', 'templateId', 'conditions', 'grantControls',
        'sessionControls', 'partialEnablementStrategy']) &&
        p.id === policyId && p.displayName === CUSTOMER_MFA_POLICY.name &&
        (absent(p.description) || typeof p.description === 'string') && p.state === 'enabled' &&
        absent(p.deletedDateTime) &&
        keys(p.conditions, ['users', 'applications', 'clientAppTypes', 'platforms', 'locations', 'devices',
            'deviceStates', 'clientApplications', 'authenticationFlows', 'signInRiskLevels', 'userRiskLevels',
            'servicePrincipalRiskLevels', 'insiderRiskLevels', 'agents', 'times']) &&
        keys(c.users, ['includeUsers', 'excludeUsers', 'includeGroups', 'excludeGroups', 'includeRoles',
            'excludeRoles', 'includeGuestsOrExternalUsers', 'excludeGuestsOrExternalUsers']) &&
        equal(u.includeUsers, ['All']) &&
        ['excludeUsers', 'excludeGroups', 'excludeRoles'].every(k => equal(u[k], [])) &&
        ['includeGroups', 'includeRoles'].every(k => empty(u[k])) &&
        absent(u.includeGuestsOrExternalUsers) && absent(u.excludeGuestsOrExternalUsers) &&
        keys(c.applications, ['includeApplications', 'excludeApplications', 'includeUserActions',
            'includeAuthenticationContextClassReferences', 'applicationFilter', 'includeAgentActions']) &&
        equal(a.includeApplications, []) && equal(a.excludeApplications, []) &&
        equal(a.includeAuthenticationContextClassReferences, [context]) && equal(a.includeUserActions, []) &&
        empty(a.includeAgentActions) && absent(a.applicationFilter) &&
        equal(c.clientAppTypes, ['all']) && absent(c.authenticationFlows) &&
        ['platforms', 'locations', 'devices', 'deviceStates', 'clientApplications', 'agents', 'times']
            .every(k => absent(c[k])) && absent(c.insiderRiskLevels) &&
        ['signInRiskLevels', 'userRiskLevels', 'servicePrincipalRiskLevels'].every(k => equal(c[k], [])) &&
        keys(p.grantControls, ['operator', 'builtInControls', 'customAuthenticationFactors', 'termsOfUse',
            'authenticationStrength', 'authenticationStrength@odata.context']) &&
        g.operator === 'OR' && equal(g.builtInControls, ['mfa']) && empty(g.customAuthenticationFactors) &&
        empty(g.termsOfUse) && absent(g.authenticationStrength) &&
        (absent(p.sessionControls) || equal(p.sessionControls, {})) && absent(p.partialEnablementStrategy);
}

module.exports = { CUSTOMER_MFA_POLICY, isCustomerMfaPolicy };
