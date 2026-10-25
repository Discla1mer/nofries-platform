'use strict';

const assert = require('node:assert/strict');
// Both repository Jest and dependency-free node --test execute this contract.
const test = global.test || require('node:test');
const { createTenantAggregate, transitionTenant, transitionOrganisation } = require('../api/shared/appLifecycle/tenantDomain');
const { createMembershipState, applyMembershipCommand } = require('../api/shared/appLifecycle/membershipDomain');
const { PortalPermissionError, PERMISSIONS, ROLE_PERMISSIONS, normaliseAdvisorAssignment,
    resolvePortalPermission, createPortalPermissionGuard } = require('../api/shared/appLifecycle/portalPermissions');

const ADMIN = '10000000-0000-4000-8000-000000000000:10000000-0000-4000-8000-000000000001';
const ALICE = '20000000-0000-4000-8000-000000000000:20000000-0000-4000-8000-000000000001';
const BOB = '20000000-0000-4000-8000-000000000000:20000000-0000-4000-8000-000000000002';
const START = '2026-09-05T00:00:00.000Z';
const ACCEPT = '2026-09-05T01:00:00.000Z';
const NOW = '2026-09-06T00:00:00.000Z';
const ASSIGN_END = '2026-09-08T00:00:00.000Z';
const END = '2027-09-05T00:00:00.000Z';
const SCOPE = { tenantId: 'tenant-a', organisationId: 'org-1' };
const clone = value => JSON.parse(JSON.stringify(value));
const tenant = (tenantId = SCOPE.tenantId) => createTenantAggregate({
    tenant: { tenantId, displayName: 'Synthetic workspace' },
    organisations: [{ tenantId, organisationId: 'org-1', displayName: 'Synthetic one' },
        { tenantId, organisationId: 'org-2', displayName: 'Synthetic two' }]
});
function membership(roles = ['viewer'], { aggregate = tenant(), scope = SCOPE, subjectKey = ALICE,
    validFrom = START, validUntil = END } = {}) {
    let state = createMembershipState(aggregate, scope, START);
    state = applyMembershipCommand(state, aggregate, { ...scope, expectedRevision: 0,
        actorSubjectKey: ADMIN, now: START, action: 'invite', payload: {
            invitationId: 'invite-1', subjectKey, roles, validFrom, validUntil,
            grantEvidenceId: 'grant-1', expiresAt: '2026-09-07T00:00:00.000Z'
        } });
    return applyMembershipCommand(state, aggregate, { ...scope, expectedRevision: 1,
        actorSubjectKey: subjectKey, now: ACCEPT, action: 'accept',
        payload: { invitationId: 'invite-1', membershipId: 'member-1' } });
}
const assignment = overrides => ({ schemaVersion: 1, assignmentId: 'assignment-1', ...SCOPE,
    membershipId: 'member-1', subjectKey: ALICE, status: 'active', validFrom: ACCEPT,
    validUntil: ASSIGN_END, modules: ['cyber_security'], permissions: ['assessment.read'],
    grantEvidenceId: 'advisor-grant-1', revision: 0, updatedAt: ACCEPT, ...overrides });
const selector = overrides => ({ ...SCOPE, subjectKey: ALICE, permission: 'overview.read',
    module: 'overview', ...overrides });
const resolve = (state, overrides, advisorAssignment = null, now = NOW, aggregate = tenant()) =>
    resolvePortalPermission(state, aggregate, selector(overrides), advisorAssignment, now);
function isDenied(error) {
    assert.ok(error instanceof PortalPermissionError);
    assert.equal(error.statusCode, 403);
    assert.equal(error.code, 'portal_permission_denied');
    assert.equal(error.message, 'portal_permission_denied');
    assert.ok(!JSON.stringify(error).includes(ALICE));
    assert.ok(!JSON.stringify(error).includes('private-upstream-detail'));
    return true;
}
const denies = operation => assert.throws(operation, isDenied);
const deniesAsync = operation => assert.rejects(operation, isDenied);

