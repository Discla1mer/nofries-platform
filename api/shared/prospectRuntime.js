const net = require('net');
const { apiSecurityHeaders, assertSameOriginForMutation } = require('./securityHeaders');
const { checkRateLimit, getClientKeyFromHeaders, rateLimitHeaders } = require('./abuseProtection');
const { requestBodySize } = require('./requestLimits');
const { getReleaseIdentity } = require('./releaseIdentity');
const {
    PROSPECT_PROMPT_VERSION,
    createProspectAgent,
    guardVisitorMessage,
    resolveProspectRuntime
} = require('./agents/prospectAgent');
const { PROSPECT_TOOL_SCHEMA_VERSION } = require('./agents/prospectTools');
const { MANAGED_IT_POLICY } = require('./managedItPolicy');
const { detectProspectPromptInjection } = require('./agents/prospectInjectionGuard');
const { publicHelpReply, publicHelpFallbackReply } = require('./agents/nofriesPublicKnowledge');
const { resolveModel } = require('./agents/modelRegistry');
const { getLifecycleService } = require('./appLifecycleRuntime');
const {
    ProspectSessionError,
    createProspectSessionManager,
    createPublicAgentAccess
} = require('./lifecycle/prospectSession');
const { LifecycleRepositoryError } = require('./appLifecycle/lifecycleRepository');
const { buildContextSnapshot, createOrganisation } = require('./lifecycle/lifecycleModel');
const {
    PRICE_VERSION,
    STANDARD_PRICE,
    estimateManagedItPrice,
    priceReply,
    shouldOfferPrice
} = require('./mspPricing');

const MAX_REQUEST_BYTES = 16 * 1024;

async function handleProspectSessionRequest(req, options = {}) {
    const env = options.env || process.env;
    assertSameOriginForMutation(req);
    const helpQuery = req && req.query && req.query.publicHelpOnly;
    if (helpQuery !== undefined && helpQuery !== 'true' && helpQuery !== 'false') {
        throw prospectError(400, 'The public help mode is invalid', 'invalid_public_help_mode');
    }
    const publicHelpOnly = helpQuery === 'true';
    const rateLimit = prospectRateLimit(req, 'apiProspectSession', env);
    const prepared = await prepareSession(req, env, Object.assign({}, options, { persistSession: false }));
    const runtime = resolveProspectRuntime(env);
    const model = resolveModel('prospect', env);
    const session = !publicHelpOnly && prepared.session || emptyProspectSession();
    const resolveReleaseIdentity = typeof options.getReleaseIdentity === 'function'
        ? options.getReleaseIdentity
        : getReleaseIdentity;
    const releaseIdentity = resolveReleaseIdentity();
    return json(200, {
        release: releaseIdentity
            ? { sha: releaseIdentity.releaseSha, runId: releaseIdentity.runId }
            : null,
        assistant: {
            name: 'No Fries',
            agent: 'prospect_agent',
            runtime,
            model: publicHelpOnly ? 'deterministic-public-help' : runtime.liveModel ? model.model : 'mock-deterministic',
            publicHelpOnly,
            publicHelpProtocol: publicHelpOnly ? 'public-help-v1' : null,
            promptVersion: PROSPECT_PROMPT_VERSION,
            toolSchemaVersion: PROSPECT_TOOL_SCHEMA_VERSION,
            streaming: true,
            voiceReady: false,
            pricing: publicHelpOnly ? null : {
                policyId: MANAGED_IT_POLICY.policyId,
                policyVersion: PRICE_VERSION,
                effectiveFrom: MANAGED_IT_POLICY.effectiveFrom,
                serviceName: MANAGED_IT_POLICY.customerFacingServiceName,
                currency: STANDARD_PRICE.currency,
                perUserMonthly: STANDARD_PRICE.perUserMonthly,
                includedEndpointsPerUser: STANDARD_PRICE.includedEndpointsPerUser,
                onboardingFrom: STANDARD_PRICE.onboardingFrom,
                additionalEndpointMonthly: STANDARD_PRICE.additionalEndpointMonthly,
                additionalLocationMonthly: STANDARD_PRICE.additionalLocationMonthly,
                gstExclusive: STANDARD_PRICE.gstExclusive
            }
        },
        conversation: session.conversation,
        organisation: session.organisation,
        privacy: publicHelpOnly
            ? 'Public guidance only. Do not include private organisation or assessment details, passwords, access tokens, recovery codes, payment data, or raw security configuration.'
            : 'Do not send passwords, access tokens, recovery codes, payment data, or raw security configuration.'
    }, Object.assign({}, rateLimitHeaders(rateLimit), prepared.cookie ? { 'Set-Cookie': prepared.cookie } : {}));
}

