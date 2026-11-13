'use strict';

// Lifecycle email sender (#151, slices E4/E5), off unless
// NOFRIES_LIFECYCLE_EMAIL_SEND_ENABLED is exactly 'true'. Each run claims due
// outbox rows as nofries_email_dispatcher, resolves the address at send time
// (account -> subject key -> customer-subjects record) and sends plain text.
// The address is never stored, cached or logged; logs carry only the outbox id,
// type, status and error code.
const { renderTemplate } = require('./templates');
const { createResendClient } = require('./resendClient');
const { createUnsubscribeToken, unsubscribeConfigured } = require('./unsubscribeToken');

const TYPES = Object.freeze(['welcome', 'result_summary', 'nudge_unfinished', 'reassess_reminder']);
// The Unsolicited Electronic Messages Act 2007 requires a working unsubscribe
// facility. Without NOFRIES_EMAIL_UNSUBSCRIBE_SECRET there are no signed links,
// so the non-transactional types are never claimed, even when allow-listed, and
// their rows stay pending.
const AWAITING_UNSUBSCRIBE = Object.freeze(['nudge_unfinished', 'reassess_reminder']);
const BATCH = 20;
const INTERVAL_MS = 5 * 60 * 1000;
const BACKOFF_MS = Object.freeze([5 * 60e3, 30 * 60e3, 2 * 3600e3, 8 * 3600e3, 24 * 3600e3]);
const MAX_ATTEMPTS = BACKOFF_MS.length + 1;
// Resend ids are UUIDs; refusing '@' keeps any address-shaped value out of the row.
const PROVIDER_ID = /^[A-Za-z0-9._:-]{1,200}$/;
// Due pending rows of the sendable types, plus expired leases after a crash.
// Each claim counts as an attempt, so a crash loop stops at the cap; the lease
// value fences every later update to this claim.
const CLAIM_SQL = `UPDATE nofries.email_outbox o SET status='sending', attempts=LEAST(o.attempts+1, ${MAX_ATTEMPTS}),
        locked_until=clock_timestamp()+interval '10 minutes'
    FROM (SELECT outbox_id, attempts FROM nofries.email_outbox
        WHERE email_type = ANY($2::text[])
          AND ((status='pending' AND not_before<=clock_timestamp()) OR (status='sending' AND locked_until<clock_timestamp()))
        ORDER BY not_before, outbox_id LIMIT $1 FOR UPDATE SKIP LOCKED) c
    WHERE o.outbox_id = c.outbox_id
    RETURNING o.outbox_id, o.account_id, o.email_type, o.template_version, o.attempts, c.attempts AS prior_attempts,
        extract(epoch FROM o.locked_until)::text AS lease`;
const RECIPIENT_SQL = `SELECT a.account_id, a.subject_key, ARRAY(SELECT p.email_type FROM nofries.email_preferences p
    WHERE p.account_id=a.account_id AND p.unsubscribed_at IS NOT NULL) AS unsubscribed
    FROM nofries.dashboard_starter_accounts a WHERE a.account_id = ANY($1::uuid[])`;
const FENCE = "WHERE outbox_id=$1 AND status='sending' AND extract(epoch FROM locked_until) = $2::numeric";
const SETS = Object.freeze({ suppressed: ["status='suppressed', last_error_code=$3", ['code']],
    sent: ["status='sent', sent_at=clock_timestamp(), provider_message_id=$3", ['providerId']],
    failed: ["status='failed', last_error_code=$3", ['code']],
    pending: ["status='pending', last_error_code=$3, not_before=clock_timestamp()+$4::int*interval '1 millisecond'", ['code', 'delayMs']] });

const sendEnabled = env => env.NOFRIES_LIFECYCLE_EMAIL_SEND_ENABLED === 'true';
// Unset means every type; an empty or invalid list means none.
function allowedTypes(env) {
    if (env.NOFRIES_LIFECYCLE_EMAIL_TYPES === undefined) return new Set(TYPES);
    const values = String(env.NOFRIES_LIFECYCLE_EMAIL_TYPES).split(',').map(value => value.trim());
    return values.every(value => TYPES.includes(value)) ? new Set(values) : new Set();
}
const sendableTypes = env => [...allowedTypes(env)].filter(type => unsubscribeConfigured(env) || !AWAITING_UNSUBSCRIBE.includes(type));
const UNSUBSCRIBE_PATH = '/api/emailPreferences';