// Policy expectations are explicit: changing exported tables cannot silently
// change the acceptance contract for viewer, editor and administrator access.
const PERMISSION_MODULES = {
    'overview.read': ['overview'],
    'assessment.read': ['cyber_security', 'ai_governance', 'it_optimisation'],
    'assessment.write': ['cyber_security', 'ai_governance', 'it_optimisation'],
    'improvement.read': ['improvement_plan'], 'improvement.write': ['improvement_plan'],
    'decision.read': ['improvement_plan'], 'decision.write': ['improvement_plan'],
    'decision.approve': ['improvement_plan'],
    'evidence.read': ['evidence'], 'evidence.link': ['evidence'], 'evidence.review': ['evidence'],
    'report.read_issued': ['board_reports'], 'report.read_draft': ['board_reports'],
    'report.draft': ['board_reports'], 'report.approve': ['board_reports'],
    'services.read': ['services'], 'membership.manage': ['overview'], 'advisor.manage': ['overview']
};
const VIEWER = ['overview.read', 'services.read', 'report.read_issued'];
const EDITOR = [...VIEWER, 'assessment.read', 'assessment.write', 'improvement.read',
    'improvement.write', 'decision.read', 'decision.write', 'evidence.read', 'evidence.link',
    'report.read_draft', 'report.draft'];

for (const [role, granted] of [['viewer', VIEWER], ['editor', EDITOR], ['admin', Object.keys(PERMISSION_MODULES)]]) {
    test(`${role} enforces its complete portal permission boundary`, () => {
        const state = membership([role]);
        for (const [permission, modules] of Object.entries(PERMISSION_MODULES)) {
            for (const module of modules) {
                if (granted.includes(permission)) {
                    const decision = resolve(state, { permission, module });
                    assert.equal(decision.role, role);
                    assert.equal(decision.assignmentId, null);
                } else denies(() => resolve(state, { permission, module }));
            }
        }
    });
}

test('permission results identify the current membership and scope without mutating inputs', () => {
    const state = membership(), aggregate = tenant(), query = selector(), advisorAssignment = null;
    const before = JSON.stringify([state, aggregate, query, advisorAssignment]);
    const decision = resolvePortalPermission(state, aggregate, query, advisorAssignment, NOW);
    for (const [key, value] of Object.entries({ ...SCOPE, permission: 'overview.read', module: 'overview',
        membershipId: 'member-1', membershipRevision: state.revision, role: 'viewer', assignmentId: null })) {
        assert.equal(decision[key], value);
    }
    assert.ok(Object.isFrozen(decision));
    assert.equal(JSON.stringify([state, aggregate, query, advisorAssignment]), before);
    assert.ok(Object.isFrozen(PERMISSIONS));
    assert.ok(Object.values(PERMISSIONS).every(Object.isFrozen));
    assert.ok(Object.isFrozen(ROLE_PERMISSIONS));
    assert.ok(Object.values(ROLE_PERMISSIONS).every(Object.isFrozen));
});

test('even administrators cannot use an unknown permission, module or mismatched permission-module pair', () => {
    const state = membership(['admin']);
    for (const overrides of [{ permission: '*' }, { permission: 'assessment.delete' },
        { module: 'billing' }, { permission: 'assessment.read', module: 'evidence' },
        { permission: 'membership.manage', module: 'board_reports' },
        { permission: 'report.read_issued', module: 'overview' }]) {
        denies(() => resolve(state, overrides));
    }
});

test('selector requires exactly the trusted subject, scope and requested capability', () => {
    const state = membership(['admin']);
    const queries = [null, [], { ...selector(), roles: ['admin'] }, { ...selector(), assignmentId: 'forged' },
        { ...selector(), subjectKey: 'alice@example.test' }, { ...selector(), tenantId: ' tenant-a' }];
    for (const key of Object.keys(selector())) {
        const incomplete = selector();
        delete incomplete[key];
        queries.push(incomplete);
    }
    for (const query of queries) denies(() => resolvePortalPermission(state, tenant(), query, null, NOW));
});

