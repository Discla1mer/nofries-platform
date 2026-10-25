'use strict';

const assert = require('node:assert/strict');
const test = global.test || require('node:test');
const { createDashboardAdmission, DashboardAdmissionError } = require('../api/shared/dashboardAdmission');
const { applyMembershipCommand } = require('../api/shared/appLifecycle/membershipDomain');
const { admissionFixture, SUBJECT } = require('./fixtures/dashboardAdmissionFixture');
const registry = require('../api/shared/protectedAssets/dashboardRegistry');

const request = { method: 'GET' };
const keys = result => result.modules.map(item => item.key);
const denied = operation => assert.rejects(operation, error => {
    assert.ok(error instanceof DashboardAdmissionError);
    assert.equal(error.statusCode, 403);
    assert.equal(error.code, 'dashboard_access_denied');
    assert.equal(error.message, 'dashboard_access_denied');
    assert.deepEqual(error.details, { code: 'dashboard_access_denied' });
    assert.ok(!JSON.stringify(error).includes('synthetic'));
    return true;
});

test('dashboard-only member loads renderer contract without provider IDs or service dependencies', async () => {
    const { adapters, state } = admissionFixture();
    const result = await createDashboardAdmission(adapters)(request);
    assert.equal(keys(result).length, 8);
    assert.equal(result.context.organisationId, state.scope.organisationId);
    assert.deepEqual(state.calls, ['authenticate', 'resolveScope', 'loadSnapshot', 'clock']);
    assert.equal(result.admissionGranted, false);
    assert.equal(result.providerAccessGranted, false);
    for (const field of ['subjectKey', 'tenantId', 'agreementRef', 'grantId', 'membershipId', 'companyId', 'contactId', 'providerScopeId']) {
        assert.ok(!JSON.stringify(result).includes('"' + field + '"'));
    }
    assert.ok(Object.isFrozen(result));
});

for (const [role, expected] of [
    ['viewer', ['overview', 'board_reports', 'services']],
    ['editor', registry.modules.map(item => item.key)],
    ['admin', registry.modules.map(item => item.key)],
    ['fractional_advisor', ['cyber_security']]
]) test(`${role} admission and every module read intersect current explicit permissions`, async () => {
    const { adapters } = admissionFixture({ role, ...(role === 'fractional_advisor' ? { service: 'fractional_advisory' } : {}) });
    const admit = createDashboardAdmission(adapters);
    assert.deepEqual(keys(await admit(request)), expected);
    for (const item of registry.modules) {
        if (expected.includes(item.key)) assert.ok(keys(await admit(request, item.key)).includes(item.key));
        else await denied(() => admit(request, item.key));
    }
});

test('request body, identity, role and scope hints cannot supply a trusted principal or extend a viewer', async () => {
    const { adapters, state } = admissionFixture({ role: 'viewer' });
    const admit = createDashboardAdmission(adapters);
    const forged = { method: 'GET', identity: { authenticated: true, subjectKey: SUBJECT },
        body: { ...state.input, roles: ['admin'], subjectKey: SUBJECT }, query: { tenantId: 'foreign', organisationId: 'foreign' } };
    assert.deepEqual(keys(await admit(forged)), ['overview', 'board_reports', 'services']);
    await denied(() => admit(forged, 'evidence'));
    state.authenticated = false;
    state.calls.length = 0;
    await denied(() => admit(forged));
    assert.deepEqual(state.calls, ['authenticate']);
});

for (const value of ['', 'customer@example.test', SUBJECT.toUpperCase(), 'other-subject', null]) {
    // Numeric-only fixture UUIDs have identical upper/lower case; exercise a
    // non-canonical upper-case UUID explicitly rather than assuming otherwise.
    const subjectKey = value === SUBJECT ? SUBJECT.replace('10000000', 'A0000000') : value;
    test(`invalid immutable principal ${JSON.stringify(subjectKey)} fails before storage`, async () => {
        const { adapters, state } = admissionFixture(); state.subjectKey = subjectKey;
        await denied(() => createDashboardAdmission(adapters)(request));
        assert.deepEqual(state.calls, ['authenticate']);
    });
}

