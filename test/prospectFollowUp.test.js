const fs = require('fs');
const os = require('os');
const path = require('path');
const { createProspectAgent } = require('../api/shared/agents/prospectAgent');
const { createLifecycleRepository } = require('../api/shared/appLifecycle/lifecycleRepository');
const { createLifecycleService } = require('../api/shared/appLifecycle/lifecycleService');
const { createPublicAgentAccess } = require('../api/shared/lifecycle/prospectSession');

// Exercise the active App lifecycle service and disk-backed local repository.
// Only the model response is injected; no provider, booking or outreach occurs.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-follow-up-causal-'));
const env = {
    NOFRIES_DEFAULT_TENANT_ID: 'synthetic-follow-up-tenant',
    NOFRIES_TENANT_NAME: 'Synthetic Follow-up Tests',
    NOFRIES_PROSPECT_AGENT_RUNTIME: 'openai',
    OPENAI_API_KEY: 'synthetic-injected-client-never-sent',
    NOFRIES_PUBLIC_URL: 'https://nofries.example.test'
};
let sequence = 0;
const actionCall = (type, detail = 'Model-selected next action') => ({
    type: 'function_call', call_id: 'synthetic-action', name: 'suggest_next_action',
    arguments: JSON.stringify({ type, timing: 'When ready', detail })
});

async function fixture(options = {}) {
    const fixtureId = ++sequence;
    const repository = createLifecycleRepository({ provider: 'local', dataDir: path.join(dataDir, String(fixtureId)) });
    let id = 0;
    const service = createLifecycleService({ repository, createId: prefix => `${prefix}_${fixtureId}_${++id}` });
    const access = createPublicAgentAccess(env);
    const sessionHash = String(fixtureId).padStart(64, '0');
    await service.ensureProspectSession(access, sessionHash, { channel: 'text' });
    if (options.seedContext !== false) await service.executeProspectTool(access, sessionHash, 'update_prospect_context', { facts: [
        { field: 'company.name', value: 'Synthetic Harbour Workshop', certainty: 'explicit' },
        { field: 'company.summary', value: 'Reviewing IT support reliability', certainty: 'explicit' }
    ] });
    if (options.discovery !== false) {
        await service.executeProspectTool(access, sessionHash, 'advance_lifecycle', { targetState: 'discovery' });
    }
    const outputs = options.outputs || [[]];
    let turn = 0;
    const create = jest.fn(async () => ({ requestId: 'synthetic-request', body: {
        output: outputs[Math.min(turn++, outputs.length - 1)], usage: {}, model: 'synthetic-injected-model'
    } }));
    const stream = jest.fn(async (_request, handlers) => {
        await handlers.onEvent({ type: 'response.output_text.delta', delta: 'What else should we know about your IT support?' });
        await handlers.onEvent({ type: 'response.completed', response: { usage: {} } });
        return { requestId: 'synthetic-stream' };
    });
    const agent = createProspectAgent({ lifecycleService: service, access, sessionHash,
        env, openaiClient: { create, stream }, releaseIdentity: null });
    async function stored() {
        // A fresh repository read verifies the persisted state, not the agent's return object.
        const state = await repository.read(access);
        return { state, conversation: state.conversations[0], organisation: state.organisations[0] };
    }
    return { repository, service, access, sessionHash, agent, create, stream, stored };
}

function expectPendingHumanFollowUp(stored, taskCount = 1) {
    expect(stored.conversation.nextAction.type).toBe('human_follow_up');
    expect(stored.conversation.escalation).toMatchObject({ required: true });
    expect(stored.conversation.escalation.requestedAt).toBeTruthy();
    expect(stored.organisation.nextAction).toMatchObject({ type: 'human_follow_up', owner: 'operator', status: 'open' });
    expect(stored.state.operatorTasks).toHaveLength(taskCount);
    if (taskCount) expect(stored.state.operatorTasks[0]).toMatchObject({
        organisationId: stored.organisation.id, conversationId: stored.conversation.id,
        type: 'discovery_scoping_review', status: 'open', ownerRole: 'service_owner',
        source: 'prospect_agent_handoff', evidence: { nextActionType: 'human_follow_up', lifecycleState: 'discovery' }
    });
}

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

