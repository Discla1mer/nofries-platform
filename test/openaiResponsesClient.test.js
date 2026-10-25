const {
    createOpenAIResponsesClient,
    parseSseFrame
} = require('../api/shared/agents/openaiResponsesClient');

describe('OpenAI Responses client boundary', () => {
    test('keeps the API key in backend headers and sends a hashed safety identifier as a Responses parameter', async () => {
        const calls = [];
        const client = createOpenAIResponsesClient({
            apiKey: 'server-only-test-key',
            fetchImpl: async (url, options) => {
                calls.push({ url, options });
                return new Response(JSON.stringify({ id: 'resp_test', output: [] }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json', 'x-request-id': 'request_test' }
                });
            }
        });
        const result = await client.create({ model: 'gpt-5.6-luna', input: 'hello', store: false }, {
            safetyIdentifier: 'hashed-browser-session'
        });

        expect(result.requestId).toBe('request_test');
        expect(calls).toHaveLength(1);
        expect(calls[0].options.headers.Authorization).toBe('Bearer server-only-test-key');
        expect(calls[0].options.headers['OpenAI-Safety-Identifier']).toBeUndefined();
        expect(JSON.parse(calls[0].options.body)).toMatchObject({
            model: 'gpt-5.6-luna',
            store: false,
            safety_identifier: 'hashed-browser-session'
        });
    });

    test('parses Responses streaming events and forwards text deltas', async () => {
        const streamBody = [
            'data: {"type":"response.output_text.delta","delta":"Hello "}\n\n',
            'data: {"type":"response.output_text.delta","delta":"there"}\n\n',
            'data: {"type":"response.completed","response":{"usage":{"input_tokens":2,"output_tokens":2}}}\n\n',
            'data: [DONE]\n\n'
        ].join('');
        const client = createOpenAIResponsesClient({
            apiKey: 'server-only-test-key',
            fetchImpl: async () => new Response(streamBody, {
                status: 200,
                headers: { 'Content-Type': 'text/event-stream', 'x-request-id': 'stream_request' }
            })
        });
        const events = [];
        const result = await client.stream({ model: 'gpt-5.6-luna', input: 'hello' }, {
            onEvent: async (event) => events.push(event)
        });

        expect(result.requestId).toBe('stream_request');
        expect(events.filter((event) => event.type === 'response.output_text.delta').map((event) => event.delta).join('')).toBe('Hello there');
        expect(parseSseFrame('data: [DONE]')).toBeNull();
    });
});
