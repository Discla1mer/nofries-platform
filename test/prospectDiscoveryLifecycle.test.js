const fs = require('fs');
const os = require('os');
const path = require('path');
const { createProspectAgent } = require('../api/shared/agents/prospectAgent');
const { createLifecycleRepository } = require('../api/shared/appLifecycle/lifecycleRepository');
const { createLifecycleService } = require('../api/shared/appLifecycle/lifecycleService');
const { createPublicAgentAccess } = require('../api/shared/lifecycle/prospectSession');
const scenario = require('../evals/prospect-discovery.json').scenarios
    .find(item => item.id === 'core_identity_and_environment');

// Real lifecycle persistence and permissions; only the provider is injected.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-discovery-causal-'));
const env = {
    NOFRIES_DEFAULT_TENANT_ID: 'synthetic-discovery-tenant',
    NOFRIES_TENANT_NAME: 'Synthetic discovery tests',
    NOFRIES_PROSPECT_AGENT_RUNTIME: 'openai',
    OPENAI_API_KEY: 'synthetic-injected-client-never-sent',
    NOFRIES_PUBLIC_URL: 'https://nofries.example.test'
};
let sequence = 0;
const call = (name, args) => ({
    type: 'function_call', call_id: `synthetic-${name}`, name, arguments: JSON.stringify(args)
});
const contextOnly = [call('update_prospect_context', { facts: [] })];
const company = { field: 'company.name', value: 'Alpine Studio', certainty: 'explicit' };
const reason = { field: 'company.summary', value: 'We need more reliable IT support.', certainty: 'explicit' };

async function fixture(options = {}) {
    const id = ++sequence;
    const repository = createLifecycleRepository({ provider: 'local', dataDir: path.join(dataDir, String(id)) });
    const service = createLifecycleService({ repository, env });
    const access = createPublicAgentAccess(env);
    const sessionHash = String(id).padStart(64, '0');
    await service.ensureProspectSession(access, sessionHash, { channel: 'text' });
    if (options.facts) {
        await service.executeProspectTool(access, sessionHash, 'update_prospect_context', { facts: options.facts });
    }
    if (options.discovery) {
        await service.executeProspectTool(access, sessionHash, 'advance_lifecycle', { targetState: 'discovery' });
    }
    const execute = service.executeProspectTool.bind(service);
    let failAdvance = options.failAdvanceOnce === true;
    let loseAdvanceResponse = options.loseAdvanceResponseOnce === true;
    const tools = jest.spyOn(service, 'executeProspectTool').mockImplementation(async (...args) => {
        if (args[2] === 'advance_lifecycle' && failAdvance) {
            failAdvance = false;
            throw new Error('synthetic transition unavailable');
        }
        const result = await execute(...args);
        if (args[2] === 'advance_lifecycle' && loseAdvanceResponse) {
            loseAdvanceResponse = false;
            throw new Error('synthetic transition acknowledgement lost');
        }
        return result;
    });
    const create = jest.fn(async () => {
        if (options.beforeProvider) await options.beforeProvider({ service, access, sessionHash });
        if (options.providerError) throw options.providerError;
        return { requestId: 'synthetic-discovery-request', body: {
            model: 'synthetic-injected-model', output: options.output || contextOnly, usage: {}
        } };
    });
    const stream = jest.fn(async (_request, handlers) => {
        await handlers.onEvent({ type: 'response.output_text.delta', delta: 'About how many devices need support?' });
        await handlers.onEvent({ type: 'response.completed', response: { model: 'synthetic-injected-model', usage: {} } });
        return { requestId: 'synthetic-discovery-stream' };
    });
    const agent = createProspectAgent({ lifecycleService: service, access, sessionHash, env,
        openaiClient: { create, stream }, releaseIdentity: null });
    async function stored() {
        const state = await repository.read(access);
        return { state, organisation: state.organisations[0], conversation: state.conversations[0] };
    }
    const append = (role, text) => service.appendProspectMessage(access, sessionHash, role, text);
    return { agent, tools, create, stream, stored, append };
}

let fetch;
beforeEach(() => {
    fetch = jest.spyOn(global, 'fetch').mockImplementation(async () => {
        throw new Error('Network is forbidden in this injected-provider regression');
    });
});
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); fetch.mockRestore(); });
afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));
const advances = f => f.tools.mock.calls.filter(args => args[2] === 'advance_lifecycle');

