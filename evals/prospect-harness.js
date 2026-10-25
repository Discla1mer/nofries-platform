const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isDeepStrictEqual } = require('util');

const {
    errorResponse,
    handleProspectChatRequest,
    handleProspectSessionRequest
} = require('../api/shared/prospectRuntime');
const { PROSPECT_PROMPT_VERSION } = require('../api/shared/agents/prospectAgent');
const { resolveModel } = require('../api/shared/agents/modelRegistry');
const { PROSPECT_TOOL_SCHEMA_VERSION } = require('../api/shared/agents/prospectTools');
const { createLifecycleRepository } = require('../api/shared/appLifecycle/lifecycleRepository');
const { createLifecycleService } = require('../api/shared/appLifecycle/lifecycleService');
const {
    createProspectSessionManager,
    createPublicAgentAccess
} = require('../api/shared/lifecycle/prospectSession');
const { MANAGED_IT_POLICY } = require('../api/shared/managedItPolicy');
const { PRICE_VERSION } = require('../api/shared/mspPricing');

const HARNESS_SCHEMA_VERSION = 1;
const HARNESS_VERSION = 'prospect-application-path-v1';
const DEFAULT_DATASET_PATH = path.join(__dirname, 'prospect-discovery.json');
const CONTRACT_FILES = [
    'api/shared/abuseProtection.js',
    'api/shared/agents/modelRegistry.js',
    'api/shared/agents/nofriesPublicKnowledge.js',
    'api/shared/agents/openaiResponsesClient.js',
    'api/shared/agents/promptCaching.js',
    'api/shared/agents/prospectAgent.js',
    'api/shared/agents/prospectInjectionGuard.js',
    'api/shared/agents/prospectTools.js',
    'api/shared/appLifecycle/customerOperations.js',
    'api/shared/appLifecycle/lifecycleModel.js',
    'api/shared/appLifecycle/lifecycleRepository.js',
    'api/shared/appLifecycle/lifecycleService.js',
    'api/shared/appLifecycle/lifecycleState.js',
    'api/shared/appLifecycle/monthlyProof.js',
    'api/shared/appLifecycle/postgresLifecycleRepository.js',
    'api/shared/lifecycle/prospectSession.js',
    'api/shared/appLifecycleRuntime.js',
    'api/shared/appTenantAccess.js',
    'api/shared/releaseIdentity.js',
    'api/shared/requestLimits.js',
    'api/shared/securityHeaders.js',
    'api/shared/mspPricing.js',
    'api/shared/managedItPolicy.js',
    'api/shared/prospectRuntime.js'
];

function loadProspectEvalDataset(datasetPath = DEFAULT_DATASET_PATH) {
    const absolutePath = path.resolve(datasetPath);
    const raw = fs.readFileSync(absolutePath, 'utf8');
    const parsed = JSON.parse(raw);
    const dataset = Array.isArray(parsed)
        ? {
            schemaVersion: 0,
            suiteId: 'legacy-prospect-discovery',
            suiteVersion: 'legacy',
            description: '',
            scenarios: parsed
        }
        : parsed;
    validateDataset(dataset);
    return {
        dataset,
        absolutePath,
        relativePath: normaliseRelativePath(absolutePath),
        sha256: sha256(raw)
    };
}

