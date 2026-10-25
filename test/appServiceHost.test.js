const request = require('supertest');

process.env.NOFRIES_REQUIRE_AUTH = 'false';
process.env.NOFRIES_BROWSER_AUTH_MODE = 'swa';
process.env.NOFRIES_DEV_EMAIL = 'admin@example.test';
process.env.NOFRIES_ALLOWED_EMAILS = 'admin@example.test';
process.env.NOFRIES_ADMIN_EMAILS = 'admin@example.test';

const app = require('../server');
const {
    HostConfigurationError,
    resolveAppServiceHostConfig,
    resolveStandaloneHostConfig,
    startAppServiceHost
} = require('../lib/hostStartup');
const { resetRequestIdentityForTests } = require('../api/shared/identity');

function appServiceEnvironment(overrides = {}) {
    return Object.assign({
        NODE_ENV: 'production',
        PORT: '8080',
        NOFRIES_BIND_HOST: '127.0.0.1',
        NOFRIES_REQUIRE_AUTH: 'true',
        NOFRIES_BROWSER_AUTH_MODE: 'entra_bff',
        NOFRIES_TRUSTED_AUTH_PROXY: 'false',
        NOFRIES_BROWSER_SESSION_STORE: 'azure',
        NOFRIES_BROWSER_AUTH_STORAGE_ACCOUNT: 'nofriesauthdev123',
        AZURE_STORAGE_ACCOUNT_NAME: 'nofriesdatadev123',
        NOFRIES_PUBLIC_URL: 'https://nofries-dynamic-dev.azurewebsites.net',
        NOFRIES_ENTRA_CLIENT_SECRET: 'nonproduction-entra-client-secret',
        NOFRIES_SCOPE_SIGNING_SECRET: 'nonproduction-scope-secret-at-least-32-characters',
        NOFRIES_PROSPECT_SIGNING_SECRET: 'nonproduction-prospect-secret-at-least-32-characters'
    }, overrides);
}

describe('App Service host configuration', () => {
    test('binds the Azure platform port on all interfaces with the BFF boundary', () => {
        const config = resolveAppServiceHostConfig(appServiceEnvironment());
        expect(config).toMatchObject({
            port: 8080,
            bindHost: '0.0.0.0',
            requireAuth: true,
            browserAuthMode: 'entra_bff',
            trustedAuthProxy: false
        });
    });

    test('starts through the resolved port and returns the server lifecycle handle', () => {
        const server = { close: jest.fn() };
        const listen = jest.fn((port, host, callback) => {
            callback();
            return server;
        });
        const logger = { log: jest.fn() };

        const result = startAppServiceHost({ listen }, {
            env: appServiceEnvironment({ PORT: '4321' }),
            logger
        });

        expect(result).toBe(server);
        expect(listen).toHaveBeenCalledWith(4321, '0.0.0.0', expect.any(Function));
        expect(logger.log).toHaveBeenCalledWith('No Fries dynamic host listening on 0.0.0.0:4321');
        result.close();
        expect(server.close).toHaveBeenCalledTimes(1);
    });

    test.each([
        ['non-production Node mode', { NODE_ENV: 'development' }],
        ['authentication opt-out', { NOFRIES_REQUIRE_AUTH: 'false' }],
        ['legacy SWA identity headers', { NOFRIES_BROWSER_AUTH_MODE: 'swa' }],
        ['trusted identity headers', { NOFRIES_TRUSTED_AUTH_PROXY: 'true' }],
        ['in-memory sessions', { NOFRIES_BROWSER_SESSION_STORE: 'memory' }],
        ['shared auth and data storage', { NOFRIES_BROWSER_AUTH_STORAGE_ACCOUNT: 'nofriesdatadev123' }],
        ['non-HTTPS callback origin', { NOFRIES_PUBLIC_URL: 'http://localhost:3000' }],
        ['an unresolved Entra secret reference', { NOFRIES_ENTRA_CLIENT_SECRET: '@Microsoft.KeyVault(VaultName=missing;SecretName=entra-client-secret)' }],
        ['an unresolved scope signing reference', { NOFRIES_SCOPE_SIGNING_SECRET: '@Microsoft.KeyVault(VaultName=missing;SecretName=scope-signing-secret)' }],
        ['an unresolved prospect signing reference', { NOFRIES_PROSPECT_SIGNING_SECRET: '@Microsoft.KeyVault(VaultName=missing;SecretName=prospect-signing-secret)' }],
        ['a blank Entra client secret', { NOFRIES_ENTRA_CLIENT_SECRET: '                                ' }],
        ['a blank scope signing secret', { NOFRIES_SCOPE_SIGNING_SECRET: '                                ' }],
        ['a blank prospect signing secret', { NOFRIES_PROSPECT_SIGNING_SECRET: '                                ' }],
        ['a short scope signing secret', { NOFRIES_SCOPE_SIGNING_SECRET: 'too-short' }],
        ['a short prospect signing secret', { NOFRIES_PROSPECT_SIGNING_SECRET: 'too-short' }],
        ['invalid platform port', { PORT: '0' }]
    ])('rejects %s', (_, overrides) => {
        expect(() => resolveAppServiceHostConfig(appServiceEnvironment(overrides)))
            .toThrow(HostConfigurationError);
    });

    test('keeps direct BFF startup independent of legacy platform-header trust', () => {
        expect(resolveStandaloneHostConfig({
            PORT: '3000',
            NOFRIES_REQUIRE_AUTH: 'true',
            NOFRIES_BROWSER_AUTH_MODE: 'entra_bff',
            NOFRIES_TRUSTED_AUTH_PROXY: 'false'
        })).toMatchObject({
            bindHost: '127.0.0.1',
            browserAuthMode: 'entra_bff',
            trustedAuthProxy: false
        });
    });

    test('keeps legacy SWA header auth behind the sanitising-proxy guard', () => {
        expect(() => resolveStandaloneHostConfig({
            NOFRIES_REQUIRE_AUTH: 'true',
            NOFRIES_BROWSER_AUTH_MODE: 'swa',
            NOFRIES_TRUSTED_AUTH_PROXY: 'false'
        })).toThrow(HostConfigurationError);
        expect(resolveStandaloneHostConfig({
            NOFRIES_REQUIRE_AUTH: 'true',
            NOFRIES_BROWSER_AUTH_MODE: 'swa',
            NOFRIES_TRUSTED_AUTH_PROXY: 'true'
        })).toMatchObject({ trustedAuthProxy: true });
    });
});

