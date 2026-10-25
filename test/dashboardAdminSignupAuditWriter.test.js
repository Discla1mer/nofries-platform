'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createSignupAuditEnvelope, projectSignupAuditRow } = require('../api/shared/dashboardAdmin/signupAuditEnvelope');
const { persistSignupAudit, reconcileSignupAudit, DashboardAdminSignupAuditWriterError } = require('../api/shared/dashboardAdmin/postgresSignupAuditWriter');
const { hash } = require('../api/shared/appLifecycle/dashboardRuntimeRecords');
const uid = n => '72000000-0000-4000-8000-' + String(n).padStart(12, '0');
const ACTOR = uid(1) + ':' + uid(2), NOW = '2026-10-20T22:00:00.000Z';
const clone = value => JSON.parse(JSON.stringify(value));
function envelope(outcome = 'requested', eventId = outcome === 'requested' ? uid(3) : uid(4)) {
    const authority = { schemaVersion: 1, capability: 'signupList', operatorSubjectKey: ACTOR,
        provider: 'external', tenantId: 'synthetic-tenant', populationId: 'synthetic-population', indexId: 'synthetic-index',
        authorityRevision: 1, issuedAt: '2026-10-20T21:59:00.000Z', expiresAt: '2026-10-20T22:01:00.000Z',
        maxPageSize: 25, maxRows: 100, maxPages: 10, fields: ['email', 'organisation', 'accountType', 'milestones'], auditPolicyId: 'synthetic-audit' };
    return createSignupAuditEnvelope({ authority, eventId,
        nativeBinding: { requestId: uid(5), sessionSha256: 'a'.repeat(64), instanceId: uid(6), actorSubjectKey: ACTOR },
        serviceEvent: { schemaVersion: 1, category: 'dashboard_admin_signup_list', requestId: uid(7), actorSubjectKey: ACTOR,
            authoritySha256: hash(authority), requestSha256: hash({ cursor: null }), page: 1,
            phase: outcome === 'requested' ? 'attempt' : 'outcome', outcome, count: outcome === 'available' ? 1 : 0, occurredAt: NOW } });
}
function harness(initial = []) {
    const rows = initial.map(value => clone(projectSignupAuditRow(value)));
    const tx = { query: jest.fn(async (sql, values) => {
        if (sql.startsWith('SELECT pg_advisory')) return { rows: [] };
        if (sql.startsWith('SELECT event_id')) return { rows: clone(rows.filter(row => row.instance_id === values[0] &&
            row.session_sha256 === values[1] && row.request_id === values[2] && row.payload.serviceEvent.requestId === values[3] &&
            row.payload.serviceEvent.phase === values[4])) };
        if (sql.startsWith('INSERT INTO nofries.dashboard_runtime_audit')) {
            const keys = sql.match(/\(([^)]+)\)/)[1].split(', ');
            // Match the existing database's NOT NULL JSONB column. A JS null
            // SQL parameter is different from JSON text representing null.
            if (values[keys.indexOf('scope_json')] === null) throw new Error('synthetic scope_json NOT NULL violation');
            const row = Object.fromEntries(keys.map((key, i) => [key, values[i] !== null && ['scope_json', 'payload'].includes(key)
                ? JSON.parse(values[i]) : values[i]]));
            if (rows.some(existing => existing.event_id === row.event_id)) throw new Error('synthetic event conflict');
            rows.push(row); return { rowCount: 1 };
        }
        throw new Error('unexpected synthetic SQL');
    }) };
    return { tx, rows, writes: () => tx.query.mock.calls.filter(([sql]) => sql.startsWith('INSERT')) };
}
async function unavailable(work) {
    await expect(work()).rejects.toBeInstanceOf(DashboardAdminSignupAuditWriterError);
}

