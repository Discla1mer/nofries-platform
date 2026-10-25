const { createAutotaskClient } = require('../api/shared/serviceDesk/autotaskClient');

function response(status, body) {
    return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => body == null ? '' : JSON.stringify(body)
    };
}

function auth(mode = 'controlled_write') {
    return {
        getApiBase: async () => 'https://webservices1.autotask.net/atservicesrest/v1.0',
        requestHeaders: () => ({ UserName: 'hidden', Secret: 'hidden', ApiIntegrationCode: 'hidden' }),
        status: () => ({ configured: true, mode, writeOperationsEnabled: mode === 'controlled_write' })
    };
}

function streamedResponse(status, chunks, options = {}) {
    let index = 0;
    const reader = {
        cancel: jest.fn().mockResolvedValue(undefined),
        releaseLock: jest.fn(),
        read: jest.fn(async () => {
            if (options.stall) return new Promise((resolve, reject) => {
                options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
            });
            if (index >= chunks.length) return { done: true };
            return { done: false, value: chunks[index++] };
        })
    };
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: () => null },
        body: { getReader: () => reader },
        reader
    };
}

describe('Autotask REST client', () => {
    test('uses bounded pagination on the discovered exact API origin', async () => {
        const fetch = jest.fn()
            .mockResolvedValueOnce(response(200, {
                items: [{ id: 1 }],
                pageDetails: { nextPageUrl: 'https://webservices1.autotask.net/atservicesrest/v1.0/Tickets/query?next=2' }
            }))
            .mockResolvedValueOnce(response(200, { items: [{ id: 2 }] }));
        const client = createAutotaskClient({ authProvider: auth(), fetch, maxPages: 4 });
        const result = await client.queryTickets([{ op: 'eq', field: 'companyID', value: 10 }]);
        expect(result).toMatchObject({ items: [{ id: 1 }, { id: 2 }], pages: 2, truncated: false });
        expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'POST', redirect: 'error' });
        expect(fetch.mock.calls[1][1].method).toBe('GET');
    });

    test('uses the documented UDF filter shape and collection PATCH endpoint', async () => {
        const fetch = jest.fn()
            .mockResolvedValueOnce(response(200, { items: [] }))
            .mockResolvedValueOnce(response(200, { itemId: 700 }));
        const client = createAutotaskClient({ authProvider: auth(), fetch });
        await client.queryTickets([
            { op: 'eq', field: 'NoFriesOperationId', udf: true, value: 'operation-00000001' }
        ]);
        expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
            filter: [{ op: 'eq', field: 'NoFriesOperationId', udf: true, value: 'operation-00000001' }]
        });
        await client.updateTicket('700', { id: 700, status: 5 });
        expect(fetch.mock.calls[1][0]).toBe('https://webservices1.autotask.net/atservicesrest/v1.0/Tickets');
        expect(fetch.mock.calls[1][1]).toMatchObject({ method: 'PATCH' });
        await expect(client.updateTicket('700', { id: 701, status: 5 }))
            .rejects.toMatchObject({ details: { code: 'autotask_update_id_mismatch' } });
    });

    test('rejects a pagination URL that leaves the exact Autotask origin', async () => {
        const fetch = jest.fn().mockResolvedValue(response(200, {
            items: [{ id: 1 }],
            pageDetails: { nextPageUrl: 'https://example.test/atservicesrest/v1.0/Tickets/query?next=2' }
        }));
        const client = createAutotaskClient({ authProvider: auth(), fetch });
        await expect(client.queryTickets([{ op: 'eq', field: 'companyID', value: 10 }]))
            .rejects.toMatchObject({ details: { code: 'autotask_url_rejected' } });
    });

    test.each([400, 404, 422])('marks explicit write HTTP %i as effect absent', async (status) => {
        const client = createAutotaskClient({ authProvider: auth(), fetch: jest.fn().mockResolvedValue(response(status, {})) });
        await expect(client.createTicket({ title: 'Test' })).rejects.toMatchObject({
            details: { providerStatus: status, providerEffectAbsent: true }
        });
    });

    test.each([409, 429, 500])('does not mark ambiguous write HTTP %i as effect absent', async (status) => {
        const client = createAutotaskClient({ authProvider: auth(), fetch: jest.fn().mockResolvedValue(response(status, {})) });
        try {
            await client.createTicket({ title: 'Test' });
            throw new Error('expected rejection');
        } catch (error) {
            expect(error.details.providerStatus).toBe(status);
            expect(error.details.providerEffectAbsent).toBeUndefined();
        }
    });

    test('never marks read failures or network failures as effect absent', async () => {
        const read = createAutotaskClient({ authProvider: auth(), fetch: jest.fn().mockResolvedValue(response(404, {})) });
        await expect(read.getTicket('1')).rejects.toMatchObject({ details: { providerStatus: 404 } });
        try {
            await read.getTicket('1');
        } catch (error) {
            expect(error.details.providerEffectAbsent).toBeUndefined();
        }
        const network = createAutotaskClient({ authProvider: auth(), fetch: jest.fn().mockRejectedValue(new Error('offline')) });
        await expect(network.createTicket({ title: 'Test' })).rejects.toMatchObject({
            details: { code: 'autotask_unreachable' }
        });
    });

    test.each([
        {},
        [],
        { item: [] },
        { items: {}, pageDetails: {} },
        { items: [], pageDetails: [] },
        { items: [], pageDetails: { nextPageUrl: 7 } },
        { items: [], pageDetails: { count: -1 } }
    ])('rejects malformed successful query collection %#', async (payload) => {
        const client = createAutotaskClient({ authProvider: auth(), fetch: jest.fn().mockResolvedValue(response(200, payload)) });
        await expect(client.queryTickets([{ op: 'eq', field: 'companyID', value: 10 }]))
            .rejects.toMatchObject({ details: { code: expect.stringMatching(/^autotask_(?:query_response|pagination)_invalid$/) } });
    });

    test('rejects a streaming response as soon as it exceeds the byte cap', async () => {
        const large = streamedResponse(200, [Buffer.alloc(3 * 1024 * 1024), Buffer.alloc(3 * 1024 * 1024)]);
        const client = createAutotaskClient({ authProvider: auth(), fetch: jest.fn().mockResolvedValue(large) });
        await expect(client.getTicket('1')).rejects.toMatchObject({ details: { code: 'autotask_response_too_large' } });
        expect(large.reader.cancel).toHaveBeenCalledTimes(1);
    });

    test('bounds the cumulative bytes across paginated responses', async () => {
        const padding = 'x'.repeat(3 * 1024 * 1024);
        const fetch = jest.fn()
            .mockResolvedValueOnce(response(200, {
                items: [{ id: 1, padding }],
                pageDetails: { nextPageUrl: 'https://webservices1.autotask.net/atservicesrest/v1.0/Tickets/query?next=2' }
            }))
            .mockResolvedValueOnce(response(200, { items: [{ id: 2, padding }] }));
        const client = createAutotaskClient({ authProvider: auth(), fetch, maxPages: 4 });
        await expect(client.queryTickets([{ op: 'eq', field: 'companyID', value: 10 }]))
            .rejects.toMatchObject({ details: { code: 'autotask_response_too_large' } });
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    test('keeps the request timeout active while consuming the response body', async () => {
        jest.useFakeTimers();
        let signal;
        const fetch = jest.fn(async (url, options) => {
            signal = options.signal;
            return streamedResponse(200, [], { stall: true, signal });
        });
        const client = createAutotaskClient({ authProvider: auth(), fetch, timeoutMs: 1000 });
        const pending = client.getTicket('1');
        const assertion = expect(pending).rejects.toMatchObject({ details: { code: 'autotask_timeout' } });
        await jest.advanceTimersByTimeAsync(1000);
        await assertion;
        jest.useRealTimers();
    });
});
