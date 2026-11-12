'use strict';

// Lifecycle email sender (#151, slices E4/E5), off unless
// NOFRIES_LIFECYCLE_EMAIL_SEND_ENABLED is exactly 'true'. Each run claims due
// outbox rows as nofries_email_dispatcher, resolves the address at send time
// (account -> subject key -> customer-subjects record) and sends plain text.
// The address is never stored, cached or logged; logs carry only the outbox id,
// type, status and error code.
const { renderTemplate } = require('./templates');
const { createResendClient } = require('./resendClient');

const TYPES = Object.freeze(['welcome', 'result_summary', 'nudge_unfinished', 'reassess_reminder']);
const BATCH = 20;
const INTERVAL_MS = 5 * 60 * 1000;
const BACKOFF_MS = Object.freeze([5 * 60e3, 30 * 60e3, 2 * 3600e3, 8 * 3600e3, 24 * 3600e3]);
// Resend ids are UUIDs; refusing '@' keeps any address-shaped value out of the row.
const PROVIDER_ID = /^[A-Za-z0-9._:-]{1,200}$/;
// Due pending rows, plus rows whose sending lease expired after a crash; the
// Idempotency-Key stops a reclaimed row from sending twice.
const CLAIM_SQL = `UPDATE nofries.email_outbox o SET status='sending', locked_until=clock_timestamp()+interval '10 minutes'
    WHERE o.outbox_id IN (SELECT outbox_id FROM nofries.email_outbox
        WHERE (status='pending' AND not_before<=clock_timestamp()) OR (status='sending' AND locked_until<clock_timestamp())
        ORDER BY not_before, outbox_id LIMIT $1 FOR UPDATE SKIP LOCKED)
    RETURNING o.outbox_id, o.account_id, o.email_type, o.template_version, o.attempts`;
const RECIPIENT_SQL = `SELECT a.account_id, a.subject_key, ARRAY(SELECT p.email_type FROM nofries.email_preferences p
    WHERE p.account_id=a.account_id AND p.unsubscribed_at IS NOT NULL) AS unsubscribed
    FROM nofries.dashboard_starter_accounts a WHERE a.account_id = ANY($1::uuid[])`;
const FINISH = 'UPDATE nofries.email_outbox SET locked_until=NULL, ';

// A reclaimed row may already hold the last attempt; the column caps at 6.
const next = row => Math.min(row.attempts + 1, BACKOFF_MS.length + 1);
const sendEnabled = env => env.NOFRIES_LIFECYCLE_EMAIL_SEND_ENABLED === 'true';
function allowedTypes(env) {
    const raw = String(env.NOFRIES_LIFECYCLE_EMAIL_TYPES || '').trim();
    if (!raw) return new Set(TYPES);
    return new Set(raw.split(',').map(value => value.trim()).filter(value => TYPES.includes(value)));
}

async function asDispatcher(pool, work) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN'); await client.query('SET LOCAL ROLE nofries_email_dispatcher');
        const result = await work(client); await client.query('COMMIT'); return result;
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; } finally { client.release(); }
}

async function claimBatch(client, limit = BATCH) {
    const rows = (await client.query(CLAIM_SQL, [limit])).rows;
    const ids = [...new Set(rows.map(row => row.account_id))];
    const recipients = new Map(ids.length ? (await client.query(RECIPIENT_SQL, [ids])).rows.map(row => [row.account_id, row]) : []);
    return rows.map(row => ({ ...row, subjectKey: recipients.get(row.account_id)?.subject_key ?? null,
        unsubscribed: (recipients.get(row.account_id)?.unsubscribed || []).includes(row.email_type) }));
}

function createLifecycleEmailDispatcher({ env = process.env, pool, resolveAddress, send, from, publicOrigin, log = defaultLog }) {
    const SETS = Object.freeze({ suppressed: ["status='suppressed', last_error_code=$2", ['code']],
        sent: ["status='sent', sent_at=clock_timestamp(), provider_message_id=$2, attempts=$3", ['providerId', 'attempts']],
        failed: ["status='failed', last_error_code=$2, attempts=$3", ['code', 'attempts']],
        pending: ["status='pending', last_error_code=$2, attempts=$3, not_before=clock_timestamp()+$4::int*interval '1 millisecond'",
            ['code', 'attempts', 'delayMs']] });
    async function finish(row, status, extra = {}) {
        const [set, keys] = SETS[status];
        await asDispatcher(pool, client => client.query(`${FINISH}${set} WHERE outbox_id=$1 AND status='sending'`,
            [row.outbox_id, ...keys.map(key => extra[key] ?? null)]));
        log({ outboxId: row.outbox_id, type: row.email_type, status, errorCode: extra.code ?? null });
    }
    function retry(row, code) {
        const attempts = next(row);
        if (attempts > BACKOFF_MS.length) return finish(row, 'failed', { code, attempts });
        return finish(row, 'pending', { code, attempts, delayMs: BACKOFF_MS[attempts - 1] });
    }
    async function deliver(row, allowed) {
        if (!allowed.has(row.email_type)) return finish(row, 'suppressed', { code: 'type_not_allowed' });
        if (row.unsubscribed) return finish(row, 'suppressed', { code: 'unsubscribed' });
        if (!row.subjectKey) return finish(row, 'failed', { code: 'recipient_missing', attempts: next(row) });
        let message;
        const signInUrl = `${publicOrigin}/dashboard`;
        // TODO(#151 unsubscribe slice): replace with the signed one-click unsubscribe link.
        try { message = renderTemplate(row.email_type, row.template_version, { signInUrl, unsubscribeUrl: signInUrl }); }
        catch (_) { return finish(row, 'failed', { code: 'template_unknown', attempts: next(row) }); }
        let address;
        try { address = await resolveAddress(row.subjectKey); }
        catch (error) {
            return error?.statusCode === 401 ? finish(row, 'failed', { code: 'recipient_invalid', attempts: next(row) })
                : retry(row, 'recipient_store_unavailable');
        }
        if (!address) return finish(row, 'failed', { code: 'recipient_missing', attempts: next(row) });
        let response;
        try { response = await send({ from, to: address, subject: message.subject, text: message.text, idempotencyKey: row.outbox_id }); }
        catch (_) { return retry(row, 'network_error'); }
        if (response?.ok) {
            let id = null;
            try { id = (await response.json())?.id; } catch (_) { /* sent; the id is optional */ }
            return finish(row, 'sent', { providerId: typeof id === 'string' && PROVIDER_ID.test(id) ? id : null, attempts: next(row) });
        }
        const status = Number(response?.status) || 0;
        if (status === 429 || status >= 500 || !status) return retry(row, status ? `provider_${status}` : 'provider_invalid');
        return finish(row, 'failed', { code: `provider_${status}`, attempts: next(row) });
    }
    async function runOnce() {
        if (!sendEnabled(env)) return { claimed: 0 };
        const allowed = allowedTypes(env), rows = await asDispatcher(pool, client => claimBatch(client));
        for (const row of rows) {
            try { await deliver(row, allowed); }
            catch (_) { log({ outboxId: row.outbox_id, type: row.email_type, status: 'sending', errorCode: 'dispatch_error' }); }
        }
        return { claimed: rows.length };
    }
    return Object.freeze({ runOnce });
}

