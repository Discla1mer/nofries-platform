const crypto = require('crypto');
const { cleanText } = require('../lifecycle/lifecycleModel');
const {
    MANAGED_IT_POLICY,
    managedItPolicyCacheSegment
} = require('../managedItPolicy');
const {
    NOFRIES_PUBLIC_KNOWLEDGE,
    prospectPublicKnowledgePrompt,
    publicHelpReply
} = require('./nofriesPublicKnowledge');
const { getReleaseIdentity } = require('../releaseIdentity');
const { estimateCost, normaliseUsage, resolveModel } = require('./modelRegistry');
const { createOpenAIResponsesClient } = require('./openaiResponsesClient');
const { estimateManagedItPrice, priceReply, shouldOfferPrice } = require('../mspPricing');
const { buildPromptPrefix, dynamicUntrustedDataMessage } = require('./promptCaching');
const {
    PROSPECT_TOOL_SCHEMA_VERSION,
    PROSPECT_TOOL_NAMES,
    createProspectToolGateway,
    prospectToolDefinitions
} = require('./prospectTools');

const AGENT_ID = 'prospect_agent';
const PROSPECT_PROMPT_VERSION = 'prospect-v5';
const MAX_VISITOR_MESSAGE = 2000;
const MAX_AGENT_REPLY = 1800;

function createProspectAgent(options = {}) {
    const env = options.env || process.env;
    const lifecycleService = options.lifecycleService;
    const access = options.access;
    const sessionHash = options.sessionHash;
    const runtime = resolveProspectRuntime(env);
    const model = resolveModel('prospect', env);
    const releaseIdentity = options.releaseIdentity === undefined ? getReleaseIdentity() : options.releaseIdentity;
    const toolGateway = options.toolGateway || createProspectToolGateway({ lifecycleService, access, sessionHash });
    const client = options.openaiClient || (runtime.mode === 'openai'
        ? createOpenAIResponsesClient({ env })
        : null);
    if (!lifecycleService || !access || !sessionHash) {
        throw new Error('Prospect Agent requires lifecycle service, access, and a session');
    }

    return {
        runtime,
        model,

        async runTurn(input = {}) {
            const startedAt = Date.now();
            const message = guardVisitorMessage(input.message);
            await lifecycleService.appendProspectMessage(access, sessionHash, 'user', message);

            try {
                const result = runtime.mode === 'openai'
                    ? await runOpenAITurn({
                        client,
                        lifecycleService,
                        access,
                        sessionHash,
                        toolGateway,
                        model,
                        releaseIdentity,
                        message,
                        onDelta: input.onDelta,
                        safetyIdentifier: input.safetyIdentifier
                    })
                    : await runMockTurn({
                        lifecycleService,
                        access,
                        sessionHash,
                        toolGateway,
                        model,
                        releaseIdentity,
                        message,
                        onDelta: input.onDelta
                    });

                const reply = guardAgentReply(result.text);
                const persisted = await lifecycleService.appendProspectMessage(access, sessionHash, 'assistant', reply);
                const usage = normaliseUsage(result.usage || {});
                const approximateCostUsd = estimateCost(model, usage);
                const providerModel = cleanText(result.providerModel, 120);
                await lifecycleService.recordAgentRun(access, sessionHash, {
                    agent: AGENT_ID,
                    model: runtime.mode === 'openai' ? model.model : 'mock-deterministic',
                    providerModel,
                    runtime: runtime.mode,
                    reasoningEffort: model.reasoningEffort,
                    promptVersion: PROSPECT_PROMPT_VERSION,
                    toolSchemaVersion: PROSPECT_TOOL_SCHEMA_VERSION,
                    policyId: MANAGED_IT_POLICY.policyId,
                    policyVersion: MANAGED_IT_POLICY.legacyPriceVersion,
                    policyEffectiveFrom: MANAGED_IT_POLICY.effectiveFrom,
                    releaseSha: releaseIdentity && releaseIdentity.releaseSha || '',
                    releaseRunId: releaseIdentity && releaseIdentity.runId || '',
                    confidence: result.confidence,
                    outcome: 'success',
                    latencyMs: Date.now() - startedAt,
                    inputTokens: usage.inputTokens,
                    cachedInputTokens: usage.cachedInputTokens,
                    cacheWriteTokens: usage.cacheWriteTokens,
                    outputTokens: usage.outputTokens,
                    reasoningTokens: usage.reasoningTokens,
                    totalTokens: usage.totalTokens,
                    toolFailures: result.toolFailures,
                    approximateCostUsd,
                    traceId: result.traceId,
                    details: { channel: input.channel === 'voice' ? 'voice' : 'text' }
                });
                return {
                    text: reply,
                    runtime,
                    model: runtime.mode === 'openai' ? model.model : 'mock-deterministic',
                    providerModel,
                    usage,
                    approximateCostUsd,
                    traceId: result.traceId,
                    identities: agentIdentities(model, releaseIdentity),
                    conversation: persisted.conversation,
                    organisation: persisted.organisation
                };
            } catch (error) {
                await lifecycleService.recordAgentRun(access, sessionHash, {
                    agent: AGENT_ID,
                    model: runtime.mode === 'openai' ? model.model : 'mock-deterministic',
                    runtime: runtime.mode,
                    reasoningEffort: model.reasoningEffort,
                    promptVersion: PROSPECT_PROMPT_VERSION,
                    toolSchemaVersion: PROSPECT_TOOL_SCHEMA_VERSION,
                    policyId: MANAGED_IT_POLICY.policyId,
                    policyVersion: MANAGED_IT_POLICY.legacyPriceVersion,
                    policyEffectiveFrom: MANAGED_IT_POLICY.effectiveFrom,
                    releaseSha: releaseIdentity && releaseIdentity.releaseSha || '',
                    releaseRunId: releaseIdentity && releaseIdentity.runId || '',
                    confidence: 0,
                    outcome: 'error',
                    errorCode: error && error.details && error.details.code || 'agent_error',
                    latencyMs: Date.now() - startedAt,
                    traceId: error && error.details && error.details.requestId || ''
                }).catch(() => {});
                throw error;
            }
        }
    };
}

