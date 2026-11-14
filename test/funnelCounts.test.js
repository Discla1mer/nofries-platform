'use strict';

const request = require('supertest');
const { FUNNEL_EVENTS, aucklandDay, createFunnelCountWriter, funnelCountsEnabled, handleFunnelCountRequest, UPSERT_SQL,
    resetTelemetryRateLimitForTests, telemetryKey, STATEMENT_TIMEOUT_SQL, LOCK_TIMEOUT_SQL } = require('../api/shared/funnelCounts');
const { handlers } = require('../api/shared/apiRuntime');
const { checkRateLimit, resetAbuseProtectionForTests } = require('../api/shared/abuseProtection');

process.env.NOFRIES_REQUIRE_AUTH = 'false';
delete process.env.NOFRIES_FUNNEL_COUNTS_ENABLED;
const app = require('../server');

const ON = { NOFRIES_FUNNEL_COUNTS_ENABLED: 'true' };
const IP = '203.0.113.77';
const UA = 'Mozilla/5.0 PrivateBrowser/9.9';
const post = (body, extra = {}) => ({ method: 'POST', body, headers: { 'sec-fetch-site': 'same-origin',
    'x-forwarded-for': IP, 'user-agent': UA, referer: 'https://nofries.nz/private?x=1', ...extra } });

beforeEach(() => { resetAbuseProtectionForTests(); resetTelemetryRateLimitForTests(); });
afterEach(() => { delete process.env.NOFRIES_FUNNEL_COUNTS_ENABLED; });

test('flag is on only for the exact string true', () => {
    for (const value of [undefined, '', 'false', 'TRUE', '1', 'true ']) {
        expect(funnelCountsEnabled({ NOFRIES_FUNNEL_COUNTS_ENABLED: value })).toBe(false);
    }
    expect(funnelCountsEnabled(ON)).toBe(true);
});

test('Pacific/Auckland day crosses midnight in NZ, not UTC', () => {
    expect(aucklandDay(new Date('2026-11-12T10:59:59Z'))).toBe('2026-11-12');
    expect(aucklandDay(new Date('2026-11-12T11:00:00Z'))).toBe('2026-11-13');
    expect(aucklandDay(new Date('2026-06-30T12:00:00Z'))).toBe('2026-07-01');
});

test('flag off gives 410 for every method and never records', async () => {
    const record = jest.fn();
    for (const method of ['POST', 'GET']) {
        const result = await handleFunnelCountRequest({ ...post({ event: 'visit' }), method }, { env: {}, record });
        expect(result.status).toBe(410);
        expect(result.body.code).toBe('telemetry_disabled');
    }
    expect(record).not.toHaveBeenCalled();
});

test('valid event upserts once with the NZ date and returns 204 without cookies or logs', async () => {
    const record = jest.fn(async () => {});
    const log = { warn: jest.fn(), error: jest.fn(), info: jest.fn() };
    for (const event of FUNNEL_EVENTS) {
        const result = await handleFunnelCountRequest(post({ event }), { env: ON, record, log,
            now: () => new Date('2026-11-12T12:30:00Z') });
        expect(result.status).toBe(204);
        expect(result.body).toBeNull();
        expect(Object.keys(result.headers).map(name => name.toLowerCase())).not.toContain('set-cookie');
    }
    expect(record).toHaveBeenCalledTimes(FUNNEL_EVENTS.length);
    expect(record).toHaveBeenNthCalledWith(1, 'visit', '2026-11-13');
    expect(log.warn).not.toHaveBeenCalled();
});

test.each([
    ['unknown event', { event: 'page_view' }],
    ['extra field', { event: 'visit', ip: '1' }],
    ['non-string event', { event: 1 }],
    ['array', ['visit']],
    ['bad JSON string', '{event'],
    ['missing body', undefined]
])('%s gives 400', async (_name, body) => {
    const record = jest.fn();
    const result = await handleFunnelCountRequest(post(body), { env: ON, record });
    expect(result.status).toBe(400);
    expect(record).not.toHaveBeenCalled();
});

