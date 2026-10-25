jest.mock('../api/shared/identity', () => ({
    getProductRequestIdentity: jest.fn()
}));

const { getProductRequestIdentity } = require('../api/shared/identity');
const { resetAbuseProtectionForTests } = require('../api/shared/abuseProtection');
const { runDattoRmmFunction, resetDattoRmmRuntimeForTests } = require('../api/shared/dattoRmmRuntime');
const { runLifecycleFunction, resetLifecycleRuntimeForTests } = require('../api/shared/appLifecycleRuntime');
const { runSalesFunction, resetSalesRuntimeForTests } = require('../api/shared/salesRuntime');
const { runServiceDeskFunction, resetServiceDeskRuntimeForTests } = require('../api/shared/serviceDeskRuntime');

const APPROVED_TENANT_ID = '11111111-1111-4111-8111-111111111111';
const APPROVED_PRINCIPAL_ID = '22222222-2222-4222-8222-222222222222';
const APPROVED_SUBJECT = `${APPROVED_TENANT_ID}:${APPROVED_PRINCIPAL_ID}`;
const UNAPPROVED_TENANT_ID = '33333333-3333-4333-8333-333333333333';
const UNAPPROVED_PRINCIPAL_ID = '44444444-4444-4444-8444-444444444444';
const ENVIRONMENT_KEYS = [
    'NOFRIES_BROWSER_AUTH_MODE',
    'NOFRIES_REQUIRE_AUTH',
    'NOFRIES_ALLOWED_SUBJECTS',
    'NOFRIES_ADMIN_SUBJECTS',
    'NOFRIES_SERVICE_OWNER_SUBJECTS',
    'NOFRIES_ALLOWED_EMAILS',
    'NOFRIES_PILOT_EMAILS',
    'NOFRIES_ALLOWED_TENANT_IDS',
    'NOFRIES_ALLOW_TENANT_WIDE',
    'NOFRIES_DATTO_RMM_MODE',
    'NOFRIES_DATTO_RMM_API_URL',
    'NOFRIES_DATTO_RMM_ACCESS_TOKEN',
    'NOFRIES_DATTO_RMM_TENANT_ID'
];
const originalEnvironment = Object.fromEntries(
    ENVIRONMENT_KEYS.map((key) => [key, process.env[key]])
);

const runtimes = [
    {
        name: 'sales',
        run: runSalesFunction,
        url: '/api/sales/blueprint',
        deniedMessage: 'This Microsoft identity has not been approved for a No Fries workspace',
        outageMessage: 'No Fries session verification is temporarily unavailable.',
        verifySuccess(response) {
            expect(response.headers['Content-Type']).toBe('application/json; charset=utf-8');
            expect(response.body).toEqual(expect.objectContaining({
                estimatedMinutes: expect.any(Number),
                questions: expect.any(Array)
            }));
        }
    },
    {
        name: 'lifecycle',
        run: runLifecycleFunction,
        url: '/api/lifecycle/app.js',
        deniedMessage: 'This Microsoft identity has not been approved for a No Fries tenant',
        outageMessage: 'No Fries could not complete that request',
        verifySuccess(response) {
            expect(response.isRaw).toBe(true);
            expect(response.headers['Content-Type']).toBe('application/javascript; charset=utf-8');
            expect(response.body).toContain("document.getElementById('operatorRoot')");
        }
    },
    {
        name: 'service desk',
        run: runServiceDeskFunction,
        url: '/api/service-desk/app.js',
        deniedMessage: 'This Microsoft identity has not been approved for a No Fries tenant',
        outageMessage: 'No Fries could not complete that request',
        verifySuccess(response) {
            expect(response.isRaw).toBe(true);
            expect(response.headers['Content-Type']).toBe('application/javascript; charset=utf-8');
            expect(response.body).toContain('window.NoFriesSupport');
        }
    },
    {
        name: 'Datto RMM',
        run: runDattoRmmFunction,
        url: '/api/datto-rmm/status',
        deniedMessage: 'This Microsoft identity has not been approved for a No Fries tenant',
        outageMessage: 'No Fries could not complete that request',
        verifySuccess(response) {
            expect(response.headers['Content-Type']).toBe('application/json; charset=utf-8');
            expect(response.body).toEqual(expect.objectContaining({
                provider: 'datto_rmm',
                mode: 'disabled',
                readOnly: true,
                configured: false,
                state: 'tenant_binding_required',
                writeOperationsEnabled: false,
                tenantBindingConfigured: false,
                tenantBindingMatches: false
            }));
        }
    }
];

function setExplicitEntraBffEnvironment() {
    Object.assign(process.env, {
        NOFRIES_BROWSER_AUTH_MODE: 'entra_bff',
        NOFRIES_REQUIRE_AUTH: 'true',
        NOFRIES_ALLOWED_SUBJECTS: APPROVED_SUBJECT,
        NOFRIES_ADMIN_SUBJECTS: APPROVED_SUBJECT,
        NOFRIES_SERVICE_OWNER_SUBJECTS: '',
        NOFRIES_ALLOWED_EMAILS: '',
        NOFRIES_PILOT_EMAILS: '',
        NOFRIES_ALLOWED_TENANT_IDS: '',
        NOFRIES_ALLOW_TENANT_WIDE: 'false',
        NOFRIES_DATTO_RMM_MODE: 'disabled',
        NOFRIES_DATTO_RMM_API_URL: '',
        NOFRIES_DATTO_RMM_ACCESS_TOKEN: '',
        NOFRIES_DATTO_RMM_TENANT_ID: ''
    });
}

