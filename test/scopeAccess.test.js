const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const {
    MemoryChallengeStore,
    ScopeAccessError,
    createScopeAccessService
} = require('../api/shared/scopeAccess');
const { getServiceScope } = require('../api/shared/serviceScope');

describe('verified managed IT service scope', () => {
    const secret = 'test-scope-secret-that-is-longer-than-thirty-two-characters';

    test('emails a code without returning either verification credential to the browser', async () => {
        const sent = [];
        const service = createScopeAccessService({
            secret,
            store: new MemoryChallengeStore(),
            sendEmail: async (message) => sent.push(message),
            publicUrl: 'https://nofries.nz'
        });

        const result = await service.requestAccess({
            email: '  Person@Example.co.nz ',
            ip: '192.0.2.1'
        });

        expect(result.challengeId).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(result.emailHint).toContain('@example.co.nz');
        expect(result).not.toHaveProperty('code');
        expect(result).not.toHaveProperty('token');
        expect(sent).toHaveLength(1);
        expect(sent[0].email).toBe('person@example.co.nz');
        expect(sent[0].code).toMatch(/^\d{6}$/);
        expect(sent[0].verificationUrl).toContain('/api/scope/verify?');
        expect(sent[0].verificationUrl).not.toContain(sent[0].code);
    });

    test('accepts the emailed code once and issues a signed HttpOnly access cookie', async () => {
        const sent = [];
        const store = new MemoryChallengeStore();
        const service = createScopeAccessService({
            secret,
            store,
            sendEmail: async (message) => sent.push(message)
        });
        const requested = await service.requestAccess({ email: 'person@example.co.nz', ip: '192.0.2.2' });

        expect(store.verifiedInterests.size).toBe(0);

        await expect(service.verifyAccess({
            challengeId: requested.challengeId,
            code: '111111'
        })).rejects.toMatchObject({ code: 'code_invalid', status: 400 });
        expect(store.verifiedInterests.size).toBe(0);

        const verified = await service.verifyAccess({
            challengeId: requested.challengeId,
            code: sent[0].code
        });
        expect(verified.cookie).toContain('HttpOnly');
        expect(verified.cookie).toContain('Secure');
        expect(verified.cookie).toContain('SameSite=Strict');
        const tokenPayload = JSON.parse(Buffer.from(verified.accessToken.split('.')[0], 'base64url').toString('utf8'));
        expect(tokenPayload.version).toBe(2);
        expect(tokenPayload.audience).toBe('nofries-service-scope');
        expect(tokenPayload.emailHint).toContain('@example.co.nz');
        expect(JSON.stringify(tokenPayload)).not.toContain('person@example.co.nz');
        expect([...store.verifiedInterests.values()]).toEqual([expect.objectContaining({
            email: 'person@example.co.nz',
            source: 'standard-service-scope'
        })]);

        const viewer = service.authorize({ cookie: verified.cookie });
        expect(viewer.email).toBe('');
        expect(viewer.emailHint).toContain('@example.co.nz');

        const viewerWithPlatformAuthorization = service.authorize({
            cookie: verified.cookie,
            authorization: 'Bearer unrelated-azure-platform-token'
        });
        expect(viewerWithPlatformAuthorization.emailHint).toContain('@example.co.nz');

        expect(() => service.authorize({
            authorization: `Bearer ${verified.accessToken}`
        })).toThrow(expect.objectContaining({ code: 'scope_access_required' }));

        await expect(service.verifyAccess({
            challengeId: requested.challengeId,
            code: sent[0].code
        })).rejects.toMatchObject({ code: 'challenge_missing', status: 404 });
    });

    test('accepts the emailed confirmation link once', async () => {
        const sent = [];
        const service = createScopeAccessService({
            secret,
            store: new MemoryChallengeStore(),
            sendEmail: async (message) => sent.push(message),
            publicUrl: 'https://nofries.nz'
        });
        const requested = await service.requestAccess({ email: 'link@example.co.nz', ip: '192.0.2.3' });
        const link = new URL(sent[0].verificationUrl);

        const verified = await service.verifyAccess({
            challengeId: link.searchParams.get('id'),
            linkToken: link.searchParams.get('token')
        });
        expect(service.authorize({ cookie: verified.cookie }).emailHint).toContain('@example.co.nz');

        await expect(service.verifyAccess({
            challengeId: requested.challengeId,
            linkToken: link.searchParams.get('token')
        })).rejects.toBeInstanceOf(ScopeAccessError);
    });

    test('expires verification challenges and later scope access', async () => {
        let currentTime = Date.parse('2026-08-12T00:00:00Z');
        const sent = [];
        const service = createScopeAccessService({
            secret,
            store: new MemoryChallengeStore(),
            sendEmail: async (message) => sent.push(message),
            now: () => currentTime,
            challengeTtlMs: 60 * 1000,
            accessTtlMs: 2 * 60 * 1000
        });
        const requested = await service.requestAccess({ email: 'expiry@example.co.nz', ip: '192.0.2.4' });
        currentTime += 61 * 1000;

        await expect(service.verifyAccess({
            challengeId: requested.challengeId,
            code: sent[0].code
        })).rejects.toMatchObject({ code: 'challenge_expired', status: 410 });

        currentTime = Date.parse('2026-08-12T01:00:00Z');
        const second = await service.requestAccess({ email: 'expiry@example.co.nz', ip: '192.0.2.4' });
        const verified = await service.verifyAccess({ challengeId: second.challengeId, code: sent[1].code });
        currentTime += 121 * 1000;
        expect(() => service.authorize({ cookie: verified.cookie })).toThrow(expect.objectContaining({ code: 'scope_access_expired' }));
    });

    test('keeps the detailed service schedule out of the public static bundle', () => {
        const scope = getServiceScope();
        expect(scope.sections).toHaveLength(7);
        expect(scope.sections.map((section) => section.title)).toContain('Getting started and service checks');
        const gettingStarted = scope.sections.find((section) => section.title === 'Getting started and service checks');
        const representativeDevices = gettingStarted.items.find((item) => item.name === 'Test representative devices');
        expect(representativeDevices.included).toContain('agreed representative group');
        expect(representativeDevices.included).toContain('environment and rollout risk');
        expect(representativeDevices.included).not.toContain('up to two');

        execFileSync(process.execPath, ['scripts/build-static.js'], { cwd: path.resolve(__dirname, '..') });
        const dist = path.resolve(__dirname, '..', 'dist');
        expect(fs.existsSync(path.join(dist, 'scope.html'))).toBe(true);
        expect(fs.existsSync(path.join(dist, 'js', 'scope-access.js'))).toBe(true);
        const publicBundle = fs.readdirSync(dist, { recursive: true })
            .filter((entry) => fs.statSync(path.join(dist, entry)).isFile())
            .map((entry) => fs.readFileSync(path.join(dist, entry), 'utf8'))
            .join('\n');
        expect(publicBundle).not.toContain('Social messages and requests sent to personal accounts');
        expect(publicBundle).not.toContain('NOFRIES_SCOPE_SIGNING_SECRET');
    });
});