test('same local member and organisation IDs in another tenant never transfer authority', () => {
    const scopeB = { ...SCOPE, tenantId: 'tenant-b' }, aggregateB = tenant('tenant-b');
    const stateA = membership(['admin']);
    const stateB = membership(['viewer'], { aggregate: aggregateB, scope: scopeB, subjectKey: BOB });
    assert.equal(resolve(stateB, { ...scopeB, subjectKey: BOB }, null, NOW, aggregateB).role, 'viewer');
    denies(() => resolve(stateA, scopeB, null, NOW, aggregateB));
    denies(() => resolve(stateB, { ...scopeB, subjectKey: ALICE }, null, NOW, aggregateB));
    denies(() => resolve(stateA, { organisationId: 'org-2' }));
});

test('missing, wrong-subject and malformed membership state produce the same safe denial', () => {
    const state = membership(), malformed = clone(state);
    malformed.memberships[0].roles = ['admin']; // Contradicts immutable invitation grant.
    const failures = [() => resolve(state, { subjectKey: BOB }), () => resolve(null),
        () => resolve(malformed), () => resolve(state, { tenantId: 'private-upstream-detail' })];
    const shapes = failures.map(operation => {
        try { operation(); assert.fail('expected denial'); } catch (error) {
            isDenied(error);
            return [error.name, error.statusCode, error.code, error.message, error.details];
        }
    });
    for (const shape of shapes) assert.deepEqual(shape, shapes[0]);
});

for (const action of ['suspend', 'remove']) {
    test(`${action} revokes normal and advisor permissions immediately`, () => {
        const original = membership(['admin', 'fractional_advisor']);
        const state = applyMembershipCommand(original, tenant(), { ...SCOPE,
            expectedRevision: original.revision, actorSubjectKey: ADMIN, now: NOW, action,
            payload: { membershipId: 'member-1' } });
        denies(() => resolve(state));
        denies(() => resolve(state, { permission: 'assessment.read', module: 'cyber_security' }, assignment()));
    });
}

for (const target of ['tenant', 'organisation']) {
    for (const status of ['suspended', 'closed']) {
        test(`${target} ${status} blocks all portal roles`, () => {
            const aggregate = clone(tenant());
            if (target === 'tenant') aggregate.tenant = transitionTenant(aggregate.tenant, { expectedRevision: 0, toStatus: status });
            else aggregate.organisations[0] = transitionOrganisation(aggregate.organisations[0], { expectedRevision: 0, toStatus: status });
            denies(() => resolve(membership(['admin']), {}, null, NOW, aggregate));
            denies(() => resolve(membership(['fractional_advisor']),
                { permission: 'assessment.read', module: 'cyber_security' }, assignment(), NOW, aggregate));
        });
    }
}

test('membership authority begins inclusively and expires exclusively', () => {
    const state = membership(['viewer'], { validFrom: NOW });
    denies(() => resolve(state, {}, null, ACCEPT));
    assert.equal(resolve(state).role, 'viewer');
    assert.equal(resolve(state, {}, null, '2027-09-04T23:59:59.999Z').role, 'viewer');
    denies(() => resolve(state, {}, null, END));
});

test('fractional advisor role alone grants no permission, including overview and issued reports', () => {
    const state = membership(['fractional_advisor']);
    for (const [permission, modules] of Object.entries(PERMISSION_MODULES)) {
        denies(() => resolve(state, { permission, module: modules[0] }));
    }
});

test('an explicit advisor assignment grants only its named capability and module', () => {
    const state = membership(['fractional_advisor']), grant = assignment();
    const decision = resolve(state, { permission: 'assessment.read', module: 'cyber_security' }, grant);
    assert.equal(decision.role, 'fractional_advisor');
    assert.equal(decision.assignmentId, 'assignment-1');
    denies(() => resolve(state, { permission: 'assessment.write', module: 'cyber_security' }, grant));
    denies(() => resolve(state, { permission: 'assessment.read', module: 'ai_governance' }, grant));
    denies(() => resolve(state, {}, grant));
});

test('advisor evidence review is explicit and cannot grant decision or report approval or access administration', () => {
    const state = membership(['fractional_advisor']);
    const review = assignment({ modules: ['evidence'], permissions: ['evidence.review'] });
    assert.equal(resolve(state, { permission: 'evidence.review', module: 'evidence' }, review).assignmentId, review.assignmentId);
    for (const permission of ['decision.approve', 'report.approve', 'membership.manage', 'advisor.manage']) {
        const grant = assignment({ permissions: [permission], modules: PERMISSION_MODULES[permission] });
        denies(() => normaliseAdvisorAssignment(grant));
        denies(() => resolve(state, { permission, module: PERMISSION_MODULES[permission][0] }, grant));
    }
});

