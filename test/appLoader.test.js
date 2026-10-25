const fs = require('fs');
const path = require('path');
const vm = require('vm');

const loaderSource = fs.readFileSync(path.join(__dirname, '..', 'js', 'app-loader.js'), 'utf8');

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

function validBootstrap() {
    return {
        revision: 3,
        user: { email: 'admin@example.com', name: 'Admin User', role: 'admin' },
        tenant: { name: 'No Fries workspace' },
        counts: {},
        catalogue: {},
        customers: [],
        assessments: [],
        proposals: [],
        integration: {}
    };
}

function validSession() {
    return {
        authenticated: true,
        user: { email: 'admin@example.com', name: 'Admin User' },
        expiresAt: '2026-08-23T05:00:00.000Z'
    };
}

function createHarness(fetchImpl, options = {}) {
    const elements = {
        loadingHeading: { textContent: '' },
        loadingMessage: { textContent: '' },
        loadingStatus: { textContent: '', innerHTML: '' }
    };
    const classes = new Set(['app-loading']);
    const appendedScripts = [];
    const document = {
        body: {
            dataset: { page: 'sales-workspace', startup: '' },
            classList: {
                add(value) { classes.add(value); },
                remove(value) { classes.delete(value); },
                contains(value) { return classes.has(value); }
            }
        },
        getElementById(id) {
            return elements[id];
        },
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
        NoFriesSales: options.salesApp,
        location: { assign: jest.fn() }
    };
    const timers = [];
    const setTimeoutImpl = options.setTimeout || function (callback, delay) {
        timers.push({ callback, delay });
        return timers.length;
    };
    const clearTimeoutImpl = jest.fn(function (timerId) {
        if (timers[timerId - 1]) timers[timerId - 1].cancelled = true;
    });
    const sessionImpl = options.sessionImpl || (async () => jsonResponse(200, validSession()));
    const routedFetch = jest.fn(function (url, requestOptions) {
        return url === '/api/auth/session'
            ? sessionImpl(url, requestOptions)
            : fetchImpl(url, requestOptions);
    });

    vm.runInNewContext(loaderSource, {
        AbortController: options.hasAbortController === false ? undefined : AbortController,
        clearTimeout: clearTimeoutImpl,
        document,
        fetch: routedFetch,
        setTimeout: setTimeoutImpl,
        window
    });

    return {
        classes,
        appendedScripts,
        clearTimeout: clearTimeoutImpl,
        document,
        elements,
        fetch: routedFetch,
        timers,
        window
    };
}