async function runProspectEvalSuite(options = {}) {
    const runtime = normaliseRuntime(options.runtime || process.env.NOFRIES_EVAL_RUNTIME || 'mock');
    const loaded = loadProspectEvalDataset(options.datasetPath);
    const requestedIds = normaliseScenarioIds(options.scenarioIds || options.scenarios || []);
    const scenarios = selectScenarios(loaded.dataset.scenarios, requestedIds);
    const env = evalEnvironment(runtime, options.env);
    if (runtime === 'openai' && !String(env.OPENAI_API_KEY || '').trim()) {
        throw new Error('OPENAI_API_KEY is required for the OpenAI prospect evaluation runtime');
    }

    const startedAt = new Date();
    const results = [];
    for (let index = 0; index < scenarios.length; index += 1) {
        results.push(await runProspectScenario(scenarios[index], {
            runtime,
            env,
            scenarioIndex: index,
            dataset: loaded.dataset
        }));
    }
    const completedAt = new Date();
    const usage = sumUsage(results.flatMap((scenario) => scenario.evidence.transcript));
    const approximateCostUsd = roundCost(results.reduce(
        (total, scenario) => total + Number(scenario.evidence.approximateCostUsd || 0),
        0
    ));
    const passed = results.filter((scenario) => scenario.passed).length;
    const model = resolveModel('prospect', env);
    const actualProviderModels = [...new Set(results
        .flatMap((scenario) => scenario.evidence.agentRuns || [])
        .map((run) => run.providerModel)
        .filter(Boolean))].sort();
    const contract = applicationContractManifest();
    const releaseTarget = results[0] && results[0].evidence.target || {};

    return {
        schemaVersion: HARNESS_SCHEMA_VERSION,
        kind: 'nofries.prospect-eval-result',
        harness: {
            id: 'nofries-prospect-application-path',
            version: HARNESS_VERSION,
            target: 'handleProspectSessionRequest + handleProspectChatRequest',
            applicationContractSha256: contract.sha256,
            applicationContractFiles: contract.files
        },
        suite: {
            id: loaded.dataset.suiteId,
            version: loaded.dataset.suiteVersion,
            schemaVersion: loaded.dataset.schemaVersion,
            dataClassification: loaded.dataset.dataClassification,
            dataset: loaded.relativePath,
            datasetSha256: loaded.sha256,
            selectedScenarioIds: scenarios.map((scenario) => scenario.id)
        },
        run: {
            runtime,
            model: runtime === 'openai' ? (actualProviderModels[0] || model.model) : 'mock-deterministic',
            configuredModel: model.model,
            actualProviderModels,
            reasoningEffort: model.reasoningEffort,
            promptVersion: PROSPECT_PROMPT_VERSION,
            toolSchemaVersion: PROSPECT_TOOL_SCHEMA_VERSION,
            commercialPolicyId: MANAGED_IT_POLICY.policyId,
            commercialPolicyVersion: PRICE_VERSION,
            commercialPolicyEffectiveFrom: MANAGED_IT_POLICY.effectiveFrom,
            releaseSha: releaseTarget.releaseSha || '',
            releaseRunId: releaseTarget.releaseRunId || '',
            startedAt: startedAt.toISOString(),
            completedAt: completedAt.toISOString(),
            durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
            usage,
            approximateCostUsd
        },
        summary: {
            passed,
            failed: results.length - passed,
            total: results.length
        },
        scenarios: results
    };
}

async function runProspectScenario(scenario, options = {}) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-prospect-eval-'));
    const env = Object.assign({}, options.env || {}, {
        NOFRIES_DEFAULT_TENANT_ID: `prospect-eval-${safeId(scenario.id)}`,
        NOFRIES_TENANT_NAME: `No Fries prospect evaluation — ${scenario.id}`
    });
    const repository = createLifecycleRepository({ provider: 'local', dataDir });
    const lifecycleService = createLifecycleService({ repository, env });
    const access = createPublicAgentAccess(env);
    const sessionManager = createProspectSessionManager({ env });
    const clientAddress = scenarioClientAddress(options.scenarioIndex);
    const dependencies = { env, lifecycleService, access, sessionManager };
    const transcript = [];
    let lastDone = null;
    let lastErrorCode = '';

    try {
        const bootstrap = await handleProspectSessionRequest(
            prospectRequest('GET', '', '', clientAddress),
            dependencies
        );
        const target = targetEvidence(bootstrap);
        const cookie = responseCookie(bootstrap);
        if (!cookie) throw new Error(`Prospect evaluation ${scenario.id} did not receive a session cookie`);

        for (let turnIndex = 0; turnIndex < scenario.turns.length; turnIndex += 1) {
            const visitorMessage = scenario.turns[turnIndex];
            const turnStartedAt = Date.now();
            let response;
            let events = [];
            let responseError = null;
            try {
                response = await handleProspectChatRequest(
                    prospectRequest('POST', visitorMessage, cookie, clientAddress),
                    dependencies
                );
                events = parseSseEvents(response.body);
            } catch (error) {
                responseError = error;
                response = errorResponse(error);
            }

            const done = lastEvent(events, 'done');
            const streamedError = lastEvent(events, 'error');
            const responseBody = response && response.body && typeof response.body === 'object'
                ? response.body
                : {};
            const errorCode = String(
                responseError && responseError.details && responseError.details.code ||
                streamedError && streamedError.code ||
                responseBody.code ||
                ''
            );
            const reply = String(
                done && done.text ||
                events.filter((event) => event.event === 'delta').map((event) => event.data.delta || '').join('') ||
                ''
            );
            const turnEvidence = {
                turn: turnIndex + 1,
                visitor: sanitiseEvidenceText(visitorMessage),
                status: Number(response && response.status || responseError && responseError.statusCode || 500),
                reply: sanitiseEvidenceText(reply),
                errorCode,
                runtime: sanitiseEvidenceValue(done && done.runtime || null),
                model: sanitiseEvidenceText(done && done.model || ''),
                usage: normaliseUsage(done && done.usage),
                approximateCostUsd: roundCost(done && done.approximateCostUsd),
                traceId: sanitiseEvidenceText(done && done.traceId || ''),
                providerModel: sanitiseEvidenceText(done && done.providerModel || ''),
                identities: sanitiseEvidenceValue(done && done.identities || null),
                security: sanitiseEvidenceValue(done && done.security || null),
                pricing: sanitiseEvidenceValue(done && done.pricing || null),
                latencyMs: Math.max(0, Date.now() - turnStartedAt)
            };
            transcript.push(turnEvidence);
            if (done) lastDone = done;
            if (errorCode) {
                lastErrorCode = errorCode;
                break;
            }
        }

        const stored = await repository.read(access);
        const storage = storageEvidence(stored);
        const agentRuns = agentRunEvidence(stored);
        const finalOrganisation = lastDone && lastDone.organisation || null;
        const finalConversation = lastDone && lastDone.conversation || null;
        const assertions = evaluateScenario(scenario, {
            transcript,
            lastDone,
            lastErrorCode,
            finalOrganisation,
            finalConversation,
            stored,
            storage
        });
        assertions.push(...evaluateRuntimeIdentity({
            runtime: options.runtime,
            transcript,
            agentRuns,
            target
        }));
        const scenarioUsage = sumUsage(transcript);
        const approximateCostUsd = roundCost(transcript.reduce(
            (total, turn) => total + Number(turn.approximateCostUsd || 0),
            0
        ));

        return {
            id: scenario.id,
            passed: assertions.every((assertion) => assertion.passed),
            assertionCount: assertions.length,
            failedAssertions: assertions.filter((assertion) => !assertion.passed).map((assertion) => assertion.name),
            assertions,
            evidence: {
                scenarioSha256: sha256(JSON.stringify(scenario)),
                target,
                transcript,
                final: {
                    lifecycleState: sanitiseEvidenceText(finalOrganisation && finalOrganisation.lifecycleState || ''),
                    nextActionType: sanitiseEvidenceText(finalConversation && finalConversation.nextAction && finalConversation.nextAction.type || ''),
                    model: sanitiseEvidenceText(lastDone && lastDone.model || ''),
                    securityCode: sanitiseEvidenceText(lastDone && lastDone.security && lastDone.security.code || ''),
                    errorCode: sanitiseEvidenceText(lastErrorCode),
                    knownFacts: knownFactEvidence(finalOrganisation),
                    unknownFacts: unknownFactEvidence(finalOrganisation),
                    pricing: sanitiseEvidenceValue(lastDone && lastDone.pricing || null)
                },
                storage,
                agentRuns,
                usage: scenarioUsage,
                approximateCostUsd
            }
        };
    } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
}

