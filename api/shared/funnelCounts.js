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

// Every count write, beacon or server-side, is bounded so it can never hold
// the shared dashboard pool: at most MAX_IN_FLIGHT writes per process (more
// are skipped), a bounded wait for a pooled client, and statement and lock
// timeouts inside the transaction.
const MAX_IN_FLIGHT = 2;
const ACQUIRE_TIMEOUT_MS = 500;
const STATEMENT_TIMEOUT_SQL = "SET LOCAL statement_timeout = '1000ms'";
const LOCK_TIMEOUT_SQL = "SET LOCAL lock_timeout = '500ms'";
let writesInFlight = 0;

function resetFunnelWritesForTests() { writesInFlight = 0; }

function codedError(code) { const error = new Error(code); error.code = code; return error; }

async function acquireClient(pool, timeoutMs) {
    let timer = null, timedOut = false;
    const connecting = Promise.resolve().then(() => pool.connect());
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => { timedOut = true; reject(codedError('funnel_count_acquire_timeout')); }, timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
    });
    try {
        return await Promise.race([connecting, timeout]);
    } catch (error) {
        // A client that arrives after we gave up goes straight back to the pool.
        if (timedOut) connecting.then(client => client.release(), () => {});
        throw error;
    } finally {
        clearTimeout(timer);
    }
}

function createFunnelCountWriter({ pool, acquireTimeoutMs = ACQUIRE_TIMEOUT_MS }) {
    if (!pool || typeof pool.connect !== 'function') throw new Error('funnel_counts_pool_invalid');
    return async function record(event, day) {
        if (writesInFlight >= MAX_IN_FLIGHT) throw codedError('funnel_count_busy');
        writesInFlight += 1;
        try {
            const client = await acquireClient(pool, acquireTimeoutMs);
            let discard = false;
            try {
                await client.query('BEGIN');
                try {
                    await client.query('SET LOCAL ROLE nofries_runtime');
                    await client.query(STATEMENT_TIMEOUT_SQL);
                    await client.query(LOCK_TIMEOUT_SQL);
                    await client.query(UPSERT_SQL, [day, event]);
                    await client.query('COMMIT');
                } catch (error) {
                    try { await client.query('ROLLBACK'); } catch (_) { discard = true; }
                    throw error;
                }
            } finally {
                client.release(discard);
            }
        } finally {
            writesInFlight -= 1;
        }
    };
}

// Server-side increments (#151 F3). These three steps are counted by their own
// handlers, never from the browser. Best-effort and fire-and-forget: called only
// after the business response is final, never awaited, bounded by a short
// timeout and silent apart from one fixed tag. The flag is read on each call.
const SERVER_FUNNEL_EVENTS = Object.freeze(['code_confirmed', 'submitted', 'enquiry_sent']);
// The beacon endpoint accepts only the steps the server cannot see itself.
const BROWSER_FUNNEL_EVENTS = Object.freeze(FUNNEL_EVENTS.filter(event => !SERVER_FUNNEL_EVENTS.includes(event)));

// Owner decision (#151): a visitor sending Global Privacy Control (Sec-GPC: 1)
// or Do Not Track (DNT: 1) is never counted, by the server or the beacon.
function privacySignal(headers) {
    if (!headers || typeof headers !== 'object') return false;
    const value = name => String(headers[name] ?? '').trim();
    return value('sec-gpc') === '1' || value('dnt') === '1';
}
const SERVER_COUNT_TIMEOUT_MS = 2000;

function createServerFunnelCounter({ env = process.env, record = null, log = null, now = () => new Date(),
    timeoutMs = SERVER_COUNT_TIMEOUT_MS } = {}) {
    return function countFunnelEvent(event, headers = null) {
        if (!funnelCountsEnabled(env) || typeof record !== 'function' || !SERVER_FUNNEL_EVENTS.includes(event) ||
            privacySignal(headers)) return;
        let timer = null;
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('funnel_count_timeout')), timeoutMs);
            if (typeof timer.unref === 'function') timer.unref();
        });
        Promise.race([Promise.resolve().then(() => record(event, aucklandDay(now()))), timeout])
            .catch(error => {
                // Skipped at the in-flight cap: expected under load, not a failure.
                if (error && error.code === 'funnel_count_busy') return;
                try { if (log && typeof log.warn === 'function') log.warn('funnel_count_write_failed'); } catch (_) { /* never surface */ }
            })
            .finally(() => clearTimeout(timer));
    };
}

