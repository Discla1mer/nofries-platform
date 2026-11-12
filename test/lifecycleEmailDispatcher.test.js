'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createLifecycleEmailDispatcher, startLifecycleEmailDispatcher, allowedTypes, sendableTypes, BACKOFF_MS, CLAIM_SQL } = require('../api/shared/lifecycleEmail/dispatcher');
const { createResendClient } = require('../api/shared/lifecycleEmail/resendClient');
const { TEMPLATES, PLACEHOLDERS, FOOTER, renderTemplate } = require('../api/shared/lifecycleEmail/templates');
const { TEMPLATE_VERSIONS } = require('../api/shared/lifecycleEmail/templateVersions');

const ADDRESS = 'owner@example.invalid';
const ON = Object.freeze({ NOFRIES_LIFECYCLE_EMAIL_SEND_ENABLED: 'true' });
const ACCOUNT = '11111111-1111-4111-8111-111111111111', ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', LEASE = '1794000000.123456';
const row = (over = {}) => ({ outbox_id: ID, account_id: ACCOUNT, email_type: 'welcome', template_version: 'welcome-v1',
    attempts: 1, prior_attempts: 0, lease: LEASE, ...over });

function harness({ env = ON, rows = [row()], unsubscribed = [], response = { ok: true, status: 200, json: async () => ({ id: 'msg_1' }) },
    resolveAddress = async () => ADDRESS, rowCount = 1 } = {}) {
    const queries = [], logs = [], updates = [], claims = [];
    const client = { release: jest.fn(), async query(sql, params) {
        queries.push(sql);
        if (sql === CLAIM_SQL) { claims.push(params); return { rows: rows.splice(0) }; }
        if (sql.includes('FROM nofries.dashboard_starter_accounts')) return { rows: [{ account_id: ACCOUNT, subject_key: 'subject:key', unsubscribed }] };
        if (sql.startsWith('UPDATE nofries.email_outbox SET locked_until=NULL')) { updates.push({ sql, params }); return { rowCount, rows: [] }; }
        return { rows: [] };
    } };
    const pool = { connect: jest.fn(async () => client) };
    const send = jest.fn(async () => (typeof response === 'function' ? response() : response));
    const dispatcher = createLifecycleEmailDispatcher({ env, pool, resolveAddress, send, from: 'No Fries <hello@example.invalid>',
        publicOrigin: 'https://nofries.nz', log: entry => logs.push(entry) });
    return { dispatcher, pool, send, queries, logs, updates, claims };
}

