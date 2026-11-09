(function () {
    if (document.body.dataset.page !== 'operator') {
        return;
    }

    // /operator is the staff entry. It verifies the staff session, then hands
    // off to dashboard account administration, which checks its own access.
    // The managed IT lifecycle console is retired from this page.
    const LOGIN_URL = '/api/auth/login?returnTo=%2Foperator';
    const ADMIN_ENTRY_URL = '/dashboard-admin/entry';
    const SESSION_TIMEOUT_MS = 12000;
    const loadingStatus = document.getElementById('loadingStatus');
    const RETRY_RETURN = /(?:^\?|&)signin=retry(?:&|$)/.test(String(window.location.search || ''));

    if (RETRY_RETURN) {
        // Sign-in could not start. Never bounce straight back into it.
        showUnavailable('Staff sign-in could not start just now. Nothing was changed. Wait a minute, then try again.');
    } else {
        verifySessionAndHandOff().catch(function (error) {
            showUnavailable(error && error.message || 'The staff workspace could not be opened.');
        });
    }

    async function verifySessionAndHandOff() {
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
        setStatus('Signed in. Opening account administration.');
        window.location.replace(ADMIN_ENTRY_URL);
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
        }).catch(function () {
            throw new Error('Your session could not be checked in time. Nothing was changed.');
        }).then(function (response) {
            return response.json().catch(function () { return {}; }).then(function (body) {
                return { response, body };
            });
        }).finally(function () {
            window.clearTimeout(timer);
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
        signIn.textContent = RETRY_RETURN ? 'Try staff sign-in again' : 'Sign in again';
        loadingStatus.append(signIn, '.');
    }
}());