const cases = {
    'foreign selected tenant': s => { s.scope.tenantId = 'foreign'; },
    'foreign selected organisation': s => { s.scope.organisationId = 'foreign'; },
    'foreign immutable subject': s => { s.subjectKey = SUBJECT.slice(0, -1) + '2'; },
    'foreign membership scope': s => { s.input.membershipState.organisationId = 'foreign'; },
    'foreign entitlement scope': s => { s.input.entitlementState.tenantId = 'foreign'; },
    'foreign flags scope': s => { s.input.flags.organisationId = 'foreign'; },
    'foreign summary': s => { s.input.summary.organisationId = 'foreign'; },
    'suspended tenant': s => { s.input.tenantAggregate.tenant.recordStatus = 'suspended'; },
    'closed organisation': s => { s.input.tenantAggregate.organisations[0].recordStatus = 'closed'; },
    'suspended membership': s => { s.input.membershipState.memberships[0].status = 'suspended'; },
    'removed membership': s => { s.input.membershipState.memberships[0].status = 'removed'; },
    'missing membership': s => { s.input.membershipState.memberships = []; },
    'missing product': s => { s.input.entitlementState.grants = []; },
    'revoked product': s => { s.input.entitlementState.grants[0].status = 'revoked'; },
    'expired product': s => { s.input.entitlementState.grants[0].validUntil = s.now; },
    'future product': s => { s.input.entitlementState.grants[0].validFrom = '2026-09-06T10:00:00.000Z'; },
    'disabled dashboard': s => { s.input.flags.enabled.dashboard = false; },
    'no eligible modules': s => { registry.modules.forEach(item => { s.input.flags.enabled[item.key] = false; }); },
    'non-canonical clock': s => { s.now = '2026-09-06'; },
    'future membership revision': s => { s.input.membershipState.updatedAt = '2026-09-06T10:00:00.000Z'; }
};
for (const [name, change] of Object.entries(cases)) test(`${name} fails closed without account detail`, async () => {
    const { adapters, state } = admissionFixture(); change(state);
    await denied(() => createDashboardAdmission(adapters)(request));
});

test('purchased disabled modules can show an unavailable notice but cannot supply resource content', async () => {
    const { adapters } = admissionFixture({ enabled: { cyber_security: false } });
    const admit = createDashboardAdmission(adapters);
    const projection = await admit(request);
    assert.equal(projection.modules.find(item => item.key === 'cyber_security').state, 'disabled');
    assert.deepEqual(projection.summary.metrics, []);
    await denied(() => admit(request, 'cyber_security'));
});

test('Score membership cannot enter the unpurchased Govern modules', async () => {
    const { adapters } = admissionFixture({ tier: 'dashboard_score' });
    const admit = createDashboardAdmission(adapters);
    assert.ok(!keys(await admit(request)).includes('ai_governance'));
    await denied(() => admit(request, 'ai_governance'));
    await denied(() => admit(request, 'it_optimisation'));
});

test('each request observes committed membership removal and old projections cannot override it', async () => {
    const { adapters, state } = admissionFixture();
    const admit = createDashboardAdmission(adapters);
    const previous = await admit(request);
    state.input.membershipState = applyMembershipCommand(state.input.membershipState, state.input.tenantAggregate, {
        ...state.scope, expectedRevision: state.input.membershipState.revision, actorSubjectKey: SUBJECT,
        now: state.now, action: 'remove', payload: { membershipId: 'synthetic-membership' }
    });
    await denied(() => admit({ ...request, body: previous }));
    assert.equal(state.calls.filter(call => call === 'authenticate').length, 2);
    assert.equal(state.calls.filter(call => call === 'loadSnapshot').length, 2);
});

test('clock sampled after asynchronous snapshot loading rejects the exclusive expiry boundary', async () => {
    const { adapters, state } = admissionFixture();
    const load = adapters.loadSnapshot;
    adapters.loadSnapshot = async (...args) => {
        const snapshot = await load(...args);
        state.now = state.input.membershipState.memberships[0].validUntil;
        return snapshot;
    };
    await denied(() => createDashboardAdmission(adapters)(request));
    assert.equal(state.calls.at(-1), 'clock');
});

