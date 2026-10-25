const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { BlobServiceClient } = require('@azure/storage-blob');

const ACCESS_COOKIE = '__Host-nofries_scope_access';
const DEFAULT_CHALLENGE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_ACCESS_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 5;

class ScopeAccessError extends Error {
    constructor(code, publicMessage, status = 400) {
        super(code);
        this.name = 'ScopeAccessError';
        this.code = code;
        this.publicMessage = publicMessage;
        this.status = status;
    }
}

class MemoryChallengeStore {
    constructor() {
        this.records = new Map();
        this.verifiedInterests = new Map();
    }

    async create(record) {
        if (this.records.has(record.id)) {
            throw new ScopeAccessError('challenge_conflict', 'Please request another code.', 409);
        }
        this.records.set(record.id, { version: 1, record: clone(record) });
    }

    async load(id) {
        const value = this.records.get(id);
        return value ? { version: value.version, record: clone(value.record) } : null;
    }

    async update(id, version, record) {
        const current = this.records.get(id);
        if (!current || current.version !== version) {
            throw new ScopeAccessError('challenge_used', 'That code has already been used. Please request a new one.', 409);
        }
        this.records.set(id, { version: current.version + 1, record: clone(record) });
    }

    async delete(id) {
        this.records.delete(id);
    }

    async recordVerifiedInterest(record) {
        if (!this.verifiedInterests.has(record.id)) {
            this.verifiedInterests.set(record.id, verifiedInterestPayload(record));
        }
    }
}

class FileChallengeStore {
    constructor(directory) {
        this.directory = directory;
        fs.mkdirSync(directory, { recursive: true });
    }

    async create(record) {
        const filePath = this.filePath(record.id);
        fs.writeFileSync(filePath, JSON.stringify({ version: 1, record }), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    }

    async load(id) {
        try {
            return JSON.parse(fs.readFileSync(this.filePath(id), 'utf8'));
        } catch (error) {
            if (error && error.code === 'ENOENT') return null;
            throw error;
        }
    }

    async update(id, version, record) {
        const current = await this.load(id);
        if (!current || current.version !== version) {
            throw new ScopeAccessError('challenge_used', 'That code has already been used. Please request a new one.', 409);
        }
        fs.writeFileSync(this.filePath(id), JSON.stringify({ version: version + 1, record }), { encoding: 'utf8', mode: 0o600 });
    }

    async delete(id) {
        try {
            fs.unlinkSync(this.filePath(id));
        } catch (error) {
            if (!error || error.code !== 'ENOENT') throw error;
        }
    }

    async recordVerifiedInterest(record) {
        const payload = verifiedInterestPayload(record);
        try {
            fs.writeFileSync(
                this.verifiedInterestPath(record.id),
                JSON.stringify(payload),
                { encoding: 'utf8', flag: 'wx', mode: 0o600 }
            );
        } catch (error) {
            if (!error || error.code !== 'EEXIST') throw error;
        }
    }

    filePath(id) {
        return path.join(this.directory, `${sha256(id)}.json`);
    }

    verifiedInterestPath(id) {
        return path.join(this.directory, `verified-${sha256(id)}.json`);
    }
}

class AzureBlobChallengeStore {
    constructor(options = {}) {
        const connectionString = options.connectionString || process.env.AZURE_STORAGE_CONNECTION_STRING;
        const accountName = options.accountName || process.env.AZURE_STORAGE_ACCOUNT_NAME;
        const blobEndpoint = options.blobEndpoint || (accountName ? `https://${accountName}.blob.core.windows.net` : '');
        if (!connectionString && !blobEndpoint) {
            throw new ScopeAccessError('scope_storage_unavailable', 'Email verification is temporarily unavailable.', 503);
        }
        const containerName = options.containerName
            || process.env.NOFRIES_SCOPE_CONTAINER
            || process.env.NOFRIES_AZURE_CONTAINER
            || 'nofries-workspace';
        let service;
        if (connectionString) {
            service = BlobServiceClient.fromConnectionString(connectionString);
        } else {
            const { DefaultAzureCredential } = require('@azure/identity');
            service = new BlobServiceClient(blobEndpoint, options.credential || new DefaultAzureCredential());
        }
        this.container = service.getContainerClient(containerName);
        this.ready = null;
    }