function resolveProspectRuntime(env = process.env) {
    const configured = String(env.NOFRIES_PROSPECT_AGENT_RUNTIME || '').trim().toLowerCase();
    const mode = configured || (String(env.OPENAI_API_KEY || '').trim() ? 'openai' : 'mock');
    if (!['openai', 'mock', 'disabled'].includes(mode)) {
        return { mode: 'disabled', label: 'Unavailable', liveModel: false, reason: 'invalid_runtime' };
    }
    if (mode === 'openai' && !String(env.OPENAI_API_KEY || '').trim()) {
        return { mode: 'disabled', label: 'Set-up pending', liveModel: false, reason: 'openai_key_missing' };
    }
    if (mode === 'openai') {
        return { mode, label: 'Live assistant', liveModel: true, reason: '' };
    }
    if (mode === 'mock') {
        return { mode, label: 'Structured preview', liveModel: false, reason: 'openai_not_configured' };
    }
    return { mode, label: 'Unavailable', liveModel: false, reason: 'disabled' };
}

async function runOpenAITurn(options) {
    const initial = await options.lifecycleService.getProspectSession(options.access, options.sessionHash);
    const discoveryEligibleAtStart = shouldAdvanceToDiscovery(initial.organisation);
    const explicitFacts = extractExplicitFacts(options.message, initial.organisation);
    const explicitFields = new Set(explicitFacts.map((fact) => fact.field));
    if (explicitFacts.length) {
        await options.toolGateway.invoke(PROSPECT_TOOL_NAMES.UPDATE_CONTEXT, { facts: explicitFacts }, {
            agent: AGENT_ID,
            model: options.model.model,
            details: { extractor: 'deterministic_explicit_v1' }
        });
    }

    // Capture explicit workflow input before a provider failure can interrupt
    // this turn. The existing gateway owns audit, escalation and task deduplication.
    const pendingFollowUpEmail = isPendingFollowUpEmail(options.message, initial);
    const followUp = explicitHumanContactRequested(options.message) || pendingFollowUpEmail;
    const requestedAction = pendingFollowUpEmail ? initial.conversation.nextAction : {
        type: 'human_follow_up', timing: 'As requested', detail: 'Prospect requested human contact'
    };
    const matchesRequest = session => session.conversation.nextAction.type === 'human_follow_up' &&
        session.conversation.escalation.required === true &&
        (!pendingFollowUpEmail || (session.conversation.nextAction.timing === requestedAction.timing &&
            session.conversation.nextAction.detail === requestedAction.detail));
    if (followUp && !matchesRequest(initial)) {
        await options.toolGateway.invoke(PROSPECT_TOOL_NAMES.SUGGEST_NEXT_ACTION, requestedAction, {
            agent: AGENT_ID, model: options.model.model,
            details: { extractor: 'explicit_human_contact_v1' }
        });
    }
    const session = await options.lifecycleService.getProspectSession(options.access, options.sessionHash);
    const stableInstructions = prospectStableInstructions();
    const dynamicInstructions = prospectDynamicInstructions(session.organisation, session.conversation);
    const promptPrefix = buildPromptPrefix({
        model: options.model.model,
        promptCacheKey: prospectPromptCacheKey(),
        stableInstructions
    });
    const cacheSettings = promptCacheSettings(promptPrefix);
    const input = promptPrefix.input.concat(
        dynamicUntrustedDataMessage(dynamicInstructions),
        conversationInput(session.conversation.messages)
    );
    const tools = prospectToolDefinitions();
    const first = await options.client.create(Object.assign({
        model: options.model.model,
        reasoning: { effort: options.model.reasoningEffort },
        input,
        tools,
        tool_choice: 'required',
        parallel_tool_calls: true,
        max_output_tokens: 1400,
        store: false,
        metadata: openAIMetadata('nofries_prospect_agent', options.releaseIdentity)
    }, cacheSettings), {
        safetyIdentifier: options.safetyIdentifier
    });

    const toolCalls = (first.body.output || []).filter((item) => item.type === 'function_call');
    const toolOutputs = [];
    let toolFailures = 0;
    if (!toolCalls.length) {
        await options.toolGateway.invoke(PROSPECT_TOOL_NAMES.UPDATE_CONTEXT, { facts: [] }, {
            agent: AGENT_ID,
            model: options.model.model,
            traceId: first.requestId
        });
    }
    for (const call of toolCalls.slice(0, 8)) {
        const toolStartedAt = Date.now();
        try {
            let args = parseToolArguments(call.arguments);
            if (call.name === PROSPECT_TOOL_NAMES.UPDATE_CONTEXT && explicitFields.size) {
                args = Object.assign({}, args, {
                    facts: (Array.isArray(args.facts) ? args.facts : [])
                        .filter((fact) => !explicitFields.has(fact.field))
                });
            }
            const result = await options.toolGateway.invoke(call.name, args, {
                agent: AGENT_ID,
                model: options.model.model,
                traceId: first.requestId,
                latencyMs: Date.now() - toolStartedAt
            });
            toolOutputs.push({
                type: 'function_call_output',
                call_id: call.call_id,
                output: JSON.stringify({ ok: true, result: result.output, context: compactToolContext(result.context) })
            });
        } catch (error) {
            toolFailures += 1;
            toolOutputs.push({
                type: 'function_call_output',
                call_id: call.call_id,
                output: JSON.stringify({
                    ok: false,
                    error: error && error.details && error.details.code || 'tool_failed'
                })
            });
        }
    }

    const firstUsage = normaliseUsage(first.body.usage || {});
    // A visitor's explicit request is durable workflow input, not an optional
    // model classification. Reconcile after tools so continue_chat cannot erase
    // this request or its subsequent missing-email answer.
    let groundedSession = await options.lifecycleService.getProspectSession(options.access, options.sessionHash);
    if (followUp && !matchesRequest(groundedSession)) {
        await options.toolGateway.invoke(PROSPECT_TOOL_NAMES.SUGGEST_NEXT_ACTION, requestedAction, {
            agent: AGENT_ID, model: options.model.model, traceId: first.requestId,
            details: { extractor: 'explicit_human_contact_v1' }
        });
        groundedSession = await options.lifecycleService.getProspectSession(options.access, options.sessionHash);
    }
    if (followUp && !matchesRequest(groundedSession)) {
        const error = new Error('The human follow-up request could not be verified');
        error.statusCode = 503;
        error.details = { code: 'prospect_follow_up_unverified' };
        throw error;
    }
    // A newly completed enquiry must not depend on the model choosing this
    // optional tool. Preserve informational/contact-only turns and use persisted
    // unanswered input, rather than a summary match, for bounded recovery.
    if (!followUp && !isInformationalProspectTurn(options.message) &&
        shouldAdvanceToDiscovery(groundedSession.organisation) &&
        (!discoveryEligibleAtStart || hasRepeatedUnansweredTurn(groundedSession.conversation, options.message))) {
        await options.toolGateway.invoke(PROSPECT_TOOL_NAMES.ADVANCE_LIFECYCLE, {
            targetState: 'discovery',
            reason: 'Organisation and reason for enquiry are known'
        }, {
            agent: AGENT_ID, model: options.model.model, traceId: first.requestId
        });
        groundedSession = await options.lifecycleService.getProspectSession(options.access, options.sessionHash);
    }
    const groundedReply = groundedFaqReply(
        groundedSession.organisation,
        options.message,
        groundedSession.conversation
    ) || (followUp ? humanFollowUpReply(groundedSession.organisation) : '');
    if (groundedReply) {
        if (typeof options.onDelta === 'function') {
            for (const delta of groundedReply.match(/\S+\s*/g) || [groundedReply]) {
                await options.onDelta(delta);
            }
        }
        return {
            text: groundedReply,
            usage: firstUsage,
            confidence: toolFailures ? 0.65 : 0.95,
            traceId: first.requestId,
            providerModel: cleanText(first.body.model, 120),
            toolFailures
        };
    }

    const finalInput = promptPrefix.input.concat(
        dynamicUntrustedDataMessage(dynamicInstructions),
        conversationInput(session.conversation.messages),
        first.body.output || [],
        toolOutputs
    );
    let text = '';
    let completedResponse = null;
    const streamed = await options.client.stream(Object.assign({
        model: options.model.model,
        reasoning: { effort: options.model.reasoningEffort },
        input: finalInput,
        tools,
        tool_choice: 'none',
        max_output_tokens: 650,
        store: false,
        metadata: openAIMetadata('nofries_prospect_agent_reply', options.releaseIdentity)
    }, cacheSettings), {
        safetyIdentifier: options.safetyIdentifier,
        async onEvent(event) {
            if (event.type === 'response.output_text.delta' && event.delta) {
                text += event.delta;
                if (typeof options.onDelta === 'function') await options.onDelta(event.delta);
            }
            if (event.type === 'response.completed' && event.response) {
                completedResponse = event.response;
            }
            if (event.type === 'response.failed' || event.type === 'error') {
                const error = new Error('The assistant could not complete that response');
                error.statusCode = 502;
                error.details = { code: 'openai_stream_failed', requestId: first.requestId || '' };
                throw error;
            }
        }
    });

    if (!text.trim() && completedResponse) {
        text = responseOutputText(completedResponse);
        if (text && typeof options.onDelta === 'function') await options.onDelta(text);
    }
    if (!text.trim()) {
        text = 'Thanks — I have recorded that. What would make the biggest difference to your day-to-day IT support?';
        if (typeof options.onDelta === 'function') await options.onDelta(text);
    }

    const finalUsage = normaliseUsage(completedResponse && completedResponse.usage || {});
    return {
        text,
        usage: combineUsage(firstUsage, finalUsage),
        confidence: toolFailures ? 0.65 : 0.9,
        traceId: [first.requestId, streamed.requestId].filter(Boolean).join(':'),
        providerModel: cleanText(completedResponse && completedResponse.model || first.body.model, 120),
        toolFailures
    };
}