describe('lifecycle email dispatcher', () => {
    test.each([[{}], [{ NOFRIES_LIFECYCLE_EMAIL_SEND_ENABLED: 'TRUE' }], [{ NOFRIES_LIFECYCLE_EMAIL_SEND_ENABLED: '1' }]])('flag off (%p) claims nothing', async env => {
        const h = harness({ env }); expect(await h.dispatcher.runOnce()).toEqual({ claimed: 0 });
        expect(h.pool.connect).not.toHaveBeenCalled();
        expect(startLifecycleEmailDispatcher({ env })).toBeNull();
    });

    test('claims as the dispatcher role, counts the attempt and sends with the outbox id as idempotency key', async () => {
        const h = harness(); expect(await h.dispatcher.runOnce()).toEqual({ claimed: 1 });
        expect(h.queries.slice(0, 3)).toEqual(['BEGIN', 'SET LOCAL ROLE nofries_email_dispatcher', CLAIM_SQL]);
        expect(CLAIM_SQL).toContain('FOR UPDATE SKIP LOCKED'); expect(CLAIM_SQL).toContain('attempts=LEAST(o.attempts+1, 6)');
        expect(h.send).toHaveBeenCalledWith(expect.objectContaining({ to: ADDRESS, idempotencyKey: ID,
            subject: 'Welcome to No Fries', text: expect.stringContaining('https://nofries.nz/dashboard') }));
        expect(h.updates).toEqual([{ sql: expect.stringContaining("status='sent'"), params: [ID, LEASE, 'msg_1'] }]);
        expect(h.logs).toEqual([{ outboxId: ID, type: 'welcome', status: 'sent', errorCode: null }]);
    });

    test('every completion is fenced by the claimed lease, and a lost lease is logged by id only', async () => {
        const h = harness({ rowCount: 0 }); await h.dispatcher.runOnce();
        expect(h.updates[0].sql).toMatch(/WHERE outbox_id=\$1 AND status='sending' AND extract\(epoch FROM locked_until\) = \$2::numeric$/);
        expect(CLAIM_SQL).toContain('extract(epoch FROM o.locked_until)::text AS lease');
        expect(h.logs).toEqual([{ outboxId: ID, type: null, status: null, errorCode: 'lease_lost' }]);
    });

    test('a row claimed at the attempt cap fails as attempts_exhausted without sending', async () => {
        const h = harness({ rows: [row({ prior_attempts: 6, attempts: 6 })] }); await h.dispatcher.runOnce();
        expect(h.updates[0]).toEqual({ sql: expect.stringContaining("status='failed'"), params: [ID, LEASE, 'attempts_exhausted'] });
        expect(h.send).not.toHaveBeenCalled();
    });

    test('backs off 5 min, 30 min, 2 h, 8 h, 24 h, then fails', async () => {
        expect(BACKOFF_MS).toEqual([300000, 1800000, 7200000, 28800000, 86400000]);
        for (let attempts = 1; attempts <= 6; attempts += 1) {
            const h = harness({ rows: [row({ attempts, prior_attempts: attempts - 1 })], response: { ok: false, status: 503 } });
            await h.dispatcher.runOnce();
            expect(h.updates[0]).toEqual(attempts < 6
                ? { sql: expect.stringContaining("status='pending'"), params: [ID, LEASE, 'provider_503', BACKOFF_MS[attempts - 1]] }
                : { sql: expect.stringContaining("status='failed'"), params: [ID, LEASE, 'provider_503'] });
        }
    });

    test('network errors and 429 retry; other 4xx fail at once with a short code', async () => {
        for (const [response, code] of [[() => { throw new Error(ADDRESS); }, 'network_error'], [{ ok: false, status: 429 }, 'provider_429']]) {
            const h = harness({ response }); await h.dispatcher.runOnce();
            expect(h.updates[0].params).toEqual([ID, LEASE, code, BACKOFF_MS[0]]);
        }
        for (const status of [400, 403, 422]) {
            const h = harness({ response: { ok: false, status } }); await h.dispatcher.runOnce();
            expect(h.updates[0]).toEqual({ sql: expect.stringContaining("status='failed'"), params: [ID, LEASE, `provider_${status}`] });
        }
    });

    test('suppresses unsubscribed types without resolving an address or sending', async () => {
        const resolveAddress = jest.fn(async () => ADDRESS), h = harness({ unsubscribed: ['welcome'], resolveAddress });
        await h.dispatcher.runOnce();
        expect(h.updates[0]).toEqual({ sql: expect.stringContaining("status='suppressed'"), params: [ID, LEASE, 'unsubscribed'] });
        expect(resolveAddress).not.toHaveBeenCalled(); expect(h.send).not.toHaveBeenCalled();
    });

    test('the allow-list filters the claim; an empty or invalid list claims nothing', async () => {
        expect([...allowedTypes({})].sort()).toEqual(['nudge_unfinished', 'reassess_reminder', 'result_summary', 'welcome']);
        expect([...allowedTypes({ NOFRIES_LIFECYCLE_EMAIL_TYPES: ' welcome , result_summary' })]).toEqual(['welcome', 'result_summary']);
        for (const types of ['', ' ', 'welcome,bogus', 'welcome,']) {
            const h = harness({ env: { ...ON, NOFRIES_LIFECYCLE_EMAIL_TYPES: types } });
            expect(await h.dispatcher.runOnce()).toEqual({ claimed: 0 }); expect(h.pool.connect).not.toHaveBeenCalled();
        }
        const h = harness({ env: { ...ON, NOFRIES_LIFECYCLE_EMAIL_TYPES: 'result_summary' } }); await h.dispatcher.runOnce();
        expect(h.claims).toEqual([[20, ['result_summary']]]);
        expect(CLAIM_SQL).toContain('email_type = ANY($2::text[])'); expect(h.updates.map(u => u.sql).join()).not.toContain('suppressed');
    });

    test('nudge and reassess types are never claimed until unsubscribe ships, even when allow-listed', async () => {
        expect(sendableTypes({})).toEqual(['welcome', 'result_summary']);
        const h = harness({ env: { ...ON, NOFRIES_LIFECYCLE_EMAIL_TYPES: 'nudge_unfinished,reassess_reminder' } });
        expect(await h.dispatcher.runOnce()).toEqual({ claimed: 0 }); expect(h.pool.connect).not.toHaveBeenCalled();
    });

    test('an unreadable, invalid or missing recipient record retries or fails without sending', async () => {
        for (const [resolveAddress, params] of [
            [async () => { throw Object.assign(new Error(), { statusCode: 503 }); }, ['recipient_store_unavailable', BACKOFF_MS[0]]],
            [async () => { throw Object.assign(new Error(), { statusCode: 401 }); }, ['recipient_invalid']], [async () => null, ['recipient_missing']]]) {
            const h = harness({ resolveAddress }); await h.dispatcher.runOnce();
            expect(h.updates[0].params).toEqual([ID, LEASE, ...params]); expect(h.send).not.toHaveBeenCalled();
        }
    });

    test('logs and stored codes never contain the address or the body', async () => {
        const spy = jest.spyOn(console, 'info').mockImplementation(() => {});
        try {
            for (const response of [{ ok: true, status: 200, json: async () => ({ id: ADDRESS }) }, { ok: false, status: 422 },
                () => { throw new Error(ADDRESS); }]) {
                const h = harness({ response }); await h.dispatcher.runOnce();
                const text = JSON.stringify([h.logs, h.updates]);
                expect(text).not.toContain(ADDRESS); expect(text).not.toContain('Kia ora');
                for (const entry of h.logs) expect(Object.keys(entry).sort()).toEqual(['errorCode', 'outboxId', 'status', 'type']);
            }
        } finally { spy.mockRestore(); }
    });
});