test('assignment modules and permissions are never unioned across independent grants', () => {
    const state = membership(['fractional_advisor']);
    const grants = [assignment(), assignment({ assignmentId: 'assignment-2', modules: ['ai_governance'],
        permissions: ['assessment.write'] })];
    assert.equal(resolve(state, { permission: 'assessment.read', module: 'cyber_security' }, grants[0]).assignmentId, 'assignment-1');
    assert.equal(resolve(state, { permission: 'assessment.write', module: 'ai_governance' }, grants[1]).assignmentId, 'assignment-2');
    for (const candidate of grants) {
        denies(() => resolve(state, { permission: 'assessment.write', module: 'cyber_security' }, candidate));
        denies(() => resolve(state, { permission: 'assessment.read', module: 'ai_governance' }, candidate));
    }
    // The policy accepts one selected grant, never a history array to combine.
    denies(() => resolve(state, { permission: 'assessment.read', module: 'cyber_security' }, grants));
});

test('assignments cannot enlarge other roles and independently granted roles still work', () => {
    const review = assignment({ modules: ['evidence'], permissions: ['evidence.review'] });
    denies(() => resolve(membership(['editor']), { permission: 'evidence.review', module: 'evidence' }, review));
    const state = membership(['viewer', 'fractional_advisor']);
    assert.equal(resolve(state, {}, review).role, 'viewer');
    assert.equal(resolve(state, { permission: 'evidence.review', module: 'evidence' }, review).role, 'fractional_advisor');
    assert.equal(resolve(state, {}, { ...review, status: 'revoked' }).role, 'viewer');
    denies(() => resolve(state, { permission: 'evidence.review', module: 'evidence' }, { ...review, status: 'revoked' }));
});

test('advisor assignments must match tenant, organisation, immutable subject and membership ID', () => {
    const state = membership(['fractional_advisor']);
    for (const overrides of [{ tenantId: 'tenant-b' }, { organisationId: 'org-2' },
        { subjectKey: BOB }, { membershipId: 'member-2' }]) {
        denies(() => resolve(state, { permission: 'assessment.read', module: 'cyber_security' }, assignment(overrides)));
    }
});

test('removed and re-invited subject cannot inherit the old membership assignment', () => {
    let state = membership(['fractional_advisor']);
    const command = (action, payload, actorSubjectKey = ADMIN) => {
        state = applyMembershipCommand(state, tenant(), { ...SCOPE, expectedRevision: state.revision,
            actorSubjectKey, now: NOW, action, payload });
    };
    command('remove', { membershipId: 'member-1' });
    command('invite', { invitationId: 'invite-2', subjectKey: ALICE, roles: ['fractional_advisor'],
        validFrom: NOW, validUntil: END, expiresAt: ASSIGN_END, grantEvidenceId: 'grant-2' });
    command('accept', { invitationId: 'invite-2', membershipId: 'member-2' }, ALICE);
    denies(() => resolve(state, { permission: 'assessment.read', module: 'cyber_security' }, assignment()));
    assert.equal(resolve(state, { permission: 'assessment.read', module: 'cyber_security' },
        assignment({ membershipId: 'member-2', validFrom: NOW, updatedAt: NOW })).membershipId, 'member-2');
});

test('advisor validity is half-open and revocation wins within an otherwise valid term', () => {
    const state = membership(['fractional_advisor']);
    const grant = assignment({ validFrom: NOW }), query = { permission: 'assessment.read', module: 'cyber_security' };
    denies(() => resolve(state, query, grant, ACCEPT));
    assert.equal(resolve(state, query, grant).assignmentId, 'assignment-1');
    assert.equal(resolve(state, query, grant, '2026-09-07T23:59:59.999Z').assignmentId, 'assignment-1');
    denies(() => resolve(state, query, grant, ASSIGN_END));
    denies(() => resolve(state, query, assignment({ status: 'revoked', updatedAt: NOW })));
});

