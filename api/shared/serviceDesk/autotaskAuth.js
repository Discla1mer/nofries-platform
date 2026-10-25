const DEFAULT_TIMEOUT_MS = 10000;
const MAX_ZONE_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_ZONE_URL = 'https://webservices.autotask.net/atservicesrest/v1.0/zoneInformation';
const { readBoundedResponseText } = require('./boundedHttpBody');

class AutotaskAuthError extends Error {
    constructor(statusCode, message, code, details = {}) {
        super(message);
        this.statusCode = statusCode;
        this.details = Object.assign({ code }, details);
    }
}

function createAutotaskAuthProvider(options = {}) {
    const env = options.env || process.env;
    const fetchImpl = options.fetch || globalThis.fetch;
    const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 1000, 30000);
    const config = resolveAutotaskConfig(env);
    let cachedApiBase = config.apiBase;
    let discoveryPromise = null;

    function status() {
        const missing = [];
        if (!config.username) missing.push('NOFRIES_AUTOTASK_USERNAME');
        if (!config.secret) missing.push('NOFRIES_AUTOTASK_SECRET');
        if (!config.integrationCode) missing.push('NOFRIES_AUTOTASK_INTEGRATION_CODE');
        const configured = config.mode !== 'disabled' && !config.configurationError && missing.length === 0;
        return {
            provider: 'autotask',
            mode: config.mode,
            configured,
            readOnly: config.mode !== 'controlled_write',
            writeOperationsEnabled: config.mode === 'controlled_write' && config.writeEnabled === true && configured,
            state: config.configurationError
                ? 'invalid_configuration'
                : config.mode === 'disabled' ? 'disabled' : missing.length ? 'awaiting_credentials' : 'ready',
            apiHost: cachedApiBase ? new URL(cachedApiBase).host : '',
            zoneDiscoveryRequired: !config.apiBase,
            missing,
            configurationError: config.configurationError
        };
    }

    async function getApiBase() {
        assertConfigured();
        if (cachedApiBase) return cachedApiBase;
        if (discoveryPromise) return discoveryPromise;
        discoveryPromise = discoverZone();
        try {
            cachedApiBase = await discoveryPromise;
            return cachedApiBase;
        } finally {
            discoveryPromise = null;
        }
    }

    async function discoverZone() {
        if (typeof fetchImpl !== 'function') {
            throw new AutotaskAuthError(503, 'The Autotask authentication client is unavailable', 'autotask_http_unavailable');
        }
        const url = new URL(DEFAULT_ZONE_URL);
        url.searchParams.set('user', config.username);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetchImpl(url.toString(), {
                method: 'GET',
                headers: Object.assign({ Accept: 'application/json' }, requestHeaders()),
                redirect: 'error',
                signal: controller.signal
            });
            const text = await boundedText(response, MAX_ZONE_RESPONSE_BYTES, 'autotask_zone_response_too_large');
            if (!response.ok) {
                throw providerAuthError(response.status, 'zone_discovery');
            }
            let payload;
            try {
                payload = text ? JSON.parse(text) : {};
            } catch (error) {
                throw new AutotaskAuthError(502, 'Autotask returned an invalid zone response', 'autotask_zone_response_invalid');
            }
            const candidate = payload && (payload.url || payload.webUrl || payload.apiUrl);
            try {
                return normaliseAutotaskApiBase(candidate, config.allowedHosts);
            } catch (error) {
                throw new AutotaskAuthError(502, 'Autotask returned an unsafe zone URL', 'autotask_zone_url_rejected');
            }
        } catch (error) {
            if (error && error.details && /^autotask_/.test(String(error.details.code || ''))) throw error;
            if (error && error.name === 'AbortError') {
                throw new AutotaskAuthError(504, 'Autotask zone discovery timed out', 'autotask_zone_timeout');
            }
            throw new AutotaskAuthError(502, 'No Fries could not reach Autotask zone discovery', 'autotask_zone_unreachable');
        } finally {
            clearTimeout(timer);
        }
    }

    function requestHeaders() {
        assertConfigured();
        return {
            ApiIntegrationCode: config.integrationCode,
            UserName: config.username,
            Secret: config.secret
        };
    }

    function assertConfigured() {
        const current = status();
        if (!current.configured) {
            throw new AutotaskAuthError(503, 'Autotask access is not configured', 'autotask_not_configured', {
                state: current.state,
                missing: current.missing
            });
        }
    }

    return {
        getApiBase,
        requestHeaders,
        status
    };
}

