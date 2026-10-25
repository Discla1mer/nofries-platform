'use strict';

const { createHash, timingSafeEqual } = require('node:crypto');
const { BrowserAuthError } = require('../browserAuth');
const { fields, copy, freeze, uuid, digest, revision } = require('../appLifecycle/dashboardRuntimeRecords');
const { canonicalDigest } = require('../appLifecycle/dashboardOnboardingDomain');
const { tokenDigest } = require('./invitationAcceptance');
const COOKIE = '__Host-nofries-signup';
const fail = () => { throw new BrowserAuthError(401, 'browser_auth_customer_required'); };
const hash = value => createHash('sha256').update(value).digest('hex');
const subjectHash = subject => hash(`nofries:customer-subject:v1\0${subject}`);
const proofKey = (subject, invitationDigest) => `customer-email-proofs/${hash(`${subject}\0${invitationDigest}`)}.json`;
const termsOfferKey = (tenantId, organisationId) => `customer-term-offers/${hash(`nofries:customer-terms-offer:v1\0${tenantId}\0${organisationId}`)}.json`;
const DEFAULT_RECORD_MAX_BYTES = 32768;
const SCHEDULE_TEXT_MAX_BYTES = 32768;
const SCHEDULE_ARCHIVE_MAX_BYTES = 262144;
function scheduleArchiveKey(scheduleId, sha) {
    if (typeof scheduleId !== 'string' || !scheduleId || scheduleId.length > 180 || /[\x00-\x1f\x7f]/.test(scheduleId)) fail();
    digest(sha);
    return `customer-schedules/${hash(`nofries:customer-schedule:v1\0${scheduleId}\0${sha}`)}.json`;
}

function opaqueCookie(header, name) {
    if (typeof header !== 'string' || header.length > 4096) fail();
    const values = header.split(';').map(s => s.trim()).filter(s => s.startsWith(`${name}=`));
    if (!values.length) return null;
    if (values.length !== 1) fail();
    const value = values[0].slice(name.length + 1);
    if (!/^[A-Za-z0-9_-]{43}$/.test(value) || Buffer.from(value, 'base64url').toString('base64url') !== value) fail();
    return value;
}
function termsOffer(raw, reference, now) {
    const record = freeze(fields(copy(raw, 16384), ['schemaVersion', 'status', 'tenantId', 'organisationId', 'scheduleId',
        'scheduleDigest', 'termsVersion', 'termsDigest', 'effectiveAt', 'expiresAt']));
    if (record.schemaVersion !== 1 || record.status !== 'active' ||
        record.tenantId !== reference.tenantId || record.organisationId !== reference.organisationId ||
        record.termsVersion !== reference.termsVersion ||
        record.termsDigest !== reference.termsDigest || record.scheduleId !== reference.scheduleId ||
        record.scheduleDigest !== reference.scheduleDigest || !Number.isSafeInteger(record.effectiveAt) ||
        !Number.isSafeInteger(record.expiresAt) || record.effectiveAt > now || record.expiresAt <= now) fail();
    digest(record.termsDigest); digest(record.scheduleDigest);
    for (const key of ['tenantId', 'organisationId', 'scheduleId', 'termsVersion']) {
        if (typeof record[key] !== 'string' || !record[key] || record[key].length > 180 || /[\x00-\x1f\x7f]/.test(record[key])) fail();
    }
    return record;
}

function scheduleArchive(raw, reference) {
    const record = freeze(fields(copy(raw, SCHEDULE_ARCHIVE_MAX_BYTES), ['schemaVersion', 'scheduleId', 'scheduleText', 'scheduleDigest']));
    if (record.schemaVersion !== 1 || record.scheduleId !== reference.scheduleId ||
        record.scheduleDigest !== reference.scheduleDigest || typeof record.scheduleText !== 'string' ||
        !record.scheduleText || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(record.scheduleText) ||
        Buffer.byteLength(record.scheduleText, 'utf8') > SCHEDULE_TEXT_MAX_BYTES ||
        hash(record.scheduleText) !== record.scheduleDigest) fail();
    digest(record.scheduleDigest);
    if (typeof record.scheduleId !== 'string' || !record.scheduleId || record.scheduleId.length > 180 ||
        /[\x00-\x1f\x7f]/.test(record.scheduleId)) fail();
    return record;
}

