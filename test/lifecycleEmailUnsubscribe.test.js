'use strict';

const crypto = require('node:crypto');
const request = require('supertest');
const { createUnsubscribeToken, verifyUnsubscribeToken, unsubscribeConfigured, EMAIL_TYPES } = require('../api/shared/lifecycleEmail/unsubscribeToken');
const { handleUnsubscribeRequest, createUnsubscribeWriter, resetUnsubscribeRateLimitForTests, UPSERT_SQL, RATE_MAX,
    TOKEN_RATE_MAX, MAX_IN_FLIGHT } =
    require('../api/shared/lifecycleEmail/unsubscribeEndpoint');
const { resetAbuseProtectionForTests } = require('../api/shared/abuseProtection');

process.env.NOFRIES_REQUIRE_AUTH = 'false';
delete process.env.NOFRIES_EMAIL_UNSUBSCRIBE_SECRET;
const app = require('../server');

const SECRET = 'unit-test-only-unsubscribe-secret-0123456789';
const ENV = { NOFRIES_EMAIL_UNSUBSCRIBE_SECRET: SECRET };
const claims = { accountId: crypto.randomUUID(), subjectKey: `${crypto.randomUUID()}:${crypto.randomUUID()}`, emailType: 'nudge_unfinished' };
const token = createUnsubscribeToken(claims, ENV);
const call = (method, extra = {}) => ({ method, query: { t: token }, headers: { 'x-forwarded-for': '203.0.113.50' }, ...extra });

beforeEach(() => { resetUnsubscribeRateLimitForTests(); resetAbuseProtectionForTests(); });
afterEach(() => { delete process.env.NOFRIES_EMAIL_UNSUBSCRIBE_SECRET; });

describe('unsubscribe token', () => {
    test('round trips for every type and hides the subject key', () => {
        for (const emailType of EMAIL_TYPES) {
            const value = createUnsubscribeToken({ ...claims, emailType }, ENV);
            expect(value.length).toBeLessThanOrEqual(256);
            expect(value).not.toContain(claims.subjectKey.split(':')[0]);
            expect(value).not.toContain(claims.subjectKey.split(':')[1]);
            expect(createUnsubscribeToken({ ...claims, emailType }, ENV)).toBe(value);
            expect(verifyUnsubscribeToken(value, ENV)).toEqual({ ...claims, emailType });
        }
    });

    test('fails closed without a secret of at least 32 bytes', () => {
        for (const value of [undefined, '', 'x'.repeat(31)]) {
            const env = { NOFRIES_EMAIL_UNSUBSCRIBE_SECRET: value };
            expect(unsubscribeConfigured(env)).toBe(false);
            expect(() => createUnsubscribeToken(claims, env)).toThrow('unsubscribe_secret_unavailable');
            expect(verifyUnsubscribeToken(token, env)).toBeNull();
        }
        expect(unsubscribeConfigured(ENV)).toBe(true);
    });

    test('rejects tampering, another type, another account, another secret and unknown versions', () => {
        const [version, accountId, emailType, sealed] = token.split('.');
        const flip = sealed.slice(0, 10) + (sealed[10] === 'A' ? 'B' : 'A') + sealed.slice(11);
        const tail = sealed.slice(0, 50) + (sealed[50] === 'A' ? 'B' : 'A') + sealed.slice(51);
        for (const value of [
            [version, accountId, emailType, flip].join('.'),
            [version, accountId, emailType, tail].join('.'),
            [version, accountId, 'reassess_reminder', sealed].join('.'),
            [version, crypto.randomUUID(), emailType, sealed].join('.'),
            ['v2', accountId, emailType, sealed].join('.'),
            ['V1', accountId, emailType, sealed].join('.'),
            [version, accountId.toUpperCase(), emailType, sealed].join('.'),
            [version, accountId, 'marketing', sealed].join('.'),
            `${token}.x`, token.slice(0, -1), `${token}A`, '', 'v1...', 'x'.repeat(300), null, 42, {}
        ]) expect(verifyUnsubscribeToken(value, ENV)).toBeNull();
        expect(verifyUnsubscribeToken(token, { NOFRIES_EMAIL_UNSUBSCRIBE_SECRET: `${SECRET}-other` })).toBeNull();
    });

    test('refuses to sign malformed input', () => {
        for (const bad of [{ accountId: 'nope' }, { subjectKey: 'a:b' }, { emailType: 'marketing' }]) {
            expect(() => createUnsubscribeToken({ ...claims, ...bad }, ENV)).toThrow('unsubscribe_token_input_invalid');
        }
    });
});