// Production wiring: the App Service managed identity already reads these
// starter authority containers for sign-in. A subject key names one identity
// provider, so its record exists in at most one of them.
function createProductionDependencies(env, dependencies = {}) {
    const fail = () => { throw new Error('lifecycle_email_configuration_invalid'); };
    const containerName = /^(?!.*--)[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
    const names = [env.NOFRIES_EXTERNAL_CUSTOMER_AUTHORITY_CONTAINER, env.NOFRIES_STARTER_AUTHORITY_CONTAINER].filter(Boolean);
    const from = String(env.NOFRIES_LIFECYCLE_EMAIL_FROM || env.NOFRIES_SCOPE_EMAIL_FROM || '').trim();
    if (!/^[a-z0-9]{3,24}$/.test(env.AZURE_STORAGE_ACCOUNT_NAME || '') || !names.length ||
        !names.every(name => containerName.test(name)) || !from || !String(env.RESEND_API_KEY || '').trim()) fail();
    const { createCustomerRecords, authority } = require('../customerSignup/customerAuthority'), { createPostgresPool } = require('../database/postgres');
    const ManagedIdentityCredential = dependencies.ManagedIdentityCredential || require('@azure/identity').ManagedIdentityCredential;
    const BlobServiceClient = dependencies.BlobServiceClient || require('@azure/storage-blob').BlobServiceClient;
    const credential = env.NOFRIES_MANAGED_IDENTITY_CLIENT_ID
        ? new ManagedIdentityCredential({ clientId: env.NOFRIES_MANAGED_IDENTITY_CLIENT_ID }) : new ManagedIdentityCredential();
    const service = new BlobServiceClient(`https://${env.AZURE_STORAGE_ACCOUNT_NAME}.blob.core.windows.net`, credential,
        { retryOptions: { maxTries: 2, tryTimeoutInMs: 4000 } });
    const stores = names.map(name => createCustomerRecords({ authorityContainer: service.getContainerClient(name), sessionContainer: null }));
    async function resolveAddress(subjectKey) {
        for (const records of stores) {
            const raw = await records.readSubject(subjectKey);
            if (raw !== null) return authority(raw, subjectKey, Date.now()).email;
        }
        return null;
    }
    const pool = (dependencies.createPostgresPool || createPostgresPool)({ env, credential, poolMax: 2, statementTimeoutMs: 15000,
        connectionTimeoutMs: 5000, applicationName: 'nofries-lifecycle-email' });
    return { pool, resolveAddress, send: createResendClient({ apiKey: env.RESEND_API_KEY }).send, from,
        publicOrigin: new URL(env.NOFRIES_PUBLIC_URL || 'https://nofries.nz').origin };
}

let active = null;
function startLifecycleEmailDispatcher({ env = process.env, dependencies, setIntervalImpl = setInterval, log = defaultLog } = {}) {
    if (!sendEnabled(env)) return null;
    if (active) return active;
    const dispatcher = createLifecycleEmailDispatcher({ env, log, ...createProductionDependencies(env, dependencies) });
    let running = false;
    async function tick() {
        if (running) return;
        running = true;
        try { await dispatcher.runOnce(); } catch (_) { log({ outboxId: null, type: null, status: 'run', errorCode: 'run_failed' }); } finally { running = false; }
    }
    const timer = setIntervalImpl(tick, INTERVAL_MS); timer?.unref?.();
    active = Object.freeze({ tick, stop() { clearInterval(timer); active = null; } });
    return active;
}

function defaultLog({ outboxId, type, status, errorCode }) {
    console.info(JSON.stringify({ event: 'lifecycle_email', outboxId, type, status, errorCode }));
}

module.exports = { createLifecycleEmailDispatcher, startLifecycleEmailDispatcher, claimBatch, asDispatcher, sendEnabled, allowedTypes,
    BACKOFF_MS, BATCH, INTERVAL_MS, CLAIM_SQL };
