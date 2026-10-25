'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createAuditEnvelope, projectAuditRow } = require('../api/shared/dashboardAdmin/auditEnvelope');
const { normaliseSelector } = require('../api/shared/dashboardAdmin/service');
const { persistAudit, reconcileAudit, DashboardAdminAuditWriterError } = require('../api/shared/dashboardAdmin/postgresAuditWriter');

const ACTOR = '10000000-0000-4000-8000-000000000001:10000000-0000-4000-8000-000000000002';
const TARGET = '20000000-0000-4000-8000-000000000001:20000000-0000-4000-8000-000000000002';
const uid = n => '30000000-0000-4000-8000-' + String(n).padStart(12, '0');
const NOW = '2026-10-19T00:00:00.000Z';
const clone = value => JSON.parse(JSON.stringify(value));
function envelope(outcome = 'attempt', eventId = outcome === 'attempt' ? uid(3) : uid(4)) {
    const selector = normaliseSelector({ provider: 'external', subjectKey: TARGET,
        tenantId: 'synthetic-tenant', organisationId: 'synthetic-organisation' });
    return createAuditEnvelope({ selector, eventId,
        nativeBinding: { requestId: uid(1), sessionSha256: 'a'.repeat(64), instanceId: uid(5), actorSubjectKey: ACTOR },
        serviceEvent: { schemaVersion: 1, category: 'dashboard_admin_read', requestId: uid(2), actorSubjectKey: ACTOR,
            targetSha256: createHash('sha256').update(JSON.stringify(selector)).digest('hex'), outcome, occurredAt: NOW } });
}
function harness(initial = []) {
    const rows = initial.map(value => clone(projectAuditRow(value)));
    const tx = { query: jest.fn(async (sql, values) => {
        if (sql.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [] };
        if (sql.startsWith('SELECT event_id')) return { rows: clone(rows.filter(row =>
            row.instance_id === values[0] && row.session_sha256 === values[1] && row.request_id === values[2] &&
            row.payload.lookupRequestId === values[3] && row.payload.phase === values[4])) };
        if (sql.startsWith('INSERT INTO nofries.dashboard_runtime_audit')) {
            const keys = sql.match(/\(([^)]+)\)/)[1].split(', ');
            const row = Object.fromEntries(keys.map((key, i) => [key, ['scope_json', 'payload'].includes(key) ? JSON.parse(values[i]) : values[i]]));
            if (rows.some(existing => existing.event_id === row.event_id)) throw new Error('synthetic primary key conflict');
            rows.push(row); return { rowCount: 1 };
        }
        throw new Error('Unexpected synthetic SQL');
    }) };
    const writes = () => tx.query.mock.calls.filter(([sql]) => sql.startsWith('INSERT'));
    return { tx, rows, writes };
}
async function unavailable(work) {
    await expect(work()).rejects.toEqual(expect.objectContaining({
        name: 'Error', message: 'dashboard_admin_audit_unavailable', code: 'dashboard_admin_audit_unavailable', statusCode: 503
    }));
}

test('inserts one exact immutable attempt with native phase lock, without owning transaction control or acknowledgement', async () => {
    const h = harness(), attempt = envelope();
    await expect(persistAudit(h.tx, attempt)).resolves.toBeUndefined();
    expect(h.rows).toEqual([projectAuditRow(attempt)]);
    expect(h.writes()).toHaveLength(1);
    expect(h.tx.query.mock.calls[0]).toEqual(['SELECT pg_advisory_xact_lock($1::integer, hashtext($2))',
        [71005, JSON.stringify([attempt.instanceId, attempt.sessionSha256, attempt.event.requestId, attempt.event.lookupRequestId])]]);
    expect(h.tx.query.mock.calls.every(([sql]) => /^(SELECT|INSERT)/.test(sql))).toBe(true);
    expect(h.tx.query.mock.calls.some(([sql]) => /ON CONFLICT|COMMIT|ROLLBACK|UPDATE |DELETE |SET LOCAL|dashboard_session_gates/.test(sql))).toBe(false);
});

