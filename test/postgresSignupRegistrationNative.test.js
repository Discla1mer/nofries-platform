'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const runner = typeof globalThis.test === 'function' ? globalThis : require('node:test');
const { test, describe } = runner;
const beforeAll = runner.beforeAll || runner.before;
const afterAll = runner.afterAll || runner.after;
const testUrl = String(process.env.NOFRIES_TEST_DATABASE_URL || '').trim();

// This fixture deletes only its generated records, and refuses remote/customer
// databases. Never fall back to NOFRIES_DATABASE_URL or application credentials.
function isolatedTestUrl(value) {
    let url;
    try { url = new URL(value); } catch (_) { throw new Error('isolated_signup_test_database_required'); }
    if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
        !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
        !/^\/nofries_(?:ci|test(?:_[a-z0-9_]+)?)$/.test(url.pathname) ||
        url.search || url.hash) throw new Error('isolated_signup_test_database_required');
    return value;
}

for (const value of [
    'postgresql://localhost/nofries_ci',
    'postgres://127.0.0.1/nofries_test_registration',
    'postgresql://[::1]/nofries_test'
]) test(`native registration fixture accepts isolated target ${new URL(value).hostname}`, () => {
    assert.equal(isolatedTestUrl(value), value);
});
for (const [name, value] of [
    ['remote host', 'postgresql://example.invalid/nofries_ci'],
    ['production database', 'postgresql://localhost/nofries_production'],
    ['missing target', ''],
    ['query overrides', 'postgresql://localhost/nofries_ci?host=example.invalid'],
    ['non-PostgreSQL protocol', 'https://localhost/nofries_ci']
]) test(`native registration fixture rejects ${name}`, () => {
    assert.throws(() => isolatedTestUrl(value), /isolated_signup_test_database_required/);
});