describe('dynamic host route and disclosure boundary', () => {
    test('bridges the existing fail-closed health and release identity contracts', async () => {
        const health = await request(app).get('/api/health');
        expect(health.status).toBe(503);
        expect(health.body).toEqual({
            status: 'unavailable',
            code: 'release_identity_unavailable'
        });
        expect(health.headers['cache-control']).toContain('no-store');
        expect(health.headers['x-robots-tag']).toBe('noindex, nofollow');

        const release = await request(app).get('/release.json');
        expect(release.status).toBe(200);
        expect(release.body).toEqual({
            schemaVersion: 2,
            releaseSha: null,
            runId: null
        });
        expect(release.headers['cache-control']).toBe('no-store, max-age=0');
        expect(release.headers['x-robots-tag']).toBe('noindex, nofollow');
    });

    test.each([
        '/',
        '/scope.html',
        '/404.html',
        '/error.html',
        '/privacy.html',
        '/terms.html',
        '/style.css',
        '/home.css',
        '/favicon.svg',
        '/images/nofrieslogo.png',
        '/js/home.js',
        '/js/prospect-assistant.js',
        '/assets/mssp.css',
        '/assets/support.css',
        '/assets/operator.css',
        '/.well-known/security.txt'
    ])('serves the curated public asset %s', async (route) => {
        expect((await request(app).get(route)).status).toBe(200);
    });

    test.each([
        '/server.js',
        '/app-service.js',
        '/package.json',
        '/package-lock.json',
        '/AGENTS.md',
        '/database/migrations/0001_core_service_desk.sql',
        '/scripts/db-migrate.js',
        '/test/server.test.js',
        '/docs/production-runbook.md',
        '/lib/identity.js',
        '/connector-functions/host.json',
        '/release/browser-auth-contract.json',
        '/infra/azure/main.bicep',
        '/staticwebapp.config.json',
        '/.env.example'
    ])('does not disclose repository path %s', async (route) => {
        expect((await request(app).get(route)).status).toBe(404);
    });

    test('does not disclose API source through the preserved retired-API response', async () => {
        const response = await request(app).get('/api/shared/identity.js');
        expect(response.status).toBe(410);
        expect(response.body).toEqual({
            error: 'This legacy API route has been retired',
            code: 'legacy_workspace_retired'
        });
        expect(response.text).not.toContain('parseStaticWebAppsPrincipal');
    });

    test.each([
        ['/scoping', 200],
        ['/support', 200],
        ['/operator', 200],
        ['/api/sales/bootstrap', 200],
        ['/api/lifecycle/bootstrap', 200],
        ['/api/service-desk/bootstrap', 200],
        ['/api/datto-rmm/status', 200],
        ['/api/account', 410],
        ['/api/billing/checkout', 410]
    ])('preserves %s with status %i', async (route, status) => {
        expect((await request(app).get(route)).status).toBe(status);
    });

    test.each([
        ['/service-desk', '/support', 302],
        ['/mssp', '/scoping', 302],
        ['/CloudPC.html', '/scoping', 301],
        ['/share/not-a-token', '/', 302]
    ])('preserves redirect %s', async (route, location, status) => {
        const response = await request(app).get(route);
        expect(response.status).toBe(status);
        expect(response.headers.location).toBe(location);
    });

    test('ignores a forged Static Web Apps principal in BFF mode', async () => {
        const keys = [
            'NOFRIES_REQUIRE_AUTH',
            'NOFRIES_BROWSER_AUTH_MODE',
            'NOFRIES_BROWSER_SESSION_STORE',
            'NOFRIES_BROWSER_AUTH_STORAGE_ACCOUNT',
            'AZURE_STORAGE_ACCOUNT_NAME'
        ];
        const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
        Object.assign(process.env, {
            NOFRIES_REQUIRE_AUTH: 'true',
            NOFRIES_BROWSER_AUTH_MODE: 'entra_bff',
            NOFRIES_BROWSER_SESSION_STORE: 'azure',
            NOFRIES_BROWSER_AUTH_STORAGE_ACCOUNT: 'nofriesauthdev123',
            AZURE_STORAGE_ACCOUNT_NAME: 'nofriesdatadev123'
        });
        resetRequestIdentityForTests();
        try {
            const forgedPrincipal = Buffer.from(JSON.stringify({
                identityProvider: 'aad',
                userId: 'forged-user',
                userDetails: 'admin@example.test'
            })).toString('base64');
            const response = await request(app)
                .get('/api/sales/bootstrap')
                .set('x-ms-client-principal', forgedPrincipal);
            expect(response.status).toBe(401);
            expect(response.body.code).toBe('authentication_required');
        } finally {
            keys.forEach((key) => {
                if (previous[key] === undefined) delete process.env[key];
                else process.env[key] = previous[key];
            });
            resetRequestIdentityForTests();
        }
    });
});
