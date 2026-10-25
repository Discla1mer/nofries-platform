'use strict';

const crypto = require('node:crypto');
const COOKIE = '__Host-nofries_org_setup';
const CODE_TTL = 10 * 60 * 1000;
const SETUP_TTL = 24 * 60 * 60 * 1000;
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const setupReferenceKey = requestId => {
    if (typeof requestId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(requestId)) throw new Error('setup_request_invalid');
    return 'references/' + hash('nofries:organisation-setup-reference:v1\0' + requestId);
};
const codeHash = (token, code) => crypto.createHmac('sha256', token).update('nofries:org-code:v1\0' + code).digest('hex');
class OrganisationSetupError extends Error {
    constructor(status, code) { super(code); this.statusCode = status; this.code = code; }
}
const fail = (status, code) => { throw new OrganisationSetupError(status, code); };
async function reserveSetupBudget(store, kind, identity, period, limit, at, reservationKey) {
    if (!Number.isSafeInteger(at) || at < 0) fail(503, 'setup_unavailable');
    if (reservationKey !== undefined && (typeof reservationKey !== 'string' || !/^[a-f0-9]{64}$/.test(reservationKey))) fail(503, 'setup_unavailable');
    const bucket = Math.floor(at / period);
    const key = 'budget/' + hash(kind + ':' + identity + ':' + bucket);
    for (let i = 0; i < 4; i++) {
        const loaded = await store.load(key);
        if (loaded && (!Number.isSafeInteger(loaded.record.count) || loaded.record.count < 0 || loaded.record.count > limit)) fail(503, 'setup_unavailable');
        const reservations = loaded && Object.hasOwn(loaded.record, 'reservations') ? loaded.record.reservations : [];
        if (!Array.isArray(reservations) || reservations.length > (loaded?.record.count || 0) ||
            reservations.length > limit || new Set(reservations).size !== reservations.length ||
            reservations.some(value => typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))) fail(503, 'setup_unavailable');
        if (reservationKey && reservations.includes(reservationKey)) return;
        if ((loaded?.record.count || 0) >= limit) fail(429, 'setup_rate_limited');
        const next = { schemaVersion: 1, count: (loaded?.record.count || 0) + 1, expiresAt: (bucket + 1) * period,
            ...(reservations.length || reservationKey ? { reservations: reservationKey ? [...reservations, reservationKey] : reservations } : {}) };
        if (loaded ? await store.replace(key, loaded.version, next) : await store.create(key, next)) return;
    }
    fail(429, 'setup_rate_limited');
}
// One existing durable daily ceiling, shared by legacy verification requests and
// first external setup admission across every process and runtime instance.
const reserveSetupGlobalBudget = (store, at, reservationKey) => reserveSetupBudget(store, 'global', 'all', 86400000, 20, at, reservationKey);
function input(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== keys.sort().join(',')) fail(400, 'setup_input_invalid');
    return value;
}
function accountType(value) {
    if (value === undefined) return 'company'; // Existing requests remain valid.
    if (!['company', 'consultant'].includes(value)) fail(400, 'account_type_invalid');
    return value;
}
function organisation(value) {
    if (typeof value !== 'string') fail(400, 'organisation_name_invalid');
    const result = value.trim().normalize('NFC');
    if (!result || result.length > 120 || /[\u0000-\u001f\u007f-\u009f<>]/u.test(result)) fail(400, 'organisation_name_invalid');
    return result;
}
function workEmail(value) {
    if (typeof value !== 'string' || value.length > 254) fail(400, 'work_email_invalid');
    const result = value.trim().toLowerCase();
    const parts = result.split('@');
    if (parts.length !== 2 || !/^[a-z0-9!#$%&'*+\-/=?^_\x60{|}~.]{1,64}$/i.test(parts[0]) ||
        parts[0].startsWith('.') || parts[0].endsWith('.') || parts[0].includes('..') ||
        !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(parts[1])) fail(400, 'work_email_invalid');
    return result;
}
function cookieToken(header) {
    const found = String(header || '').split(';').map(x => x.trim()).filter(x => x.startsWith(COOKIE + '='));
    if (found.length !== 1) return null;
    const token = found[0].slice(COOKIE.length + 1);
    return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}
function publicState(record, at) {
    if (!record || record.expiresAt <= at) return { state: 'start' };
    const selectedType = record.accountType === null ? null : accountType(record.accountType);
    if (record.status === 'verified') return { state: 'verified', organisationName: record.organisationName,
        requestId: record.requestId, accountType: selectedType, accessGranted: false };
    return { state: 'awaiting_code', requestId: record.requestId, accountType: selectedType, emailHint: record.email.slice(0, 1) + '***@' + record.email.split('@')[1],
        codeExpired: record.codeExpiresAt <= at, attemptsExhausted: record.attempts >= 5 };
}
function createOrganisationSetup({ store, sendEmail, origin, readContinuation, starterSetup, findAccount = starterSetup?.findAccount, now = Date.now, randomBytes = crypto.randomBytes, randomInt = crypto.randomInt, newId = crypto.randomUUID }) {
    if (!store || !['load', 'create', 'replace'].every(k => typeof store[k] === 'function') || typeof sendEmail !== 'function' || new URL(origin).origin !== origin || !origin.startsWith('https://')) throw new TypeError('organisation_setup_configuration_invalid');
    if (starterSetup !== undefined && (!starterSetup || !['read', 'save'].every(k => typeof starterSetup[k] === 'function'))) throw new TypeError('organisation_setup_configuration_invalid');
    if (findAccount !== undefined && typeof findAccount !== 'function') throw new TypeError('organisation_setup_configuration_invalid');
    async function replace(key, loaded, record) {
        if (!await store.replace(key, loaded.version, record)) fail(409, 'setup_changed');
    }
    const detachedKey = requestKey => requestKey.replace(/^requests\//, 'detached/');
    async function isDetached(requestKey) {
        return requestKey ? Boolean(await store.load(detachedKey(requestKey))) : false;
    }
    async function retainVerifiedReference(record, requestKey) {
        // Only the original opaque-cookie lookup supplies this key and record.
        // Preserve proofs created before the locator existed, without changing
        // the proof, its expiry, or any identity/organisation authority.
        try {
            input(record, ['schemaVersion', 'requestId', 'organisationName', 'email', 'status',
                'codeHash', 'attempts', 'createdAt', 'codeExpiresAt', 'expiresAt', 'verifiedAt',
                ...(Object.hasOwn(record, 'accountType') ? ['accountType'] : [])]);
            const unselected = record.accountType === null && record.organisationName === null;
            if (!unselected) accountType(record.accountType);
            if (record.email !== workEmail(record.email) || !unselected && record.organisationName !== organisation(record.organisationName)) throw new Error();
        } catch (_) { fail(503, 'setup_unavailable'); }
        if (!/^requests\/[a-f0-9]{64}$/.test(requestKey) || record.schemaVersion !== 1 || record.status !== 'verified' ||
            record.codeHash !== null ||
            ![record.attempts, record.createdAt, record.codeExpiresAt, record.expiresAt, record.verifiedAt].every(Number.isSafeInteger) ||
            record.attempts < 0 || record.attempts >= 5 || record.createdAt < 0 || record.verifiedAt < record.createdAt ||
            record.verifiedAt >= record.codeExpiresAt || record.verifiedAt > now() ||
            record.codeExpiresAt !== record.createdAt + CODE_TTL || record.expiresAt !== record.createdAt + SETUP_TTL) fail(503, 'setup_unavailable');
        const referenceKey = setupReferenceKey(record.requestId);
        const expected = { schemaVersion: 1, requestId: record.requestId, requestKey, expiresAt: record.expiresAt };
        let saved = await store.load(referenceKey);
        if (!saved) {
            if (record.expiresAt <= now()) return;
            await store.create(referenceKey, expected);
            saved = await store.load(referenceKey);
        }
        const value = saved?.record;
        if (!value || Object.keys(value).sort().join(',') !== Object.keys(expected).sort().join(',') ||
            Object.keys(expected).some(name => value[name] !== expected[name])) fail(503, 'setup_unavailable');
    }
    async function project(record, requestKey) {
        if (await isDetached(requestKey)) return { state: 'start' };
        const result = publicState(record, now());
        if (result.state === 'verified') {
            await retainVerifiedReference(record, requestKey);
            if (findAccount || record.accountType === null) {
                const existing = findAccount ? await findAccount(record) : null;
                if (existing) {
                    result.accountType = accountType(existing.accountType);
                    result.organisationName = organisation(existing.organisationName);
                    const steps = ['account_found', 'setup_review_required', 'secure_sign_in'];
                    if (starterSetup && record.accountType !== null) steps.push('details_required');
                    if (existing.nextStep !== undefined && !steps.includes(existing.nextStep)) fail(503, 'setup_unavailable');
                    result.nextStep = existing.nextStep || 'account_found';
                } else if (record.accountType === null) result.nextStep = 'choose_account';
                if (existing || record.accountType === null) return record.expiresAt <= now() ? { state: 'start' } : result;
            }
            if (starterSetup && Object.hasOwn(record, 'accountType')) {
                const nextStep = await starterSetup.read(record);
                if (!['details_required', 'pending_activation', 'check_invitation', 'setup_review_required', 'secure_sign_in'].includes(nextStep)) fail(503, 'setup_unavailable');
                result.nextStep = nextStep;
            } else if (readContinuation) {
                const nextStep = await readContinuation(record);
                if (!['pending_activation', 'check_invitation'].includes(nextStep)) fail(503, 'setup_unavailable');
                result.nextStep = nextStep;
            }
            if (record.expiresAt <= now()) return { state: 'start' };
        }
        return result;
    }
    async function reserve(kind, identity, period, limit, at) {
        return reserveSetupBudget(store, kind, identity, period, limit, at);
    }
    function sameOrigin(req) {
        if (req.headers?.origin !== origin || req.headers?.['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin') fail(403, 'setup_origin_invalid');
        if (!/^application\/json(?:\s*;|$)/i.test(req.headers?.['content-type'] || '')) fail(415, 'setup_content_type_invalid');
    }
    async function handle(req) {
        const method = String(req.method || '').toUpperCase();
        const route = String(req.path || '').replace(/^\/api\/organisation-setup\//, '');
        if (req.originalUrl?.includes('?')) fail(400, 'setup_input_invalid');
        if (method === 'GET' && route === 'state') {
            const token = cookieToken(req.headers?.cookie);
            const requestKey = token ? 'requests/' + hash(token) : null;
            const loaded = requestKey ? await store.load(requestKey) : null;
            return { status: 200, body: await project(loaded?.record, requestKey) };
        }
        if (method !== 'POST' || !['request', 'verify', 'state', 'choose', ...(starterSetup ? ['details'] : [])].includes(route)) fail(404, 'setup_not_found');
        sameOrigin(req);
        if (Buffer.byteLength(JSON.stringify(req.body || {})) > (route === 'details' ? 8192 : 2048)) fail(413, 'setup_input_invalid');
        if (route === 'state') {
            input(req.body, ['action']);
            if (req.body.action !== 'leave') fail(400, 'setup_input_invalid');
            const token = cookieToken(req.headers?.cookie);
            const requestKey = token ? 'requests/' + hash(token) : null;
            const record = requestKey ? (await store.load(requestKey))?.record : null;
            if (record && record.expiresAt > now() && (typeof req.headers?.['x-nofries-setup-request'] !== 'string' ||
                req.headers['x-nofries-setup-request'] !== record.requestId)) fail(409, 'setup_changed');
            // Detach only this opaque session. Never send a cookie expiry:
            // a delayed response in another tab must not clear a newer cookie.
            // Keep the proof, details, reservations and delivery fences intact.
            // Already accepted submissions may finish against their original
            // proof; leaving does not cancel that cross-store workflow.
            if (record && record.expiresAt > now()) {
                if (!await store.create(detachedKey(requestKey), { schemaVersion: 1, expiresAt: record.expiresAt }) &&
                    !await isDetached(requestKey)) fail(503, 'setup_unavailable');
            }
            return { status: 200, body: { state: 'start' } };
        }
        const at = now();
        if (route === 'request') {
            const emailFirst = Object.keys(req.body || {}).length === 1 && Object.hasOwn(req.body, 'email');
            const supplied = input(req.body, emailFirst ? ['email'] : ['organisationName', 'email',
                ...(Object.hasOwn(req.body || {}, 'accountType') ? ['accountType'] : [])]);
            const selectedType = emailFirst ? null : accountType(supplied.accountType);
            const organisationName = emailFirst ? null : organisation(supplied.organisationName), email = workEmail(supplied.email);
            // Reservations are durable CAS writes and are never refunded after uncertainty.
            // Fixed upper bounds apply across all processes and restarts.
            await reserve('network', String(req.clientKey || 'unknown'), 3600000, 5, at);
            await reserve('mailbox', email, 3600000, 3, at);
            await reserveSetupGlobalBudget(store, at);
            const token = randomBytes(32).toString('base64url');
            const code = String(randomInt(0, 100000000)).padStart(8, '0');
            const record = { schemaVersion: 1, requestId: newId(), organisationName, email, accountType: selectedType, status: 'awaiting_code',
                codeHash: codeHash(token, code), attempts: 0, createdAt: at, codeExpiresAt: at + CODE_TTL,
                expiresAt: at + SETUP_TTL, verifiedAt: null };
            const requestKey = 'requests/' + hash(token);
            if (!await store.create(requestKey, record)) fail(503, 'setup_unavailable');
            // A locator for the administrative reader, never an identity proof.
            // Persist it before delivery so an acknowledged request is reachable.
            if (!await store.create(setupReferenceKey(record.requestId), { schemaVersion: 1,
                requestId: record.requestId, requestKey, expiresAt: record.expiresAt })) fail(503, 'setup_unavailable');
            let delivery = 'confirmed';
            try { await sendEmail({ email, code, requestId: record.requestId }); }
            catch (_) { delivery = 'unconfirmed'; }
            return { status: 202, headers: { 'Set-Cookie': COOKIE + '=' + token + '; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=86400' },
                body: { ...publicState(record, at), delivery } };
        }
        if (route === 'choose' || route === 'details') {
            const token = cookieToken(req.headers?.cookie);
            if (!token) fail(401, 'setup_session_required');
            const key = 'requests/' + hash(token), loaded = await store.load(key), record = loaded?.record;
            if (await isDetached(key)) fail(410, 'setup_expired');
            if (!record || record.expiresAt <= now()) fail(410, 'setup_expired');
            if (record.status !== 'verified') fail(403, 'setup_verification_required');
            if (!Object.hasOwn(record, 'accountType')) fail(409, 'setup_details_unavailable');
            // A different tab may have replaced the shared setup cookie. Never
            // apply the old tab's representative details to that new request.
            if (req.headers?.['x-nofries-setup-request'] !== record.requestId) fail(409, 'setup_changed');
            await retainVerifiedReference(record, key);
            if (route === 'choose') {
                const supplied = input(req.body, ['accountType', 'organisationName']);
                const selected = { accountType: accountType(supplied.accountType), organisationName: organisation(supplied.organisationName) };
                if (findAccount && await findAccount(record)) fail(409, 'starter_account_exists');
                if (record.accountType !== null) {
                    if (record.accountType !== selected.accountType || record.organisationName !== selected.organisationName) fail(409, 'setup_changed');
                    return { status: 200, body: await project(record, key) };
                }
                const chosen = { ...record, ...selected };
                await replace(key, loaded, chosen);
                return { status: 200, body: await project(chosen, key) };
            }
            if (record.accountType === null) fail(409, 'account_type_invalid');
            try { await starterSetup.save(record, req.body); }
            catch (error) {
                if (['starter_details_invalid', 'starter_authority_required'].includes(error?.code)) fail(400, error.code);
                if (['starter_details_locked', 'starter_account_exists'].includes(error?.code)) fail(409, error.code);
                throw error;
            }
            return { status: 200, body: await project(record, key) };
        }
        const supplied = input(req.body, ['code']);
        if (typeof supplied.code !== 'string' || !/^[0-9]{8}$/.test(supplied.code)) fail(400, 'verification_code_invalid');
        const token = cookieToken(req.headers?.cookie);
        if (!token) fail(401, 'setup_session_required');
        const key = 'requests/' + hash(token), loaded = await store.load(key), record = loaded?.record;
        if (await isDetached(key)) fail(410, 'setup_expired');
        if (!record || record.expiresAt <= at) fail(410, 'setup_expired');
        // A code belongs to the displayed request, even if another tab has
        // replaced the shared cookie. Reject before consuming any attempts.
        if (req.headers?.['x-nofries-setup-request'] !== record.requestId) fail(409, 'setup_changed');
        // Verified continuation is idempotent only for this same opaque browser session.
        if (record.status === 'verified') return { status: 200, body: await project(record, key) };
        if (record.codeExpiresAt <= at) fail(410, 'verification_code_expired');
        if (record.attempts >= 5) fail(429, 'verification_attempts_exhausted');
        if (typeof record.codeHash !== 'string' || !/^[a-f0-9]{64}$/.test(record.codeHash)) fail(503, 'setup_unavailable');
        if (!crypto.timingSafeEqual(Buffer.from(record.codeHash, 'hex'), Buffer.from(codeHash(token, supplied.code), 'hex'))) {
            await replace(key, loaded, { ...record, attempts: record.attempts + 1 });
            fail(record.attempts + 1 >= 5 ? 429 : 400, record.attempts + 1 >= 5 ? 'verification_attempts_exhausted' : 'verification_code_invalid');
        }
        const verified = { ...record, status: 'verified', codeHash: null, verifiedAt: at };
        await replace(key, loaded, verified);
        return { status: 200, body: await project(verified, key) };
    }
    return Object.freeze({ async handle(req) {
        try { return await handle(req); }
        catch (e) { return { status: e instanceof OrganisationSetupError ? e.statusCode : 503,
            body: { code: e instanceof OrganisationSetupError ? e.code : 'setup_unavailable' } }; }
    } });
}
module.exports = { createOrganisationSetup, OrganisationSetupError, workEmail, accountType, COOKIE, cookieToken, setupReferenceKey, reserveSetupGlobalBudget };
