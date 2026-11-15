'use strict';
const { createAccountWipeRepository, RESET_TABLES, DELETE_TENANT_TABLES, DELETE_FIRST_TABLES, DELETE_ACCOUNT_TABLES } = require('../api/shared/dashboardAdmin/accountWipeRepository');

const uid = n => '50000000-0000-4000-8000-' + String(n).padStart(12, '0');
const SUBJECT = uid(1) + ':' + uid(2);
const scope = { accountId: uid(10), subjectKey: SUBJECT, tenantIds: [uid(20), uid(21)] };

function fakePool({ owner = 1, scoped = 1, failOn = null, failCode = '23503', leftover = null } = {}) {
    const statements = [], released = [];
    const client = {
        async query(sql, params = []) {
            statements.push([sql, params]);
            if (failOn && sql.includes(failOn)) throw Object.assign(new Error('PRIVATE_DATABASE_DETAIL customer@example.test'), { code: failCode });
            if (sql.startsWith('SELECT 1 FROM nofries.dashboard_starter_accounts')) return { rowCount: owner };
            if (sql.startsWith('SELECT EXISTS') || sql.startsWith('SELECT (EXISTS')) return { rowCount: 1, rows: [{ found: leftover !== null && sql.includes(leftover) }] };
            if (sql.startsWith('SELECT 1 FROM nofries.dashboard_starter_scopes')) return { rowCount: scoped };
            if (sql.startsWith('DELETE')) return { rowCount: 2 };
            return { rowCount: 0 };
        },
        release: discard => released.push(discard)
    };
    return { statements, released, pool: { connect: async () => client } };
}
const deletes = statements => statements.filter(([sql]) => sql.startsWith('DELETE')).map(([sql]) => sql.match(/nofries\.(\w+)/)[1]);

test('delete runs as the wipe capability in one transaction, children before parents, then the account and subject', async () => {
    const f = fakePool(), result = await createAccountWipeRepository(f.pool).delete(scope);
    expect(f.statements[0][0]).toBe('BEGIN');
    expect(f.statements[1][0]).toBe('SET LOCAL ROLE nofries_account_wipe');
    expect(f.statements.at(-1)[0]).toBe('COMMIT');
    expect(deletes(f.statements)).toEqual([...DELETE_FIRST_TABLES, ...DELETE_TENANT_TABLES, ...DELETE_TENANT_TABLES, ...DELETE_ACCOUNT_TABLES]);
    // Non-deferrable 0005 keys: receipts/audit before bindings, bindings before admission decisions, proofs before cases.
    const at = table => DELETE_TENANT_TABLES.indexOf(table);
    expect(at('dashboard_identity_bindings')).toBeLessThan(at('dashboard_admission_decisions'));
    expect(at('dashboard_runtime_receipts')).toBeLessThan(at('dashboard_identity_bindings'));
    expect(at('dashboard_onboarding_proofs')).toBeLessThan(at('dashboard_onboarding_cases'));
    expect(DELETE_TENANT_TABLES.indexOf('dashboard_organisations')).toBeLessThan(DELETE_TENANT_TABLES.indexOf('dashboard_tenants'));
    expect(DELETE_TENANT_TABLES.indexOf('dashboard_starter_scopes')).toBeLessThan(DELETE_TENANT_TABLES.length);
    expect(result).toEqual({ mode: 'delete', tenants: 2, counts: expect.objectContaining({ dashboard_tenants: 4, dashboard_starter_accounts: 2 }) });
    expect(f.released).toEqual([false]);
});

test('reset deletes only working data tables for each tenant and never the account', async () => {
    const f = fakePool();
    await createAccountWipeRepository(f.pool).reset(scope);
    expect(deletes(f.statements)).toEqual([...RESET_TABLES, ...RESET_TABLES]);
    for (const table of ['dashboard_tenants', 'dashboard_organisations', 'dashboard_membership_states', 'dashboard_identity_bindings', 'dashboard_starter_accounts'])
        expect(RESET_TABLES).not.toContain(table);
});