async function handleProspectChatRequest(req, options = {}) {
    const env = options.env || process.env;
    if (requestBodySize(req) > MAX_REQUEST_BYTES) {
        throw prospectError(413, 'Message is too large', 'request_too_large');
    }
    assertSameOriginForMutation(req);
    const body = getJsonBody(req);
    if (body.publicHelpOnly !== undefined && typeof body.publicHelpOnly !== 'boolean') {
        throw prospectError(400, 'The public help mode is invalid', 'invalid_public_help_mode');
    }
    const publicHelpOnly = body.publicHelpOnly === true;
    // Omit the legacy message field so rollback servers reject public-only
    // requests before they can create a prospect or invoke a discovery model.
    const hasPublicMessage = Object.prototype.hasOwnProperty.call(body, 'publicHelpMessage');
    if (publicHelpOnly
        ? !hasPublicMessage || Object.keys(body).some(key => !['publicHelpOnly', 'publicHelpMessage'].includes(key))
        : hasPublicMessage) {
        throw prospectError(400, 'The public help mode is invalid', 'invalid_public_help_mode');
    }
    const visitorMessage = guardVisitorMessage(publicHelpOnly ? body.publicHelpMessage : body.message);
    const rateLimit = prospectRateLimit(req, 'apiProspectChat', env);
    const runtime = resolveProspectRuntime(env);
    const prepared = await prepareSession(req, env, Object.assign({}, options, { persistSession: false }));
    const injection = detectProspectPromptInjection(visitorMessage);
    // A public question is not a request to create a prospect or quote a service.
    // The explicit help-only mode never forwards an unmatched/private question.
    // Neither the mode nor the fixed topic is identity or organisation evidence.
    const publicHelp = !injection.detected
        ? publicHelpReply(visitorMessage) || (publicHelpOnly ? publicHelpFallbackReply() : null)
        : null;
    let securityRecord = null;

    if (!prepared.isNewBrowserSession && runtime.mode !== 'disabled' && injection.detected) {
        const identity = prospectSecurityIdentity(prepared, req);
        if (prepared.session && typeof prepared.lifecycleService.recordProspectSecurityAttempt === 'function') {
            securityRecord = await prepared.lifecycleService.recordProspectSecurityAttempt(
                prepared.access,
                prepared.browserSession.sessionHash,
                {
                    clientKeyHash: identity.clientKeyHash,
                    networkIdentifierAvailable: identity.networkIdentifierAvailable,
                    detectorVersion: injection.detectorVersion,
                    signals: injection.signals
                }
            ).catch(() => null);
        }
    }

    if (
        !prepared.isNewBrowserSession &&
        runtime.mode !== 'disabled' &&
        !prepared.session &&
        !isTrivialOpening(visitorMessage) &&
        !injection.detected &&
        !publicHelp
    ) {
        prepared.session = await persistPreparedSession(prepared, req, body, env);
    }

    const headers = apiSecurityHeaders(Object.assign({
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'private, no-store, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
    }, rateLimitHeaders(rateLimit), prepared.cookie ? { 'Set-Cookie': prepared.cookie } : {}));
    const emitted = [];
    const emit = async (event, data) => {
        const frame = sse(event, data);
        emitted.push(frame);
        if (typeof options.onEvent === 'function') await options.onEvent(frame, event, data);
    };
    if (typeof options.onHeaders === 'function') await options.onHeaders(headers);

    await emit('ready', {
        runtime,
        conversationId: !publicHelpOnly && !publicHelp && prepared.session && prepared.session.conversation && prepared.session.conversation.id || ''
    });
    if (prepared.isNewBrowserSession) {
        await emit('error', {
            error: 'Please wait for the assistant to finish setting up, then try again.',
            code: 'session_bootstrap_required'
        });
        return raw(200, emitted.join(''), headers);
    }
    if (runtime.mode === 'disabled') {
        await emit('error', { error: 'The assistant is not configured yet.', code: runtime.reason || 'assistant_disabled' });
        return raw(200, emitted.join(''), headers);
    }
    if (injection.detected) {
        const text = promptInjectionReply(securityRecord);
        const pending = !publicHelpOnly && prepared.session || emptyProspectSession();
        await emit('delta', { delta: text });
        await emit('done', {
            text,
            runtime,
            model: 'deterministic-security-guard',
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            approximateCostUsd: 0,
            traceId: '',
            conversation: pending.conversation,
            organisation: pending.organisation,
            pricing: null,
            security: { blocked: true, code: 'prompt_injection_blocked' }
        });
        return raw(200, emitted.join(''), headers);
    }
    if (publicHelp) {
        // Leave a pending discovery untouched in storage and off this public
        // reply; it is neither current Dashboard organisation nor help context.
        const pending = emptyProspectSession();
        await emit('delta', { delta: publicHelp.text });
        await emit('done', {
            text: publicHelp.text,
            runtime,
            model: 'deterministic-public-help',
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            approximateCostUsd: 0,
            traceId: '',
            identities: { knowledgeVersion: publicHelp.knowledgeVersion },
            publicHelp: { topic: publicHelp.topic, helpOnly: publicHelpOnly },
            conversation: pending.conversation,
            organisation: pending.organisation,
            pricing: null
        });
        return raw(200, emitted.join(''), headers);
    }
    if (!prepared.session && isTrivialOpening(visitorMessage)) {
        const text = 'Hi — tell me what you would like to improve about your IT support, or ask for an indicative price.';
        const pending = emptyProspectSession();
        await emit('delta', { delta: text });
        await emit('done', {
            text,
            runtime,
            model: 'deterministic-welcome',
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            approximateCostUsd: 0,
            traceId: '',
            conversation: pending.conversation,
            organisation: pending.organisation,
            pricing: null
        });
        return raw(200, emitted.join(''), headers);
    }

    try {
        const agent = options.agentFactory
            ? options.agentFactory({
                lifecycleService: prepared.lifecycleService,
                access: prepared.access,
                sessionHash: prepared.browserSession.sessionHash,
                env
            })
            : createProspectAgent({
                lifecycleService: prepared.lifecycleService,
                access: prepared.access,
                sessionHash: prepared.browserSession.sessionHash,
                env
            });
        const result = await agent.runTurn({
            message: visitorMessage,
            channel: 'text',
            safetyIdentifier: prepared.browserSession.sessionHash.slice(0, 64),
            onDelta: async (delta) => emit('delta', { delta })
        });

        let finalText = result.text;
        let pricing = null;
        let responseConversation = result.conversation;
        let responseOrganisation = result.organisation;
        const organisationContext = result.organisation && result.organisation.context || {};
        const conversationMessages = result.conversation && result.conversation.messages || [];
        const priorConversationMessages = conversationMessages.length
            && conversationMessages[conversationMessages.length - 1].role === 'assistant'
            ? conversationMessages.slice(0, -1)
            : conversationMessages;
        const explicitPricingIntent = shouldOfferPrice(organisationContext, visitorMessage);
        const priorPricingIntent = priorConversationMessages.some((message) => (
            message.role === 'user' && shouldOfferPrice({}, message.text)
        ));
        const finalQuoteAlreadyProvided = priorConversationMessages.some((message) => (
            message.role === 'assistant' && /current No Fries estimate is NZ\$[\d,]+/i.test(String(message.text || ''))
        ));
        const pricingJourneyActive = explicitPricingIntent || (priorPricingIntent && !finalQuoteAlreadyProvided);

        if (pricingJourneyActive) {
            pricing = estimateManagedItPrice(organisationContext);
            const shouldAppendPricing = pricing.status !== 'needs_more_info' || explicitPricingIntent;
            const pricingText = shouldAppendPricing ? priceReply(pricing) : '';
            const alreadyContainsThisTurnPrice = /NZ\$[\d,]+/i.test(finalText);
            if (pricingText && !alreadyContainsThisTurnPrice) {
                finalText = `${finalText}\n\n${pricingText}`;
                await emit('delta', { delta: `\n\n${pricingText}` });
                const persistedPrice = await prepared.lifecycleService.appendProspectMessage(
                    prepared.access,
                    prepared.browserSession.sessionHash,
                    'assistant',
                    pricingText
                ).catch(() => null);
                if (persistedPrice) {
                    responseConversation = persistedPrice.conversation;
                    responseOrganisation = persistedPrice.organisation;
                }
            }
        }

        await emit('done', {
            text: finalText,
            runtime: result.runtime,
            model: result.model,
            providerModel: result.providerModel,
            usage: result.usage,
            approximateCostUsd: result.approximateCostUsd,
            traceId: result.traceId,
            identities: result.identities,
            conversation: responseConversation,
            organisation: responseOrganisation,
            pricing
        });
    } catch (error) {
        await emit('error', {
            error: publicErrorMessage(error),
            code: error && error.details && error.details.code || 'assistant_error'
        });
    }
    return raw(200, emitted.join(''), headers);
}

