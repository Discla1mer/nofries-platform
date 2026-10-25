const { handleProspectChatRequest } = require('../api/shared/prospectRuntime');
const {
    createProspectSessionManager,
    createPublicAgentAccess
} = require('../api/shared/lifecycle/prospectSession');

const env = {
    NOFRIES_DEFAULT_TENANT_ID: 'prospect-telemetry-identity-test',
    NOFRIES_TENANT_NAME: 'No Fries',
    NOFRIES_PROSPECT_SIGNING_SECRET: 'prospect-telemetry-test-secret-longer-than-thirty-two-characters',
    NOFRIES_PROSPECT_AGENT_RUNTIME: 'openai',
    OPENAI_API_KEY: 'server-only-test-key',
    NOFRIES_PUBLIC_URL: 'https://nofries.nz',
    NODE_ENV: 'production'
};

function request(message, cookie) {
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

describe('prospect runtime telemetry identity', () => {
    test('preserves configured and provider model identities in the done event', async () => {
        const sessionManager = createProspectSessionManager({ env });
        const browser = sessionManager.create();
        const identities = {
            promptVersion: 'prospect-v4',
            toolSchemaVersion: 'prospect-tools-v1',
            policyId: 'managed_it_2026_08_4',
            model: 'gpt-5.6-luna',
            releaseSha: 'a'.repeat(40)
        };
        const session = {
            conversation: { id: 'conversation_1', messages: [] },
            organisation: { context: {} }
        };
        const lifecycleService = {
            findProspectSession: jest.fn().mockResolvedValue(session)
        };
        const agentFactory = jest.fn(() => ({
            runTurn: jest.fn().mockResolvedValue({
                text: 'Thanks — what prompted the review?',
                runtime: { mode: 'openai', label: 'Live assistant', liveModel: true, reason: '' },
                model: 'gpt-5.6-luna',
                providerModel: 'gpt-5.6-luna-2026-08-01',
                identities,
                usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
                approximateCostUsd: 0.000008,
                traceId: 'request_first:request_stream',
                conversation: session.conversation,
                organisation: session.organisation
            })
        }));
        const events = [];

        const response = await handleProspectChatRequest(
            request('We need better IT support.', browser.cookie),
            {
                env,
                lifecycleService,
                access: createPublicAgentAccess(env),
                sessionManager,
                agentFactory,
                onEvent: async (frame, event, data) => events.push({ event, data })
            }
        );

        expect(response.status).toBe(200);
        expect(events.find((event) => event.event === 'done').data).toMatchObject({
            model: 'gpt-5.6-luna',
            providerModel: 'gpt-5.6-luna-2026-08-01',
            identities
        });
    });
});
