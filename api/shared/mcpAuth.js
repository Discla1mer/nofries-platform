const crypto = require('crypto');
const { browserAuthMode, getRequestIdentity } = require('./identity');
const { assertCapability, resolveTenantAccess } = require('./tenantAccess');

const CACHE_TTL_MS = 5 * 60 * 1000;
const OAUTH_REFRESH_COOLDOWN_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 10 * 1000;
const MAX_BEARER_TOKEN_BYTES = 32 * 1024;
const MAX_METADATA_BYTES = 1024 * 1024;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DELEGATED_PERMISSION = 'nofries.lifecycle.read';
const APPLICATION_PERMISSION = 'nofries.lifecycle.read.application';
const TOKEN_SCOPE_SETTING = 'NOFRIES_MCP_TOKEN_SCOPE';
const discoveryCache = new Map();
const discoveryRefreshAttemptedAt = new Map();
const discoveryRequests = new Map();
const jwksCache = new Map();
const jwksRefreshAttemptedAt = new Map();
const jwksRequests = new Map();

class McpAuthError extends Error {
    constructor(message, code = 'authentication_required', details = {}) {
        super(message);
        this.statusCode = 401;
        this.details = Object.assign({ code }, details);
    }
}

class McpAccessError extends Error {
    constructor(message, code = 'tenant_access_required', details = {}) {
        super(message);
        this.statusCode = 403;
        this.details = Object.assign({ code }, details);
    }
}

async function resolveMcpAccess(req, options = {}) {
    const env = options.env || process.env;
    const developmentIdentityRequested =
        env.NODE_ENV === 'development' &&
        env.NOFRIES_REQUIRE_AUTH === 'false' &&
        env.NOFRIES_MCP_ALLOW_DEVELOPMENT_IDENTITY === 'true';
    const allowDevelopmentIdentity = developmentIdentityRequested
        ? browserAuthMode(env) === 'swa'
        : false;
    const browserIdentity = allowDevelopmentIdentity
        ? getRequestIdentity(req, env)
        : null;
    if (allowDevelopmentIdentity) {
        const access = resolveTenantAccess(browserIdentity, env);
        if (!access.allowed) {
            throw new McpAccessError('This identity is not approved for No Fries', 'tenant_access_required', {
                reason: access.reason
            });
        }
        return access;
    }

    const token = bearerToken(req);
    if (!token) throw new McpAuthError('Authentication is required to read No Fries lifecycle data');
    const claims = await verifyBearerToken(token, {
        env,
        fetchImpl: options.fetchImpl || global.fetch,
        now: options.now || (() => Date.now())
    });
    const identity = mcpIdentityFromClaims(claims);
    const access = resolveTenantAccess(identity, env);
    if (!access.allowed) {
        throw new McpAccessError('This identity is not approved for No Fries', 'tenant_access_required', {
            reason: access.reason
        });
    }
    return access;
}

