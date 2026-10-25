'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const { randomBytes } = require('node:crypto');
const { isProxy, isPromise } = require('node:util').types;
const { getReleaseIdentity } = require('../releaseIdentity');

// This scope contains only generated public metadata, never the request,
// identity, cookies or provider response. It is installed by the signup HTTP
// adapter explicitly; domain operations outside that adapter stay uncorrelated.
const scopes = new AsyncLocalStorage();
const REFERENCE = /^NF-[A-F0-9]{16}$/;
const OWNED_HEADERS = new Set(['x-nofries-support-reference', 'x-nofries-release-sha', 'x-nofries-release-run-id',
    'x-nofries-signup-stage', 'x-nofries-signup-reason']);
const absent = Symbol('absent');

// Deliberately smaller than the existing server-only diagnostic vocabulary.
// Never publish authentication, account-existence, conflict or SQL details.
function publicDiagnostic(stage, code) {
    let signupStage;
    if (['organisation_preparation', 'setup_claim'].includes(stage)) signupStage = 'workspace_preparation';
    else if (['setup_retained_read', 'setup_save'].includes(stage)) signupStage = 'workspace_details';
    else if (stage === 'signup_state') signupStage = 'signup_status';
    else if (stage === 'terms_offer') signupStage = 'terms_review';
    if (!signupStage) return null;
    let signupReason;
    if (code === 'signup_state_unavailable') signupReason = 'step_unconfirmed';
    else if (signupStage === 'terms_review' && code === 'signup_terms_unavailable') signupReason = 'terms_unavailable';
    else if (signupStage !== 'terms_review' && ['signup_store_unavailable', 'starter_store_unavailable',
        'starter_details_store_unavailable', 'signup_acceptance_journal_unavailable'].includes(code)) {
        signupReason = 'setup_information_unavailable';
    }
    return signupReason ? Object.freeze({ signupStage, signupReason }) : null;
}

function plain(value) {
    return !!value && typeof value === 'object' && !isProxy(value) &&
        [null, Object.prototype].includes(Object.getPrototypeOf(value));
}
function own(value, key) {
    if (!plain(value)) return absent;
    const field = Object.getOwnPropertyDescriptor(value, key);
    return field && Object.hasOwn(field, 'value') ? field.value : absent;
}
function descriptors(value) {
    if (!plain(value)) return null;
    const fields = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(fields).some(key => typeof key !== 'string' || !Object.hasOwn(fields[key], 'value'))) return null;
    return fields;
}
function validReference(value) {
    return typeof value === 'string' && value.length === 19 && REFERENCE.test(value);
}
function ignorePromise(value) {
    // Optional metadata sources are synchronous. Drain only an ordinary native
    // promise's rejection without reading an untrusted then/catch accessor or
    // awaiting it. Non-ordinary values are simply unusable metadata.
    if (value && !isProxy(value) && isPromise(value) && Object.getPrototypeOf(value) === Promise.prototype &&
        !Object.hasOwn(value, 'constructor')) Promise.prototype.then.call(value, () => {}, () => {});
}
function readOptional(reader) {
    try {
        if (typeof reader !== 'function' || isProxy(reader)) return absent;
        const value = reader();
        ignorePromise(value);
        return value;
    } catch (_) { return absent; }
}
function dependency(options, name, fallback) {
    const value = own(options, name);
    if (value !== absent) return value;
    return plain(options) && !Object.hasOwn(options, name) ? fallback : null;
}
function releasePair(value) {
    const releaseSha = own(value, 'releaseSha'), runId = own(value, 'runId');
    if (own(value, 'schemaVersion') !== 2 || typeof releaseSha !== 'string' || releaseSha.length !== 40 ||
        !/^[a-f0-9]{40}$/.test(releaseSha) || typeof runId !== 'string' || runId.length > 20 ||
        !/^[1-9][0-9]{0,19}$/.test(runId)) return null;
    return Object.freeze({ releaseSha, runId });
}
function failed(result) {
    const status = own(result, 'status');
    return Number.isInteger(status) && (status >= 400 || status === 200 &&
        own(own(own(result, 'body'), 'state'), 'status') === 'unavailable');
}
function decorate(result, scope, release) {
    const fields = descriptors(result);
    if (!fields) return result;
    const originalHeaders = fields.headers?.value;
    const headers = originalHeaders === undefined ? {} : descriptors(originalHeaders);
    if (!headers) return result;
    let changed = false;
    const retained = {};
    for (const [name, field] of Object.entries(headers)) {
        if (OWNED_HEADERS.has(name.toLowerCase())) changed = true;
        else Object.defineProperty(retained, name, field);
    }
    if (failed(result)) {
        if (scope.emitted && validReference(scope.reference)) {
            retained['X-NoFries-Support-Reference'] = scope.reference;
            if (scope.publicDiagnostic) {
                retained['X-NoFries-Signup-Stage'] = scope.publicDiagnostic.signupStage;
                retained['X-NoFries-Signup-Reason'] = scope.publicDiagnostic.signupReason;
            }
            changed = true;
        }
        if (release) {
            retained['X-NoFries-Release-Sha'] = release.releaseSha;
            retained['X-NoFries-Release-Run-Id'] = release.runId;
            changed = true;
        }
    }
    if (!changed) return result;
    fields.headers = { value: retained, enumerable: true, writable: true, configurable: true };
    return Object.create(Object.getPrototypeOf(result), fields);
}

