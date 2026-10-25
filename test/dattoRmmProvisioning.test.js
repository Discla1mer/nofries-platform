const { createDattoRmmAuthProvider } = require('../api/shared/integrations/dattoRmmAuthProvider');
const { createDattoRmmProvisioningClient } = require('../api/shared/integrations/dattoRmmProvisioningClient');

describe('Datto RMM controlled onboarding clients', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('OAuth exchange is server-side, secret-free in status and cached until a forced refresh', async () => {
        const apiKey = 'dedicated-api-key';
        const apiSecret = 'dedicated-api-secret';
        const firstToken = 'server-access-token-one';
        const secondToken = 'server-access-token-two';
        const fetch = jest.fn()
            .mockResolvedValueOnce(response({ access_token: firstToken, expires_in: 3600 }))
            .mockResolvedValueOnce(response({ access_token: secondToken, expires_in: 3600 }));
        const auth = createDattoRmmAuthProvider({
            env: controlledWriteEnv({
                NOFRIES_DATTO_RMM_API_KEY: apiKey,
                NOFRIES_DATTO_RMM_API_SECRET: apiSecret
            }),
            fetch,
            now: () => new Date('2026-08-21T01:00:00.000Z')
        });

        const initialStatus = auth.status();
        expect(initialStatus).toMatchObject({
            provider: 'datto_rmm',
            mode: 'controlled_write',
            configured: true,
            authentication: 'api_identity',
            writeOperationsEnabled: true
        });
        expect(JSON.stringify(initialStatus)).not.toContain(apiKey);
        expect(JSON.stringify(initialStatus)).not.toContain(apiSecret);

        await expect(auth.getAccessToken()).resolves.toBe(firstToken);
        await expect(auth.getAccessToken()).resolves.toBe(firstToken);
        expect(fetch).toHaveBeenCalledTimes(1);

        const [tokenUrl, tokenRequest] = fetch.mock.calls[0];
        expect(tokenUrl).toBe('https://vidal-api.centrastage.net/auth/oauth/token');
        expect(tokenRequest).toMatchObject({
            method: 'POST',
            redirect: 'error',
            headers: {
                Accept: 'application/json',
                Authorization: 'Basic cHVibGljLWNsaWVudDpwdWJsaWM=',
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });
        expect(Object.fromEntries(new URLSearchParams(tokenRequest.body))).toEqual({
            grant_type: 'password',
            username: apiKey,
            password: apiSecret
        });

        await expect(auth.getAccessToken({ force: true })).resolves.toBe(secondToken);
        expect(fetch).toHaveBeenCalledTimes(2);
        const finalStatus = JSON.stringify(auth.status());
        expect(finalStatus).not.toContain(apiKey);
        expect(finalStatus).not.toContain(apiSecret);
        expect(finalStatus).not.toContain(firstToken);
        expect(finalStatus).not.toContain(secondToken);
    });

    test('concurrent OAuth refresh callers share one exchange, including callers behind a forced refresh', async () => {
        let resolveRefresh;
        const fetch = jest.fn()
            .mockResolvedValueOnce(response({ access_token: 'cached-access-token', expires_in: 3600 }))
            .mockImplementationOnce(() => new Promise((resolve) => {
                resolveRefresh = resolve;
            }));
        const auth = createDattoRmmAuthProvider({
            env: controlledWriteEnv(),
            fetch,
            now: () => new Date('2026-08-21T01:00:00.000Z')
        });

        await expect(auth.getAccessToken()).resolves.toBe('cached-access-token');
        const forcedRefresh = auth.getAccessToken({ force: true });
        const normalCaller = auth.getAccessToken();
        const secondForcedCaller = auth.getAccessToken({ force: true });

        expect(fetch).toHaveBeenCalledTimes(2);
        resolveRefresh(response({ access_token: 'shared-refreshed-token', expires_in: 3600 }));
        await expect(Promise.all([forcedRefresh, normalCaller, secondForcedCaller])).resolves.toEqual([
            'shared-refreshed-token',
            'shared-refreshed-token',
            'shared-refreshed-token'
        ]);
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    test('a failed shared OAuth exchange is cleared so a later caller can retry', async () => {
        const fetch = jest.fn()
            .mockResolvedValueOnce(response({ error: 'temporary_failure' }, 500))
            .mockResolvedValueOnce(response({ access_token: 'retry-access-token', expires_in: 3600 }));
        const auth = createDattoRmmAuthProvider({
            env: controlledWriteEnv(),
            fetch,
            now: () => new Date('2026-08-21T01:00:00.000Z')
        });

        const firstCaller = auth.getAccessToken();
        const concurrentCaller = auth.getAccessToken();
        await expect(Promise.all([firstCaller, concurrentCaller])).rejects.toMatchObject({
            statusCode: 502,
            details: { code: 'datto_rmm_auth_provider_error' }
        });
        expect(fetch).toHaveBeenCalledTimes(1);

        await expect(auth.getAccessToken()).resolves.toBe('retry-access-token');
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    test('authentication failures do not echo the API key or secret', async () => {
        const apiKey = 'api-key-that-must-not-leak';
        const apiSecret = 'api-secret-that-must-not-leak';
        const auth = createDattoRmmAuthProvider({
            env: controlledWriteEnv({
                NOFRIES_DATTO_RMM_API_KEY: apiKey,
                NOFRIES_DATTO_RMM_API_SECRET: apiSecret
            }),
            fetch: jest.fn(async () => response({ error: 'invalid_grant' }, 401))
        });

        let caught;
        try {
            await auth.getAccessToken();
        } catch (error) {
            caught = error;
        }

        expect(caught).toMatchObject({
            statusCode: 502,
            details: { code: 'datto_rmm_auth_failed' }
        });
        const publicError = `${caught.message} ${JSON.stringify(caught.details)}`;
        expect(publicError).not.toContain(apiKey);
        expect(publicError).not.toContain(apiSecret);
    });

    test('readonly mode prefers renewable API identity credentials over a stale legacy token', async () => {
        const fetch = jest.fn(async () => response({ access_token: 'renewed-api-token', expires_in: 3600 }));
        const auth = createDattoRmmAuthProvider({
            env: {
                NOFRIES_DATTO_RMM_MODE: 'readonly',
                NOFRIES_DATTO_RMM_API_URL: 'https://vidal-api.centrastage.net',
                NOFRIES_DATTO_RMM_API_KEY: 'dedicated-api-key',
                NOFRIES_DATTO_RMM_API_SECRET: 'dedicated-api-secret',
                NOFRIES_DATTO_RMM_ACCESS_TOKEN: 'stale-legacy-token'
            },
            fetch
        });

        await expect(auth.getAccessToken()).resolves.toBe('renewed-api-token');
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(auth.status()).toMatchObject({ authentication: 'api_identity' });
    });

    test('site creation is disabled unless controlled_write is explicitly ready', async () => {
        const fetch = jest.fn();
        const reader = { listSites: jest.fn() };
        const client = createDattoRmmProvisioningClient({
            authProvider: stubAuth({ mode: 'readonly', writeOperationsEnabled: false }),
            fetch,
            reader
        });

        expect(client.status()).toMatchObject({
            mode: 'readonly',
            writeOperationsEnabled: false
        });
        await expect(client.ensureManagedSite({
            name: 'No Fries Headquarters',
            externalKey: 'organisation:no-fries-hq'
        })).rejects.toMatchObject({
            statusCode: 503,
            details: { code: 'datto_rmm_provisioning_disabled' }
        });
        expect(reader.listSites).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
    });

    test('site creation uses only the allow-listed PUT and retains the stable ownership marker', async () => {
        const apiKey = 'not-returned-api-key';
        const apiSecret = 'not-returned-api-secret';
        const accessToken = 'not-returned-access-token';
        const auth = stubAuth({ accessToken });
        const reader = { listSites: jest.fn(async () => ({ sites: [], pages: 1, truncated: false })) };
        const fetch = jest.fn()
            .mockResolvedValueOnce(response({
                site: { uid: 'site-hq-uid', id: 123, name: 'No Fries Headquarters' }
            }))
            .mockResolvedValueOnce(response({
                uid: 'site-hq-uid',
                id: 123,
                name: 'No Fries Headquarters',
                notes: '[nofries:organisation:no-fries-hq]'
            }));
        const client = createDattoRmmProvisioningClient({ authProvider: auth, fetch, reader });

        const created = await client.ensureManagedSite({
            name: 'No Fries Headquarters',
            externalKey: 'ORGANISATION:NO-FRIES-HQ'
        });

        expect(created).toMatchObject({
            created: true,
            site: {
                siteUid: 'site-hq-uid',
                siteId: 123,
                name: 'No Fries Headquarters',
                notes: '[nofries:organisation:no-fries-hq]'
            }
        });
        expect(fetch).toHaveBeenCalledTimes(2);
        const [createUrl, createRequest] = fetch.mock.calls[0];
        expect(createUrl).toBe('https://vidal-api.centrastage.net/api/v2/site');
        expect(createRequest).toMatchObject({
            method: 'PUT',
            redirect: 'error',
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            }
        });
        expect(JSON.parse(createRequest.body)).toMatchObject({
            name: 'No Fries Headquarters',
            notes: '[nofries:organisation:no-fries-hq]',
            onDemand: false,
            splashtopAutoInstall: false
        });
        expect(fetch.mock.calls[1][0]).toBe('https://vidal-api.centrastage.net/api/v2/site/site-hq-uid');
        expect(fetch.mock.calls[1][1].method).toBe('GET');

        const emitted = JSON.stringify(created);
        expect(emitted).not.toContain(apiKey);
        expect(emitted).not.toContain(apiSecret);
        expect(emitted).not.toContain(accessToken);
    });

    test('an exact marked site is reused idempotently without a supplier PUT', async () => {
        const reader = {
            listSites: jest.fn(async () => ({
                sites: [{ siteUid: 'site-hq-uid', siteId: 123, name: '  NO FRIES   HEADQUARTERS ' }],
                pages: 1,
                truncated: false
            }))
        };
        const fetch = jest.fn(async (_url, init) => {
            expect(init.method).toBe('GET');
            return response({
                uid: 'site-hq-uid',
                id: 123,
                name: 'No Fries Headquarters',
                notes: 'Created for pilot [nofries:organisation:no-fries-hq]'
            });
        });
        const client = createDattoRmmProvisioningClient({
            authProvider: stubAuth(),
            fetch,
            reader
        });
        const request = {
            name: 'No Fries Headquarters',
            externalKey: 'organisation:no-fries-hq'
        };

        await expect(client.ensureManagedSite(request)).resolves.toMatchObject({
            created: false,
            site: { siteUid: 'site-hq-uid', siteId: 123 }
        });
        await expect(client.ensureManagedSite(request)).resolves.toMatchObject({
            created: false,
            site: { siteUid: 'site-hq-uid', siteId: 123 }
        });

        expect(reader.listSites).toHaveBeenCalledTimes(2);
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(fetch.mock.calls.some(([, init]) => init.method === 'PUT')).toBe(false);
    });

    test('the existing marked No Fries HQ alias is reused instead of creating a second Headquarters site', async () => {
        const reader = {
            listSites: jest.fn(async () => ({
                sites: [{ siteUid: 'site-hq-uid', siteId: 123, name: 'No Fries HQ' }],
                pages: 1,
                truncated: false
            }))
        };
        const fetch = jest.fn(async (_url, init) => {
            expect(init.method).toBe('GET');
            return response({
                uid: 'site-hq-uid',
                id: 123,
                name: 'No Fries HQ',
                notes: 'Created for pilot [nofries:organisation:no-fries-hq]'
            });
        });
        const client = createDattoRmmProvisioningClient({
            authProvider: stubAuth(),
            fetch,
            reader
        });

        await expect(client.ensureManagedSite({
            name: 'No Fries Headquarters',
            externalKey: 'organisation:no-fries-hq'
        })).resolves.toMatchObject({
            created: false,
            site: { siteUid: 'site-hq-uid', siteId: 123, name: 'No Fries HQ' }
        });
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(fetch.mock.calls.some(([, init]) => init.method === 'PUT')).toBe(false);
    });

    test('ambiguous names and exact unmarked sites fail closed before creation', async () => {
        const ambiguousReader = {
            listSites: jest.fn(async () => ({
                sites: [
                    { siteUid: 'site-one', siteId: 1, name: 'No Fries Headquarters' },
                    { siteUid: 'site-two', siteId: 2, name: 'NO FRIES HEADQUARTERS' }
                ],
                pages: 1,
                truncated: false
            }))
        };
        const ambiguousFetch = jest.fn();
        const ambiguousClient = createDattoRmmProvisioningClient({
            authProvider: stubAuth(),
            fetch: ambiguousFetch,
            reader: ambiguousReader
        });

        await expect(ambiguousClient.ensureManagedSite({
            name: 'No Fries Headquarters',
            externalKey: 'organisation:no-fries-hq'
        })).rejects.toMatchObject({
            statusCode: 409,
            details: { code: 'datto_rmm_site_ambiguous', matchCount: 2 }
        });
        expect(ambiguousFetch).not.toHaveBeenCalled();

        const unmarkedReader = {
            listSites: jest.fn(async () => ({
                sites: [{ siteUid: 'site-existing', siteId: 123, name: 'No Fries Headquarters' }],
                pages: 1,
                truncated: false
            }))
        };
        const unmarkedFetch = jest.fn(async () => response({
            uid: 'site-existing',
            id: 123,
            name: 'No Fries Headquarters',
            notes: '[nofries:organisation:someone-else]'
        }));
        const unmarkedClient = createDattoRmmProvisioningClient({
            authProvider: stubAuth(),
            fetch: unmarkedFetch,
            reader: unmarkedReader
        });

        await expect(unmarkedClient.ensureManagedSite({
            name: 'No Fries Headquarters',
            externalKey: 'organisation:no-fries-hq'
        })).rejects.toMatchObject({
            statusCode: 409,
            details: { code: 'datto_rmm_site_ownership_unverified', siteUid: 'site-existing' }
        });
        expect(unmarkedFetch).toHaveBeenCalledTimes(1);
        expect(unmarkedFetch.mock.calls[0][1].method).toBe('GET');
    });

    test('a mapped site must retain the exact lifecycle ownership marker before installers are issued', async () => {
        const fetch = jest.fn(async () => response({
            uid: 'site-hq-uid',
            id: 123,
            name: 'No Fries Headquarters',
            notes: '[nofries:organisation:another-record]'
        }));
        const client = createDattoRmmProvisioningClient({
            authProvider: stubAuth(),
            fetch,
            reader: { listSites: jest.fn() }
        });

        await expect(client.verifyManagedSite({
            siteUid: 'site-hq-uid',
            name: 'No Fries Headquarters',
            externalKey: 'organisation:no-fries-hq'
        })).rejects.toMatchObject({
            statusCode: 409,
            details: {
                code: 'datto_rmm_site_ownership_unverified',
                siteUid: 'site-hq-uid'
            }
        });
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    test('installer handoffs use the numeric site ID and preserve the Windows/macOS approval boundary', () => {
        const accessToken = 'server-token-that-must-not-be-emitted';
        const client = createDattoRmmProvisioningClient({
            authProvider: stubAuth({ accessToken }),
            fetch: jest.fn(),
            reader: { listSites: jest.fn() }
        });

        const handoffs = client.buildInstallerHandoffs(
            { siteUid: 'site-hq-uid', siteId: 123, name: 'No Fries Headquarters' },
            [
                { deviceId: 'dell-laptop', label: 'Dell laptop', platform: 'windows' },
                { deviceId: 'older-macbook', label: 'Older Apple MacBook', platform: 'macos' }
            ]
        );

        expect(handoffs).toEqual([
            expect.objectContaining({
                deviceId: 'dell-laptop',
                platform: 'windows',
                downloadUrl: 'https://vidal.rmm.datto.com/download-agent/windows/123',
                requiresLocalAdmin: true,
                requiredApprovals: ['Local administrator / UAC approval']
            }),
            expect.objectContaining({
                deviceId: 'older-macbook',
                platform: 'macos',
                downloadUrl: 'https://vidal.rmm.datto.com/download-agent/mac/123',
                requiresLocalAdmin: true,
                requiredApprovals: expect.arrayContaining([
                    'Local administrator approval',
                    'Accessibility',
                    'Full Disk Access',
                    'Screen & System Audio Recording',
                    'Automation → System Events',
                    'Local Network'
                ])
            })
        ]);
        expect(JSON.stringify(handoffs)).not.toContain(accessToken);
    });

    test('unsupported installer platforms are rejected instead of guessed', () => {
        const client = createDattoRmmProvisioningClient({
            authProvider: stubAuth(),
            fetch: jest.fn(),
            reader: { listSites: jest.fn() }
        });

        expect(() => client.buildInstallerHandoffs(
            { siteUid: 'site-hq-uid', siteId: 123 },
            [{ deviceId: 'linux-laptop', platform: 'linux' }]
        )).toThrow(expect.objectContaining({
            statusCode: 409,
            details: {
                code: 'datto_rmm_installer_platform_unsupported',
                deviceId: 'linux-laptop',
                platform: 'linux'
            }
        }));
    });
});

function controlledWriteEnv(overrides = {}) {
    return Object.assign({
        NOFRIES_DATTO_RMM_MODE: 'controlled_write',
        NOFRIES_DATTO_RMM_API_URL: 'https://vidal-api.centrastage.net',
        NOFRIES_DATTO_RMM_INSTALLER_BASE_URL: 'https://vidal.rmm.datto.com',
        NOFRIES_DATTO_RMM_API_KEY: 'dedicated-api-key',
        NOFRIES_DATTO_RMM_API_SECRET: 'dedicated-api-secret'
    }, overrides);
}

function stubAuth(overrides = {}) {
    const accessToken = overrides.accessToken || 'server-only-access-token';
    const mode = overrides.mode || 'controlled_write';
    const configured = overrides.configured !== false;
    const writeOperationsEnabled = overrides.writeOperationsEnabled == null
        ? mode === 'controlled_write' && configured
        : overrides.writeOperationsEnabled;
    return {
        connection: jest.fn(() => ({
            apiBase: 'https://vidal-api.centrastage.net',
            installerBase: 'https://vidal.rmm.datto.com',
            mode,
            renewable: true
        })),
        getAccessToken: jest.fn(async () => accessToken),
        invalidate: jest.fn(),
        status: jest.fn(() => ({
            provider: 'datto_rmm',
            mode,
            readOnly: mode !== 'controlled_write',
            configured,
            state: configured ? 'ready' : 'awaiting_credentials',
            authentication: 'api_identity',
            missing: [],
            writeOperationsEnabled
        }))
    };
}

function response(body, status = 200, headers = {}) {
    const headerMap = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]));
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: {
            get(name) {
                return headerMap.get(String(name || '').toLowerCase()) || null;
            }
        },
        text: jest.fn(async () => text)
    };
}