function evaluateScenario(scenario, actual) {
    const expected = scenario.expect || {};
    const assertions = [];
    const organisation = actual.finalOrganisation || {};
    const context = organisation.context || {};
    const fieldStates = organisation.fieldStates || {};
    const finalReply = actual.transcript.length
        ? actual.transcript[actual.transcript.length - 1].reply
        : '';
    const allReplies = actual.transcript.map((turn) => turn.reply).filter(Boolean).join('\n');
    const storedAssistantText = (actual.stored.conversations || [])
        .flatMap((conversation) => conversation.messages || [])
        .filter((message) => message.role === 'assistant')
        .map((message) => sanitiseEvidenceText(message.text))
        .join('\n');
    const usage = sumUsage(actual.transcript);

    Object.entries(expected.facts || {}).forEach(([field, expectedValue]) => {
        const actualValue = getPath(context, field);
        addAssertion(assertions, `fact:${field}`, isDeepStrictEqual(actualValue, expectedValue), {
            expected: expectedValue,
            actual: actualValue
        });
    });
    (expected.unknownFacts || []).forEach((field) => {
        addAssertion(assertions, `unknown:${field}`, fieldStates[field] && fieldStates[field].status === 'unknown', {
            expected: 'unknown',
            actual: fieldStates[field] && fieldStates[field].status || 'missing'
        });
    });
    if (expected.lifecycleState != null) {
        addAssertion(assertions, 'lifecycleState', organisation.lifecycleState === expected.lifecycleState, {
            expected: expected.lifecycleState,
            actual: organisation.lifecycleState || ''
        });
    }
    if (expected.nextActionType != null) {
        const actualType = actual.finalConversation && actual.finalConversation.nextAction && actual.finalConversation.nextAction.type || '';
        addAssertion(assertions, 'nextActionType', actualType === expected.nextActionType, {
            expected: expected.nextActionType,
            actual: actualType
        });
    }
    (expected.replyMustInclude || []).forEach((value) => {
        addAssertion(assertions, `replyIncludes:${value}`, includesCaseInsensitive(finalReply, value), {
            expected: value,
            actual: finalReply
        });
    });
    (expected.forbiddenReplyPatterns || []).forEach((pattern) => {
        const regex = new RegExp(pattern, 'i');
        addAssertion(assertions, `replyForbids:${pattern}`, !regex.test(allReplies), {
            expected: `not ${pattern}`,
            actual: allReplies
        });
    });
    if (expected.maxQuestionsPerReply != null) {
        actual.transcript.forEach((turn) => {
            const count = (turn.reply.match(/\?/g) || []).length;
            addAssertion(assertions, `turn:${turn.turn}:maxQuestions`, count <= expected.maxQuestionsPerReply, {
                expected: expected.maxQuestionsPerReply,
                actual: count
            });
        });
    }
    if (expected.errorCode != null) {
        addAssertion(assertions, 'errorCode', actual.lastErrorCode === expected.errorCode, {
            expected: expected.errorCode,
            actual: actual.lastErrorCode
        });
    }
    if (expected.securityCode != null) {
        const actualCode = actual.lastDone && actual.lastDone.security && actual.lastDone.security.code || '';
        addAssertion(assertions, 'securityCode', actualCode === expected.securityCode, {
            expected: expected.securityCode,
            actual: actualCode
        });
    }
    if (expected.model != null) {
        const actualModel = actual.lastDone && actual.lastDone.model || '';
        addAssertion(assertions, 'model', actualModel === expected.model, {
            expected: expected.model,
            actual: actualModel
        });
    }
    assertNumber(assertions, 'storedMessageCount', expected.storedMessageCount, actual.storage.messages);
    assertNumber(assertions, 'storedOrganisationCount', expected.storedOrganisationCount, actual.storage.organisations);
    assertNumber(assertions, 'storedConversationCount', expected.storedConversationCount, actual.storage.conversations);
    assertNumber(assertions, 'securityEventCount', expected.securityEventCount, actual.storage.securityEvents);
    assertNumber(assertions, 'totalTokens', expected.totalTokens, usage.totalTokens);

    Object.entries(expected.pricing || {}).forEach(([field, expectedValue]) => {
        const actualValue = getPath(actual.lastDone && actual.lastDone.pricing || {}, field);
        addAssertion(assertions, `pricing:${field}`, isDeepStrictEqual(actualValue, expectedValue), {
            expected: expectedValue,
            actual: actualValue
        });
    });
    Object.entries(expected.conversationTextMaxOccurrences || {}).forEach(([value, maximum]) => {
        const count = countOccurrences(storedAssistantText || allReplies, value);
        addAssertion(assertions, `conversationMaxOccurrences:${value}`, count <= maximum, {
            expected: maximum,
            actual: count
        });
    });
    return assertions;
}