for (const [name, mutate] of Object.entries({
    missing: state => { state.input.advisorAssignments = {}; },
    revoked: state => { state.input.advisorAssignments.cyber_security.status = 'revoked'; },
    expired: state => { state.input.advisorAssignments.cyber_security.validUntil = state.now; },
    'wrong tenant': state => { state.input.advisorAssignments.cyber_security.tenantId = 'foreign'; },
    'wrong membership': state => { state.input.advisorAssignments.cyber_security.membershipId = 'foreign'; },
    'wrong subject': state => { state.input.advisorAssignments.cyber_security.subjectKey = SUBJECT.slice(0, -1) + '2'; },
    'wrong resource': state => { state.input.advisorAssignments.cyber_security.modules = ['ai_governance']; },
    'future revision': state => { state.input.advisorAssignments.cyber_security.updatedAt = '2026-09-06T10:00:00.000Z'; }
})) test(`advisor ${name} assignment is not dashboard authority`, async () => {
    const { adapters, state } = admissionFixture({ role: 'fractional_advisor', service: 'fractional_advisory' });
    const admit = createDashboardAdmission(adapters);
    assert.deepEqual(keys(await admit(request)), ['cyber_security']);
    mutate(state);
    await denied(() => admit(request));
    await denied(() => admit(request, 'cyber_security'));
});

for (const [name, mutate] of Object.entries({
    missing: state => { state.input.entitlementState.grants = state.input.entitlementState.grants.slice(0, 1); },
    'missing flag': state => { delete state.input.flags.enabled['service:fractional_advisory']; },
    disabled: state => { state.input.flags.enabled['service:fractional_advisory'] = false; },
    suspended: state => { state.input.entitlementState.grants[1].status = 'suspended'; },
    revoked: state => { state.input.entitlementState.grants[1].status = 'revoked'; },
    expired: state => { state.input.entitlementState.grants[1].validUntil = state.now; },
    future: state => { state.input.entitlementState.grants[1].validFrom = '2026-09-06T10:00:00.000Z'; },
    'foreign owner': state => { state.input.entitlementState.grants[1].organisationId = 'foreign'; },
    'unrelated purchase': state => { state.input.entitlementState.grants[1].code = 'managed_endpoint'; }
})) test(`advisor ${name} advisory service cannot authorize admission or a module read`, async () => {
    const { adapters, state } = admissionFixture({ role: 'fractional_advisor', service: 'fractional_advisory' });
    mutate(state);
    const admit = createDashboardAdmission(adapters);
    await denied(() => admit(request));
    await denied(() => admit(request, 'cyber_security'));
});

for (const role of ['admin', 'editor']) test(`${role} plus advisor retains independently granted access without advisory purchase`, async () => {
    const { adapters, state } = admissionFixture({ role: 'fractional_advisor' });
    for (const row of [...state.input.membershipState.memberships, ...state.input.membershipState.invitations]) {
        row.roles = [role, 'fractional_advisor'];
    }
    state.input.advisorAssignments.cyber_security.status = 'revoked';
    const admit = createDashboardAdmission(adapters);
    assert.deepEqual(keys(await admit(request)), registry.modules.map(item => item.key));
    assert.ok(keys(await admit(request, 'cyber_security')).includes('cyber_security'));
});

test('viewer plus unpaid advisor retains viewer modules without Cyber summaries or module access', async () => {
    const { adapters, state } = admissionFixture({ role: 'fractional_advisor' });
    for (const row of [...state.input.membershipState.memberships, ...state.input.membershipState.invitations]) {
        row.roles = ['viewer', 'fractional_advisor'];
    }
    const admit = createDashboardAdmission(adapters), result = await admit(request);
    assert.deepEqual(keys(result), ['overview', 'board_reports', 'services']);
    assert.deepEqual(result.summary.attention, []);
    assert.deepEqual(result.summary.metrics, []);
    await denied(() => admit(request, 'cyber_security'));
});

test('advisory service expiry during snapshot loading is checked at the exclusive boundary', async () => {
    const { adapters, state } = admissionFixture({ role: 'fractional_advisor', service: 'fractional_advisory' });
    state.input.entitlementState.grants[1].validUntil = '2026-09-06T09:30:00.000Z';
    const load = adapters.loadSnapshot;
    adapters.loadSnapshot = async (...args) => {
        const snapshot = await load(...args);
        state.now = state.input.entitlementState.grants[1].validUntil;
        return snapshot;
    };
    await denied(() => createDashboardAdmission(adapters)(request, 'cyber_security'));
    assert.equal(state.calls.at(-1), 'clock');
});

