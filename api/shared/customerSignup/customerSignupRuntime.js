'use strict';

const { assertSameOriginForMutation } = require('../securityHeaders');
const { requestBodySize } = require('../requestLimits');
const { isProxy } = require('node:util').types;

const STATES = new Set(['create_account', 'setup_details', 'resume_setup', 'setup_read_only', 'continue_authentication', 'terms', 'resume_acceptance', 'pending_preparation', 'pending_admission', 'continue_to_dashboard', 'unavailable']);
const TOKEN = /^[A-Za-z0-9_-]{43,128}$/;
const DIGEST = /^[a-f0-9]{64}$/;

class CustomerSignupRuntimeError extends Error {
    constructor(statusCode, code) {
        super(code);
        this.statusCode = statusCode;
        this.code = code;
    }
}

const fail = (status, code) => { throw new CustomerSignupRuntimeError(status, code); };
function exact(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value) ||
        ![null, Object.prototype].includes(Object.getPrototypeOf(value))) fail(400, 'signup_request_invalid');
    const own = Reflect.ownKeys(value);
    if (own.length !== keys.length || own.some(key => typeof key !== 'string' || !keys.includes(key))) {
        fail(400, 'signup_request_invalid');
    }
    const snapshot = {};
    for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
            fail(400, 'signup_request_invalid');
        }
        snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
}

function state(value) {
    if (!value || typeof value !== 'object' || isProxy(value)) fail(503, 'signup_unavailable');
    const statusDescriptor = Object.getOwnPropertyDescriptor(value, 'status');
    if (!statusDescriptor || !Object.hasOwn(statusDescriptor, 'value')) fail(503, 'signup_unavailable');
    const statusValue = statusDescriptor.value;
    let snapshot;
    const scheduled = statusValue === 'terms' && Reflect.ownKeys(value).some(key => ['scheduleId', 'scheduleText', 'scheduleDigest'].includes(key));
    const typedDestination = statusValue === 'continue_to_dashboard' && Object.hasOwn(value, 'accountType');
    const setup = ['setup_details', 'resume_setup'].includes(statusValue);
    const reserved = statusValue === 'setup_details' && Object.hasOwn(value, 'reservation');
    let reservation;
    try { snapshot = exact(value, ['status', ...(setup ? ['email'] : []), ...(reserved ? ['reservation'] : []),
        ...(statusValue === 'resume_setup' ? ['accountType', 'organisationName'] : []), ...(typedDestination ? ['accountType'] : []), ...(statusValue === 'terms' ? ['termsText', 'termsVersion', 'termsDigest',
        ...(scheduled ? ['scheduleId', 'scheduleText', 'scheduleDigest'] : [])] : [])]); }
    catch (_) { fail(503, 'signup_unavailable'); }
    if (typedDestination && !['company', 'consultant'].includes(snapshot.accountType)) fail(503, 'signup_unavailable');
    if (setup && (typeof snapshot.email !== 'string' || snapshot.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+(?![\s\S])/.test(snapshot.email))) fail(503, 'signup_unavailable');
    if (reserved) {
        try { reservation = exact(snapshot.reservation, ['accountType', 'organisationName']); }
        catch (_) { fail(503, 'signup_unavailable'); }
    }
    const account = statusValue === 'resume_setup' ? snapshot : reservation;
    if (account && (!['company', 'consultant'].includes(account.accountType) || typeof account.organisationName !== 'string' ||
        !account.organisationName || account.organisationName.length > 120 ||
        account.organisationName !== account.organisationName.trim().normalize('NFC') ||
        /[\u0000-\u001f\u007f-\u009f<>]/u.test(account.organisationName))) fail(503, 'signup_unavailable');
    if (!STATES.has(snapshot.status)) fail(503, 'signup_unavailable');
    if (snapshot.status === 'terms' && (typeof snapshot.termsText !== 'string' || !snapshot.termsText || snapshot.termsText.length > 32768 ||
        typeof snapshot.termsVersion !== 'string' || !snapshot.termsVersion || snapshot.termsVersion.length > 180 ||
        typeof snapshot.termsDigest !== 'string' || !DIGEST.test(snapshot.termsDigest) || (scheduled &&
        (typeof snapshot.scheduleId !== 'string' || !snapshot.scheduleId || snapshot.scheduleId.length > 180 ||
            typeof snapshot.scheduleText !== 'string' || !snapshot.scheduleText || snapshot.scheduleText.length > 32768 ||
            typeof snapshot.scheduleDigest !== 'string' || !DIGEST.test(snapshot.scheduleDigest))))) fail(503, 'signup_unavailable');
    return Object.freeze(snapshot.status === 'terms'
        ? { status: 'terms', termsText: snapshot.termsText, termsVersion: snapshot.termsVersion, termsDigest: snapshot.termsDigest,
            ...(scheduled ? { scheduleId: snapshot.scheduleId, scheduleText: snapshot.scheduleText,
                scheduleDigest: snapshot.scheduleDigest } : {}) }
        : { status: snapshot.status, ...(setup ? { email: snapshot.email } : {}), ...(reserved ? { reservation } : {}),
            ...(snapshot.status === 'resume_setup' ? { accountType: snapshot.accountType, organisationName: snapshot.organisationName } : {}),
            ...(typedDestination ? { accountType: snapshot.accountType } : {}) });
}

function header(req, name) {
    return typeof req?.get === 'function' ? String(req.get(name) || '').trim() : String(req?.headers?.[name.toLowerCase()] || '').trim();
}

