const {
    createAutotaskAuthProvider,
    normaliseAutotaskApiBase,
    resolveAutotaskConfig
} = require('../api/shared/serviceDesk/autotaskAuth');

function credentials(overrides = {}) {
    return Object.assign({
        NOFRIES_AUTOTASK_MODE: 'controlled_write',
        NOFRIES_AUTOTASK_WRITE_ENABLED: 'true',
        NOFRIES_AUTOTASK_USERNAME: 'integration@example.test',
        NOFRIES_AUTOTASK_SECRET: 'secret',
        NOFRIES_AUTOTASK_INTEGRATION_CODE: 'integration-code'
    }, overrides);
}

describe('Autotask production authentication admission', () => {
    test('requires both controlled-write mode and the emergency write-enable flag', () => {
        expect(createAutotaskAuthProvider({ env: credentials() }).status().writeOperationsEnabled).toBe(true);
        expect(createAutotaskAuthProvider({
            env: credentials({ NOFRIES_AUTOTASK_WRITE_ENABLED: 'false' })
        }).status().writeOperationsEnabled).toBe(false);
        expect(createAutotaskAuthProvider({
            env: credentials({ NOFRIES_AUTOTASK_MODE: 'readonly' })
        }).status().writeOperationsEnabled).toBe(false);
    });

    test.each([
        'https://127.0.0.1/atservicesrest/v1.0',
        'https://localhost/atservicesrest/v1.0',
        'https://webservices1.autotask.net:8443/atservicesrest/v1.0',
        'https://user:password@webservices1.autotask.net/atservicesrest/v1.0'
    ])('rejects unsafe production provider URL %s', (url) => {
        const config = resolveAutotaskConfig(credentials({
            NOFRIES_AUTOTASK_API_URL: url,
            NOFRIES_AUTOTASK_ALLOWED_HOSTS: '127.0.0.1,localhost'
        }));
        expect(config.configurationError).toMatch(/approved Autotask HTTPS host/);
    });

    test('permits an explicit custom host only in non-production read-only development', () => {
        const config = resolveAutotaskConfig(credentials({
            NODE_ENV: 'development',
            NOFRIES_AUTOTASK_MODE: 'readonly',
            NOFRIES_AUTOTASK_API_URL: 'https://autotask-fixture.test/atservicesrest/v1.0',
            NOFRIES_AUTOTASK_ALLOWED_HOSTS: 'autotask-fixture.test'
        }));
        expect(config.configurationError).toBe('');
        expect(config.apiBase).toBe('https://autotask-fixture.test/atservicesrest/v1.0');
    });

    test('normalises only the official vendor API path on standard HTTPS', () => {
        expect(normaliseAutotaskApiBase('https://webservices1.autotask.net/atservicesrest/v1.0/Tickets'))
            .toBe('https://webservices1.autotask.net/atservicesrest/v1.0');
    });

    test('bounds zone discovery while streaming and keeps its timeout active through the body', async () => {
        const oversizedReader = {
            cancel: jest.fn().mockResolvedValue(undefined),
            releaseLock: jest.fn(),
            read: jest.fn()
                .mockResolvedValueOnce({ done: false, value: Buffer.alloc(200 * 1024) })
                .mockResolvedValueOnce({ done: false, value: Buffer.alloc(100 * 1024) })
        };
        const provider = createAutotaskAuthProvider({
            env: credentials(),
            fetch: jest.fn().mockResolvedValue({
                ok: true,
                status: 200,
                headers: { get: () => null },
                body: { getReader: () => oversizedReader }
            })
        });
        await expect(provider.getApiBase()).rejects.toMatchObject({ details: { code: 'autotask_zone_response_too_large' } });
        expect(oversizedReader.cancel).toHaveBeenCalledTimes(1);

        jest.useFakeTimers();
        let signal;
        const stalledProvider = createAutotaskAuthProvider({
            env: credentials(),
            timeoutMs: 1000,
            fetch: jest.fn(async (url, options) => {
                signal = options.signal;
                return {
                    ok: true,
                    status: 200,
                    headers: { get: () => null },
                    body: {
                        getReader: () => ({
                            cancel: jest.fn().mockResolvedValue(undefined),
                            releaseLock: jest.fn(),
                            read: () => new Promise((resolve, reject) => {
                                signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
                            })
                        })
                    }
                };
            })
        });
        const pending = stalledProvider.getApiBase();
        const assertion = expect(pending).rejects.toMatchObject({ details: { code: 'autotask_zone_timeout' } });
        await jest.advanceTimersByTimeAsync(1000);
        await assertion;
        jest.useRealTimers();
    });
});
