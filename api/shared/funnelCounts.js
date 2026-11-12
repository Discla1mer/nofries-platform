'use strict';

// Aggregate-only funnel counts (issue #151, slice F2). One upsert per accepted
// event into nofries.funnel_daily_counts for the Pacific/Auckland day. Nothing
// here reads, stores or logs an IP, user agent, referrer, URL or cookie; the
// client key is used only as an in-memory rate-limit bucket.
const { checkRateLimit, getClientKeyFromHeaders, rateLimitHeaders } = require('./abuseProtection');
const { apiSecurityHeaders, assertSameOriginForMutation } = require('./securityHeaders');
const { requestBodySize } = require('./requestLimits');

const FUNNEL_EVENTS = Object.freeze(['visit', 'signup_started', 'code_confirmed', 'first_answer',
    'submitted', 'result_viewed', 'enquiry_sent']);
const MAX_REQUEST_BYTES = 64;
const UPSERT_SQL = `INSERT INTO nofries.funnel_daily_counts (day, event, count) VALUES ($1, $2, 1)
    ON CONFLICT (day, event) DO UPDATE SET count = funnel_daily_counts.count + 1`;
const NZ_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit' });

function funnelCountsEnabled(env = process.env) {
    return Boolean(env) && env.NOFRIES_FUNNEL_COUNTS_ENABLED === 'true';
}

function aucklandDay(now = new Date()) {
    return NZ_DAY.format(now);
}

function createFunnelCountWriter({ pool }) {
    if (!pool || typeof pool.connect !== 'function') throw new Error('funnel_counts_pool_invalid');
    return async function record(event, day) {
        const client = await pool.connect();
        let discard = false;
        try {
            await client.query('BEGIN');
            try {
                await client.query('SET LOCAL ROLE nofries_runtime');
                await client.query(UPSERT_SQL, [day, event]);
                await client.query('COMMIT');
            } catch (error) {
                try { await client.query('ROLLBACK'); } catch (_) { discard = true; }
                throw error;
            }
        } catch (error) {
            discard = true;
            throw error;
        } finally {
            client.release(discard);
        }
    };
}

function retired() {
    return result(410, { error: 'Public acquisition telemetry is disabled', code: 'telemetry_disabled' });
}

async function handleFunnelCountRequest(req, { env = process.env, record = null, now = () => new Date(), log = null, clientKey = '' } = {}) {
    if (!funnelCountsEnabled(env)) return retired();
    if (String(req && req.method || '').toUpperCase() !== 'POST') {
        return result(405, { error: 'Method not allowed', code: 'method_not_allowed' }, { Allow: 'POST' });
    }
    if (requestBodySize(req) > MAX_REQUEST_BYTES) {
        return result(413, { error: 'Request body is too large', code: 'request_too_large' });
    }
    try {
        assertSameOriginForMutation(req, env);
    } catch (error) {
        return result(403, { error: 'Request blocked', code: 'same_origin_required' });
    }
    const limit = checkRateLimit('apiTelemetry', getClientKeyFromHeaders((req && req.headers) || {}, clientKey || 'unknown'), env);
    if (!limit.allowed) return result(429, { error: 'Too many requests', code: 'rate_limited' }, rateLimitHeaders(limit));
    const event = readEvent(req && req.body);
    if (!event) return result(400, { error: 'Unknown event', code: 'invalid_event' });
    if (typeof record !== 'function') return result(503, { error: 'Funnel counts are unavailable', code: 'funnel_counts_unavailable' });
    try {
        await record(event, aucklandDay(now()));
    } catch (_) {
        // Fixed text only: no driver error, request detail or visitor data.
        if (log && typeof log.warn === 'function') log.warn('funnel_count_write_failed');
        return result(503, { error: 'Funnel counts are unavailable', code: 'funnel_counts_unavailable' });
    }
    return { status: 204, headers: apiSecurityHeaders(), body: null, isRaw: true };
}

function readEvent(body) {
    let value = body;
    if (Buffer.isBuffer(value)) value = value.toString('utf8');
    if (typeof value === 'string') {
        try { value = JSON.parse(value); } catch (_) { return null; }
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const keys = Object.keys(value);
    if (keys.length !== 1 || keys[0] !== 'event') return null;
    return typeof value.event === 'string' && FUNNEL_EVENTS.includes(value.event) ? value.event : null;
}

function result(status, body, extraHeaders = {}) {
    return { status, headers: apiSecurityHeaders({ 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders }), body };
}

module.exports = {
    FUNNEL_EVENTS,
    MAX_REQUEST_BYTES,
    UPSERT_SQL,
    aucklandDay,
    createFunnelCountWriter,
    funnelCountsEnabled,
    handleFunnelCountRequest
};
