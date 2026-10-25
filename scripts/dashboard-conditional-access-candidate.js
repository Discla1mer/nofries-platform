'use strict';

// Offline, read-only inspection of the four existing candidates in the plan.
// No Azure SDK, network calls, credentials, policy writes or cutover authority.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isDeepStrictEqual: equal } = require('node:util');
const CANDIDATES = Object.freeze([
    { id: '163381d1-21f1-4527-bcde-ae6cc6c81667', name: 'No Fries - Require MFA for all users', kind: 'baseline' },
    { id: '8b4d925f-b907-41d7-a1c3-9d1acfd7a44d', name: 'No Fries - Block legacy authentication', kind: 'legacy' },
    { id: 'b11e901c-6ad5-41d5-af78-79630406726e', name: 'No Fries - Block device code flow', kind: 'device' },
    { id: '1bf6dbaa-b7f2-4571-a490-e6117f72b284', name: 'No Fries - Customer signup MFA context', kind: 'context' }
].map(Object.freeze));
const STATES = ['enabledForReportingButNotEnforced', 'enabled', 'disabled'];
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const absent = v => v === null || v === undefined;
const empty = v => absent(v) || equal(v, []);
const keys = (v, allowed) => object(v) && Object.keys(v).every(k => allowed.includes(k));
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function criteria(value, candidate, state) {
    if (!STATES.includes(state) || !CANDIDATES.includes(candidate)) throw new Error('candidate_arguments_invalid');
    const p = object(value) ? value : {}, c = object(p.conditions) ? p.conditions : {};
    const u = object(c.users) ? c.users : {}, a = object(c.applications) ? c.applications : {};
    const g = object(p.grantControls) ? p.grantControls : {};
    const context = candidate.kind === 'context';
    return {
        policy_shape: keys(value, ['@odata.context', 'id', 'displayName', 'description', 'state', 'createdDateTime',
            'modifiedDateTime', 'deletedDateTime', 'templateId', 'conditions', 'grantControls',
            'sessionControls', 'partialEnablementStrategy']),
        identity: p.id === candidate.id && p.displayName === candidate.name,
        description_metadata: absent(p.description) || typeof p.description === 'string',
        state: p.state === state,
        not_deleted: absent(p.deletedDateTime),
        condition_keys: keys(p.conditions, ['users', 'applications', 'clientAppTypes', 'platforms',
            'locations', 'devices', 'deviceStates', 'clientApplications', 'authenticationFlows',
            'signInRiskLevels', 'userRiskLevels', 'servicePrincipalRiskLevels', 'insiderRiskLevels', 'agents', 'times']),
        user_keys: keys(c.users, ['includeUsers', 'excludeUsers', 'includeGroups', 'excludeGroups',
            'includeRoles', 'excludeRoles', 'includeGuestsOrExternalUsers', 'excludeGuestsOrExternalUsers']),
        all_users: equal(u.includeUsers, ['All']),
        no_exclusions: ['excludeUsers', 'excludeGroups', 'excludeRoles'].every(k => equal(u[k], [])),
        no_other_identity_scope: ['includeGroups', 'includeRoles'].every(k => empty(u[k])) &&
            absent(u.includeGuestsOrExternalUsers) && absent(u.excludeGuestsOrExternalUsers),
        application_keys: keys(c.applications, ['includeApplications', 'excludeApplications',
            'includeUserActions', 'includeAuthenticationContextClassReferences', 'applicationFilter', 'includeAgentActions']),
        application_target: equal(a.includeApplications, context ? [] : ['All']) &&
            equal(a.excludeApplications, []) &&
            (context ? equal(a.includeAuthenticationContextClassReferences, ['c1']) : empty(a.includeAuthenticationContextClassReferences)) &&
            (context ? equal(a.includeUserActions, []) : empty(a.includeUserActions)) &&
            empty(a.includeAgentActions) && absent(a.applicationFilter),
        clients: equal(c.clientAppTypes, candidate.kind === 'legacy' ? ['exchangeActiveSync', 'other'] : ['all']),
        authentication_flow: candidate.kind === 'device' ? equal(c.authenticationFlows, { transferMethods: 'deviceCodeFlow' }) : absent(c.authenticationFlows),
        no_narrowing: ['platforms', 'locations', 'devices', 'deviceStates', 'clientApplications', 'agents', 'times'].every(k => absent(c[k])),
        no_insider_risk_condition: absent(c.insiderRiskLevels),
        no_risk_conditions: ['signInRiskLevels', 'userRiskLevels', 'servicePrincipalRiskLevels'].every(k => equal(c[k], [])),
        grant_keys: keys(p.grantControls, ['operator', 'builtInControls', 'customAuthenticationFactors',
            'termsOfUse', 'authenticationStrength', 'authenticationStrength@odata.context']),
        exact_grant: g.operator === 'OR' && equal(g.builtInControls, ['legacy', 'device'].includes(candidate.kind) ? ['block'] : ['mfa']) &&
            empty(g.customAuthenticationFactors) && empty(g.termsOfUse) && absent(g.authenticationStrength),
        no_session_controls: absent(p.sessionControls) || equal(p.sessionControls, {}),
        no_partial_rollout: absent(p.partialEnablementStrategy)
    };
}

function inspect(directory, state) {
    if (typeof directory !== 'string' || !STATES.includes(state)) throw new Error('candidate_arguments_invalid');
    const policies = CANDIDATES.map(candidate => {
        let fd;
        try {
            fd = fs.openSync(path.join(directory, candidate.id + '.json'), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
            const stat = fs.fstatSync(fd);
            if (!stat.isFile() || stat.size < 2 || stat.size > 65536) throw new Error();
            const bytes = fs.readFileSync(fd);
            if (bytes.length > 65536) throw new Error();
            const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
            const checks = criteria(value, candidate, state);
            return { id: candidate.id, sha256: digest(bytes), criteria: checks, passed: Object.values(checks).every(Boolean) };
        } catch (_) {
            return { id: candidate.id, passed: false, code: 'candidate_unreadable_or_invalid' };
        } finally { if (fd !== undefined) fs.closeSync(fd); }
    });
    return { schemaVersion: 1, expectedState: state,
        policies, passed: policies.every(p => p.passed) };
}

if (require.main === module) {
    process.stderr.write('{"code":"candidate_verified_loader_required"}\n');
    process.exitCode = 1;
}
module.exports = { CANDIDATES, criteria, inspect };