test('every tenant is checked against the account before its rows are deleted', async () => {
    const f = fakePool();
    await createAccountWipeRepository(f.pool).delete(scope);
    const sql = f.statements.map(([text]) => text);
    const firstTenantCheck = sql.findIndex(text => text.startsWith('SELECT 1 FROM nofries.dashboard_starter_scopes'));
    expect(firstTenantCheck).toBeLessThan(sql.findIndex(text => text.startsWith('DELETE') && !text.includes('dashboard_session_gates')));
    expect(sql.findIndex(text => text.startsWith('SELECT 1 FROM nofries.dashboard_starter_accounts'))).toBeLessThan(sql.findIndex(text => text.startsWith('DELETE')));
    expect(sql.filter(text => text.startsWith('SELECT 1 FROM nofries.dashboard_starter_scopes'))).toHaveLength(2);
});

test.each([[{ owner: 0 }, 'account_wipe_account_not_found'], [{ scoped: 0 }, 'account_wipe_tenant_mismatch']])
('%j rolls back with %s before any delete', async (options, code) => {
    const f = fakePool(options);
    await expect(createAccountWipeRepository(f.pool).delete(scope)).rejects.toMatchObject({ code });
    expect(deletes(f.statements)).toEqual([]);
    expect(f.statements.at(-1)[0]).toBe('ROLLBACK'); expect(f.released).toEqual([true]);
});

test.each([['23503', 'account_wipe_reference_blocked'], ['55P03', 'account_wipe_busy'], ['XX000', 'account_wipe_unavailable']])
('database error %s rolls back as %s, discards the connection and reveals no detail', async (failCode, code) => {
    const f = fakePool({ failOn: 'dashboard_tenants', failCode });
    const error = await createAccountWipeRepository(f.pool).delete(scope).catch(e => e);
    expect(error.code).toBe(code); expect(error.message).not.toContain('PRIVATE');
    expect(f.statements.at(-1)[0]).toBe('ROLLBACK'); expect(f.released).toEqual([true]);
    expect(f.statements.map(([sql]) => sql)).not.toContain('COMMIT');
});

test('a login without the wipe role is refused with a clear code before anything is read', async () => {
    const f = fakePool({ failOn: 'SET LOCAL ROLE', failCode: '42501' });
    await expect(createAccountWipeRepository(f.pool).reset(scope)).rejects.toMatchObject({ code: 'account_wipe_role_unavailable' });
    expect(f.statements.filter(([sql]) => sql.startsWith('SELECT 1') || sql.startsWith('DELETE'))).toEqual([]);
    expect(f.released).toEqual([true]);
});

test.each([
    [{ ...scope, extra: 1 }], [{ ...scope, accountId: 'not-a-uuid' }], [{ ...scope, subjectKey: 'x' }],
    [{ ...scope, tenantIds: [] }], [{ ...scope, tenantIds: [uid(20), uid(20)] }], [{ ...scope, tenantIds: ["x'; DROP TABLE"] }],
    [{ ...scope, tenantIds: Array.from({ length: 65 }, (_, i) => uid(100 + i)) }]
])('target %#: malformed input is refused before connecting', async input => {
    let connected = false;
    await expect(createAccountWipeRepository({ connect: async () => { connected = true; } }).delete(input)).rejects.toThrow();
    expect(connected).toBe(false);
});

test.each(['reset', 'delete'])('%s locks every table it deletes from before the first delete, with a lock timeout', async mode => {
    const f = fakePool();
    await createAccountWipeRepository(f.pool)[mode](scope);
    const sql = f.statements.map(([text]) => text);
    const lock = sql.findIndex(text => text.startsWith('LOCK TABLE'));
    expect(lock).toBeGreaterThan(sql.indexOf('SET LOCAL ROLE nofries_account_wipe'));
    expect(sql.indexOf("SET LOCAL lock_timeout = '5s'")).toBeLessThan(lock);
    expect(lock).toBeLessThan(sql.findIndex(text => text.startsWith('DELETE')));
    expect(sql[lock]).toMatch(/IN SHARE ROW EXCLUSIVE MODE$/);
    for (const table of new Set(deletes(f.statements))) expect(sql[lock]).toContain('nofries.' + table + (sql[lock].includes('nofries.' + table + ',') ? ',' : ''));
});

