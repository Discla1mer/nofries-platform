const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const loaderSource = fs.readFileSync(path.join(root, 'js', 'support-loader.js'), 'utf8');
const applicationSource = fs.readFileSync(
    path.join(root, 'api', 'shared', 'protectedAssets', 'support.js'),
    'utf8'
);

function flushAsyncWork() {
    return new Promise((resolve) => setImmediate(resolve));
}

function jsonResponse(status, body) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body
    };
}

function nonJsonResponse(status) {
    return {
        ok: false,
        status,
        json: async () => { throw new Error('not json'); }
    };
}

function validSession() {
    return {
        authenticated: true,
        user: { email: 'admin@example.com', name: 'Admin User' },
        expiresAt: '2026-08-23T05:00:00.000Z'
    };
}

function validBootstrap() {
    return {
        revision: 4,
        user: { email: 'admin@example.com', role: 'admin' },
        tenant: { name: 'Pilot workspace' },
        runtime: {
            mode: 'production',
            provider: 'autotask',
            sourceOfTruth: true,
            externalChanges: true,
            durableOperationFence: true
        },
        customers: [],
        tickets: []
    };
}

function createHarness(fetchImpl, options = {}) {
    const elements = {
        loadingHeading: { textContent: '' },
        loadingMessage: { textContent: '' },
        loadingStatus: { textContent: '' },
        loadingActions: { hidden: true },
        loadingPanel: { hidden: false },
        supportApp: { hidden: true }
    };
    const classes = new Set(['support-loading']);
    const appendedScripts = [];
    const timers = [];
    const setTimeoutImpl = options.setTimeout || function (callback, delay) {
        timers.push({ callback, delay });
        return timers.length;
    };
    const clearTimeoutImpl = jest.fn(function (timerId) {
        if (timers[timerId - 1]) timers[timerId - 1].cancelled = true;
    });
    const document = {
        body: {
            dataset: { page: 'service-desk', startup: '' },
            classList: {
                add(value) { classes.add(value); },
                remove(value) { classes.delete(value); },
                contains(value) { return classes.has(value); }
            }
        },
        getElementById(id) { return elements[id]; },
        head: {
            append: jest.fn((script) => {
                appendedScripts.push(script);
                if (options.scriptLoadError) script.onerror();
                else script.onload();
            })
        },
        createElement(tagName) {
            return { tagName: String(tagName).toUpperCase() };
        }
    };
    const window = {
        NoFriesSupport: options.supportApp,
        location: { assign: jest.fn() },
        setTimeout: setTimeoutImpl,
        clearTimeout: clearTimeoutImpl
    };
    const sessionImpl = options.sessionImpl || (async () => jsonResponse(200, validSession()));
    const routedFetch = jest.fn(function (url, requestOptions) {
        return url === '/api/auth/session'
            ? sessionImpl(url, requestOptions)
            : fetchImpl(url, requestOptions);
    });

    vm.runInNewContext(loaderSource, {
        AbortController: options.hasAbortController === false ? undefined : AbortController,
        document,
        fetch: routedFetch,
        URLSearchParams,
        window
    });

    return { appendedScripts, classes, document, elements, fetch: routedFetch, fetchImpl, timers, window };
}