    async create(record) {
        await this.ensureContainer();
        const payload = JSON.stringify(record);
        try {
            await this.blob(record.id).upload(payload, Buffer.byteLength(payload), {
                conditions: { ifNoneMatch: '*' },
                blobHTTPHeaders: { blobContentType: 'application/json' }
            });
        } catch (error) {
            if (error && (error.statusCode === 409 || error.statusCode === 412)) {
                throw new ScopeAccessError('challenge_conflict', 'Please request another code.', 409);
            }
            throw error;
        }
    }

    async load(id) {
        await this.ensureContainer();
        const blob = this.blob(id);
        try {
            const response = await blob.download(0);
            const content = await streamToString(response.readableStreamBody);
            return { version: response.etag, record: JSON.parse(content) };
        } catch (error) {
            if (error && error.statusCode === 404) return null;
            throw error;
        }
    }

    async update(id, version, record) {
        const blob = this.blob(id);
        const payload = JSON.stringify(record);
        try {
            await blob.upload(payload, Buffer.byteLength(payload), {
                conditions: { ifMatch: version },
                blobHTTPHeaders: { blobContentType: 'application/json' }
            });
        } catch (error) {
            if (error && (error.statusCode === 404 || error.statusCode === 412)) {
                throw new ScopeAccessError('challenge_used', 'That code has already been used. Please request a new one.', 409);
            }
            throw error;
        }
    }

    async delete(id) {
        await this.blob(id).deleteIfExists();
    }

    async recordVerifiedInterest(record) {
        await this.ensureContainer();
        const payload = JSON.stringify(verifiedInterestPayload(record));
        try {
            await this.verifiedInterestBlob(record.id).upload(payload, Buffer.byteLength(payload), {
                conditions: { ifNoneMatch: '*' },
                blobHTTPHeaders: { blobContentType: 'application/json' }
            });
        } catch (error) {
            if (!error || (error.statusCode !== 409 && error.statusCode !== 412)) throw error;
        }
    }

    async ensureContainer() {
        if (!this.ready) {
            this.ready = this.container.createIfNotExists();
        }
        await this.ready;
    }

    blob(id) {
        return this.container.getBlockBlobClient(`public-scope/challenges/${sha256(id)}.json`);
    }