test('oversize body, non-POST and cross-site requests are rejected', async () => {
    const record = jest.fn();
    expect((await handleFunnelCountRequest(post({ event: 'visit', pad: 'x'.repeat(64) }), { env: ON, record })).status).toBe(413);
    expect((await handleFunnelCountRequest(post({ event: 'visit' }, { 'content-length': '65' }), { env: ON, record })).status).toBe(413);
    const get = await handleFunnelCountRequest({ ...post(), method: 'GET' }, { env: ON, record });
    expect(get.status).toBe(405);
    expect(get.headers.Allow).toBe('POST');
    expect((await handleFunnelCountRequest(post({ event: 'visit' }, { 'sec-fetch-site': 'cross-site' }), { env: ON, record })).status).toBe(403);
    expect(record).not.toHaveBeenCalled();
});

test('its own in-memory rate limit returns 429 after 90 posts per client', async () => {
    const record = jest.fn(async () => {});
    for (let i = 0; i < 90; i += 1) expect((await handleFunnelCountRequest(post({ event: 'visit' }), { env: ON, record })).status).toBe(204);
    expect((await handleFunnelCountRequest(post({ event: 'visit' }), { env: ON, record })).status).toBe(429);
    expect(record).toHaveBeenCalledTimes(90);
});

test('telemetry traffic never touches the shared enquiry and signup rate-limit buckets', async () => {
    const record = jest.fn(async () => {});
    for (let i = 0; i < 100; i += 1) await handleFunnelCountRequest(post({ event: 'visit' }), { env: ON, record });
    expect(checkRateLimit('apiEnquiry', IP, {}).allowed).toBe(true);
});

test('IPv6 clients share a bucket per /64', () => {
    expect(telemetryKey('2001:db8:1:2:aaaa::1')).toBe(telemetryKey('2001:db8:1:2:bbbb::9'));
    expect(telemetryKey('2001:db8:1:2::1')).not.toBe(telemetryKey('2001:db8:1:3::1'));
    expect(telemetryKey(IP)).toBe(IP);
    expect(telemetryKey('2001:db8::aaaa:1')).toBe(telemetryKey('2001:db8::bbbb:1'));
    expect(telemetryKey('2001:db8::1')).toBe('2001:0db8:0000:0000::/64');
    expect(telemetryKey('2001:DB8:0:0:1::1')).toBe(telemetryKey('2001:db8::2'));
    expect(telemetryKey('::ffff:203.0.113.7')).toBe(telemetryKey('::ffff:203.0.113.8'));
});

test('telemetry posts do not spend the shared API write budget', async () => {
    process.env.NOFRIES_FUNNEL_COUNTS_ENABLED = 'true';
    for (let i = 0; i < 95; i += 1) {
        await request(app).post('/api/telemetry').set('sec-fetch-site', 'same-origin').set('x-forwarded-for', '198.51.100.9').send({ event: 'visit' });
    }
    expect(checkRateLimit('apiWrite', '198.51.100.9', {}).allowed).toBe(true);
});

test('a failed write logs fixed text only, with no IP, user agent or referrer', async () => {
    const lines = [];
    const log = { warn: (...args) => lines.push(args.join(' ')), error: (...args) => lines.push(args.join(' ')) };
    const record = jest.fn(async () => { throw new Error(`connection from ${IP} failed`); });
    const result = await handleFunnelCountRequest(post({ event: 'visit' }), { env: ON, record, log });
    expect(result.status).toBe(503);
    expect(lines).toEqual(['funnel_count_write_failed']);
    expect(JSON.stringify([lines, result])).not.toMatch(/203\.0\.113|PrivateBrowser|private\?x/);
});

