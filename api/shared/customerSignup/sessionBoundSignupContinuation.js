'use strict';

const { isProxy } = require('node:util').types;
const { validateAcceptanceReceipt } = require('./invitationAcceptance');
const { createPostgresSignupAcceptanceJournal } = require('./postgresSignupAcceptanceJournal');
const { createSignupDiagnostics } = require('./signupDiagnostics');
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const REFERENCE = ['subjectKey', 'tenantId', 'organisationId', 'invitationId',
    'receiptId', 'termsVersion', 'termsDigest', 'status', 'revision'];
const referenceKeys = value => [...REFERENCE.slice(0, 7),
    ...(Object.hasOwn(value, 'scheduleId') ? ['scheduleId', 'scheduleDigest'] : []), ...REFERENCE.slice(7)];
const unavailable = () => Object.freeze({ status: 'unavailable' });

function data(value, required, optional = []) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) throw new Error();
    const prototype = Object.getPrototypeOf(value);
    // Accept plain data from another JS realm, but never class instances.
    if (prototype !== null && Object.getPrototypeOf(prototype) !== null) throw new Error();
    const keys = Reflect.ownKeys(value);
    if (required.some(key => !Object.hasOwn(value, key)) ||
        keys.some(key => typeof key !== 'string' || ![...required, ...optional].includes(key))) throw new Error();
    const result = {};
    for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) throw new Error();
        result[key] = descriptor.value;
    }
    return Object.freeze(result);
}

function session(value, at) {
    const details = data(value, ['identity', 'expiresAt']);
    const identity = data(details.identity, ['provider', 'isAuthenticated', 'tenantId', 'principalId', 'subjectKey'], ['email', 'name']);
    if (identity.provider !== 'entra-bff' || identity.isAuthenticated !== true ||
        typeof identity.tenantId !== 'string' || !UUID.test(identity.tenantId) ||
        typeof identity.principalId !== 'string' || !UUID.test(identity.principalId) ||
        identity.subjectKey !== `${identity.tenantId}:${identity.principalId}`) throw new Error();
    if (typeof details.expiresAt !== 'string') throw new Error();
    const expiry = Date.parse(details.expiresAt);
    if (!Number.isSafeInteger(expiry) ||
        new Date(expiry).toISOString() !== details.expiresAt || expiry <= at) throw new Error();
    return Object.freeze({ subjectKey: identity.subjectKey, expiresAt: expiry });
}

function recoveryReference(value, subjectKey) {
    const scheduled = value && typeof value === 'object' && !isProxy(value) && Object.hasOwn(value, 'scheduleId');
    const keys = ['subjectKey', 'tenantId', 'organisationId', 'invitationId', 'termsVersion', 'termsDigest',
        ...(scheduled ? ['scheduleId', 'scheduleDigest'] : [])];
    const record = data(value, keys);
    if (record.subjectKey !== subjectKey || typeof record.termsDigest !== 'string' ||
        !/^[a-f0-9]{64}$/.test(record.termsDigest) || (scheduled && (typeof record.scheduleDigest !== 'string' ||
            !/^[a-f0-9]{64}$/.test(record.scheduleDigest)))) throw new Error();
    for (const key of ['tenantId', 'organisationId', 'invitationId', 'termsVersion', ...(scheduled ? ['scheduleId'] : [])]) {
        const item = record[key];
        if (typeof item !== 'string' || !item || item.length > 180 || item.trim() !== item ||
            /[\u0000-\u001f\u007f]/.test(item)) throw new Error();
    }
    return record;
}

function registration(value, subjectKey) {
    const keys = referenceKeys(value);
    const record = data(value, keys);
    if (record.subjectKey !== subjectKey || record.status !== 'pending_admission' ||
        !Number.isSafeInteger(record.revision) || record.revision < 0 ||
        typeof record.termsDigest !== 'string' || !/^[a-f0-9]{64}$/.test(record.termsDigest) ||
        (Object.hasOwn(record, 'scheduleId') && (typeof record.scheduleDigest !== 'string' ||
            !/^[a-f0-9]{64}$/.test(record.scheduleDigest)))) throw new Error();
    for (const key of ['tenantId', 'organisationId', 'invitationId', 'receiptId', 'termsVersion',
        ...(Object.hasOwn(record, 'scheduleId') ? ['scheduleId'] : [])]) {
        const item = record[key];
        if (typeof item !== 'string' || !item || item.length > 180 || item.trim() !== item ||
            /[\u0000-\u001f\u007f]/.test(item)) throw new Error();
    }
    return record;
}

/**
 * Read acknowledgement after bootstrap deletion, without treating a receipt as
 * permission. readSessionDetails is the bound, reviewed BFF cookie reader.
 * readRegistration reads CURRENT server-owned scope/revocation/version state
 * by immutable subject, not CRM/email/body/query values or an archived receipt.
 * Ambiguous or absent registration selection must return null, never first().
 * This read-only port does not issue sessions, accept terms or grant membership.
 */