// A successful NCSC submit through the dashboard runtime: POST to
// ncsc/assessments/<id>/submit (path relative to /api/dashboard) answered 200
// with a submitted assessment. A same-key replay after a lost response gets the
// same answer and counts again; the HTTP layer cannot tell the two apart.
function isAssessmentSubmit(method, path, result) {
    return method === 'POST' && typeof path === 'string' && /^\/ncsc\/assessments\/[^/]+\/submit$/.test(path) &&
        Boolean(result) && result.status === 200 && result.body?.assessment?.status === 'submitted';
}

// Staff view (#151 F5): the last 30 Pacific/Auckland days, oldest first,
// with a zero for every allow-listed event that has no row.
const FUNNEL_VIEW_DAYS = 30;
const READ_SQL = `SELECT to_char(day, 'YYYY-MM-DD') AS day, event, count FROM nofries.funnel_daily_counts
    WHERE day BETWEEN $1::date AND $2::date ORDER BY day, event`;

function funnelWindow(now = new Date()) {
    const to = aucklandDay(now);
    const [year, month, date] = to.split('-').map(Number);
    const days = [];
    for (let offset = FUNNEL_VIEW_DAYS - 1; offset >= 0; offset -= 1) {
        days.push(new Date(Date.UTC(year, month - 1, date - offset)).toISOString().slice(0, 10));
    }
    return Object.freeze({ from: days[0], to, days: Object.freeze(days) });
}

function projectFunnelView(rows, window) {
    const byDay = new Map(window.days.map(day => [day, Object.fromEntries(FUNNEL_EVENTS.map(event => [event, 0]))]));
    for (const row of Array.isArray(rows) ? rows : []) {
        const counts = row && byDay.get(row.day);
        const value = Number(row && row.count);
        if (!counts || !FUNNEL_EVENTS.includes(row.event) || !Number.isSafeInteger(value) || value < 0 || value > 10000000) {
            throw new Error('funnel_counts_row_invalid');
        }
        counts[row.event] = value;
    }
    return { from: window.from, to: window.to, events: [...FUNNEL_EVENTS],
        days: window.days.map(day => ({ day, counts: byDay.get(day) })) };
}

// Read-only, under the runtime role, with the same short timeouts as writes.
function createFunnelCountReader({ pool, now = () => new Date(), acquireTimeoutMs = ACQUIRE_TIMEOUT_MS }) {
    if (!pool || typeof pool.connect !== 'function') throw new Error('funnel_counts_pool_invalid');
    return async function readFunnelView() {
        const window = funnelWindow(now());
        // Same bounded wait for a pooled client as the count writes.
        const client = await acquireClient(pool, acquireTimeoutMs);
        let discard = false;
        try {
            await client.query('BEGIN READ ONLY');
            try {
                await client.query('SET LOCAL ROLE nofries_runtime');
                await client.query("SET LOCAL statement_timeout = '1000ms'");
                const result = await client.query(READ_SQL, [window.from, window.to]);
                await client.query('COMMIT');
                return projectFunnelView(result.rows, window);
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
    // Accepted but not counted for GPC / DNT, so the answer reveals nothing.
    if (privacySignal(req && req.headers)) return { status: 204, headers: apiSecurityHeaders(), body: null, isRaw: true };
    if (typeof record !== 'function') return result(503, { error: 'Funnel counts are unavailable', code: 'funnel_counts_unavailable' });
    try {
        await record(event, aucklandDay(now()));
    } catch (error) {
        // Fixed text only: no driver error, request detail or visitor data.
        // A skip at the in-flight cap is expected under load, not a failure.
        if (!(error && error.code === 'funnel_count_busy') && log && typeof log.warn === 'function') log.warn('funnel_count_write_failed');
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
    return typeof value.event === 'string' && BROWSER_FUNNEL_EVENTS.includes(value.event) ? value.event : null;
}

function result(status, body, extraHeaders = {}) {
    return { status, headers: apiSecurityHeaders({ 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders }), body };
}

module.exports = {
    BROWSER_FUNNEL_EVENTS,
    privacySignal,
    MAX_IN_FLIGHT,
    STATEMENT_TIMEOUT_SQL,
    LOCK_TIMEOUT_SQL,
    resetFunnelWritesForTests,
    SERVER_FUNNEL_EVENTS,
    createServerFunnelCounter,
    isAssessmentSubmit,
    FUNNEL_VIEW_DAYS,
    READ_SQL,
    createFunnelCountReader,
    funnelWindow,
    projectFunnelView,
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
