(function () {
    if (document.body.dataset.page !== 'sales-workspace') {
        return;
    }

    const BOOTSTRAP_TIMEOUT_MS = 12000;
    const MAX_BOOTSTRAP_ATTEMPTS = 2;
    const heading = document.getElementById('loadingHeading');
    const message = document.getElementById('loadingMessage');
    const status = document.getElementById('loadingStatus');
    startLoader();

    function startLoader() {
        try {
            document.body.dataset.startup = 'loader_active';
            message.textContent = 'Secure page loaded. Checking your Microsoft identity and workspace access.';
            status.textContent = 'Checking your same-domain session first. Diagnostic stage: session_request; bootstrap_request follows.';
            initialise().catch(function (error) {
                showLoadError(
                    'The workspace loader stopped unexpectedly.',
                    error && error.code || 'loader_unhandled_error'
                );
            });
        } catch (error) {
            document.body.classList.remove('app-loading');
            document.body.classList.add('workspace-unavailable');
            if (heading) heading.textContent = 'Workspace could not load';
            if (message) message.textContent = 'The workspace loader could not initialise.';
            if (status) status.textContent = 'Diagnostic: loader_initialisation_failed.';
        }
    }

    async function initialise() {
        for (let attempt = 1; attempt <= MAX_BOOTSTRAP_ATTEMPTS; attempt += 1) {
            try {
                const sessionResult = await requestJsonWithTimeout('/api/auth/session', {
                    credentials: 'same-origin',
                    headers: { Accept: 'application/json' }
                }, BOOTSTRAP_TIMEOUT_MS);
                if (sessionResult.response.status === 401) {
                    redirectToSignIn();
                    return;
                }
                if (!sessionResult.response.ok) {
                    throw createBootstrapError(sessionResult.response.status, sessionResult.body);
                }
                validateSession(sessionResult.body);

                const result = await requestJsonWithTimeout('/api/sales/bootstrap', {
                    credentials: 'same-origin',
                    headers: { Accept: 'application/json' }
                }, BOOTSTRAP_TIMEOUT_MS);
                const response = result.response;
                const bootstrap = result.body;

                if (response.status === 401) {
                    redirectToSignIn();
                    return;
                }
                if (!response.ok) {
                    throw createBootstrapError(response.status, bootstrap);
                }

                window.NoFriesBootstrap = validateBootstrap(bootstrap);
                heading.textContent = 'Opening Sales';
                message.textContent = 'Access verified. Opening customer discovery, service plans and proposals now.';
                status.textContent = 'Protected application loaded. Starting now.';

                loadAndStartApplication().catch(function (error) {
                    showLoadError(
                        'The protected application could not start.',
                        error && error.code || 'app_load_failed'
                    );
                });
                return;
            } catch (error) {
                if (isAccessError(error)) {
                    showAccessDenied(error);
                    return;
                }

                if (attempt < MAX_BOOTSTRAP_ATTEMPTS && isRecoverable(error)) {
                    heading.textContent = 'Starting the protected workspace';
                    message.textContent = 'The secure workspace is taking longer than usual to respond. Retrying once.';
                    status.textContent = 'No customer action is being performed while the workspace starts.';
                    continue;
                }

                showWorkspaceUnavailable(error);
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

    async function readJsonResponse(response) {
        try {
            return await response.json();
        } catch (error) {
            const responseError = new Error('The protected workspace returned an invalid response.');
            responseError.code = 'invalid_bootstrap_response';
            responseError.recoverable = true;
            throw responseError;
        }
    }

    function validateBootstrap(value) {
        if (!value || typeof value !== 'object' ||
            !value.tenant || typeof value.tenant !== 'object' || !value.tenant.name ||
            !value.user || typeof value.user !== 'object' ||
            (!value.user.email && !value.user.principalId) || !value.user.role) {
            const error = new Error('The protected workspace response was incomplete.');
            error.code = 'invalid_bootstrap_payload';
            error.recoverable = true;
            throw error;
        }

        return Object.assign({}, value, {
            revision: Number.isFinite(Number(value.revision)) ? Number(value.revision) : 0,
            counts: Object.assign({
                customers: 0,
                activeAssessments: 0,
                completedAssessments: 0,
                proposals: 0,
                publishedServices: 0
            }, value.counts || {}),
            catalogue: Object.assign({
                publishedVersionId: null,
                publishedLabel: '',
                publishedAt: '',
                serviceCount: 0,
                draftCount: 0
            }, value.catalogue || {}),
            customers: Array.isArray(value.customers) ? value.customers : [],
            assessments: Array.isArray(value.assessments) ? value.assessments : [],
            proposals: Array.isArray(value.proposals) ? value.proposals : [],
            integration: Object.assign({
                configured: false,
                endpointConfigured: false,
                authentication: 'not_configured',
                mode: 'one_way_user_initiated',
                productionWriteEnabled: false
            }, value.integration || {})
        });
    }

    function requestJsonWithTimeout(url, options, timeoutMs) {
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const requestOptions = controller
            ? Object.assign({}, options, { signal: controller.signal })
            : options;

        return new Promise(function (resolve, reject) {
            let settled = false;
            const timer = setTimeout(function () {
                if (controller) {
                    try { controller.abort(); } catch (error) { /* best effort only */ }
                }
                const timeoutError = new Error('The protected workspace did not respond in time.');
                timeoutError.code = 'workspace_timeout';
                timeoutError.recoverable = true;
                finish(reject, timeoutError);
            }, timeoutMs);

            Promise.resolve()
                .then(function () { return fetch(url, requestOptions); })
                .then(function (response) {
                    return readJsonResponse(response).then(function (body) {
                        return { response: response, body: body };
                    });
                })
                .then(function (result) {
                    finish(resolve, result);
                }, function (error) {
                    if (error && typeof error === 'object') {
                        error.recoverable = true;
                    }
                    finish(reject, error);
                });

            function finish(callback, value) {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timer);
                callback(value);
            }
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
            return 'This Microsoft identity has not been approved for the No Fries workspace.';
        }
        if (httpStatus >= 500) {
            return 'The protected workspace service is temporarily unavailable.';
        }
        return 'The protected workspace could not be opened.';
    }

    function isAccessError(error) {
        return Boolean(error && (error.httpStatus === 403 || error.code === 'tenant_access_required' || error.code === 'capability_required'));
    }

    function isRecoverable(error) {
        return Boolean(error && (error.recoverable || error.code === 'workspace_timeout'));
    }

    function redirectToSignIn() {
        window.location.assign('/api/auth/login?returnTo=%2Fscoping');
    }

    function showAccessDenied(error) {
        document.body.classList.remove('app-loading');
        document.body.classList.add('access-denied');
        heading.textContent = 'Access has not been approved';
        message.textContent = 'Sign in with an approved Microsoft identity, or ask the No Fries administrator to add you.';
        status.innerHTML = escapeHtml(error.message || 'Access denied.') +
            ' <a href="/api/auth/login?returnTo=%2Fscoping">Sign in again</a> or ' +
            '<a href="mailto:hello@nofries.nz">contact support</a>.';
    }

    function showWorkspaceUnavailable(error) {
        document.body.classList.remove('app-loading');
        document.body.classList.add('workspace-unavailable');
        heading.textContent = 'Workspace could not load';
        message.textContent = 'Your sign-in may be valid, but the protected workspace did not become ready.';
        status.innerHTML = escapeHtml(error && error.message || 'The protected workspace is temporarily unavailable.') +
            diagnosticText(error && error.code) +
            ' <a href="/scoping">Retry</a> or ' +
            '<a href="/api/auth/login?returnTo=%2Fscoping">sign in again</a>.';
    }

    async function loadAndStartApplication() {
        await loadProtectedApplication();

        if (!window.NoFriesSales || typeof window.NoFriesSales.start !== 'function') {
            const initializerError = new Error('The protected application did not expose its startup function.');
            initializerError.code = 'app_initializer_missing';
            throw initializerError;
        }

        try {
            window.NoFriesSales.start(window.NoFriesBootstrap);
        } catch (error) {
            const startupError = new Error('The protected application encountered a startup error.');
            startupError.code = 'app_start_failed';
            startupError.cause = error;
            throw startupError;
        }

        if (document.body.classList.contains && document.body.classList.contains('app-loading')) {
            const error = new Error('The protected application returned without opening the workspace.');
            error.code = 'app_start_incomplete';
            throw error;
        }
    }

    function loadProtectedApplication() {
        return new Promise(function (resolve, reject) {
            const script = document.createElement('script');
            script.id = 'protectedSalesApplication';
            script.src = '/api/sales/app.js';
            script.async = true;
            script.onload = resolve;
            script.onerror = function () {
                const error = new Error('The protected application could not be loaded.');
                error.code = 'app_script_load_failed';
                reject(error);
            };
            document.head.append(script);
        });
    }

    function showLoadError(text, code) {
        document.body.classList.remove('app-loading');
        document.body.classList.add('workspace-unavailable');
        heading.textContent = 'Workspace could not load';
        message.textContent = text;
        status.innerHTML = diagnosticText(code) +
            ' <a href="/scoping">Retry</a> or ' +
            '<a href="/api/auth/login?returnTo=%2Fscoping">sign in again</a>.';
    }

    function diagnosticText(code) {
        return code ? ' Diagnostic: ' + escapeHtml(code) + '.' : '';
    }

    function escapeHtml(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }
}());