test('advisor grant cannot extend outside membership validity or use a future revision timestamp', () => {
    const state = membership(['fractional_advisor'], { validFrom: ACCEPT });
    for (const overrides of [{ validFrom: START }, { validUntil: '2027-09-06T00:00:00.000Z' },
        { updatedAt: '2026-09-06T00:00:00.001Z' }]) {
        denies(() => resolve(state, { permission: 'assessment.read', module: 'cyber_security' }, assignment(overrides)));
    }
});

test('assignment normalisation copies and freezes valid grants and rejects missing or unexpected fields', () => {
    const input = assignment(), result = normaliseAdvisorAssignment(input);
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen(result.modules));
    assert.ok(Object.isFrozen(result.permissions));
    input.modules.push('ai_governance');
    assert.deepEqual(result.modules, ['cyber_security']);
    for (const key of Object.keys(assignment())) {
        const incomplete = assignment();
        delete incomplete[key];
        denies(() => normaliseAdvisorAssignment(incomplete));
    }
    denies(() => normaliseAdvisorAssignment(assignment({ role: 'admin' })));
    denies(() => normaliseAdvisorAssignment(assignment({ allow: true })));
});

test('malformed persisted advisor grants fail closed instead of defaulting authority', () => {
    const bad = [{ schemaVersion: 2 }, { status: 'pending' }, { assignmentId: '' }, { membershipId: ' member-1' },
        { subjectKey: ALICE.toUpperCase().replace('20000000', 'AAAAAAAA') }, { grantEvidenceId: null },
        { revision: -1 }, { revision: 0.5 }, { revision: Number.MAX_SAFE_INTEGER + 1 },
        { modules: [] }, { modules: ['cyber_security', 'cyber_security'] }, { modules: ['unknown'] },
        { permissions: [] }, { permissions: ['assessment.read', 'assessment.read'] }, { permissions: ['*'] },
        { validFrom: '2026-09-05T01:00:00Z' }, { validUntil: '2026-09-08T12:00:00.000+12:00' },
        { validUntil: '2026-02-30T00:00:00.000Z' }, { validUntil: ACCEPT }, { updatedAt: new Date(ACCEPT) }];
    for (const overrides of bad) denies(() => normaliseAdvisorAssignment(assignment(overrides)));
});

test('selected advisor grants reject accessors and arrays without evaluating hidden data', () => {
    let reads = 0;
    const accessor = assignment();
    Object.defineProperty(accessor, 'subjectKey', { enumerable: true, get() { reads += 1; return ALICE; } });
    denies(() => normaliseAdvisorAssignment(accessor));
    const sparse = new Array(1), decorated = [assignment()];
    decorated.authority = 'admin';
    const getterList = [assignment()];
    Object.defineProperty(getterList, '0', { get() { reads += 1; return assignment(); } });
    for (const candidate of [accessor, sparse, decorated, getterList, null, undefined, {}]) {
        denies(() => resolve(membership(['fractional_advisor']),
            { permission: 'assessment.read', module: 'cyber_security' }, candidate));
    }
    assert.equal(reads, 0);
});

test('normal roles do not inspect advisor data, including irrelevant accumulated history', () => {
    const irrelevantHistory = Array.from({ length: 10000 }, (_, i) => assignment({
        assignmentId: `old-assignment-${i}`, subjectKey: BOB, status: 'revoked' }));
    for (const role of ['admin', 'editor', 'viewer']) {
        for (const candidate of [null, assignment({ permissions: ['*'] }), irrelevantHistory]) {
            assert.equal(resolve(membership([role]), {}, candidate).role, role);
        }
    }
});

test('permission evaluation rejects noncanonical time and time regression', () => {
    const state = membership(['admin']);
    for (const now of [START, '2026-09-06T00:00:00Z', '2026-09-06T12:00:00.000+12:00',
        '2026-02-30T00:00:00.000Z', null, new Date(NOW)]) {
        denies(() => resolve(state, {}, null, now));
    }
});