test('an exact repeated attempt returns provisionally without another INSERT', async () => {
    const h = harness(), attempt = envelope();
    await persistAudit(h.tx, attempt); await persistAudit(h.tx, attempt);
    expect(h.writes()).toHaveLength(1); expect(h.rows).toHaveLength(1);
});

test.each(['found', 'not_found', 'unavailable'])('terminal %s requires and retains the exact original attempt', async outcome => {
    const attempt = envelope(), terminal = envelope(outcome), h = harness([attempt]);
    await persistAudit(h.tx, terminal, attempt); await persistAudit(h.tx, terminal, attempt);
    expect(h.rows).toEqual([projectAuditRow(attempt), projectAuditRow(terminal)]);
    expect(h.writes()).toHaveLength(1);
    expect(h.tx.query.mock.calls.filter(([sql]) => sql.startsWith('SELECT event_id')).map(([, values]) => values[4]))
        .toEqual(['attempt', 'terminal', 'attempt', 'terminal']);
});

test('a terminal without retained matching attempt never writes; a structural pair is insufficient', async () => {
    for (const supplied of [null, envelope()]) {
        const h = harness(); await unavailable(() => persistAudit(h.tx, envelope('found'), supplied));
        expect(h.writes()).toHaveLength(0);
    }
});

test.each(['event ID', 'time', 'target', 'actor', 'scope'])('different %s cannot replace an occupied attempt slot', async change => {
    const attempt = envelope(), h = harness([attempt]), changed = clone(attempt);
    if (change === 'event ID') changed.event.eventId = uid(9);
    if (change === 'time') changed.event.occurredAt = '2026-10-19T00:00:00.001Z';
    if (change === 'target') changed.event.targetSha256 = 'b'.repeat(64);
    if (change === 'actor') changed.event.actorSubjectKey = TARGET;
    if (change === 'scope') changed.event.scope.organisationId = 'other';
    await unavailable(() => persistAudit(h.tx, changed)); expect(h.writes()).toHaveLength(0);
});

test('an occupied terminal slot cannot acquire a different terminal outcome or fresh event ID', async () => {
    const attempt = envelope(), h = harness([attempt, envelope('found')]);
    await unavailable(() => persistAudit(h.tx, envelope('unavailable'), attempt));
    await unavailable(() => persistAudit(h.tx, envelope('found', uid(9)), attempt));
    expect(h.writes()).toHaveLength(0);
});

test.each(['native request', 'session', 'instance', 'lookup', 'actor', 'target', 'scope'])
    ('terminal rejects a changed %s binding before SQL', async change => {
        const attempt = envelope(), terminal = clone(envelope('found')), h = harness([attempt]);
        if (change === 'native request') terminal.event.requestId = uid(9);
        if (change === 'session') terminal.sessionSha256 = 'b'.repeat(64);
        if (change === 'instance') terminal.instanceId = uid(9);
        if (change === 'lookup') terminal.event.lookupRequestId = uid(9);
        if (change === 'actor') terminal.event.actorSubjectKey = TARGET;
        if (change === 'target') terminal.event.targetSha256 = 'b'.repeat(64);
        if (change === 'scope') terminal.event.scope.organisationId = 'other';
        await unavailable(() => persistAudit(h.tx, terminal, attempt)); expect(h.tx.query).not.toHaveBeenCalled();
    });

test('a mismatching retained attempt denies terminal even when the supplied pair agrees', async () => {
    const attempt = envelope(), h = harness([attempt]); h.rows[0].event_sha256 = 'b'.repeat(64);
    await unavailable(() => persistAudit(h.tx, envelope('found'), attempt)); expect(h.writes()).toHaveLength(0);
});

test.each(['attempt', 'found'])('reconciliation of %s reads exactly retained phases and never inserts', async outcome => {
    const attempt = envelope(), expected = envelope(outcome), h = harness(outcome === 'attempt' ? [attempt] : [attempt, expected]);
    await expect(reconcileAudit(h.tx, expected, outcome === 'attempt' ? null : attempt)).resolves.toBeUndefined();
    expect(h.writes()).toHaveLength(0); expect(h.tx.query.mock.calls.every(([sql]) => sql.startsWith('SELECT'))).toBe(true);
    const absent = harness(outcome === 'attempt' ? [] : [attempt]);
    await unavailable(() => reconcileAudit(absent.tx, expected, outcome === 'attempt' ? null : attempt));
    expect(absent.writes()).toHaveLength(0);
});

