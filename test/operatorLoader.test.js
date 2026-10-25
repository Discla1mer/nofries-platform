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

function createHarness(fetchImpl) {
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
        location: { replace: jest.fn() },
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

    test('injects the protected lifecycle application after session verification', async () => {
        const fetchImpl = jest.fn(async () => jsonResponse(200, {
            authenticated: true,
            expiresAt: '2026-08-23T05:00:00.000Z'
        }));
        const harness = createHarness(fetchImpl);

        await flushAsyncWork();
        await flushAsyncWork();

        expect(harness.window.location.replace).not.toHaveBeenCalled();
        expect(harness.document.head.append).toHaveBeenCalledTimes(1);
        expect(harness.appendedScripts).toHaveLength(1);
        expect(harness.appendedScripts[0]).toMatchObject({
            id: 'protectedOperatorApplication',
            src: '/api/lifecycle/app.js',
            async: true
        });
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