function createSessionBoundSignupContinuation(options) {
    let config;
    try {
        config = data(options, ['readSessionDetails', 'readRegistration', 'database'], ['now', 'readRecoveryReference', 'diagnostics']);
        for (const fn of [config.readSessionDetails, config.readRegistration,
            ...(Object.hasOwn(config, 'readRecoveryReference') ? [config.readRecoveryReference] : []), config.now || Date.now]) {
            if (typeof fn !== 'function' || isProxy(fn)) throw new Error();
        }
        if (Object.hasOwn(config, 'now') && typeof config.now !== 'function') throw new Error();
    } catch (_) { throw new TypeError('signup_continuation_dependencies_required'); }
    const { readSessionDetails, readRegistration, readRecoveryReference, database } = config;
    const now = config.now || Date.now;
    const report = createSignupDiagnostics({ sink: config.diagnostics });
    const journal = createPostgresSignupAcceptanceJournal({ database });
    return Object.freeze(async function loadContinuationState(req) {
        let stage = 'continuation_request';
        const denied = error => {
            report(stage, error, 'signup_continuation_unavailable');
            return unavailable();
        };
        try {
            // Snapshot only the cookie. User-selected identity/scope is ignored.
            if (!req || typeof req !== 'object' || isProxy(req)) return denied();
            const cookie = typeof req.get === 'function' ? req.get('cookie') : req.headers?.cookie;
            if (typeof cookie !== 'string' || !cookie || cookie.length > 4096) return denied();
            let lastAt = -1;
            const clock = () => {
                const at = now();
                if (!Number.isSafeInteger(at) || at < 0 || at < lastAt) {
                    stage = 'continuation_clock';
                    throw new Error();
                }
                lastAt = at; return at;
            };
            stage = 'continuation_clock';
            clock();
            stage = 'continuation_session';
            const initial = session(await readSessionDetails(cookie), clock());
            const selector = Object.freeze({ subjectKey: initial.subjectKey });
            stage = 'continuation_registration';
            const rawBinding = await readRegistration(selector);
            if (!rawBinding && readRecoveryReference) {
                stage = 'continuation_recovery_reference';
                const reference = recoveryReference(await readRecoveryReference(selector), initial.subjectKey);
                if (clock() >= initial.expiresAt) return denied();
                stage = 'continuation_receipt';
                const receipt = validateAcceptanceReceipt(await journal.readForInvitation({
                    tenantId: reference.tenantId, organisationId: reference.organisationId, invitationId: reference.invitationId
                }));
                const keys = Reflect.ownKeys(reference);
                stage = 'continuation_receipt_match';
                if (clock() >= initial.expiresAt || receipt.acceptedAt > lastAt ||
                    keys.some(key => receipt[key] !== reference[key])) return denied();
                stage = 'continuation_session_recheck';
                const current = session(await readSessionDetails(cookie), clock());
                if (current.subjectKey !== initial.subjectKey) return denied();
                stage = 'continuation_reference_recheck';
                const latest = recoveryReference(await readRecoveryReference(selector), initial.subjectKey);
                if (JSON.stringify(latest) !== JSON.stringify(reference) ||
                    clock() >= Math.min(initial.expiresAt, current.expiresAt)) return denied();
                return Object.freeze({ status: 'resume_acceptance' });
            }
            const binding = registration(rawBinding, initial.subjectKey);
            if (clock() >= initial.expiresAt) return denied();
            stage = 'continuation_receipt';
            const receipt = validateAcceptanceReceipt(await journal.readForInvitation({
                tenantId: binding.tenantId, organisationId: binding.organisationId, invitationId: binding.invitationId
            }));
            if (clock() >= initial.expiresAt || receipt.acceptedAt > lastAt) return denied();
            const bindingKeys = ['subjectKey', 'tenantId', 'organisationId', 'invitationId', 'receiptId', 'termsVersion', 'termsDigest',
                ...(Object.hasOwn(binding, 'scheduleId') ? ['scheduleId', 'scheduleDigest'] : [])];
            stage = 'continuation_receipt_match';
            for (const key of bindingKeys) {
                if (receipt[key] !== binding[key]) return denied();
            }
            // Recheck live session and registration after database I/O. A saved
            // receipt cannot undo logout, scope revocation or a terms revision.
            stage = 'continuation_session_recheck';
            const current = session(await readSessionDetails(cookie), clock());
            if (current.subjectKey !== initial.subjectKey) return denied();
            stage = 'continuation_registration_recheck';
            const latest = registration(await readRegistration(selector), initial.subjectKey);
            if (referenceKeys(binding).some(key => latest[key] !== binding[key]) ||
                clock() >= Math.min(initial.expiresAt, current.expiresAt)) return denied();
            return Object.freeze({ status: 'pending_admission' });
        } catch (error) { return denied(error); }
    });
}

/** Bind the actual BFF reader, rather than a browser-supplied identity object. */
function createBrowserSignupContinuation(options) {
    let config, auth, env;
    try {
        config = data(options, ['browserAuthOptions', 'readRegistration', 'database'], ['now']);
        auth = data(config.browserAuthOptions, ['env', 'store']);
        if (!auth.env || typeof auth.env !== 'object' || isProxy(auth.env)) throw new Error();
        const snapshot = {};
        for (const key of ['NOFRIES_REQUIRE_AUTH', 'NOFRIES_BROWSER_AUTH_MODE', 'NOFRIES_ENTRA_TENANT_ID', 'NOFRIES_ALLOWED_SUBJECTS']) {
            const descriptor = Object.getOwnPropertyDescriptor(auth.env, key);
            if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string') throw new Error();
            snapshot[key] = descriptor.value;
        }
        env = Object.freeze(snapshot);
        if (env.NOFRIES_REQUIRE_AUTH.trim().toLowerCase() !== 'true' ||
            env.NOFRIES_BROWSER_AUTH_MODE.trim().toLowerCase() !== 'entra_bff' ||
            !auth.store || isProxy(auth.store)) throw new Error();
    } catch (_) { throw new TypeError('signup_continuation_browser_configuration_invalid'); }
    const { readBrowserSessionDetails } = require('../browserAuth');
    const now = Object.hasOwn(config, 'now') ? config.now : Date.now;
    return createSessionBoundSignupContinuation({
        readSessionDetails: cookie => readBrowserSessionDetails(cookie, { env, store: auth.store, now }),
        readRegistration: config.readRegistration, database: config.database, now
    });
}

module.exports = Object.freeze({ createSessionBoundSignupContinuation, createBrowserSignupContinuation });