function restoreEnvironment() {
    ENVIRONMENT_KEYS.forEach((key) => {
        if (originalEnvironment[key] === undefined) {
            delete process.env[key];
            return;
        }
        process.env[key] = originalEnvironment[key];
    });
}

function resolverError(statusCode, message, code) {
    const error = new Error(message);
    error.statusCode = statusCode;
    error.details = { code };
    return error;
}

function entraBffIdentity(approved) {
    const tenantId = approved ? APPROVED_TENANT_ID : UNAPPROVED_TENANT_ID;
    const principalId = approved ? APPROVED_PRINCIPAL_ID : UNAPPROVED_PRINCIPAL_ID;
    return {
        email: approved ? 'approved@example.test' : 'unapproved@example.test',
        name: approved ? 'Approved User' : 'Unapproved User',
        tenantId,
        principalId,
        subjectKey: `${tenantId}:${principalId}`,
        provider: 'entra-bff',
        isAuthenticated: true
    };
}

function requestFor(runtimeName, url, scenario) {
    return {
        method: 'GET',
        originalUrl: url,
        url,
        headers: {
            'x-forwarded-for': `198.51.100.${runtimeName.length}.${scenario}`
        }
    };
}

function functionContext() {
    return {
        bindingData: {},
        log: {
            error: jest.fn(),
            info: jest.fn(),
            warn: jest.fn()
        }
    };
}

async function runWith(runtime, scenario) {
    const req = requestFor(runtime.name, runtime.url, scenario);
    const context = functionContext();
    await runtime.run(context, req);
    expect(getProductRequestIdentity).toHaveBeenCalledTimes(1);
    expect(getProductRequestIdentity).toHaveBeenCalledWith(req);
    return context;
}

describe.each(runtimes)('$name product runtime identity wiring', (runtime) => {
    beforeEach(() => {
        setExplicitEntraBffEnvironment();
        getProductRequestIdentity.mockReset();
        resetAbuseProtectionForTests();
        resetDattoRmmRuntimeForTests();
        resetLifecycleRuntimeForTests();
        resetSalesRuntimeForTests();
        resetServiceDeskRuntimeForTests();
    });

    test('returns the exact authentication-required JSON when identity resolution rejects the request', async () => {
        getProductRequestIdentity.mockRejectedValueOnce(resolverError(
            401,
            'Sign-in is required.',
            'authentication_required'
        ));

        const context = await runWith(runtime, '401');

        expect(context.res.status).toBe(401);
        expect(context.res.body).toEqual({
            error: 'Sign-in is required.',
            code: 'authentication_required'
        });
    });

    test('returns the exact tenant-access JSON for a valid but unapproved Entra subject', async () => {
        getProductRequestIdentity.mockResolvedValueOnce(entraBffIdentity(false));

        const context = await runWith(runtime, '403');

        expect(context.res.status).toBe(403);
        expect(context.res.body).toEqual({
            error: runtime.deniedMessage,
            code: 'tenant_access_required',
            reason: 'identity_not_approved'
        });
    });

    test('returns the exact browser-auth-unavailable JSON when identity resolution is unavailable', async () => {
        getProductRequestIdentity.mockRejectedValueOnce(resolverError(
            503,
            'No Fries session verification is temporarily unavailable.',
            'browser_auth_unavailable'
        ));

        const context = await runWith(runtime, '503');

        expect(context.res.status).toBe(503);
        expect(context.res.body).toEqual({
            error: runtime.outageMessage,
            code: 'browser_auth_unavailable'
        });
    });

    test('allows an approved Entra subject to complete a GET through the runtime wrapper', async () => {
        getProductRequestIdentity.mockResolvedValueOnce(entraBffIdentity(true));

        const context = await runWith(runtime, '200');

        expect(context.res.status).toBe(200);
        runtime.verifySuccess(context.res);
    });
});

describe('Lifecycle export capability boundary', () => {
    beforeEach(() => {
        setExplicitEntraBffEnvironment();
        process.env.NOFRIES_ADMIN_SUBJECTS = '';
        process.env.NOFRIES_SERVICE_OWNER_SUBJECTS = '';
        getProductRequestIdentity.mockReset();
        resetAbuseProtectionForTests();
        resetLifecycleRuntimeForTests();
    });

    test('refuses complete audit export to a consultant without lifecycle audit access', async () => {
        getProductRequestIdentity.mockResolvedValueOnce(entraBffIdentity(true));
        const req = requestFor(
            'lifecycle',
            '/api/lifecycle/organisations/organisation-test/export',
            'audit-export-403'
        );
        const context = functionContext();
        await runLifecycleFunction(context, req);

        expect(context.res.status).toBe(403);
        expect(context.res.body).toEqual({
            error: 'Your No Fries role does not permit this action',
            code: 'capability_required',
            capability: 'lifecycle:audit:read'
        });
    });
});

afterAll(() => {
    restoreEnvironment();
});
