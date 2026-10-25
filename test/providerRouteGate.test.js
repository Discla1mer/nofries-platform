'use strict';

const assert = require('node:assert/strict');
const test = global.test || require('node:test');
const { fixture, SUBJECT, NOW } = require('./fixtures/dashboardFixture');
const { admissionFixture } = require('./fixtures/dashboardAdmissionFixture');
const { createDashboardService } = require('../api/shared/dashboardService');
const { normaliseExternalReference } = require('../api/shared/appLifecycle/customerOperations');
const { ROUTES, ProviderRouteGateError, normaliseProviderBinding, createProviderRouteGuard } = require('../api/shared/appLifecycle/providerRouteGate');
const { createTenantRequestContext, requireTenantRequestContext } = require('../api/shared/appLifecycle/tenantRequestContext');

const copy = value => JSON.parse(JSON.stringify(value));
const ago = minutes => new Date(Date.parse(NOW) - minutes * 60000).toISOString();
const later = minutes => new Date(Date.parse(NOW) + minutes * 60000).toISOString();

function harness(routeKey = 'autotask/tickets', options = {}) {
    const route = ROUTES[routeKey];
    const input = copy(fixture({ service: route.code, ...options }));
    const state = { now: NOW, authenticated: true, subjectKey: SUBJECT,
        target: { ...input.scope, targetId: 'synthetic-target' }, calls: [], audits: [], snapshot: {
            tenantAggregate: input.tenantAggregate, membershipState: input.membershipState,
            entitlementState: input.entitlementState, flags: input.flags,
            advisorAssignment: null,
            providerPolicy: { system: route.system, providerScopeId: 'synthetic-provider-account',
                revision: 1, maxBindingAgeMs: 3600000, updatedAt: ago(60) },
            binding: { schemaVersion: 1, bindingId: 'synthetic-binding', ...input.scope,
                targetId: 'synthetic-target', system: route.system, recordType: route.recordTypes[0],
                providerScopeId: 'synthetic-provider-account', externalId: 'synthetic-external-private-id',
                status: 'verified', verifiedAt: ago(30), validUntil: later(60),
                verificationEvidenceId: 'synthetic-verification', revision: 2, updatedAt: ago(30) }
        } };
    const adapters = {
        authenticate: async () => {
            state.calls.push('authenticate');
            return { authenticated: state.authenticated, subjectKey: state.subjectKey };
        },
        resolveTarget: async (request, identity, key) => {
            state.calls.push('resolveTarget'); assert.ok(Object.isFrozen(identity)); assert.equal(key, routeKey);
            return state.target;
        },
        loadSnapshot: async (target, identity, key) => {
            state.calls.push('loadSnapshot'); assert.ok(Object.isFrozen(target)); assert.ok(Object.isFrozen(identity));
            assert.equal(key, routeKey); return state.snapshot;
        },
        clock: () => { state.calls.push('clock'); return state.now; },
        auditDenial: async event => { state.calls.push('auditDenial'); assert.ok(Object.isFrozen(event)); state.audits.push(event); }
    };
    return { state, adapters, routeKey, run: () => createProviderRouteGuard(adapters)({ method: 'GET' }, routeKey) };
}
async function rejected(h, reason) {
    await assert.rejects(h.run(), error => error instanceof ProviderRouteGateError && error.statusCode === 403 &&
        error.code === 'provider_route_access_denied' && error.message === 'provider_route_access_denied' &&
        JSON.stringify(error.details) === '{"code":"provider_route_access_denied"}');
    assert.equal(h.state.audits.length, 1);
    if (reason) assert.equal(h.state.audits[0].reason, reason);
}

