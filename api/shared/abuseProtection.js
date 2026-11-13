const { createHmac, randomBytes } = require('node:crypto');

const rateLimitBuckets = new Map();
const MAX_RATE_LIMIT_BUCKETS = 6000;

const defaultRateLimits = {
    apiRead: { windowMs: 15 * 60 * 1000, max: 240 },
    apiWrite: { windowMs: 10 * 60 * 1000, max: 90 },
    // Dashboard traffic from a session the server has already verified is
    // counted per session, so people sharing an office address do not use up
    // each other's allowance. Unverified cookies stay on apiRead/apiWrite.
    dashboardSessionRead: { windowMs: 15 * 60 * 1000, max: 600 },
    dashboardSessionWrite: { windowMs: 10 * 60 * 1000, max: 120 },
    dashboardAddressRead: { windowMs: 15 * 60 * 1000, max: 1800 },
    dashboardAddressWrite: { windowMs: 10 * 60 * 1000, max: 360 },
    apiUpload: { windowMs: 15 * 60 * 1000, max: 12 },
    apiBilling: { windowMs: 10 * 60 * 1000, max: 12 },
    apiWebhook: { windowMs: 10 * 60 * 1000, max: 120 },
    apiShare: { windowMs: 10 * 60 * 1000, max: 120 },
    apiTelemetry: { windowMs: 10 * 60 * 1000, max: 90 },
    apiLead: { windowMs: 10 * 60 * 1000, max: 30 },
    apiScopeRequest: { windowMs: 10 * 60 * 1000, max: 5 },
    apiEnquiry: { windowMs: 10 * 60 * 1000, max: 5 },
    apiScopeVerify: { windowMs: 10 * 60 * 1000, max: 20 },
    apiScopeContent: { windowMs: 15 * 60 * 1000, max: 120 },
    apiProspectSession: { windowMs: 10 * 60 * 1000, max: 30 },
    apiProspectChat: { windowMs: 10 * 60 * 1000, max: 20 }
};

const defaultBlockedUserAgentFragments = [
    'sqlmap',
    'nikto',
    'masscan',
    'zgrab',
    'nuclei',
    'dirbuster',
    'ffuf'
];

function getClientKeyFromHeaders(headers, fallback) {
    const forwarded = String(getHeader(headers, 'x-forwarded-for') || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
    // Azure's forwarding layer appends the socket address to any client-supplied
    // X-Forwarded-For value, so the final entry cannot be chosen by the caller.
    const clientIp = forwarded.length
        ? forwarded[forwarded.length - 1]
        : getHeader(headers, 'x-client-ip') || getHeader(headers, 'x-real-ip') || fallback || 'unknown';
    return normaliseClientAddress(clientIp);
}

function normaliseClientAddress(value) {
    const text = String(value || '').trim().slice(0, 256);
    const bracketed = text.match(/^\[([^\]]+)\](?::\d{1,5})?$/);
    if (bracketed) return bracketed[1].slice(0, 128) || 'unknown';
    const ipv4WithPort = text.match(/^((?:\d{1,3}\.){3}\d{1,3}):\d{1,5}$/);
    if (ipv4WithPort) return ipv4WithPort[1];
    return text.slice(0, 128) || 'unknown';
}

function isBlockedUserAgent(userAgent, env = process.env) {
    const text = String(userAgent || '').toLowerCase();
    if (!text) {
        return false;
    }

    return getBlockedUserAgentFragments(env).some((fragment) => text.includes(fragment));
}

function checkRateLimit(bucketName, clientKey, env = process.env) {
    const limit = getRateLimit(bucketName, env);
    const now = Date.now();
    const bucketKey = `${bucketName}:${clientKey || 'unknown'}`;
    if (!rateLimitBuckets.has(bucketKey) && rateLimitBuckets.size >= MAX_RATE_LIMIT_BUCKETS) {
        cleanupBuckets(now, true);
    }
    const bucket = rateLimitBuckets.get(bucketKey) || [];
    const recent = bucket.filter((timestamp) => now - timestamp < limit.windowMs);

    if (recent.length >= limit.max) {
        rateLimitBuckets.set(bucketKey, recent);
        return {
            allowed: false,
            limit: limit.max,
            retryAfterSeconds: Math.max(1, Math.ceil((limit.windowMs - (now - recent[0])) / 1000))
        };
    }

    recent.push(now);
    // Re-insert so eviction under the bucket cap drops the least recently
    // used keys first, never an address that is still sending requests.
    rateLimitBuckets.delete(bucketKey);
    rateLimitBuckets.set(bucketKey, recent);
    cleanupBuckets(now);

    return {
        allowed: true,
        limit: limit.max,
        remaining: Math.max(0, limit.max - recent.length)
    };
}

const DASHBOARD_SESSION_COOKIES = ['__Host-nofries-auth', '__Host-nofries-customer', '__Host-nofries-external-customer'];
const MAX_VERIFIED_DASHBOARD_SESSIONS = 10000;
const MAX_VERIFIED_DASHBOARD_SESSION_TTL_MS = 15 * 60 * 1000;
// Keyed by an HMAC under a per-process secret, so no cookie value (or a
// digest that could be matched against one) is retained. Value: expiry time.
const verifiedDashboardSessions = new Map();
const verifiedSessionSecret = randomBytes(32);