// A signed per-account, per-type link plus RFC 8058 one-click headers, or, with
// no secret, the sign-in link and no headers (the behaviour before E6).
function unsubscribeFor(env, publicOrigin, row) {
    if (!unsubscribeConfigured(env)) return { url: `${publicOrigin}/dashboard`, headers: null };
    const token = createUnsubscribeToken({ accountId: row.account_id, subjectKey: row.subjectKey, emailType: row.email_type }, env);
    const url = `${publicOrigin}${UNSUBSCRIBE_PATH}?t=${encodeURIComponent(token)}`;
    return { url, headers: { 'List-Unsubscribe': `<${url}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } };
}

async function asDispatcher(pool, work) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN'); await client.query('SET LOCAL ROLE nofries_email_dispatcher');
        const result = await work(client); await client.query('COMMIT'); return result;
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; } finally { client.release(); }
}

async function claimBatch(client, types, limit = BATCH) {
    const rows = (await client.query(CLAIM_SQL, [limit, types])).rows;
    const ids = [...new Set(rows.map(row => row.account_id))];
    const recipients = new Map(ids.length ? (await client.query(RECIPIENT_SQL, [ids])).rows.map(row => [row.account_id, row]) : []);
    return rows.map(row => ({ ...row, subjectKey: recipients.get(row.account_id)?.subject_key ?? null,
        unsubscribed: (recipients.get(row.account_id)?.unsubscribed || []).includes(row.email_type) }));
}

function createLifecycleEmailDispatcher({ env = process.env, pool, resolveAddress, send, from, publicOrigin, log = defaultLog }) {
    async function finish(row, status, extra = {}) {
        const [set, keys] = SETS[status];
        const result = await asDispatcher(pool, client => client.query(`UPDATE nofries.email_outbox SET locked_until=NULL, ${set} ${FENCE}`,
            [row.outbox_id, row.lease, ...keys.map(key => extra[key] ?? null)]));
        if (result.rowCount !== 1) return log({ outboxId: row.outbox_id, type: null, status: null, errorCode: 'lease_lost' });
        log({ outboxId: row.outbox_id, type: row.email_type, status, errorCode: extra.code ?? null });
    }
    function retry(row, code) {
        if (row.attempts >= MAX_ATTEMPTS) return finish(row, 'failed', { code });
        return finish(row, 'pending', { code, delayMs: BACKOFF_MS[row.attempts - 1] });
    }
    async function deliver(row) {
        if (row.prior_attempts >= MAX_ATTEMPTS) return finish(row, 'failed', { code: 'attempts_exhausted' });
        if (row.unsubscribed) return finish(row, 'suppressed', { code: 'unsubscribed' });
        if (!row.subjectKey) return finish(row, 'failed', { code: 'recipient_missing' });
        let message, unsubscribe;
        const signInUrl = `${publicOrigin}/dashboard`;
        try { unsubscribe = unsubscribeFor(env, publicOrigin, row); }
        catch (_) { return finish(row, 'failed', { code: 'unsubscribe_link_invalid' }); }
        try { message = renderTemplate(row.email_type, row.template_version, { signInUrl, unsubscribeUrl: unsubscribe.url }); }
        catch (_) { return finish(row, 'failed', { code: 'template_unknown' }); }
        let address;
        try { address = await resolveAddress(row.subjectKey); }
        catch (error) { return error?.statusCode === 401 ? finish(row, 'failed', { code: 'recipient_invalid' }) : retry(row, 'recipient_store_unavailable'); }
        if (!address) return finish(row, 'failed', { code: 'recipient_missing' });
        let response;
        try {
            response = await send({ from, to: address, subject: message.subject, text: message.text, idempotencyKey: row.outbox_id,
                ...(unsubscribe.headers ? { headers: unsubscribe.headers } : {}) });
        } catch (_) { return retry(row, 'network_error'); }
        if (response?.ok) {
            let id = null;
            try { id = (await response.json())?.id; } catch (_) { /* sent; the id is optional */ }
            return finish(row, 'sent', { providerId: typeof id === 'string' && PROVIDER_ID.test(id) ? id : null });
        }
        const status = Number(response?.status) || 0;
        if (status === 429 || status >= 500 || !status) return retry(row, status ? `provider_${status}` : 'provider_invalid');
        return finish(row, 'failed', { code: `provider_${status}` });
    }
    async function runOnce() {
        const types = sendEnabled(env) ? sendableTypes(env) : [];
        if (!types.length) return { claimed: 0 };
        const rows = await asDispatcher(pool, client => claimBatch(client, types));
        for (const row of rows) {
            try { await deliver(row); }
            catch (_) { log({ outboxId: row.outbox_id, type: row.email_type, status: 'sending', errorCode: 'dispatch_error' }); }
        }
        return { claimed: rows.length };
    }
    return Object.freeze({ runOnce });
}

// Production wiring: the App Service managed identity already reads these
// starter authority containers for sign-in. A subject key names one identity
// provider, so its record exists in at most one of them. The database login
// defaults to the existing one; NOFRIES_EMAIL_DISPATCHER_DB_CLIENT_ID and
// NOFRIES_EMAIL_DISPATCHER_DB_USER select a dedicated managed identity instead.
function createProductionDependencies(env, dependencies = {}) {
    const fail = () => { throw new Error('lifecycle_email_configuration_invalid'); };
    const containerName = /^(?!.*--)[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/, uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const names = [env.NOFRIES_EXTERNAL_CUSTOMER_AUTHORITY_CONTAINER, env.NOFRIES_STARTER_AUTHORITY_CONTAINER].filter(Boolean);
    const from = String(env.NOFRIES_LIFECYCLE_EMAIL_FROM || env.NOFRIES_SCOPE_EMAIL_FROM || '').trim();
    const dbClientId = env.NOFRIES_EMAIL_DISPATCHER_DB_CLIENT_ID, dbUser = env.NOFRIES_EMAIL_DISPATCHER_DB_USER;
    if (!/^[a-z0-9]{3,24}$/.test(env.AZURE_STORAGE_ACCOUNT_NAME || '') || !names.length ||
        !names.every(name => containerName.test(name)) || !from || !String(env.RESEND_API_KEY || '').trim() ||
        Boolean(dbClientId) !== Boolean(dbUser) || dbClientId && !uuid.test(dbClientId)) fail();
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
    const pool = (dependencies.createPostgresPool || createPostgresPool)({ env, poolMax: 2, statementTimeoutMs: 15000,
        connectionTimeoutMs: 5000, applicationName: 'nofries-lifecycle-email',
        ...(dbClientId ? { credential: new ManagedIdentityCredential({ clientId: dbClientId }), user: dbUser } : { credential }) });
    return { pool, resolveAddress, send: createResendClient({ apiKey: env.RESEND_API_KEY }).send, from,
        publicOrigin: new URL(env.NOFRIES_PUBLIC_URL || 'https://nofries.nz').origin };
}

// Never throws: a configuration, setup or probe failure logs one fixed code and
// leaves the host running without the sender. Runs are scheduled only after the
// login is confirmed able to SET ROLE nofries_email_dispatcher.
let active = null;
function startLifecycleEmailDispatcher({ env = process.env, dependencies, setIntervalImpl = setInterval, log = defaultLog } = {}) {
    if (!sendEnabled(env)) return null;
    if (active) return active;
    let dispatcher, pool, timer = null, running = false;
    try {
        const production = createProductionDependencies(env, dependencies);
        pool = production.pool;
        dispatcher = createLifecycleEmailDispatcher({ env, log, ...production });
    } catch (_) {
        log({ outboxId: null, type: null, status: null, errorCode: 'dispatcher_start_failed' });
        return null;
    }
    async function tick() {
        if (running) return;
        running = true;
        try { await dispatcher.runOnce(); } catch (_) { log({ outboxId: null, type: null, status: null, errorCode: 'run_failed' }); } finally { running = false; }
    }
    const handle = { tick, stop() { if (timer) clearInterval(timer); if (active === handle) active = null; } };
    handle.ready = (async () => {
        let allowed = false;
        try { allowed = (await pool.query("SELECT pg_has_role(current_user,'nofries_email_dispatcher','SET') AS ok")).rows[0]?.ok === true; }
        catch (_) { /* treated as unavailable */ }
        if (!allowed) {
            log({ outboxId: null, type: null, status: null, errorCode: 'dispatcher_role_unavailable' });
            return false;
        }
        if (active !== handle) return false;
        timer = setIntervalImpl(tick, INTERVAL_MS); timer?.unref?.();
        return true;
    })();
    active = Object.freeze(handle);
    return active;
}

function defaultLog({ outboxId, type, status, errorCode }) {
    console.info(JSON.stringify({ event: 'lifecycle_email', outboxId, type, status, errorCode }));
}

module.exports = { createLifecycleEmailDispatcher, startLifecycleEmailDispatcher, claimBatch, asDispatcher, sendEnabled, allowedTypes,
    sendableTypes, AWAITING_UNSUBSCRIBE, BACKOFF_MS, BATCH, INTERVAL_MS, CLAIM_SQL };