function assignAdvisor(h) {
    const member = h.state.snapshot.membershipState.memberships[0];
    const assignment = { schemaVersion: 1, assignmentId: 'synthetic-services-assignment',
        tenantId: h.state.target.tenantId, organisationId: h.state.target.organisationId,
        membershipId: member.membershipId, subjectKey: SUBJECT, status: 'active',
        validFrom: member.validFrom, validUntil: member.validUntil, modules: ['services'], permissions: ['services.read'],
        grantEvidenceId: 'synthetic-advisor-evidence', revision: 1, updatedAt: ago(60) };
    h.state.snapshot.advisorAssignment = assignment;
    return assignment;
}

function purchaseAdvisory(h) {
    const service = h.state.snapshot.entitlementState.grants.find(grant => grant.code === ROUTES[h.routeKey].code);
    const advisory = { ...copy(service), grantId: 'synthetic-advisory-purchase', code: 'fractional_advisory',
        agreementRef: 'synthetic-advisory-order', coverage: [], actions: [] };
    h.state.snapshot.entitlementState.grants.push(advisory);
    h.state.snapshot.flags.enabled['service:fractional_advisory'] = true;
    return advisory;
}

for (const routeKey of Object.keys(ROUTES)) {
    test(`${routeKey}: exact current entitlement and binding satisfy only route preconditions`, async () => {
        const h = harness(routeKey), before = copy(h.state.snapshot), result = await h.run();
        assert.equal(result.preconditionsSatisfied, true);
        assert.equal(result.providerAccessGranted, false);
        assert.equal(result.serviceCode, ROUTES[routeKey].code);
        assert.equal(result.binding.system, ROUTES[routeKey].system);
        assert.equal(result.binding.providerScopeId, 'synthetic-provider-account');
        assert.equal(result.binding.externalId, 'synthetic-external-private-id');
        assert.equal(result.bindingRevision, 2);
        assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.binding));
        assert.deepEqual(h.state.snapshot, before); assert.deepEqual(h.state.audits, []);
        assert.deepEqual(h.state.calls, ['authenticate', 'resolveTarget', 'loadSnapshot', 'clock']);
    });
    test(`${routeKey}: a provider binding alone cannot grant service entitlement`, async () => {
        const h = harness(routeKey); h.state.snapshot.entitlementState.grants.pop();
        await rejected(h, 'entitlement_denied');
    });
    test(`${routeKey}: an entitled service without a current binding denies and audits`, async () => {
        const h = harness(routeKey); h.state.snapshot.binding = null;
        await rejected(h, 'binding_denied');
    });
    test(`${routeKey}: stale binding denies at exact freshness boundary`, async () => {
        const h = harness(routeKey); h.state.snapshot.binding.verifiedAt = ago(60);
        await rejected(h, 'binding_denied');
    });
    test(`${routeKey}: revocation between requests is observed without caching`, async () => {
        const h = harness(routeKey), guard = createProviderRouteGuard(h.adapters);
        assert.equal((await guard({ method: 'GET' }, routeKey)).preconditionsSatisfied, true);
        h.state.snapshot.binding.status = 'revoked'; h.state.snapshot.binding.revision += 1;
        h.run = () => guard({ method: 'GET' }, routeKey);
        await rejected(h, 'binding_denied');
        assert.equal(h.state.calls.filter(call => call === 'loadSnapshot').length, 2);
    });
}

for (const [field, value] of [
    ['tenantId', 'foreign-tenant'], ['organisationId', 'foreign-organisation'], ['targetId', 'foreign-target'],
    ['system', 'datto_rmm'], ['recordType', 'contact'], ['recordType', 'company'], ['providerScopeId', 'foreign-account'],
    ['status', 'suspended'], ['status', 'retired'], ['status', 'active'], ['externalId', ''],
    ['verifiedAt', later(1)], ['validUntil', NOW], ['updatedAt', later(1)], ['verificationEvidenceId', ''],
    ['revision', -1], ['verifiedAt', '2026-09-06T08:30:00Z'], ['validUntil', '2026-02-30T10:00:00.000Z'],
    ['externalId', '*'], ['targetId', ' synthetic-target']
]) {
    test(`binding ${field}=${value} fails closed`, async () => {
        const h = harness(); h.state.snapshot.binding[field] = value;
        await rejected(h, 'binding_denied');
    });
}