function mcpIdentityFromClaims(claimsValue) {
    const claims = claimsValue && typeof claimsValue === 'object' && !Array.isArray(claimsValue)
        ? claimsValue
        : {};
    const delegatedScopeSupplied = Object.prototype.hasOwnProperty.call(claims, 'scp');
    const delegatedScopes = String(claims.scp || '').trim();
    const applicationRolesSupplied = Object.prototype.hasOwnProperty.call(claims, 'roles');
    const applicationRoles = Array.isArray(claims.roles) ? claims.roles : [];

    if (applicationRolesSupplied && !Array.isArray(claims.roles)) {
        throw new McpAuthError('The application access token identity is invalid', 'invalid_token');
    }
    if (applicationRolesSupplied && delegatedScopeSupplied && !delegatedScopes) {
        throw new McpAuthError('The application access token identity is invalid', 'invalid_token');
    }

    if (applicationRolesSupplied && !delegatedScopeSupplied) {
        if (applicationRoles.length !== 1 || applicationRoles[0] !== APPLICATION_PERMISSION) {
            throw new McpAuthError('The application access token identity is invalid', 'invalid_token');
        }
        const tenantId = canonicalGuid(claims.tid);
        const principalId = canonicalGuid(claims.oid);
        const azpSupplied = claims.azp !== undefined;
        const appidSupplied = claims.appid !== undefined;
        const azp = optionalCanonicalGuid(claims.azp);
        const appid = optionalCanonicalGuid(claims.appid);
        if (
            !tenantId ||
            !principalId ||
            (azpSupplied && !azp) ||
            (appidSupplied && !appid) ||
            (!azp && !appid) ||
            (azp && appid && azp !== appid)
        ) {
            throw new McpAuthError('The application access token identity is invalid', 'invalid_token');
        }
        const clientId = azp || appid;
        return {
            email: '',
            name: '',
            provider: 'mcp-oauth-application',
            principalId,
            tenantId,
            clientId,
            subjectKey: `${tenantId}:${principalId}:${clientId}`,
            isAuthenticated: true
        };
    }

    return {
        email: claims.email || claims.preferred_username || claims.upn || '',
        name: claims.name || '',
        provider: 'mcp-oauth',
        principalId: claims.oid || claims.sub || null,
        tenantId: claims.tid || '',
        isAuthenticated: true
    };
}

function canonicalGuid(value) {
    if (typeof value !== 'string') return '';
    const result = value.trim().toLowerCase();
    return GUID.test(result) ? result : '';
}

function optionalCanonicalGuid(value) {
    if (value === undefined || value === null || String(value).trim() === '') return '';
    return canonicalGuid(value);
}

function requiredMcpPermission(env) {
    if (
        Object.prototype.hasOwnProperty.call(env, TOKEN_SCOPE_SETTING) &&
        env[TOKEN_SCOPE_SETTING] !== DELEGATED_PERMISSION
    ) {
        throw new McpAuthError(
            'The No Fries MCP OAuth resource server is not configured',
            'mcp_auth_not_configured'
        );
    }
    return DELEGATED_PERMISSION;
}