test('snapshot mutations after capture do not alter the authorised browser projection', async () => {
    const { adapters, state } = admissionFixture();
    const clock = adapters.clock;
    adapters.clock = () => { state.input.summary.metrics[0].value = 'MUTATED'; return clock(); };
    const projection = await createDashboardAdmission(adapters)(request);
    assert.equal(projection.summary.metrics[0].value, '64%');
});

test('malformed/accessor snapshot data is rejected without executing a getter', async () => {
    const { adapters, state } = admissionFixture(); let called = false;
    Object.defineProperty(state.input.flags.enabled, 'dashboard', { enumerable: true,
        get() { called = true; return true; } });
    await denied(() => createDashboardAdmission(adapters)(request));
    assert.equal(called, false);
});

for (const dependency of ['authenticate', 'resolveScope', 'loadSnapshot', 'clock']) {
    test(`${dependency} failure exposes no upstream detail and fails closed`, async () => {
        const { adapters } = admissionFixture();
        adapters[dependency] = () => { throw new Error('private-upstream-detail'); };
        await denied(() => createDashboardAdmission(adapters)(request));
    });
}

test('no implicit factory defaults or arbitrary resource/action selectors are accepted', async () => {
    assert.throws(() => createDashboardAdmission(), DashboardAdmissionError);
    const { adapters } = admissionFixture();
    const admit = createDashboardAdmission(adapters);
    for (const resource of ['*', '__proto__', 'tickets', 'evidence/foreign-id', 'report.read_draft', { module: 'overview' }]) {
        await denied(() => admit(request, resource));
    }
});

// G: exact finite typed-admission and temporal-policy inventory. These use the
// genuine canonical policy/projector; the sole projector fault delegates to the
// real projector before throwing and is isolated/restored within HN-A09.
const { createDashboardAdmissionDecision, DashboardAdmissionUnavailableError } = require('../api/shared/dashboardAdmission');
const { createMembershipState } = require('../api/shared/appLifecycle/membershipDomain');
const { transitionTenant, transitionOrganisation } = require('../api/shared/appLifecycle/tenantDomain');
const { normaliseAdvisorAssignment } = require('../api/shared/appLifecycle/portalPermissions');
const copied = value => JSON.parse(JSON.stringify(value));
function recursivelyFrozen(value) {
    if (value && typeof value === 'object') {
        assert.ok(Object.isFrozen(value)); Object.values(value).forEach(recursivelyFrozen);
    }
}
function unavailableDecision(operation, Type = DashboardAdmissionUnavailableError) {
    return assert.rejects(operation, error => {
        assert.ok(error instanceof Type);
        assert.equal(error.name, 'DashboardAdmissionUnavailableError');
        assert.equal(error.code, 'dashboard_unavailable'); assert.equal(error.statusCode, 503);
        assert.equal(error.message, 'dashboard_unavailable');
        assert.deepEqual(error.details, { code: 'dashboard_unavailable' });
        assert.ok(Object.isFrozen(error.details)); assert.equal(error.cause, undefined);
        assert.ok(!JSON.stringify(error).includes('private')); return true;
    });
}
async function parity(f, moduleKey = null, outcome = 'succeeded') {
    const result = await createDashboardAdmissionDecision(f.adapters)(request, moduleKey);
    assert.deepEqual(Object.keys(result).sort(), ['outcome', 'projection']); recursivelyFrozen(result);
    assert.equal(result.outcome, outcome);
    if (outcome === 'denied') {
        assert.equal(result.projection, null);
        await denied(() => createDashboardAdmission(f.adapters)(request, moduleKey));
    } else assert.deepEqual(result.projection, await createDashboardAdmission(f.adapters)(request, moduleKey));
    return result;
}
function viewerAdvisor(f) {
    for (const row of [...f.state.input.membershipState.memberships, ...f.state.input.membershipState.invitations]) row.roles = ['viewer', 'fractional_advisor'];
}
const CUTOFF = '2026-09-06T09:00:01.000Z';