async function runMockTurn(options) {
    const initial = await options.lifecycleService.getProspectSession(options.access, options.sessionHash);
    const facts = extractExplicitFacts(options.message, initial.organisation);
    await options.toolGateway.invoke(PROSPECT_TOOL_NAMES.UPDATE_CONTEXT, { facts }, {
        agent: AGENT_ID,
        model: 'mock-deterministic'
    });
    const updated = await options.lifecycleService.getProspectSession(options.access, options.sessionHash);
    const summary = buildMockSummary(updated.organisation, options.message);
    await options.toolGateway.invoke(PROSPECT_TOOL_NAMES.RECORD_SUMMARY, {
        summary,
        currentNeed: cleanText(options.message, 800),
        concerns: updated.organisation.context.security.concerns.concat(updated.organisation.context.support.frustrations).slice(0, 12)
    }, {
        agent: AGENT_ID,
        model: 'mock-deterministic'
    });

    const refreshed = await options.lifecycleService.getProspectSession(options.access, options.sessionHash);
    const next = mockNextAction(refreshed.organisation, options.message);
    await options.toolGateway.invoke(PROSPECT_TOOL_NAMES.SUGGEST_NEXT_ACTION, next, {
        agent: AGENT_ID,
        model: 'mock-deterministic'
    });

    if (shouldAdvanceToDiscovery(refreshed.organisation)) {
        await options.toolGateway.invoke(PROSPECT_TOOL_NAMES.ADVANCE_LIFECYCLE, {
            targetState: 'discovery',
            reason: 'Organisation and reason for enquiry are known'
        }, {
            agent: AGENT_ID,
            model: 'mock-deterministic'
        }).catch(() => {});
    }

    const latest = await options.lifecycleService.getProspectSession(options.access, options.sessionHash);
    const text = groundedFaqReply(latest.organisation, options.message, latest.conversation)
        || mockReply(latest.organisation, options.message);
    if (typeof options.onDelta === 'function') {
        for (const delta of text.match(/\S+\s*/g) || [text]) {
            await options.onDelta(delta);
        }
    }
    return {
        text,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        confidence: facts.length ? 0.82 : 0.7,
        traceId: `mock_${crypto.randomBytes(8).toString('hex')}`
    };
}

