'use strict';

// Public unsubscribe endpoint for lifecycle email (#151, slice E6). GET only
// shows a confirm page, because mail scanners prefetch links; POST (the page's
// form, or an RFC 8058 one-click "List-Unsubscribe=One-Click" body) records the
// unsubscribe. The signed token is the only authority, so there is no
// same-origin check: one-click POSTs come from mail providers, not browsers.
// Answers never say whether an account exists, and nothing identifying is
// logged. Without NOFRIES_EMAIL_UNSUBSCRIBE_SECRET the route is a 404.
const { getClientKeyFromHeaders } = require('../abuseProtection');
const { apiSecurityHeaders } = require('../securityHeaders');
const { telemetryKey } = require('../funnelCounts');
const { verifyUnsubscribeToken, unsubscribeConfigured, MAX_TOKEN_LENGTH } = require('./unsubscribeToken');

const PATH = '/api/emailPreferences';
const MAX_BODY_BYTES = 1024;
// Never clears or moves an earlier unsubscribe: an existing row that is already
// unsubscribed is left exactly as it is.
const UPSERT_SQL = `INSERT INTO nofries.email_preferences (account_id, email_type, unsubscribed_at, source)
    VALUES ($1, $2, clock_timestamp(), 'link')
    ON CONFLICT (account_id, email_type) DO UPDATE SET unsubscribed_at = clock_timestamp(), source = 'link'
    WHERE email_preferences.unsubscribed_at IS NULL`;
const TYPE_LABELS = Object.freeze({ welcome: 'welcome emails', result_summary: 'result summary emails',
    nudge_unfinished: 'reminders to finish an assessment', reassess_reminder: 'reminders to reassess' });
// Own small limiters, like /api/telemetry: they neither spend nor are starved
// by the shared signup and enquiry budget.
// - Failed token checks are limited per client (IPv6 clients share their /64).
// - Valid tokens are never limited per client, because one-click POSTs arrive
//   from shared mail-provider addresses and a lost unsubscribe is a compliance
//   failure. Instead each account and email type is limited on its own, a
//   recorded unsubscribe is answered from memory (it is permanent, so the answer
//   stays true), and at most MAX_IN_FLIGHT writes may hold pool connections, so
//   a replayed token cannot starve the shared dashboard pool.
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 30;
const TOKEN_RATE_MAX = 5;
const MAX_IN_FLIGHT = 2;
const MAX_BUCKETS = 2000;

function createLimiter(max) {
    const buckets = new Map();
    return {
        allow(key, nowMs = Date.now()) {
            let bucket = buckets.get(key);
            if (!bucket || nowMs - bucket.start >= RATE_WINDOW_MS) {
                buckets.delete(key);
                if (buckets.size >= MAX_BUCKETS) {
                    for (const [oldKey, old] of buckets) if (nowMs - old.start >= RATE_WINDOW_MS) buckets.delete(oldKey);
                    if (buckets.size >= MAX_BUCKETS) buckets.delete(buckets.keys().next().value);
                }
                bucket = { start: nowMs, count: 0 };
                buckets.set(key, bucket);
            }
            bucket.count += 1;
            return bucket.count <= max;
        },
        clear() { buckets.clear(); }
    };
}

const clientLimiter = createLimiter(RATE_MAX);
const tokenLimiter = createLimiter(TOKEN_RATE_MAX);
// Bounded memory of recorded unsubscribes; oldest entries fall out first and a
// later replay then simply re-runs the idempotent write.
const recorded = new Set();
let inFlight = 0;

function remember(key) {
    recorded.delete(key);
    if (recorded.size >= MAX_BUCKETS) recorded.delete(recorded.values().next().value);
    recorded.add(key);
}

const allow = clientKey => clientLimiter.allow(telemetryKey(clientKey));

function resetUnsubscribeRateLimitForTests() { clientLimiter.clear(); tokenLimiter.clear(); recorded.clear(); inFlight = 0; }

// Runs as nofries_runtime with the account's subject as the RLS context, the
// same transaction shape as the funnel-count writer. The email_preferences_subject
// policy then admits only that subject's own account.
function createUnsubscribeWriter({ pool }) {
    if (!pool || typeof pool.connect !== 'function') throw new Error('unsubscribe_pool_invalid');
    return async function record({ accountId, subjectKey, emailType }) {
        const client = await pool.connect();
        let discard = false;
        try {
            await client.query('BEGIN');
            try {
                await client.query('SET LOCAL ROLE nofries_runtime');
                await client.query("SELECT set_config('nofries.subject_key', $1, true)", [subjectKey]);
                await client.query(UPSERT_SQL, [accountId, emailType]);
                await client.query('COMMIT');
            } catch (error) {
                try { await client.query('ROLLBACK'); } catch (_) { discard = true; }
                throw error;
            }
        } finally {
            client.release(discard);
        }
    };
}