    verifiedInterestBlob(id) {
        return this.container.getBlockBlobClient(`public-scope/verified/${sha256(id)}.json`);
    }
}

function createScopeAccessService(options = {}) {
    const now = options.now || (() => Date.now());
    const randomBytes = options.randomBytes || crypto.randomBytes;
    const challengeTtlMs = options.challengeTtlMs || DEFAULT_CHALLENGE_TTL_MS;
    const accessTtlMs = options.accessTtlMs || DEFAULT_ACCESS_TTL_MS;
    const secret = String(options.secret || process.env.NOFRIES_SCOPE_SIGNING_SECRET || '');
    const store = options.store || createDefaultStore(options.env || process.env);
    const sendEmail = options.sendEmail || sendScopeEmail;
    const publicUrl = String(options.publicUrl || process.env.NOFRIES_PUBLIC_URL || 'https://nofries.nz').replace(/\/$/, '');

    function requireSecret() {
        if (secret.length < 32) {
            throw new ScopeAccessError('scope_configuration_error', 'Email verification is temporarily unavailable.', 503);
        }
    }

    async function requestAccess(input = {}) {
        requireSecret();
        const email = normalizeEmail(input.email);
        if (!email) {
            throw new ScopeAccessError('email_invalid', 'Enter a valid work email address.', 400);
        }

        if (String(input.website || '').trim()) {
            return {
                challengeId: base64url(randomBytes(18)),
                emailHint: maskEmail(email),
                expiresInMinutes: Math.round(challengeTtlMs / 60000)
            };
        }

        const challengeId = base64url(randomBytes(18));
        const linkToken = base64url(randomBytes(32));
        const code = createSixDigitCode(randomBytes(4));
        const createdAt = now();
        const record = {
            id: challengeId,
            email,
            codeHash: credentialHash(secret, challengeId, 'code', code),
            linkTokenHash: credentialHash(secret, challengeId, 'link', linkToken),
            createdAt,
            expiresAt: createdAt + challengeTtlMs,
            attempts: 0,
            consumedAt: null,
            requesterHash: sha256(String(input.ip || 'unknown'))
        };

        await store.create(record);
        const verificationUrl = `${publicUrl}/api/scope/verify?id=${encodeURIComponent(challengeId)}&token=${encodeURIComponent(linkToken)}`;

        try {
            await sendEmail({ email, code, verificationUrl, expiresInMinutes: Math.round(challengeTtlMs / 60000) });
        } catch (error) {
            await store.delete(challengeId).catch(() => {});
            throw new ScopeAccessError('email_delivery_failed', 'We could not send the verification email. Please try again or email hello@nofries.nz.', 503);
        }

        return {
            challengeId,
            emailHint: maskEmail(email),
            expiresInMinutes: Math.round(challengeTtlMs / 60000)
        };
    }

    async function verifyAccess(input = {}) {
        requireSecret();
        const challengeId = String(input.challengeId || input.id || '').trim();
        if (!/^[A-Za-z0-9_-]{20,80}$/.test(challengeId)) {
            throw new ScopeAccessError('challenge_invalid', 'Request a new verification code.', 400);
        }

        const loaded = await store.load(challengeId);
        if (!loaded) {
            throw new ScopeAccessError('challenge_missing', 'That code has expired. Please request a new one.', 404);
        }
        const record = loaded.record;
        if (record.consumedAt) {
            throw new ScopeAccessError('challenge_used', 'That code has already been used. Please request a new one.', 409);
        }
        if (record.expiresAt <= now()) {
            throw new ScopeAccessError('challenge_expired', 'That code has expired. Please request a new one.', 410);
        }
        if ((record.attempts || 0) >= MAX_ATTEMPTS) {
            throw new ScopeAccessError('challenge_locked', 'Too many attempts. Please request a new code.', 429);
        }

        const providedCode = String(input.code || '').replace(/\D/g, '');
        const providedLinkToken = String(input.linkToken || input.token || '').trim();
        const codeMatches = providedCode.length === 6 && safeEqual(
            record.codeHash,
            credentialHash(secret, challengeId, 'code', providedCode)
        );
        const linkMatches = providedLinkToken.length >= 32 && safeEqual(
            record.linkTokenHash,
            credentialHash(secret, challengeId, 'link', providedLinkToken)
        );

        if (!codeMatches && !linkMatches) {
            record.attempts = (record.attempts || 0) + 1;
            await store.update(challengeId, loaded.version, record);
            throw new ScopeAccessError(
                record.attempts >= MAX_ATTEMPTS ? 'challenge_locked' : 'code_invalid',
                record.attempts >= MAX_ATTEMPTS ? 'Too many attempts. Please request a new code.' : 'That code is not correct. Please check the email and try again.',
                record.attempts >= MAX_ATTEMPTS ? 429 : 400
            );
        }

        const verifiedAt = now();
        try {
            await store.recordVerifiedInterest({
                id: challengeId,
                email: record.email,
                verifiedAt,
                source: 'standard-service-scope'
            });
        } catch (error) {
            throw new ScopeAccessError(
                'verified_interest_storage_failed',
                'We confirmed your email but could not prepare the scope. Please try again.',
                503
            );
        }

        record.consumedAt = verifiedAt;
        record.codeHash = null;
        record.linkTokenHash = null;
        await store.update(challengeId, loaded.version, record);
        await store.delete(challengeId).catch(() => {});

        const expiresAt = verifiedAt + accessTtlMs;
        const emailHint = maskEmail(record.email);
        const accessToken = signAccessToken(secret, {
            audience: 'nofries-service-scope',
            subject: subjectHash(secret, record.email),
            emailHint,
            issuedAt: verifiedAt,
            expiresAt,
            version: 2
        });

        return {
            email: record.email,
            emailHint,
            accessToken,
            expiresAt,
            cookie: accessCookie(accessToken, accessTtlMs)
        };
    }

    function authorize(input = {}) {
        requireSecret();
        const cookieHeader = String(input.cookie || input.cookieHeader || '');
        // Azure Static Web Apps can inject an unrelated Authorization header.
        // Scope access is browser-only, so accept only this service's signed,
        // HttpOnly cookie and never interpret platform credentials as tokens.
        const token = parseCookies(cookieHeader)[ACCESS_COOKIE];
        if (!token) {
            throw new ScopeAccessError('scope_access_required', 'Verify your email to view the detailed scope.', 401);
        }

        const payload = verifyAccessToken(secret, token, now(), accessTtlMs);
        if (!payload) {
            throw new ScopeAccessError('scope_access_expired', 'Your scope access has expired. Please verify your email again.', 401);
        }
        return {
            email: payload.version === 1 ? payload.email : '',
            emailHint: payload.version === 1 ? maskEmail(payload.email) : payload.emailHint,
            expiresAt: payload.expiresAt
        };
    }

    return {
        authorize,
        requestAccess,
        verifyAccess
    };
}

function createDefaultStore(env = process.env) {
    const provider = String(env.NOFRIES_SCOPE_STORAGE_PROVIDER || '').toLowerCase();
    if (provider === 'memory') return new MemoryChallengeStore();
    if (provider === 'local') {
        const directory = env.NOFRIES_SCOPE_DATA_DIR || path.join(os.tmpdir(), 'nofries-scope-access');
        return new FileChallengeStore(directory);
    }
    const azureConfigured = Boolean(env.AZURE_STORAGE_CONNECTION_STRING || env.AZURE_STORAGE_ACCOUNT_NAME);
    if (provider === 'azure' || azureConfigured) {
        return new AzureBlobChallengeStore({
            connectionString: env.AZURE_STORAGE_CONNECTION_STRING,
            accountName: env.AZURE_STORAGE_ACCOUNT_NAME,
            containerName: env.NOFRIES_SCOPE_CONTAINER || env.NOFRIES_AZURE_CONTAINER
        });
    }
    const directory = env.NOFRIES_SCOPE_DATA_DIR || path.join(os.tmpdir(), 'nofries-scope-access');
    return new FileChallengeStore(directory);
}

async function sendScopeEmail(message, env = process.env) {
    const apiKey = String(env.RESEND_API_KEY || '').trim();
    const from = String(env.NOFRIES_SCOPE_EMAIL_FROM || '').trim();
    if (!apiKey || !from) {
        throw new Error('Scope email delivery is not configured');
    }

    const subject = 'Confirm your email to view the No Fries service scope';
    const html = `
        <div style="font-family:Arial,sans-serif;max-width:620px;margin:0 auto;color:#17211d;line-height:1.55">
            <p style="font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#1e5b4d">No Fries Managed IT</p>
            <h1 style="font-size:28px;line-height:1.15">Confirm your email</h1>
            <p>Use the button below to confirm this address and view the standard managed IT service scope.</p>
            <p style="margin:28px 0"><a href="${escapeHtml(message.verificationUrl)}" style="display:inline-block;border-radius:9px;padding:13px 18px;color:#fff;background:#11382f;text-decoration:none;font-weight:700">Confirm email and view scope</a></p>
            <p>Or enter this six-digit code on nofries.nz:</p>
            <p style="font-size:30px;font-weight:800;letter-spacing:.16em">${escapeHtml(message.code)}</p>
            <p style="font-size:13px;color:#65746e">The link and code expire in ${Number(message.expiresInMinutes) || 15} minutes and can be used once. If you did not request this, you can ignore the email.</p>
        </div>`;
    const text = [
        'No Fries Managed IT',
        '',
        'Confirm your email to view the standard managed IT service scope:',
        message.verificationUrl,
        '',
        `Verification code: ${message.code}`,
        '',
        `The link and code expire in ${Number(message.expiresInMinutes) || 15} minutes and can be used once.`
    ].join('\n');

    const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        signal: AbortSignal.timeout(10000),
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            from,
            to: [message.email],
            reply_to: env.NOFRIES_SCOPE_EMAIL_REPLY_TO || 'hello@nofries.nz',
            subject,
            html,
            text
        })
    });

    if (!response.ok) {
        throw new Error(`Resend returned ${response.status}`);
    }
}

