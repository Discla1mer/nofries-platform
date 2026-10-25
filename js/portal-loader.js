(function () {
    'use strict';

    if (document.body.dataset.page !== 'customer-portal') return;

    const TIMEOUT_MS = 12000;
    const MAX_ATTEMPTS = 2;
    const elements = {
        panel: document.getElementById('loadingPanel'),
        heading: document.getElementById('loadingHeading'),
        message: document.getElementById('loadingMessage'),
        status: document.getElementById('loadingStatus'),
        actions: document.getElementById('loadingActions'),
        watchdog: document.getElementById('startupWatchdog'),
        app: document.getElementById('portalApp')
    };
    let watchdogTimer = window.setTimeout(revealWatchdog, TIMEOUT_MS);

    document.body.dataset.startup = 'loader_active';
    initialise().catch(function (error) {
        showUnavailable(error, 'customer_portal_loader_failed');
    });

    async function initialise() {
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
            try {
                const session = await requestJson('/api/auth/session');
                if (session.response.status === 401) {
                    window.location.assign(portalLoginUrl());
                    return;
                }
                if (!session.response.ok || !session.body || session.body.authenticated !== true) {
                    throw responseError(session, 'customer_portal_session_invalid');
                }

                elements.status.textContent = 'Identity confirmed. Checking your customer membership and live service desk.';
                const result = await requestJson('/api/customer-portal/bootstrap');
                if (result.response.status === 401) {
                    window.location.assign(portalLoginUrl());
                    return;
                }
                if (!result.response.ok) throw responseError(result, 'customer_portal_bootstrap_failed');
                const bootstrap = validateBootstrap(result.body);
                await loadProtectedApplication();
                if (!window.NoFriesPortal || typeof window.NoFriesPortal.start !== 'function') {
                    throw codedError('The customer portal application did not start.', 'customer_portal_initializer_missing', true);
                }
                window.NoFriesPortal.start(bootstrap);
                clearWatchdog();
                return;
            } catch (error) {
                if (error && error.httpStatus === 403) {
                    showDenied(error);
                    return;
                }
                if (attempt < MAX_ATTEMPTS && error && error.recoverable) {
                    elements.heading.textContent = 'Opening your customer portal';
                    elements.message.textContent = 'The protected service is taking longer than usual. Retrying once.';
                    continue;
                }
                showUnavailable(error, error && error.code || 'customer_portal_startup_failed');
                return;
            }
        }
    }

    function portalLoginUrl() {
        // Preserve only a bounded module fragment, never object IDs or query input.
        // The post-auth dashboard registry still decides whether it is entitled.
        const fragment = String(window.location.hash || '');
        const returnTo = /^#[a-z][a-z-]{0,63}$/.test(fragment) ? '/portal' + fragment : '/portal';
        return '/api/auth/login?returnTo=' + encodeURIComponent(returnTo);
    }

    function requestJson(url) {
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        return new Promise(function (resolve, reject) {
            let settled = false;
            const timer = window.setTimeout(function () {
                if (controller) controller.abort();
                finish(reject, codedError('The customer portal did not respond in time.', 'customer_portal_timeout', true));
            }, TIMEOUT_MS);
            fetch(url, {
                credentials: 'same-origin',
                headers: { Accept: 'application/json' },
                signal: controller && controller.signal
            }).then(function (response) {
                return response.json().catch(function () { return {}; }).then(function (body) {
                    return { response: response, body: body };
                });
            }).then(function (value) {
                finish(resolve, value);
            }, function (error) {
                if (error && typeof error === 'object') error.recoverable = true;
                finish(reject, error);
            });

            function finish(callback, value) {
                if (settled) return;
                settled = true;
                window.clearTimeout(timer);
                callback(value);
            }
        });
    }

    function validateBootstrap(value) {
        if (!value || typeof value !== 'object' ||
            !value.customer || typeof value.customer !== 'object' || !value.customer.id || !value.customer.displayName ||
            !value.user || typeof value.user !== 'object' ||
            !Array.isArray(value.tickets) || !value.proof || typeof value.proof !== 'object' ||
            !value.proof.current || !Array.isArray(value.proof.history)) {
            throw codedError('The customer portal response was incomplete.', 'customer_portal_bootstrap_invalid', true);
        }
        validateProofBinding(value.customer, value.proof);
        return value;
    }

    function validateProofBinding(customer, proof) {
        const proofCustomerId = String(customer.proofCustomerId || '');
        if (proof.status === 'unavailable') {
            if (proofCustomerId || proof.current.state !== 'unavailable' || proof.current.report || proof.history.length) {
                throw codedError('The unavailable Proof response was inconsistent.', 'customer_portal_proof_binding_invalid', true);
            }
            return;
        }
        if (!proofCustomerId || proof.proofCustomerId !== proofCustomerId) {
            throw codedError('The Proof customer binding was missing.', 'customer_portal_proof_binding_invalid', true);
        }
        const reports = proof.history.slice();
        if (proof.current.state === 'issued') reports.push(proof.current.report);
        if (reports.some(function (report) {
            return !report || report.customerId !== proofCustomerId ||
                !report.frozenSnapshot || report.frozenSnapshot.customerId !== proofCustomerId ||
                !report.publicationEnvelope || report.publicationEnvelope.customerId !== proofCustomerId;
        })) {
            throw codedError('A Proof report belonged to another customer.', 'customer_portal_proof_binding_invalid', true);
        }
    }

    function loadProtectedApplication() {
        return new Promise(function (resolve, reject) {
            const script = document.createElement('script');
            script.id = 'protectedCustomerPortalApplication';
            script.src = '/api/customer-portal/app.js';
            script.async = true;
            script.onload = resolve;
            script.onerror = function () {
                reject(codedError('The protected customer portal could not be loaded.', 'customer_portal_script_failed', true));
            };
            document.head.append(script);
        });
    }

    function responseError(result, fallbackCode) {
        const body = result.body || {};
        const error = codedError(body.error || 'The customer portal could not be opened.', body.code || fallbackCode, result.response.status >= 500 || result.response.status === 429);
        error.httpStatus = result.response.status;
        return error;
    }

    function codedError(message, code, recoverable) {
        const error = new Error(message);
        error.code = code;
        error.recoverable = recoverable === true;
        return error;
    }

    function showDenied(error) {
        clearWatchdog();
        document.body.classList.remove('portal-loading');
        elements.heading.textContent = 'Customer portal access has not been approved';
        elements.message.textContent = 'Sign in with the Microsoft identity registered for your customer account.';
        elements.status.textContent = `${error.message} Diagnostic: ${error.code || 'customer_portal_access_required'}.`;
        elements.actions.hidden = false;
    }

    function showUnavailable(error, fallbackCode) {
        clearWatchdog();
        document.body.classList.remove('portal-loading');
        elements.heading.textContent = 'Customer portal could not load';
        elements.message.textContent = 'Your sign-in may be valid, but the protected service is not ready.';
        elements.status.textContent = `${error && error.message || 'Please try again.'} Diagnostic: ${error && error.code || fallbackCode}.`;
        elements.actions.hidden = false;
    }

    function revealWatchdog() {
        watchdogTimer = null;
        elements.watchdog.hidden = false;
        elements.watchdog.setAttribute('aria-hidden', 'false');
    }

    function clearWatchdog() {
        if (watchdogTimer != null) window.clearTimeout(watchdogTimer);
        watchdogTimer = null;
        elements.watchdog.hidden = true;
        elements.watchdog.setAttribute('aria-hidden', 'true');
    }
}());