describe('explicit prospect contact requests in the active App lifecycle', () => {
    test.each([
        ['omitted model action', []],
        ['contradictory continue-chat action', [actionCall('continue_chat')]]
    ])('persists the human handoff despite %s', async (_name, output) => {
        const f = await fixture({ outputs: [output] });
        const result = await f.agent.runTurn({ message: 'Please arrange for someone to call me about managed IT.' });
        expectPendingHumanFollowUp(await f.stored());
        expect(result.conversation.nextAction.type).toBe('human_follow_up');
        expect(result.text).toMatch(/email/i);
        expect(result.text).not.toMatch(/(?:meeting|call|appointment) (?:is |has been )?(?:booked|scheduled)|(?:sent|emailed) (?:you|an? invitation)/i);
    });

    test('retains the unchanged live-evaluation request when the model omits its action', async () => {
        const scenario = require('../evals/prospect-discovery.json').scenarios
            .find(item => item.id === 'human_follow_up_is_suggested_not_booked');
        const f = await fixture({ discovery: false, seedContext: false });
        const result = await f.agent.runTurn({ message: scenario.turns[0] });
        const stored = await f.stored();
        expectPendingHumanFollowUp(stored, 0);
        expect(stored.conversation.nextAction.type).toBe(scenario.expect.nextActionType);
        expect(stored.organisation.context.company.name).toBe(scenario.expect.facts['company.name']);
        expect(stored.organisation.context.users.estimatedCount).toBe(scenario.expect.facts['users.estimatedCount']);
        for (const pattern of scenario.expect.forbiddenReplyPatterns) {
            expect(result.text.toLowerCase()).not.toContain(pattern);
        }
        expect((result.text.match(/\?/g) || []).length).toBeLessThanOrEqual(scenario.expect.maxQuestionsPerReply);
    });

    test('retains prospect-stage follow-up without inventing a discovery handoff task', async () => {
        const f = await fixture({ discovery: false });
        await f.agent.runTurn({ message: 'Can someone contact me please?' });
        expectPendingHumanFollowUp(await f.stored(), 0);
    });

    test('still answers a service question when the same message requests contact', async () => {
        const f = await fixture();
        const result = await f.agent.runTurn({ message: 'What does managed IT support cover? Please contact me.' });
        expectPendingHumanFollowUp(await f.stored());
        expect(result.text).toContain('day-to-day support');
        expect((result.text.match(/\?/g) || []).length).toBeLessThanOrEqual(1);
    });

    test('contact-email continuation cannot erase the pending request or duplicate its task', async () => {
        const f = await fixture({ outputs: [[], [actionCall('continue_chat')], []] });
        await f.agent.runTurn({ message: 'Please call me to discuss our support needs.' });
        const first = await f.stored();
        expectPendingHumanFollowUp(first);
        const taskId = first.state.operatorTasks[0].id;
        await f.agent.runTurn({ message: 'My email is alex@harbour.example.test.' });
        const second = await f.stored();
        expectPendingHumanFollowUp(second);
        expect(second.organisation.context.contacts.primary.email).toBe('alex@harbour.example.test');
        expect(second.state.operatorTasks[0].id).toBe(taskId);
        await f.agent.runTurn({ message: 'Please contact me about this.' });
        expectPendingHumanFollowUp(await f.stored());
        expect((await f.stored()).state.operatorTasks[0].id).toBe(taskId);
    });

    test('preserves a previously stored follow-up when the missing email is supplied', async () => {
        const f = await fixture({ outputs: [[actionCall('continue_chat')]] });
        await f.service.executeProspectTool(f.access, f.sessionHash, 'suggest_next_action', {
            type: 'human_follow_up', timing: 'Thursday afternoon only', detail: 'Email first; do not phone during work hours'
        });
        const before = await f.stored();
        await f.agent.runTurn({ message: 'alex@harbour.example.test' });
        const after = await f.stored();
        expectPendingHumanFollowUp(after);
        expect(after.organisation.context.contacts.primary.email).toBe('alex@harbour.example.test');
        expect(after.state.operatorTasks[0].id).toBe(before.state.operatorTasks[0].id);
        expect(after.conversation.nextAction).toEqual(before.conversation.nextAction);
    });

    test.each([
        'Please call me tomorrow.',
        'Could someone contact me?',
        'I would like to talk to a person.',
        'Can we book a meeting to discuss support?'
    ])('recognises a direct request: %s', async message => {
        const f = await fixture(); await f.agent.runTurn({ message });
        expectPendingHumanFollowUp(await f.stored());
    });

    test.each([
        'We use Teams meetings every day.',
        'What happens during a discovery call?',
        'Our office has a meeting room and a coffee machine.',
        'Please do not call me; I only want information.',
        'I do not want to talk to a person.',
        'Please call me Casey.',
        'Call me Alex.',
        'Please call me. Actually, do not contact me.',
        'Please book a meeting. Actually, do not book a meeting.',
        'I want to meet with someone. Actually, I do not want a meeting.',
        'For example:\nPlease call me.',
        'The training example says "please contact me".',
        'A colleague wrote “please call me”; I am only comparing providers.',
        'The template contains `please call me` as example text.',
        'Example:\n```text\nPlease book a meeting with me.\n```'
    ])('does not invent follow-up from quoted, negated or informational text: %s', async message => {
        const f = await fixture(); await f.agent.runTurn({ message });
        const stored = await f.stored();
        expect(stored.conversation.nextAction.type).not.toBe('human_follow_up');
        expect(stored.conversation.escalation.required).toBe(false);
        expect(stored.state.operatorTasks).toHaveLength(0);
    });

    test('a direct request outside a quoted passage still persists follow-up', async () => {
        const f = await fixture();
        await f.agent.runTurn({ message: 'The FAQ says "we never call without permission". Please contact me.' });
        expectPendingHumanFollowUp(await f.stored());
    });

    test('preserves an unrelated existing scoping action when there is no contact request', async () => {
        const f = await fixture();
        await f.service.executeProspectTool(f.access, f.sessionHash, 'suggest_next_action', {
            type: 'start_scoping', timing: 'Next week', detail: 'Prepare the reviewed scoping questionnaire'
        });
        const before = await f.stored();
        await f.agent.runTurn({ message: 'We use Teams for meetings and have 18 staff.' });
        const after = await f.stored();
        expect(after.conversation.nextAction).toEqual(before.conversation.nextAction);
        expect(after.organisation.nextAction).toEqual(before.organisation.nextAction);
        expect(after.state.operatorTasks.map(task => task.id)).toEqual(before.state.operatorTasks.map(task => task.id));
    });

    test('preserves an unrelated model-selected action without an explicit or pending request', async () => {
        const f = await fixture({ outputs: [[actionCall('send_scope', 'Review the scope draft')]] });
        await f.agent.runTurn({ message: 'We are comparing the available managed IT services.' });
        const stored = await f.stored();
        expect(stored.conversation.nextAction).toMatchObject({ type: 'send_scope', detail: 'Review the scope draft' });
        expect(stored.conversation.escalation.required).toBe(false);
        expect(stored.state.operatorTasks).toHaveLength(0);
    });

    test('does not force a previous follow-up over an unrelated later model action', async () => {
        const f = await fixture({ outputs: [[actionCall('send_scope', 'Review the scope outline')]] });
        await f.service.executeProspectTool(f.access, f.sessionHash, 'suggest_next_action', {
            type: 'human_follow_up', timing: 'As requested', detail: 'Existing visitor request'
        });
        const before = await f.stored();
        await f.agent.runTurn({ message: 'We would like an overview of the proposed service scope.' });
        const after = await f.stored();
        expect(after.conversation.nextAction).toMatchObject({ type: 'send_scope', detail: 'Review the scope outline' });
        expect(after.state.operatorTasks.map(task => task.id)).toEqual(before.state.operatorTasks.map(task => task.id));
    });

    test('does not acknowledge handoff or record agent success when its persistence fails', async () => {
        const f = await fixture();
        const mutate = f.repository.mutate.bind(f.repository);
        let rejectedWrites = 0;
        f.repository.mutate = (access, options, mutator) => mutate(access, options, async state => {
            const result = await mutator(state);
            if (state.conversations.some(conversation => conversation.nextAction.type === 'human_follow_up')) {
                rejectedWrites++;
                throw Object.assign(new Error('Synthetic persistence failure'), { details: { code: 'synthetic_follow_up_write_failed' } });
            }
            return result;
        });
        const deltas = [];
        await expect(f.agent.runTurn({ message: 'Please contact me about IT support.', onDelta: delta => deltas.push(delta) }))
            .rejects.toMatchObject({ details: { code: 'synthetic_follow_up_write_failed' } });
        expect(rejectedWrites).toBeGreaterThan(0);
        const stored = await f.stored();
        expect(stored.state.operatorTasks).toHaveLength(0);
        expect(stored.conversation.nextAction.type).not.toBe('human_follow_up');
        expect(stored.conversation.messages.filter(message => message.role === 'assistant')).toHaveLength(0);
        expect(deltas).toEqual([]);
        expect(f.stream).not.toHaveBeenCalled();
        const runs = stored.state.observability.filter(event => event.eventType === 'agent.run');
        expect(runs.filter(run => run.outcome === 'success')).toHaveLength(0);
        expect(runs).toEqual(expect.arrayContaining([expect.objectContaining({ outcome: 'error' })]));
    });
});