function signAccessToken(secret, payload) {
    const body = base64url(Buffer.from(JSON.stringify(payload), 'utf8'));
    const signature = base64url(crypto.createHmac('sha256', secret).update(body).digest());
    return `${body}.${signature}`;
}

function verifyAccessToken(secret, token, currentTime, maxTtlMs) {
    const parts = String(token || '').split('.');
    if (parts.length !== 2) return null;
    const expected = base64url(crypto.createHmac('sha256', secret).update(parts[0]).digest());
    if (!safeEqual(expected, parts[1])) return null;
    try {
        const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
        const issuedAt = Number(payload && payload.issuedAt);
        const expiresAt = Number(payload && payload.expiresAt);
        const now = Number(currentTime);
        const maximumTtl = Number(maxTtlMs);
        if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) ||
            !Number.isFinite(now) || !Number.isFinite(maximumTtl) ||
            issuedAt > now + 5 * 60 * 1000 || expiresAt <= now ||
            expiresAt <= issuedAt || expiresAt - issuedAt > maximumTtl) {
            return null;
        }
        if (payload.version === 1 && normalizeEmail(payload.email)) {
            return payload;
        }
        if (payload.version === 2 &&
            payload.audience === 'nofries-service-scope' &&
            /^[A-Za-z0-9_-]{40,50}$/.test(String(payload.subject || '')) &&
            typeof payload.emailHint === 'string' && payload.emailHint.length <= 320) {
            return payload;
        }
        return null;
    } catch (error) {
        return null;
    }
}

