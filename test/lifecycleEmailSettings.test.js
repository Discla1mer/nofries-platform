'use strict';

const crypto = require('node:crypto');
const request = require('supertest');
const { handleEmailSettingsRequest, resetEmailSettingsForTests, PATH, MAX_IN_FLIGHT, SUBJECT_WRITE_MAX, SUBJECT_WINDOW_MS,
    MAX_SUBJECT_BUCKETS } = require('../api/shared/lifecycleEmail/emailSettings');

process.env.NOFRIES_REQUIRE_AUTH = 'false';
const app = require('../server');

const ENV = { NOFRIES_PUBLIC_URL: 'https://nofries.example.test' };
const SUBJECT = `${crypto.randomUUID()}:${crypto.randomUUID()}`;
const ACCOUNT = crypto.randomUUID();
const SAME = { 'sec-fetch-site': 'same-origin', origin: 'null', cookie: '__Host-nofries-customer=synthetic' };

function fakeStore(rows = [], outcome = 'changed') {
    return { read: jest.fn(async () => rows), change: jest.fn(async () => outcome) };
}
const run = (req, options = {}) => handleEmailSettingsRequest({ headers: { cookie: SAME.cookie }, query: {}, ...req },
    { env: ENV, readSubject: async () => SUBJECT, store: fakeStore(), ...options });
const post = (body, headers = SAME) => ({ method: 'POST', headers, body, query: {} });

beforeEach(() => resetEmailSettingsForTests());

