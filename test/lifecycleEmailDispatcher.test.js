'use strict';

const { createLifecycleEmailDispatcher, startLifecycleEmailDispatcher, allowedTypes, BACKOFF_MS, CLAIM_SQL } = require('../api/shared/lifecycleEmail/dispatcher');
const { createResendClient } = require('../api/shared/lifecycleEmail/resendClient');
const { TEMPLATES, PLACEHOLDERS, FOOTER, renderTemplate } = require('../api/shared/lifecycleEmail/templates');

const ADDRESS = 'owner@example.invalid';
const ON = Object.freeze({ NOFRIES_LIFECYCLE_EMAIL_SEND_ENABLED: 'true' });
const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const row = (over = {}) => ({ outbox_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', account_id: ACCOUNT, email_type: 'welcome',
    template_version: 'welcome-v1', attempts: 0, ...over });

function harness({ env = ON, rows = [row()], unsubscribed = [], response = { ok: true, status: 200, json: async () => ({ id: 'msg_1' }) },
    resolveAddress = async () => ADDRESS } = {}) {
    const queries = [], logs = [], updates = [];
    const client = { release: jest.fn(), async query(sql, params) {
        queries.push(sql);
        if (sql === CLAIM_SQL) return { rows: rows.splice(0) };
        if (sql.includes('FROM nofries.dashboard_starter_accounts')) return { rows: [{ account_id: ACCOUNT, subject_key: 'subject:key', unsubscribed }] };
        if (sql.startsWith('UPDATE nofries.email_outbox SET locked_until=NULL')) updates.push({ sql, params });
        return { rows: [] };
    } };
    const pool = { connect: jest.fn(async () => client) };
    const send = jest.fn(async () => (typeof response === 'function' ? response() : response));
    const dispatcher = createLifecycleEmailDispatcher({ env, pool, resolveAddress, send, from: 'No Fries <hello@example.invalid>',
        publicOrigin: 'https://nofries.nz', log: entry => logs.push(entry) });
    return { dispatcher, pool, send, queries, logs, updates };
}