test('HN-A01 typed success preserves genuine legacy projection and detached frozen result', async () => {
    const f = admissionFixture(); const result = await parity(f);
    assert.equal(result.projection.summary.metrics[0].value, '64%');
    f.state.input.summary.metrics[0].value = 'private-after-capture';
    assert.equal(result.projection.summary.metrics[0].value, '64%');
    const fresh = admissionFixture(), clock = fresh.adapters.clock;
    fresh.adapters.clock = () => { fresh.state.input.summary.metrics[0].value = 'private-at-clock'; return clock(); };
    assert.equal((await createDashboardAdmissionDecision(fresh.adapters)(request)).projection.summary.metrics[0].value, '64%');
});

test('HN-A02 canonical missing member and inactive owners are genuine typed refusals', async () => {
    for (const kind of ['missing member', 'organisation', 'tenant']) {
        const f = admissionFixture();
        if (kind === 'missing member') f.state.input.membershipState = createMembershipState(f.state.input.tenantAggregate, f.state.scope, f.state.now);
        else if (kind === 'organisation') {
            const row = f.state.input.tenantAggregate.organisations[0];
            f.state.input.tenantAggregate.organisations[0] = transitionOrganisation(row, { expectedRevision: row.revision, toStatus: 'suspended' });
        } else {
            const row = f.state.input.tenantAggregate.tenant;
            f.state.input.tenantAggregate.tenant = transitionTenant(row, { expectedRevision: row.revision, toStatus: 'suspended' });
        }
        await parity(f, null, 'denied');
    }
});

test('HN-A03 lawful entitlement and feature refusals remain policy outcomes', async () => {
    for (const kind of ['product absent', 'dashboard disabled', 'module disabled', 'not entitled', 'profile unavailable']) {
        const f = admissionFixture(kind === 'not entitled' ? { tier: 'dashboard_score' } : {});
        if (kind === 'product absent') f.state.input.entitlementState.grants = [];
        if (kind === 'dashboard disabled') f.state.input.flags.enabled.dashboard = false;
        if (kind === 'module disabled') f.state.input.flags.enabled.ai_governance = false;
        if (kind === 'profile unavailable') f.state.input.flags.frameworks = f.state.input.flags.frameworks.filter(row => row.moduleId !== 'ai_governance');
        await parity(f, 'ai_governance', 'denied');
    }
    await parity(admissionFixture(), 'ai_governance');
});

test('HN-A04 structurally valid role and advisor refusals differ from corruption', async () => {
    await parity(admissionFixture({ role: 'viewer' }), 'cyber_security', 'denied');
    for (const kind of ['absent', 'other subject', 'wrong permission', 'service disabled']) {
        const f = admissionFixture({ role: 'fractional_advisor', service: 'fractional_advisory' });
        if (kind === 'absent') f.state.input.advisorAssignments = {};
        if (kind === 'other subject') f.state.input.advisorAssignments.cyber_security.subjectKey = SUBJECT.slice(0, -1) + '2';
        if (kind === 'wrong permission') f.state.input.advisorAssignments.cyber_security.permissions = ['assessment.write'];
        if (kind === 'service disabled') f.state.input.flags.enabled['service:fractional_advisory'] = false;
        for (const row of Object.values(f.state.input.advisorAssignments)) normaliseAdvisorAssignment(row);
        await parity(f, 'cyber_security', 'denied');
    }
    await parity(admissionFixture({ role: 'fractional_advisor', service: 'fractional_advisory' }), 'cyber_security');
});

test('HN-A05 malformed retained scope linkage entitlement and chronology are unavailable', async () => {
    const mutations = [
        f => { f.state.input.membershipState.organisationId = 'foreign'; },
        f => { f.state.input.membershipState.invitations[0].membershipId = 'foreign'; },
        f => { f.state.input.entitlementState.grants[0].status = 'invalid'; },
        f => { f.state.input.membershipState.updatedAt = CUTOFF; }
    ];
    for (const mutate of mutations) {
        const f = admissionFixture(); mutate(f);
        await unavailableDecision(() => createDashboardAdmissionDecision(f.adapters)(request));
        await denied(() => createDashboardAdmission(f.adapters)(request));
    }
});

