'use strict';
const { CANDIDATES, criteria } = require('../scripts/dashboard-conditional-access-candidate');
const { CUSTOMER_MFA_POLICY, isCustomerMfaPolicy } = require('../api/shared/customerSignup/customerMfaPolicy');
const { createEntraCustomerGraph } = require('../api/shared/customerSignup/entraCustomerGraph');
const candidate = CANDIDATES.find(c => c.kind === 'context');
function fixture() {
    return { id: candidate.id, displayName: candidate.name, state: 'enabled',
        conditions: { signInRiskLevels: [], userRiskLevels: [], servicePrincipalRiskLevels: [],
            users: { includeUsers: ['All'], excludeUsers: [], excludeGroups: [], excludeRoles: [] },
            applications: { includeApplications: [], excludeApplications: [],
                includeAuthenticationContextClassReferences: ['c1'], includeUserActions: [] }, clientAppTypes: ['all'] },
        grantControls: { operator: 'OR', builtInControls: ['mfa'] } };
}
const runtime = p => isCustomerMfaPolicy(p, candidate.id, 'c1');
const offline = p => Object.values(criteria(p, candidate, 'enabled')).every(Boolean);
test('runtime identity and context match the existing reviewed context candidate', () => {
    expect(CUSTOMER_MFA_POLICY).toEqual({ id: candidate.id, name: candidate.name, context: 'c1' });
    expect(runtime(fixture())).toBe(true);
    expect(isCustomerMfaPolicy(fixture(), '00000000-0000-4000-8000-000000000000', 'c1')).toBe(false);
    expect(isCustomerMfaPolicy(fixture(), candidate.id, 'c2')).toBe(false);
});
const invalid = [
    ['AND with device', p => { p.grantControls.operator = 'AND'; p.grantControls.builtInControls.push('compliantDevice'); }],
    ['AND with MFA', p => p.grantControls.operator = 'AND'],
    ['extra OR grant', p => p.grantControls.builtInControls.push('compliantDevice')],
    ['missing MFA', p => p.grantControls.builtInControls = []],
    ['extra context', p => p.conditions.applications.includeAuthenticationContextClassReferences.push('c2')],
    ['session control', p => p.sessionControls = { signInFrequency: { value: 1 } }],
    ['malformed session controls', p => p.sessionControls = []],
    ['partial rollout', p => p.partialEnablementStrategy = {}],
    ['custom grant', p => p.grantControls.customAuthenticationFactors = ['unreviewed']],
    ['terms grant', p => p.grantControls.termsOfUse = ['unreviewed']],
    ['authentication strength', p => p.grantControls.authenticationStrength = {}],
    ['unknown grant', p => p.grantControls.futureGrant = null],
    ['report only', p => p.state = 'enabledForReportingButNotEnforced'],
    ['disabled', p => p.state = 'disabled'],
    ['deleted', p => p.deletedDateTime = '2026-01-01T00:00:00Z'],
    ['wrong ID', p => p.id = '00000000-0000-4000-8000-000000000000'],
    ['wrong name', p => p.displayName = 'Another policy'],
    ['unknown root control', p => p.futureScope = null],
    ['malformed description', p => p.description = {}],
    ['excluded user', p => p.conditions.users.excludeUsers.push('unreviewed')],
    ['missing exclusions', p => delete p.conditions.users.excludeGroups],
    ['included group', p => p.conditions.users.includeGroups = ['unreviewed']],
    ['included role', p => p.conditions.users.includeRoles = ['unreviewed']],
    ['guest exclusion', p => p.conditions.users.excludeGuestsOrExternalUsers = {}],
    ['guest inclusion', p => p.conditions.users.includeGuestsOrExternalUsers = {}],
    ['unknown user control', p => p.conditions.users.futureScope = null],
    ['extra user', p => p.conditions.users.includeUsers.push('unreviewed')],
    ['included resource', p => p.conditions.applications.includeApplications = ['All']],
    ['excluded resource', p => p.conditions.applications.excludeApplications.push('unreviewed')],
    ['missing included resources', p => delete p.conditions.applications.includeApplications],
    ['missing user actions', p => delete p.conditions.applications.includeUserActions],
    ['application filter', p => p.conditions.applications.applicationFilter = {}],
    ['agent action', p => p.conditions.applications.includeAgentActions = ['unreviewed']],
    ['user action', p => p.conditions.applications.includeUserActions.push('unreviewed')],
    ['unknown application control', p => p.conditions.applications.futureScope = []],
    ['authentication flow', p => p.conditions.authenticationFlows = {}],
    ['unknown condition', p => p.conditions.futureScope = null],
    ['different clients', p => p.conditions.clientAppTypes = ['browser']],
    ...['platforms', 'locations', 'devices', 'deviceStates', 'clientApplications', 'agents', 'times', 'insiderRiskLevels']
        .map(key => [key + ' control', p => p.conditions[key] = {}]),
    ...['signInRiskLevels', 'userRiskLevels', 'servicePrincipalRiskLevels'].flatMap(key =>
        [undefined, null, {}, '', ['high']].map(value => [key + ' nonempty or missing', p => p.conditions[key] = value]))
];
test.each(invalid)('runtime and immutable candidate both reject %s', async (_, change) => {
    const p = fixture(); change(p);
    expect(offline(p)).toBe(false); expect(runtime(p)).toBe(false);
    const fetch = jest.fn(async () => new Response(JSON.stringify(p)));
    const graph = createEntraCustomerGraph({ policyId: candidate.id, credential: { getToken: async () => ({ token: 'synthetic' }) }, fetch });
    await expect(graph.verifyMfaPolicy('c1')).resolves.toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1].method).toBe('GET');
});
test.each([undefined, null, [], {}, '', 42, { conditions: [] }, { grantControls: [] }])
    ('runtime and candidate reject malformed policy %#', p => {
        expect(offline(p)).toBe(false); expect(runtime(p)).toBe(false);
    });