const escape = value => String(value).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

function page(status, title, paragraphs, form = '') {
    const body = `<!DOCTYPE html>
<html lang="en-NZ">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)} | No Fries</title></head>
<body>
<main>
<h1>${escape(title)}</h1>
${paragraphs.map(text => `<p>${escape(text)}</p>`).join('\n')}
${form}</main>
</body>
</html>
`;
    return { status, isRaw: true, body, headers: apiSecurityHeaders({ 'Content-Type': 'text/html; charset=utf-8',
        // No script, style or third-party asset; the form may post back here only.
        'Content-Security-Policy': "default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'" }) };
}

const withHeaders = (result, extra) => ({ ...result, headers: { ...result.headers, ...extra } });
const invalid = () => page(400, 'This link is not valid', ['Check that you used the full link from the email. You can also manage email from your account settings.']);

function readToken(req) {
    const query = req && req.query && typeof req.query === 'object' ? req.query.t : undefined;
    const body = req && req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) ? req.body.t : undefined;
    const value = typeof query === 'string' ? query : body;
    return typeof value === 'string' && value.length <= MAX_TOKEN_LENGTH ? value : null;
}

async function handleUnsubscribeRequest(req, { env = process.env, record = null, log = null, clientKey = '' } = {}) {
    if (!unsubscribeConfigured(env)) return { status: 404, headers: apiSecurityHeaders({ 'Content-Type': 'application/json; charset=utf-8' }),
        body: { error: 'Not found', code: 'not_found' } };
    const method = String(req && req.method || '').toUpperCase();
    if (method !== 'GET' && method !== 'POST') {
        return withHeaders(page(405, 'Method not allowed', ['Use the link in the email.']), { Allow: 'GET, POST' });
    }
    const token = readToken(req);
    const claims = token ? verifyUnsubscribeToken(token, env) : null;
    // Only failed token checks are limited. One-click POSTs arrive from shared
    // mail-provider addresses, so a valid signed token must never be throttled:
    // a lost unsubscribe is a compliance failure, and valid writes are idempotent.
    if (!claims) {
        if (!allow(getClientKeyFromHeaders((req && req.headers) || {}, clientKey || 'unknown'))) {
            return withHeaders(page(429, 'Too many requests', ['Please wait a few minutes and try again.']), { 'Retry-After': '600' });
        }
        return invalid();
    }
    const label = TYPE_LABELS[claims.emailType];
    if (method === 'GET') {
        const form = `<form method="post" action="${PATH}?t=${encodeURIComponent(token)}">
<input type="hidden" name="List-Unsubscribe" value="One-Click">
<button type="submit">Unsubscribe</button>
</form>
`;
        return page(200, 'Unsubscribe from No Fries email', [`Select Unsubscribe to stop ${label}.`], form);
    }
    const done = page(200, 'You are unsubscribed', [`We will not send you ${label} again.`]);
    const busy = () => withHeaders(page(503, 'Please try again later', ['We could not update your email settings just now.']), { 'Retry-After': '60' });
    const key = `${claims.accountId}:${claims.emailType}`;
    if (recorded.has(key)) return done;
    if (!tokenLimiter.allow(key)) {
        return withHeaders(page(429, 'Too many requests', ['Please wait a few minutes and try again.']), { 'Retry-After': '600' });
    }
    if (typeof record !== 'function' || inFlight >= MAX_IN_FLIGHT) return busy();
    inFlight += 1;
    try {
        await record(claims);
    } catch (_) {
        // Fixed text only: no token, account, driver error or request detail.
        if (log && typeof log.warn === 'function') log.warn('email_unsubscribe_write_failed');
        return busy();
    } finally {
        inFlight -= 1;
    }
    remember(key);
    return done;
}

module.exports = { PATH, UPSERT_SQL, MAX_BODY_BYTES, RATE_MAX, TOKEN_RATE_MAX, MAX_IN_FLIGHT, createUnsubscribeWriter, handleUnsubscribeRequest,
    resetUnsubscribeRateLimitForTests };