describe('protected service-desk loader', () => {
    test('marks startup active before waiting for bootstrap', () => {
        const harness = createHarness(jest.fn(() => new Promise(() => {})), {
            supportApp: { start: jest.fn() }
        });
        expect(harness.document.body.dataset.startup).toBe('loader_active');
        expect(harness.elements.loadingStatus.textContent).toContain('bootstrap_request');
        expect(harness.timers[0].delay).toBe(12000);
    });

    test('redirects a 401 back through Microsoft sign-in to support', async () => {
        const harness = createHarness(jest.fn(async () => jsonResponse(401, {})));
        await flushAsyncWork();
        await flushAsyncWork();
        expect(harness.window.location.assign).toHaveBeenCalledWith(
            '/api/auth/login?returnTo=%2Fsupport'
        );
    });

    test('redirects a non-JSON 401 instead of treating it as a broken bootstrap', async () => {
        const harness = createHarness(jest.fn(async () => nonJsonResponse(401)));
        await flushAsyncWork();
        await flushAsyncWork();
        expect(harness.window.location.assign).toHaveBeenCalledWith(
            '/api/auth/login?returnTo=%2Fsupport'
        );
    });

    test('checks the opaque browser session before requesting support data', async () => {
        const fetchImpl = jest.fn(async () => jsonResponse(200, validBootstrap()));
        let harness;
        const supportApp = { start: jest.fn(() => harness.classes.delete('support-loading')) };
        harness = createHarness(fetchImpl, { supportApp });

        await flushAsyncWork();
        await flushAsyncWork();

        expect(harness.fetch.mock.calls.map((call) => call[0])).toEqual([
            '/api/auth/session',
            '/api/service-desk/bootstrap'
        ]);
        expect(harness.appendedScripts).toHaveLength(1);
        expect(harness.appendedScripts[0]).toMatchObject({
            id: 'protectedSupportApplication',
            src: '/api/service-desk/app.js',
            async: true
        });
        expect(supportApp.start).toHaveBeenCalledTimes(1);
    });

    test('refuses a mock or simulation bootstrap instead of opening it as the live desk', async () => {
        const payload = validBootstrap();
        payload.runtime = { mode: 'mock', provider: 'mock', sourceOfTruth: false };
        const fetchImpl = jest.fn(async () => jsonResponse(200, payload));
        const supportApp = { start: jest.fn() };
        const harness = createHarness(fetchImpl, { supportApp });

        await flushAsyncWork();
        await flushAsyncWork();
        await flushAsyncWork();

        expect(supportApp.start).not.toHaveBeenCalled();
        expect(harness.classes.has('support-unavailable')).toBe(true);
        expect(harness.elements.loadingStatus.textContent).toContain('production_service_desk_required');
    });

    test('redirects a missing opaque session without requesting protected support data', async () => {
        const fetchImpl = jest.fn();
        const supportApp = { start: jest.fn() };
        const harness = createHarness(fetchImpl, {
            supportApp,
            sessionImpl: async () => jsonResponse(401, {
                authenticated: false,
                code: 'authentication_required'
            })
        });

        await flushAsyncWork();
        await flushAsyncWork();

        expect(fetchImpl).not.toHaveBeenCalled();
        expect(harness.appendedScripts).toHaveLength(0);
        expect(harness.window.location.assign).toHaveBeenCalledWith(
            '/api/auth/login?returnTo=%2Fsupport'
        );
        expect(supportApp.start).not.toHaveBeenCalled();
    });

    test('shows access denied for a non-JSON 403 response', async () => {
        const fetchImpl = jest.fn(async () => nonJsonResponse(403));
        const harness = createHarness(fetchImpl);
        await flushAsyncWork();
        await flushAsyncWork();
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(harness.classes.has('access-denied')).toBe(true);
    });

    test('does not retry an unapproved identity', async () => {
        const fetchImpl = jest.fn(async () => jsonResponse(403, {
            error: 'Identity not approved',
            code: 'tenant_access_required'
        }));
        const harness = createHarness(fetchImpl);
        await flushAsyncWork();
        await flushAsyncWork();
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(harness.classes.has('access-denied')).toBe(true);
        expect(harness.elements.loadingActions.hidden).toBe(false);
    });

    test('retries one temporary failure and then shows a recoverable state', async () => {
        const fetchImpl = jest.fn(async () => jsonResponse(503, { error: 'Storage unavailable' }));
        const harness = createHarness(fetchImpl);
        await flushAsyncWork();
        await flushAsyncWork();
        await flushAsyncWork();
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(harness.classes.has('support-unavailable')).toBe(true);
        expect(harness.elements.loadingStatus.textContent).toContain('support_startup_failed');
    });

    test('rejects an incomplete successful response', async () => {
        const fetchImpl = jest.fn(async () => jsonResponse(200, { html: '<html>Sign in</html>' }));
        const harness = createHarness(fetchImpl);
        await flushAsyncWork();
        await flushAsyncWork();
        await flushAsyncWork();
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(harness.elements.loadingStatus.textContent).toContain('production_service_desk_required');
    });

    test('loads and starts the protected support application after a valid bootstrap', async () => {
        const fetchImpl = jest.fn(async () => jsonResponse(200, validBootstrap()));
        let harness;
        const supportApp = { start: jest.fn(() => harness.classes.delete('support-loading')) };
        harness = createHarness(fetchImpl, { supportApp });
        await flushAsyncWork();
        await flushAsyncWork();
        expect(supportApp.start).toHaveBeenCalledWith(expect.objectContaining({ revision: 4 }));
        expect(harness.classes.has('support-unavailable')).toBe(false);
    });

    test.each([
        ['missing', undefined, 'support_initializer_missing'],
        ['throws', { start: jest.fn(() => { throw new Error('render failed'); }) }, 'support_start_failed'],
        ['incomplete', { start: jest.fn() }, 'support_start_incomplete']
    ])('restores recovery UI when application startup is %s', async (_, supportApp, diagnostic) => {
        const harness = createHarness(jest.fn(async () => jsonResponse(200, validBootstrap())), { supportApp });
        harness.elements.loadingPanel.hidden = true;
        harness.elements.supportApp.hidden = false;
        await flushAsyncWork();
        await flushAsyncWork();
        expect(harness.elements.loadingPanel.hidden).toBe(false);
        expect(harness.elements.supportApp.hidden).toBe(true);
        expect(harness.classes.has('support-unavailable')).toBe(true);
        expect(harness.elements.loadingStatus.textContent).toContain(diagnostic);
    });

    test('hard-times out a fetch that never settles and retries once', async () => {
        const fetchImpl = jest.fn(() => new Promise(() => {}));
        const harness = createHarness(fetchImpl, { supportApp: { start: jest.fn() } });
        await flushAsyncWork();
        const firstPendingTimer = harness.timers.find((timer) => !timer.cancelled);
        firstPendingTimer.callback();
        await flushAsyncWork();
        await flushAsyncWork();
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        const secondPendingTimer = harness.timers.find((timer) => !timer.cancelled && timer !== firstPendingTimer);
        secondPendingTimer.callback();
        await flushAsyncWork();
        await flushAsyncWork();
        expect(harness.classes.has('support-unavailable')).toBe(true);
        expect(harness.elements.loadingStatus.textContent).toContain('support_timeout');
    });

    test('contains no legacy Static Web Apps authentication route', () => {
        expect(loaderSource).not.toContain('/.auth/');
    });
});

describe('support application startup contract', () => {
    test('exports one loader-controlled start function and does not fetch its own bootstrap', () => {
        expect(applicationSource).toContain('window.NoFriesSupport = { start };');
        expect(applicationSource).not.toMatch(/^\s*initialise\(\);\s*$/m);
        expect(applicationSource).not.toContain("api('/api/service-desk/bootstrap')");
    });
});