test('writer runs one upsert under the runtime role in a transaction', async () => {
    const queries = [];
    const client = { query: jest.fn(async (sql, params) => { queries.push([sql, params]); }), release: jest.fn() };
    const record = createFunnelCountWriter({ pool: { connect: async () => client } });
    await record('submitted', '2026-11-13');
    expect(queries).toEqual([['BEGIN', undefined], ['SET LOCAL ROLE nofries_runtime', undefined],
        [STATEMENT_TIMEOUT_SQL, undefined], [LOCK_TIMEOUT_SQL, undefined],
        [UPSERT_SQL, ['2026-11-13', 'submitted']], ['COMMIT', undefined]]);
    expect(STATEMENT_TIMEOUT_SQL).toBe("SET LOCAL statement_timeout = '1000ms'");
    expect(LOCK_TIMEOUT_SQL).toBe("SET LOCAL lock_timeout = '500ms'");
    expect(UPSERT_SQL).toMatch(/ON CONFLICT \(day, event\) DO UPDATE SET count = funnel_daily_counts\.count \+ 1/);
    expect(client.release).toHaveBeenCalledWith(false);
});

test('Functions host keeps 410 with the flag off and founderSummary stays retired', async () => {
    expect((await handlers.telemetry({}, post({ event: 'visit' }))).status).toBe(410);
    process.env.NOFRIES_FUNNEL_COUNTS_ENABLED = 'true';
    expect((await handlers.founderSummary({}, post({ event: 'visit' }))).status).toBe(410);
    expect((await handlers.telemetry({}, post({ event: 'visit' }))).status).toBe(503);
});

describe('server route /api/telemetry', () => {
    const send = (method = 'post') => request(app)[method]('/api/telemetry')
        .set('Sec-Fetch-Site', 'same-origin').set('X-Forwarded-For', IP).set('User-Agent', UA);

    test('flag off gives 410 even for an oversize body', async () => {
        const response = await send().send({ event: 'visit', pad: 'x'.repeat(200) });
        expect(response.status).toBe(410);
        expect(response.body.code).toBe('telemetry_disabled');
        expect(response.headers['set-cookie']).toBeUndefined();
    });

    test('flag on rejects bad input and sets no cookies or visitor logs', async () => {
        process.env.NOFRIES_FUNNEL_COUNTS_ENABLED = 'true';
        const spies = ['log', 'info', 'warn', 'error'].map(name => jest.spyOn(console, name).mockImplementation(() => {}));
        try {
            const responses = [
                [await send().send({ event: 'nope' }), 400],
                [await send().send({ event: 'visit', pad: 'x'.repeat(64) }), 413],
                [await send('get'), 405],
                [await send().send({ event: 'visit' }), 503]
            ];
            for (const [response, status] of responses) {
                expect(response.status).toBe(status);
                expect(response.headers['set-cookie']).toBeUndefined();
            }
            const logged = JSON.stringify(spies.map(spy => spy.mock.calls));
            expect(logged).not.toMatch(/203\.0\.113|PrivateBrowser/);
        } finally { spies.forEach(spy => spy.mockRestore()); }
    });
});

test('a failed upsert with a clean rollback keeps the pooled connection', async () => {
    const client = { query: jest.fn(async sql => { if (String(sql).startsWith('INSERT')) throw new Error('check'); }), release: jest.fn() };
    const record = createFunnelCountWriter({ pool: { connect: async () => client } });
    await expect(record('visit', '2026-11-12')).rejects.toThrow('check');
    expect(client.release).toHaveBeenCalledWith(false);
});

test('a failed rollback discards the pooled connection', async () => {
    const client = { query: jest.fn(async sql => { if (sql !== 'BEGIN' && !sql.startsWith('SET LOCAL')) throw new Error('broken'); }), release: jest.fn() };
    const record = createFunnelCountWriter({ pool: { connect: async () => client } });
    await expect(record('visit', '2026-11-12')).rejects.toThrow('broken');
    expect(client.release).toHaveBeenCalledWith(true);
});

test('the upsert stops at the cap instead of erroring', () => {
    expect(UPSERT_SQL).toMatch(/WHERE funnel_daily_counts\.count < 10000000/);
});