describe('provider-independent contact handoff regression', () => {
    test.each([
        ['timeout', 504, 'openai_timeout'],
        ['service failure', 503, 'openai_upstream_unavailable']
    ])('commits the handoff before the first provider %s and propagates its error', async (_name, statusCode, code) => {
        const f = await fixture();
        const providerError = Object.assign(new Error('Synthetic provider failure'), { statusCode, details: { code } });
        let observedAtProviderInvocation;
        f.create.mockImplementation(async () => {
            observedAtProviderInvocation = await f.stored();
            throw providerError;
        });
        const deltas = [];
        await expect(f.agent.runTurn({
            message: 'Please contact me about managed IT.',
            onDelta: delta => deltas.push(delta)
        })).rejects.toBe(providerError);
        expect(f.create).toHaveBeenCalledTimes(1);
        expectPendingHumanFollowUp(observedAtProviderInvocation);
        const stored = await f.stored();
        expectPendingHumanFollowUp(stored);
        expect(stored.state.operatorTasks[0].id).toBe(observedAtProviderInvocation.state.operatorTasks[0].id);
        expect(stored.conversation.messages.filter(message => message.role === 'assistant')).toHaveLength(0);
        expect(deltas).toEqual([]);
        expect(f.stream).not.toHaveBeenCalled();
        const runs = stored.state.observability.filter(event => event.eventType === 'agent.run');
        expect(runs.filter(run => run.outcome === 'success')).toHaveLength(0);
        expect(runs).toEqual(expect.arrayContaining([expect.objectContaining({ outcome: 'error', errorCode: code })]));
    });

    test.each([
        "I'd like you to call me.",
        'I’d like you to call me tomorrow.',
        'I want you to contact me about managed IT.',
        'I would like you to phone me tomorrow.'
    ])('recognises a direct first-person contact request: %s', async message => {
        const f = await fixture();
        await f.agent.runTurn({ message });
        expectPendingHumanFollowUp(await f.stored());
    });

    test.each([
        "I don't want you to contact me.",
        'I do not want you to call me.',
        'I’d like you to call me. Actually, do not contact me.',
        'The example says "I\'d like you to call me".',
        'The example says “I want you to contact me”.',
        "I'd like you to call me Alex.",
        'I want you to call me Casey.'
    ])('does not treat first-person quotes, refusal or naming as consent: %s', async message => {
        const f = await fixture();
        await f.agent.runTurn({ message });
        const stored = await f.stored();
        expect(stored.conversation.nextAction.type).not.toBe('human_follow_up');
        expect(stored.conversation.escalation.required).toBe(false);
        expect(stored.state.operatorTasks).toHaveLength(0);
    });
});