test('current binding query rejects ambiguous arrays and never chooses first or last', async () => {
    const h = harness(); h.state.snapshot.binding = [h.state.snapshot.binding, copy(h.state.snapshot.binding)];
    await rejected(h, 'binding_denied');
});

// Literal canonical stored types are deliberately independent of ROUTES. These
// values come from lifecycle/provider singleton records, not the new gate map.
for (const [routeKey, system, recordType] of [
    ['autotask/tickets', 'autotask', 'account'],
    ['datto_rmm/devices', 'datto_rmm', 'site'],
    ['kaseya_mdr/alerts', 'kaseya_mdr', 'tenant'],
    ['kaseya_mdr/alerts', 'kaseya_mdr', 'organisation']
]) {
    test(`${system}/${recordType}: current persisted reference requires explicit trusted scoped projection`, async () => {
        const persisted = normaliseExternalReference({ id: 'synthetic-persisted-ref', system, recordType,
            externalId: 'synthetic-persisted-record', providerScopeId: 'synthetic-provider-account',
            status: 'verified', verificationMode: 'manual', verifiedAt: ago(30),
            verifiedBy: 'synthetic-service-owner', evidenceRef: 'synthetic-crosswalk-register', createdAt: ago(60) });
        assert.equal(persisted.recordType, recordType);
        // Persisted references lack the current tenant/organisation/coverage and
        // freshness envelope. Passing them directly must never grant authority.
        const raw = harness(routeKey); raw.state.snapshot.binding = persisted;
        await rejected(raw, 'binding_denied');
        const h = harness(routeKey);
        h.state.snapshot.binding = { schemaVersion: 1, bindingId: persisted.id,
            ...h.state.target, system: persisted.system, recordType: persisted.recordType,
            providerScopeId: persisted.providerScopeId, externalId: persisted.externalId,
            status: persisted.status, verifiedAt: persisted.verifiedAt,
            verificationEvidenceId: persisted.evidenceRef,
            // Ownership above and these current governance fields are supplied by
            // the trusted synthetic loader, not inferred from the legacy record.
            validUntil: later(60), revision: 4, updatedAt: ago(30) };
        const result = await h.run();
        assert.equal(result.binding.recordType, recordType);
        assert.equal(result.binding.externalId, persisted.externalId);
        assert.equal(result.bindingRevision, 4);
        assert.equal(result.providerAccessGranted, false);
    });
}

for (const [field, value] of [['system', 'kaseya_mdr'], ['providerScopeId', 'wrong-account'],
    ['maxBindingAgeMs', 0], ['maxBindingAgeMs', -1], ['maxBindingAgeMs', '3600000'],
    ['updatedAt', later(1)], ['revision', -1]]) {
    test(`provider policy ${field}=${value} cannot be inferred from binding`, async () => {
        const h = harness(); h.state.snapshot.providerPolicy[field] = value;
        await rejected(h, 'binding_denied');
    });
}

for (const change of ['revoked', 'suspended', 'expired', 'wrong_target', 'wrong_action', 'wrong_module', 'disabled', 'ambiguous', 'parent_package']) {
    test(`service ${change} cannot borrow provider authority`, async () => {
        const h = harness(), service = h.state.snapshot.entitlementState.grants[1];
        if (['revoked', 'suspended'].includes(change)) service.status = change;
        if (change === 'expired') service.validUntil = NOW;
        if (change === 'wrong_target') service.coverage = ['different-target'];
        if (change === 'wrong_action') service.actions = ['write'];
        if (change === 'wrong_module') service.modules = ['overview'];
        if (change === 'disabled') h.state.snapshot.flags.enabled['service:tier1_support'] = false;
        if (change === 'ambiguous') h.state.snapshot.entitlementState.grants.push({ ...service, grantId: 'second-service' });
        if (change === 'parent_package') Object.assign(service, { code: 'managed_it_core', modules: [], coverage: [], actions: [] });
        await rejected(h, 'entitlement_denied');
    });
}