test('HN-A06 malformed disabled neighboring advisor is503 while legacy omission remains', async () => {
    const f = admissionFixture({ role: 'fractional_advisor', service: 'fractional_advisory', enabled: { cyber_security: false } });
    viewerAdvisor(f);
    assert.ok(keys((await parity(f)).projection).includes('cyber_security'));
    f.state.input.advisorAssignments.cyber_security.permissions = ['private-invalid-permission'];
    await unavailableDecision(() => createDashboardAdmissionDecision(f.adapters)(request));
    const legacy = await createDashboardAdmission(f.adapters)(request);
    assert.ok(keys(legacy).includes('overview')); assert.ok(!keys(legacy).includes('cyber_security'));
});

test('HN-A07 genuine loader403 and copied denial fields cannot become typed refusal', async () => {
    const { DashboardPersistenceError } = require('../api/shared/appLifecycle/postgresDashboardRepository');
    for (const error of [new DashboardPersistenceError('assignment_ambiguous', 403),
        Object.assign(new Error('private-loader'), { code: 'dashboard_access_denied', statusCode: 403 })]) {
        const f = admissionFixture(); f.adapters.loadSnapshot = async () => { throw error; };
        await unavailableDecision(() => createDashboardAdmissionDecision(f.adapters)(request));
        await denied(() => createDashboardAdmission(f.adapters)(request));
        assert.ok(!f.state.calls.includes('clock'));
    }
});

test('HN-A08 provider and invalid clock failures keep sanitized typed503 and legacy403', async () => {
    for (const kind of ['authenticate', 'resolveScope', 'loadSnapshot', 'clock throw', 'clock invalid']) {
        const f = admissionFixture();
        if (kind === 'clock invalid') f.adapters.clock = () => 'not-an-instant';
        else if (kind === 'clock throw') f.adapters.clock = () => { throw new Error('private-clock'); };
        else f.adapters[kind] = async () => { throw new Error('private-adapter'); };
        await unavailableDecision(() => createDashboardAdmissionDecision(f.adapters)(request));
        await denied(() => createDashboardAdmission(f.adapters)(request));
        if (kind === 'authenticate') assert.ok(!f.state.calls.includes('resolveScope'));
        if (kind === 'resolveScope') assert.ok(!f.state.calls.includes('loadSnapshot'));
    }
});

test('HN-A09 real positive projection followed by unexpected failure is unavailable', async () => {
    const projectionPath = '../api/shared/appLifecycle/dashboardProjection'; let module, calls = 0, actualResult;
    try {
        jest.isolateModules(() => {
            const actual = jest.requireActual(projectionPath);
            jest.doMock(projectionPath, () => ({ ...actual, projectDashboard(input) {
                actualResult = actual.projectDashboard(input); calls++;
                throw new Error('private-after-genuine-projection');
            } }));
            module = require('../api/shared/dashboardAdmission');
        });
        const f = admissionFixture();
        await unavailableDecision(() => module.createDashboardAdmissionDecision(f.adapters)(request), module.DashboardAdmissionUnavailableError);
        assert.equal(calls, 1); assert.ok(actualResult.modules.some(row => row.key === 'overview'));
        await assert.rejects(() => module.createDashboardAdmission(f.adapters)(request), module.DashboardAdmissionError);
        assert.equal(calls, 2);
    } finally { jest.dontMock(projectionPath); }
});

test('HN-A10 closed adapters and hostile principal scope snapshot reject without getters', async () => {
    const f = admissionFixture(); let getters = 0, injected = 0;
    for (const bad of [undefined, { ...f.adapters, work: () => injected++ }, { ...f.adapters, clock: null }]) {
        assert.throws(() => createDashboardAdmissionDecision(bad), DashboardAdmissionUnavailableError);
        assert.throws(() => createDashboardAdmission(bad), DashboardAdmissionError);
    }
    for (const kind of ['principal', 'scope', 'extra snapshot', 'nested accessor', 'prototype']) {
        const g = admissionFixture();
        if (kind === 'principal') g.adapters.authenticate = async () => ({ authenticated: true, get subjectKey() { getters++; return SUBJECT; } });
        if (kind === 'scope') g.adapters.resolveScope = async () => ({ ...g.state.scope, extra: true });
        if (kind === 'extra snapshot') { const load = g.adapters.loadSnapshot; g.adapters.loadSnapshot = async (...args) => ({ ...await load(...args), extra: true }); }
        if (kind === 'nested accessor') Object.defineProperty(g.state.input.flags.enabled, 'dashboard', { enumerable: true, get() { getters++; return true; } });
        if (kind === 'prototype') Object.setPrototypeOf(g.state.input.flags.enabled, { supplied: true });
        await unavailableDecision(() => createDashboardAdmissionDecision(g.adapters)(request));
        await denied(() => createDashboardAdmission(g.adapters)(request));
    }
    assert.equal(getters, 0); assert.equal(injected, 0); await parity(admissionFixture());
});

