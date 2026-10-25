const {
    handleProspectChatRequest,
    isTrivialOpening,
    normaliseProspectClientAddress
} = require('../api/shared/prospectRuntime');
const {
    createProspectSessionManager,
    createPublicAgentAccess
} = require('../api/shared/lifecycle/prospectSession');
const { createLifecycleRepository } = require('../api/shared/lifecycle/lifecycleRepository');
const { createLifecycleService } = require('../api/shared/lifecycle/lifecycleService');

const env = {
    NOFRIES_DEFAULT_TENANT_ID: 'prospect-abuse-test',
    NOFRIES_TENANT_NAME: 'No Fries',
    NOFRIES_PROSPECT_SIGNING_SECRET: 'prospect-abuse-test-secret-longer-than-thirty-two-characters',
    NOFRIES_PROSPECT_AGENT_RUNTIME: 'mock',
    NOFRIES_PUBLIC_URL: 'https://nofries.nz',
    NODE_ENV: 'production'
};

function request(message, cookie = '') {
    return {
        method: 'POST',
        headers: {
            cookie,
            'content-type': 'application/json',
            'sec-fetch-site': 'same-origin',
            'x-forwarded-for': '203.0.113.44'
        },
        body: { message }
    };
}

function pendingLifecycle() {
    return {
        findProspectSession: jest.fn().mockResolvedValue(null),
        ensureProspectSession: jest.fn()
    };
}

describe('public prospect admission protection', () => {
    test('a chat POST without the bootstrap cookie cannot create a prospect or call the model', async () => {
        const lifecycleService = pendingLifecycle();
        const agentFactory = jest.fn();
        const result = await handleProspectChatRequest(request('We need help replacing our IT provider'), {
            env,
            lifecycleService,
            access: createPublicAgentAccess(env),
            sessionManager: createProspectSessionManager({ env }),
            agentFactory
        });

        expect(result.status).toBe(200);
        expect(result.headers['Set-Cookie']).toMatch(/^__Host-nf_prospect_session=/);
        expect(result.body).toContain('session_bootstrap_required');
        expect(lifecycleService.ensureProspectSession).not.toHaveBeenCalled();
        expect(agentFactory).not.toHaveBeenCalled();
    });

    test('a trivial first greeting is answered without persistence or model work', async () => {
        const lifecycleService = pendingLifecycle();
        const sessionManager = createProspectSessionManager({ env });
        const browser = sessionManager.create();
        const agentFactory = jest.fn();
        const result = await handleProspectChatRequest(request('Hi!', browser.cookie), {
            env,
            lifecycleService,
            access: createPublicAgentAccess(env),
            sessionManager,
            agentFactory
        });

        expect(result.status).toBe(200);
        expect(result.body).toContain('deterministic-welcome');
        expect(result.body).toContain('what you would like to improve');
        expect(lifecycleService.ensureProspectSession).not.toHaveBeenCalled();
        expect(agentFactory).not.toHaveBeenCalled();
    });

    test('prospect admission keys normalise addresses without retaining raw IPv6 host identifiers', () => {
        expect(normaliseProspectClientAddress('203.0.113.44')).toBe('203.0.113.44');
        expect(normaliseProspectClientAddress('2001:db8:1234:5678:abcd:ef01:2345:6789')).toBe('2001:0db8:1234:5678::/64');
        expect(normaliseProspectClientAddress('not-an-ip')).toBe('unknown');
        expect(isTrivialOpening('Kia ora')).toBe(true);
        expect(isTrivialOpening('Price managed IT for 20 users')).toBe(false);
    });

    test('the shared lifecycle store caps new records while existing signed sessions keep working', async () => {
        const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-prospect-admission-'));
        const repository = createLifecycleRepository({ provider: 'local', dataDir });
        const service = createLifecycleService({
            repository,
            now: () => new Date('2026-08-20T00:00:00.000Z')
        });
        const access = createPublicAgentAccess(env);
        const clientKeyHash = 'a'.repeat(64);
        const admission = {
            clientKeyHash,
            burstWindowMs: 600000,
            burstMax: 2,
            clientWindowMs: 86400000,
            clientMax: 8,
            globalHourWindowMs: 3600000,
            globalHourMax: 30,
            globalDayWindowMs: 86400000,
            globalDayMax: 100
        };

        try {
            const first = await service.ensureProspectSession(access, 'session-one', { admission });
            await service.ensureProspectSession(access, 'session-two', { admission });
            await expect(service.ensureProspectSession(access, 'session-three', { admission })).rejects.toMatchObject({
                statusCode: 429,
                details: {
                    code: 'prospect_creation_limited',
                    retryAfterSeconds: 600
                }
            });

            const resumed = await service.ensureProspectSession(access, 'session-one', { admission });
            expect(resumed.conversation.id).toBe(first.conversation.id);

            const stored = await repository.read(access);
            expect(stored.organisations).toHaveLength(2);
            expect(stored.prospectAdmissions).toHaveLength(2);
            expect(JSON.stringify(stored.prospectAdmissions)).not.toContain('203.0.113.44');
            expect(stored.prospectAdmissions.every((item) => item.clientKeyHash === clientKeyHash)).toBe(true);
        } finally {
            fs.rmSync(dataDir, { recursive: true, force: true });
        }
    });
});
const fs = require('fs');
const os = require('os');
const path = require('path');
