const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_TOKEN_TTL_SECONDS = 100 * 60 * 60;
const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;
const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;

class DattoRmmAuthError extends Error {
    constructor(statusCode, message, code, details = {}) {
        super(message);
        this.statusCode = statusCode;
        this.details = Object.assign({ code }, details);
    }
}

function createDattoRmmAuthProvider(options = {}) {
    const env = options.env || process.env;
    const fetchImpl = options.fetch || globalThis.fetch;
    const now = options.now || (() => new Date());
    const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 1000, 30000);
    const config = resolveDattoRmmConfig(env);
    let cachedToken = { value: '', expiresAt: 0 };
    let tokenExchangePromise = null;

    function status() {
        const missing = [];
        if (!config.apiBase) missing.push('NOFRIES_DATTO_RMM_API_URL');
        if (config.mode === 'controlled_write') {
            if (!config.apiKey) missing.push('NOFRIES_DATTO_RMM_API_KEY');
            if (!config.apiSecret) missing.push('NOFRIES_DATTO_RMM_API_SECRET');
            if (!config.installerBase) missing.push('NOFRIES_DATTO_RMM_INSTALLER_BASE_URL');
        } else if (config.mode === 'readonly' && !config.accessToken && !(config.apiKey && config.apiSecret)) {
            missing.push('NOFRIES_DATTO_RMM_ACCESS_TOKEN or NOFRIES_DATTO_RMM_API_KEY/API_SECRET');
        }
        const configured = config.mode !== 'disabled' && !config.configurationError && missing.length === 0;
        return {
            provider: 'datto_rmm',
            mode: config.mode,
            readOnly: config.mode !== 'controlled_write',
            configured,
            state: config.configurationError
                ? 'invalid_configuration'
                : config.mode === 'disabled' ? 'disabled' : missing.length ? 'awaiting_credentials' : 'ready',
            apiHost: config.apiBase ? new URL(config.apiBase).host : '',
            installerHost: config.installerBase ? new URL(config.installerBase).host : '',
            authentication: config.apiKey && config.apiSecret
                ? 'api_identity'
                : config.accessToken ? 'static_access_token' : 'unavailable',
            missing,
            configurationError: config.configurationError,
            writeOperationsEnabled: config.mode === 'controlled_write' && configured
        };
    }

    async function getAccessToken(input = {}) {
        assertConfigured();
        if (config.accessToken && config.mode === 'readonly' && !(config.apiKey && config.apiSecret)) {
            return config.accessToken;
        }
        const force = input.force === true;
        const currentTime = nowMilliseconds(now);
        if (tokenExchangePromise) {
            return tokenExchangePromise;
        }
        if (!force && cachedToken.value && cachedToken.expiresAt > currentTime + TOKEN_REFRESH_SKEW_MS) {
            return cachedToken.value;
        }
        const exchange = exchangeAccessToken(currentTime);
        tokenExchangePromise = exchange;
        try {
            return await exchange;
        } finally {
            if (tokenExchangePromise === exchange) {
                tokenExchangePromise = null;
            }
        }
    }

    async function exchangeAccessToken(currentTime) {
        if (typeof fetchImpl !== 'function') {
            throw new DattoRmmAuthError(503, 'The Datto RMM authentication client is unavailable', 'datto_rmm_http_unavailable');
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let response;
        try {
            response = await fetchImpl(`${config.apiBase}/auth/oauth/token`, {
                method: 'POST',
                headers: {
                    Accept: 'application/json',
                    Authorization: `Basic ${Buffer.from('public-client:public', 'utf8').toString('base64')}`,
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'User-Agent': 'NoFries-DattoRMM-Auth/1.0'
                },
                body: new URLSearchParams({
                    grant_type: 'password',
                    username: config.apiKey,
                    password: config.apiSecret
                }).toString(),
                redirect: 'error',
                signal: controller.signal
            });
        } catch (error) {
            if (error && error.name === 'AbortError') {
                throw new DattoRmmAuthError(504, 'Datto RMM authentication timed out', 'datto_rmm_auth_timeout');
            }
            throw new DattoRmmAuthError(502, 'No Fries could not reach Datto RMM authentication', 'datto_rmm_auth_unreachable');
        } finally {
            clearTimeout(timer);
        }
        if (!response.ok) {
            const code = response.status === 401 || response.status === 400
                ? 'datto_rmm_auth_failed'
                : response.status === 429 ? 'datto_rmm_rate_limited' : 'datto_rmm_auth_provider_error';
            throw new DattoRmmAuthError(
                response.status === 429 ? 503 : 502,
                response.status === 429
                    ? 'Datto RMM rate-limited authentication; wait before retrying'
                    : 'The dedicated Datto RMM API identity could not authenticate',
                code,
                response.status === 429 ? { retryAfterSeconds: retryAfterSeconds(response) } : {}
            );
        }
        const text = await boundedResponseText(response, MAX_TOKEN_RESPONSE_BYTES, 'datto_rmm_auth_response_too_large');
        let payload;
        try {
            payload = text ? JSON.parse(text) : {};
        } catch (error) {
            throw new DattoRmmAuthError(502, 'Datto RMM returned an invalid authentication response', 'datto_rmm_auth_response_invalid');
        }
        const accessToken = safeToken(payload && payload.access_token);
        if (!accessToken) {
            throw new DattoRmmAuthError(502, 'Datto RMM did not return an access token', 'datto_rmm_auth_token_missing');
        }
        const expiresIn = positiveInteger(payload && payload.expires_in, DEFAULT_TOKEN_TTL_SECONDS, 60, DEFAULT_TOKEN_TTL_SECONDS);
        cachedToken = {
            value: accessToken,
            expiresAt: currentTime + (expiresIn * 1000)
        };
        return accessToken;
    }

    function invalidate() {
        cachedToken = { value: '', expiresAt: 0 };
    }

    function assertConfigured() {
        const current = status();
        if (!current.configured) {
            throw new DattoRmmAuthError(503, 'Datto RMM access is not configured', 'datto_rmm_not_configured', {
                state: current.state,
                missing: current.missing
            });
        }
    }

    function connection() {
        return {
            apiBase: config.apiBase,
            installerBase: config.installerBase,
            mode: config.mode,
            renewable: Boolean(config.apiKey && config.apiSecret)
        };
    }

    return { connection, getAccessToken, invalidate, status };
}