test('delete removes customer and onboarding-discovery sessions of the subject, never staff sessions', async () => {
    const f = fakePool();
    await createAccountWipeRepository(f.pool).delete(scope);
    const gates = f.statements.map(([sql]) => sql).filter(sql => sql.includes('dashboard_session_gates') && !sql.startsWith('LOCK TABLE'));
    expect(gates.length).toBeGreaterThan(0);
    for (const sql of gates) { expect(sql).toContain("kind IN ('customer', 'onboarding_discovery')"); expect(sql).not.toContain('operator_dashboard'); }
});

test('session-anchored receipts and audit are deleted only where they carry no tenant', async () => {
    const f = fakePool();
    await createAccountWipeRepository(f.pool).delete(scope);
    const sessionDeletes = f.statements.map(([sql]) => sql).filter(sql => sql.startsWith('DELETE') && sql.includes('session_sha256 IN'));
    expect(sessionDeletes).toHaveLength(2);
    for (const sql of sessionDeletes) expect(sql).toContain('tenant_id IS NULL AND');
});

describe('run deadline', () => {
    test('every statement gets statement_timeout no larger than the time left; the lock wait is capped too', async () => {
        let clock = 1000;
        const f = fakePool(), result = await createAccountWipeRepository(f.pool, { now: () => (clock += 10) }).reset(scope, { deadline: 4000 });
        expect(result.mode).toBe('reset');
        const sql = f.statements.map(([text]) => text);
        const timeout = "SELECT set_config('statement_timeout', $1, true)";
        const timeouts = f.statements.filter(([text]) => text === timeout);
        // All but BEGIN and COMMIT, parameterised (never interpolated).
        expect(timeouts.length).toBe(sql.filter(text => text !== timeout).length - 2);
        const values = timeouts.map(([, params]) => Number(params[0]));
        expect(values.every(value => value > 0 && value < 3000)).toBe(true);
        expect([...values].sort((a, b) => b - a)).toEqual(values);
        const lock = f.statements.find(([text]) => text === "SELECT set_config('lock_timeout', $1, true)");
        expect(Number(lock[1][0])).toBeLessThanOrEqual(3000);
        expect(sql.some(text => /statement_timeout =|lock_timeout =/.test(text))).toBe(false);
    });

    test('a tiny budget rolls back mid-delete and never commits', async () => {
        let clock = 0;
        const f = fakePool(), repository = createAccountWipeRepository(f.pool, { now: () => clock });
        const original = f.pool.connect;
        f.pool.connect = async () => { const client = await original(); const query = client.query;
            client.query = async (sql, params) => { if (sql.startsWith('DELETE')) clock += 40; return query(sql, params); }; return client; };
        await expect(repository.delete(scope, { deadline: 100 })).rejects.toMatchObject({ code: 'account_wipe_timed_out' });
        const sql = f.statements.map(([text]) => text);
        expect(sql).not.toContain('COMMIT'); expect(sql.at(-1)).toBe('ROLLBACK'); expect(f.released).toEqual([true]);
        expect(deletes(f.statements).length).toBeGreaterThan(0);
    });

    test('an expired deadline or aborted signal takes no connection and sends nothing', async () => {
        const f = fakePool(), controller = new AbortController(); controller.abort();
        await expect(createAccountWipeRepository(f.pool).reset(scope, { deadline: Date.now() + 60000, signal: controller.signal })).rejects.toMatchObject({ code: 'account_wipe_timed_out' });
        expect(f.statements).toEqual([]); expect(f.released).toEqual([]); // not even a connection is taken
    });

    test('a statement cancelled by statement_timeout is reported as timed out', async () => {
        const f = fakePool({ failOn: 'dashboard_evidence_heads', failCode: '57014' });
        await expect(createAccountWipeRepository(f.pool).reset(scope, { deadline: Date.now() + 60000 })).rejects.toMatchObject({ code: 'account_wipe_timed_out' });
        expect(f.statements.map(([text]) => text)).not.toContain('COMMIT');
    });
});

