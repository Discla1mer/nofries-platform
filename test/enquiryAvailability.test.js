'use strict';
const fs = require('node:fs');
const vm = require('node:vm');
const { createEnquiryService } = require('../api/shared/enquiry');
const { createEnquiryFunction } = require('../api/enquiry');
const ENV = { NOFRIES_ENQUIRY_RATE_LIMIT_BLOB_URL: 'https://example.blob.core.windows.net/enquiry-rate-limit/public-enquiry-v1.json', RESEND_API_KEY: 'not-a-real-key', NOFRIES_ENQUIRY_EMAIL_FROM: 'web@example.invalid' };

describe('public enquiry configuration status', () => {
    test.each([
        [{}, false, false],
        [{ ...ENV, RESEND_API_KEY: ' ' }, false, false],
        [{ ...ENV, NOFRIES_ENQUIRY_EMAIL_FROM: '' }, false, false],
        [ENV, true, false],
        [{ ...ENV, NOFRIES_ENQUIRY_RATE_LIMIT_BLOB_URL: '' }, false, false],
        [{ ...ENV, NOFRIES_ENQUIRY_RATE_LIMIT_BLOB_URL: ENV.NOFRIES_ENQUIRY_RATE_LIMIT_BLOB_URL + '?sig=not-a-real-secret', NOFRIES_ENQUIRY_DELIVERY_VERIFIED: 'true' }, false, false],
        [{ ...ENV, NOFRIES_ENQUIRY_DELIVERY_VERIFIED: 'false' }, true, false],
        [{ ...ENV, NOFRIES_ENQUIRY_DELIVERY_VERIFIED: 'TRUE' }, true, false],
        [{ ...ENV, NOFRIES_ENQUIRY_DELIVERY_VERIFIED: 'true' }, true, true],
        [{ NOFRIES_ENQUIRY_DELIVERY_VERIFIED: 'true' }, false, false]
    ])('returns only safe booleans without sending mail (%#)', async (env, available, promote) => {
        const fetchImpl = jest.fn();
        const rateLimiter = { reserve: jest.fn(() => { throw Error('GET must not reserve'); }) };
        const service = createEnquiryService({ env, fetchImpl, rateLimiter });
        const context = {};
        await createEnquiryFunction(service)(context, { method: 'GET' });
        expect(context.res.status).toBe(200);
        expect(context.res.body).toEqual({ available, promote });
        expect(context.res.headers['Cache-Control']).toContain('no-store');
        expect(fetchImpl).not.toHaveBeenCalled();
        expect(rateLimiter.reserve).not.toHaveBeenCalled();
        expect(JSON.stringify(context.res)).not.toContain(ENV.RESEND_API_KEY);
    });
    test('status is a GET route with anonymous read-only access', () => {
        const binding = require('../api/enquiry/function.json').bindings[0];
        expect(binding).toMatchObject({ methods: ['get', 'post'], route: 'enquiry', authLevel: 'anonymous' });
        const route = require('../staticwebapp.config.json').routes.find(r => r.route === '/api/enquiry');
        expect(route.allowedRoles).toEqual(['anonymous']);
        expect(route.headers['Cache-Control']).toContain('no-store');
    });
});

describe('bounded browser availability read', () => {
    const script = fs.readFileSync(require.resolve('../js/enquiry-availability.js'), 'utf8');
    function load(fetchImpl) {
        const window = {};
        vm.runInNewContext(script, { window, fetch: fetchImpl, AbortController, setTimeout, clearTimeout });
        return window.enquiryAvailability;
    }
    afterEach(() => jest.useRealTimers());
    test.each([
        [{ available: true, promote: true }, { available: true, promote: true }],
        [{ available: true }, { available: true, promote: false }],
        [{ available: false, promote: true }, { available: false, promote: false }],
        [{ available: 'true', promote: 'true' }, { available: false, promote: false }],
        [null, { available: false, promote: false }]
    ])('requires explicit booleans (%#)', async (body, expected) => {
        const fetchImpl = jest.fn(async () => Response.json(body));
        await expect(load(fetchImpl)()).resolves.toEqual(expected);
        expect(fetchImpl).toHaveBeenCalledWith('/api/enquiry', expect.objectContaining({ cache: 'no-store', credentials: 'same-origin' }));
        expect(fetchImpl.mock.calls[0][1].body).toBeUndefined();
    });
    test.each(['network', 'HTTP', 'JSON'])('fails closed on %s error', async mode => {
        const fetchImpl = async () => {
            if (mode === 'network') throw Error('network');
            return mode === 'HTTP' ? new Response('', { status: 503 }) : new Response('<html>');
        };
        await expect(load(fetchImpl)()).resolves.toEqual({ available: false, promote: false });
    });
    test.each(['fetch', 'body'])('bounds a stalled %s even if cancellation is ignored', async mode => {
        jest.useFakeTimers();
        let resolve;
        const stalled = new Promise(r => { resolve = r; });
        const fetchImpl = jest.fn(() => mode === 'fetch' ? stalled : Promise.resolve({ ok: true, json: () => stalled }));
        const result = load(fetchImpl)();
        await jest.advanceTimersByTimeAsync(5000);
        await expect(result).resolves.toEqual({ available: false, promote: false });
        expect(fetchImpl.mock.calls[0][1].signal.aborted).toBe(true);
        resolve(mode === 'fetch' ? Response.json({ available: true, promote: true }) : { available: true, promote: true });
        await Promise.resolve();
        expect(jest.getTimerCount()).toBe(0);
    });
});
