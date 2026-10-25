(function () {
    if (document.body.dataset.page !== 'service-desk') {
        return;
    }

    const BOOTSTRAP_TIMEOUT_MS = 12000;
    const MAX_BOOTSTRAP_ATTEMPTS = 2;
    const heading = document.getElementById('loadingHeading');
    const message = document.getElementById('loadingMessage');
    const status = document.getElementById('loadingStatus');
    const actions = document.getElementById('loadingActions');
    const loadingPanel = document.getElementById('loadingPanel');
    const supportApp = document.getElementById('supportApp');

    startLoader();

    function startLoader() {
        try {
            document.body.dataset.startup = 'loader_active';
            message.textContent = 'Secure page loaded. Checking your Microsoft identity and service-desk access.';
            status.textContent = 'Checking your same-domain session first. Diagnostic stage: session_request; bootstrap_request follows.';
            initialise().catch(function (error) {
                showWorkspaceUnavailable(error, 'loader_unhandled_error');
            });
        } catch (error) {
            showWorkspaceUnavailable(error, 'loader_initialisation_failed');
        }
    }

    async function initialise() {
        for (let attempt = 1; attempt <= MAX_BOOTSTRAP_ATTEMPTS; attempt += 1) {
            try {
                const session = await requestJsonWithTimeout('/api/auth/session', {
                    credentials: 'same-origin',
                    headers: { Accept: 'application/json' }
                }, BOOTSTRAP_TIMEOUT_MS);

                if (session.response.status === 401) {
                    redirectToSignIn();
                    return;
                }
                if (!session.response.ok) {
                    throw createBootstrapError(session.response.status, session.body);
                }
                validateSession(session.body);

                const result = await requestJsonWithTimeout('/api/service-desk/bootstrap', {
                    credentials: 'same-origin',
                    headers: { Accept: 'application/json' }
                }, BOOTSTRAP_TIMEOUT_MS);

                if (result.response.status === 401) {
                    redirectToSignIn();
                    return;
                }
                if (!result.response.ok) {
                    throw createBootstrapError(result.response.status, result.body);
                }

                const bootstrap = validateBootstrap(result.body);
                heading.textContent = 'Opening the service desk';
                message.textContent = 'Access verified. Loading active customers, verified computers and tickets.';
                status.textContent = 'Protected service-desk data loaded. Starting now.';
                await loadAndStartApplication(bootstrap);
                return;
            } catch (error) {
                if (isAccessError(error)) {
                    showAccessDenied(error);
                    return;
                }
                if (attempt < MAX_BOOTSTRAP_ATTEMPTS && isRecoverable(error)) {
                    heading.textContent = 'Starting the service desk';
                    message.textContent = 'The secure service is taking longer than usual. Retrying once.';
                    status.textContent = 'No ticket or customer action is being performed while the service starts.';
                    continue;
                }
                showWorkspaceUnavailable(error, error && error.code || 'support_startup_failed');
                return;
            }
        }
    }

    function validateSession(value) {
        if (!value || typeof value !== 'object' || value.authenticated !== true) {
            const error = new Error('The protected session response was incomplete.');
            error.code = 'invalid_session_payload';
            error.recoverable = true;
            throw error;
        }
        return value;
    }

    function requestJsonWithTimeout(url, options, timeoutMs) {
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const requestOptions = controller ? Object.assign({}, options, { signal: controller.signal }) : options;

        return new Promise(function (resolve, reject) {
            let settled = false;
            const timer = window.setTimeout(function () {
                if (controller) {
                    try { controller.abort(); } catch (error) { /* best effort only */ }
                }
                const timeoutError = new Error('The protected service desk did not respond in time.');
                timeoutError.code = 'support_timeout';
                timeoutError.recoverable = true;
                finish(reject, timeoutError);
            }, timeoutMs);

            Promise.resolve()
                .then(function () { return fetch(url, requestOptions); })
                .then(function (response) {
                    if (!response.ok) {
                        return response.json().catch(function () { return {}; }).then(function (body) {
                            return { response, body };
                        });
                    }
                    return response.json().then(function (body) {
                        return { response, body };
                    }, function () {
                        const responseError = new Error('The protected service desk returned an invalid response.');
                        responseError.code = 'invalid_bootstrap_response';
                        responseError.recoverable = true;
                        throw responseError;
                    });
                })
                .then(function (result) {
                    finish(resolve, result);
                }, function (error) {
                    if (error && typeof error === 'object' && error.recoverable == null) {
                        error.recoverable = true;
                    }
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
            !value.tenant || typeof value.tenant !== 'object' || !value.tenant.name ||
            !value.user || typeof value.user !== 'object' ||
            (!value.user.email && !value.user.principalId) || !value.user.role ||
            !value.runtime || value.runtime.mode !== 'production' ||
            value.runtime.provider !== 'autotask' || value.runtime.sourceOfTruth !== true ||
            !Array.isArray(value.customers) || !Array.isArray(value.tickets)) {
            const error = new Error('The protected service-desk response was incomplete.');
            error.code = 'production_service_desk_required';
            error.recoverable = true;
            throw error;
        }
        return Object.assign({}, value, {
            revision: Number.isFinite(Number(value.revision)) ? Number(value.revision) : 0
        });
    }

    function createBootstrapError(httpStatus, payload) {
        const error = new Error(payload && payload.error || defaultBootstrapMessage(httpStatus));
        error.httpStatus = httpStatus;
        error.code = payload && payload.code || '';
        error.recoverable = httpStatus >= 500 || httpStatus === 408 || httpStatus === 429;
        return error;
    }

    function defaultBootstrapMessage(httpStatus) {
        if (httpStatus === 403) {
            return 'This Microsoft identity has not been approved for the No Fries service desk.';
        }
        if (httpStatus >= 500) {
            return 'The protected service-desk service is temporarily unavailable.';
        }
        return 'The protected service desk could not be opened.';
    }

    function isAccessError(error) {
        return Boolean(error && (
            error.httpStatus === 403 ||
            error.code === 'tenant_access_required' ||
            error.code === 'capability_required'
        ));
    }

    function isRecoverable(error) {
        return Boolean(error && (error.recoverable || error.code === 'support_timeout'));
    }

    function redirectToSignIn() {
        window.location.assign('/api/auth/login?returnTo=%2Fsupport');
    }

    function startApplication(bootstrap) {
        if (!window.NoFriesSupport || typeof window.NoFriesSupport.start !== 'function') {
            const error = new Error('The service-desk application did not expose its startup function.');
            error.code = 'support_initializer_missing';
            throw error;
        }
        try {
            window.NoFriesSupport.start(bootstrap);
        } catch (error) {
            const startupError = new Error('The service-desk application encountered a startup error.');
            startupError.code = 'support_start_failed';
            startupError.cause = error;
            throw startupError;
        }
        if (document.body.classList.contains('support-loading')) {
            const error = new Error('The service-desk application returned without opening the workspace.');
            error.code = 'support_start_incomplete';
            throw error;
        }
    }

    async function loadAndStartApplication(bootstrap) {
        await loadProtectedApplication();
        startApplication(bootstrap);
    }

    function loadProtectedApplication() {
        return new Promise(function (resolve, reject) {
            const script = document.createElement('script');
            script.id = 'protectedSupportApplication';
            script.src = '/api/service-desk/app.js';
            script.async = true;
            script.onload = resolve;
            script.onerror = function () {
                const error = new Error('The protected service-desk application could not be loaded.');
                error.code = 'support_script_load_failed';
                reject(error);
            };
            document.head.append(script);
        });
    }

    function showAccessDenied(error) {
        restoreLoadingPanel();
        document.body.classList.remove('support-loading');
        document.body.classList.add('access-denied');
        heading.textContent = 'Service-desk access has not been approved';
        message.textContent = 'Sign in with an approved Microsoft identity or ask the No Fries administrator to add you.';
        status.textContent = `${error.message || 'Access denied.'} Diagnostic: ${error.code || 'support_access_denied'}.`;
        revealActions();
    }

    function showWorkspaceUnavailable(error, fallbackCode) {
        restoreLoadingPanel();
        document.body.classList.remove('support-loading');
        document.body.classList.add('support-unavailable');
        heading.textContent = 'Service desk could not load';
        message.textContent = 'Your sign-in may be valid, but the protected service did not become ready.';
        status.textContent = `${error && error.message || 'The service desk is temporarily unavailable.'} Diagnostic: ${error && error.code || fallbackCode}.`;
        revealActions();
    }

    function revealActions() {
        if (actions) actions.hidden = false;
    }

    function restoreLoadingPanel() {
        if (loadingPanel) loadingPanel.hidden = false;
        if (supportApp) supportApp.hidden = true;
    }
}());
