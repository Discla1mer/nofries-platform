'use strict';

// Native check of the lifecycle email dispatcher's SQL as nofries_email_dispatcher
// on the disposable CI database. The sender and address lookup are fakes.
const crypto = require('node:crypto');
const { createLifecycleEmailDispatcher, claimBatch, asDispatcher } = require('../../api/shared/lifecycleEmail/dispatcher');
const { TEMPLATE_VERSIONS } = require('../../api/shared/lifecycleEmail/templateVersions');

const target = String(process.env.NOFRIES_TEST_DATABASE_URL || '').trim();

module.exports = function registerLifecycleEmailDispatcherTests() {
(target ? describe : describe.skip)('lifecycle email dispatcher (native)', () => {
    const account = { accountId: crypto.randomUUID(), subjectKey: `${crypto.randomUUID()}:${crypto.randomUUID()}`,
        tenantId: crypto.randomUUID(), organisationId: crypto.randomUUID() };
    let pool;
    const enqueue = async (type, key) => {
        const id = crypto.randomUUID();
        await pool.query(`INSERT INTO nofries.email_outbox (outbox_id,tenant_id,organisation_id,account_id,email_type,dedupe_key,
            template_version,not_before) VALUES ($1,$2,$3,$4,$5,$6,$7,'2000-01-01T00:00:00Z')`,
        [id, account.tenantId, account.organisationId, account.accountId, type, key, TEMPLATE_VERSIONS[type]]);
        return id;
    };
    const rowOf = async id => (await pool.query('SELECT status, attempts, provider_message_id, sent_at IS NOT NULL AS sent FROM nofries.email_outbox WHERE outbox_id=$1', [id])).rows[0];

    beforeAll(async () => {
        const url = new URL(target);
        if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('disposable_loopback_database_required');
        const { Pool } = require('pg');
        pool = new Pool({ connectionString: target, max: 3, application_name: 'email-dispatcher-native' });
        await pool.query(`INSERT INTO nofries.dashboard_starter_accounts (account_id,email_sha256,subject_key,account_type)
            VALUES ($1,$2,$3,'company')`, [account.accountId, crypto.randomBytes(32).toString('hex'), account.subjectKey]);
    });
    afterAll(async () => {
        if (!pool) return;
        try {
            for (const table of ['email_outbox', 'email_preferences', 'dashboard_starter_accounts']) await pool.query(`DELETE FROM nofries.${table} WHERE account_id=$1`, [account.accountId]);
        } finally { await pool.end(); }
    });

    test('two concurrent claimers get disjoint rows', async () => {
        const ids = [];
        for (let i = 0; i < 6; i += 1) ids.push(await enqueue('welcome', `claim-${i}`));
        const [one, two] = [await pool.connect(), await pool.connect()];
        try {
            for (const c of [one, two]) { await c.query('BEGIN'); await c.query('SET LOCAL ROLE nofries_email_dispatcher'); }
            const first = (await claimBatch(one, ['welcome'], 3)).map(r => r.outbox_id);
            const second = (await claimBatch(two, ['welcome'], 3)).map(r => r.outbox_id);
            await one.query('COMMIT'); await two.query('COMMIT');
            expect(first).toHaveLength(3); expect(second).toHaveLength(3);
            expect(first.filter(id => second.includes(id))).toEqual([]);
            expect([...first, ...second].sort()).toEqual([...ids].sort());
            for (const id of ids) expect(await rowOf(id)).toMatchObject({ status: 'sending', attempts: 1 });
        } finally { one.release(); two.release(); }
        await pool.query("UPDATE nofries.email_outbox SET status='cancelled', locked_until=NULL WHERE outbox_id = ANY($1::uuid[])", [ids]);
    });

    test('a run sends, suppresses an unsubscribed type and records only delivery columns', async () => {
        await pool.query(`INSERT INTO nofries.email_preferences (account_id,email_type,unsubscribed_at,source)
            VALUES ($1,'result_summary',clock_timestamp(),'link')`, [account.accountId]);
        const welcome = await enqueue('welcome', 'run-welcome'), nudge = await enqueue('result_summary', 'run-unsubscribed');
        const resolveAddress = jest.fn(async subjectKey => (subjectKey === account.subjectKey ? 'owner@example.invalid' : null));
        const send = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ id: 'msg-native-1' }) }));
        const dispatcher = createLifecycleEmailDispatcher({ env: { NOFRIES_LIFECYCLE_EMAIL_SEND_ENABLED: 'true' }, pool, resolveAddress, send,
            from: 'No Fries <hello@example.invalid>', publicOrigin: 'https://nofries.nz', log: () => {} });
        await dispatcher.runOnce();
        expect(await rowOf(welcome)).toEqual({ status: 'sent', attempts: 1, provider_message_id: 'msg-native-1', sent: true });
        expect(await rowOf(nudge)).toEqual({ status: 'suppressed', attempts: 1, provider_message_id: null, sent: false });
        expect(send).toHaveBeenCalledTimes(1);
        expect(send.mock.calls[0][0].idempotencyKey).toBe(welcome);
    });

    test('a stale lease cannot complete a reclaimed row, and the cap fails a crash-looping row', async () => {
        const id = await enqueue('result_summary', 'lease');
        const [stale] = await asDispatcher(pool, c => claimBatch(c, ['result_summary']));
        await pool.query("UPDATE nofries.email_outbox SET locked_until=clock_timestamp()-interval '1 second' WHERE outbox_id=$1", [id]);
        const [fresh] = await asDispatcher(pool, c => claimBatch(c, ['result_summary']));
        expect(fresh).toMatchObject({ outbox_id: id, attempts: 2, prior_attempts: 1 }); expect(fresh.lease).not.toBe(stale.lease);
        const complete = lease => asDispatcher(pool, c => c.query(`UPDATE nofries.email_outbox SET locked_until=NULL, status='pending'
            WHERE outbox_id=$1 AND status='sending' AND extract(epoch FROM locked_until) = $2::numeric`, [id, lease]));
        expect((await complete(stale.lease)).rowCount).toBe(0);
        expect((await complete(fresh.lease)).rowCount).toBe(1);
        await pool.query("UPDATE nofries.email_outbox SET status='sending', attempts=6, locked_until=clock_timestamp()-interval '1 second' WHERE outbox_id=$1", [id]);
        const logs = [], send = jest.fn();
        await createLifecycleEmailDispatcher({ env: { NOFRIES_LIFECYCLE_EMAIL_SEND_ENABLED: 'true' }, pool, send, resolveAddress: async () => 'owner@example.invalid',
            from: 'a@example.invalid', publicOrigin: 'https://nofries.nz', log: e => logs.push(e) }).runOnce();
        expect(send).not.toHaveBeenCalled();
        expect(await rowOf(id)).toMatchObject({ status: 'failed', attempts: 6 });
        expect(logs).toContainEqual({ outboxId: id, type: 'result_summary', status: 'failed', errorCode: 'attempts_exhausted' });
    });

    test('types outside the allow-list or awaiting unsubscribe stay pending', async () => {
        const nudge = await enqueue('nudge_unfinished', 'held'), result = await enqueue('result_summary', 'held');
        const dispatcher = createLifecycleEmailDispatcher({ env: { NOFRIES_LIFECYCLE_EMAIL_SEND_ENABLED: 'true', NOFRIES_LIFECYCLE_EMAIL_TYPES: 'welcome,nudge_unfinished' },
            pool, send: jest.fn(), resolveAddress: jest.fn(), from: 'a@example.invalid', publicOrigin: 'https://nofries.nz', log: () => {} });
        await dispatcher.runOnce();
        for (const id of [nudge, result]) expect(await rowOf(id)).toMatchObject({ status: 'pending', attempts: 0 });
        await pool.query("UPDATE nofries.email_outbox SET status='cancelled' WHERE outbox_id = ANY($1::uuid[])", [[nudge, result]]);
    });

    test('the dispatcher role cannot read assessment tables', async () => {
        for (const table of ['dashboard_ncsc_assessments', 'dashboard_ncsc_assessment_receipts', 'dashboard_starter_scopes']) await expect(
            asDispatcher(pool, c => c.query(`SELECT 1 FROM nofries.${table} LIMIT 1`))).rejects.toMatchObject({ code: '42501' });
    });
});
};