async function verifyBearerToken(token, options) {
    const env = options.env;
    const issuer = normaliseIssuer(env.NOFRIES_MCP_ISSUER || env.NOFRIES_MCP_AUTHORIZATION_SERVER);
    const audience = String(env.NOFRIES_MCP_AUDIENCE || '').trim();
    const requiredScope = requiredMcpPermission(env);
    if (!issuer || !audience) {
        throw new McpAuthError('The No Fries MCP OAuth resource server is not configured', 'mcp_auth_not_configured');
    }
    const tokenText = String(token || '');
    if (Buffer.byteLength(tokenText, 'utf8') > MAX_BEARER_TOKEN_BYTES) {
        throw new McpAuthError('The access token is invalid', 'invalid_token');
    }
    const parts = tokenText.split('.');
    if (parts.length !== 3) throw new McpAuthError('The access token is invalid', 'invalid_token');
    const header = parseJwtPart(parts[0]);
    const claims = parseJwtPart(parts[1]);
    if (!isJsonObject(header) || !isJsonObject(claims)) {
        throw new McpAuthError('The access token is invalid', 'invalid_token');
    }
    if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid.length) {
        throw new McpAuthError('The access token signing algorithm is not supported', 'invalid_token');
    }

    const jwksUri = String(env.NOFRIES_MCP_JWKS_URI || '').trim() || await discoverJwksUri(
        issuer,
        options.fetchImpl,
        options.now,
        env
    );
    assertTrustedHttpsUrl(jwksUri, issuer, env);
    let keys = await loadJwks(jwksUri, options.fetchImpl, options.now);
    let jwk = keys.find((key) => key && key.kid === header.kid && key.kty === 'RSA');
    if (!jwk) {
        keys = await loadJwks(jwksUri, options.fetchImpl, options.now, true);
        jwk = keys.find((key) => key && key.kid === header.kid && key.kty === 'RSA');
    }
    if (!jwk) throw new McpAuthError('The access token signing key is not recognised', 'invalid_token');

    let publicKey;
    try {
        publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    } catch (error) {
        throw new McpAuthError('The access token signing key is invalid', 'invalid_token');
    }
    const signed = Buffer.from(`${parts[0]}.${parts[1]}`, 'utf8');
    const signature = base64UrlBuffer(parts[2]);
    if (!crypto.verify('RSA-SHA256', signed, publicKey, signature)) {
        throw new McpAuthError('The access token signature is invalid', 'invalid_token');
    }

    const nowSeconds = Math.floor(options.now() / 1000);
    if (String(claims.iss || '').replace(/\/$/, '') !== issuer) {
        throw new McpAuthError('The access token issuer is invalid', 'invalid_token');
    }
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(audience)) {
        throw new McpAuthError('The access token audience is invalid', 'invalid_token');
    }
    if (!Number.isFinite(Number(claims.exp)) || Number(claims.exp) < nowSeconds - 60) {
        throw new McpAuthError('The access token has expired', 'invalid_token');
    }
    if (claims.nbf != null && Number(claims.nbf) > nowSeconds + 60) {
        throw new McpAuthError('The access token is not active yet', 'invalid_token');
    }
    const delegatedScopeClaimPresent = Object.prototype.hasOwnProperty.call(claims, 'scp');
    const requiredPermission = delegatedScopeClaimPresent ? requiredScope : APPLICATION_PERMISSION;
    const delegatedScopes = typeof claims.scp === 'string'
        ? claims.scp.trim().split(/\s+/).filter(Boolean)
        : [];
    const rawApplicationRoles = claims.roles;
    const applicationRoles = Array.isArray(rawApplicationRoles)
        ? rawApplicationRoles.filter((role) => typeof role === 'string' && role)
        : [];
    if (!delegatedScopeClaimPresent && Array.isArray(rawApplicationRoles) &&
        rawApplicationRoles.some((role) =>
            typeof role === 'string' && role.trim() === requiredPermission) &&
        (rawApplicationRoles.length !== 1 || rawApplicationRoles[0] !== requiredPermission)) {
        throw new McpAuthError('The application access token identity is invalid', 'invalid_token');
    }
    const grantedPermissions = new Set(
        delegatedScopeClaimPresent ? delegatedScopes : applicationRoles
    );
    if (!grantedPermissions.has(requiredPermission)) {
        throw new McpAuthError('The access token does not include the required lifecycle scope', 'insufficient_scope', {
            requiredScope: requiredPermission
        });
    }
    return claims;
}

async function discoverJwksUri(issuer, fetchImpl, now, env) {
    if (typeof fetchImpl !== 'function') {
        throw new McpAuthError('OAuth discovery is unavailable', 'mcp_auth_unavailable');
    }
    const url = `${issuer}/.well-known/openid-configuration`;
    const currentTime = now();
    const cached = freshCacheEntry(discoveryCache, url, currentTime);
    if (cached) return cached;
    if (discoveryRequests.has(url)) return discoveryRequests.get(url);
    const lastAttempt = discoveryRefreshAttemptedAt.get(url);
    if (lastAttempt != null && currentTime - lastAttempt < OAUTH_REFRESH_COOLDOWN_MS) {
        throw new McpAuthError('OAuth discovery is unavailable', 'mcp_auth_unavailable');
    }

    discoveryRefreshAttemptedAt.set(url, currentTime);
    const request = (async () => {
        const metadata = await fetchJson(url, fetchImpl);
        const jwksUri = String((metadata && metadata.jwks_uri) || '').trim();
        if (!jwksUri) {
            throw new McpAuthError('OAuth discovery did not publish signing keys', 'mcp_auth_invalid_discovery');
        }
        assertTrustedHttpsUrl(jwksUri, issuer, env);
        discoveryCache.set(url, { value: jwksUri, expiresAt: now() + CACHE_TTL_MS });
        return jwksUri;
    })();
    discoveryRequests.set(url, request);
    try {
        return await request;
    } finally {
        if (discoveryRequests.get(url) === request) discoveryRequests.delete(url);
    }
}