function evaluateScenarioEvidence(scenario, evidence, runtime) {
    const expected = scenario && scenario.expect || {};
    const source = evidence && typeof evidence === 'object' && !Array.isArray(evidence) ? evidence : {};
    const transcript = Array.isArray(source.transcript) ? source.transcript : [];
    const final = source.final && typeof source.final === 'object' && !Array.isArray(source.final)
        ? source.final
        : {};
    const knownFacts = final.knownFacts && typeof final.knownFacts === 'object' && !Array.isArray(final.knownFacts)
        ? final.knownFacts
        : {};
    const unknownFacts = Array.isArray(final.unknownFacts) ? final.unknownFacts : [];
    const storage = source.storage && typeof source.storage === 'object' && !Array.isArray(source.storage)
        ? source.storage
        : {};
    const finalReply = transcript.length ? String(transcript[transcript.length - 1] && transcript[transcript.length - 1].reply || '') : '';
    const allReplies = transcript.map((turn) => String(turn && turn.reply || '')).filter(Boolean).join('\n');
    const assertions = [];

    Object.entries(expected.facts || {}).forEach(([field, expectedValue]) => {
        const actualValue = knownFacts[field];
        addAssertion(assertions, `fact:${field}`, isDeepStrictEqual(actualValue, expectedValue), {
            expected: expectedValue,
            actual: actualValue
        });
    });
    (expected.unknownFacts || []).forEach((field) => {
        addAssertion(assertions, `unknown:${field}`, unknownFacts.includes(field), {
            expected: 'unknown',
            actual: unknownFacts.includes(field) ? 'unknown' : 'missing'
        });
    });
    if (expected.lifecycleState != null) {
        addAssertion(assertions, 'lifecycleState', final.lifecycleState === expected.lifecycleState, {
            expected: expected.lifecycleState,
            actual: final.lifecycleState || ''
        });
    }
    if (expected.nextActionType != null) {
        addAssertion(assertions, 'nextActionType', final.nextActionType === expected.nextActionType, {
            expected: expected.nextActionType,
            actual: final.nextActionType || ''
        });
    }
    (expected.replyMustInclude || []).forEach((value) => {
        addAssertion(assertions, `replyIncludes:${value}`, includesCaseInsensitive(finalReply, value), {
            expected: value,
            actual: finalReply
        });
    });
    (expected.forbiddenReplyPatterns || []).forEach((pattern) => {
        const regex = new RegExp(pattern, 'i');
        addAssertion(assertions, `replyForbids:${pattern}`, !regex.test(allReplies), {
            expected: `not ${pattern}`,
            actual: allReplies
        });
    });
    if (expected.maxQuestionsPerReply != null) {
        transcript.forEach((turn) => {
            const reply = String(turn && turn.reply || '');
            const count = (reply.match(/\?/g) || []).length;
            addAssertion(assertions, `turn:${turn && turn.turn}:maxQuestions`, count <= expected.maxQuestionsPerReply, {
                expected: expected.maxQuestionsPerReply,
                actual: count
            });
        });
    }
    if (expected.errorCode != null) {
        addAssertion(assertions, 'errorCode', final.errorCode === expected.errorCode, {
            expected: expected.errorCode,
            actual: final.errorCode || ''
        });
    }
    if (expected.securityCode != null) {
        addAssertion(assertions, 'securityCode', final.securityCode === expected.securityCode, {
            expected: expected.securityCode,
            actual: final.securityCode || ''
        });
    }
    if (expected.model != null) {
        addAssertion(assertions, 'model', final.model === expected.model, {
            expected: expected.model,
            actual: final.model || ''
        });
    }
    assertNumber(assertions, 'storedMessageCount', expected.storedMessageCount, storage.messages);
    assertNumber(assertions, 'storedOrganisationCount', expected.storedOrganisationCount, storage.organisations);
    assertNumber(assertions, 'storedConversationCount', expected.storedConversationCount, storage.conversations);
    assertNumber(assertions, 'securityEventCount', expected.securityEventCount, storage.securityEvents);
    assertNumber(assertions, 'totalTokens', expected.totalTokens, sumUsage(transcript).totalTokens);

    Object.entries(expected.pricing || {}).forEach(([field, expectedValue]) => {
        const actualValue = getPath(final.pricing || {}, field);
        addAssertion(assertions, `pricing:${field}`, isDeepStrictEqual(actualValue, expectedValue), {
            expected: expectedValue,
            actual: actualValue
        });
    });
    Object.entries(expected.conversationTextMaxOccurrences || {}).forEach(([value, maximum]) => {
        const count = countOccurrences(allReplies, value);
        addAssertion(assertions, `conversationMaxOccurrences:${value}`, count <= maximum, {
            expected: maximum,
            actual: count
        });
    });
    assertions.push(...evaluateRuntimeIdentity({
        runtime,
        transcript,
        agentRuns: Array.isArray(source.agentRuns) ? source.agentRuns : [],
        target: source.target && typeof source.target === 'object' && !Array.isArray(source.target) ? source.target : {}
    }));
    return assertions;
}