test.each([undefined, null, []])('preserves permitted absent/null/empty Graph arrays %#', value => {
    const p = fixture();
    p.conditions.users.includeGroups = value; p.conditions.users.includeRoles = value;
    p.conditions.applications.includeAgentActions = value;
    p.grantControls.customAuthenticationFactors = value; p.grantControls.termsOfUse = value;
    expect(offline(p)).toBe(true); expect(runtime(p)).toBe(true);
});
test.each([undefined, null])('preserves permitted absent/null Graph controls %#', value => {
    const p = fixture();
    p.description = value; p.deletedDateTime = value; p.partialEnablementStrategy = value;
    p.conditions.users.includeGuestsOrExternalUsers = value; p.conditions.users.excludeGuestsOrExternalUsers = value;
    p.conditions.applications.applicationFilter = value;
    for (const key of ['platforms', 'locations', 'devices', 'deviceStates', 'clientApplications', 'authenticationFlows',
        'agents', 'times', 'insiderRiskLevels']) p.conditions[key] = value;
    p.grantControls.authenticationStrength = value; p.sessionControls = value;
    expect(offline(p)).toBe(true); expect(runtime(p)).toBe(true);
});
test('accepts exact enabled Graph-normalized shape and inert descriptive metadata', async () => {
    const p = fixture();
    Object.assign(p, { '@odata.context': 'synthetic-metadata', description: 'Synthetic descriptive metadata',
        createdDateTime: '2026-01-01T00:00:00Z', modifiedDateTime: null, templateId: null, sessionControls: {} });
    p.grantControls['authenticationStrength@odata.context'] = 'synthetic-metadata';
    expect(offline(p)).toBe(true); expect(runtime(p)).toBe(true);
    const graph = createEntraCustomerGraph({ policyId: candidate.id, credential: { getToken: async () => ({ token: 'synthetic' }) },
        fetch: async () => new Response(JSON.stringify(p)) });
    await expect(graph.verifyMfaPolicy('c1')).resolves.toBe(true);
});