async function loadJwks(url, fetchImpl, now, forceRefresh = false) {
    if (typeof fetchImpl !== 'function') {
        throw new McpAuthError('OAuth signing keys are unavailable', 'mcp_auth_unavailable');
    }
    const currentTime = now();
    const cached = freshCacheEntry(jwksCache, url, currentTime);
    if (cached && !forceRefresh) return cached;
    if (jwksRequests.has(url)) return jwksRequests.get(url);
    const lastAttempt = jwksRefreshAttemptedAt.get(url);
    if (lastAttempt != null && currentTime - lastAttempt < OAUTH_REFRESH_COOLDOWN_MS) {
        if (cached) return cached;
        throw new McpAuthError('OAuth signing keys are unavailable', 'mcp_auth_unavailable');
    }

    jwksRefreshAttemptedAt.set(url, currentTime);
    const request = (async () => {
        const body = await fetchJson(url, fetchImpl);
        const keys = body && Array.isArray(body.keys)
            ? body.keys.filter(isUsableRsaVerificationKey)
            : [];
        if (!keys.length) throw new McpAuthError('OAuth signing keys are unavailable', 'mcp_auth_invalid_jwks');
        const fetchedAt = now();
        jwksCache.set(url, { value: keys, expiresAt: fetchedAt + CACHE_TTL_MS });
        return keys;
    })();
    jwksRequests.set(url, request);
    try {
        return await request;
    } finally {
        if (jwksRequests.get(url) === request) jwksRequests.delete(url);
    }
}

function isUsableRsaVerificationKey(key) {
    if (!key || key.kty !== 'RSA' || typeof key.kid !== 'string' || !key.kid.length) return false;
    if (key.use != null && key.use !== 'sig') return false;
    if (key.alg != null && key.alg !== 'RS256') return false;
    if (key.key_ops != null && (!Array.isArray(key.key_ops) || !key.key_ops.includes('verify'))) return false;
    const modulus = rsaPublicInteger(key.n);
    const exponent = rsaPublicInteger(key.e);
    if (!modulus || !exponent) return false;
    const modulusBits = (modulus.length - 1) * 8 + 32 - Math.clz32(modulus[0]);
    // RFC 7518 section 3.3 requires at least 2048 bits for RS256. Node's JWK
    // importer alone also accepts empty or tiny integers, so import success
    // must not let unusable provider data replace valid cached signing keys.
    if (modulusBits < 2048 || !(modulus[modulus.length - 1] & 1)) return false;
    if (!(exponent[exponent.length - 1] & 1) || (exponent.length === 1 && exponent[0] < 3)) return false;
    if (exponent.length > modulus.length ||
        (exponent.length === modulus.length && Buffer.compare(exponent, modulus) >= 0)) return false;
    try {
        const publicKey = crypto.createPublicKey({ key, format: 'jwk' });
        return publicKey.asymmetricKeyType === 'rsa' &&
            publicKey.asymmetricKeyDetails.modulusLength === modulusBits;
    } catch (error) {
        return false;
    }
}

function rsaPublicInteger(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
    const bytes = Buffer.from(value, 'base64url');
    // RFC 7518 Base64urlUInt uses the shortest unsigned big-endian encoding.
    // A positive RSA parameter cannot start with a zero octet.
    if (!bytes.length || bytes[0] === 0 || bytes.toString('base64url') !== value) return null;
    return bytes;
}

