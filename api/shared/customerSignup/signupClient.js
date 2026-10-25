'use strict';

// Dormant browser transport contract. These endpoints are NOT installed here.
// The host must supply native fetch and a reviewed account-provider adapter.
function createSignupClient({ fetch: fetchImpl, createAccount, customerTransport } = {}) {
    if (typeof fetchImpl !== 'function' || typeof createAccount !== 'function') {
        throw new TypeError('signup_client_dependencies_required');
    }
    if (customerTransport !== undefined && customerTransport !== 'external') throw new TypeError('signup_transport_invalid');
    const route = customerTransport === 'external' ? '/api/external-customer-signup' : '/api/customer-signup';
    let csrf = null, busy = false, disposed = false, cancel = null;
    // Only metadata observed on this operation's original response is trusted.
    // Neither provider errors nor customer state objects can supply these fields.
    const diagnostics = new WeakMap(), operations = new WeakMap();
    const failure = metadata => {
        const error = new Error('signup_unavailable');
        if (metadata) diagnostics.set(error, metadata);
        return error;
    };
    function responseDiagnostic(headers) {
        try {
            const reference = headers.get('X-NoFries-Support-Reference');
            const sha = headers.get('X-NoFries-Release-Sha');
            const runId = headers.get('X-NoFries-Release-Run-Id');
            const signupStage = headers.get('X-NoFries-Signup-Stage');
            const signupReason = headers.get('X-NoFries-Signup-Reason');
            const metadata = {};
            if (typeof reference === 'string' && reference.length === 19 && /^NF-[A-F0-9]{16}$/.test(reference)) metadata.supportReference = reference;
            if (typeof sha === 'string' && sha.length === 40 && /^[a-f0-9]{40}$/.test(sha) &&
                typeof runId === 'string' && runId.length <= 20 && /^[1-9][0-9]{0,19}$/.test(runId)) {
                metadata.apiReleaseSha = sha; metadata.apiReleaseRunId = runId;
            }
            if (metadata.supportReference && typeof signupStage === 'string' && typeof signupReason === 'string' &&
                (['workspace_preparation', 'workspace_details', 'signup_status'].includes(signupStage)
                    ? ['step_unconfirmed', 'setup_information_unavailable'].includes(signupReason)
                    : signupStage === 'terms_review' && ['step_unconfirmed', 'terms_unavailable'].includes(signupReason))) {
                metadata.signupStage = signupStage; metadata.signupReason = signupReason;
            }
            return Object.keys(metadata).length ? Object.freeze(metadata) : undefined;
        } catch (_) { return undefined; }
    }
    const exactKeys = (value, keys) => !!value && typeof value === 'object' && !Array.isArray(value) &&
        Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
    const validAccount = value => value && ['company', 'consultant'].includes(value.accountType) &&
        typeof value.organisationName === 'string' && value.organisationName.length > 0 && value.organisationName.length <= 120 &&
        value.organisationName === value.organisationName.trim().normalize('NFC') && !/[\u0000-\u001f\u007f-\u009f<>]/u.test(value.organisationName);
    async function bounded(action, signal, timeoutMs = 15000) {
        if (disposed || busy || signal?.aborted) throw failure();
        busy = true;
        const controller = new AbortController();
        const operation = { active: true, metadata: undefined };
        operations.set(controller.signal, operation);
        let timer, rejectCancelled;
        const cancellation = new Promise((_, reject) => { rejectCancelled = reject; });
        const abort = () => { controller.abort(); rejectCancelled(failure(operation.metadata)); };
        cancel = abort;
        signal?.addEventListener('abort', abort, { once: true });
        const resetDeadline = ms => {
            if (controller.signal.aborted || disposed) throw failure();
            clearTimeout(timer);
            timer = setTimeout(abort, ms);
        };
        resetDeadline(timeoutMs);
        try {
            return await Promise.race([action(controller.signal, resetDeadline), cancellation]);
        } catch (_) {
            csrf = null;
            throw failure(operation.metadata);
        } finally {
            operation.active = false;
            operations.delete(controller.signal);
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            cancel = null;
            busy = false;
        }
    }
    async function request(path, body, signal) {
        const token = csrf;
        csrf = null;
        if (body && !token) throw failure();
        const response = await fetchImpl(path, {
            method: body ? 'POST' : 'GET', mode: 'same-origin', credentials: 'same-origin',
            redirect: 'error', cache: 'no-store', referrerPolicy: 'same-origin', signal,
            headers: { Accept: 'application/json', ...(body ? {
                'Content-Type': 'application/json', 'X-CSRF-Token': token
            } : {}) }, ...(body ? { body: JSON.stringify(body) } : {})
        });
        if (signal.aborted || disposed || response.redirected) throw failure();
        const operation = operations.get(signal);
        const metadata = responseDiagnostic(response.headers);
        if (operation?.active) {
            // Snapshot original headers once. A public pair on HTTP200 is only
            // usable after the body actually declares an unavailable state.
            const { signupStage, signupReason, ...base } = metadata || {};
            operation.metadata = response.status >= 400 ? metadata
                : Object.keys(base).length ? Object.freeze(base) : undefined;
        }
        const signInRequired = customerTransport === 'external' && response.status === 401;
        if (signal.aborted || disposed || response.status !== 200 && !signInRequired || response.redirected ||
            !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) throw failure();
        const reader = response.body?.getReader();
        if (!reader) throw failure();
        const cancelReader = () => { try { Promise.resolve(reader.cancel()).catch(() => {}); } catch (_) { /* best effort */ } };
        signal.addEventListener('abort', cancelReader, { once: true });
        const decoder = new TextDecoder('utf-8', { fatal: true });
        let text = '', size = 0, chunks = 0;
        try {
            for (;;) {
                const { value, done } = await reader.read();
                if (signal.aborted || disposed) throw failure();
                if (done) break;
                size += value.byteLength;
                if (size > 131072 || ++chunks > 4096) throw failure();
                text += decoder.decode(value, { stream: true });
            }
            text += decoder.decode();
        } finally {
            // Cancellation must not hold the caller hostage to a stalled stream.
            signal.removeEventListener('abort', cancelReader);
            cancelReader();
        }
        const payload = JSON.parse(text);
        if (signInRequired) {
            if (!exactKeys(payload, ['error', 'code']) || payload.error !== 'Signup is unavailable' ||
                payload.code !== 'signup_signin_required') throw failure();
            return Object.freeze({ status: 'signin_required' });
        }
        const state = payload?.state;
        if (!state || !['create_account', 'setup_details', 'resume_setup', 'continue_authentication', 'terms', 'resume_acceptance', 'pending_preparation', 'pending_admission', 'continue_to_dashboard', 'setup_read_only', 'unavailable'].includes(state.status)) throw failure();
        if (['setup_details', 'resume_setup', 'continue_authentication'].includes(state.status) && customerTransport !== 'external') throw failure();
        if (state.status === 'setup_read_only' && (!exactKeys(payload, ['state']) ||
            !exactKeys(state, ['status']))) throw failure();
        const setup = ['setup_details', 'resume_setup'].includes(state.status);
        const reserved = state.status === 'setup_details' && Object.hasOwn(state, 'reservation');
        if (setup && (!exactKeys(payload, ['state', 'csrfToken']) || !exactKeys(state,
            ['status', 'email', ...(reserved ? ['reservation'] : []), ...(state.status === 'resume_setup' ? ['accountType', 'organisationName'] : [])]) ||
            typeof state.email !== 'string' || state.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+(?![\s\S])/.test(state.email))) throw failure();
        if (reserved && (!exactKeys(state.reservation, ['accountType', 'organisationName']) || !validAccount(state.reservation))) throw failure();
        if (state.status === 'resume_setup' && !validAccount(state)) throw failure();
        const typedDestination = state.status === 'continue_to_dashboard' && Object.hasOwn(state, 'accountType');
        if (Object.hasOwn(state, 'accountType') && (!typedDestination && state.status !== 'resume_setup' || !['company', 'consultant'].includes(state.accountType))) throw failure();
        const scheduled = state.status === 'terms' && Object.hasOwn(state, 'scheduleId');
        if (state.status === 'terms' && (typeof state.termsText !== 'string' ||
            !state.termsText.length || state.termsText.length > 32768 ||
            typeof state.termsVersion !== 'string' || !state.termsVersion.length || state.termsVersion.length > 180 ||
            typeof state.termsDigest !== 'string' || !/^[a-f0-9]{64}$/.test(state.termsDigest) || (scheduled &&
                (typeof state.scheduleId !== 'string' || !state.scheduleId.length || state.scheduleId.length > 180 ||
                    typeof state.scheduleText !== 'string' || !state.scheduleText.length || state.scheduleText.length > 32768 ||
                    typeof state.scheduleDigest !== 'string' || !/^[a-f0-9]{64}$/.test(state.scheduleDigest))) ||
            typeof payload.csrfToken !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(payload.csrfToken))) throw failure();
        if (signal.aborted || disposed) throw failure();
        if (['resume_acceptance', 'setup_details', 'resume_setup'].includes(state.status) && (typeof payload.csrfToken !== 'string' ||
            !/^[A-Za-z0-9_-]{43,128}$/.test(payload.csrfToken))) throw failure();
        csrf = ['terms', 'resume_acceptance', 'setup_details', 'resume_setup'].includes(state.status) ? payload.csrfToken : null;
        const result = Object.freeze(state.status === 'terms' ? { status: 'terms', termsText: state.termsText,
            termsVersion: state.termsVersion, termsDigest: state.termsDigest,
            ...(scheduled ? { scheduleId: state.scheduleId, scheduleText: state.scheduleText,
                scheduleDigest: state.scheduleDigest } : {}) } : { status: state.status, ...(setup ? { email: state.email } : {}),
                ...(reserved ? { reservation: Object.freeze({ accountType: state.reservation.accountType,
                    organisationName: state.reservation.organisationName }) } : {}),
                ...(state.status === 'resume_setup' ? { accountType: state.accountType, organisationName: state.organisationName } : {}),
                ...(typedDestination ? { accountType: state.accountType } : {}) });
        if (state.status === 'unavailable' && operation?.active && metadata) {
            operation.metadata = metadata;
            diagnostics.set(result, metadata);
        }
        return result;
    }
    return Object.freeze({
        diagnostic: value => diagnostics.get(value),
        load: ({ signal } = {}) => bounded(s => request(route + '/state', null, s), signal),
        createAccount: ({ signal } = {}) => bounded(async (s, resetDeadline) => {
            csrf = null;
            // Adapter handles the real provider. Only a fresh server read may
            // assert verified identity/terms; ignore all provider return values.
            await createAccount({ signal: s });
            if (s.aborted || disposed) throw failure();
            // Human account creation/MFA has ten minutes; network refresh does
            // not inherit that allowance. Keep one busy/cancellation lifecycle.
            resetDeadline(15000);
            return request(route + '/state', null, s);
        }, signal, 600000),
        acceptTerms: (terms, { signal } = {}) => bounded(s => {
            const scheduled = !!terms && Object.hasOwn(terms, 'scheduleId');
            const keys = scheduled ? 'accepted,scheduleDigest,scheduleId,termsDigest,termsVersion' : 'accepted,termsDigest,termsVersion';
            if (!terms || Object.keys(terms).sort().join(',') !== keys ||
                terms.accepted !== true || typeof terms.termsVersion !== 'string' ||
                !terms.termsVersion.length || terms.termsVersion.length > 180 ||
                typeof terms.termsDigest !== 'string' || !/^[a-f0-9]{64}$/.test(terms.termsDigest) || (scheduled &&
                (typeof terms.scheduleId !== 'string' || !terms.scheduleId.length || terms.scheduleId.length > 180 ||
                    typeof terms.scheduleDigest !== 'string' || !/^[a-f0-9]{64}$/.test(terms.scheduleDigest)))) throw failure();
            return request(route + '/terms', terms, s);
        }, signal),
        completeSetup: (input, { signal } = {}) => bounded(s => {
            if (customerTransport !== 'external') throw failure();
            if (input && Object.hasOwn(input, 'resume') && (!exactKeys(input, ['resume']) || input.resume !== true)) throw failure();
            return request(route + '/setup', input, s);
        }, signal),
        resumeAcceptance: ({ signal } = {}) => bounded(s => request(route + '/terms', { resume: true }, s), signal),
        dispose() { disposed = true; csrf = null; if (cancel) cancel(); }
    });
}

module.exports = { createSignupClient };
