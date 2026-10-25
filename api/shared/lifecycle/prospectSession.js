const crypto = require('crypto');
const { tenantStorageKey } = require('../tenantAccess');

const COOKIE_NAME = 'nf_prospect_session';
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const SESSION_TTL_MS = SESSION_TTL_SECONDS * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;

class ProspectSessionError extends Error {
    constructor(statusCode, message, code) {
        super(message);
        this.statusCode = statusCode;
        this.details = { code };
    }
}

function createProspectSessionManager(options = {}) {
    const env = options.env || process.env;
    const secret = resolveSecret(env);
    const now = options.now || (() => Date.now());
    const secure = String(env.NOFRIES_PUBLIC_URL || '').startsWith('https://') || String(env.NODE_ENV || '') === 'production';
    const cookieName = secure ? `__Host-${COOKIE_NAME}` : COOKIE_NAME;

    return {
        resolve(cookieHeader) {
            const encoded = readCookie(cookieHeader, cookieName);
            if (!encoded) return null;
            const parts = encoded.split('.');
            if (parts.length !== 3 || parts[0] !== 'v2') return null;
            const payloadText = parts[1];
            if (!safeEqual(parts[2], sign(payloadText, secret))) return null;

            try {
                const payload = JSON.parse(Buffer.from(payloadText, 'base64url').toString('utf8'));
                const issuedAt = Number(payload && payload.iat);
                const expiresAt = Number(payload && payload.exp);
                const currentTime = Number(now());
                if (!/^ps_[A-Za-z0-9_-]{32,}$/.test(String(payload && payload.token || '')) ||
                    !Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || !Number.isFinite(currentTime) ||
                    issuedAt > currentTime + CLOCK_SKEW_MS || expiresAt <= currentTime ||
                    expiresAt <= issuedAt || expiresAt - issuedAt > SESSION_TTL_MS) {
                    return null;
                }
                return session(payload.token);
            } catch (error) {
                return null;
            }
        },

        create() {
            const token = `ps_${crypto.randomBytes(32).toString('base64url')}`;
            const issuedAt = Number(now());
            const payload = Buffer.from(JSON.stringify({
                token,
                iat: issuedAt,
                exp: issuedAt + SESSION_TTL_MS
            }), 'utf8').toString('base64url');
            return Object.assign(session(token), {
                cookie: serialiseCookie(cookieName, `v2.${payload}.${sign(payload, secret)}`, secure)
            });
        },

        admissionKey(clientAddress) {
            const value = String(clientAddress || 'unknown').trim().toLowerCase().slice(0, 180) || 'unknown';
            return crypto
                .createHmac('sha256', secret)
                .update(`prospect-admission:v1:${value}`)
                .digest('hex');
        },

        clearCookie() {
            return `${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Priority=High${secure ? '; Secure' : ''}`;
        }
    };
}

function createPublicAgentAccess(env = process.env) {
    const tenantId = String(
        env.NOFRIES_DEFAULT_TENANT_ID ||
        env.NOFRIES_TENANT_SLUG ||
        'founding-pilot'
    ).trim().toLowerCase();
    const tenantName = String(env.NOFRIES_TENANT_NAME || 'No Fries').trim().slice(0, 120);
    return {
        allowed: true,
        reason: 'public_prospect_agent',
        user: {
            email: 'prospect-agent@system.nofries',
            name: 'Prospect Agent',
            role: 'public_agent',
            capabilities: ['prospect:read-own', 'prospect:write-own']
        },
        tenant: {
            id: tenantId,
            key: tenantStorageKey(tenantId),
            name: tenantName,
            slug: slugify(tenantName)
        },
        authentication: {
            required: false,
            authenticated: false,
            provider: 'signed_prospect_session',
            tenantWideAccess: false
        }
    };
}

function session(token) {
    return {
        token,
        sessionHash: crypto.createHash('sha256').update(`nofries-prospect:${token}`).digest('hex')
    };
}

function resolveSecret(env) {
    const secret = String(
        env.NOFRIES_PROSPECT_SIGNING_SECRET ||
        env.NOFRIES_SCOPE_SIGNING_SECRET ||
        ''
    );
    if (secret.length < 32) {
        throw new ProspectSessionError(
            503,
            'The prospect assistant is not configured yet',
            'prospect_session_not_configured'
        );
    }
    return secret;
}

function sign(payload, secret) {
    return crypto.createHmac('sha256', secret).update(`v2:${payload}`).digest('base64url');
}

function safeEqual(left, right) {
    const a = Buffer.from(String(left || ''));
    const b = Buffer.from(String(right || ''));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readCookie(header, name) {
    const match = String(header || '')
        .split(';')
        .map((part) => part.trim())
        .find((part) => part.startsWith(`${name}=`));
    if (!match) return '';
    try {
        return decodeURIComponent(match.slice(name.length + 1));
    } catch (error) {
        return '';
    }
}

function serialiseCookie(name, value, secure) {
    return [
        `${name}=${encodeURIComponent(value)}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Strict',
        `Max-Age=${SESSION_TTL_SECONDS}`,
        'Priority=High',
        secure ? 'Secure' : ''
    ].filter(Boolean).join('; ');
}

function slugify(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80) || 'nofries';
}

module.exports = {
    COOKIE_NAME,
    ProspectSessionError,
    createProspectSessionManager,
    createPublicAgentAccess
};
