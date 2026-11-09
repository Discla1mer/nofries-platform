const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const loaderSource = fs.readFileSync(path.join(root, 'js', 'operator-loader.js'), 'utf8');
const operatorSource = fs.readFileSync(
    path.join(root, 'api', 'shared', 'protectedAssets', 'operator.js'),
    'utf8'
);
const salesSource = fs.readFileSync(
    path.join(root, 'api', 'shared', 'protectedAssets', 'mssp.js'),
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

function createHarness(fetchImpl, search = '') {
    const loadingStatus = {
        textContent: '',
        append: jest.fn()
    };
    const classes = new Set(['operator-loading']);
    const appendedScripts = [];
    const document = {
        body: {
            dataset: { page: 'operator' },
            classList: {
                remove(value) { classes.delete(value); }
            }
        },
        head: {
            append: jest.fn((script) => appendedScripts.push(script))
        },
        getElementById(id) {
            return id === 'loadingStatus' ? loadingStatus : null;
        },
        createElement(tagName) {
            return { tagName: String(tagName).toUpperCase() };
        }
    };
    const window = {
        clearTimeout: jest.fn(),
        location: { replace: jest.fn(), search },
        setTimeout: jest.fn(() => 1)
    };

    vm.runInNewContext(loaderSource, {
        AbortController,
        document,
        fetch: fetchImpl,
        window
    });

    return {
        appendedScripts,
        classes,
        document,
        loadingStatus,
        window
    };
}

describe('operator session loader', () => {
    test('redirects a signed-out session without loading the protected application', async () => {
        const fetchImpl = jest.fn(async () => jsonResponse(401, {
            authenticated: false,
            code: 'authentication_required'
        }));
        const harness = createHarness(fetchImpl);

        await flushAsyncWork();
        await flushAsyncWork();

        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(fetchImpl).toHaveBeenCalledWith('/api/auth/session', expect.objectContaining({
            credentials: 'same-origin',
            cache: 'no-store'
        }));
        expect(harness.window.location.replace).toHaveBeenCalledWith(
            '/api/auth/login?returnTo=%2Foperator'
        );
        expect(harness.document.head.append).not.toHaveBeenCalled();
        expect(harness.appendedScripts).toHaveLength(0);
    });

    test('hands a verified staff session to account administration without loading the retired console', async () => {
        const fetchImpl = jest.fn(async () => jsonResponse(200, {
            authenticated: true,
            expiresAt: '2026-08-23T05:00:00.000Z'
        }));
        const harness = createHarness(fetchImpl);

        await flushAsyncWork();
        await flushAsyncWork();

        expect(harness.window.location.replace).toHaveBeenCalledWith('/dashboard-admin/entry');
        expect(harness.document.head.append).not.toHaveBeenCalled();
        expect(harness.appendedScripts).toHaveLength(0);
        expect(loaderSource).not.toContain('/api/lifecycle/app.js');
    });

    test('a failed sign-in start shows a retry screen instead of looping back into sign-in', async () => {
        const fetchImpl = jest.fn();
        const harness = createHarness(fetchImpl, '?signin=retry');

        await flushAsyncWork();

        expect(fetchImpl).not.toHaveBeenCalled();
        expect(harness.window.location.replace).not.toHaveBeenCalled();
        expect(harness.loadingStatus.textContent).toContain('Staff sign-in could not start');
        expect(harness.classes.has('operator-loading')).toBe(false);
        expect(harness.appendedScripts).toHaveLength(0);
    });

    test('a session check that times out or fails on the network explains itself', async () => {
        const fetchImpl = jest.fn(async () => { throw new Error('The user aborted a request.'); });
        const harness = createHarness(fetchImpl);

        await flushAsyncWork();
        await flushAsyncWork();

        expect(harness.loadingStatus.textContent).toBe('Your session could not be checked in time. Nothing was changed.');
        expect(harness.window.location.replace).not.toHaveBeenCalled();
        expect(harness.appendedScripts).toHaveLength(0);
    });

    test('contains no legacy Static Web Apps authentication route', () => {
        expect(loaderSource).not.toContain('/.auth/');
    });
});

describe('protected application session-expiry recovery', () => {
    test('operator API requests redirect a mid-session 401 to same-domain sign-in', () => {
        expect(operatorSource).toMatch(
            /if \(response\.status === 401\) \{[\s\S]{0,320}window\.location\.replace\('\/api\/auth\/login\?returnTo=%2Foperator'\)/
        );
    });

    test('sales API requests redirect a mid-session 401 to same-domain sign-in', () => {
        expect(salesSource).toMatch(
            /if \(response\.status === 401\) \{[\s\S]{0,320}window\.location\.assign\('\/api\/auth\/login\?returnTo=%2Fscoping'\)/
        );
    });
});