describe('unsubscribe handler', () => {
    test('404 for every method while the secret is missing', async () => {
        const record = jest.fn();
        for (const method of ['GET', 'POST']) {
            expect((await handleUnsubscribeRequest(call(method), { env: {}, record })).status).toBe(404);
        }
        expect(record).not.toHaveBeenCalled();
    });

    test('GET shows a confirm form and never writes', async () => {
        const record = jest.fn();
        const result = await handleUnsubscribeRequest(call('GET'), { env: ENV, record });
        expect(result.status).toBe(200);
        expect(result.headers['Content-Type']).toMatch(/^text\/html/);
        expect(result.headers['Content-Security-Policy']).toBe("default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
        expect(result.body).toContain(`<form method="post" action="/api/emailPreferences?t=${encodeURIComponent(token)}">`);
        expect(result.body).toContain('<html lang="en-NZ">');
        expect(result.body).not.toMatch(/<script|<link|<img|style=/);
        expect(result.body).not.toContain(claims.subjectKey.split(':')[1]);
        expect(record).not.toHaveBeenCalled();
    });

    test('POST records the verified claims, from the form or an RFC 8058 one-click body', async () => {
        const record = jest.fn(async () => {});
        const form = await handleUnsubscribeRequest(call('POST', { query: {}, body: { t: token } }), { env: ENV, record });
        const oneClick = await handleUnsubscribeRequest(call('POST', { body: { 'List-Unsubscribe': 'One-Click' } }), { env: ENV, record });
        for (const result of [form, oneClick]) {
            expect(result.status).toBe(200);
            expect(result.body).toContain('You are unsubscribed');
        }
        // The second POST is answered from the recorded unsubscribe, without a write.
        expect(record).toHaveBeenCalledTimes(1);
        expect(record).toHaveBeenCalledWith(claims);
    });

    test('a replayed valid token is bounded per account and type, and writes are capped in flight', async () => {
        let fail = true;
        const record = jest.fn(async () => { if (fail) throw new Error('down'); });
        for (let i = 0; i < TOKEN_RATE_MAX; i += 1) {
            expect((await handleUnsubscribeRequest(call('POST'), { env: ENV, record })).status).toBe(503);
        }
        const limited = await handleUnsubscribeRequest(call('POST'), { env: ENV, record });
        expect(limited.status).toBe(429);
        expect(record).toHaveBeenCalledTimes(TOKEN_RATE_MAX);

        resetUnsubscribeRateLimitForTests();
        fail = false;
        const release = [];
        const slow = jest.fn(() => new Promise(resolve => release.push(resolve)));
        const other = (accountId) => call('POST', { query: { t: createUnsubscribeToken({ ...claims, accountId }, ENV) } });
        const pending = [];
        for (let i = 0; i < MAX_IN_FLIGHT; i += 1) {
            pending.push(handleUnsubscribeRequest(other(`00000000-0000-4000-8000-00000000000${i}`), { env: ENV, record: slow }));
        }
        const over = await handleUnsubscribeRequest(call('POST'), { env: ENV, record: slow });
        expect(over.status).toBe(503);
        expect(over.headers['Retry-After']).toBe('60');
        release.forEach(resolve => resolve());
        for (const result of await Promise.all(pending)) expect(result.status).toBe(200);
        expect((await handleUnsubscribeRequest(call('POST'), { env: ENV, record })).status).toBe(200);
    });

    test('invalid tokens get one generic 400 and no write', async () => {
        const record = jest.fn();
        const bodies = new Set();
        for (const t of [undefined, '', 'v1.x.y.z', token.slice(0, -2) + 'AA', ['a', 'b'], 'x'.repeat(5000)]) {
            for (const method of ['GET', 'POST']) {
                const result = await handleUnsubscribeRequest(call(method, { query: { t } }), { env: ENV, record });
                expect(result.status).toBe(400);
                bodies.add(result.body);
            }
        }
        expect(bodies.size).toBe(1);
        expect(record).not.toHaveBeenCalled();
    });

    test('write failures answer 503 with a fixed log line only', async () => {
        const log = { warn: jest.fn() };
        const result = await handleUnsubscribeRequest(call('POST'), { env: ENV, log, record: async () => { throw new Error(claims.subjectKey); } });
        expect(result.status).toBe(503);
        expect(log.warn.mock.calls).toEqual([['email_unsubscribe_write_failed']]);
        expect((await handleUnsubscribeRequest(call('POST'), { env: ENV, record: null })).status).toBe(503);
    });

    test('rate limits failed token checks per client, never valid tokens', async () => {
        const record = jest.fn(async () => {});
        const bad = (extra = {}) => call('GET', { query: { t: 'v1.not-a-token' }, ...extra });
        for (let i = 0; i < RATE_MAX; i += 1) expect((await handleUnsubscribeRequest(bad(), { env: ENV, record })).status).toBe(400);
        const limited = await handleUnsubscribeRequest(bad(), { env: ENV, record });
        expect(limited.status).toBe(429);
        expect(limited.headers['Retry-After']).toBe('600');
        const other = await handleUnsubscribeRequest(bad({ headers: { 'x-forwarded-for': '198.51.100.7' } }), { env: ENV, record });
        expect(other.status).toBe(400);
        // A valid token from the same (shared mail-provider) address still works.
        expect((await handleUnsubscribeRequest(call('POST'), { env: ENV, record })).status).toBe(200);
        expect(record).toHaveBeenCalledTimes(1);
    });

    test('other methods get 405', async () => {
        const result = await handleUnsubscribeRequest(call('PUT'), { env: ENV });
        expect(result.status).toBe(405);
        expect(result.headers.Allow).toBe('GET, POST');
    });
});

describe('unsubscribe writer', () => {
    test('runs as runtime under the subject and never clears an earlier unsubscribe', async () => {
        const client = { query: jest.fn(async () => ({ rowCount: 1 })), release: jest.fn() };
        await createUnsubscribeWriter({ pool: { connect: async () => client } })(claims);
        expect(client.query.mock.calls).toEqual([['BEGIN'], ['SET LOCAL ROLE nofries_runtime'],
            ["SELECT set_config('nofries.subject_key', $1, true)", [claims.subjectKey]],
            [UPSERT_SQL, [claims.accountId, claims.emailType]], ['COMMIT']]);
        expect(UPSERT_SQL).toMatch(/WHERE email_preferences\.unsubscribed_at IS NULL$/);
        expect(UPSERT_SQL).not.toMatch(/unsubscribed_at\s*=\s*NULL/i);
        expect(client.release).toHaveBeenCalledWith(false);
    });

    test('a failed rollback discards the connection', async () => {
        const client = { query: jest.fn(async sql => { if (!['BEGIN', 'SET LOCAL ROLE nofries_runtime'].includes(sql)) throw new Error('x'); }), release: jest.fn() };
        await expect(createUnsubscribeWriter({ pool: { connect: async () => client } })(claims)).rejects.toThrow('x');
        expect(client.release).toHaveBeenCalledWith(true);
    });
});

describe('server route /api/emailPreferences', () => {
    test('is a 404 without the secret', async () => {
        expect((await request(app).get('/api/emailPreferences').query({ t: token })).status).toBe(404);
    });

    test('with the secret, GET confirms, a valid one-click POST without a database answers 503, and nothing identifying is logged', async () => {
        process.env.NOFRIES_EMAIL_UNSUBSCRIBE_SECRET = SECRET;
        const spies = ['log', 'info', 'warn', 'error'].map(name => jest.spyOn(console, name).mockImplementation(() => {}));
        try {
            const get = await request(app).get('/api/emailPreferences').query({ t: token }).set('X-Forwarded-For', '203.0.113.60');
            expect(get.status).toBe(200);
            expect(get.headers['content-security-policy']).toContain("form-action 'self'");
            expect(get.headers['set-cookie']).toBeUndefined();
            const post = await request(app).post(`/api/emailPreferences?t=${encodeURIComponent(token)}`)
                .type('form').send('List-Unsubscribe=One-Click').set('X-Forwarded-For', '203.0.113.60');
            expect(post.status).toBe(503);
            expect((await request(app).post('/api/emailPreferences').type('form').send('t=nope')).status).toBe(400);
            expect((await request(app).post('/api/emailPreferences').type('form').send(`t=${'x'.repeat(2000)}`)).status).toBe(413);
            expect(JSON.stringify(spies.map(spy => spy.mock.calls))).not.toMatch(/203\.0\.113|[0-9a-f]{8}-[0-9a-f]{4}/);
        } finally { spies.forEach(spy => spy.mockRestore()); }
    });
});