function dashboardSessionDigest(name, value) {
    return createHmac('sha256', verifiedSessionSecret).update(name + '=' + value).digest('hex').slice(0, 32);
}

function isDashboardSessionCookie(name, value) {
    return DASHBOARD_SESSION_COOKIES.includes(name) && typeof value === 'string' && value.length >= 16 && value.length <= 4096;
}

// Called only after the server has issued or verified this exact session
// against the session store. Rate limiting never reads the store itself.
function markDashboardSessionVerified(name, value, ttlMs) {
    if (!isDashboardSessionCookie(name, value)) return;
    const ttl = Math.min(Number(ttlMs), MAX_VERIFIED_DASHBOARD_SESSION_TTL_MS);
    if (!Number.isFinite(ttl) || ttl <= 0) return;
    const key = dashboardSessionDigest(name, value);
    verifiedDashboardSessions.delete(key);
    verifiedDashboardSessions.set(key, Date.now() + ttl);
    while (verifiedDashboardSessions.size > MAX_VERIFIED_DASHBOARD_SESSIONS) {
        verifiedDashboardSessions.delete(verifiedDashboardSessions.keys().next().value);
    }
}

// Sign-out, expiry or an invalid record: the session loses the dashboard
// allowance at once rather than when its entry times out.
function forgetDashboardSession(name, value) {
    if (!isDashboardSessionCookie(name, value)) return;
    verifiedDashboardSessions.delete(dashboardSessionDigest(name, value));
}

// Returns the opaque key of a session cookie on this request that the server
// has already verified, or null. Unverified, fabricated or rotated cookie
// values return null, so those requests stay on the ordinary address limits.
function getVerifiedDashboardSessionKey(headers) {
    const header = getHeader(headers, 'cookie');
    const raw = Array.isArray(header) ? header.join(';') : String(header || '');
    if (!raw || raw.length > 16384) return null;
    const now = Date.now();
    const parts = raw.split(';');
    for (const name of DASHBOARD_SESSION_COOKIES) {
        for (const part of parts) {
            const index = part.indexOf('=');
            if (index < 0 || part.slice(0, index).trim() !== name) continue;
            const value = part.slice(index + 1).trim();
            if (!isDashboardSessionCookie(name, value)) continue;
            const key = dashboardSessionDigest(name, value);
            const expiresAt = verifiedDashboardSessions.get(key);
            if (expiresAt === undefined) continue;
            if (expiresAt <= now) { verifiedDashboardSessions.delete(key); continue; }
            return key;
        }
    }
    return null;
}

function rateLimitHeaders(result) {
    const headers = {
        'X-RateLimit-Limit': String(result.limit || '')
    };

    if (Number.isFinite(result.remaining)) {
        headers['X-RateLimit-Remaining'] = String(result.remaining);
    }

    if (!result.allowed && result.retryAfterSeconds) {
        headers['Retry-After'] = String(result.retryAfterSeconds);
    }

    return headers;
}

function getRateLimit(bucketName, env) {
    const fallback = defaultRateLimits[bucketName] || defaultRateLimits.apiRead;
    const prefix = `NOFRIES_RATE_${String(bucketName || '').replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()}`;
    const configuredMax = Number(env[`${prefix}_MAX`]);
    const configuredWindowMs = Number(env[`${prefix}_WINDOW_MS`]);

    return {
        max: Number.isFinite(configuredMax) && configuredMax > 0 ? configuredMax : fallback.max,
        windowMs: Number.isFinite(configuredWindowMs) && configuredWindowMs > 0 ? configuredWindowMs : fallback.windowMs
    };
}

function getBlockedUserAgentFragments(env) {
    const configured = String(env.NOFRIES_BLOCKED_USER_AGENTS || '')
        .split(',')
        .map((fragment) => fragment.trim().toLowerCase())
        .filter(Boolean);

    return configured.length ? configured : defaultBlockedUserAgentFragments;
}

function getHeader(headers, name) {
    const source = headers || {};
    return source[name] || source[name.toLowerCase()] || source[name.toUpperCase()] || '';
}

function cleanupBuckets(now, enforceCap = false) {
    if (!enforceCap && rateLimitBuckets.size <= 5000) {
        return;
    }

    const maxWindowMs = Math.max(...Object.values(defaultRateLimits).map((limit) => limit.windowMs));
    rateLimitBuckets.forEach((timestamps, key) => {
        const recent = timestamps.filter((timestamp) => now - timestamp < maxWindowMs);
        if (recent.length) {
            rateLimitBuckets.set(key, recent);
            return;
        }
        rateLimitBuckets.delete(key);
    });
    while (rateLimitBuckets.size >= MAX_RATE_LIMIT_BUCKETS) {
        const oldestKey = rateLimitBuckets.keys().next().value;
        if (!oldestKey) break;
        rateLimitBuckets.delete(oldestKey);
    }
}

function resetAbuseProtectionForTests() {
    rateLimitBuckets.clear();
    verifiedDashboardSessions.clear();
}

module.exports = {
    checkRateLimit,
    forgetDashboardSession,
    getVerifiedDashboardSessionKey,
    markDashboardSessionVerified,
    getClientKeyFromHeaders,
    isBlockedUserAgent,
    rateLimitHeaders,
    resetAbuseProtectionForTests
};