test('HA01 future product starts exactly at its inclusive lower bound', async () => {
    const f = admissionFixture(); f.state.input.entitlementState.grants[0].validFrom = CUTOFF;
    await parity(f, null, 'denied'); f.state.now = CUTOFF; await parity(f);
});

test('HA02 product expiry is exclusive in actual typed and legacy projections', async () => {
    const f = admissionFixture(); f.state.input.entitlementState.grants[0].validUntil = CUTOFF;
    await parity(f); f.state.now = CUTOFF; await parity(f, null, 'denied');
});

test('HA03 only selected advisor expiry removes its otherwise eligible module', async () => {
    const f = admissionFixture({ role: 'fractional_advisor', service: 'fractional_advisory' });
    f.state.input.advisorAssignments.cyber_security.validUntil = CUTOFF;
    await parity(f, 'cyber_security'); f.state.now = CUTOFF; await parity(f, 'cyber_security', 'denied');
});

test('HA04 fractional service expiry alone removes advisor permission without scope prerequisites', async () => {
    const f = admissionFixture({ role: 'fractional_advisor', service: 'fractional_advisory' });
    const service = f.state.input.entitlementState.grants[1];
    service.validUntil = CUTOFF; service.modules = []; service.coverage = []; service.actions = [];
    await parity(f, 'cyber_security'); f.state.now = CUTOFF; await parity(f, 'cyber_security', 'denied');
});

test('HA05 one overlapping fractional grant survives the first service cutoff', async () => {
    const f = admissionFixture({ role: 'fractional_advisor', service: 'fractional_advisory' });
    const first = f.state.input.entitlementState.grants[1], second = { ...copied(first), grantId: 'synthetic-surviving-service' };
    first.validUntil = CUTOFF; f.state.input.entitlementState.grants.push(second);
    await parity(f, 'cyber_security'); f.state.now = CUTOFF; await parity(f, 'cyber_security');
});

test('HA06 expired advisor never restricts independently granted normal permission', async () => {
    const f = admissionFixture({ role: 'fractional_advisor' });
    for (const row of [...f.state.input.membershipState.memberships, ...f.state.input.membershipState.invitations]) row.roles = ['admin', 'fractional_advisor'];
    f.state.input.advisorAssignments.cyber_security.validUntil = CUTOFF;
    await parity(f, 'cyber_security'); f.state.now = CUTOFF;
    assert.equal(keys((await parity(f, 'cyber_security')).projection).length, 8);
});

test('HA07 entitled disabled neighboring advisor expiry changes bootstrap module vector', async () => {
    const f = admissionFixture({ role: 'fractional_advisor', service: 'fractional_advisory', enabled: { cyber_security: false } });
    viewerAdvisor(f); f.state.input.advisorAssignments.cyber_security.validUntil = CUTOFF;
    const before = (await parity(f)).projection;
    assert.equal(before.modules.find(row => row.key === 'cyber_security').state, 'disabled');
    f.state.now = CUTOFF; const after = (await parity(f)).projection;
    assert.ok(keys(after).includes('overview')); assert.ok(!keys(after).includes('cyber_security'));
});

test('HA08 adjacent real product handoff changes label while Cyber remains allowed', async () => {
    const f = admissionFixture(), score = admissionFixture({ tier: 'dashboard_score' }).state.input.entitlementState.grants[0];
    const govern = f.state.input.entitlementState.grants[0];
    score.validUntil = CUTOFF; govern.validFrom = CUTOFF; govern.grantId = 'synthetic-next-product';
    f.state.input.entitlementState.grants = [score, govern];
    const before = (await parity(f, 'cyber_security')).projection;
    assert.equal(before.subscription, 'Score');
    f.state.now = CUTOFF; const after = (await parity(f, 'cyber_security')).projection;
    assert.equal(after.subscription, 'Govern');
    assert.ok(keys(before).includes('cyber_security') && keys(after).includes('cyber_security'));
});
