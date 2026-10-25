const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_MAX_PAGES = 10;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const {
    createDattoRmmAuthProvider,
    normaliseApiBase
} = require('./dattoRmmAuthProvider');

class DattoRmmError extends Error {
    constructor(statusCode, message, code, details = {}) {
        super(message);
        this.statusCode = statusCode;
        this.details = Object.assign({ code }, details);
    }
}

function createDattoRmmClient(options = {}) {
    const env = options.env || process.env;
    const fetchImpl = options.fetch || globalThis.fetch;
    const now = options.now || (() => new Date());
    const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 1000, 30000);
    const maxPages = positiveInteger(options.maxPages, DEFAULT_MAX_PAGES, 1, 20);
    const auth = options.authProvider || createDattoRmmAuthProvider({
        env,
        fetch: fetchImpl,
        now,
        timeoutMs
    });
    const config = auth.connection();

    function status() {
        return auth.status();
    }

    async function health() {
        assertConfigured();
        const payload = await requestApi('/api/v2/system/status');
        return {
            connected: true,
            checkedAt: now().toISOString(),
            provider: 'datto_rmm',
            mode: config.mode,
            platform: {
                status: cleanText(payload && (payload.status || payload.systemStatus), 80),
                version: cleanText(payload && (payload.version || payload.systemVersion), 120)
            }
        };
    }

    async function listSites() {
        assertConfigured();
        const result = await requestCollection('/api/v2/account/sites?max=250', ['sites']);
        return {
            sites: result.items.map(normaliseSite).filter((site) => site.siteUid),
            truncated: result.truncated,
            pages: result.pages
        };
    }

    async function getSiteSnapshot(siteUid) {
        assertConfigured();
        const safeSiteUid = requireUid(siteUid, 'datto_rmm_site_uid_invalid');
        const encoded = encodeURIComponent(safeSiteUid);
        const [sitePayload, deviceResult, alertResult] = await Promise.all([
            requestApi(`/api/v2/site/${encoded}`),
            requestCollection(`/api/v2/site/${encoded}/devices?max=250`, ['devices']),
            requestCollection(`/api/v2/site/${encoded}/alerts/open?max=250`, ['alerts'])
        ]);
        const site = normaliseSite(sitePayload);
        if (!site.siteUid) site.siteUid = safeSiteUid;
        return {
            site,
            devices: deviceResult.items.map(normaliseDevice).filter((device) => device.deviceUid),
            openAlerts: alertResult.items.map(normaliseAlert).filter((alert) => alert.alertUid),
            truncated: deviceResult.truncated || alertResult.truncated,
            readOnly: true,
            capturedAt: now().toISOString()
        };
    }

    async function requestCollection(initialPath, keys) {
        let next = initialPath;
        let pages = 0;
        let truncated = false;
        const items = [];
        const seen = new Set();
        while (next && pages < maxPages) {
            const requestUrl = buildApiUrl(config.apiBase, next);
            if (seen.has(requestUrl)) {
                throw new DattoRmmError(502, 'Datto RMM returned a repeated pagination URL', 'datto_rmm_pagination_invalid');
            }
            seen.add(requestUrl);
            const payload = await requestApi(requestUrl);
            const pageItems = extractCollection(payload, keys);
            items.push(...pageItems);
            pages += 1;
            next = extractNextPage(payload);
        }
        if (next) truncated = true;
        return { items, pages, truncated };
    }

    async function requestApi(pathOrUrl, attempt = 0) {
        assertConfigured();
        if (typeof fetchImpl !== 'function') {
            throw new DattoRmmError(503, 'The Datto RMM HTTP client is unavailable', 'datto_rmm_http_unavailable');
        }
        const url = buildApiUrl(config.apiBase, pathOrUrl);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let response;
        try {
            const accessToken = await auth.getAccessToken();
            response = await fetchImpl(url, {
                method: 'GET',
                headers: {
                    Accept: 'application/json',
                    Authorization: `Bearer ${accessToken}`,
                    'User-Agent': 'NoFries-DattoRMM-Reader/1.0'
                },
                redirect: 'error',
                signal: controller.signal
            });
        } catch (error) {
            if (error && error.details && /^datto_rmm_(auth|not_configured|rate_limited)/.test(String(error.details.code || ''))) {
                throw error;
            }
            if (error && error.name === 'AbortError') {
                throw new DattoRmmError(504, 'Datto RMM did not respond before the timeout', 'datto_rmm_timeout');
            }
            throw new DattoRmmError(502, 'No Fries could not reach Datto RMM', 'datto_rmm_unreachable');
        } finally {
            clearTimeout(timer);
        }

        if (response.status === 401 && attempt === 0 && config.renewable) {
            auth.invalidate();
            return requestApi(pathOrUrl, 1);
        }
        if (!response.ok) throw providerHttpError(response.status);
        const text = await response.text();
        if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
            throw new DattoRmmError(502, 'Datto RMM returned more data than the trial bridge accepts', 'datto_rmm_response_too_large');
        }
        try {
            return text ? JSON.parse(text) : {};
        } catch (error) {
            throw new DattoRmmError(502, 'Datto RMM returned an invalid JSON response', 'datto_rmm_response_invalid');
        }
    }

    function assertConfigured() {
        const current = status();
        if (!current.configured) {
            throw new DattoRmmError(503, 'Datto RMM access is not configured', 'datto_rmm_not_configured', {
                state: current.state,
                missing: current.missing
            });
        }
    }

    return { getSiteSnapshot, health, listSites, status };
}