async function fetchJson(url, fetchImpl) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let response;
    try {
        response = await fetchImpl(url, {
            headers: { Accept: 'application/json' },
            redirect: 'error',
            signal: controller.signal
        });
    } catch (error) {
        clearTimeout(timer);
        throw new McpAuthError('OAuth metadata could not be reached', 'mcp_auth_unavailable');
    }
    if (!response || !response.ok) {
        clearTimeout(timer);
        throw new McpAuthError('OAuth metadata could not be loaded', 'mcp_auth_unavailable');
    }
    try {
        if (typeof response.text === 'function') {
            const text = await response.text();
            if (Buffer.byteLength(text, 'utf8') > MAX_METADATA_BYTES) {
                throw new McpAuthError('OAuth metadata was too large', 'mcp_auth_invalid_discovery');
            }
            return JSON.parse(text);
        }
        const body = await response.json();
        if (Buffer.byteLength(JSON.stringify(body), 'utf8') > MAX_METADATA_BYTES) {
            throw new McpAuthError('OAuth metadata was too large', 'mcp_auth_invalid_discovery');
        }
        return body;
    } catch (error) {
        if (error instanceof McpAuthError) throw error;
        throw new McpAuthError('OAuth metadata was not valid JSON', 'mcp_auth_invalid_discovery');
    } finally {
        clearTimeout(timer);
    }
}

function assertTrustedHttpsUrl(value, issuer, env) {
    let target;
    let issuerUrl;
    try {
        target = new URL(value);
        issuerUrl = new URL(issuer);
    } catch (error) {
        throw new McpAuthError('OAuth metadata URL is invalid', 'mcp_auth_invalid_discovery');
    }
    const allowedHosts = new Set([
        issuerUrl.hostname,
        ...String(env.NOFRIES_MCP_AUTH_HOSTS || '').split(/[\s,;]+/).filter(Boolean)
    ].map((host) => host.toLowerCase()));
    if (target.protocol !== 'https:' || !allowedHosts.has(target.hostname.toLowerCase())) {
        throw new McpAuthError('OAuth metadata URL is not trusted', 'mcp_auth_invalid_discovery');
    }
}

function bearerToken(req) {
    const headers = req && req.headers || {};
    const value = typeof req.get === 'function'
        ? req.get('authorization')
        : headers.authorization || headers.Authorization || '';
    const match = String(value || '').match(/^Bearer\s+(.+)$/i);
    return match ? match[1].trim() : '';
}

function parseJwtPart(value) {
    try {
        const parsed = JSON.parse(base64UrlBuffer(value).toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('JWT part is not an object');
        }
        return parsed;
    } catch (error) {
        throw new McpAuthError('The access token is invalid', 'invalid_token');
    }
}

function isJsonObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function base64UrlBuffer(value) {
    const text = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
    const padding = '='.repeat((4 - (text.length % 4)) % 4);
    return Buffer.from(text + padding, 'base64');
}

function normaliseIssuer(value) {
    const issuer = String(value || '').trim().replace(/\/$/, '');
    if (!issuer) return '';
    try {
        const url = new URL(issuer);
        return url.protocol === 'https:' ? issuer : '';
    } catch (error) {
        return '';
    }
}

function freshCacheEntry(cache, key, now) {
    const entry = cache.get(key);
    if (!entry || entry.expiresAt <= now) return null;
    return entry.value;
}

function requireMcpCapability(access, capability) {
    assertCapability(access, capability);
    return access;
}

function resetMcpAuthCaches() {
    discoveryCache.clear();
    discoveryRefreshAttemptedAt.clear();
    discoveryRequests.clear();
    jwksCache.clear();
    jwksRefreshAttemptedAt.clear();
    jwksRequests.clear();
}

module.exports = {
    McpAccessError,
    McpAuthError,
    mcpIdentityFromClaims,
    requireMcpCapability,
    resetMcpAuthCaches,
    resolveMcpAccess,
    verifyBearerToken
};