describe('lifecycle email dispatcher', () => {
    test.each([[{}], [{ NOFRIES_LIFECYCLE_EMAIL_SEND_ENABLED: 'TRUE' }], [{ NOFRIES_LIFECYCLE_EMAIL_SEND_ENABLED: '1' }]])('flag off (%p) claims nothing', async env => {
        const h = harness({ env }); expect(await h.dispatcher.runOnce()).toEqual({ claimed: 0 });
        expect(h.pool.connect).not.toHaveBeenCalled();
        expect(startLifecycleEmailDispatcher({ env })).toBeNull();
    });

    test('claims as the dispatcher role and sends with the outbox id as idempotency key', async () => {
        const h = harness(); expect(await h.dispatcher.runOnce()).toEqual({ claimed: 1 });
        expect(h.queries.slice(0, 3)).toEqual(['BEGIN', 'SET LOCAL ROLE nofries_email_dispatcher', CLAIM_SQL]);
        expect(CLAIM_SQL).toContain('FOR UPDATE SKIP LOCKED');
        expect(h.send).toHaveBeenCalledWith(expect.objectContaining({ to: ADDRESS, idempotencyKey: row().outbox_id,
            subject: 'Welcome to No Fries', text: expect.stringContaining('https://nofries.nz/dashboard') }));
        expect(h.updates).toEqual([{ sql: expect.stringContaining("status='sent'"), params: [row().outbox_id, 'msg_1', 1] }]);
        expect(h.logs).toEqual([{ outboxId: row().outbox_id, type: 'welcome', status: 'sent', errorCode: null }]);
    });

    test('backs off 5 min, 30 min, 2 h, 8 h, 24 h, then fails', async () => {
        expect(BACKOFF_MS).toEqual([300000, 1800000, 7200000, 28800000, 86400000]);
        for (let attempts = 0; attempts < 6; attempts += 1) {
            const h = harness({ rows: [row({ attempts })], response: { ok: false, status: 503 } }); await h.dispatcher.runOnce();
            const [update] = h.updates;
            if (attempts < 5) {
                expect(update.sql).toContain("status='pending'");
                expect(update.params).toEqual([row().outbox_id, 'provider_503', attempts + 1, BACKOFF_MS[attempts]]);
            } else {
                expect(update.sql).toContain("status='failed'");
                expect(update.params).toEqual([row().outbox_id, 'provider_503', 6]);
            }
        }
    });

    test('network errors and 429 retry; other 4xx fail at once with a short code', async () => {
        for (const [response, code] of [[() => { throw new Error(ADDRESS); }, 'network_error'], [{ ok: false, status: 429 }, 'provider_429']]) {
            const h = harness({ response }); await h.dispatcher.runOnce();
            expect(h.updates[0].params).toEqual([row().outbox_id, code, 1, BACKOFF_MS[0]]);
        }
        for (const status of [400, 403, 422]) {
            const h = harness({ response: { ok: false, status } }); await h.dispatcher.runOnce();
            expect(h.updates[0].sql).toContain("status='failed'");
            expect(h.updates[0].params).toEqual([row().outbox_id, `provider_${status}`, 1]);
        }
    });

    test('suppresses unsubscribed types without resolving an address or sending', async () => {
        const resolveAddress = jest.fn(async () => ADDRESS), h = harness({ unsubscribed: ['welcome'], resolveAddress });
        await h.dispatcher.runOnce();
        expect(h.updates[0]).toEqual({ sql: expect.stringContaining("status='suppressed'"), params: [row().outbox_id, 'unsubscribed'] });
        expect(resolveAddress).not.toHaveBeenCalled(); expect(h.send).not.toHaveBeenCalled();
    });

    test('the type allow-list narrows which types send', async () => {
        expect([...allowedTypes({})].sort()).toEqual(['nudge_unfinished', 'reassess_reminder', 'result_summary', 'welcome']);
        expect([...allowedTypes({ NOFRIES_LIFECYCLE_EMAIL_TYPES: ' welcome , bogus' })]).toEqual(['welcome']);
        const h = harness({ env: { ...ON, NOFRIES_LIFECYCLE_EMAIL_TYPES: 'result_summary' } }); await h.dispatcher.runOnce();
        expect(h.updates[0].params).toEqual([row().outbox_id, 'type_not_allowed']);
        expect(h.send).not.toHaveBeenCalled();
    });

    test('an unreadable, invalid or missing recipient record retries or fails without sending', async () => {
        for (const [resolveAddress, params] of [
            [async () => { throw Object.assign(new Error(), { statusCode: 503 }); }, ['recipient_store_unavailable', 1, BACKOFF_MS[0]]],
            [async () => { throw Object.assign(new Error(), { statusCode: 401 }); }, ['recipient_invalid', 1]], [async () => null, ['recipient_missing', 1]]]) {
            const h = harness({ resolveAddress }); await h.dispatcher.runOnce();
            expect(h.updates[0].params).toEqual([row().outbox_id, ...params]); expect(h.send).not.toHaveBeenCalled();
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
    test('starts every 5 minutes only when the flag is on, and refuses incomplete configuration', () => {
        const env = { ...ON, AZURE_STORAGE_ACCOUNT_NAME: 'nofriesdata', NOFRIES_STARTER_AUTHORITY_CONTAINER: 'starter-authority',
            NOFRIES_SCOPE_EMAIL_FROM: 'No Fries <hello@example.invalid>', RESEND_API_KEY: 'test-key' };
        const containers = [];
        const dependencies = { ManagedIdentityCredential: function () {}, createPostgresPool: jest.fn(() => ({})),
            BlobServiceClient: function () { this.getContainerClient = name => { containers.push(name); return {}; }; } };
        const setIntervalImpl = jest.fn(() => ({ unref() {} }));
        expect(() => startLifecycleEmailDispatcher({ env: { ...env, RESEND_API_KEY: '' }, dependencies, setIntervalImpl })).toThrow('lifecycle_email_configuration_invalid');
        expect(() => startLifecycleEmailDispatcher({ env: { ...env, NOFRIES_STARTER_AUTHORITY_CONTAINER: '' }, dependencies, setIntervalImpl }))
            .toThrow('lifecycle_email_configuration_invalid');
        startLifecycleEmailDispatcher({ env, dependencies, setIntervalImpl }).stop();
        expect(setIntervalImpl).toHaveBeenCalledWith(expect.any(Function), 300000);
        expect(containers).toEqual(['starter-authority']);
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

describe('lifecycle email templates', () => {
    test('every template uses only the allowed placeholders and carries no name, result or score', () => {
        for (const [type, versions] of Object.entries(TEMPLATES)) {
            for (const [version, template] of Object.entries(versions)) {
                expect(version).toMatch(new RegExp(`^${type}-v\\d+$`));
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