function resolveAutotaskConfig(env = {}) {
    const requestedMode = String(env.NOFRIES_AUTOTASK_MODE || 'disabled').trim().toLowerCase();
    const modes = ['disabled', 'readonly', 'controlled_write'];
    const mode = modes.includes(requestedMode) ? requestedMode : 'disabled';
    let configurationError = modes.includes(requestedMode)
        ? ''
        : 'NOFRIES_AUTOTASK_MODE must be disabled, readonly or controlled_write';
    const configuredAllowedHosts = String(env.NOFRIES_AUTOTASK_ALLOWED_HOSTS || '')
        .split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
    const customHostsPermitted = mode !== 'controlled_write' && !env.WEBSITE_HOSTNAME && String(env.NODE_ENV || '').toLowerCase() !== 'production';
    const allowedHosts = customHostsPermitted ? configuredAllowedHosts : [];
    let apiBase = '';
    if (String(env.NOFRIES_AUTOTASK_API_URL || '').trim()) {
        try {
            apiBase = normaliseAutotaskApiBase(env.NOFRIES_AUTOTASK_API_URL, allowedHosts);
        } catch (error) {
            configurationError = error.message;
        }
    }
    return {
        mode,
        apiBase,
        allowedHosts,
        username: safeCredential(env.NOFRIES_AUTOTASK_USERNAME, 320),
        secret: safeCredential(env.NOFRIES_AUTOTASK_SECRET, 1000),
        integrationCode: safeCredential(env.NOFRIES_AUTOTASK_INTEGRATION_CODE, 320),
        writeEnabled: String(env.NOFRIES_AUTOTASK_WRITE_ENABLED || 'false').trim().toLowerCase() === 'true',
        configurationError
    };
}

function normaliseAutotaskApiBase(value, additionalHosts = []) {
    let url;
    try {
        url = new URL(String(value || '').trim());
    } catch (error) {
        throw new Error('NOFRIES_AUTOTASK_API_URL must be a valid HTTPS URL');
    }
    const host = url.hostname.toLowerCase();
    const hostAllowed = host.endsWith('.autotask.net') || additionalHosts.includes(host);
    if (
        url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
        (url.port && url.port !== '443') ||
        !hostAllowed
    ) {
        throw new Error('NOFRIES_AUTOTASK_API_URL must use an approved Autotask HTTPS host');
    }
    let pathname = url.pathname.replace(/\/+$/, '');
    const versionMatch = pathname.match(/^(.*\/atservicesrest\/v1\.0)(?:\/.*)?$/i);
    if (!versionMatch) pathname = `${pathname}/atservicesrest/v1.0`;
    else pathname = versionMatch[1];
    url.pathname = pathname;
    return url.toString().replace(/\/$/, '');
}

function providerAuthError(status, operation) {
    if (status === 401 || status === 400) {
        return new AutotaskAuthError(502, 'The Autotask API identity could not authenticate', 'autotask_auth_failed');
    }
    if (status === 403) {
        return new AutotaskAuthError(502, 'The Autotask API identity lacks the required permissions', 'autotask_access_denied');
    }
    if (status === 429) {
        return new AutotaskAuthError(503, 'Autotask rate-limited authentication; wait before retrying', 'autotask_rate_limited');
    }
    return new AutotaskAuthError(502, 'Autotask authentication is unavailable', 'autotask_auth_provider_error', {
        providerStatus: Number(status || 0),
        operation
    });
}

async function boundedText(response, maximum, code) {
    return readBoundedResponseText(response, maximum, () => (
        new AutotaskAuthError(502, 'Autotask returned more data than No Fries accepts', code)
    ));
}

function safeCredential(value, maximum) {
    const text = String(value || '').trim();
    return text && text.length <= maximum && !/[\r\n\u0000]/.test(text) ? text : '';
}

function positiveInteger(value, fallback, minimum, maximum) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

module.exports = {
    AutotaskAuthError,
    createAutotaskAuthProvider,
    normaliseAutotaskApiBase,
    resolveAutotaskConfig
};