function resolveDattoRmmConfig(env = {}) {
    const requestedMode = String(env.NOFRIES_DATTO_RMM_MODE || 'disabled').trim().toLowerCase();
    const supportedModes = ['disabled', 'readonly', 'controlled_write'];
    const mode = supportedModes.includes(requestedMode) ? requestedMode : 'disabled';
    let configurationError = supportedModes.includes(requestedMode)
        ? ''
        : 'NOFRIES_DATTO_RMM_MODE must be disabled, readonly or controlled_write';
    let apiBase = '';
    let installerBase = '';
    const configuredUrl = String(env.NOFRIES_DATTO_RMM_API_URL || '').trim();
    if (configuredUrl) {
        try {
            apiBase = normaliseApiBase(configuredUrl, env.NOFRIES_DATTO_RMM_ALLOWED_HOSTS);
        } catch (error) {
            configurationError = error.message;
        }
    }
    const configuredInstaller = String(env.NOFRIES_DATTO_RMM_INSTALLER_BASE_URL || '').trim();
    if (configuredInstaller) {
        try {
            installerBase = normaliseInstallerBase(configuredInstaller, env.NOFRIES_DATTO_RMM_ALLOWED_HOSTS);
        } catch (error) {
            configurationError = error.message;
        }
    } else if (apiBase) {
        installerBase = deriveInstallerBase(apiBase);
    }
    return {
        mode,
        apiBase,
        installerBase,
        accessToken: safeToken(env.NOFRIES_DATTO_RMM_ACCESS_TOKEN),
        apiKey: safeCredential(env.NOFRIES_DATTO_RMM_API_KEY),
        apiSecret: safeCredential(env.NOFRIES_DATTO_RMM_API_SECRET),
        configurationError
    };
}

function normaliseApiBase(value, additionalHosts) {
    return normaliseOrigin(value, additionalHosts, (host) => host.endsWith('-api.centrastage.net'), 'NOFRIES_DATTO_RMM_API_URL', 'Datto RMM API');
}

function normaliseInstallerBase(value, additionalHosts) {
    return normaliseOrigin(value, additionalHosts, (host) => host.endsWith('.rmm.datto.com'), 'NOFRIES_DATTO_RMM_INSTALLER_BASE_URL', 'Datto RMM installer');
}

function normaliseOrigin(value, additionalHosts, defaultHostCheck, variableName, label) {
    let url;
    try {
        url = new URL(value);
    } catch (error) {
        throw new Error(`${variableName} must be a valid HTTPS URL`);
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
        throw new Error(`${variableName} must be a credential-free HTTPS origin`);
    }
    if (url.pathname !== '/' && url.pathname !== '') {
        throw new Error(`${variableName} must not include a path`);
    }
    const host = url.hostname.toLowerCase();
    const explicitHosts = String(additionalHosts || '')
        .split(/[,;\n]/)
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean);
    if (!defaultHostCheck(host) && !explicitHosts.includes(host)) {
        throw new Error(`${variableName} must use a ${label} host`);
    }
    return url.origin;
}

function deriveInstallerBase(apiBase) {
    const host = apiBase ? new URL(apiBase).hostname.toLowerCase() : '';
    const match = host.match(/^([a-z0-9-]+)-api\.centrastage\.net$/);
    return match ? `https://${match[1]}.rmm.datto.com` : '';
}

async function boundedResponseText(response, limit, code) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > limit) {
        throw new DattoRmmAuthError(502, 'Datto RMM returned more authentication data than No Fries accepts', code);
    }
    return text;
}

function retryAfterSeconds(response) {
    const value = Number(response && response.headers && typeof response.headers.get === 'function' && response.headers.get('retry-after'));
    return Number.isFinite(value) && value >= 1 && value <= 3600 ? Math.ceil(value) : 60;
}

function nowMilliseconds(now) {
    const value = now();
    const timestamp = value instanceof Date ? value.getTime() : Date.parse(String(value || ''));
    return Number.isFinite(timestamp) ? timestamp : Date.now();
}

function positiveInteger(value, fallback, minimum, maximum) {
    const number = Number(value);
    return Number.isInteger(number) && number >= minimum && number <= maximum ? number : fallback;
}

function safeToken(value) {
    const token = String(value == null ? '' : value).trim();
    return token && token.length <= 8192 && !/[\u0000-\u001f\u007f]/.test(token) ? token : '';
}

function safeCredential(value) {
    const credential = String(value == null ? '' : value).trim();
    return credential && credential.length <= 2048 && !/[\u0000-\u001f\u007f]/.test(credential) ? credential : '';
}

module.exports = {
    DattoRmmAuthError,
    createDattoRmmAuthProvider,
    deriveInstallerBase,
    normaliseApiBase,
    normaliseInstallerBase,
    resolveDattoRmmConfig
};
