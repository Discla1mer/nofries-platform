(function () {
    if (document.body.dataset.page !== 'operator') {
        return;
    }

    const LOGIN_URL = '/api/auth/login?returnTo=%2Foperator';
    const SESSION_TIMEOUT_MS = 12000;
    const loadingStatus = document.getElementById('loadingStatus');
    const adminNavigation = document.getElementById('dashboardAdminNavigation');
    const CAPABILITY_TIMEOUT_MS = 5000;
    let adminSequence = 0;
    let adminRequest = null;
    let staffSessionVerified = false;
    let pageActive = true;

    if (adminNavigation) {
        adminNavigation.hidden = true;
        window.addEventListener('pagehide', function () {
            pageActive = false;
            cancelAdminDiscovery();
        });
        window.addEventListener('pageshow', function (event) {
            pageActive = true;
            if (event.persisted) discoverAdminNavigation();
        });
        window.addEventListener('focus', discoverAdminNavigation);
    }

    verifySessionAndLoad().catch(function (error) {
        showUnavailable(error && error.message || 'The protected workspace could not be opened.');
    });

    async function verifySessionAndLoad() {
        setStatus('Checking your secure No Fries session.');
        const result = await requestSession();
        if (result.response.status === 401) {
            redirectToSignIn();
            return;
        }
        if (!result.response.ok) {
            throw new Error(result.body && result.body.error || 'Session verification is temporarily unavailable.');
        }
        if (!result.body || result.body.authenticated !== true) {
            redirectToSignIn();
            return;
        }
        staffSessionVerified = true;
        discoverAdminNavigation();
        setStatus('Access verified. Loading work that needs attention.');
        await loadProtectedApplication();
    }

    function cancelAdminDiscovery() {
        adminSequence += 1;
        if (adminNavigation) adminNavigation.hidden = true;
        if (!adminRequest) return;
        window.clearTimeout(adminRequest.timer);
        if (adminRequest.controller) adminRequest.controller.abort();
        adminRequest = null;
    }

    function discoverAdminNavigation() {
        cancelAdminDiscovery();
        if (!adminNavigation || !staffSessionVerified || !pageActive) return;
        const sequence = adminSequence;
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const current = function () { return pageActive && sequence === adminSequence; };
        const timer = window.setTimeout(function () {
            if (current()) cancelAdminDiscovery();
        }, CAPABILITY_TIMEOUT_MS);
        adminRequest = { controller: controller, timer: timer };
        Promise.resolve().then(function () {
            if (!current()) return null;
            return fetch('/api/dashboard-admin/entry-capabilities', {
                credentials: 'same-origin', cache: 'no-store', redirect: 'error',
                headers: { Accept: 'application/json' }, signal: controller && controller.signal
            });
        }).then(async function (response) {
            if (!current() || !response || response.status !== 200 || response.redirected ||
                ['opaque', 'opaqueredirect'].includes(response.type) || !response.headers ||
                !/^application\/json(?:\s*;|\s*$)/i.test(response.headers.get('content-type') || '')) return;
            const value = await response.json();
            // This permission opens only the empty staff entry. The entry must
            // separately check the native gate and current data capabilities.
            if (!current() || !value || Array.isArray(value) || Object.keys(value).length !== 1 || value.entry !== true) return;
            adminNavigation.hidden = false;
        }).catch(function () {
            // Discovery is optional. Missing or revoked access keeps navigation hidden.
        }).finally(function () {
            if (!current()) return;
            window.clearTimeout(timer);
            adminRequest = null;
        });
    }

    function requestSession() {
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const timer = window.setTimeout(function () {
            if (controller) controller.abort();
        }, SESSION_TIMEOUT_MS);
        return fetch('/api/auth/session', {
            credentials: 'same-origin',
            cache: 'no-store',
            headers: { Accept: 'application/json' },
            signal: controller && controller.signal
        }).then(function (response) {
            return response.json().catch(function () { return {}; }).then(function (body) {
                return { response, body };
            });
        }).finally(function () {
            window.clearTimeout(timer);
        });
    }

    function loadProtectedApplication() {
        return new Promise(function (resolve, reject) {
            const script = document.createElement('script');
            script.id = 'protectedOperatorApplication';
            script.src = '/api/lifecycle/app.js';
            script.async = true;
            script.onload = resolve;
            script.onerror = function () {
                reject(new Error('The protected application could not be loaded. Please sign in again.'));
            };
            document.head.append(script);
        });
    }

    function redirectToSignIn() {
        window.location.replace(LOGIN_URL);
    }

    function setStatus(message) {
        if (loadingStatus) loadingStatus.textContent = message;
    }

    function showUnavailable(message) {
        document.body.classList.remove('operator-loading');
        setStatus(message);
        if (!loadingStatus) return;
        loadingStatus.append(' ');
        const signIn = document.createElement('a');
        signIn.href = LOGIN_URL;
        signIn.textContent = 'Sign in again';
        loadingStatus.append(signIn, '.');
    }
}());