describe('lifecycle email start-up', () => {
    const env = { ...ON, AZURE_STORAGE_ACCOUNT_NAME: 'nofriesdata', NOFRIES_STARTER_AUTHORITY_CONTAINER: 'starter-authority',
        NOFRIES_SCOPE_EMAIL_FROM: 'No Fries <hello@example.invalid>', RESEND_API_KEY: 'test-key' };
    function deps(probe) {
        const containers = [], credentials = [];
        const createPostgresPool = jest.fn(() => ({ query: jest.fn(probe) }));
        return { containers, credentials, createPostgresPool, ManagedIdentityCredential: function (options) { credentials.push(options); },
            BlobServiceClient: function () { this.getContainerClient = name => { containers.push(name); return {}; }; } };
    }
    const okProbe = async () => ({ rows: [{ ok: true }] });

    test('configuration errors log a fixed code and never throw', () => {
        for (const bad of [{ RESEND_API_KEY: '' }, { NOFRIES_STARTER_AUTHORITY_CONTAINER: '' }, { NOFRIES_EMAIL_DISPATCHER_DB_CLIENT_ID: 'not-a-uuid' },
            { NOFRIES_EMAIL_DISPATCHER_DB_USER: 'dispatcher' }]) {
            const logs = [];
            expect(startLifecycleEmailDispatcher({ env: { ...env, ...bad }, dependencies: deps(okProbe), log: e => logs.push(e) })).toBeNull();
            expect(logs).toEqual([{ outboxId: null, type: null, status: null, errorCode: 'dispatcher_start_failed' }]);
        }
        const logs = [], dependencies = deps(okProbe);
        dependencies.createPostgresPool = () => { throw new Error('postgres_configuration_invalid'); };
        expect(startLifecycleEmailDispatcher({ env, dependencies, log: e => logs.push(e) })).toBeNull();
        expect(logs.map(e => e.errorCode)).toEqual(['dispatcher_start_failed']);
    });

    test('schedules every 5 minutes only after the SET ROLE probe passes', async () => {
        const dependencies = deps(okProbe), setIntervalImpl = jest.fn(() => ({ unref() {} }));
        const started = startLifecycleEmailDispatcher({ env, dependencies, setIntervalImpl, log: () => {} });
        try {
            expect(await started.ready).toBe(true);
            expect(dependencies.createPostgresPool.mock.results[0].value.query).toHaveBeenCalledWith(
                "SELECT pg_has_role(current_user,'nofries_email_dispatcher','SET') AS ok");
            expect(setIntervalImpl).toHaveBeenCalledWith(expect.any(Function), 300000);
            expect(dependencies.containers).toEqual(['starter-authority']);
        } finally { started.stop(); }
    });

    test.each([[async () => ({ rows: [{ ok: false }] })], [async () => { throw new Error('connect failed'); }]])('a failed probe logs once and schedules nothing', async probe => {
        const logs = [], setIntervalImpl = jest.fn();
        const started = startLifecycleEmailDispatcher({ env, dependencies: deps(probe), setIntervalImpl, log: e => logs.push(e) });
        try {
            expect(await started.ready).toBe(false);
            expect(logs).toEqual([{ outboxId: null, type: null, status: null, errorCode: 'dispatcher_role_unavailable' }]);
            expect(setIntervalImpl).not.toHaveBeenCalled();
        } finally { started.stop(); }
    });

    test('an optional dedicated database identity is used for the pool only', () => {
        const dependencies = deps(okProbe), clientId = '22222222-2222-4222-8222-222222222222';
        const started = startLifecycleEmailDispatcher({ env: { ...env, NOFRIES_EMAIL_DISPATCHER_DB_CLIENT_ID: clientId, NOFRIES_EMAIL_DISPATCHER_DB_USER: 'nofries-email' },
            dependencies, setIntervalImpl: () => ({}), log: () => {} });
        started.stop();
        expect(dependencies.credentials).toEqual([undefined, { clientId }]);
        expect(dependencies.createPostgresPool).toHaveBeenCalledWith(expect.objectContaining({ user: 'nofries-email', credential: expect.any(Object) }));
    });

    test('website enquiries still send through the extracted Resend client', async () => {
        let created;
        await jest.isolateModulesAsync(async () => {
            const actual = jest.requireActual('../api/shared/lifecycleEmail/resendClient');
            created = jest.fn(actual.createResendClient);
            jest.doMock('../api/shared/lifecycleEmail/resendClient', () => ({ ...actual, createResendClient: created }));
            const { createEnquiryService } = require('../api/shared/enquiry');
            const fetchImpl = jest.fn(async () => ({ ok: true }));
            await createEnquiryService({ env: { RESEND_API_KEY: 'k', NOFRIES_ENQUIRY_EMAIL_FROM: 'web@example.invalid' }, fetchImpl,
                rateLimiter: { reserve: async () => ({ allowed: true }) } }).submitEnquiry({ name: 'Aroha', email: 'aroha@example.invalid',
                message: 'We would like an assessment please.' });
            expect(fetchImpl.mock.calls[0][0]).toBe('https://api.resend.com/emails');
        });
        expect(created).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'k' }));
    });
});