async function runProspectSessionFunction(context, req) {
    try {
        context.res = await handleProspectSessionRequest(req);
    } catch (error) {
        context.res = errorResponse(error, context.log);
    }
}

async function runProspectChatFunction(context, req) {
    try {
        context.res = await handleProspectChatRequest(req);
    } catch (error) {
        context.res = errorResponse(error, context.log);
    }
}

async function prepareSession(req, env, options) {
    const sessionManager = options.sessionManager || createProspectSessionManager({ env });
    const cookieHeader = getHeader(req, 'cookie');
    let browserSession = sessionManager.resolve(cookieHeader);
    const isNewBrowserSession = !browserSession;
    let cookie = '';
    if (!browserSession) {
        browserSession = sessionManager.create();
        cookie = browserSession.cookie;
    }
    const access = options.access || createPublicAgentAccess(env);
    const lifecycleService = options.lifecycleService || getLifecycleService();
    const session = options.persistSession === true
        ? await persistPreparedSession({ sessionManager, browserSession, access, lifecycleService }, req, getJsonBody(req), env)
        : await lifecycleService.findProspectSession(access, browserSession.sessionHash);
    return { sessionManager, browserSession, cookie, access, lifecycleService, session, isNewBrowserSession };
}

async function persistPreparedSession(prepared, req, body, env) {
    const identity = prospectSecurityIdentity(prepared, req);
    return prepared.lifecycleService.ensureProspectSession(
        prepared.access,
        prepared.browserSession.sessionHash,
        {
            channel: 'text',
            campaign: clean(body && body.campaign, 160),
            referrer: clean(getHeader(req, 'referer'), 500),
            admission: Object.assign({
                clientKeyHash: identity.clientKeyHash
            }, prospectAdmissionPolicy(env))
        }
    );
}