function parseSseEvents(value) {
    const events = [];
    String(value || '').split(/\r?\n\r?\n/).forEach((frame) => {
        const lines = frame.split(/\r?\n/);
        const event = lines.find((line) => line.startsWith('event:'));
        const data = lines.filter((line) => line.startsWith('data:'));
        if (!event || !data.length) return;
        try {
            events.push({
                event: event.slice('event:'.length).trim(),
                data: JSON.parse(data.map((line) => line.slice('data:'.length).trim()).join('\n'))
            });
        } catch (error) {
            events.push({
                event: event.slice('event:'.length).trim(),
                data: { code: 'invalid_sse_json' }
            });
        }
    });
    return events;
}

function sanitiseEvidenceText(value) {
    let text = String(value || '').slice(0, 6000);
    text = text.replace(
        /\b(password\s*(?:is|=|:)|(?:api[_ -]?key|client[_ -]?secret|access[_ -]?token)\s*(?:is|=|:)|(?:recovery|mfa|2fa)\s*code\s*(?:is|=|:))\s*\S+/gi,
        '$1 [REDACTED]'
    );
    text = text.replace(/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]{10,})?/g, '[REDACTED_TOKEN]');
    text = text.replace(/\b[A-Z0-9._%+-]+@(?!(?:example\.(?:com|org|net)|example|invalid)\b)[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED_EMAIL]');
    return text;
}

function sanitiseEvidenceValue(value, depth = 0) {
    if (depth > 8) return '[TRUNCATED]';
    if (typeof value === 'string') return sanitiseEvidenceText(value);
    if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitiseEvidenceValue(item, depth + 1));
    if (!value || typeof value !== 'object') return value == null ? null : value;
    return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [
        key,
        sanitiseEvidenceValue(item, depth + 1)
    ]));
}