// Until #244 makes the outbox writer import templateVersions.js, fail if the
// versions it enqueues drift from the ones the sender can render.
test('the outbox writer and the templates use the same template versions', () => {
    const writer = path.join(__dirname, '../api/shared/lifecycleEmail/outboxWriter.js');
    const enqueued = fs.existsSync(writer) ? require(writer).TEMPLATE_VERSIONS : TEMPLATE_VERSIONS;
    expect(enqueued).toEqual(TEMPLATE_VERSIONS);
    for (const [type, version] of Object.entries(enqueued)) expect(() => renderTemplate(type, version,
        { signInUrl: 'https://nofries.nz/', unsubscribeUrl: 'https://nofries.nz/' })).not.toThrow();
});

describe('lifecycle email templates', () => {
    test('every template uses only the allowed placeholders and carries no name, result or score', () => {
        for (const [type, versions] of Object.entries(TEMPLATES)) {
            for (const [version, template] of Object.entries(versions)) {
                expect(version).toBe(TEMPLATE_VERSIONS[type]);
                const source = [template.subject, ...template.lines, ...FOOTER].join('\n');
                for (const [, name] of source.matchAll(/\{\{([^}]*)\}\}/g)) expect(PLACEHOLDERS).toContain(name);
                expect(source).not.toMatch(/assessmentId|gapCount|score|\{\{name/i);
                const text = renderTemplate(type, version, { signInUrl: 'https://nofries.nz/dashboard', unsubscribeUrl: 'https://nofries.nz/dashboard' }).text;
                expect(text).not.toMatch(/\{\{/);
                expect(text).toMatch(/^Kia ora,\n/);
                expect(text).toContain('unsubscribe: https://nofries.nz/dashboard');
                expect(text).not.toMatch(/<[a-z]/i);
            }
        }
        expect(Object.keys(TEMPLATES).sort()).toEqual(Object.keys(TEMPLATE_VERSIONS).sort());
        expect(() => renderTemplate('welcome', 'welcome-v9', { signInUrl: 'https://nofries.nz/', unsubscribeUrl: 'https://nofries.nz/' }))
            .toThrow('template_unknown');
        expect(() => renderTemplate('welcome', 'welcome-v1', { signInUrl: 'javascript:alert(1)', unsubscribeUrl: 'https://nofries.nz/' })).toThrow();
    });
});

test('the Resend client posts plain text with a 10 second timeout and the idempotency key', async () => {
    const fetchImpl = jest.fn(async () => ({ ok: true })), timeout = jest.spyOn(AbortSignal, 'timeout');
    await createResendClient({ apiKey: ' key ', fetchImpl }).send({ from: 'a@example.invalid', to: 'b@example.invalid', subject: 's', text: 't', idempotencyKey: 'id-1' });
    expect(timeout).toHaveBeenCalledWith(10000); timeout.mockRestore();
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.resend.com/emails');
    expect(fetchImpl.mock.calls[0][1].headers).toEqual({ Authorization: 'Bearer key', 'Content-Type': 'application/json', 'Idempotency-Key': 'id-1' });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ from: 'a@example.invalid', to: ['b@example.invalid'], subject: 's', text: 't' });
});
