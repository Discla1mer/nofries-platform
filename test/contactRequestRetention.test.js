'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createContactRequestRetention, startContactRequestRetention, PURGE_SQL, FIRST_RUN_DELAY_MS, INTERVAL_MS }
    = require('../api/shared/contactRequestRetention');

// A fake pool: the probe answers `allowed`; each purge DELETE answers the next count.
function fakePool({ allowed = true, probeError = null, counts = [], failAt = null, rollbackError = false } = {}) {
    const statements = [], released = [];
    let deletes = 0;
    const pool = {
        statements, released,
        async query(sql) {
            statements.push(sql);
            if (probeError) throw probeError;
            return { rows: [{ ok: allowed }] };
        },
        async connect() {
            return {
                async query(sql, params) {
                    statements.push(sql);
                    if (sql === 'ROLLBACK' && rollbackError) throw new Error('connection lost');
                    if (sql === PURGE_SQL) {
                        expect(params).toEqual([expect.any(Number)]);
                        if (failAt === deletes) { deletes += 1; throw Object.assign(new Error('secret row detail'), { code: '57014' }); }
                        return { rowCount: counts[deletes++] ?? 0 };
                    }
                    return { rows: [] };
                },
                release(discard) { released.push(discard); }
            };
        }
    };
    return pool;
}

describe('contact request retention job', () => {
    test('skips with a code and touches nothing when the login cannot SET the role', async () => {
        const log = jest.fn(), pool = fakePool({ allowed: false });
        await expect(createContactRequestRetention({ pool, log }).runOnce()).resolves.toEqual({ code: 'retention_role_unavailable', deleted: 0 });
        expect(pool.statements).toEqual(["SELECT pg_has_role(current_user, 'nofries_contact_request_retention', 'SET') AS ok"]);
        expect(log).toHaveBeenCalledWith({ code: 'retention_role_unavailable', deleted: 0 });
    });

    test('a failing probe is logged as a code and swallowed', async () => {
        const log = jest.fn(), pool = fakePool({ probeError: new Error('boom') });
        await expect(createContactRequestRetention({ pool, log }).runOnce()).resolves.toEqual({ code: 'retention_probe_failed', deleted: 0 });
        expect(log).toHaveBeenCalledWith({ code: 'retention_probe_failed', deleted: 0 });
    });

    test('deletes in bounded batches under SET LOCAL ROLE and a statement timeout until a short batch', async () => {
        const log = jest.fn(), pool = fakePool({ counts: [3, 3, 1] });
        await expect(createContactRequestRetention({ pool, log, batchSize: 3 }).runOnce()).resolves.toEqual({ code: 'retention_completed', deleted: 7 });
        const batch = ['BEGIN', 'SET LOCAL statement_timeout = 15000', 'SET LOCAL ROLE nofries_contact_request_retention', PURGE_SQL, 'COMMIT'];
        expect(pool.statements.slice(1)).toEqual([...batch, ...batch, ...batch]);
        expect(pool.released).toEqual([false, false, false]);
        expect(log).toHaveBeenCalledTimes(1);
        expect(log).toHaveBeenCalledWith({ code: 'retention_completed', deleted: 7 });
    });

    test('stops at the batch limit and says so', async () => {
        const log = jest.fn(), pool = fakePool({ counts: [2, 2, 2, 2] });
        await expect(createContactRequestRetention({ pool, log, batchSize: 2, maxBatches: 2 }).runOnce())
            .resolves.toEqual({ code: 'retention_batch_limit', deleted: 4 });
    });

    test('a failed batch rolls back, logs only a code and the count so far, and does not throw', async () => {
        const log = jest.fn(), pool = fakePool({ counts: [2], failAt: 1 });
        await expect(createContactRequestRetention({ pool, log, batchSize: 2 }).runOnce()).resolves.toEqual({ code: 'retention_failed', deleted: 2 });
        expect(pool.statements.slice(-1)).toEqual(['ROLLBACK']);
        expect(pool.released).toEqual([false, false]);
        expect(JSON.stringify(log.mock.calls)).not.toMatch(/secret|57014/);
    });

    test('a connection that cannot roll back is discarded', async () => {
        const pool = fakePool({ failAt: 0, rollbackError: true });
        await expect(createContactRequestRetention({ pool, log: () => {} }).runOnce()).resolves.toEqual({ code: 'retention_failed', deleted: 0 });
        expect(pool.released).toEqual([true]);
    });

    test('a throwing logger does not break the run', async () => {
        const pool = fakePool({ counts: [0] });
        await expect(createContactRequestRetention({ pool, log: () => { throw new Error('log'); } }).runOnce())
            .resolves.toEqual({ code: 'retention_completed', deleted: 0 });
    });

    test('the default log line is a fixed event, a code and a count', async () => {
        const info = jest.spyOn(console, 'info').mockImplementation(() => {});
        try {
            await createContactRequestRetention({ pool: fakePool({ allowed: false }) }).runOnce();
            expect(info.mock.calls).toEqual([[JSON.stringify({ event: 'contact_request_retention', code: 'retention_role_unavailable', deleted: 0 })]]);
        } finally { info.mockRestore(); }
    });

    test('the statement deletes only rows past 24 months and returns nothing', () => {
        expect(PURGE_SQL.match(/requested_at < now\(\) - interval '24 months'/g)).toHaveLength(2);
        expect(PURGE_SQL).toMatch(/LIMIT \$1/);
        expect(PURGE_SQL).not.toMatch(/RETURNING/i);
    });
});