function authority(raw, subject, now) {
    const source = copy(raw, 16384);
    const scheduled = Reflect.ownKeys(source).some(key => ['scheduleId', 'scheduleDigest'].includes(key));
    const record = freeze(fields(source, ['schemaVersion', 'subjectKey', 'email', 'revision', 'status',
        'invitationDigest', 'invitationId', 'tenantId', 'organisationId', 'termsVersion', 'termsDigest',
        ...(scheduled ? ['scheduleId', 'scheduleDigest'] : []), 'bindingId', 'expiresAt',
        ...(Object.hasOwn(source, 'accountType') ? ['accountType'] : [])]));
    if (Object.hasOwn(record, 'accountType') && !['company', 'consultant'].includes(record.accountType)) fail();
    const parts = subject.split(':'); if (parts.length !== 2) fail(); parts.forEach(uuid);
    if (record.schemaVersion !== (scheduled ? 2 : 1) || record.subjectKey !== subject || record.status !== 'active' ||
        !Number.isSafeInteger(record.expiresAt) || record.expiresAt <= now ||
        typeof record.email !== 'string' || record.email !== record.email.trim().toLowerCase() ||
        record.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(record.email)) fail();
    revision(record.revision); digest(record.invitationDigest); digest(record.termsDigest);
    if (scheduled) digest(record.scheduleDigest);
    if (record.bindingId !== null) uuid(record.bindingId);
    for (const key of ['invitationId', 'tenantId', 'organisationId', 'termsVersion', ...(scheduled ? ['scheduleId'] : [])]) {
        if (typeof record[key] !== 'string' || !record[key] || record[key].length > 180 || /[\x00-\x1f\x7f]/.test(record[key])) fail();
    }
    return record;
}

// These containers have different write authorities: the app cannot grant or
// change an admission. Its email proof is evidence only, never membership.
function createCustomerRecords({ authorityContainer, sessionContainer }) {
    async function read(container, key, maxBytes = DEFAULT_RECORD_MAX_BYTES) {
        try {
            const response = await container.getBlockBlobClient(key).download(0, maxBytes + 1, { abortSignal: AbortSignal.timeout(5000) });
            if (!Number.isSafeInteger(response.contentLength) || response.contentLength > maxBytes) throw new Error();
            const chunks = []; let length = 0;
            try {
                for await (const chunk of response.readableStreamBody) {
                    length += chunk.length; if (length > maxBytes) throw new Error(); chunks.push(chunk);
                }
            } finally { response.readableStreamBody?.destroy(); }
            return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
        } catch (error) {
            if (error?.statusCode === 404 && error?.code === 'BlobNotFound') return null;
            throw new BrowserAuthError(503, 'browser_auth_customer_store_unavailable');
        }
    }
    return Object.freeze({
        readSubject: subject => read(authorityContainer, `customer-subjects/${subjectHash(subject)}.json`),
        readSignupRecovery: subject => read(authorityContainer, `customer-signup-recoveries/${subjectHash(subject)}.json`),
        readTerms: sha => { digest(sha); return read(authorityContainer, `customer-terms/${sha}.json`); },
        readTermsOffer: (tenantId, organisationId) => read(authorityContainer, termsOfferKey(tenantId, organisationId)),
        readSchedule: (scheduleId, sha) => read(authorityContainer, scheduleArchiveKey(scheduleId, sha), SCHEDULE_ARCHIVE_MAX_BYTES),
        readEmailProof: (subject, sha) => read(sessionContainer, proofKey(subject, sha)),
        async createEmailProof(subject, sha, email, method = 'entra-invitation-mailbox-capability') {
            if (!['entra-invitation-mailbox-capability', 'nofries-email-code-and-entra-mfa'].includes(method)) fail();
            const record = { schemaVersion: 1, subjectKey: subject, invitationDigest: sha, email, method };
            try {
                await sessionContainer.getBlockBlobClient(proofKey(subject, sha)).uploadData(Buffer.from(JSON.stringify(record)), {
                    conditions: { ifNoneMatch: '*' }, abortSignal: AbortSignal.timeout(5000),
                    blobHTTPHeaders: { blobContentType: 'application/json', blobCacheControl: 'no-store' }
                });
            } catch (error) {
                if (![409, 412].includes(error?.statusCode)) throw new BrowserAuthError(503, 'browser_auth_customer_store_unavailable');
                const existing = await read(sessionContainer, proofKey(subject, sha));
                fields(existing, ['schemaVersion', 'subjectKey', 'invitationDigest', 'email', 'method']);
                if (existing.schemaVersion !== 1 || existing.subjectKey !== subject || existing.invitationDigest !== sha || existing.email !== email ||
                    !['entra-invitation-mailbox-capability', 'nofries-email-code-and-entra-mfa'].includes(existing.method)) fail();
            }
        }
    });
}