function validateDataset(dataset) {
    if (!dataset || typeof dataset !== 'object') throw new Error('Prospect eval dataset must be an object');
    if (!Number.isInteger(dataset.schemaVersion) || dataset.schemaVersion < 0) {
        throw new Error('Prospect eval dataset requires an integer schemaVersion');
    }
    if (!String(dataset.suiteId || '').trim()) throw new Error('Prospect eval dataset requires suiteId');
    if (!String(dataset.suiteVersion || '').trim()) throw new Error('Prospect eval dataset requires suiteVersion');
    if (dataset.dataClassification !== 'synthetic_sanitised') {
        throw new Error('Prospect eval fixtures must be classified synthetic_sanitised');
    }
    if (!Array.isArray(dataset.scenarios) || !dataset.scenarios.length) {
        throw new Error('Prospect eval dataset requires at least one scenario');
    }
    const ids = new Set();
    dataset.scenarios.forEach((scenario) => {
        const id = String(scenario && scenario.id || '').trim();
        if (!id || !/^[a-z0-9][a-z0-9_-]{2,100}$/.test(id)) {
            throw new Error(`Prospect eval scenario has an invalid id: ${id || '(missing)'}`);
        }
        if (ids.has(id)) throw new Error(`Prospect eval scenario id is duplicated: ${id}`);
        ids.add(id);
        if (!Array.isArray(scenario.turns) || !scenario.turns.length || scenario.turns.some((turn) => !String(turn || '').trim())) {
            throw new Error(`Prospect eval scenario ${id} requires non-empty turns`);
        }
        if (!scenario.expect || typeof scenario.expect !== 'object') {
            throw new Error(`Prospect eval scenario ${id} requires expectations`);
        }
        (scenario.expect.forbiddenReplyPatterns || []).forEach((pattern) => new RegExp(pattern, 'i'));
    });
}

function evalEnvironment(runtime, supplied = {}) {
    return Object.assign({}, process.env, supplied || {}, {
        NOFRIES_DEFAULT_TENANT_ID: 'prospect-eval',
        NOFRIES_TENANT_NAME: 'No Fries prospect evaluation',
        NOFRIES_PROSPECT_SIGNING_SECRET: 'prospect-evaluation-secret-longer-than-thirty-two-characters',
        NOFRIES_PROSPECT_AGENT_RUNTIME: runtime,
        NOFRIES_PUBLIC_URL: 'https://nofries.nz',
        NOFRIES_RATE_API_PROSPECT_SESSION_MAX: '10000',
        NOFRIES_RATE_API_PROSPECT_CHAT_MAX: '10000'
    });
}

function selectScenarios(scenarios, requestedIds) {
    if (!requestedIds.length) return scenarios.slice();
    const byId = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
    const missing = requestedIds.filter((id) => !byId.has(id));
    if (missing.length) throw new Error(`Unknown prospect eval scenario: ${missing.join(', ')}`);
    return requestedIds.map((id) => byId.get(id));
}

function normaliseScenarioIds(value) {
    const values = Array.isArray(value) ? value : [value];
    return [...new Set(values.flatMap((item) => String(item || '').split(','))
        .map((item) => item.trim())
        .filter(Boolean))];
}

function prospectRequest(method, message, cookie, clientAddress) {
    return {
        method,
        headers: {
            cookie,
            'content-type': 'application/json',
            'sec-fetch-site': 'same-origin',
            'user-agent': 'NoFries-Eval/1.0',
            'x-forwarded-for': clientAddress
        },
        body: method === 'POST' ? { message, campaign: 'repository_eval' } : undefined
    };
}

function responseCookie(response) {
    const header = response && response.headers && (
        response.headers['Set-Cookie'] || response.headers['set-cookie']
    );
    return String(Array.isArray(header) ? header[0] : header || '').split(';')[0];
}

function storageEvidence(state) {
    const conversations = Array.isArray(state.conversations) ? state.conversations : [];
    return {
        organisations: Array.isArray(state.organisations) ? state.organisations.length : 0,
        conversations: conversations.length,
        messages: conversations.reduce((total, conversation) => total + (
            Array.isArray(conversation.messages) ? conversation.messages.length : 0
        ), 0),
        securityEvents: Array.isArray(state.prospectSecurityEvents) ? state.prospectSecurityEvents.length : 0,
        audit: Array.isArray(state.audit) ? state.audit.length : 0,
        agentRuns: Array.isArray(state.observability)
            ? state.observability.filter((event) => event.eventType === 'agent.run').length
            : 0
    };
}

function agentRunEvidence(state) {
    return (Array.isArray(state && state.observability) ? state.observability : [])
        .filter((event) => event && event.eventType === 'agent.run')
        .map((event) => sanitiseEvidenceValue({
            agent: event.agent,
            model: event.model,
            providerModel: event.providerModel,
            runtime: event.runtime,
            reasoningEffort: event.reasoningEffort,
            promptVersion: event.promptVersion,
            toolSchemaVersion: event.toolSchemaVersion,
            policyId: event.policyId,
            policyVersion: event.policyVersion,
            policyEffectiveFrom: event.policyEffectiveFrom,
            releaseSha: event.releaseSha,
            releaseRunId: event.releaseRunId,
            outcome: event.outcome,
            inputTokens: event.inputTokens,
            cachedInputTokens: event.cachedInputTokens,
            cacheWriteTokens: event.cacheWriteTokens,
            outputTokens: event.outputTokens,
            reasoningTokens: event.reasoningTokens,
            totalTokens: event.totalTokens,
            toolFailures: event.toolFailures,
            approximateCostUsd: event.approximateCostUsd,
            traceId: event.traceId
        }));
}