function prospectStableInstructions() {
    return [
        'You are the No Fries public product and service discovery assistant on nofries.nz.',
        `The customer-facing managed service is ${MANAGED_IT_POLICY.customerFacingServiceName}.`,
        'Be concise, helpful and natural. Use New Zealand English and avoid slogans, hype and technical jargon.',
        'Write website-ready plain text. Do not use Markdown headings, bold markers, or tables; use short labels and bullet lines when structure helps.',
        'Answer the visitor\'s question before asking one useful follow-up question.',
        'Keep the answer focused on the product the visitor asked about. Do not append general product menus or cross-promote other services or sites unless the visitor explicitly asks.',
        'For a public product or dashboard question, explain the relevant verified workflow. Do not turn help into a sales questionnaire, infer a service request or choose an organisation for the visitor.',
        'When the visitor is discussing an actual service enquiry, progressively learn about their organisation and IT needs. Do not run a rigid questionnaire and never ask more than one question at a time.',
        'Capture every supported fact explicitly stated in the latest visitor message, not just a representative subset.',
        'Use update_prospect_context every turn, even when its facts array is empty. Save only facts the visitor stated or strongly implied. Never fabricate a missing detail.',
        'Use these canonical values: productivity.platform is microsoft_365, google_workspace, mixed, or other; itProvider.model is managed_provider, internal, hybrid, or none; internalIt.capability is none, part_time, full_time, or team.',
        'For commercial.preferredTiming save only the visitor\'s timing phrase, such as "within 90 days", rather than a paraphrased sentence.',
        'Do not resave a known fact unless the visitor is clearly correcting it.',
        'Use record_conversation_summary when the rolling summary or actual service need changes. Use suggest_next_action only for an actual service enquiry. Public product questions and general meeting vocabulary do not authorise human contact, a task, a booking or a commercial next step.',
        'Advance prospect to discovery only when the organisation and a useful reason for the enquiry are known.',
        'Never ask for or accept passwords, access tokens, recovery codes, secrets, payment data, or raw security configuration.',
        'This public agent has no access to customer operational systems. Do not claim that it checked a device, tenant, ticket, or security tool.',
        prospectPublicKnowledgePrompt(),
        'Do not calculate or invent pricing. When the visitor asks about Managed IT price, gather the user and device counts needed for the server-side calculation. The Managed IT policy is separate from dashboard pricing and access. Never present an indicative estimate as a final agreement or promise service acceptance.',
        'Do not promise response-time exceptions, booking confirmation, or service acceptance. You may suggest a service review or human follow-up.',
        'Do not mention underlying suppliers or products unless the visitor asks about a product they already use. Describe the customer outcome first.'
    ].join('\n');
}

