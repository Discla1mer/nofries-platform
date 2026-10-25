'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const test = global.test || require('node:test');
const { createTenantRequestContext, requireTenantRequestContext } = require('../api/shared/appLifecycle/tenantRequestContext');
const { createDashboardAdmission } = require('../api/shared/dashboardAdmission');
const { admissionFixture } = require('./fixtures/dashboardAdmissionFixture');
const { SUBJECT, NOW } = require('./fixtures/dashboardFixture');
const FOREIGN = '11111111-1111-1111-1111-111111111111:22222222-2222-2222-2222-222222222222';
const copy = value => JSON.parse(JSON.stringify(value));

function harness(overrides = {}) {
    const h = admissionFixture();
    const adapters = { authenticate: h.adapters.authenticate, resolveScope: h.adapters.resolveScope,
        clock: h.adapters.clock, createRequestId: randomUUID, ...overrides };
    return { ...h, context: createTenantRequestContext(adapters), adapters };
}

test('parallel protected consumers resolve identity and selection once without reading caller context', async () => {
    const h = harness();
    const request = { headers: { 'x-tenant-id': 'foreign', 'x-request-id': 'secret-client-id' },
        body: { subjectKey: FOREIGN, tenantId: 'foreign' }, tenantContext: { tenantId: 'foreign' } };
    const contexts = await Promise.all(Array.from({ length: 20 }, () => h.context.resolve(request)));
    assert.ok(contexts.every(value => value === contexts[0]));
    assert.equal(h.state.calls.filter(value => value === 'authenticate').length, 1);
    assert.equal(h.state.calls.filter(value => value === 'resolveScope').length, 1);
    const context = contexts[0];
    assert.equal(context.identity.subjectKey, SUBJECT);
    assert.deepEqual(context.scope, h.state.scope);
    assert.notEqual(context.requestId, request.headers['x-request-id']);
    assert.ok(Object.isFrozen(context)); assert.ok(Object.isFrozen(context.identity)); assert.ok(Object.isFrozen(context.scope));
    h.state.scope.tenantId = 'changed-after-resolution'; h.state.subjectKey = FOREIGN;
    assert.equal((await h.context.resolve(request)).scope.tenantId, h.state.input.scope.tenantId);
    assert.equal((await h.context.authenticate(request)).subjectKey, SUBJECT);
    assert.equal(requireTenantRequestContext(context), context);
});

test('interleaved requests retain their own verified subjects and selected tenants', async () => {
    const requests = [{}, {}], releases = [];
    const identities = new Map([[requests[0], SUBJECT], [requests[1], FOREIGN]]);
    const context = createTenantRequestContext({
        authenticate: async request => { await new Promise(resolve => releases.push(resolve));
            return { authenticated: true, subjectKey: identities.get(request) }; },
        resolveScope: async (request, identity) => ({ tenantId: identity.subjectKey === SUBJECT ? 'tenant-a' : 'tenant-b',
            organisationId: identity.subjectKey === SUBJECT ? 'org-a' : 'org-b' }),
        clock: () => NOW, createRequestId: randomUUID });
    const a = context.resolve(requests[0]), b = context.resolve(requests[1]);
    await Promise.resolve();
    releases[1](); const second = await b; releases[0](); const first = await a;
    assert.equal(first.scope.tenantId, 'tenant-a'); assert.equal(second.scope.tenantId, 'tenant-b');
    assert.equal(first.identity.subjectKey, SUBJECT); assert.equal(second.identity.subjectKey, FOREIGN);
    assert.notEqual(first.requestId, second.requestId);
    await assert.rejects(context.resolveScope(requests[0], second.identity), /tenant_request_context_denied/);
});

test('failed resolution is shared and retained for a request, while a new request can recover', async () => {
    const h = harness(); h.state.authenticated = false;
    const request = {}, attempts = [h.context.resolve(request), h.context.resolve(request)];
    assert.equal(attempts[0], attempts[1]);
    for (const attempt of attempts) await assert.rejects(attempt, /tenant_request_context_denied/);
    h.state.authenticated = true;
    await assert.rejects(h.context.resolve(request), /tenant_request_context_denied/);
    assert.equal(h.state.calls.filter(value => value === 'authenticate').length, 1);
    assert.equal((await h.context.resolve({})).identity.subjectKey, SUBJECT);
});

test('existing admission composes one context but reloads policy and detects current revocation', async () => {
    const h = harness(), request = {};
    let snapshots = 0;
    const admit = createDashboardAdmission({ clock: h.adapters.clock,
        authenticate: h.context.authenticate, resolveScope: h.context.resolveScope,
        loadSnapshot: async () => {
            snapshots += 1;
            const { tenantAggregate, membershipState, entitlementState, flags, advisorAssignments, summary } = h.state.input;
            return { tenantAggregate, membershipState, entitlementState, flags, advisorAssignments, summary: summary ?? null };
        } });
    await admit(request);
    h.state.input.flags.enabled.dashboard = false;
    await assert.rejects(admit(request), /dashboard_access_denied/);
    assert.equal(snapshots, 2);
    assert.equal(h.state.calls.filter(value => value === 'authenticate').length, 1);
    assert.equal(h.state.calls.filter(value => value === 'resolveScope').length, 1);
});

for (const [label, replacement] of [
    ['unverified principal', { authenticate: async () => ({ authenticated: 'true', subjectKey: SUBJECT }) }],
    ['principal metadata', { authenticate: async () => ({ authenticated: true, subjectKey: SUBJECT, token: 'secret' }) }],
    ['foreign-style identity', { authenticate: async () => ({ authenticated: true, subjectKey: 'person@example.test' }) }],
    ['wildcard tenant', { resolveScope: async () => ({ tenantId: '*', organisationId: 'org' }) }],
    ['scope metadata', { resolveScope: async () => ({ tenantId: 'tenant', organisationId: 'org', password: 'secret' }) }],
    ['bad timestamp', { clock: () => '2026-02-30T00:00:00.000Z' }],
    ['caller-style correlation', { createRequestId: () => 'secret-client-input' }],
    ['upstream exception', { authenticate: async () => { throw new Error('secret-provider-response'); } }]
]) test(`${label} fails generically without context or private error`, async () => {
    await assert.rejects(harness(replacement).context.resolve({}), error => error.code === 'tenant_request_context_denied' &&
        error.statusCode === 403 && !JSON.stringify(error).includes('secret'));
});

test('accessors are rejected without execution and contexts cannot be forged or cloned', async () => {
    let reads = 0;
    const h = harness({ resolveScope: async () => ({ get tenantId() { reads += 1; return 'tenant'; }, organisationId: 'org' }) });
    await assert.rejects(h.context.resolve({}), /tenant_request_context_denied/);
    assert.equal(reads, 0);
    const valid = await harness().context.resolve({});
    for (const value of [copy(valid), { ...valid }, null, Object.create(valid)]) {
        assert.throws(() => requireTenantRequestContext(value), /tenant_request_context_denied/);
    }
});