test('a dashboard product is not required by an independently purchased provider service', async () => {
    const h = harness(); h.state.snapshot.entitlementState.grants.shift();
    assert.equal((await h.run()).preconditionsSatisfied, true);
});

for (const role of ['admin', 'editor', 'viewer']) {
    test(`${role} service visibility is a precondition and grants no provider record or action authority`, async () => {
        const result = await harness('autotask/tickets', { role }).run();
        assert.equal(result.providerAccessGranted, false);
        assert.equal(result.action, 'view');
    });
}

test('advisor assignment, advisory purchase and provider service are independent preconditions', async () => {
    const h = harness('autotask/tickets', { role: 'fractional_advisor' });
    await rejected(h, 'permission_denied');
    assignAdvisor(h); h.state.audits = [];
    await rejected(h, 'entitlement_denied');
    purchaseAdvisory(h); h.state.audits = [];
    assert.equal((await h.run()).preconditionsSatisfied, true);
    h.state.snapshot.advisorAssignment.status = 'revoked'; h.state.audits = [];
    await rejected(h, 'permission_denied');
});

for (const routeKey of Object.keys(ROUTES)) {
    test(`${routeKey}: an advisor needs both advisory and route service purchases with the exact binding`, async () => {
        const h = harness(routeKey, { role: 'fractional_advisor' });
        assignAdvisor(h);
        await rejected(h, 'entitlement_denied');
        assert.equal(h.state.audits[0].scopeAuthorised, true);
        purchaseAdvisory(h); h.state.audits = [];
        const result = await h.run();
        assert.equal(result.preconditionsSatisfied, true);
        assert.equal(result.providerAccessGranted, false);
        assert.equal(result.serviceCode, ROUTES[routeKey].code);
        assert.equal(result.assignmentRevision, 1);
        h.state.snapshot.entitlementState.grants = h.state.snapshot.entitlementState.grants
            .filter(grant => grant.code !== ROUTES[routeKey].code);
        await rejected(h, 'entitlement_denied');
    });
}

for (const change of ['missing', 'missing_flag', 'disabled', 'suspended', 'revoked',
    'future', 'expired', 'foreign_tenant', 'foreign_organisation', 'unrelated_purchase']) {
    test(`advisor ${change} advisory purchase cannot borrow a route service and binding`, async () => {
        const h = harness('autotask/tickets', { role: 'fractional_advisor' });
        assignAdvisor(h);
        const advisory = purchaseAdvisory(h);
        if (change === 'missing') h.state.snapshot.entitlementState.grants.pop();
        if (change === 'missing_flag') delete h.state.snapshot.flags.enabled['service:fractional_advisory'];
        if (change === 'disabled') h.state.snapshot.flags.enabled['service:fractional_advisory'] = false;
        if (['suspended', 'revoked'].includes(change)) advisory.status = change;
        if (change === 'future') advisory.validFrom = later(1);
        if (change === 'expired') advisory.validUntil = NOW;
        if (change === 'foreign_tenant') advisory.tenantId = 'foreign-tenant';
        if (change === 'foreign_organisation') advisory.organisationId = 'foreign-organisation';
        if (change === 'unrelated_purchase') advisory.code = 'managed_endpoint';
        await rejected(h, 'entitlement_denied');
        assert.equal(h.state.audits[0].scopeAuthorised, true);
        assert.doesNotMatch(JSON.stringify(h.state.audits), /externalId|providerScopeId|synthetic-advisory-order/);
    });
}

