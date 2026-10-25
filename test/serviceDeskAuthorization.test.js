const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-service-desk-auth-'));
process.env.NOFRIES_DATA_DIR = dataDir;
process.env.NOFRIES_REQUIRE_AUTH = 'true';
process.env.NOFRIES_BROWSER_AUTH_MODE = 'swa';
process.env.NOFRIES_ALLOWED_EMAILS = 'approved@example.com';
process.env.NOFRIES_ADMIN_EMAILS = 'approved@example.com';
process.env.NOFRIES_ALLOWED_TENANT_IDS = 'tenant-a';
process.env.NOFRIES_DEFAULT_TENANT_ID = 'tenant-a';
process.env.NOFRIES_STORAGE_PROVIDER = 'local';
process.env.NOFRIES_SERVICE_DESK_STORAGE_PROVIDER = 'local';
process.env.NOFRIES_AGENT_RUNTIME = 'mock';

const {
    handleServiceDeskRequest,
    resetServiceDeskRuntimeForTests
} = require('../api/shared/serviceDeskRuntime');

function principal(email, tenantId = 'tenant-a') {
    return Buffer.from(JSON.stringify({
        identityProvider: 'aad',
        userId: `user:${email}`,
        userDetails: email,
        claims: [
            { typ: 'tid', val: tenantId },
            { typ: 'name', val: email }
        ]
    })).toString('base64');
}

function requestFor(pathname, email) {
    return {
        method: 'GET',
        originalUrl: `/api/service-desk/${pathname}`,
        headers: email ? { 'x-ms-client-principal': principal(email) } : {},
        body: null
    };
}

describe('hosted service-desk authorization', () => {
    afterAll(() => {
        resetServiceDeskRuntimeForTests();
        fs.rmSync(dataDir, { recursive: true, force: true });
    });

    test.each(['app.js', 'bootstrap'])('%s rejects a missing or unapproved hosted identity', async (pathname) => {
        await expect(handleServiceDeskRequest(requestFor(pathname))).rejects.toMatchObject({
            statusCode: 403,
            details: { code: 'tenant_access_required' }
        });
        await expect(handleServiceDeskRequest(requestFor(pathname, 'unapproved@example.com'))).rejects.toMatchObject({
            statusCode: 403,
            details: { code: 'tenant_access_required' }
        });
    });

    test('approved identity can load the application and bootstrap', async () => {
        const application = await handleServiceDeskRequest(requestFor('app.js', 'approved@example.com'));
        expect(application).toMatchObject({ status: 200, isRaw: true });
        expect(application.body).toContain('NoFriesSupport');

        const bootstrap = await handleServiceDeskRequest(requestFor('bootstrap', 'approved@example.com'));
        expect(bootstrap.status).toBe(200);
        expect(bootstrap.body).toMatchObject({
            tenant: { id: 'tenant-a' },
            user: { email: 'approved@example.com', role: 'admin' }
        });
    });
});