function guardFixture(overrides = {}) {
    const calls = [];
    const dependencies = {
        authenticate: async request => { calls.push(['authenticate', request]); return { authenticated: true, subjectKey: ALICE }; },
        resolveScope: async (request, principal) => { calls.push(['scope', request, principal]); return { ...SCOPE }; },
        loadTenantAggregate: async scope => { calls.push(['tenant', scope]); return tenant(); },
        loadMembershipState: async scope => { calls.push(['membership', scope]); return membership(); },
        loadAdvisorAssignment: async query => { calls.push(['assignment', query]); return null; },
        clock: () => { calls.push(['clock']); return NOW; },
        ...overrides
    };
    return { requirePermission: createPortalPermissionGuard(dependencies), calls };
}
const overview = { permission: 'overview.read', module: 'overview' };

test('server guard derives identity and scope from trusted adapters and ignores request role claims', async () => {
    const request = { body: { ...SCOPE, tenantId: 'attacker-tenant', subjectKey: BOB, roles: ['admin'] } };
    const { requirePermission, calls } = guardFixture();
    const decision = await requirePermission(request, overview);
    assert.equal(decision.role, 'viewer');
    assert.equal(decision.tenantId, SCOPE.tenantId);
    assert.equal(calls[0][0], 'authenticate');
    assert.equal(calls[0][1], request);
    assert.deepEqual(calls.find(call => call[0] === 'scope')[2], { authenticated: true, subjectKey: ALICE });
    for (const kind of ['tenant', 'membership']) {
        assert.deepEqual(calls.find(call => call[0] === kind)[1], SCOPE);
    }
    assert.ok(!calls.some(call => call[0] === 'assignment'));
    assert.equal(calls[calls.length - 1][0], 'clock');
    await deniesAsync(() => requirePermission(request, { permission: 'membership.manage', module: 'overview' }));
});

test('server guard requires a canonical verified principal before protected state is loaded', async () => {
    for (const principal of [null, {}, { authenticated: false, subjectKey: ALICE },
        { authenticated: 'true', subjectKey: ALICE }, { authenticated: true, subjectKey: 'alice@example.test' },
        { authenticated: true, subjectKey: ALICE, roles: ['admin'] }]) {
        let loads = 0;
        const { requirePermission } = guardFixture({ authenticate: async () => principal,
            loadMembershipState: async () => { loads += 1; return membership(['admin']); } });
        await deniesAsync(() => requirePermission({}, overview));
        assert.equal(loads, 0);
    }
});

test('server guard rejects malformed trusted scope and requested capabilities', async () => {
    for (const scope of [null, {}, { ...SCOPE, subjectKey: BOB }, { ...SCOPE, tenantId: '' }]) {
        const { requirePermission } = guardFixture({ resolveScope: async () => scope });
        await deniesAsync(() => requirePermission({}, overview));
    }
    const { requirePermission } = guardFixture({ loadMembershipState: async () => membership(['admin']) });
    for (const requirement of [null, {}, { ...overview, roles: ['admin'] },
        { permission: 'overview.read', module: 'cyber_security' }, { permission: '*', module: 'overview' }]) {
        await deniesAsync(() => requirePermission({}, requirement));
    }
});

test('dependency failures return safe denial and prevent the protected operation', async () => {
    for (const dependency of ['authenticate', 'resolveScope', 'loadTenantAggregate', 'loadMembershipState', 'clock']) {
        let protectedCalls = 0;
        const { requirePermission } = guardFixture({ [dependency]: () => { throw new Error('private-upstream-detail'); } });
        const protectedOperation = async () => { await requirePermission({}, overview); protectedCalls += 1; };
        await deniesAsync(protectedOperation);
        assert.equal(protectedCalls, 0);
    }
    let protectedCalls = 0;
    const { requirePermission } = guardFixture({ loadMembershipState: async () => membership(['fractional_advisor']),
        loadAdvisorAssignment: async () => { throw new Error('private-upstream-detail'); } });
    await deniesAsync(async () => {
        await requirePermission({}, { permission: 'assessment.read', module: 'cyber_security' });
        protectedCalls += 1;
    });
    assert.equal(protectedCalls, 0);
});

test('normal-role requests never query advisor storage and remain available if that storage fails', async () => {
    for (const role of ['admin', 'editor', 'viewer']) {
        let advisorLoads = 0;
        const { requirePermission } = guardFixture({
            loadMembershipState: async () => membership([role, 'fractional_advisor']),
            loadAdvisorAssignment: async () => { advisorLoads += 1; throw new Error('private-upstream-detail'); }
        });
        assert.equal((await requirePermission({}, overview)).role, role);
        assert.equal(advisorLoads, 0);
    }
});

