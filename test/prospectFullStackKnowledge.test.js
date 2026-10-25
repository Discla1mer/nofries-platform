const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    PROSPECT_PROMPT_VERSION,
    createProspectAgent,
    prospectPromptCacheKey,
    prospectStableInstructions
} = require('../api/shared/agents/prospectAgent');
const {
    NOFRIES_PUBLIC_KNOWLEDGE,
    prospectPublicKnowledgePrompt,
    publicHelpReply
} = require('../api/shared/agents/nofriesPublicKnowledge');
const { normalisePromptCacheKey } = require('../api/shared/agents/promptCaching');
const { PROSPECT_TOOL_SCHEMA_VERSION } = require('../api/shared/agents/prospectTools');
const { createLifecycleRepository } = require('../api/shared/appLifecycle/lifecycleRepository');
const { createLifecycleService } = require('../api/shared/appLifecycle/lifecycleService');
const { createPublicAgentAccess } = require('../api/shared/lifecycle/prospectSession');
const { applicationContractManifest } = require('../evals/prospect-harness');
const { publicKnowledgeDialogues } = require('../evals/prospect-discovery.json');

// The existing real agent and durable local lifecycle store run here. Only the
// provider client is injected. This proves request construction and grounded
// source behaviour, not live model quality or the runtime's no-persistence route.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-public-knowledge-'));
let sequence = 0;

async function fixture() {
    const id = ++sequence;
    const env = {
        NOFRIES_DEFAULT_TENANT_ID: `synthetic-knowledge-${id}`,
        NOFRIES_TENANT_NAME: 'Synthetic public knowledge tests',
        NOFRIES_PROSPECT_AGENT_RUNTIME: 'openai',
        OPENAI_API_KEY: 'synthetic-injected-client-never-sent',
        NOFRIES_PUBLIC_URL: 'https://nofries.example.test'
    };
    const repository = createLifecycleRepository({ provider: 'local', dataDir: path.join(dataDir, String(id)) });
    const service = createLifecycleService({ repository, env });
    const access = createPublicAgentAccess(env);
    const sessionHash = String(id).padStart(64, '0');
    await service.ensureProspectSession(access, sessionHash, { channel: 'text' });
    const create = jest.fn(async () => ({
        requestId: 'synthetic-knowledge-request',
        body: {
            model: 'synthetic-provider-model',
            output: [{ type: 'function_call', name: 'update_prospect_context', call_id: 'synthetic-context', arguments: '{"facts":[]}' }],
            usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 }
        }
    }));
    const stream = jest.fn(async (_request, handlers) => {
        await handlers.onEvent({ type: 'response.output_text.delta', delta: 'What should improve about your IT support?' });
        await handlers.onEvent({ type: 'response.completed', response: {
            model: 'synthetic-provider-model', usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
        } });
        return { requestId: 'synthetic-knowledge-stream' };
    });
    const agent = createProspectAgent({
        lifecycleService: service, access, sessionHash, env,
        openaiClient: { create, stream },
        releaseIdentity: { releaseSha: 'a'.repeat(40), runId: '12345' }
    });
    return { agent, create, stream, repository, service, access, sessionHash };
}

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

