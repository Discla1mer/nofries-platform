const rateLimitBuckets = new Map();
const MAX_RATE_LIMIT_BUCKETS = 6000;

const defaultRateLimits = {
    apiRead: { windowMs: 15 * 60 * 1000, max: 240 },
    apiWrite: { windowMs: 10 * 60 * 1000, max: 90 },
    apiUpload: { windowMs: 15 * 60 * 1000, max: 12 },
    apiBilling: { windowMs: 10 * 60 * 1000, max: 12 },
    apiWebhook: { windowMs: 10 * 60 * 1000, max: 120 },
    apiShare: { windowMs: 10 * 60 * 1000, max: 120 },
    apiTelemetry: { windowMs: 10 * 60 * 1000, max: 90 },
    apiLead: { windowMs: 10 * 60 * 1000, max: 30 },
    apiScopeRequest: { windowMs: 10 * 60 * 1000, max: 5 },
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
    rateLimitBuckets.set(bucketKey, recent);
    cleanupBuckets(now);

    return {
        allowed: true,
        limit: limit.max,
        remaining: Math.max(0, limit.max - recent.length)
    };
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
}

module.exports = {
    checkRateLimit,
    getClientKeyFromHeaders,
    isBlockedUserAgent,
    rateLimitHeaders,
    resetAbuseProtectionForTests
};