test('writes one exact attempt with the existing JSONB-null scope contract, native phase lock and no durability capability', async () => {
    const h = harness(), attempt = envelope();
    const schema = fs.readFileSync(path.join(__dirname, '../database/migrations/0005_dashboard_runtime.sql'), 'utf8');
    expect(schema).toContain('scope_json jsonb NOT NULL');
    expect(schema).toContain("tenant_id IS NULL AND organisation_id IS NULL AND scope_json='null'::jsonb");
    await expect(persistSignupAudit(h.tx, attempt)).resolves.toBeUndefined();
    expect(h.rows).toEqual([projectSignupAuditRow(attempt)]);
    expect(h.writes()).toHaveLength(1); expect(h.writes()[0][1].slice(5, 8)).toEqual([null, null, 'null']);
    expect(h.tx.query.mock.calls[0]).toEqual(['SELECT pg_advisory_xact_lock($1::integer, hashtext($2))',
        [71005, JSON.stringify(['dashboard.admin.signup_list', attempt.instanceId, attempt.sessionSha256,
            attempt.event.requestId, attempt.event.serviceEvent.requestId])]]);
    expect(h.tx.query.mock.calls.some(([sql]) => /COMMIT|ROLLBACK|UPDATE |DELETE |ON CONFLICT|CREATE |SET LOCAL/.test(sql))).toBe(false);
    expect(h.tx.query.mock.calls.every(([sql]) => /^(SELECT|INSERT)/.test(sql))).toBe(true);
});

test.each(['available', 'unavailable', 'denied'])('retains one immutable %s outcome after exact attempt readback', async outcome => {
    const attempt = envelope(), terminal = envelope(outcome), h = harness();
    await persistSignupAudit(h.tx, attempt); await persistSignupAudit(h.tx, attempt);
    await persistSignupAudit(h.tx, terminal, attempt); await persistSignupAudit(h.tx, terminal, attempt);
    expect(h.writes()).toHaveLength(2); expect(h.rows).toEqual([projectSignupAuditRow(attempt), projectSignupAuditRow(terminal)]);
    const phases = h.tx.query.mock.calls.filter(([sql]) => sql.startsWith('SELECT event_id')).map(([, values]) => values[4]);
    expect(phases).toEqual(['attempt', 'attempt', 'attempt', 'outcome', 'attempt', 'outcome']);
});

test('outcome requires a retained exact attempt; a caller-supplied structural pair cannot substitute', async () => {
    for (const supplied of [null, envelope()]) {
        const h = harness(); await unavailable(() => persistSignupAudit(h.tx, envelope('available'), supplied)); expect(h.writes()).toHaveLength(0);
    }
    const h = harness([envelope()]); h.rows[0].event_sha256 = 'b'.repeat(64);
    await unavailable(() => persistSignupAudit(h.tx, envelope('available'), envelope())); expect(h.writes()).toHaveLength(0);
});

test('occupied phases cannot change ID, time, population or outcome', async () => {
    const attempt = envelope(), terminal = envelope('available');
    for (const change of [v => { v.event.eventId = uid(9); }, v => { v.event.population.indexId = 'changed'; },
        v => { v.event.occurredAt = v.event.serviceEvent.occurredAt = '2026-10-20T22:00:00.001Z';
            v.event.serviceEventSha256 = hash(v.event.serviceEvent); }]) {
        const h = harness([attempt]), changed = clone(attempt); change(changed);
        await unavailable(() => persistSignupAudit(h.tx, changed)); expect(h.writes()).toHaveLength(0);
    }
    const h = harness([attempt, terminal]);
    await unavailable(() => persistSignupAudit(h.tx, envelope('unavailable'), attempt));
    await unavailable(() => persistSignupAudit(h.tx, envelope('available', uid(9)), attempt)); expect(h.writes()).toHaveLength(0);
});

test.each(['session', 'instance', 'native', 'population', 'service', 'authority', 'request', 'page'])
('changed %s binding rejects outcome before SQL', change => {
    const attempt = envelope(), terminal = clone(envelope('available')), h = harness([attempt]);
    if (change === 'session') terminal.sessionSha256 = 'b'.repeat(64);
    if (change === 'instance') terminal.instanceId = uid(9);
    if (change === 'native') terminal.event.requestId = uid(9);
    if (change === 'population') terminal.event.population.populationId = 'other';
    if (change === 'service') terminal.event.serviceEvent.requestId = uid(9);
    if (change === 'authority') terminal.event.serviceEvent.authoritySha256 = 'b'.repeat(64);
    if (change === 'request') terminal.event.serviceEvent.requestSha256 = 'b'.repeat(64);
    if (change === 'page') terminal.event.serviceEvent.page = 2;
    terminal.event.serviceEventSha256 = hash(terminal.event.serviceEvent);
    return unavailable(() => persistSignupAudit(h.tx, terminal, attempt)).then(() => expect(h.tx.query).not.toHaveBeenCalled());
});