describe('existing provider path receives the full verified public knowledge', () => {
    test('binds prompt and cache identity to changed public facts without changing model or tool schema', async () => {
        const f = await fixture();
        const message = 'I work at Synthetic Harbour, and we need more reliable IT support. VisitorOnlyMarker2026.';
        const result = await f.agent.runTurn({ message });
        const request = f.create.mock.calls[0][0];
        expect(request).toMatchObject({
            model: 'gpt-5.6-luna',
            reasoning: { effort: 'none' },
            tool_choice: 'required',
            store: false,
            metadata: { prompt_version: 'prospect-v5', tool_schema_version: PROSPECT_TOOL_SCHEMA_VERSION }
        });
        expect(PROSPECT_PROMPT_VERSION).toBe('prospect-v5');
        expect(prospectPromptCacheKey()).toContain(NOFRIES_PUBLIC_KNOWLEDGE.knowledgeVersion);
        expect(request.prompt_cache_key).toBe(normalisePromptCacheKey(prospectPromptCacheKey()));
        expect(request.prompt_cache_key.length).toBeLessThanOrEqual(64);
        expect(request.prompt_cache_key).not.toBe(normalisePromptCacheKey(
            'nofries:prospect:prospect-v4:prospect-tools-v1:managed_it_2026_08_4'
        ));
        const stable = request.input[0];
        expect(stable.role).toBe('developer');
        expect(stable.content[0].prompt_cache_breakpoint).toEqual({ mode: 'explicit' });
        expect(stable.content[0].text).toContain(prospectPublicKnowledgePrompt());
        expect(stable.content[0].text).not.toContain('VisitorOnlyMarker2026');
        expect(request.input[1].role).toBe('user');
        expect(request.input[1].content[0].text).toContain('BEGIN UNTRUSTED CUSTOMER_CONTEXT DATA');
        expect(request.input[1].content[0].text).toContain('VisitorOnlyMarker2026');
        expect(result.identities).toMatchObject({ promptVersion: 'prospect-v5', model: 'gpt-5.6-luna' });
        expect(f.stream).toHaveBeenCalledTimes(1);
    });

    test.each(publicKnowledgeDialogues.map(dialogue => [dialogue.id, dialogue]))('grounds %s in the same public source', async (_id, dialogue) => {
        const f = await fixture();
        const chunks = [];
        const result = await f.agent.runTurn({
            message: dialogue.turns[0], onDelta: async value => chunks.push(value)
        });
        expect(f.create).toHaveBeenCalledTimes(1);
        expect(f.create.mock.calls[0][0].input[0].content[0].text).toContain(prospectPublicKnowledgePrompt());
        expect(f.stream).not.toHaveBeenCalled();
        expect(result.text).toBe(publicHelpReply(dialogue.turns[0]).text);
        expect(chunks.join('')).toBe(result.text);
        expect(result.organisation.fieldStates['company.name'].status).toBe('unknown');
        for (const expected of dialogue.expect.replyMustInclude) {
            expect(result.text.toLowerCase()).toContain(expected.toLowerCase());
        }
        for (const pattern of dialogue.expect.forbiddenReplyPatterns) {
            expect(result.text).not.toMatch(new RegExp(pattern, 'i'));
        }
    });

    test('answers a dashboard question without reviving the earlier Managed IT quote', async () => {
        const f = await fixture();
        await f.service.executeProspectTool(f.access, f.sessionHash, 'update_prospect_context', { facts: [
            { field: 'users.estimatedCount', value: '10', certainty: 'explicit' },
            { field: 'endpoints.estimatedCount', value: '10', certainty: 'explicit' }
        ] });
        await f.service.appendProspectMessage(f.access, f.sessionHash, 'user', 'What does managed IT cost?');
        const result = await f.agent.runTurn({ message: 'How do I reopen submitted dashboard results?' });
        expect(result.text).toContain('read-only');
        expect(result.text).not.toMatch(/NZ\$|current No Fries estimate|monthly price/i);
        expect(f.stream).not.toHaveBeenCalled();
    });

    test('keeps explicit contact requests in the established reviewed handoff', async () => {
        const f = await fixture();
        const message = 'What is the dashboard? Please contact me about a service review.';
        expect(publicHelpReply(message)).toBeNull();
        const result = await f.agent.runTurn({ message });
        const state = await f.repository.read(f.access);
        expect(result.conversation.nextAction.type).toBe('human_follow_up');
        expect(result.text).toContain('recorded your request');
        expect(result.text).not.toMatch(/meeting is booked|sent an email|booking confirmed/i);
        expect(state.conversations[0].escalation.required).toBe(true);
    });

    test('hashes the actual new knowledge bytes in evaluation evidence', () => {
        const entry = applicationContractManifest().files.find(file =>
            file.path === 'api/shared/agents/nofriesPublicKnowledge.js');
        expect(entry).toEqual({
            path: 'api/shared/agents/nofriesPublicKnowledge.js',
            sha256: crypto.createHash('sha256').update(fs.readFileSync(path.resolve(__dirname,
                '../api/shared/agents/nofriesPublicKnowledge.js'))).digest('hex')
        });
        expect(prospectStableInstructions()).toContain('Public product questions and general meeting vocabulary do not authorise human contact');
    });
});
