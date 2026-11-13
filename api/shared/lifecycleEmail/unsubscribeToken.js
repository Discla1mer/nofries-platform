'use strict';

// Signed one-click unsubscribe tokens for lifecycle email (#151, slice E6).
//
//   v1.<account_id>.<email_type>.<base64url(tag[32] || sealed subject key)>
//
// tag = HMAC-SHA256(macKey, "v1|account_id|subject_key|email_type"). The subject
// key is sealed with AES-256-CTR under encKey, using the first 16 bytes of the
// tag as the counter block (a deterministic, SIV-style construction), so the
// link never shows the identity-provider subject in clear and the same message
// type always gets the same link. Both keys come from
// NOFRIES_EMAIL_UNSUBSCRIBE_SECRET via HKDF. No expiry: an unsubscribe link has
// to keep working. Without a secret of at least 32 bytes nothing is signed or
// accepted.
const crypto = require('node:crypto');

const VERSION = 'v1';
const EMAIL_TYPES = Object.freeze(['welcome', 'result_summary', 'nudge_unfinished', 'reassess_reminder']);
const MIN_SECRET_BYTES = 32;
const MAX_TOKEN_LENGTH = 256;
const ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Same shape as the dashboard_starter_accounts.subject_key CHECK (0011).
const SUBJECT_KEY = /^[a-f0-9-]{36}:[a-f0-9-]{36}$/;
const SEALED = /^[A-Za-z0-9_-]{140}$/;
const TAG_BYTES = 32;
const SUBJECT_BYTES = 73;

function keysFrom(env = process.env) {
    const secret = Buffer.from(String((env && env.NOFRIES_EMAIL_UNSUBSCRIBE_SECRET) || ''), 'utf8');
    if (secret.length < MIN_SECRET_BYTES) return null;
    const derive = info => Buffer.from(crypto.hkdfSync('sha256', secret, Buffer.alloc(0), info, 32));
    return { mac: derive('nofries-email-unsubscribe-v1-mac'), enc: derive('nofries-email-unsubscribe-v1-enc') };
}

const unsubscribeConfigured = env => keysFrom(env) !== null;

function tagFor(keys, accountId, subjectKey, emailType) {
    return crypto.createHmac('sha256', keys.mac).update(`${VERSION}|${accountId}|${subjectKey}|${emailType}`).digest();
}

function ctr(keys, iv, input) {
    const cipher = crypto.createCipheriv('aes-256-ctr', keys.enc, iv);
    return Buffer.concat([cipher.update(input), cipher.final()]);
}

function createUnsubscribeToken({ accountId, subjectKey, emailType }, env = process.env) {
    const keys = keysFrom(env);
    if (!keys) throw new Error('unsubscribe_secret_unavailable');
    if (!ACCOUNT_ID.test(String(accountId)) || !SUBJECT_KEY.test(String(subjectKey)) || !EMAIL_TYPES.includes(emailType)) {
        throw new Error('unsubscribe_token_input_invalid');
    }
    const tag = tagFor(keys, accountId, subjectKey, emailType);
    const sealed = ctr(keys, tag.subarray(0, 16), Buffer.from(subjectKey, 'ascii'));
    return `${VERSION}.${accountId}.${emailType}.${Buffer.concat([tag, sealed]).toString('base64url')}`;
}

// Returns { accountId, subjectKey, emailType } or null. Never throws and never
// says why a token was refused.
function verifyUnsubscribeToken(token, env = process.env) {
    const keys = keysFrom(env);
    if (!keys || typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH) return null;
    const parts = token.split('.');
    if (parts.length !== 4) return null;
    const [version, accountId, emailType, sealedText] = parts;
    if (version !== VERSION || !ACCOUNT_ID.test(accountId) || !EMAIL_TYPES.includes(emailType) || !SEALED.test(sealedText)) return null;
    const raw = Buffer.from(sealedText, 'base64url');
    if (raw.length !== TAG_BYTES + SUBJECT_BYTES || raw.toString('base64url') !== sealedText) return null;
    const tag = raw.subarray(0, TAG_BYTES);
    const subjectKey = ctr(keys, tag.subarray(0, 16), raw.subarray(TAG_BYTES)).toString('latin1');
    const expected = tagFor(keys, accountId, subjectKey, emailType);
    if (!crypto.timingSafeEqual(tag, expected) || !SUBJECT_KEY.test(subjectKey)) return null;
    return Object.freeze({ accountId, subjectKey, emailType });
}

module.exports = { createUnsubscribeToken, verifyUnsubscribeToken, unsubscribeConfigured, EMAIL_TYPES, MAX_TOKEN_LENGTH, MIN_SECRET_BYTES };