for (const role of ['admin', 'editor', 'viewer']) {
    test(`${role} plus advisor retains independent services.read without advisory purchase`, async () => {
        const h = harness('autotask/tickets', { role: 'fractional_advisor' });
        for (const member of [...h.state.snapshot.membershipState.memberships, ...h.state.snapshot.membershipState.invitations]) {
            member.roles = [role, 'fractional_advisor'];
        }
        assignAdvisor(h).status = 'revoked';
        h.state.snapshot.flags.enabled['service:fractional_advisory'] = false;
        const result = await h.run();
        assert.equal(result.preconditionsSatisfied, true);
        assert.equal(result.assignmentRevision, null);
        assert.equal(result.providerAccessGranted, false);
    });
}

for (const change of ['revoked', 'disabled']) {
    test(`advisor purchase ${change} after success is reloaded by the same guard`, async () => {
        const h = harness('autotask/tickets', { role: 'fractional_advisor' });
        assignAdvisor(h);
        const advisory = purchaseAdvisory(h);
        const guard = createProviderRouteGuard(h.adapters);
        h.run = () => guard({ method: 'GET' }, h.routeKey);
        assert.equal((await h.run()).preconditionsSatisfied, true);
        if (change === 'revoked') {
            advisory.status = 'revoked'; h.state.snapshot.entitlementState.revision += 1;
        } else {
            h.state.snapshot.flags.enabled['service:fractional_advisory'] = false;
            h.state.snapshot.flags.revision += 1;
        }
        await rejected(h, 'entitlement_denied');
        assert.equal(h.state.calls.filter(call => call === 'loadSnapshot').length, 2);
    });
}

test('advisor purchase expiry during snapshot loading uses the exclusive post-I/O boundary', async () => {
    const h = harness('autotask/tickets', { role: 'fractional_advisor' });
    assignAdvisor(h);
    const advisory = purchaseAdvisory(h);
    advisory.validUntil = later(1);
    const load = h.adapters.loadSnapshot;
    h.adapters.loadSnapshot = async (...args) => {
        const snapshot = await load(...args); h.state.now = advisory.validUntil; return snapshot;
    };
    await rejected(h, 'entitlement_denied');
    assert.equal(h.state.audits[0].evaluatedAt, advisory.validUntil);
});

test('both advisor and route purchases remain independent of a dashboard product and require a binding', async () => {
    const h = harness('autotask/tickets', { role: 'fractional_advisor' });
    assignAdvisor(h); purchaseAdvisory(h);
    h.state.snapshot.entitlementState.grants.shift();
    assert.equal((await h.run()).preconditionsSatisfied, true);
    h.state.snapshot.binding = null;
    await rejected(h, 'binding_denied');
});

test('a genuine branded request context cannot replace an advisor service purchase', async () => {
    const h = harness('autotask/tickets', { role: 'fractional_advisor' });
    assignAdvisor(h);
    const request = { method: 'GET' };
    const context = createTenantRequestContext({ authenticate: h.adapters.authenticate,
        resolveScope: async () => ({ tenantId: h.state.target.tenantId, organisationId: h.state.target.organisationId }),
        clock: () => h.state.now, createRequestId: () => '20000000-0000-4000-8000-000000000001' });
    const branded = await context.resolve(request);
    assert.equal(requireTenantRequestContext(branded), branded);
    const guard = createProviderRouteGuard({ ...h.adapters, authenticate: context.authenticate,
        resolveTarget: async (req, identity) => ({ ...await context.resolveScope(req, identity), targetId: h.state.target.targetId }) });
    let providerCalls = 0;
    h.run = async () => { await guard(request, h.routeKey); providerCalls += 1; };
    await rejected(h, 'entitlement_denied');
    assert.equal(providerCalls, 0);
    assert.equal(h.state.calls.filter(call => call === 'authenticate').length, 1);
    assert.equal(h.state.audits[0].scopeAuthorised, true);
});