function createCustomerIdentityPolicy({ records, verifyMfaPolicy, authenticationContext, verifiedEmail, now = Date.now }) {
    if (!/^c(?:[1-9]|[1-9][0-9])$/.test(authenticationContext) || typeof verifyMfaPolicy !== 'function') throw new Error('customer_policy_invalid');
    async function current(subject) {
        const record = await records.readSubject(subject); if (record === null) fail();
        return authority(record, subject, now());
    }
    async function mfaPolicyCurrent() {
        try { return await verifyMfaPolicy(authenticationContext) === true; }
        catch (_) { throw new BrowserAuthError(503, 'browser_auth_customer_mfa_unavailable'); }
    }
    function assurance(value, identity, record) {
        fields(value, ['subjectKey', 'email', 'invitationDigest', 'revision', 'verifiedAt', 'expiresAt', 'authenticationContext', 'authoritySha256']);
        if (value.subjectKey !== identity.subjectKey || value.email !== record.email || value.invitationDigest !== record.invitationDigest ||
            value.revision !== record.revision || value.authoritySha256 !== canonicalDigest(record) || value.authenticationContext !== authenticationContext ||
            !Number.isSafeInteger(value.verifiedAt) || !Number.isSafeInteger(value.expiresAt) ||
            value.verifiedAt > now() || value.expiresAt <= now() || value.expiresAt <= value.verifiedAt) fail();
    }
    const policy = Object.freeze({
        async begin(input) {
            const invitationToken = opaqueCookie(input.cookieHeader || '', COOKIE);
            const emailProof = verifiedEmail ? await verifiedEmail.begin(input.cookieHeader || '') : null;
            return { claims: JSON.stringify({ id_token: { acrs: { essential: true, value: authenticationContext } } }),
                ...(emailProof ? { loginHint: emailProof.email } : {}),
                context: { invitationDigest: emailProof || invitationToken === null ? null : tokenDigest(invitationToken),
                    ...(emailProof ? { verifiedEmail: emailProof } : {}) } };
        },
        async verify({ identity, claims, context }) {
            fields(context, ['invitationDigest', ...(Object.hasOwn(context || {}, 'verifiedEmail') ? ['verifiedEmail'] : [])]);
            const record = await current(identity.subjectKey), invitationDigest = record.invitationDigest;
            // Only claims from the validated, nonce-bound MSAL code exchange
            // reach here. ACRS alone is insufficient: verify its enforced policy.
            if (!Array.isArray(claims.acrs) || !claims.acrs.includes(authenticationContext) ||
                !Number.isSafeInteger(claims.exp) || claims.exp * 1000 <= now() ||
                !await mfaPolicyCurrent()) throw new BrowserAuthError(401, 'browser_auth_customer_mfa_required');
            if (Object.hasOwn(context, 'verifiedEmail')) {
                if (!verifiedEmail || context.invitationDigest !== null) fail();
                await verifiedEmail.verify(context.verifiedEmail, record.email);
                await records.createEmailProof(identity.subjectKey, invitationDigest, record.email, 'nofries-email-code-and-entra-mfa');
            } else if (context.invitationDigest !== null) {
                const actual = digest(context.invitationDigest);
                if (!timingSafeEqual(Buffer.from(actual), Buffer.from(invitationDigest))) fail();
                await records.createEmailProof(identity.subjectKey, invitationDigest, record.email);
            } else {
                const proof = await records.readEmailProof(identity.subjectKey, invitationDigest);
                if (proof === null) throw new BrowserAuthError(401, 'browser_auth_email_verification_required');
                fields(proof, ['schemaVersion', 'subjectKey', 'invitationDigest', 'email', 'method']);
                if (proof.schemaVersion !== 1 || proof.subjectKey !== identity.subjectKey || proof.invitationDigest !== invitationDigest || proof.email !== record.email ||
                    !['entra-invitation-mailbox-capability', 'nofries-email-code-and-entra-mfa'].includes(proof.method)) fail();
            }
            const result = freeze({ subjectKey: identity.subjectKey, email: record.email, invitationDigest,
                revision: record.revision, verifiedAt: now(), expiresAt: Math.min(claims.exp * 1000, record.expiresAt), authenticationContext, authoritySha256: canonicalDigest(record) });
            await policy.recheck({ identity, assurance: result });
            return result;
        },
        async recheck({ identity, assurance: value }) {
            assurance(value, identity, await current(identity.subjectKey));
            // Re-read after provider I/O; a policy removal cannot leave an
            // already-issued customer session asserting MFA indefinitely.
            if (!await mfaPolicyCurrent()) throw new BrowserAuthError(401, 'browser_auth_customer_mfa_required');
            assurance(value, identity, await current(identity.subjectKey));
        }
    });
    return policy;
}
module.exports = { COOKIE, opaqueCookie, authority, termsOffer, scheduleArchive, scheduleArchiveKey, termsOfferKey, subjectHash, createCustomerRecords, createCustomerIdentityPolicy };
