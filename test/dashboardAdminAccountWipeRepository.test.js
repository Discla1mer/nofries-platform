'use strict';
const { createAccountWipeRepository, RESET_TABLES, DELETE_TENANT_TABLES, DELETE_FIRST_TABLES, DELETE_ACCOUNT_TABLES } = require('../api/shared/dashboardAdmin/accountWipeRepository');

const uid = n => '50000000-0000-4000-8000-' + String(n).padStart(12, '0');
const SUBJECT = uid(1) + ':' + uid(2);
const scope = { accountId: uid(10), subjectKey: SUBJECT, tenantIds: [uid(20), uid(21)] };

function fakePool({ owner = 1, scoped = 1, failOn = null } = {}) {
    const statements = [], released = [];
    const client = {
        async query(sql, params = []) {
            statements.push([sql, params]);
            if (failOn && sql.includes(failOn)) throw Object.assign(new Error('PRIVATE_DATABASE_DETAIL customer@example.test'), { code: '23503' });
            if (sql.startsWith('SELECT 1 FROM nofries.dashboard_starter_accounts')) return { rowCount: owner };
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

test('a database error rolls back, discards the connection and reveals no detail', async () => {
    const f = fakePool({ failOn: 'dashboard_tenants' });
    const error = await createAccountWipeRepository(f.pool).delete(scope).catch(e => e);
    expect(error.code).toBe('account_wipe_unavailable'); expect(error.message).not.toContain('PRIVATE');
    expect(f.statements.at(-1)[0]).toBe('ROLLBACK'); expect(f.released).toEqual([true]);
    expect(f.statements.map(([sql]) => sql)).not.toContain('COMMIT');
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