test('unauthenticated and foreign immutable identities never reach provider checks', async () => {
    for (const change of ['unauthenticated', 'foreign', 'email']) {
        const h = harness();
        if (change === 'unauthenticated') h.state.authenticated = false;
        if (change === 'foreign') h.state.subjectKey = SUBJECT.replace(/1$/, '2');
        if (change === 'email') h.state.subjectKey = 'person@synthetic.invalid';
        await rejected(h, change === 'foreign' ? 'permission_denied' : 'identity_denied');
    }
});

for (const owner of ['tenant', 'organisation']) {
    test(`suspended ${owner} denies despite valid purchase and binding`, async () => {
        const h = harness(); const aggregate = h.state.snapshot.tenantAggregate;
        (owner === 'tenant' ? aggregate.tenant : aggregate.organisations[0]).recordStatus = 'suspended';
        await rejected(h, 'permission_denied');
    });
}

test('membership removal is checked again after a previous permitted request', async () => {
    const h = harness(), guard = createProviderRouteGuard(h.adapters);
    assert.equal((await guard({ method: 'GET' }, h.routeKey)).preconditionsSatisfied, true);
    h.state.snapshot.membershipState.memberships[0].status = 'removed';
    h.run = () => guard({ method: 'GET' }, h.routeKey);
    await rejected(h, 'permission_denied');
});

test('expiry during a slow snapshot load is evaluated after I/O', async () => {
    const h = harness(), original = h.adapters.loadSnapshot;
    h.adapters.loadSnapshot = async (...args) => {
        const snapshot = await original(...args); h.state.now = later(60); return snapshot;
    };
    await rejected(h, 'binding_denied');
});

test('snapshot is detached before the clock callback can mutate loader-owned binding data', async () => {
    const h = harness(); h.state.snapshot.binding.status = 'revoked';
    h.adapters.clock = () => { h.state.snapshot.binding.status = 'verified'; return NOW; };
    await rejected(h, 'binding_denied');
});

test('getters, sparse arrays and extra secrets fail without invoking or leaking untrusted data', async () => {
    let reads = 0;
    const h = harness(); Object.defineProperty(h.state.snapshot.binding, 'externalId', { get: () => { reads += 1; return 'secret'; } });
    await rejected(h, 'snapshot_unavailable'); assert.equal(reads, 0);
    const sparse = harness(); delete sparse.state.snapshot.entitlementState.grants[0]; await rejected(sparse, 'snapshot_unavailable');
    const extra = harness(); extra.state.snapshot.binding.token = 'synthetic-secret'; await rejected(extra, 'binding_denied');
    assert.equal(JSON.stringify(extra.state.audits).includes('synthetic-secret'), false);
});

test('unknown routes, encoded alternatives and writes are denied before any provider policy load', async () => {
    for (const [method, key] of [['POST', 'autotask/tickets'], ['GET', 'autotask/tickets/123'],
        ['GET', 'autotask%2Ftickets'], ['GET', 'constructor'], ['GET', '../bootstrap'], ['GET', 'secret-unknown-route']]) {
        const h = harness(); h.run = () => createProviderRouteGuard(h.adapters)({ method }, key);
        await rejected(h, 'request_invalid');
        assert.deepEqual(h.state.calls, ['auditDenial']);
        assert.equal(h.state.audits[0].routeKey, key === 'autotask/tickets' ? key : null);
    }
});

test('denial audit is awaited, sanitised and attributed to trusted internal actor and authorised scope', async () => {
    const h = harness(); h.state.snapshot.binding = null;
    let release, settled = false;
    h.adapters.auditDenial = async event => { h.state.audits.push(event); await new Promise(resolve => { release = resolve; }); };
    const running = h.run().catch(error => { settled = true; return error; });
    while (!release) await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false); release();
    assert.ok(await running instanceof ProviderRouteGateError);
    assert.deepEqual(h.state.audits[0], { schemaVersion: 1, eventType: 'provider_route.denied',
        policyVersion: 1, routeKey: h.routeKey, reason: 'binding_denied', evaluatedAt: NOW,
        actorSubjectKey: SUBJECT, selectedTarget: h.state.target, scopeAuthorised: true });
});

