'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const test = global.test || require('node:test');
const { createTenantRequestContext } = require('../api/shared/appLifecycle/tenantRequestContext');
const { createDashboardAudit } = require('../api/shared/appLifecycle/dashboardAudit');
const { SUBJECT, NOW } = require('./fixtures/dashboardFixture');
const operation = { action: 'assessment.write', module: 'cyber_security', result: 'succeeded' };

async function harness(overrides = {}, tenantId = 'synthetic-tenant') {
    const context = await createTenantRequestContext({
        authenticate: async () => ({ authenticated: true, subjectKey: SUBJECT }),
        resolveScope: async () => ({ tenantId, organisationId: `${tenantId}-org` }),
        clock: () => NOW, createRequestId: randomUUID }).resolve({ body: { password: 'secret-body' } });
    const written = [];
    const audit = createDashboardAudit({ writeEvent: async event => written.push(event),
        clock: () => NOW, createEventId: randomUUID, ...overrides });
    return { context, audit, written };
}

test('event envelope captures only canonical actor, selected tenant, action and result; creation has no side effect', async () => {
    const h = await harness(), event = h.audit.createEvent(h.context, operation);
    assert.equal(event.actorSubjectKey, SUBJECT); assert.equal(event.tenantId, 'synthetic-tenant');
    assert.equal(event.action, 'assessment.write'); assert.equal(event.result, 'succeeded');
    assert.equal(event.requestId, h.context.requestId); assert.equal(event.occurredAt, NOW);
    assert.ok(Object.isFrozen(event)); assert.deepEqual(h.written, []);
    assert.deepEqual(Object.keys(event).sort(), ['schemaVersion', 'eventType', 'eventId', 'requestId', 'actorSubjectKey',
        'tenantId', 'organisationId', 'action', 'module', 'result', 'occurredAt'].sort());
    assert.equal(JSON.stringify(event).includes('secret'), false);
    const receipt = await h.audit.writeEvent(event);
    assert.equal(receipt.delivery, 'acknowledged'); assert.equal(receipt.eventId, event.eventId);
    assert.equal(h.written[0], event); assert.equal('committed' in receipt, false);
});

test('sink completion is awaited; uncertain delivery retries the same immutable event identity', async () => {
    let release, calls = 0, complete = false;
    const h = await harness({ writeEvent: async () => { calls += 1;
        if (calls === 1) await new Promise(resolve => { release = resolve; }); } });
    const event = h.audit.createEvent(h.context, operation);
    const pending = h.audit.writeEvent(event).then(value => { complete = true; return value; });
    await Promise.resolve(); assert.equal(complete, false);
    release(); assert.equal((await pending).eventId, event.eventId);
    assert.equal((await h.audit.writeEvent(event)).eventId, event.eventId); assert.equal(calls, 2);
});

test('a sink rejection is generic, does not leak credentials and does not rerun any operation', async () => {
    let calls = 0;
    const h = await harness({ writeEvent: async () => { calls += 1; throw new Error('password=private-provider-response'); } });
    const event = h.audit.createEvent(h.context, operation);
    await assert.rejects(h.audit.writeEvent(event), error => error.code === 'dashboard_audit_unavailable' &&
        error.message === 'dashboard_audit_unavailable' && !JSON.stringify(error).includes('private'));
    assert.equal(calls, 1);
});

test('concurrent tenants cannot override envelope actor or tenant via operation metadata', async () => {
    const [a, b] = await Promise.all([harness({}, 'tenant-a'), harness({}, 'tenant-b')]);
    const events = [a.audit.createEvent(a.context, operation), b.audit.createEvent(b.context, operation)];
    await Promise.all([a.audit.writeEvent(events[0]), b.audit.writeEvent(events[1])]);
    assert.equal(a.written[0].tenantId, 'tenant-a'); assert.equal(b.written[0].tenantId, 'tenant-b');
    assert.notEqual(events[0].requestId, events[1].requestId);
    assert.throws(() => a.audit.createEvent(a.context, { ...operation, tenantId: 'tenant-b' }), /dashboard_audit_unavailable/);
});

for (const changed of [
    { action: 'custom-provider-request' }, { action: '__proto__' }, { action: 'assessment.write\nsecret' },
    { module: 'services' }, { result: 'rolled_back' }, { result: 'success' }, { body: { token: 'secret' } },
    { error: new Error('secret') }, { actorSubjectKey: 'other' }
]) test(`unsupported event data ${Object.keys(changed).join(',')} is rejected before delivery`, async () => {
    const h = await harness();
    assert.throws(() => h.audit.createEvent(h.context, { ...operation, ...changed }), /dashboard_audit_unavailable/);
    assert.deepEqual(h.written, []);
});

test('forged context, foreign envelopes, accessors and invalid event timestamps fail closed', async () => {
    const h = await harness(), other = await harness();
    assert.throws(() => h.audit.createEvent({ ...h.context }, operation), /dashboard_audit_unavailable/);
    const event = h.audit.createEvent(h.context, operation);
    await assert.rejects(h.audit.writeEvent({ ...event }), /dashboard_audit_unavailable/);
    await assert.rejects(other.audit.writeEvent(event), /dashboard_audit_unavailable/);
    let reads = 0;
    assert.throws(() => h.audit.createEvent(h.context, { ...operation,
        get action() { reads += 1; return 'assessment.write'; } }), /dashboard_audit_unavailable/);
    assert.equal(reads, 0);
    const bad = await harness({ clock: () => '2026-01-01T00:00:00.000Z' });
    assert.throws(() => bad.audit.createEvent(bad.context, operation), /dashboard_audit_unavailable/);
    const badId = await harness({ createEventId: () => 'request-password' });
    assert.throws(() => badId.audit.createEvent(badId.context, operation), /dashboard_audit_unavailable/);
});
