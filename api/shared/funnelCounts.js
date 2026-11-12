'use strict';

// Aggregate-only funnel counts (issue #151, slice F2). One upsert per accepted
// event into nofries.funnel_daily_counts for the Pacific/Auckland day. Nothing
// here reads, stores or logs an IP, user agent, referrer, URL or cookie; the
// client key is used only as an in-memory rate-limit bucket.
const { getClientKeyFromHeaders } = require('./abuseProtection');
const { apiSecurityHeaders, assertSameOriginForMutation } = require('./securityHeaders');
const { requestBodySize } = require('./requestLimits');

const FUNNEL_EVENTS = Object.freeze(['visit', 'signup_started', 'code_confirmed', 'first_answer',
    'submitted', 'result_viewed', 'enquiry_sent']);
const MAX_REQUEST_BYTES = 64;
const UPSERT_SQL = `INSERT INTO nofries.funnel_daily_counts (day, event, count) VALUES ($1, $2, 1)
    ON CONFLICT (day, event) DO UPDATE SET count = funnel_daily_counts.count + 1
    WHERE funnel_daily_counts.count < 10000000`;
// Telemetry keeps its own small rate-limit store so this cheap anonymous
// endpoint can never evict the shared enquiry and signup buckets. IPv6
// clients are keyed on their /64 so rotating addresses inside one network
// share a bucket.
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 90;
const MAX_TELEMETRY_BUCKETS = 2000;
const telemetryBuckets = new Map();

function expandIpv6(address) {
    const value = address.split('%')[0].toLowerCase();
    if (!/^[0-9a-f:.]+$/.test(value) || (value.match(/::/g) || []).length > 1) return null;
    const [head, tail = null] = value.split('::');
    const left = head ? head.split(':') : [];
    const right = tail === null ? [] : (tail ? tail.split(':') : []);
    const parts = [...left, ...right];
    if (parts.some(part => part.includes('.'))) {
        const v4 = parts.pop().split('.').map(Number);
        if (v4.length !== 4 || v4.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null;
        parts.push(((v4[0] << 8) | v4[1]).toString(16), ((v4[2] << 8) | v4[3]).toString(16));
        if (tail === null) left.splice(0, left.length, ...parts); else right.splice(0, right.length, ...parts.slice(left.length));
    }
    const all = tail === null ? parts : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
    if (all.length !== 8 || all.some(part => !/^[0-9a-f]{1,4}$/.test(part))) return null;
    return all.map(part => part.padStart(4, '0'));
}

function telemetryKey(clientKey) {
    const key = String(clientKey || 'unknown');
    if (!key.includes(':')) return key;
    const hextets = expandIpv6(key);
    return hextets ? hextets.slice(0, 4).join(':') + '::/64' : key;
}

function allowTelemetry(clientKey, nowMs = Date.now()) {
    const key = telemetryKey(clientKey);
    let bucket = telemetryBuckets.get(key);
    if (!bucket || nowMs - bucket.start >= RATE_WINDOW_MS) {
        telemetryBuckets.delete(key);
        if (telemetryBuckets.size >= MAX_TELEMETRY_BUCKETS) {
            for (const [oldKey, old] of telemetryBuckets) {
                if (nowMs - old.start >= RATE_WINDOW_MS) telemetryBuckets.delete(oldKey);
            }
            if (telemetryBuckets.size >= MAX_TELEMETRY_BUCKETS) telemetryBuckets.delete(telemetryBuckets.keys().next().value);
        }
        bucket = { start: nowMs, count: 0 };
        telemetryBuckets.set(key, bucket);
    }
    bucket.count += 1;
    return bucket.count <= RATE_MAX;
}

function resetTelemetryRateLimitForTests() { telemetryBuckets.clear(); }

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
    if (!allowTelemetry(getClientKeyFromHeaders((req && req.headers) || {}, clientKey || 'unknown'))) {
        return result(429, { error: 'Too many requests', code: 'rate_limited' }, { 'Retry-After': '600' });
    }
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
    resetTelemetryRateLimitForTests,
    telemetryKey,
    FUNNEL_EVENTS,
    MAX_REQUEST_BYTES,
    UPSERT_SQL,
    aucklandDay,
    createFunnelCountWriter,
    funnelCountsEnabled,
    handleFunnelCountRequest
};