test('advisor lookup binds the selected grant to current membership, immutable identity, capability and time', async () => {
    const queries = [], requirement = { permission: 'assessment.read', module: 'cyber_security' };
    const { requirePermission } = guardFixture({ loadMembershipState: async () => membership(['fractional_advisor']),
        loadAdvisorAssignment: async query => { queries.push(query); return assignment(); } });
    const request = { body: { subjectKey: BOB, membershipId: 'forged', module: 'ai_governance' } };
    assert.equal((await requirePermission(request, requirement)).assignmentId, 'assignment-1');
    assert.deepEqual(queries, [{ ...SCOPE, subjectKey: ALICE, membershipId: 'member-1', ...requirement, at: NOW }]);
    assert.ok(Object.isFrozen(queries[0]));
});

test('server guard rejects a missing, malformed or incorrectly selected advisor record', async () => {
    const requirement = { permission: 'assessment.read', module: 'cyber_security' };
    for (const candidate of [null, {}, [assignment()], assignment({ tenantId: 'tenant-b' }),
        assignment({ organisationId: 'org-2' }), assignment({ subjectKey: BOB }),
        assignment({ membershipId: 'member-2' }), assignment({ modules: ['ai_governance'] }),
        assignment({ permissions: ['assessment.write'] })]) {
        const { requirePermission } = guardFixture({ loadMembershipState: async () => membership(['fractional_advisor']),
            loadAdvisorAssignment: async () => candidate });
        await deniesAsync(() => requirePermission({}, requirement));
    }
});

test('server guard reloads membership on every request and denies after suspension', async () => {
    let state = membership(), loads = 0;
    const { requirePermission } = guardFixture({ loadMembershipState: async () => { loads += 1; return state; } });
    assert.equal((await requirePermission({}, overview)).role, 'viewer');
    state = applyMembershipCommand(state, tenant(), { ...SCOPE, expectedRevision: state.revision,
        actorSubjectKey: ADMIN, now: NOW, action: 'suspend', payload: { membershipId: 'member-1' } });
    await deniesAsync(() => requirePermission({}, overview));
    assert.equal(loads, 2);
});

test('server guard reloads advisor assignments and denies the next request after revocation', async () => {
    let grant = assignment(), loads = 0;
    const { requirePermission } = guardFixture({ loadMembershipState: async () => membership(['fractional_advisor']),
        loadAdvisorAssignment: async () => { loads += 1; return grant; } });
    const requirement = { permission: 'assessment.read', module: 'cyber_security' };
    assert.equal((await requirePermission({}, requirement)).assignmentId, 'assignment-1');
    grant = assignment({ status: 'revoked', revision: 1, updatedAt: NOW });
    await deniesAsync(() => requirePermission({}, requirement));
    assert.equal(loads, 2);
});

test('time is sampled after asynchronous loads so an assignment expiring during load is denied', async () => {
    let now = NOW;
    const { requirePermission } = guardFixture({ loadMembershipState: async () => membership(['fractional_advisor']),
        loadAdvisorAssignment: async () => { await Promise.resolve(); now = ASSIGN_END; return assignment(); },
        clock: () => now });
    await deniesAsync(() => requirePermission({}, { permission: 'assessment.read', module: 'cyber_security' }));
});

test('time is sampled after asynchronous loads so membership expiry cannot be bypassed', async () => {
    let now = NOW;
    const { requirePermission } = guardFixture({ loadMembershipState: async () => { await Promise.resolve(); now = END; return membership(); },
        clock: () => now });
    await deniesAsync(() => requirePermission({}, overview));
});

test('advisor lookup completing after membership expiry cannot preserve earlier authority', async () => {
    let now = NOW;
    const { requirePermission } = guardFixture({ loadMembershipState: async () => membership(['fractional_advisor']),
        loadAdvisorAssignment: async () => { await Promise.resolve(); now = END; return assignment({ validUntil: END }); },
        clock: () => now });
    await deniesAsync(() => requirePermission({}, { permission: 'assessment.read', module: 'cyber_security' }));
});