describe('email settings handler', () => {
    test('requires a signed-in customer and answers generically', async () => {
        const store = fakeStore();
        expect((await run({ method: 'GET' }, { readSubject: async () => null, store })).status).toBe(401);
        const expired = Object.assign(new Error('x'), { statusCode: 401 });
        expect((await run({ method: 'GET' }, { readSubject: async () => { throw expired; }, store })).status).toBe(401);
        const log = { warn: jest.fn() };
        const failed = await run({ method: 'GET' }, { readSubject: async () => { throw new Error(`driver ${SUBJECT}`); }, store, log });
        expect(failed.status).toBe(503);
        expect(failed.headers['Retry-After']).toBe('60');
        expect(failed.body).not.toContain(SUBJECT);
        expect(log.warn.mock.calls).toEqual([['email_settings_session_failed']]);
        expect((await run({ method: 'GET' }, { readSubject: async () => 'not-a-subject', store })).status).toBe(503);
        expect(store.read).not.toHaveBeenCalled();
        expect((await run({ method: 'GET' }, { store: null })).status).toBe(503);
        const other = await run({ method: 'PUT' });
        expect(other.status).toBe(405);
        expect(other.headers.Allow).toBe('GET, POST');
    });

    test('GET lists every type with plain labels, state and the right control', async () => {
        const store = fakeStore([{ type: 'result_summary', off: true, source: 'settings' },
            { type: 'nudge_unfinished', off: true, source: 'link' }, { type: 'reassess_reminder', off: false, source: 'settings' }]);
        const result = await run({ method: 'GET', query: { saved: '1' } }, { store });
        expect(result.status).toBe(200);
        expect(store.read).toHaveBeenCalledWith(SUBJECT);
        expect(result.headers['Content-Security-Policy']).toContain("form-action 'self'");
        expect(result.headers['Content-Security-Policy']).not.toContain('script-src');
        const html = result.body;
        expect(html).toContain('<p role="status">Your email settings are saved.</p>');
        expect(html).toContain('Welcome email: <strong>On</strong>');
        expect(html).not.toContain('value="welcome"');
        expect(html).toContain('Result summaries: <strong>Off</strong>');
        expect(html).toMatch(/value="result_summary"><input type="hidden" name="action" value="on"><button class="button" type="submit" aria-describedby="email-result-summary">Turn on<\/button>/);
        expect(html).toContain('Reminders to finish an assessment: <strong>Off</strong>');
        expect(html).not.toContain('value="nudge_unfinished"');
        expect(html).toContain('You unsubscribed from these using the link in an email. <a href="/contact.html">Contact us</a> to turn them back on.');
        expect(html).toMatch(/value="reassess_reminder"><input type="hidden" name="action" value="off">.*>Turn off</);
        const none = await run({ method: 'GET' }, { store: fakeStore(null) });
        expect(none.status).toBe(200);
        expect(none.body).toContain('There are no No Fries emails set up for this account.');
    });

    test('POST enforces same-origin before reading the session', async () => {
        const readSubject = jest.fn(async () => SUBJECT), store = fakeStore();
        const body = { type: 'result_summary', action: 'off' };
        for (const headers of [{}, { origin: ENV.NOFRIES_PUBLIC_URL }, { 'sec-fetch-site': 'cross-site', origin: 'null' },
            { 'sec-fetch-site': 'same-site', origin: ENV.NOFRIES_PUBLIC_URL },
            { 'sec-fetch-site': 'same-origin', origin: 'https://attacker.example.test' },
            { 'sec-fetch-site': 'same-origin', origin: `${ENV.NOFRIES_PUBLIC_URL}/` }]) {
            expect((await run(post(body, headers), { readSubject, store })).status).toBe(403);
        }
        expect(readSubject).not.toHaveBeenCalled();
        expect(store.change).not.toHaveBeenCalled();
        const ok = await run(post(body, { 'sec-fetch-site': 'same-origin', origin: ENV.NOFRIES_PUBLIC_URL }), { readSubject, store });
        expect(ok.status).toBe(303);
    });

    test('POST rejects unknown types, actions and extra fields', async () => {
        const store = fakeStore();
        for (const body of [{ type: 'marketing', action: 'off' }, { type: 'welcome', action: 'off' }, { type: 'result_summary', action: 'toggle' },
            { type: 'result_summary', action: 'off', accountId: ACCOUNT }, { type: 'result_summary' }, {}]) {
            const result = await run(post(body), { store });
            expect(result.status).toBe(400);
            expect(result.body).toContain('That change was not recognised');
        }
        expect(store.change).not.toHaveBeenCalled();
    });

    test('POST turns a type off or on for the signed-in subject only and redirects', async () => {
        const store = fakeStore();
        const off = await run(post({ type: 'nudge_unfinished', action: 'off' }), { store });
        expect(off.status).toBe(303);
        expect(off.headers.Location).toBe(`${PATH}?saved=1`);
        expect(store.change).toHaveBeenCalledWith(SUBJECT, 'nudge_unfinished', 'off');
        await run(post({ type: 'nudge_unfinished', action: 'on' }), { store });
        expect(store.change).toHaveBeenLastCalledWith(SUBJECT, 'nudge_unfinished', 'on');
        expect((await run(post({ type: 'nudge_unfinished', action: 'off' }), { readSubject: async () => null, store })).status).toBe(401);
    });

    test('a link unsubscribe stays off, a missing account is a 404, and failures are generic', async () => {
        const locked = fakeStore([{ type: 'result_summary', off: true, source: 'link' }], 'link_locked');
        const result = await run(post({ type: 'result_summary', action: 'on' }), { store: locked });
        expect(result.status).toBe(409);
        expect(result.body).toContain('That email stays off because you unsubscribed using the link in an email.');
        expect(result.body).not.toContain('value="result_summary"');
        expect((await run(post({ type: 'result_summary', action: 'off' }), { store: fakeStore([], null) })).status).toBe(404);
        const log = { warn: jest.fn() };
        const broken = { read: jest.fn(), change: jest.fn(async () => { throw new Error(`driver ${ACCOUNT}`); }) };
        const failed = await run(post({ type: 'result_summary', action: 'off' }), { store: broken, log });
        expect(failed.status).toBe(503);
        expect(failed.body).not.toContain(ACCOUNT);
        expect(log.warn.mock.calls).toEqual([['email_settings_write_failed']]);
    });

    test('limits concurrent database work', async () => {
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        const store = { read: jest.fn(() => gate.then(() => [])), change: jest.fn() };
        const pending = Array.from({ length: MAX_IN_FLIGHT }, () => run({ method: 'GET' }, { store }));
        await new Promise(resolve => setImmediate(resolve));
        expect((await run({ method: 'GET' }, { store })).status).toBe(503);
        release();
        expect((await Promise.all(pending)).map(item => item.status)).toEqual(Array(MAX_IN_FLIGHT).fill(200));
        expect((await run({ method: 'GET' }, { store })).status).toBe(200);
    });

    test('limits writes per signed-in subject, with Retry-After, and leaves reads and other subjects alone', async () => {
        const now = jest.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
        try {
            const store = fakeStore();
            const off = { type: 'result_summary', action: 'off' };
            for (let i = 0; i < SUBJECT_WRITE_MAX; i += 1) expect((await run(post(off), { store })).status).toBe(303);
            now.mockReturnValue(1_800_000_000_000 + 60_000);
            const limited = await run(post(off), { store });
            expect(limited.status).toBe(429);
            expect(limited.headers['Retry-After']).toBe(String(SUBJECT_WINDOW_MS / 1000 - 60));
            expect(limited.body).not.toContain(SUBJECT);
            expect(store.change).toHaveBeenCalledTimes(SUBJECT_WRITE_MAX);
            expect((await run({ method: 'GET' }, { store })).status).toBe(200);
            const other = `${crypto.randomUUID()}:${crypto.randomUUID()}`;
            expect((await run(post(off), { store, readSubject: async () => other })).status).toBe(303);
            now.mockReturnValue(1_800_000_000_000 + SUBJECT_WINDOW_MS);
            expect((await run(post(off), { store })).status).toBe(303);
        } finally { now.mockRestore(); }
    });

    test('keeps the per-subject memory bounded', async () => {
        const store = fakeStore();
        const first = `${crypto.randomUUID()}:${crypto.randomUUID()}`;
        const off = { type: 'result_summary', action: 'off' };
        for (let i = 0; i < SUBJECT_WRITE_MAX; i += 1) await run(post(off), { store, readSubject: async () => first });
        expect((await run(post(off), { store, readSubject: async () => first })).status).toBe(429);
        // Filling the map evicts the oldest bucket, so the first subject starts again.
        for (let i = 0; i < MAX_SUBJECT_BUCKETS; i += 1) {
            await run(post(off), { store, readSubject: async () => `${crypto.randomUUID()}:${crypto.randomUUID()}` });
        }
        expect((await run(post(off), { store, readSubject: async () => first })).status).toBe(303);
    });
});

describe('server route /api/account/email', () => {
    test('is a 404 without a dashboard database, and /api/account stays retired', async () => {
        expect((await request(app).get(PATH)).status).toBe(404);
        expect((await request(app).post(PATH).type('form').send('type=result_summary&action=off')).status).toBe(404);
        expect((await request(app).post('/api/account').send({})).status).toBe(410);
    });
});
