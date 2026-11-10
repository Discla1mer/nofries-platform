const { handleProspectChatRequest } = require('../api/shared/prospectRuntime');
const {
    createProspectSessionManager,
    createPublicAgentAccess
} = require('../api/shared/lifecycle/prospectSession');

const env = {
    NOFRIES_DEFAULT_TENANT_ID: 'prospect-tier-pricing-test',
    NOFRIES_TENANT_NAME: 'No Fries',
    NOFRIES_PROSPECT_SIGNING_SECRET: 'prospect-tier-pricing-test-secret-longer-than-thirty-two-characters',
    NOFRIES_PROSPECT_AGENT_RUNTIME: 'openai',
    OPENAI_API_KEY: 'server-only-test-key',
    NOFRIES_PUBLIC_URL: 'https://nofries.nz',
    NODE_ENV: 'production'
};

function request(body, cookie) {
    return {
        method: 'POST',
        headers: {
            cookie,
            'content-type': 'application/json',
            'sec-fetch-site': 'same-origin',
            'x-forwarded-for': '203.0.113.51'
        },
        body
    };
}

function twoUserContext(extra = {}) {
    return Object.assign({
        users: { estimatedCount: 2 },
        endpoints: { estimatedCount: 2 },
        locations: { items: ['Auckland'] }
    }, extra);
}

async function run(body, runTurnResult) {
    const sessionManager = createProspectSessionManager({ env });
    const browser = sessionManager.create();
    const session = {
        conversation: { id: 'conversation_1', messages: [] },
        organisation: { context: {} }
    };
    const runTurn = jest.fn().mockResolvedValue(runTurnResult);
    const lifecycleService = {
        findProspectSession: jest.fn().mockResolvedValue(session),
        recordProspectSelectedTier: jest.fn().mockResolvedValue(null),
        appendProspectMessage: jest.fn().mockResolvedValue(null)
    };
    const agentFactory = jest.fn(() => ({ runTurn }));
    const events = [];
    const response = await handleProspectChatRequest(request(body, browser.cookie), {
        env,
        lifecycleService,
        access: createPublicAgentAccess(env),
        sessionManager,
        agentFactory,
        onEvent: async (frame, event, data) => events.push({ event, data })
    });
    return { response, events, runTurn, lifecycleService };
}

describe('prospect chat tier-aware pricing', () => {
    test('quotes the visitor-selected Essentials tier when the agent gave no price', async () => {
        const { response, events, runTurn } = await run(
            { message: 'what is the price', tier: 'essentials' },
            {
                text: 'Happy to help — here is some detail on our managed IT service.',
                runtime: { mode: 'openai', label: 'Live assistant', liveModel: true, reason: '' },
                model: 'gpt-5.6-luna',
                conversation: { id: 'conversation_1', messages: [] },
                organisation: { context: twoUserContext() }
            }
        );

        expect(response.status).toBe(200);
        expect(runTurn).toHaveBeenCalledWith(expect.objectContaining({ tier: 'essentials' }));
        const done = events.find((event) => event.event === 'done').data;
        expect(done.text).toContain('On the Essentials plan');
        expect(done.text).toContain('NZ$150 + GST per month');
        expect(done.text).not.toContain('$240');
    });

    test('corrects a reply that already quotes the wrong (Managed) tier amount', async () => {
        const stale = 'On the Managed plan, based on 2 users, 2 devices and 1 location, the current No Fries estimate is NZ$240 + GST per month (NZ$120 + GST per user), with initial set-up from NZ$750 + GST.';
        const { response, events } = await run(
            { message: 'what is the price', tier: 'essentials' },
            {
                text: stale,
                runtime: { mode: 'openai', label: 'Live assistant', liveModel: true, reason: '' },
                model: 'gpt-5.6-luna',
                conversation: { id: 'conversation_1', messages: [] },
                organisation: { context: twoUserContext() }
            }
        );

        expect(response.status).toBe(200);
        const done = events.find((event) => event.event === 'done').data;
        expect(done.text).toContain('On the Essentials plan');
        expect(done.text).toContain('NZ$150 + GST per month');
        expect(done.text).not.toContain('NZ$240 + GST per month');
    });

    test('falls back to the tier stored in prospect context when no tier is sent', async () => {
        const { response, events, runTurn, lifecycleService } = await run(
            { message: 'what is the price' },
            {
                text: 'Here is some detail on our managed IT service.',
                runtime: { mode: 'openai', label: 'Live assistant', liveModel: true, reason: '' },
                model: 'gpt-5.6-luna',
                conversation: { id: 'conversation_1', messages: [] },
                organisation: { context: twoUserContext({ commercial: { selectedTier: 'secure' } }) }
            }
        );

        expect(response.status).toBe(200);
        expect(runTurn).toHaveBeenCalledWith(expect.objectContaining({ tier: '' }));
        expect(lifecycleService.recordProspectSelectedTier).not.toHaveBeenCalled();
        const done = events.find((event) => event.event === 'done').data;
        expect(done.text).toContain('On the Secure plan');
        expect(done.text).toContain('NZ$330 + GST per month');
    });
});