function prospectSecurityIdentity(prepared, req) {
    const clientAddress = normaliseProspectClientAddress(getClientKeyFromHeaders(
        req && req.headers || {},
        req && (req.ip || req.socket && req.socket.remoteAddress)
    ));
    return {
        clientKeyHash: prepared.sessionManager.admissionKey(clientAddress),
        networkIdentifierAvailable: clientAddress !== 'unknown'
    };
}

function emptyProspectSession() {
    const organisation = buildContextSnapshot(createOrganisation({
        id: 'pending_prospect_session',
        displayName: 'New website prospect',
        sourceChannel: 'website_chat',
        actorId: 'prospect_agent'
    }));
    organisation.organisationId = '';
    return {
        conversation: {
            id: '',
            organisationId: '',
            channel: 'text',
            status: 'not_started',
            messages: [],
            summary: '',
            currentNeed: '',
            concerns: [],
            nextAction: { type: 'continue_chat', timing: '', detail: 'Continue discovery' },
            escalation: { required: false, reason: '', requestedAt: '' },
            ai: { agent: 'prospect_agent', model: '', runtime: '', confidence: 1, lastRunAt: '' },
            createdAt: '',
            updatedAt: ''
        },
        organisation
    };
}

function prospectRateLimit(req, bucket, env) {
    const clientKey = getClientKeyFromHeaders(req && req.headers || {}, req && (req.ip || req.socket && req.socket.remoteAddress));
    const result = checkRateLimit(bucket, clientKey, env);
    if (!result.allowed) {
        throw prospectError(429, 'Too many messages. Please wait and try again.', 'rate_limited', {
            retryAfterSeconds: result.retryAfterSeconds
        });
    }
    return result;
}

function prospectAdmissionPolicy(env = process.env) {
    return {
        burstWindowMs: positiveInteger(env.NOFRIES_PROSPECT_CREATE_BURST_WINDOW_MS, 10 * 60 * 1000),
        burstMax: positiveInteger(env.NOFRIES_PROSPECT_CREATE_BURST_MAX, 3),
        clientWindowMs: positiveInteger(env.NOFRIES_PROSPECT_CREATE_CLIENT_WINDOW_MS, 24 * 60 * 60 * 1000),
        clientMax: positiveInteger(env.NOFRIES_PROSPECT_CREATE_CLIENT_MAX, 8),
        globalHourWindowMs: positiveInteger(env.NOFRIES_PROSPECT_CREATE_GLOBAL_HOUR_WINDOW_MS, 60 * 60 * 1000),
        globalHourMax: positiveInteger(env.NOFRIES_PROSPECT_CREATE_GLOBAL_HOUR_MAX, 30),
        globalDayWindowMs: positiveInteger(env.NOFRIES_PROSPECT_CREATE_GLOBAL_DAY_WINDOW_MS, 24 * 60 * 60 * 1000),
        globalDayMax: positiveInteger(env.NOFRIES_PROSPECT_CREATE_GLOBAL_DAY_MAX, 100)
    };
}

