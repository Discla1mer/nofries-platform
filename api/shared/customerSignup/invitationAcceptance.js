'use strict';

// Uninstalled server-side component. Account creation and authentication belong
// to the reviewed identity provider; acceptance never grants application access.
const { createHash, randomBytes, randomUUID, timingSafeEqual } = require('node:crypto');
const { isProxy } = require('node:util').types;
const MAX_LIFETIME = 7 * 24 * 60 * 60 * 1000;
const MAX_PROOF_AGE = 5 * 60 * 1000;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const HASH = /^[a-f0-9]{64}$/;
const SUBJECT = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

class SignupError extends Error {
    constructor(code, statusCode = 400) {
        super(code);
        this.name = 'SignupError';
        this.code = code;
        this.statusCode = statusCode;
    }
}
const fail = (code = 'signup_unavailable', status = 400) => { throw new SignupError(code, status); };
const exact = (v, keys) => {
    if (!v || typeof v !== 'object' || isProxy(v) || Array.isArray(v)) fail();
    const prototype = Object.getPrototypeOf(v);
    if ((prototype !== null && Object.getPrototypeOf(prototype) !== null) ||
        Object.keys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v, k))) fail();
    if (Reflect.ownKeys(v).length !== keys.length) fail();
    for (const k of keys) if (!Object.hasOwn(Object.getOwnPropertyDescriptor(v, k), 'value')) fail();
};
const text = (v, max = 180) => {
    if (typeof v !== 'string' || !v || v.length > max || v.trim() !== v || /[\u0000-\u001f\u007f]/.test(v)) fail();
    return v;
};
const email = v => {
    text(v, 254);
    const normalized = v.toLowerCase();
    // Lower-casing some Unicode code points expands them (for example, İ -> i + combining dot).
    // Validate the stored/compared representation so it can never exceed the field bound.
    text(normalized, 254);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) fail();
    return normalized; // Deliberately no Gmail dot/plus or domain alias folding.
};
const time = v => {
    if (!Number.isSafeInteger(v) || v < 0) fail();
    return v;
};
const hash = v => createHash('sha256').update(v).digest('hex');
const validHash = v => typeof v === 'string' && HASH.test(v);
function tokenDigest(token) {
    if (typeof token !== 'string' || !TOKEN.test(token) ||
        Buffer.from(token, 'base64url').toString('base64url') !== token) fail();
    return hash(token);
}
function equalHash(a, b) {
    return typeof a === 'string' && typeof b === 'string' && HASH.test(a) && HASH.test(b) &&
        timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

function createInvitation(input, { now = Date.now } = {}) {
    const scheduled = !isProxy(input) && !!input && typeof input === 'object' &&
        Reflect.ownKeys(input).some(key => ['scheduleId', 'scheduleDigest'].includes(key));
    exact(input, ['email', 'tenantId', 'organisationId', 'identityPolicyId', 'termsVersion', 'termsDigest',
        ...(scheduled ? ['scheduleId', 'scheduleDigest'] : []), 'mfaRequired', 'createdAt', 'expiresAt']);
    const expectedEmail = email(input.email);
    // The clock is a trusted server dependency, never part of the issuance body.
    const at = time(now());
    for (const field of ['tenantId', 'organisationId', 'identityPolicyId', 'termsVersion', ...(scheduled ? ['scheduleId'] : [])]) text(input[field]);
    if (!validHash(input.termsDigest) || (scheduled && !validHash(input.scheduleDigest)) || typeof input.mfaRequired !== 'boolean' ||
        time(input.createdAt) > at || at - input.createdAt > 60000 ||
        time(input.expiresAt) <= at || input.expiresAt - at > MAX_LIFETIME) fail();
    const invitationToken = randomBytes(32).toString('base64url');
    const record = { schemaVersion: scheduled ? 2 : 1, invitationId: randomUUID(), tokenDigest: tokenDigest(invitationToken),
        expectedEmail, tenantId: input.tenantId, organisationId: input.organisationId,
        identityPolicyId: input.identityPolicyId, termsVersion: input.termsVersion,
        termsDigest: input.termsDigest, ...(scheduled ? { scheduleId: input.scheduleId, scheduleDigest: input.scheduleDigest } : {}),
        mfaRequired: input.mfaRequired,
        createdAt: at, expiresAt: input.expiresAt, status: 'invited', revision: 0, acceptance: null };
    return { invitationToken, record }; // Caller must persist before separately authorized delivery.
}

const RECORD_KEYS = ['schemaVersion', 'invitationId', 'tokenDigest', 'expectedEmail', 'tenantId', 'organisationId',
    'identityPolicyId', 'termsVersion', 'termsDigest', 'mfaRequired', 'createdAt', 'expiresAt', 'status', 'revision', 'acceptance'];
const RECEIPT_KEYS = ['receiptId', 'invitationId', 'subjectKey', 'tenantId', 'organisationId', 'termsVersion',
    'termsDigest', 'acceptedAt', 'status', 'dashboardAccess'];
const SCHEDULE_KEYS = ['scheduleId', 'scheduleDigest'];
function scheduledFields(value, base) {
    const scheduled = !isProxy(value) && !!value && typeof value === 'object' &&
        Reflect.ownKeys(value).some(key => SCHEDULE_KEYS.includes(key));
    const keys = scheduled ? [...base.slice(0, base.indexOf('acceptedAt') >= 0 ? base.indexOf('acceptedAt') : base.indexOf('mfaRequired')),
        ...SCHEDULE_KEYS, ...base.slice(base.indexOf('acceptedAt') >= 0 ? base.indexOf('acceptedAt') : base.indexOf('mfaRequired'))] : base;
    exact(value, keys);
    return { scheduled, keys };
}
function validateAcceptanceReceipt(value) {
    const { scheduled, keys } = scheduledFields(value, RECEIPT_KEYS);
    if (typeof value.subjectKey !== 'string' || !SUBJECT.test(value.subjectKey) ||
        value.status !== 'pending_admission' || value.dashboardAccess !== false || !validHash(value.termsDigest) ||
        (scheduled && !validHash(value.scheduleDigest))) fail();
    for (const k of ['receiptId', 'invitationId', 'tenantId', 'organisationId', 'termsVersion', ...(scheduled ? ['scheduleId'] : [])]) text(value[k]);
    time(value.acceptedAt);
    return Object.freeze(Object.fromEntries(keys.map(key => [key, value[key]])));
}
function validateRecord(value) {
    try {
        const { scheduled } = scheduledFields(value, RECORD_KEYS);
        if (value.schemaVersion !== (scheduled ? 2 : 1) || !validHash(value.tokenDigest) || !validHash(value.termsDigest) ||
            (scheduled && !validHash(value.scheduleDigest)) ||
            email(value.expectedEmail) !== value.expectedEmail || typeof value.mfaRequired !== 'boolean' ||
            !['invited', 'accepted', 'revoked'].includes(value.status) ||
            !Number.isSafeInteger(value.revision) || value.revision < 0 ||
            time(value.expiresAt) <= time(value.createdAt) || value.expiresAt - value.createdAt > MAX_LIFETIME) fail();
        for (const k of ['invitationId', 'tenantId', 'organisationId', 'identityPolicyId', 'termsVersion', ...(scheduled ? ['scheduleId'] : [])]) text(value[k]);
        if (value.acceptance === null) {
            if (value.status === 'accepted') fail();
        } else {
            const r = validateAcceptanceReceipt(value.acceptance);
            if (r.acceptedAt < value.createdAt || r.acceptedAt >= value.expiresAt || value.status === 'invited' ||
                value.revision < 1) fail();
            for (const k of ['invitationId', 'tenantId', 'organisationId', 'termsVersion', 'termsDigest', ...(scheduled ? SCHEDULE_KEYS : [])]) {
                if (r[k] !== value[k]) fail();
            }
        }
        return value;
    } catch (_) { fail('signup_record_invalid', 503); }
}

function validateInvitationRecord(value) {
    try {
        validateRecord(value);
        return structuredClone(value);
    } catch (_) { fail('signup_record_invalid', 503); }
}

function validateProof(proof, digest, now) {
    exact(proof, ['subjectKey', 'email', 'emailVerified', 'identityPolicyId', 'mfaSatisfied',
        'invitationDigest', 'verifiedAt', 'expiresAt']);
    if (typeof proof.subjectKey !== 'string' || !SUBJECT.test(proof.subjectKey) || proof.emailVerified !== true ||
        typeof proof.mfaSatisfied !== 'boolean' || !equalHash(proof.invitationDigest, digest) ||
        time(proof.verifiedAt) > now || now - proof.verifiedAt > MAX_PROOF_AGE ||
        time(proof.expiresAt) <= now || proof.expiresAt <= proof.verifiedAt) fail('signup_identity_required', 401);
    email(proof.email); text(proof.identityPolicyId);
    return proof;
}

function createInvitationAcceptance({ store, verifyIdentity, now = Date.now, contextMode = 'token' }) {
    // Digest mode is an explicit server-composition choice, never a request
    // option. The identity adapter must still prove this exact invitation.
    if (!['token', 'verified-digest'].includes(contextMode)) throw new TypeError('signup_context_mode_invalid');
    const invitationField = contextMode === 'verified-digest' ? 'invitationDigest' : 'invitationToken';
    const resolveDigest = value => {
        if (contextMode === 'token') return tokenDigest(value);
        if (!validHash(value)) fail();
        return value;
    };
    if (!store || typeof store.transact !== 'function' || typeof verifyIdentity !== 'function' || typeof now !== 'function') {
        throw new TypeError('signup_dependencies_required');
    }
    async function inspectWithRecheck(input) {
        exact(input, [invitationField, 'identityProofHandle']);
        const digest = resolveDigest(input[invitationField]);
        text(input.identityProofHandle, 512);
        if (typeof store.read !== 'function') fail('signup_store_unavailable', 503);
        let proof;
        try {
            proof = { ...validateProof(await verifyIdentity({
                handle: input.identityProofHandle, invitationDigest: digest
            }), digest, time(now())) };
        } catch (_) { fail('signup_identity_required', 401); }
        let record;
        try { record = await store.read(digest); }
        catch (_) { fail('signup_store_unavailable', 503); }
        // Keep the detached proof inside this invocation. Composition can
        // recheck time after its own final I/O without another provider read.
        const recheck = () => {
            const at = time(now());
            validateProof(proof, digest, at);
            if (!record) fail('signup_invitation_unavailable', 403);
            const r = validateRecord(record);
            if (!equalHash(r.tokenDigest, digest) || r.status === 'revoked' ||
                r.createdAt > at || email(proof.email) !== r.expectedEmail ||
                proof.identityPolicyId !== r.identityPolicyId || (r.mfaRequired && !proof.mfaSatisfied) ||
                (r.status === 'accepted' && r.acceptance.subjectKey !== proof.subjectKey) ||
                (r.status === 'invited' && r.expiresAt <= at)) {
                fail('signup_invitation_unavailable', 403);
            }
        };
        recheck();
        // Server-only snapshot and callback; never project either to HTTP.
        return Object.freeze({ record: validateInvitationRecord(record), recheck });
    }
    return Object.freeze({
        inspectWithRecheck,
        async inspect(input) { return (await inspectWithRecheck(input)).record; },
        async accept(input) {
            const inputScheduled = !isProxy(input) && !!input && typeof input === 'object' &&
                Reflect.ownKeys(input).some(key => SCHEDULE_KEYS.includes(key));
            exact(input, [invitationField, 'identityProofHandle', 'termsVersion', 'termsDigest',
                ...(inputScheduled ? SCHEDULE_KEYS : []), 'accepted']);
            const digest = resolveDigest(input[invitationField]);
            text(input.identityProofHandle, 512); text(input.termsVersion);
            if (!validHash(input.termsDigest) || (inputScheduled && !validHash(input.scheduleDigest)) ||
                (inputScheduled && !text(input.scheduleId)) || input.accepted !== true) fail('signup_terms_required');
            // The adapter resolves server-held verified identity; request fields
            // cannot declare an email verified, an MFA result or a subject.
            let proof;
            try {
                const verified = await verifyIdentity({ handle: input.identityProofHandle, invitationDigest: digest });
                proof = validateProof(verified, digest, time(now()));
                proof = { ...proof }; // detach trusted adapter result before asynchronous storage work
            } catch (_) { fail('signup_identity_required', 401); }
            const receiptId = randomUUID(); // stable across repository callback retries
            try {
                return await store.transact(digest, record => {
                    const at = time(now());
                    validateProof(proof, digest, at); // expiry may have passed while waiting for the lock
                    if (!record) fail('signup_invitation_unavailable', 403);
                    const r = validateRecord(record);
                    if (!equalHash(r.tokenDigest, digest) || r.status === 'revoked' ||
                        r.createdAt > at || email(proof.email) !== r.expectedEmail ||
                        proof.identityPolicyId !== r.identityPolicyId || (r.mfaRequired && !proof.mfaSatisfied)) {
                        fail('signup_invitation_unavailable', 403);
                    }
                    const recordScheduled = r.schemaVersion === 2;
                    if (input.termsVersion !== r.termsVersion || !equalHash(input.termsDigest, r.termsDigest) ||
                        inputScheduled !== recordScheduled || (recordScheduled &&
                        (input.scheduleId !== r.scheduleId || !equalHash(input.scheduleDigest, r.scheduleDigest)))) {
                        fail('signup_terms_changed', 409);
                    }
                    if (r.status === 'accepted') {
                        if (r.acceptance.subjectKey !== proof.subjectKey) fail('signup_invitation_unavailable', 403);
                        return { record: structuredClone(r), result: structuredClone(r.acceptance) };
                    }
                    // Expiry blocks new acceptance, not retrieval of an immutable
                    // receipt after fresh, matching identity/terms verification.
                    if (r.expiresAt <= at) fail('signup_invitation_unavailable', 403);
                    const result = { receiptId, invitationId: r.invitationId, subjectKey: proof.subjectKey,
                        tenantId: r.tenantId, organisationId: r.organisationId, termsVersion: r.termsVersion,
                        termsDigest: r.termsDigest, ...(recordScheduled ? { scheduleId: r.scheduleId, scheduleDigest: r.scheduleDigest } : {}),
                        acceptedAt: at, status: 'pending_admission', dashboardAccess: false };
                    const next = { ...structuredClone(r), status: 'accepted', revision: r.revision + 1, acceptance: result };
                    validateRecord(next);
                    return { record: next, result: structuredClone(result) };
                });
            } catch (error) {
                if (error instanceof SignupError) throw error;
                fail('signup_store_unavailable', 503);
            }
        }
    });
}

module.exports = { SignupError, MAX_PROOF_AGE, createInvitation, createInvitationAcceptance, tokenDigest,
    validateAcceptanceReceipt, validateInvitationRecord };
