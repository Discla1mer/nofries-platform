const DEFAULT_ENDPOINT = 'https://api.openai.com/v1/responses';

class OpenAIResponsesError extends Error {
    constructor(statusCode, message, code, details = {}) {
        super(message);
        this.statusCode = statusCode;
        this.details = Object.assign({ code }, details);
    }
}

function createOpenAIResponsesClient(options = {}) {
    const env = options.env || process.env;
    const apiKey = String(options.apiKey || env.OPENAI_API_KEY || '').trim();
    const endpoint = String(options.endpoint || env.NOFRIES_OPENAI_RESPONSES_URL || DEFAULT_ENDPOINT).trim();
    const fetchImpl = options.fetchImpl || global.fetch;
    const timeoutMs = positiveInteger(options.timeoutMs || env.NOFRIES_OPENAI_TIMEOUT_MS, 35000);
    if (!apiKey) {
        throw new OpenAIResponsesError(503, 'The OpenAI prospect agent is not configured', 'openai_not_configured');
    }
    if (typeof fetchImpl !== 'function') {
        throw new OpenAIResponsesError(500, 'This runtime cannot call the OpenAI Responses API', 'fetch_unavailable');
    }

    return {
        async create(payload, request = {}) {
            const response = await requestOpenAI(payload, request);
            const body = await readJson(response);
            return {
                body,
                requestId: response.headers.get('x-request-id') || body.id || ''
            };
        },

        async stream(payload, request = {}) {
            const response = await requestOpenAI(Object.assign({}, payload, { stream: true }), request);
            const requestId = response.headers.get('x-request-id') || '';
            const events = [];
            if (!response.body || typeof response.body.getReader !== 'function') {
                throw new OpenAIResponsesError(502, 'OpenAI returned a non-streaming response', 'openai_stream_unavailable');
            }
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const frames = buffer.split(/\r?\n\r?\n/);
                buffer = frames.pop() || '';
                for (const frame of frames) {
                    const event = parseSseFrame(frame);
                    if (!event) continue;
                    events.push(event);
                    if (typeof request.onEvent === 'function') {
                        await request.onEvent(event);
                    }
                }
            }
            if (buffer.trim()) {
                const event = parseSseFrame(buffer);
                if (event) {
                    events.push(event);
                    if (typeof request.onEvent === 'function') await request.onEvent(event);
                }
            }
            return { events, requestId };
        }
    };

    async function requestOpenAI(payload, request) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const requestPayload = Object.assign({}, payload, request.safetyIdentifier ? {
                safety_identifier: String(request.safetyIdentifier).slice(0, 128)
            } : {});
            const response = await fetchImpl(endpoint, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(requestPayload),
                signal: controller.signal
            });
            if (!response.ok) {
                const errorBody = await readJson(response);
                throw new OpenAIResponsesError(
                    response.status >= 500 ? 502 : response.status,
                    response.status === 429
                        ? 'The assistant is busy. Please try again shortly.'
                        : 'The assistant could not complete that response.',
                    response.status === 429 ? 'openai_rate_limited' : 'openai_request_failed',
                    { providerStatus: response.status, requestId: response.headers.get('x-request-id') || '', providerError: providerErrorCode(errorBody) }
                );
            }
            return response;
        } catch (error) {
            if (error instanceof OpenAIResponsesError) throw error;
            if (error && error.name === 'AbortError') {
                throw new OpenAIResponsesError(504, 'The assistant took too long to respond', 'openai_timeout');
            }
            throw new OpenAIResponsesError(502, 'The assistant could not reach OpenAI', 'openai_unavailable');
        } finally {
            clearTimeout(timeout);
        }
    }
}

function parseSseFrame(frame) {
    const data = String(frame || '')
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('\n');
    if (!data || data === '[DONE]') return null;
    try {
        return JSON.parse(data);
    } catch (error) {
        return null;
    }
}

async function readJson(response) {
    try {
        return await response.json();
    } catch (error) {
        return {};
    }
}

function providerErrorCode(value) {
    return String(value && value.error && (value.error.code || value.error.type) || '').slice(0, 120);
}

function positiveInteger(value, fallback) {
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? number : fallback;
}

module.exports = {
    OpenAIResponsesError,
    createOpenAIResponsesClient,
    parseSseFrame
};