function buildApiUrl(apiBase, pathOrUrl) {
    if (!apiBase) throw new DattoRmmError(503, 'Datto RMM API URL is not configured', 'datto_rmm_not_configured');
    let url;
    try {
        url = new URL(String(pathOrUrl || ''), `${apiBase}/`);
    } catch (error) {
        throw new DattoRmmError(502, 'Datto RMM returned an invalid pagination URL', 'datto_rmm_pagination_invalid');
    }
    const expected = new URL(apiBase);
    if (url.origin !== expected.origin || !url.pathname.startsWith('/api/v2/')) {
        throw new DattoRmmError(502, 'Datto RMM returned an unsafe API URL', 'datto_rmm_url_rejected');
    }
    return url.toString();
}

function extractCollection(payload, keys) {
    if (Array.isArray(payload)) return payload;
    for (const key of [...keys, 'items', 'content']) {
        if (Array.isArray(payload && payload[key])) return payload[key];
    }
    return [];
}

function extractNextPage(payload) {
    return cleanText(
        payload && payload.pageDetails && payload.pageDetails.nextPageUrl ||
        payload && payload.nextPageUrl ||
        payload && payload.links && payload.links.next,
        2000
    );
}

function normaliseSite(value) {
    const source = value && typeof value === 'object' ? value : {};
    return {
        siteUid: cleanText(source.siteUid || source.uid, 180),
        siteId: optionalCount(source.siteId != null ? source.siteId : source.id),
        name: cleanText(source.name || source.siteName, 300),
        description: cleanText(source.description, 500),
        notes: cleanText(source.notes, 1000),
        deviceCount: optionalCount(source.deviceCount != null ? source.deviceCount : source.numberOfDevices)
    };
}

function normaliseDevice(value) {
    const source = value && typeof value === 'object' ? value : {};
    return {
        deviceUid: cleanText(source.deviceUid || source.uid || source.id, 180),
        hostname: cleanText(source.hostname || source.deviceName || source.name, 300),
        deviceType: cleanText(source.deviceType && (source.deviceType.type || source.deviceType) || source.type, 120),
        operatingSystem: cleanText(source.operatingSystem || source.operatingSystemName || source.os, 300),
        lastSeen: normaliseIso(source.lastSeen || source.lastSeenDate || source.lastAuditDate),
        online: source.online === true || String(source.status || '').toLowerCase() === 'online'
    };
}

function normaliseAlert(value) {
    const source = value && typeof value === 'object' ? value : {};
    return {
        alertUid: cleanText(source.alertUid || source.uid || source.id, 180),
        deviceUid: cleanText(source.deviceUid || source.device && (source.device.uid || source.device.deviceUid), 180),
        priority: cleanText(source.priority || source.alertPriority || source.severity, 80),
        type: cleanText(source.alertType || source.type || source.monitorType, 160),
        raisedAt: normaliseIso(source.timestamp || source.raisedAt || source.alertTimestamp)
    };
}

function providerHttpError(status) {
    if (status === 401) return new DattoRmmError(502, 'The Datto RMM access token is invalid or expired', 'datto_rmm_auth_failed');
    if (status === 403) return new DattoRmmError(502, 'The Datto RMM API identity lacks the required permissions', 'datto_rmm_access_denied');
    if (status === 429) return new DattoRmmError(503, 'Datto RMM rate-limited the bridge; wait before retrying', 'datto_rmm_rate_limited', { retryAfterSeconds: 60 });
    return new DattoRmmError(502, 'Datto RMM could not complete the request', 'datto_rmm_provider_error', { providerStatus: Number(status || 0) });
}

function requireUid(value, code) {
    const uid = cleanText(value, 180);
    if (!/^[a-z0-9_-]{4,180}$/i.test(uid)) throw new DattoRmmError(400, 'A valid Datto RMM site UID is required', code);
    return uid;
}

function positiveInteger(value, fallback, minimum, maximum) {
    const number = Number(value);
    return Number.isInteger(number) && number >= minimum && number <= maximum ? number : fallback;
}

function optionalCount(value) {
    const number = Number(value);
    return Number.isInteger(number) && number >= 0 && number <= 1000000 ? number : null;
}

function normaliseIso(value) {
    const timestamp = Date.parse(String(value || ''));
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : '';
}

function cleanText(value, maxLength) {
    return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maxLength);
}

module.exports = {
    DattoRmmError,
    buildApiUrl,
    createDattoRmmClient,
    normaliseApiBase,
    normaliseSite
};