describe('protected scoping workspace loader', () => {
    test('retries a temporary bootstrap failure once and shows a recoverable error', async () => {
        const fetchImpl = jest.fn(async () => jsonResponse(503, {
            error: 'Workspace storage is temporarily unavailable.'
        }));
        const harness = createHarness(fetchImpl);

        await flushAsyncWork();
        await flushAsyncWork();
        await flushAsyncWork();

        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(harness.elements.loadingHeading.textContent).toBe('Workspace could not load');
        expect(harness.elements.loadingStatus.innerHTML).toContain('Retry');
        expect(harness.classes.has('workspace-unavailable')).toBe(true);
    });

    test('marks the loader active before waiting for the protected bootstrap', () => {
        const fetchImpl = jest.fn(() => new Promise(() => {}));
        const harness = createHarness(fetchImpl, { salesApp: { start: jest.fn() } });

        expect(harness.document.body.dataset.startup).toBe('loader_active');
        expect(harness.elements.loadingMessage.textContent).toContain('Secure page loaded');
        expect(harness.elements.loadingStatus.textContent).toContain('bootstrap_request');
    });

    test('redirects a 401 response to Microsoft sign-in', async () => {
        const fetchImpl = jest.fn(async () => jsonResponse(401, {}));
        const harness = createHarness(fetchImpl);

        await flushAsyncWork();
        await flushAsyncWork();

        expect(harness.window.location.assign).toHaveBeenCalledWith(
            '/api/auth/login?returnTo=%2Fscoping'
        );
    });

    test('checks the opaque browser session before requesting workspace data', async () => {
        const fetchImpl = jest.fn(async () => jsonResponse(200, validBootstrap()));
        let harness;
        const salesApp = { start: jest.fn(() => harness.classes.delete('app-loading')) };
        harness = createHarness(fetchImpl, { salesApp });

        await flushAsyncWork();
        await flushAsyncWork();

        expect(harness.fetch.mock.calls.map((call) => call[0])).toEqual([
            '/api/auth/session',
            '/api/sales/bootstrap'
        ]);
        expect(harness.appendedScripts).toHaveLength(1);
        expect(harness.appendedScripts[0]).toMatchObject({
            id: 'protectedSalesApplication',
            src: '/api/sales/app.js',
            async: true
        });
    });

    test('redirects a missing opaque session without requesting workspace data', async () => {
        const fetchImpl = jest.fn();
        const harness = createHarness(fetchImpl, {
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
            '/api/auth/login?returnTo=%2Fscoping'
        );
    });

    test('shows the access state immediately for an unapproved Microsoft identity', async () => {
        const fetchImpl = jest.fn(async () => jsonResponse(403, {
            error: 'This Microsoft identity has not been approved for a No Fries workspace',
            code: 'tenant_access_required'
        }));
        const harness = createHarness(fetchImpl);

        await flushAsyncWork();
        await flushAsyncWork();

        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(harness.elements.loadingHeading.textContent).toBe('Access has not been approved');
        expect(harness.classes.has('access-denied')).toBe(true);
    });

    test('rejects a successful HTTP response that is not a valid workspace bootstrap payload', async () => {
        const fetchImpl = jest.fn(async () => jsonResponse(200, { html: '<html>Sign in</html>' }));
        const harness = createHarness(fetchImpl);

        await flushAsyncWork();
        await flushAsyncWork();
        await flushAsyncWork();

        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(harness.elements.loadingHeading.textContent).toBe('Workspace could not load');
        expect(harness.elements.loadingStatus.innerHTML).toContain('invalid_bootstrap_payload');
    });

    test('loads and starts the protected application after bootstrap succeeds', async () => {
        const fetchImpl = jest.fn(async (url) => {
            expect(url).toBe('/api/sales/bootstrap');
            return jsonResponse(200, validBootstrap());
        });
        let harness;
        const salesApp = {
            start: jest.fn(() => harness.classes.delete('app-loading'))
        };
        harness = createHarness(fetchImpl, { salesApp });

        await flushAsyncWork();
        await flushAsyncWork();

        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(salesApp.start).toHaveBeenCalledWith(harness.window.NoFriesBootstrap);
        expect(harness.classes.has('workspace-unavailable')).toBe(false);
    });

    test('reports a protected runtime that does not expose the application initializer', async () => {
        const fetchImpl = jest.fn(async () => jsonResponse(200, validBootstrap()));
        const harness = createHarness(fetchImpl);

        await flushAsyncWork();
        await flushAsyncWork();

        expect(harness.elements.loadingStatus.innerHTML).toContain('app_initializer_missing');
        expect(harness.classes.has('workspace-unavailable')).toBe(true);
    });

    test('hard-times out a fetch that ignores abort and never settles', async () => {
        const fetchImpl = jest.fn(() => new Promise(() => {}));
        const harness = createHarness(fetchImpl, { salesApp: { start: jest.fn() } });

        await flushAsyncWork();
        const firstPendingTimer = harness.timers.find((timer) => !timer.cancelled);
        expect(firstPendingTimer.delay).toBe(12000);
        firstPendingTimer.callback();
        await flushAsyncWork();
        await flushAsyncWork();

        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(harness.elements.loadingHeading.textContent).toBe('Starting the protected workspace');
        const secondPendingTimer = harness.timers.find((timer) => !timer.cancelled && timer !== firstPendingTimer);
        expect(secondPendingTimer.delay).toBe(12000);
        secondPendingTimer.callback();
        await flushAsyncWork();
        await flushAsyncWork();

        expect(harness.elements.loadingStatus.innerHTML).toContain('workspace_timeout');
        expect(harness.classes.has('workspace-unavailable')).toBe(true);
    });

    test('hard-times out a response body that never finishes parsing, even without AbortController', async () => {
        const neverParsed = {
            ok: true,
            status: 200,
            json: () => new Promise(() => {})
        };
        const fetchImpl = jest.fn()
            .mockResolvedValueOnce(neverParsed)
            .mockResolvedValueOnce(jsonResponse(200, validBootstrap()));
        let harness;
        const salesApp = { start: jest.fn(() => harness.classes.delete('app-loading')) };
        harness = createHarness(fetchImpl, { salesApp, hasAbortController: false });

        await flushAsyncWork();
        const pendingTimer = harness.timers.find((timer) => !timer.cancelled);
        pendingTimer.callback();
        await flushAsyncWork();
        await flushAsyncWork();
        await flushAsyncWork();

        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(salesApp.start).toHaveBeenCalledTimes(1);
        expect(harness.classes.has('workspace-unavailable')).toBe(false);
    });

    test('surfaces an application startup exception instead of leaving the loading panel stuck', async () => {
        const fetchImpl = jest.fn(async () => jsonResponse(200, validBootstrap()));
        const salesApp = {
            start() {
                throw new Error('renderIdentity failed');
            }
        };
        const harness = createHarness(fetchImpl, { salesApp });

        await flushAsyncWork();
        await flushAsyncWork();

        expect(harness.elements.loadingHeading.textContent).toBe('Workspace could not load');
        expect(harness.elements.loadingStatus.innerHTML).toContain('app_start_failed');
        expect(harness.classes.has('app-loading')).toBe(false);
        expect(harness.classes.has('workspace-unavailable')).toBe(true);
    });

    test('reports an incomplete startup if the protected app returns without opening the workspace', async () => {
        const fetchImpl = jest.fn(async () => jsonResponse(200, validBootstrap()));
        const salesApp = { start: jest.fn() };
        const harness = createHarness(fetchImpl, { salesApp });

        await flushAsyncWork();
        await flushAsyncWork();

        expect(harness.elements.loadingStatus.innerHTML).toContain('app_start_incomplete');
        expect(harness.classes.has('workspace-unavailable')).toBe(true);
    });
});