test('an uncertain insert stops immediately; only a separate exact reconciliation can establish retained evidence', async () => {
    const attempt = envelope(), h = harness(), original = h.tx.query;
    let insert = false;
    h.tx.query = jest.fn(async (sql, values) => {
        const result = await original(sql, values);
        if (sql.startsWith('INSERT')) { insert = true; throw new Error('synthetic private driver failure'); }
        return result;
    });
    await unavailable(() => persistAudit(h.tx, attempt)); expect(insert).toBe(true);
    expect(h.tx.query.mock.calls.at(-1)[0]).toMatch(/^INSERT/);
    await reconcileAudit(h.tx, attempt); expect(h.writes()).toHaveLength(1);
});

test.each(['duplicate', 'corrupt hash', 'wrong native row', 'extra column'])('rejects %s retained evidence without insertion', async change => {
    const attempt = envelope(), h = harness([attempt]);
    if (change === 'duplicate') h.rows.push(clone(h.rows[0]));
    if (change === 'corrupt hash') h.rows[0].event_sha256 = 'b'.repeat(64);
    if (change === 'wrong native row') h.rows[0].request_id = uid(9);
    if (change === 'extra column') h.rows[0].diagnostic = 'synthetic excluded field';
    await unavailable(() => reconcileAudit(h.tx, attempt)); expect(h.writes()).toHaveLength(0);
});

test('detaches the immutable phase before waiting for its lock', async () => {
    const attempt = clone(envelope()), expected = clone(attempt), h = harness();
    const original = h.tx.query; let release;
    h.tx.query = jest.fn(async (sql, values) => {
        if (sql.startsWith('SELECT pg_advisory')) await new Promise(resolve => { release = resolve; });
        return original(sql, values);
    });
    const pending = persistAudit(h.tx, attempt);
    attempt.event.occurredAt = '2026-10-19T00:00:00.001Z'; attempt.event.scope.organisationId = 'changed';
    release(); await pending; expect(h.rows).toEqual([projectAuditRow(expected)]);
});

test.each([0, 2, undefined])('a non-single INSERT row count %s cannot become acknowledgement', async rowCount => {
    const h = harness(), original = h.tx.query;
    h.tx.query = jest.fn(async (sql, values) => sql.startsWith('INSERT') ? { rowCount } : original(sql, values));
    await unavailable(() => persistAudit(h.tx, envelope()));
});

test('exports no native session, pool, COMMIT or arbitrary SQL capability', () => {
    expect(Object.keys(require('../api/shared/dashboardAdmin/postgresAuditWriter')).sort())
        .toEqual(['DashboardAdminAuditWriterError', 'persistAudit', 'reconcileAudit']);
});

test('the unapplied SQL proposal preserves exact old payload branches and adds closed phase uniqueness without privilege changes', () => {
    const proposal = fs.readFileSync(path.join(__dirname, '../database/proposals/dashboard_admin_lookup_audit.sql'), 'utf8');
    const predecessor = fs.readFileSync(path.join(__dirname, '../database/migrations/0006_dashboard_host_events.sql'), 'utf8');
    const predicate = predecessor.slice(predecessor.indexOf('CHECK ('), predecessor.lastIndexOf(';'));
    expect(proposal).toContain(predicate);
    expect(proposal).toContain('UNAPPLIED PROPOSAL ONLY');
    expect(proposal).toMatch(/\(instance_id, session_sha256, request_id,\s*\(payload->>'lookupRequestId'\), \(payload->>'phase'\)\)/);
    expect(proposal).not.toMatch(/\b(?:GRANT|REVOKE|CREATE POLICY|ALTER POLICY|DROP POLICY|UPDATE|DELETE)\b/);
});