function withSignupSupportContext(action, options = {}) {
    if (typeof action !== 'function' || isProxy(action)) throw new TypeError('signup_support_action_required');
    const candidate = readOptional(dependency(options, 'newReference', () =>
        'NF-' + randomBytes(8).toString('hex').toUpperCase()));
    const release = releasePair(readOptional(dependency(options, 'readReleaseIdentity', getReleaseIdentity)));
    const scope = { active: true, reference: validReference(candidate) ? candidate : '', emitted: false };
    return scopes.run(scope, () => {
        let result;
        try { result = action(); }
        catch (error) { scope.active = false; throw error; }
        const finish = value => {
            scope.active = false;
            // Instrumentation must preserve the exact application result even
            // if its internal adapter unexpectedly returns an unsafe object.
            try { return decorate(value, scope, release); }
            catch (_) { return value; }
        };
        // The HTTP adapter supplies an ordinary native async action. Do not
        // inspect/assimilate an arbitrary thenable or proxy to instrument it.
        if (result && !isProxy(result) && isPromise(result) && Object.getPrototypeOf(result) === Promise.prototype &&
            !Object.hasOwn(result, 'constructor')) {
            return Promise.prototype.then.call(result, finish, error => { scope.active = false; throw error; });
        }
        return finish(result);
    });
}

function annotateSignupDiagnostic(event) {
    try {
        const scope = scopes.getStore();
        if (!scope?.active || !validReference(scope.reference)) return event;
        const fields = descriptors(event);
        if (!fields || Reflect.ownKeys(fields).sort().join(',') !== 'code,stage,timestamp' ||
            !Object.isFrozen(event) || ['timestamp', 'code', 'stage'].some(key => fields[key].enumerable !== true) ||
            typeof fields.timestamp.value !== 'string' || fields.timestamp.value.length !== 24 ||
            !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(fields.timestamp.value) ||
            ['code', 'stage'].some(key => typeof fields[key].value !== 'string' ||
                !/^[a-z][a-z0-9_]{2,63}$/.test(fields[key].value))) return event;
        // The caller is the existing closed-vocabulary builder. Snapshot before
        // the sink's asynchronous work; delivery remains best effort.
        const annotated = Object.freeze({ timestamp: fields.timestamp.value, code: fields.code.value,
            stage: fields.stage.value, supportReference: scope.reference });
        // Keep the first observation even when it has no public-safe projection;
        // a later generic wrapper must not replace it with a different step.
        if (!scope.emitted) scope.publicDiagnostic = publicDiagnostic(fields.stage.value, fields.code.value);
        scope.emitted = true;
        return annotated;
    } catch (_) { return event; }
}

module.exports = Object.freeze({ withSignupSupportContext, annotateSignupDiagnostic });