function createCustomerSignupRuntime(options = {}) {
    const hasResume = !isProxy(options) && !!options && typeof options === 'object' && Object.hasOwn(options, 'resumeAcceptance');
    const hasSetup = !isProxy(options) && !!options && typeof options === 'object' && Object.hasOwn(options, 'completeSetup');
    exact(options, ['env', 'loadState', 'acceptTerms', ...(hasResume ? ['resumeAcceptance'] : []), ...(hasSetup ? ['completeSetup'] : []), 'issueCsrfToken', 'validateCsrfToken']);
    for (const key of ['loadState', 'acceptTerms', ...(hasResume ? ['resumeAcceptance'] : []), ...(hasSetup ? ['completeSetup'] : []), 'issueCsrfToken', 'validateCsrfToken']) {
        if (typeof options[key] !== 'function' || isProxy(options[key])) throw new TypeError('signup_runtime_dependencies_required');
    }
    return Object.freeze({
        async handle(req, route) {
            try {
                if (requestBodySize(req) > 16 * 1024) fail(413, 'request_too_large');
                const method = String(req?.method || 'GET').toUpperCase();
                if (route === 'state' && method === 'GET') {
                    const current = state(await options.loadState(req));
                    const body = { state: current };
                    if (['terms', 'resume_acceptance', 'setup_details', 'resume_setup'].includes(current.status)) {
                        const csrfToken = await options.issueCsrfToken(req);
                        if (typeof csrfToken !== 'string' || !TOKEN.test(csrfToken)) fail(503, 'signup_unavailable');
                        body.csrfToken = csrfToken;
                    }
                    return { status: 200, body };
                }
                if (route === 'setup' && hasSetup && method === 'POST') {
                    assertSameOriginForMutation(req, options.env || process.env);
                    const token = header(req, 'x-csrf-token');
                    if (!TOKEN.test(token) || await options.validateCsrfToken(req, token) !== true) fail(403, 'signup_csrf_invalid');
                    const resuming = req.body && typeof req.body === 'object' && !isProxy(req.body) && Object.hasOwn(req.body, 'resume');
                    if (resuming) {
                        const input = exact(req.body, ['resume']);
                        if (input.resume !== true) fail(400, 'signup_request_invalid');
                        return { status: 200, body: { state: state(await options.completeSetup({ req, input })) } };
                    }
                    const input = exact(req.body, ['accountType', 'organisationName', 'details']);
                    if (!['company', 'consultant'].includes(input.accountType) || typeof input.organisationName !== 'string' ||
                        !input.organisationName.trim() || input.organisationName.length > 120) fail(400, 'signup_request_invalid');
                    exact(input.details, ['name', 'role', 'address', 'registrationId', 'authorityConfirmed']);
                    return { status: 200, body: { state: state(await options.completeSetup({ req, input })) } };
                }
                if (route === 'terms' && method === 'POST') {
                    assertSameOriginForMutation(req, options.env || process.env);
                    const csrfToken = header(req, 'x-csrf-token');
                    if (!TOKEN.test(csrfToken) || (await options.validateCsrfToken(req, csrfToken)) !== true) fail(403, 'signup_csrf_invalid');
                    const bodyKeys = req.body && typeof req.body === 'object' && !isProxy(req.body) ? Reflect.ownKeys(req.body) : [];
                    if (hasResume && bodyKeys.includes('resume')) {
                        const input = exact(req.body, ['resume']);
                        if (input.resume !== true) fail(400, 'signup_request_invalid');
                        const next = state(await options.resumeAcceptance({ req }));
                        return { status: 200, body: { state: next } };
                    }
                    const scheduled = bodyKeys.some(key => ['scheduleId', 'scheduleDigest'].includes(key));
                    const input = exact(req.body, ['accepted', 'termsDigest', 'termsVersion',
                        ...(scheduled ? ['scheduleId', 'scheduleDigest'] : [])]);
                    if (input.accepted !== true || typeof input.termsVersion !== 'string' || !input.termsVersion ||
                        input.termsVersion.length > 180 || typeof input.termsDigest !== 'string' || !DIGEST.test(input.termsDigest) ||
                        (scheduled && (typeof input.scheduleId !== 'string' || !input.scheduleId || input.scheduleId.length > 180 ||
                            typeof input.scheduleDigest !== 'string' || !DIGEST.test(input.scheduleDigest)))) {
                        fail(400, 'signup_terms_required');
                    }
                    const next = state(await options.acceptTerms({ req, input }));
                    return { status: 200, body: { state: next } };
                }
                return { status: 404, body: { error: 'Signup route not found', code: 'route_not_found' } };
            } catch (error) {
                if (error instanceof CustomerSignupRuntimeError) throw error;
                if (error?.statusCode === 403 && error?.details?.code === 'same_origin_required') throw error;
                fail(503, 'signup_unavailable');
            }
        }
    });
}

function customerSignupErrorResponse(error) {
    if (error instanceof CustomerSignupRuntimeError && error.statusCode === 401 && error.code === 'signup_signin_required') {
        return { status: 401, headers: { 'Set-Cookie': '__Host-nofries-external-customer=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT' },
            body: { error: 'Signup is unavailable', code: 'signup_signin_required' } };
    }
    const status = Number.isInteger(error?.statusCode) ? error.statusCode : 503;
    const code = typeof error?.code === 'string' && /^[a-z][a-z0-9_]{2,63}$/.test(error.code) ? error.code : 'signup_unavailable';
    return { status, body: { error: 'Signup is unavailable', code } };
}

module.exports = Object.freeze({ CustomerSignupRuntimeError, createCustomerSignupRuntime, customerSignupErrorResponse });