function accessCookie(token, ttlMs) {
    return `${ACCESS_COOKIE}=${token}; Path=/; Max-Age=${Math.floor(ttlMs / 1000)}; HttpOnly; Secure; SameSite=Strict; Priority=High`;
}

function clearAccessCookie() {
    return `${ACCESS_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict; Priority=High`;
}

function credentialHash(secret, id, type, value) {
    return crypto.createHmac('sha256', secret).update(`${id}:${type}:${value}`).digest('hex');
}

function subjectHash(secret, email) {
    return base64url(crypto.createHmac('sha256', secret).update(`scope-subject:${email}`).digest());
}

function normalizeEmail(value) {
    const email = String(value || '').trim().toLowerCase();
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return '';
    return email;
}

function maskEmail(email) {
    const [local, domain] = String(email || '').split('@');
    if (!local || !domain) return 'your address';
    const visible = local.length <= 2 ? local[0] : local.slice(0, 2);
    return `${visible}${'•'.repeat(Math.max(2, Math.min(6, local.length - visible.length)))}@${domain}`;
}

function createSixDigitCode(bytes) {
    const value = Buffer.from(bytes).readUInt32BE(0) % 1000000;
    return String(value).padStart(6, '0');
}

function parseCookies(header) {
    return String(header || '').split(';').reduce((cookies, part) => {
        const separator = part.indexOf('=');
        if (separator < 1) return cookies;
        const name = part.slice(0, separator).trim();
        const value = part.slice(separator + 1).trim();
        if (name) cookies[name] = value;
        return cookies;
    }, {});
}

function safeEqual(left, right) {
    const a = Buffer.from(String(left || ''));
    const b = Buffer.from(String(right || ''));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function base64url(value) {
    return Buffer.from(value).toString('base64url');
}

function sha256(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function verifiedInterestPayload(record) {
    return {
        email: record.email,
        verifiedAt: record.verifiedAt,
        source: record.source
    };
}

function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function streamToString(stream) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        stream.on('error', reject);
    });
}

module.exports = {
    ACCESS_COOKIE,
    AzureBlobChallengeStore,
    FileChallengeStore,
    MemoryChallengeStore,
    ScopeAccessError,
    accessCookie,
    clearAccessCookie,
    createScopeAccessService,
    maskEmail,
    normalizeEmail,
    sendScopeEmail
};