function evaluateRuntimeIdentity(actual) {
    const assertions = [];
    const modelBackedTurns = (actual.transcript || []).filter((turn) => (
        turn.status === 200 &&
        !String(turn.model || '').startsWith('deterministic-') &&
        !turn.errorCode
    ));
    const successfulRuns = (actual.agentRuns || []).filter((run) => run.outcome === 'success');
    addAssertion(assertions, 'runtime:agentRunCount', successfulRuns.length === modelBackedTurns.length, {
        expected: modelBackedTurns.length,
        actual: successfulRuns.length
    });

    successfulRuns.forEach((run, index) => {
        const prefix = `runtime:agentRun:${index + 1}`;
        addAssertion(assertions, `${prefix}:runtime`, run.runtime === actual.runtime, {
            expected: actual.runtime,
            actual: run.runtime
        });
        addAssertion(assertions, `${prefix}:promptVersion`, run.promptVersion === PROSPECT_PROMPT_VERSION, {
            expected: PROSPECT_PROMPT_VERSION,
            actual: run.promptVersion
        });
        addAssertion(assertions, `${prefix}:toolSchemaVersion`, run.toolSchemaVersion === PROSPECT_TOOL_SCHEMA_VERSION, {
            expected: PROSPECT_TOOL_SCHEMA_VERSION,
            actual: run.toolSchemaVersion
        });
        addAssertion(assertions, `${prefix}:policyId`, run.policyId === MANAGED_IT_POLICY.policyId, {
            expected: MANAGED_IT_POLICY.policyId,
            actual: run.policyId
        });
        addAssertion(assertions, `${prefix}:policyVersion`, run.policyVersion === PRICE_VERSION, {
            expected: PRICE_VERSION,
            actual: run.policyVersion
        });
        addAssertion(assertions, `${prefix}:policyEffectiveFrom`, run.policyEffectiveFrom === MANAGED_IT_POLICY.effectiveFrom, {
            expected: MANAGED_IT_POLICY.effectiveFrom,
            actual: run.policyEffectiveFrom
        });
        if (actual.target.releaseSha) {
            addAssertion(assertions, `${prefix}:releaseSha`, run.releaseSha === actual.target.releaseSha, {
                expected: actual.target.releaseSha,
                actual: run.releaseSha
            });
        }
        if (actual.runtime === 'openai') {
            addAssertion(assertions, `${prefix}:providerModel`, Boolean(run.providerModel), {
                expected: 'provider-returned model identity',
                actual: run.providerModel
            });
            addAssertion(assertions, `${prefix}:traceId`, Boolean(run.traceId), {
                expected: 'provider request/trace identifier',
                actual: run.traceId ? 'present' : 'missing'
            });
        }
    });

    const transcriptUsage = sumUsage(actual.transcript);
    const persistedUsage = sumUsage(successfulRuns);
    addAssertion(assertions, 'runtime:persistedUsage', isDeepStrictEqual(persistedUsage, transcriptUsage), {
        expected: transcriptUsage,
        actual: persistedUsage
    });
    return assertions;
}

function knownFactEvidence(organisation) {
    const context = organisation && organisation.context || {};
    const fieldStates = organisation && organisation.fieldStates || {};
    return Object.fromEntries(Object.entries(fieldStates)
        .filter(([, state]) => state && state.status === 'known')
        .map(([field]) => [field, sanitiseEvidenceValue(getPath(context, field))]));
}

function unknownFactEvidence(organisation) {
    const fieldStates = organisation && organisation.fieldStates || {};
    return Object.entries(fieldStates)
        .filter(([, state]) => !state || state.status !== 'known')
        .map(([field]) => field)
        .sort();
}

function sumUsage(turns) {
    return (turns || []).reduce((total, turn) => {
        const usage = normaliseUsage(turn && (turn.usage || turn));
        total.inputTokens += usage.inputTokens;
        total.outputTokens += usage.outputTokens;
        total.totalTokens += usage.totalTokens;
        total.cachedInputTokens += usage.cachedInputTokens;
        total.cacheWriteTokens += usage.cacheWriteTokens;
        total.reasoningTokens += usage.reasoningTokens;
        return total;
    }, {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0
    });
}

