'use strict';

const DEFAULT_PORT = 3000;

class HostConfigurationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'HostConfigurationError';
        this.code = 'host_configuration_invalid';
    }
}

function resolveStandaloneHostConfig(env = process.env) {
    const config = commonConfig(env, '127.0.0.1', true);
    if (config.requireAuth) {
        if (config.browserAuthMode === 'entra_bff') {
            return config;
        }
        if (config.browserAuthMode === 'swa' && config.trustedAuthProxy) {
            return config;
        }
        throw new HostConfigurationError(
            'Hosted SWA authentication requires an explicitly trusted, header-sanitising proxy; use entra_bff for a direct host.'
        );
    }
    return config;
}

function resolveAppServiceHostConfig(env = process.env) {
    const config = commonConfig(env, '0.0.0.0', false);
    if (String(env.NODE_ENV || '').trim().toLowerCase() !== 'production') {
        throw new HostConfigurationError('The App Service host requires NODE_ENV=production.');
    }
    if (!config.requireAuth || config.browserAuthMode !== 'entra_bff') {
        throw new HostConfigurationError('The App Service host requires fail-closed entra_bff browser authentication.');
    }
    if (config.trustedAuthProxy) {
        throw new HostConfigurationError('The direct App Service host must not trust caller-supplied platform identity headers.');
    }
    if (String(env.NOFRIES_BROWSER_SESSION_STORE || '').trim().toLowerCase() !== 'azure') {
        throw new HostConfigurationError('The App Service host requires the dedicated Azure browser-session store.');
    }
    const authStorageAccount = storageAccountName(env.NOFRIES_BROWSER_AUTH_STORAGE_ACCOUNT);
    const dataStorageAccount = storageAccountName(env.AZURE_STORAGE_ACCOUNT_NAME);
    if (authStorageAccount === dataStorageAccount) {
        throw new HostConfigurationError('Browser sessions and application data require separate storage accounts.');
    }
    validateHttpsOrigin(env.NOFRIES_PUBLIC_URL);
    validateResolvedSecret(env.NOFRIES_ENTRA_CLIENT_SECRET, 'The Entra client secret', 1);
    if (env.NOFRIES_CUSTOMER_ENTRA_CLIENT_ID !== undefined || env.NOFRIES_CUSTOMER_ENTRA_CLIENT_SECRET !== undefined) {
        validateResolvedSecret(env.NOFRIES_CUSTOMER_ENTRA_CLIENT_SECRET, 'The customer Entra client secret', 1);
    }
    validateResolvedSecret(env.NOFRIES_SCOPE_SIGNING_SECRET, 'The scope signing secret', 32);
    validateResolvedSecret(env.NOFRIES_PROSPECT_SIGNING_SECRET, 'The prospect signing secret', 32);
    return config;
}

function startStandaloneHost(app, options = {}) {
    return startHost(app, resolveStandaloneHostConfig(options.env), options);
}

function startAppServiceHost(app, options = {}) {
    return startHost(app, resolveAppServiceHostConfig(options.env), options);
}

function startHost(app, config, options) {
    if (!app || typeof app.listen !== 'function') {
        throw new HostConfigurationError('The HTTP application is unavailable.');
    }
    const logger = options.logger || console;
    return app.listen(config.port, config.bindHost, () => {
        logger.log(`No Fries dynamic host listening on ${config.bindHost}:${config.port}`);
    });
}

function commonConfig(env = process.env, defaultBindHost, allowBindOverride) {
    const requireAuth = booleanSetting(env.NOFRIES_REQUIRE_AUTH, true);
    const trustedAuthProxy = booleanSetting(env.NOFRIES_TRUSTED_AUTH_PROXY, false);
    const browserAuthMode = String(env.NOFRIES_BROWSER_AUTH_MODE || '').trim().toLowerCase();
    if (requireAuth && !['swa', 'entra_bff'].includes(browserAuthMode)) {
        throw new HostConfigurationError('Hosted browser authentication mode must be explicitly configured.');
    }
    return Object.freeze({
        port: portNumber(env.PORT),
        bindHost: bindHost(allowBindOverride ? env.NOFRIES_BIND_HOST || defaultBindHost : defaultBindHost),
        requireAuth,
        trustedAuthProxy,
        browserAuthMode: browserAuthMode || 'swa'
    });
}

function booleanSetting(value, defaultValue) {
    const setting = String(value == null ? '' : value).trim().toLowerCase();
    if (!setting) return defaultValue;
    if (setting === 'true') return true;
    if (setting === 'false') return false;
    throw new HostConfigurationError('Boolean host settings must use true or false.');
}

function portNumber(value) {
    const candidate = value == null || value === '' ? DEFAULT_PORT : Number(value);
    if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > 65535) {
        throw new HostConfigurationError('PORT must be an integer from 1 to 65535.');
    }
    return candidate;
}

function bindHost(value) {
    const candidate = String(value || '').trim();
    if (!candidate || candidate.length > 253 || /[\s/\\]/.test(candidate)) {
        throw new HostConfigurationError('The bind host is invalid.');
    }
    return candidate;
}

function storageAccountName(value) {
    const candidate = String(value || '').trim().toLowerCase();
    if (!/^[a-z0-9]{3,24}$/.test(candidate)) {
        throw new HostConfigurationError('Hosted storage account names must be explicitly configured.');
    }
    return candidate;
}

function validateHttpsOrigin(value) {
    let candidate;
    try {
        candidate = new URL(String(value || ''));
    } catch {
        throw new HostConfigurationError('NOFRIES_PUBLIC_URL must be an HTTPS origin.');
    }
    if (
        candidate.protocol !== 'https:' || candidate.username || candidate.password ||
        candidate.pathname !== '/' || candidate.search || candidate.hash
    ) {
        throw new HostConfigurationError('NOFRIES_PUBLIC_URL must be an HTTPS origin.');
    }
}

function validateResolvedSecret(value, label, minimumLength) {
    const candidate = String(value == null ? '' : value);
    const trimmed = candidate.trim();
    if (
        trimmed.length < minimumLength || candidate.length > 4096 ||
        /[\u0000-\u001f\u007f]/.test(candidate) ||
        /^@Microsoft\.KeyVault\s*\(/i.test(trimmed)
    ) {
        throw new HostConfigurationError(`${label} must be present and resolved before the App Service host starts.`);
    }
}

module.exports = {
    HostConfigurationError,
    resolveAppServiceHostConfig,
    resolveStandaloneHostConfig,
    startAppServiceHost,
    startStandaloneHost
};