describe('live prospect discovery is persisted when enquiry prerequisites become known', () => {
    test.each([
        ['a context-only tool response', contextOnly],
        ['the existing no-tool fallback', []]
    ])('retains the unchanged evaluation scenario with %s', async (_label, output) => {
        const f = await fixture({ output });
        const result = await f.agent.runTurn({ message: scenario.turns[0] });
        const stored = await f.stored();
        expect(stored.organisation.lifecycleState).toBe(scenario.expect.lifecycleState);
        expect(result.organisation.lifecycleState).toBe(scenario.expect.lifecycleState);
        expect(stored.organisation.context.company.name).toBe(scenario.expect.facts['company.name']);
        expect(stored.organisation.context.contacts.primary.name).toBe(scenario.expect.facts['contacts.primary.name']);
        expect(stored.organisation.context.users.estimatedCount).toBe(scenario.expect.facts['users.estimatedCount']);
        expect(stored.organisation.context.productivity.platform).toBe(scenario.expect.facts['productivity.platform']);
        expect(stored.organisation.fieldStates['endpoints.estimatedCount'].status).toBe('unknown');
        expect((result.text.match(/\?/g) || []).length).toBeLessThanOrEqual(scenario.expect.maxQuestionsPerReply);
        expect(stored.state.operatorTasks).toHaveLength(0);
        expect(advances(f)).toHaveLength(1);
    });

    test.each([
        ['company', [reason], 'I work at Alpine Studio.'],
        ['reason', [company], 'We need more reliable IT support.']
    ])('advances when the missing %s is supplied this turn', async (_label, facts, message) => {
        const f = await fixture({ facts });
        await f.agent.runTurn({ message });
        expect((await f.stored()).organisation.lifecycleState).toBe('discovery');
        expect(advances(f)).toHaveLength(1);
    });

    test('uses the persisted prerequisite added by an accepted model context tool', async () => {
        const f = await fixture({ facts: [company], output: [call('update_prospect_context', { facts: [reason] })] });
        await f.agent.runTurn({ message: 'Support has become difficult.' });
        expect((await f.stored()).organisation.lifecycleState).toBe('discovery');
        expect(advances(f)).toHaveLength(1);
    });

    test('does not repeat an advance already performed by the model', async () => {
        const f = await fixture({ output: contextOnly.concat(call('advance_lifecycle', {
            targetState: 'discovery', reason: 'Organisation and enquiry are known'
        })) });
        await f.agent.runTurn({ message: scenario.turns[0] });
        expect((await f.stored()).organisation.lifecycleState).toBe('discovery');
        expect(advances(f)).toHaveLength(1);
    });

    test('leaves an existing discovery unchanged', async () => {
        const f = await fixture({ facts: [company, reason], discovery: true });
        await f.agent.runTurn({ message: scenario.turns[0] });
        expect((await f.stored()).organisation.lifecycleState).toBe('discovery');
        expect(advances(f)).toHaveLength(0);
    });

    test.each([
        'We need more reliable IT support.',
        'My name is Jamie and I work at Alpine Studio.'
    ])('keeps unknown prerequisites in prospect: %s', async message => {
        const f = await fixture();
        await f.agent.runTurn({ message });
        expect((await f.stored()).organisation.lifecycleState).toBe('prospect');
        expect(advances(f)).toHaveLength(0);
    });

    test.each([
        'Can someone contact me please?',
        'I want you to call me.',
        'I would like you to contact me.',
        'What does managed IT support cover?'
    ])('preserves a staged-known prospect for an unrelated turn: %s', async message => {
        const f = await fixture({ facts: [company, reason] });
        await f.agent.runTurn({ message });
        const stored = await f.stored();
        expect(stored.organisation.lifecycleState).toBe('prospect');
        expect(stored.state.operatorTasks).toHaveLength(0);
        expect(advances(f)).toHaveLength(0);
    });

    test('does not turn a contact-only request into a discovery task when its company is known', async () => {
        const f = await fixture({ facts: [company] });
        await f.agent.runTurn({ message: 'I want you to call me.' });
        const stored = await f.stored();
        expect(stored.organisation.lifecycleState).toBe('prospect');
        expect(stored.state.operatorTasks).toHaveLength(0);
        expect(advances(f)).toHaveLength(0);
    });

    test.each([
        'What does managed IT support cover?',
        'I want to know what managed IT support covers.',
        'I would like to learn about managed IT support.'
    ])('does not infer failed discovery from a repeated stored public question: %s', async message => {
        const f = await fixture({ facts: [company, { ...reason, value: message }] });
        await f.agent.runTurn({ message });
        const stored = await f.stored();
        expect(stored.organisation.lifecycleState).toBe('prospect');
        expect(stored.state.operatorTasks).toHaveLength(0);
        expect(advances(f)).toHaveLength(0);
    });

    test('does not alias a different long message to the recorded reason prefix', async () => {
        const prefix = ('We need more reliable IT support. ' + 'x'.repeat(500)).slice(0, 500);
        const f = await fixture({ facts: [company, { ...reason, value: prefix }] });
        await f.agent.runTurn({ message: prefix + ' This is different input.' });
        expect((await f.stored()).organisation.lifecycleState).toBe('prospect');
        expect(advances(f)).toHaveLength(0);
    });

    test.each([
        'I want to know what managed IT support covers.',
        'I would like to learn about managed IT support.',
        'I would like information about managed IT support.',
        'We are looking for information about managed IT support.'
    ])('holds informational input when its summary first becomes known: %s', async message => {
        const f = await fixture({ facts: [company], output: [call('update_prospect_context', {
            facts: [{ ...reason, value: message }]
        })] });
        await f.agent.runTurn({ message });
        const stored = await f.stored();
        expect(stored.organisation.fieldStates['company.summary'].status).toBe('known');
        expect(stored.organisation.lifecycleState).toBe('prospect');
        expect(stored.state.operatorTasks).toHaveLength(0);
        expect(advances(f)).toHaveLength(0);
    });

    test('does not infer an unanswered turn from a matching stored reason alone', async () => {
        const f = await fixture({ facts: [company, reason] });
        await f.agent.runTurn({ message: reason.value });
        expect((await f.stored()).organisation.lifecycleState).toBe('prospect');
        expect(advances(f)).toHaveLength(0);
    });

    test.each([
        ['an intervening assistant', 'assistant', 'Synthetic earlier answer.'],
        ['a different unanswered user', 'user', 'A different enquiry.']
    ])('does not treat %s as the same unanswered input', async (_label, role, text) => {
        const f = await fixture({ facts: [company, reason] });
        await f.append('user', reason.value);
        await f.append(role, text);
        await f.agent.runTurn({ message: reason.value });
        expect((await f.stored()).organisation.lifecycleState).toBe('prospect');
        expect(advances(f)).toHaveLength(0);
    });

    test('rechecks unanswered input after tools when an assistant reply intervenes', async () => {
        const f = await fixture({ facts: [company, reason], beforeProvider: async ({ service, access, sessionHash }) => {
            await service.appendProspectMessage(access, sessionHash, 'assistant', 'Synthetic concurrent answer.');
        } });
        await f.append('user', reason.value);
        await f.agent.runTurn({ message: reason.value });
        expect((await f.stored()).organisation.lifecycleState).toBe('prospect');
        expect(advances(f)).toHaveLength(0);
    });

    test('keeps earlier pricing history out of the current enquiry hold', async () => {
        const pricing = require('../evals/prospect-discovery.json').scenarios
            .find(item => item.id === 'multi_turn_pricing_uses_server_policy');
        const f = await fixture();
        await f.agent.runTurn({ message: pricing.turns[0] });
        expect((await f.stored()).organisation.lifecycleState).toBe('prospect');
        const result = await f.agent.runTurn({ message: pricing.turns[1] });
        expect((await f.stored()).organisation.lifecycleState).toBe(pricing.expect.lifecycleState);
        expect(result.text).toContain(pricing.expect.replyMustInclude[0]);
        expect(advances(f)).toHaveLength(1);
    });

    test('propagates a provider error without a successful reply or transition', async () => {
        const error = new Error('synthetic provider unavailable');
        const f = await fixture({ providerError: error });
        await expect(f.agent.runTurn({ message: scenario.turns[0] })).rejects.toBe(error);
        const stored = await f.stored();
        expect(stored.organisation.lifecycleState).toBe('prospect');
        expect(stored.organisation.fieldStates['company.summary'].status).toBe('known');
        expect(f.stream).not.toHaveBeenCalled();
        expect(stored.conversation.messages.filter(item => item.role === 'assistant')).toHaveLength(0);
    });

    test('fails closed on transition failure and safely retries the same enquiry', async () => {
        const f = await fixture({ facts: [company], failAdvanceOnce: true });
        const message = 'We need more reliable IT support.';
        await expect(f.agent.runTurn({ message })).rejects.toThrow('synthetic transition unavailable');
        const failed = await f.stored();
        expect(failed.organisation.lifecycleState).toBe('prospect');
        expect(failed.organisation.fieldStates['company.summary'].status).toBe('known');
        expect(f.stream).not.toHaveBeenCalled();
        expect(failed.conversation.messages.filter(item => item.role === 'assistant')).toHaveLength(0);
        await f.agent.runTurn({ message });
        expect((await f.stored()).organisation.lifecycleState).toBe('discovery');
        expect(advances(f)).toHaveLength(2);
        expect(f.stream).toHaveBeenCalledTimes(1);
    });

    test('does not duplicate a committed transition after its acknowledgement is lost', async () => {
        const f = await fixture({ loseAdvanceResponseOnce: true });
        await expect(f.agent.runTurn({ message: scenario.turns[0] }))
            .rejects.toThrow('synthetic transition acknowledgement lost');
        expect((await f.stored()).organisation.lifecycleState).toBe('discovery');
        expect(f.stream).not.toHaveBeenCalled();
        await f.agent.runTurn({ message: scenario.turns[0] });
        expect((await f.stored()).organisation.lifecycleState).toBe('discovery');
        expect(advances(f)).toHaveLength(1);
        expect(f.stream).toHaveBeenCalledTimes(1);
    });

    test('recovers a full identical unanswered enquiry longer than the recorded summary', async () => {
        const f = await fixture({ facts: [company], failAdvanceOnce: true });
        const message = reason.value + ' ' + 'x'.repeat(600);
        await expect(f.agent.runTurn({ message })).rejects.toThrow('synthetic transition unavailable');
        await f.agent.runTurn({ message });
        expect((await f.stored()).organisation.lifecycleState).toBe('discovery');
        expect(advances(f)).toHaveLength(2);
    });
});