test('concurrent denial audit events retain their own exact immutable internal target', async () => {
    const a = harness(), b = harness('autotask/tickets', { organisationId: 'synthetic-second-org' });
    const events = [];
    const auditDenial = async event => { await new Promise(resolve => setImmediate(resolve)); events.push(event); };
    for (const h of [a, b]) { h.state.snapshot.binding = null; h.adapters.auditDenial = auditDenial; }
    await Promise.all([a.run(), b.run()].map(result => assert.rejects(result, ProviderRouteGateError)));
    assert.deepEqual(events.map(event => event.selectedTarget.organisationId).sort(),
        ['synthetic-second-org', 'synthetic-workshop']);
    assert.ok(events.every(event => Object.isFrozen(event.selectedTarget) && event.scopeAuthorised === true));
    assert.doesNotMatch(JSON.stringify(events), /externalId|providerScopeId|synthetic-external|synthetic-provider-account/);
});

test('audit distinguishes authenticated selected scope from an authorised membership scope', async () => {
    const h = harness(); h.state.subjectKey = SUBJECT.replace(/1$/, '2');
    await rejected(h, 'permission_denied');
    assert.equal(h.state.audits[0].actorSubjectKey, h.state.subjectKey);
    assert.equal(h.state.audits[0].scopeAuthorised, false);
    assert.deepEqual(h.state.audits[0].selectedTarget, h.state.target);
    const early = harness(); early.state.authenticated = false;
    await rejected(early, 'identity_denied');
    assert.equal(early.state.audits[0].actorSubjectKey, null);
    assert.equal(early.state.audits[0].selectedTarget, null);
    assert.equal(early.state.audits[0].scopeAuthorised, false);
});

test('loader and audit failures remain generic and cannot authorise provider execution', async () => {
    const h = harness(); h.adapters.loadSnapshot = async () => { throw new Error('synthetic-secret-and-account'); };
    await rejected(h, 'snapshot_unavailable');
    assert.equal(JSON.stringify(h.state.audits).includes('synthetic-secret'), false);
    const brokenAudit = harness(); brokenAudit.state.snapshot.binding = null;
    let writes = 0, providerCalls = 0;
    brokenAudit.adapters.auditDenial = async () => { writes += 1; throw new Error('synthetic-audit-secret'); };
    const guardedExecutor = async () => { await brokenAudit.run(); providerCalls += 1; };
    await assert.rejects(guardedExecutor(), error => error instanceof ProviderRouteGateError && !error.message.includes('secret'));
    assert.equal(writes, 1); assert.equal(providerCalls, 0);
});

test('dashboard-only routes remain independent and customer projections expose no provider authority', async () => {
    const { adapters } = admissionFixture({ service: 'managed_endpoint' });
    const service = createDashboardService(adapters);
    for (const route of ['bootstrap', 'modules/services', 'modules/overview']) {
        const response = await service.handleRequest({ method: 'GET' }, route);
        assert.equal(response.status, 200); assert.equal(response.body.providerAccessGranted, false);
        assert.doesNotMatch(JSON.stringify(response.body), /providerScopeId|externalId|bindingId|subjectKey|synthetic-external/);
    }
});

test('binding normalisation is deterministic and never supplies activation defaults', () => {
    const h = harness(), before = copy(h.state.snapshot.binding);
    assert.deepEqual(normaliseProviderBinding(before), before);
    assert.ok(Object.isFrozen(normaliseProviderBinding(before)));
    delete before.status;
    assert.throws(() => normaliseProviderBinding(before), ProviderRouteGateError);
});

test('no default audit, clock or production adapters can create a gate', () => {
    const h = harness(); delete h.adapters.auditDenial;
    assert.throws(() => createProviderRouteGuard(h.adapters), ProviderRouteGateError);
    assert.throws(() => createProviderRouteGuard({}), ProviderRouteGateError);
});