function prospectDynamicInstructions(organisation, conversation) {
    const missing = organisation.discovery.missingFields.map((item) => item.label);
    return [
        `Known structured context (unknown means not yet provided): ${JSON.stringify(organisation.context)}`,
        `Current lifecycle: ${organisation.lifecycleState}. Current summary: ${conversation.summary || 'unknown'}.`,
        `Highest-value discovery gaps: ${missing.slice(0, 8).join(', ') || 'none'}.`
    ].join('\n');
}

function prospectInstructions(organisation, conversation) {
    return `${prospectStableInstructions()}\n${prospectDynamicInstructions(organisation, conversation)}`;
}

function conversationInput(messages) {
    return (messages || []).slice(-30).map((message) => ({
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: cleanText(message.text, 4000)
    }));
}

function parseToolArguments(value) {
    try {
        const parsed = JSON.parse(value || '{}');
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (error) {
        const invalid = new Error('Tool arguments were invalid');
        invalid.statusCode = 422;
        invalid.details = { code: 'invalid_tool_arguments' };
        throw invalid;
    }
}

function compactToolContext(context) {
    return {
        lifecycleState: context.lifecycleState,
        missingFields: context.discovery.missingFields.slice(0, 10),
        nextAction: context.nextAction
    };
}

function responseOutputText(response) {
    return (response.output || [])
        .filter((item) => item.type === 'message')
        .flatMap((item) => item.content || [])
        .filter((item) => item.type === 'output_text')
        .map((item) => item.text || '')
        .join('');
}

function combineUsage(left, right) {
    return {
        inputTokens: left.inputTokens + right.inputTokens,
        outputTokens: left.outputTokens + right.outputTokens,
        totalTokens: left.totalTokens + right.totalTokens,
        cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
        cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
        reasoningTokens: left.reasoningTokens + right.reasoningTokens
    };
}

function guardVisitorMessage(value) {
    const message = cleanText(value, MAX_VISITOR_MESSAGE);
    if (!message) {
        throw publicError(400, 'Please enter a message.', 'message_required');
    }
    const secretPatterns = [
        /\bpassword\s*(?:is|=|:)\s*\S+/i,
        /\b(?:api[_ -]?key|client[_ -]?secret|access[_ -]?token)\s*(?:is|=|:)\s*\S+/i,
        /\b(?:recovery|mfa|2fa)\s*code\s*(?:is|=|:)\s*\d{4,}/i,
        /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/
    ];
    if (secretPatterns.some((pattern) => pattern.test(message))) {
        throw publicError(
            400,
            'Please remove passwords, tokens, recovery codes, or other secrets before sending that message.',
            'sensitive_data_blocked'
        );
    }
    return message;
}

function guardAgentReply(value) {
    const text = cleanText(value, MAX_AGENT_REPLY);
    return text || 'Thanks — I have recorded that. What is the main IT issue you want to improve?';
}

function extractExplicitFacts(message, organisation) {
    const facts = [];
    const add = (field, value, certainty = 'explicit') => {
        if (value != null && String(value).trim()) facts.push({ field, value: String(value).trim(), certainty });
    };
    const email = message.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i);
    if (email) add('contacts.primary.email', email[0]);
    const name = message.match(/\b(?:my name is|call me|i am)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)(?=[,.]|\s+(?:and|from|at|with)\b|$)/i);
    if (name) add('contacts.primary.name', name[1]);
    const company = message.match(/\b(?:our (?:company|organisation|business) is|i work (?:at|for)|i(?:'m| am) (?:at|with|from))\s+([A-Z][A-Za-z0-9&' .-]{1,80}?)(?=[,.]|\s+(?:and|we|with|which|that)\b|$)/i);
    if (company) add('company.name', company[1]);
    const userCount = message.match(/\b(?:about|around|roughly|approximately)?\s*(\d{1,6})\s+(?:users?|staff|employees?|people)\b/i);
    if (userCount) add('users.estimatedCount', userCount[1]);
    const endpointCount = message.match(/\b(?:about|around|roughly|approximately)?\s*(\d{1,6})\s+(?:endpoints?|devices?|computers?|laptops?)\b/i);
    if (endpointCount) add('endpoints.estimatedCount', endpointCount[1]);
    if (/\b(?:microsoft|office)\s*365\b/i.test(message)) add('productivity.platform', 'microsoft_365');
    if (/\bgoogle\s+workspace\b/i.test(message)) add('productivity.platform', 'google_workspace');
    if (/\b(?:no|without)\s+(?:an?\s+)?(?:it|managed service) provider\b/i.test(message)) add('itProvider.model', 'none');
    if (/\b(?:internal|in-house)\s+it\s+(?:person|manager|team)\b/i.test(message)) add('itProvider.model', 'internal');
    if (/\b(?:internal|in-house)\s+it\s+team\b/i.test(message)) add('internalIt.capability', 'team');
    if (/\b(?:part[- ]time|fractional)\s+it\b/i.test(message)) add('internalIt.capability', 'part_time');
    const location = message.match(/\b(?:based|located|office)\s+in\s+([A-Za-z][A-Za-z ,'-]{2,80})(?=[.;]|$)/i);
    if (location) add('locations.items', location[1]);
    const tools = ['Microsoft Defender', 'CrowdStrike', 'Huntress', 'SentinelOne', 'Sophos', 'Datto', 'Kaseya'];
    const mentionedTools = tools.filter((tool) => message.toLowerCase().includes(tool.toLowerCase()));
    if (mentionedTools.length) add('security.tools', mentionedTools.join('; '));
    const applications = ['Xero', 'MYOB', 'Salesforce', 'HubSpot', 'SAP', 'NetSuite', 'Autodesk', 'AWS', 'Azure'];
    const mentionedApplications = applications.filter((item) => message.toLowerCase().includes(item.toLowerCase()));
    if (mentionedApplications.length) add('applications.important', mentionedApplications.join('; '));
    if (/\b(frustrat|slow|unreliable|expensive|cost|poor response|recurring|keeps? (?:breaking|failing))\b/i.test(message)) {
        add('support.frustrations', cleanText(message, 500));
    }
    if (/\b(security|cyber|ransomware|phishing|breach|mfa|backup)\b/i.test(message)) {
        add('security.concerns', cleanText(message, 500), 'inferred');
    }
    const hasDiscoveryNeed = /\b(?:we|i|our (?:company|organisation|business))\s+(?:need|want|are looking for|are investigating|are considering|plan|hope|would like)\b/i.test(message) ||
        /\b(?:replace|improve|change)\s+(?:our\s+)?(?:it|support|provider)\b/i.test(message);
    if (hasDiscoveryNeed &&
        organisation.fieldStates['company.summary'].status !== 'known') {
        add('company.summary', cleanText(message, 500));
    }
    const timing = message.match(/\b(asap|immediately|this month|next month|this quarter|next quarter|within \d+ (?:days?|weeks?|months?))\b/i);
    if (timing) add('commercial.preferredTiming', timing[1]);
    return facts.slice(0, 20);
}

function buildMockSummary(organisation, message) {
    const context = organisation.context;
    const parts = [];
    if (context.company.name) parts.push(`${context.company.name} is evaluating No Fries`);
    else parts.push('A website visitor is evaluating No Fries');
    if (context.users.estimatedCount != null) parts.push(`for approximately ${context.users.estimatedCount} users`);
    if (context.company.summary) parts.push(`because ${context.company.summary}`);
    else parts.push(`and most recently said: ${cleanText(message, 300)}`);
    return `${parts.join(' ')}.`.slice(0, 3000);
}

function mockNextAction(organisation, message) {
    if (/\b(call|meeting|coffee|talk to (?:someone|a person)|contact me)\b/i.test(message)) {
        return { type: 'human_follow_up', timing: 'As requested', detail: 'Prospect requested human contact' };
    }
    if (organisation.discovery.missingFields.length <= 4) {
        return { type: 'start_scoping', timing: 'When the prospect is ready', detail: 'Move known discovery information into scoping' };
    }
    return { type: 'continue_chat', timing: 'Now', detail: 'Ask the next most useful discovery question' };
}

function unquotedRequestText(message) {
    return message
        .replace(/```[\s\S]*?```|`[^`\n]*`/g, ' ')
        .replace(/"[^"\n]*"|“[^”\n]*”|‘[^’\n]*’/g, ' ')
        .replace(/(^|[\s:([{])'[^'\n]+'(?=$|[\s,.!?;:)\]}])/g, '$1 ')
        .replace(/’/g, "'");
}

function explicitHumanContactRequested(message) {
    const text = unquotedRequestText(message)
        .replace(/(^|\n)\s*(?:here is (?:an?|the)\s+)?(?:for\s+)?(?:example|sample|template|training example)\s*:[^\n]*(?:\n(?!\s*\n)[^\n]*)*/gi, ' ');
    // Do not infer permission from a refusal, reported quotation, general
    // meeting vocabulary or a question about how the service works.
    // A refusal anywhere in this message wins over an earlier request.
    if (/\b(?:do not|don't|dont|never|not to|stop)\b[^.!?;\n]{0,50}\b(?:call|contact|phone|ring|email|talk|speak|book|schedule|arrange|meet|meeting)\b/i.test(text)) return false;
    // "Call me Alex" introduces a name. Only direct contact wording with an
    // end or a bounded purpose/timing continuation supplies contact intent.
    const contact = '(?:call|contact|phone|ring|email)\\s+(?:me|us)(?:\\s+(?:about|to|for|at|on|in|today|tomorrow|later|please|when|this|next|soon|back|asap)\\b|\\s*$)';
    const direct = new RegExp('^(?:please\\s+)?' + contact, 'i');
    const requested = new RegExp('^(?:can|could|would|will)\\s+(?:you|someone|somebody|a person|your team)\\s+(?:please\\s+)?' + contact, 'i');
    const firstPerson = new RegExp("^(?:i\\s+(?:would\\s+like|want)|i'd\\s+like)\\s+you\\s+to\\s+(?:please\\s+)?" + contact, 'i');
    const arranged = new RegExp('^(?:please\\s+)?(?:arrange(?:\\s+for)?|have|ask|get)\\s+(?:someone|somebody|a person|your team)\\s+(?:to\\s+)?' + contact, 'i');
    return text.split(/[.!?;,\n]+/).some(value => {
        const clause = value.trim();
        if (/\b(?:not|never|don't|dont|avoid|without)\b/i.test(clause)) return false;
        return direct.test(clause) || requested.test(clause) || firstPerson.test(clause) || arranged.test(clause) ||
            /^(?:i\s+(?:would like|want|need)|i'd like|can i|could i)\s+(?:to\s+)?(?:talk|speak|meet)\s+(?:to|with)\s+(?:someone|somebody|a person|a human|your team)\b/i.test(clause) ||
            /^(?:please\s+(?:arrange|book|schedule)|(?:can|could) we\s+(?:arrange|book|schedule))\s+(?:a\s+)?(?:meeting|call)(?:\s+(?:to discuss|about|with (?:you|someone|your team))\b|\s*$)/i.test(clause);
    });
}

function isPendingFollowUpEmail(message, session) {
    return session.conversation.nextAction.type === 'human_follow_up' &&
        session.conversation.escalation.required === true &&
        !session.organisation.context.contacts.primary.email &&
        /^(?:(?:my email(?: address)? is|it(?:'s| is)|you can (?:email|contact|reach) me at|email(?: me)? at)\s+)?[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}[.!]?\s*$/i
            .test(unquotedRequestText(message).trim());
}

function humanFollowUpReply(organisation) {
    const recorded = 'I have recorded your request for a person to follow up.';
    return organisation.context.contacts.primary.email
        ? recorded
        : recorded + ' What email address should we use?';
}

function shouldAdvanceToDiscovery(organisation) {
    return organisation.lifecycleState === 'prospect' &&
        organisation.fieldStates['company.name'].status === 'known' &&
        organisation.fieldStates['company.summary'].status === 'known';
}

function mockReply(organisation, message) {
    const context = organisation.context;
    const lower = message.toLowerCase();
    const pricingIntent = /\b(?:price|pricing|cost|quote|how much|monthly|per user|setup fee|set-up fee|onboarding fee)\b/.test(lower);
    let answer = '';
    if (/\b(?:what|which).*(?:include|cover|do you do)\b/.test(lower)) {
        answer = `${MANAGED_IT_POLICY.customerFacingServiceName} includes day-to-day support, help with business email and shared work tools, care for your computers, supplier follow-up and Proof every month. Threat protection, after-hours security help and backup are added when you choose them.`;
    } else if (pricingIntent) {
        answer = `${MANAGED_IT_POLICY.customerFacingServiceName} is NZ$${MANAGED_IT_POLICY.pricing.perUserMonthly} + GST per user each month and includes one main work computer per user. Initial set-up starts at NZ$${MANAGED_IT_POLICY.pricing.onboardingFrom} + GST. I can prepare an indicative total once we confirm the user and device counts.`;
    } else if (/\b(?:24\/7|after hours|overnight)\b/.test(lower)) {
        answer = 'Requests can be logged at any time. Staffed user support is during agreed business hours, and after-hours security help is included only when selected.';
    } else if (/\b(?:ai|agent)\b/.test(lower)) {
        answer = 'No Fries handles common low-risk requests through approved steps. Higher-risk or disruptive changes need human approval, and you receive a record of what was done.';
    } else {
        answer = context.contacts.primary.name ? `Thanks, ${context.contacts.primary.name}.` : 'Thanks — that helps.';
    }

    const missing = organisation.discovery.missingFields.map((item) => item.field);
    let question = '';
    if (pricingIntent && missing.includes('users.estimatedCount')) question = 'Roughly how many people need IT support?';
    else if (pricingIntent && missing.includes('endpoints.estimatedCount')) question = 'About how many computers or managed devices should be included?';
    else if (missing.includes('contacts.primary.name')) question = 'What should I call you?';
    else if (missing.includes('company.name')) question = 'Which organisation are you with?';
    else if (missing.includes('company.summary')) question = 'What prompted you to look at changing or improving your IT support?';
    else if (missing.includes('users.estimatedCount')) question = 'Roughly how many people use the business systems?';
    else if (missing.includes('endpoints.estimatedCount')) question = 'About how many computers or managed devices are involved?';
    else if (missing.includes('locations.items')) question = 'Which locations need to be supported?';
    else if (missing.includes('productivity.platform')) question = 'Are you mainly on Microsoft 365 or Google Workspace?';
    else if (missing.includes('itProvider.model')) question = 'Do you currently use an IT provider, an internal IT person, or both?';
    else if (missing.includes('support.frustrations')) question = 'What is the biggest support frustration you want fixed?';
    else if (missing.includes('applications.important')) question = 'Which business applications would be most important for us to understand?';
    else question = 'Would the next useful step be a service review or a follow-up call?';
    return `${answer} ${question}`;
}

function hasRepeatedUnansweredTurn(conversation, message) {
    const messages = conversation.messages || [];
    const tail = messages.slice(-2);
    return tail.length === 2 && tail[0].id !== tail[1].id &&
        tail.every(item => item.role === 'user' && item.text === message);
}

function isGroundedProspectQuestion(message) {
    const lower = String(message || '').toLowerCase();
    return /\b(?:what|which).*(?:include|cover|do you do)\b/.test(lower) ||
        /\b(?:price|pricing|cost|quote|how much|monthly|per user|setup fee|set-up fee|onboarding fee|24\/7|after hours|overnight)\b/.test(lower) ||
        /\b(?:how|where).*(?:ai|agent)\b/.test(lower);
}

function isInformationalProspectTurn(message) {
    const text = unquotedRequestText(message);
    return Boolean(publicHelpReply(message)) || isGroundedProspectQuestion(text) ||
        /\b(?:need|want|would like|(?:are )?looking for)\s+(?:(?:to\s+)?(?:know|understand|learn|find out)\b|(?:(?:some|more)\s+)?(?:information|info|details|advice)\b)/i.test(text);
}

function groundedFaqReply(organisation, message, conversation = {}) {
    const publicHelp = publicHelpReply(message);
    if (publicHelp) return publicHelp.text;
    const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
    const pricingJourneyActive = shouldOfferPrice({}, message) || messages.some((item) => (
        item && item.role === 'user' && shouldOfferPrice({}, item.text)
    ));
    const finalQuoteAlreadyProvided = messages.some((item) => (
        item && item.role === 'assistant' && /current No Fries estimate is NZ\$[\d,]+/i.test(String(item.text || ''))
    ));
    if (pricingJourneyActive && !finalQuoteAlreadyProvided) {
        const estimate = estimateManagedItPrice(organisation && organisation.context || {});
        if (estimate.status !== 'needs_more_info') return priceReply(estimate);
    }
    return isGroundedProspectQuestion(message) ? mockReply(organisation, message) : '';
}

function publicError(statusCode, message, code) {
    const error = new Error(message);
    error.statusCode = statusCode;
    error.details = { code };
    return error;
}

function prospectPromptCacheKey() {
    return `nofries:prospect:${PROSPECT_PROMPT_VERSION}:${PROSPECT_TOOL_SCHEMA_VERSION}:${managedItPolicyCacheSegment()}:${NOFRIES_PUBLIC_KNOWLEDGE.knowledgeVersion}`;
}

function promptCacheSettings(prefix) {
    const settings = {};
    if (prefix.prompt_cache_key) settings.prompt_cache_key = prefix.prompt_cache_key;
    if (prefix.prompt_cache_options) settings.prompt_cache_options = prefix.prompt_cache_options;
    return settings;
}

function openAIMetadata(component, releaseIdentity) {
    return {
        component,
        channel: 'website',
        prompt_version: PROSPECT_PROMPT_VERSION,
        tool_schema_version: PROSPECT_TOOL_SCHEMA_VERSION,
        policy_id: MANAGED_IT_POLICY.policyId,
        policy_version: MANAGED_IT_POLICY.legacyPriceVersion,
        release_sha: releaseIdentity && releaseIdentity.releaseSha || 'unstamped'
    };
}

function agentIdentities(model, releaseIdentity) {
    return {
        promptVersion: PROSPECT_PROMPT_VERSION,
        toolSchemaVersion: PROSPECT_TOOL_SCHEMA_VERSION,
        policyId: MANAGED_IT_POLICY.policyId,
        policyVersion: MANAGED_IT_POLICY.legacyPriceVersion,
        policyEffectiveFrom: MANAGED_IT_POLICY.effectiveFrom,
        model: model.model,
        reasoningEffort: model.reasoningEffort,
        releaseSha: releaseIdentity && releaseIdentity.releaseSha || '',
        releaseRunId: releaseIdentity && releaseIdentity.runId || ''
    };
}

module.exports = {
    AGENT_ID,
    PROSPECT_PROMPT_VERSION,
    createProspectAgent,
    extractExplicitFacts,
    extractMockFacts: extractExplicitFacts,
    guardVisitorMessage,
    prospectPromptCacheKey,
    prospectStableInstructions,
    prospectInstructions,
    resolveProspectRuntime
};