test.each(['requested', 'available'])('reconciles %s by exact SELECT-only readback, never INSERT on absence', async outcome => {
    const attempt = envelope(), expected = envelope(outcome), supplied = outcome === 'requested' ? null : attempt;
    const h = harness(outcome === 'requested' ? [attempt] : [attempt, expected]);
    await expect(reconcileSignupAudit(h.tx, expected, supplied)).resolves.toBeUndefined();
    expect(h.tx.query.mock.calls.every(([sql]) => sql.startsWith('SELECT'))).toBe(true);
    const absent = harness(outcome === 'requested' ? [] : [attempt]);
    await unavailable(() => reconcileSignupAudit(absent.tx, expected, supplied)); expect(absent.writes()).toHaveLength(0);
});

test('uncertain insertion stops without retry; separate reconciliation must find that exact original event', async () => {
    const attempt = envelope(), h = harness(), query = h.tx.query;
    h.tx.query = jest.fn(async (sql, values) => {
        const result = await query(sql, values);
        if (sql.startsWith('INSERT')) throw new Error('synthetic private driver failure');
        return result;
    });
    await unavailable(() => persistSignupAudit(h.tx, attempt)); expect(h.tx.query.mock.calls.at(-1)[0]).toMatch(/^INSERT/);
    await reconcileSignupAudit(h.tx, attempt); expect(h.writes()).toHaveLength(1);
    await unavailable(() => reconcileSignupAudit(h.tx, envelope('requested', uid(9)))); expect(h.writes()).toHaveLength(1);
});

test.each(['duplicate', 'hash', 'extra', 'wrong native', 'forged scope'])('rejects %s retained row', async change => {
    const attempt = envelope(), h = harness([attempt]);
    if (change === 'duplicate') h.rows.push(clone(h.rows[0]));
    if (change === 'hash') h.rows[0].event_sha256 = 'b'.repeat(64);
    if (change === 'extra') h.rows[0].diagnostic = 'synthetic excluded';
    if (change === 'wrong native') h.rows[0].request_id = uid(9);
    if (change === 'forged scope') h.rows[0].organisation_id = 'invented';
    await unavailable(() => reconcileSignupAudit(h.tx, attempt)); expect(h.writes()).toHaveLength(0);
});

test('caller mutation during lock wait cannot change the retained phase', async () => {
    const supplied = clone(envelope()), expected = clone(supplied), h = harness(), query = h.tx.query;
    let release;
    h.tx.query = jest.fn(async (sql, values) => {
        if (sql.startsWith('SELECT pg_advisory')) await new Promise(resolve => { release = resolve; });
        return query(sql, values);
    });
    const pending = persistSignupAudit(h.tx, supplied);
    supplied.event.population.indexId = 'changed'; supplied.event.serviceEvent.authoritySha256 = 'b'.repeat(64);
    release(); await pending; expect(h.rows).toEqual([projectSignupAuditRow(expected)]);
});

test.each([0, 2, undefined])('INSERT rowCount %s is not accepted', async rowCount => {
    const h = harness(), query = h.tx.query;
    h.tx.query = jest.fn(async (sql, values) => sql.startsWith('INSERT') ? { rowCount } : query(sql, values));
    await unavailable(() => persistSignupAudit(h.tx, envelope()));
});

test('invalid transactions or hostile input perform no SQL and expose only the fixed error', async () => {
    for (const tx of [null, {}, { query: true }, new Proxy({}, {})]) await unavailable(() => persistSignupAudit(tx, envelope()));
    const h = harness(), supplied = clone(envelope()); let invoked = 0;
    Object.defineProperty(supplied.event.serviceEvent, 'count', { enumerable: true, get() { invoked++; return 0; } });
    await unavailable(() => persistSignupAudit(h.tx, supplied)); expect(invoked).toBe(0); expect(h.tx.query).not.toHaveBeenCalled();
});

test('hostile driver result accessors and proxy arrays are rejected without executing hooks or writing', async () => {
    let calls = 0;
    const accessor = {}; Object.defineProperty(accessor, 'rows', { enumerable: true, get() { calls++; return []; } });
    const array = []; Object.defineProperty(array, '0', { enumerable: true, get() { calls++; return null; } });
    const proxy = new Proxy([], { get() { calls++; return 0; } });
    for (const result of [accessor, { rows: array }, { rows: proxy }, { rows: Array(1) }]) {
        const h = harness(), query = h.tx.query;
        h.tx.query = jest.fn(async (sql, values) => sql.startsWith('SELECT event_id') ? result : query(sql, values));
        await unavailable(() => persistSignupAudit(h.tx, envelope())); expect(h.writes()).toHaveLength(0);
    }
    expect(calls).toBe(0);
});