describe('review fixes', () => {
    test.each([['email_preferences'], ['dashboard_starter_scopes']])
    ('an account row hidden by a different subject, with %s rows left, is a subject mismatch, not absent', async leftover => {
        const f = fakePool({ owner: 0, leftover });
        await expect(createAccountWipeRepository(f.pool).delete(scope)).rejects.toMatchObject({ code: 'account_wipe_subject_mismatch' });
        expect(deletes(f.statements)).toEqual([]); expect(f.statements.at(-1)[0]).toBe('ROLLBACK');
    });

    test('nothing of the account left is reported as not found', async () => {
        const f = fakePool({ owner: 0 });
        await expect(createAccountWipeRepository(f.pool).delete(scope)).rejects.toMatchObject({ code: 'account_wipe_account_not_found' });
        expect(f.statements.filter(([sql]) => sql.includes('EXISTS')).length).toBe(1 + scope.tenantIds.length);
    });

    test('a COMMIT that fails has an unknown outcome', async () => {
        const f = fakePool({ failOn: 'COMMIT', failCode: '08006' });
        await expect(createAccountWipeRepository(f.pool).delete(scope)).rejects.toMatchObject({ code: 'account_wipe_commit_unknown' });
        expect(f.released).toEqual([true]);
    });

    test('the time left is checked again right before COMMIT; past the deadline COMMIT is never sent', async () => {
        let clock = 0;
        const f = fakePool(), original = f.pool.connect;
        // The last statement passes the deadline before COMMIT would be sent.
        f.pool.connect = async () => { const client = await original(); const query = client.query;
            client.query = async (sql, params) => { const result = await query(sql, params); if (sql.startsWith('DELETE FROM nofries.signup_registrations')) clock = 1000; return result; }; return client; };
        await expect(createAccountWipeRepository(f.pool, { now: () => clock }).delete(scope, { deadline: 500 })).rejects.toMatchObject({ code: 'account_wipe_timed_out' });
        expect(f.statements.map(([sql]) => sql)).not.toContain('COMMIT');
        expect(f.statements.at(-1)[0]).toBe('ROLLBACK');
    });
});

describe('bounded waits', () => {
    test('a stalled connection wait ends at the deadline; a connection arriving later is released as broken', async () => {
        const f = fakePool(), original = f.pool.connect;
        let deliver;
        f.pool.connect = () => new Promise(resolve => { deliver = async () => resolve(await original()); });
        await expect(createAccountWipeRepository(f.pool).reset(scope, { deadline: Date.now() + 30 })).rejects.toMatchObject({ code: 'account_wipe_timed_out' });
        await deliver(); await new Promise(resolve => setImmediate(resolve));
        expect(f.released).toEqual([true]); expect(f.statements).toEqual([]);
    });

    test('a COMMIT that never answers ends as an unknown outcome without queueing ROLLBACK behind it', async () => {
        // Sequential like PostgreSQL: each query waits for the one before it.
        const f = fakePool(), original = f.pool.connect;
        f.pool.connect = async () => { const client = await original(), query = client.query; let tail = Promise.resolve();
            client.query = (sql, params) => { const run = tail.then(() => sql === 'COMMIT' ? new Promise(() => {}) : query(sql, params)); tail = run.catch(() => {}); return run; };
            return client; };
        await expect(createAccountWipeRepository(f.pool).reset(scope, { deadline: Date.now() + 1200 })).rejects.toMatchObject({ code: 'account_wipe_commit_unknown' });
        expect(f.released).toEqual([true]);
        expect(f.statements.map(([sql]) => sql)).not.toContain('ROLLBACK');
    });

    test('a ROLLBACK that never answers is bounded, and the connection is destroyed', async () => {
        const f = fakePool({ owner: 0 }), original = f.pool.connect;
        f.pool.connect = async () => { const client = await original(), query = client.query;
            client.query = (sql, params) => sql === 'ROLLBACK' ? new Promise(() => {}) : query(sql, params); return client; };
        await expect(createAccountWipeRepository(f.pool).reset(scope)).rejects.toMatchObject({ code: 'account_wipe_account_not_found' });
        expect(f.released).toEqual([true]);
    });
});
