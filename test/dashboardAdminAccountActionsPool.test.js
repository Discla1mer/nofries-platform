'use strict';
const { accountActionsPool } = require('../api/shared/dashboardAdmin/accountActionsPool');
test('ordinary callers keep the original pool; nested action validation uses read-only savepoints on one lease', async () => {
    const client = { query: jest.fn(async () => ({ rows: [] })), release: jest.fn() };
    const raw = { connect: jest.fn(async () => client), end: jest.fn() }, pool = accountActionsPool(raw);
    expect(await pool.connect()).toBe(client); raw.connect.mockClear();
    expect(accountActionsPool(raw)).toBe(pool); expect(accountActionsPool(pool)).toBe(pool);
    await pool.run(async () => {
        const outer = await pool.connect(); await outer.query('BEGIN');
        await pool.run(async () => {
            const nested = await pool.connect();
            await expect(nested.query('BEGIN')).rejects.toThrow('dashboard_admin_unavailable');
            await nested.query('BEGIN READ ONLY'); await nested.query('SELECT 1');
            await expect(nested.query('DELETE FROM nofries.memberships')).rejects.toThrow('dashboard_admin_unavailable');
            await nested.query('COMMIT'); nested.release();
        });
        await outer.query('COMMIT'); outer.release();
    });
    expect(raw.connect).toHaveBeenCalledTimes(1);
    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'SAVEPOINT account_action_check_1', 'SELECT 1',
        'ROLLBACK TO SAVEPOINT account_action_check_1', 'RELEASE SAVEPOINT account_action_check_1', 'COMMIT']);
    expect(client.release).toHaveBeenCalledTimes(1);
});
test('an abandoned nested check permits rollback but prevents the outer commit', async () => {
    const client = { query: jest.fn(async () => ({ rows: [] })), release: jest.fn() };
    const pool = accountActionsPool({ connect: async () => client, end() {} });
    await pool.run(async () => {
        const outer = await pool.connect(); await outer.query('BEGIN');
        const nested = await pool.connect(); await nested.query('BEGIN READ ONLY'); nested.release(true);
        expect(() => outer.query('COMMIT')).toThrow('dashboard_admin_unavailable');
        await outer.query('ROLLBACK'); outer.release();
    });
    expect(client.query.mock.calls.some(([sql]) => sql === 'COMMIT')).toBe(false);
    expect(client.release).toHaveBeenCalledWith(true);
});