(testUrl ? describe : describe.skip)('native PostgreSQL current signup registration', () => {
    let owner, runtimePool, database, store, Pool, createDatabase, createStore;
    const subjects = new Set();
    const makeReceipt = (options = {}) => {
        const subjectKey = options.subjectKey || `${randomUUID()}:${randomUUID()}`;
        subjects.add(subjectKey);
        return { receiptId: randomUUID(), invitationId: randomUUID(), subjectKey,
            tenantId: `logical-${randomUUID()}`, organisationId: `org-${randomUUID()}`,
            termsVersion: 'synthetic-native-v1', termsDigest: 'a'.repeat(64),
            acceptedAt: 1, status: 'pending_admission', dashboardAccess: false, ...options };
    };
    const selector = receipt => ({ subjectKey: receipt.subjectKey, tenantId: receipt.tenantId,
        organisationId: receipt.organisationId, invitationId: receipt.invitationId });

    async function openRuntime() {
        runtimePool = new Pool({ connectionString: isolatedTestUrl(testUrl), max: 4,
            connectionTimeoutMillis: 5000, statement_timeout: 10000 });
        const pool = runtimePool;
        database = createDatabase({ pool: {
            async connect() {
                const client = await pool.connect();
                try {
                    await client.query('SET ROLE nofries_runtime');
                    return { query: client.query.bind(client), release: client.release.bind(client) };
                } catch (error) { client.release(true); throw error; }
            },
            end: () => pool.end()
        } });
        store = createStore({ database });
    }
    async function raw(partition, subjectKey, work) {
        const client = await runtimePool.connect();
        let begun = false;
        try {
            await client.query('SET ROLE nofries_runtime');
            await client.query('BEGIN'); begun = true;
            await client.query("SELECT set_config('nofries.tenant_id', $1, true)", [partition || '']);
            await client.query("SELECT set_config('nofries.signup_subject_key', $1, true)", [subjectKey || '']);
            const result = await work(client);
            await client.query('COMMIT'); begun = false;
            return result;
        } finally {
            try { if (begun) await client.query('ROLLBACK'); }
            finally { client.release(); }
        }
    }
    async function saved(receipt) {
        return (await owner.query('SELECT * FROM nofries.signup_registrations WHERE subject_key=$1',
            [receipt.subjectKey])).rows[0];
    }
    beforeAll(async () => {
        isolatedTestUrl(testUrl);
        ({ Pool } = require('pg'));
        ({ createPostgresDatabase: createDatabase } = require('../api/shared/database/postgres'));
        ({ createPostgresSignupRegistrationStore: createStore } = require('../api/shared/customerSignup/postgresSignupRegistrationStore'));
        owner = new Pool({ connectionString: testUrl, max: 1,
            connectionTimeoutMillis: 5000, statement_timeout: 10000 });
        assert.equal((await owner.query("SELECT to_regclass('nofries.signup_registrations')::text AS name")).rows[0].name,
            'nofries.signup_registrations', 'Apply the repository migrations before native tests');
        await openRuntime();
    });
    afterAll(async () => {
        try { if (database) await database.close(); }
        finally {
            if (owner) {
                try {
                    if (subjects.size) await owner.query('DELETE FROM nofries.signup_registrations WHERE subject_key=ANY($1::text[])',
                        [[...subjects]]);
                } finally { await owner.end(); }
            }
        }
    });

    test('runtime is not superuser/bypass-RLS and the registry forces row isolation', async () => {
        await raw('', '', async client => {
            const role = (await client.query('SELECT current_user AS name, rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
            assert.deepEqual(role, { name: 'nofries_runtime', rolsuper: false, rolbypassrls: false });
            const table = (await client.query("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='nofries.signup_registrations'::regclass")).rows[0];
            assert.deepEqual(table, { relrowsecurity: true, relforcerowsecurity: true });
        });
    });
    test('persists, reads and replays an exact acceptance without increasing revision', async () => {
        const receipt = makeReceipt();
        const first = await store.registerAcceptance(receipt);
        assert.equal(first.revision, 1);
        assert.deepEqual(await store.readRegistration({ subjectKey: receipt.subjectKey }), first);
        assert.deepEqual(await store.registerAcceptance(receipt), first);
        assert.equal(String((await saved(receipt)).revision), '1');
    });
    test('simultaneous first-acceptance retries produce one row and one revision', async () => {
        const receipt = makeReceipt();
        const results = await Promise.all(Array.from({ length: 8 }, () => store.registerAcceptance(receipt)));
        for (const result of results) assert.deepEqual(result, results[0]);
        assert.equal(results[0].revision, 1);
        assert.equal((await owner.query('SELECT count(*)::int AS count FROM nofries.signup_registrations WHERE subject_key=$1',
            [receipt.subjectKey])).rows[0].count, 1);
    });
    test('concurrent distinct organisations require deliberate selection and reject stale selection', async () => {
        const a = makeReceipt(), b = makeReceipt({ subjectKey: a.subjectKey });
        await Promise.all([store.registerAcceptance(a), store.registerAcceptance(b)]);
        assert.equal(await store.readRegistration({ subjectKey: a.subjectKey }), null);
        const current = await store.readForInvitation(selector(a));
        const selected = await store.selectRegistration({ ...selector(a), expectedRevision: current.revision });
        assert.equal(selected.organisationId, a.organisationId);
        await assert.rejects(store.selectRegistration({ ...selector(b), expectedRevision: current.revision }),
            { code: 'signup_registration_conflict' });
        await store.registerAcceptance(b);
        assert.equal((await store.readRegistration({ subjectKey: a.subjectKey })).organisationId, a.organisationId);
    });
    test('revocation survives receipt replay and never silently switches organisations', async () => {
        const a = makeReceipt(), b = makeReceipt({ subjectKey: a.subjectKey });
        await store.registerAcceptance(a); await store.registerAcceptance(b);
        const current = await store.readForInvitation(selector(a));
        const selected = await store.selectRegistration({ ...selector(a), expectedRevision: current.revision });
        const command = { ...selector(a), expectedRevision: selected.revision };
        const revoked = await store.revokeRegistration(command);
        assert.equal(revoked.status, 'revoked');
        assert.equal(await store.readRegistration({ subjectKey: a.subjectKey }), null);
        assert.deepEqual(await store.revokeRegistration(command), revoked);
        await assert.rejects(store.registerAcceptance(a), { code: 'signup_registration_revoked' });
    });
    test('same identity tenant cannot read another subject and is not a logical organisation', async () => {
        const a = makeReceipt(), b = makeReceipt({ subjectKey: `${a.subjectKey.slice(0, 36)}:${randomUUID()}` });
        await store.registerAcceptance(a); await store.registerAcceptance(b);
        assert.notEqual(a.tenantId, a.subjectKey.slice(0, 36));
        await raw(a.subjectKey.slice(0, 36), a.subjectKey, async client => {
            const rows = (await client.query('SELECT subject_key FROM nofries.signup_registrations')).rows;
            assert.deepEqual(rows, [{ subject_key: a.subjectKey }]);
        });
    });
    test('missing or mismatched identity/subject context sees no records', async () => {
        const a = makeReceipt(), b = makeReceipt();
        await store.registerAcceptance(a); await store.registerAcceptance(b);
        for (const [partition, subjectKey] of [['', ''], [a.subjectKey.slice(0, 36), ''],
            ['', a.subjectKey], [b.subjectKey.slice(0, 36), a.subjectKey]]) {
            await raw(partition, subjectKey, async client => {
                assert.equal((await client.query('SELECT * FROM nofries.signup_registrations')).rows.length, 0);
            });
        }
    });
    test('another subject cannot insert a valid row or update an existing registration', async () => {
        const a = makeReceipt(), b = makeReceipt();
        await store.registerAcceptance(b);
        const row = await saved(b);
        await assert.rejects(raw(a.subjectKey.slice(0, 36), a.subjectKey, client => client.query(
            'INSERT INTO nofries.signup_registrations(identity_tenant_id,subject_key,revision,payload) VALUES($1,$2,$3,$4::jsonb)',
            [row.identity_tenant_id, row.subject_key, row.revision, JSON.stringify(row.payload)])), { code: '42501' });
        await raw(a.subjectKey.slice(0, 36), a.subjectKey, async client => {
            assert.equal((await client.query('UPDATE nofries.signup_registrations SET payload=payload WHERE subject_key=$1',
                [b.subjectKey])).rowCount, 0);
        });
    });
    test('runtime cannot delete even its own registration', async () => {
        const receipt = makeReceipt(); await store.registerAcceptance(receipt);
        await assert.rejects(raw(receipt.subjectKey.slice(0, 36), receipt.subjectKey, client => client.query(
            'DELETE FROM nofries.signup_registrations WHERE subject_key=$1', [receipt.subjectKey])), { code: '42501' });
        assert.ok(await store.readRegistration({ subjectKey: receipt.subjectKey }));
    });
    test('a transaction failure after writes rolls back new registration', async () => {
        const receipt = makeReceipt();
        const failing = createStore({ database: {
            withTenantTransaction: (tenant, work) => database.withTenantTransaction(tenant, async tx => {
                await work(tx); throw new Error('synthetic rollback after registry write');
            })
        } });
        await assert.rejects(failing.registerAcceptance(receipt), { code: 'signup_registration_unavailable' });
        assert.equal(await store.readRegistration({ subjectKey: receipt.subjectKey }), null);
        assert.equal(await saved(receipt), undefined);
        assert.equal((await store.registerAcceptance(receipt)).revision, 1);
    });
    test('database constraints reject mismatched payload/revision without changing saved state', async () => {
        const receipt = makeReceipt(); const before = await store.registerAcceptance(receipt);
        await assert.rejects(raw(receipt.subjectKey.slice(0, 36), receipt.subjectKey, client => client.query(
            'UPDATE nofries.signup_registrations SET revision=revision+1 WHERE subject_key=$1', [receipt.subjectKey])), { code: '23514' });
        assert.deepEqual(await store.readRegistration({ subjectKey: receipt.subjectKey }), before);
    });
    test('closing all runtime connections and reopening preserves selected registration', async () => {
        const receipt = makeReceipt(); const before = await store.registerAcceptance(receipt);
        await database.close(); await openRuntime();
        assert.deepEqual(await store.readRegistration({ subjectKey: receipt.subjectKey }), before);
    });
    test('transaction-local tenant and subject settings do not leak into the next borrower', async () => {
        const receipt = makeReceipt(); await store.registerAcceptance(receipt);
        const client = await runtimePool.connect();
        try {
            await client.query('SET ROLE nofries_runtime');
            const settings = (await client.query("SELECT current_setting('nofries.tenant_id',true) AS tenant, current_setting('nofries.signup_subject_key',true) AS subject")).rows[0];
            assert.ok(settings.tenant === null || settings.tenant === '');
            assert.ok(settings.subject === null || settings.subject === '');
            assert.equal((await client.query('SELECT * FROM nofries.signup_registrations')).rows.length, 0);
        } finally { client.release(); }
    });
});