function normaliseUsage(value) {
    const inputTokens = nonNegative(value && (value.inputTokens || value.input_tokens));
    const outputTokens = nonNegative(value && (value.outputTokens || value.output_tokens));
    const inputDetails = value && (value.inputTokensDetails || value.input_tokens_details) || {};
    const outputDetails = value && (value.outputTokensDetails || value.output_tokens_details) || {};
    return {
        inputTokens,
        outputTokens,
        totalTokens: nonNegative(value && (value.totalTokens || value.total_tokens) || inputTokens + outputTokens),
        cachedInputTokens: nonNegative(
            value && (value.cachedInputTokens || value.cached_input_tokens) ||
            inputDetails.cachedTokens ||
            inputDetails.cached_tokens
        ),
        cacheWriteTokens: nonNegative(
            value && (value.cacheWriteTokens || value.cache_write_tokens) ||
            inputDetails.cacheWriteTokens ||
            inputDetails.cache_write_tokens
        ),
        reasoningTokens: nonNegative(
            value && (value.reasoningTokens || value.reasoning_tokens) ||
            outputDetails.reasoningTokens ||
            outputDetails.reasoning_tokens
        )
    };
}

function targetEvidence(bootstrap) {
    const body = bootstrap && bootstrap.body || {};
    const assistant = body.assistant || {};
    const release = body.release || {};
    return {
        releaseSha: sanitiseEvidenceText(release.sha || ''),
        releaseRunId: sanitiseEvidenceText(release.runId || ''),
        assistant: {
            agent: sanitiseEvidenceText(assistant.agent || ''),
            runtime: sanitiseEvidenceValue(assistant.runtime || null),
            model: sanitiseEvidenceText(assistant.model || ''),
            promptVersion: sanitiseEvidenceText(assistant.promptVersion || PROSPECT_PROMPT_VERSION),
            toolSchemaVersion: sanitiseEvidenceText(assistant.toolSchemaVersion || PROSPECT_TOOL_SCHEMA_VERSION),
            pricing: sanitiseEvidenceValue(assistant.pricing || null)
        }
    };
}

function applicationContractManifest() {
    const root = path.resolve(__dirname, '..');
    const hash = crypto.createHash('sha256');
    const files = CONTRACT_FILES.map((relativePath) => {
        const absolutePath = path.join(root, relativePath);
        if (!fs.existsSync(absolutePath)) {
            throw new Error(`Prospect application contract file is missing: ${relativePath}`);
        }
        const content = fs.readFileSync(absolutePath);
        const fileSha256 = sha256(content);
        hash.update(relativePath);
        hash.update('\0');
        hash.update(content);
        hash.update('\0');
        return { path: relativePath, sha256: fileSha256 };
    });
    return { sha256: hash.digest('hex'), files };
}

function applicationContractHash() {
    return applicationContractManifest().sha256;
}

function addAssertion(assertions, name, passed, detail) {
    assertions.push({
        name,
        passed: Boolean(passed),
        detail: sanitiseEvidenceValue(detail)
    });
}

function assertNumber(assertions, name, expected, actual) {
    if (expected == null) return;
    addAssertion(assertions, name, Number(actual) === Number(expected), { expected, actual });
}

function lastEvent(events, eventName) {
    return (events || []).filter((event) => event.event === eventName).map((event) => event.data).pop() || null;
}

function getPath(value, field) {
    return String(field || '').split('.').reduce((current, key) => (
        current == null ? undefined : current[key]
    ), value);
}

function includesCaseInsensitive(value, expected) {
    return String(value || '').toLowerCase().includes(String(expected || '').toLowerCase());
}

function countOccurrences(value, expected) {
    const text = String(value || '').toLowerCase();
    const needle = String(expected || '').toLowerCase();
    if (!needle) return 0;
    let count = 0;
    let offset = 0;
    while ((offset = text.indexOf(needle, offset)) !== -1) {
        count += 1;
        offset += needle.length;
    }
    return count;
}

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function normaliseRelativePath(absolutePath) {
    const relative = path.relative(path.resolve(__dirname, '..'), absolutePath);
    return relative && !relative.startsWith('..') ? relative.replace(/\\/g, '/') : path.basename(absolutePath);
}

function normaliseRuntime(value) {
    const runtime = String(value || '').trim().toLowerCase();
    if (!['mock', 'openai'].includes(runtime)) throw new Error('Runtime must be mock or openai');
    return runtime;
}

function scenarioClientAddress(index) {
    const value = (Number(index) || 0) % 240 + 10;
    return `192.0.2.${value}`;
}

function safeId(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 100);
}

function nonNegative(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.round(number) : 0;
}

function roundCost(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.round(number * 1000000) / 1000000 : 0;
}

module.exports = {
    DEFAULT_DATASET_PATH,
    HARNESS_SCHEMA_VERSION,
    HARNESS_VERSION,
    applicationContractHash,
    applicationContractManifest,
    evaluateScenario,
    evaluateScenarioEvidence,
    loadProspectEvalDataset,
    normaliseScenarioIds,
    parseSseEvents,
    runProspectEvalSuite,
    runProspectScenario,
    sanitiseEvidenceText,
    sanitiseEvidenceValue,
    sumUsage
};