describe('starting the retention job', () => {
    const timers = () => {
        const calls = { timeout: [], interval: [] };
        return { calls, setTimeoutImpl: (fn, ms) => { calls.timeout.push(ms); return { unref() {} }; },
            setIntervalImpl: (fn, ms) => { calls.interval.push(ms); return { unref() {} }; } };
    };

    test.each([undefined, '', 'TRUE', '1', 'yes', ' true'])('is off unless the flag is exactly "true" (%p)', value => {
        const t = timers(), createPostgresPool = jest.fn();
        const env = value === undefined ? {} : { NOFRIES_CONTACT_REQUEST_RETENTION_ENABLED: value };
        expect(startContactRequestRetention({ env, dependencies: { createPostgresPool }, ...t })).toBeNull();
        expect(createPostgresPool).not.toHaveBeenCalled();
        expect(t.calls).toEqual({ timeout: [], interval: [] });
    });

    test('on, it builds one small pool as the runtime login, schedules a first run and a daily run, and runs once at a time', async () => {
        const t = timers(), pool = fakePool({ allowed: false }), log = jest.fn();
        class ManagedIdentityCredential { constructor(options) { this.options = options; } getToken() {} }
        const createPostgresPool = jest.fn(() => pool);
        const env = { NOFRIES_CONTACT_REQUEST_RETENTION_ENABLED: 'true', NOFRIES_MANAGED_IDENTITY_CLIENT_ID: 'client' };
        const handle = startContactRequestRetention({ env, dependencies: { createPostgresPool, ManagedIdentityCredential }, log, ...t });
        try {
            expect(handle).not.toBeNull();
            expect(startContactRequestRetention({ env, dependencies: { createPostgresPool, ManagedIdentityCredential }, log, ...t })).toBe(handle);
            expect(createPostgresPool).toHaveBeenCalledTimes(1);
            const options = createPostgresPool.mock.calls[0][0];
            expect(options).toMatchObject({ env, poolMax: 1, statementTimeoutMs: 15000, applicationName: 'nofries-contact-retention' });
            expect(options.credential.options).toEqual({ clientId: 'client' });
            expect(options.user).toBeUndefined();
            expect(t.calls).toEqual({ timeout: [FIRST_RUN_DELAY_MS], interval: [INTERVAL_MS] });
            const [first, second] = [handle.tick(), handle.tick()];
            await expect(second).resolves.toBeNull();
            await expect(first).resolves.toEqual({ code: 'retention_role_unavailable', deleted: 0 });
        } finally { handle.stop(); }
    });

    test('a setup failure logs a code and leaves the host running', () => {
        const log = jest.fn();
        const handle = startContactRequestRetention({ env: { NOFRIES_CONTACT_REQUEST_RETENTION_ENABLED: 'true' },
            dependencies: { createPostgresPool: () => { throw new Error('postgres_connection_string_forbidden'); },
                ManagedIdentityCredential: class {} }, log, ...timers() });
        expect(handle).toBeNull();
        expect(log).toHaveBeenCalledWith({ code: 'retention_start_failed', deleted: 0 });
    });

    test('the App Service host starts the job', () => {
        const host = fs.readFileSync(path.join(__dirname, '..', 'app-service.js'), 'utf8');
        expect(host).toMatch(/require\('\.\/api\/shared\/contactRequestRetention'\)/);
        expect(host).toMatch(/startContactRequestRetention\(\);/);
    });
});