function positiveInteger(value, fallback) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isTrivialOpening(value) {
    const text = String(value || '').trim().toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    return /^(?:hi|hello|hey|hiya|kia ora|test|start|help|anyone|are you there)$/.test(text);
}

function promptInjectionReply(securityRecord) {
    const attemptOrdinal = Number(securityRecord && securityRecord.attemptOrdinal || 0);
    if (attemptOrdinal > 1) {
        if (securityRecord.networkIdentifierRecorded) {
            return 'Another attempt to override this assistant’s instructions was blocked. Security metadata for this request has been logged, including a protected identifier derived from the network address. Please stop and use this chat for genuine IT-support enquiries.';
        }
        return 'Another attempt to override this assistant’s instructions was blocked and logged for security monitoring. Please stop and use this chat for genuine IT-support enquiries.';
    }
    return 'That looks like an attempt to override or reveal this assistant’s instructions. I can’t help with that. Please stop and use this chat for questions about No Fries or your IT support.';
}

function normaliseProspectClientAddress(value) {
    const address = String(value || '').trim().replace(/^\[|\]$/g, '').split('%')[0];
    if (net.isIP(address) === 4) return address;
    if (net.isIP(address) !== 6) return 'unknown';
    const expanded = expandIpv6(address);
    return expanded ? `${expanded.slice(0, 4).join(':')}::/64` : 'unknown';
}

function expandIpv6(value) {
    const parts = String(value || '').toLowerCase().split('::');
    if (parts.length > 2) return null;
    const left = parts[0] ? parts[0].split(':').filter(Boolean) : [];
    const right = parts[1] ? parts[1].split(':').filter(Boolean) : [];
    if (left.concat(right).some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
    const missing = 8 - left.length - right.length;
    if (missing < (parts.length === 2 ? 1 : 0)) return null;
    const groups = left.concat(Array(missing).fill('0'), right);
    return groups.length === 8 ? groups.map((part) => part.padStart(4, '0')) : null;
}

function getJsonBody(req) {
    if (!req || req.body == null) return {};
    if (Buffer.isBuffer(req.body)) return parseJson(req.body.toString('utf8'));
    if (typeof req.body === 'string') return parseJson(req.body);
    return req.body;
}

function parseJson(value) {
    try {
        return JSON.parse(value || '{}');
    } catch (error) {
        throw prospectError(400, 'Request body must contain valid JSON', 'invalid_json');
    }
}

function sse(event, data) {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function json(status, body, headers = {}) {
    return { status, headers: apiSecurityHeaders(Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, headers)), body };
}

function raw(status, body, headers = {}) {
    return { status, headers, body, isRaw: true };
}

function errorResponse(error, logger) {
    const status = error.statusCode && error.statusCode >= 400 && error.statusCode < 600 ? error.statusCode : 500;
    if (status >= 500 && !(error instanceof LifecycleRepositoryError) && !(error instanceof ProspectSessionError) && logger && typeof logger.error === 'function') {
        logger.error(error);
    }
    const headers = {};
    if (error && error.details && error.details.retryAfterSeconds) headers['Retry-After'] = String(error.details.retryAfterSeconds);
    return json(status, Object.assign({ error: publicErrorMessage(error) }, error.details || {}), headers);
}

function publicErrorMessage(error) {
    if (error && error.statusCode && error.statusCode < 500) return error.message;
    if (error instanceof ProspectSessionError) return error.message;
    return 'The assistant could not complete that response. Please try again.';
}

function prospectError(statusCode, message, code, details = {}) {
    const error = new Error(message);
    error.statusCode = statusCode;
    error.details = Object.assign({ code }, details);
    return error;
}

function getHeader(req, name) {
    if (!req) return '';
    if (typeof req.get === 'function') return String(req.get(name) || '');
    const headers = req.headers || {};
    return String(headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()] || '');
}

function clean(value, maxLength) {
    return String(value || '').trim().slice(0, maxLength);
}

module.exports = {
    errorResponse,
    handleProspectChatRequest,
    handleProspectSessionRequest,
    runProspectChatFunction,
    runProspectSessionFunction,
    sse,
    detectProspectPromptInjection,
    isTrivialOpening,
    normaliseProspectClientAddress,
    prospectAdmissionPolicy
};
