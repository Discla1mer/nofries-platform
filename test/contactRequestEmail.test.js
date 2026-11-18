'use strict';

// Staff notification for a newly stored contact request (#409): when the writer
// calls it, and what the email may contain. Synthetic values only.
const { createTenantRequestContext } = require('../api/shared/appLifecycle/tenantRequestContext');
const { writeContactRequest } = require('../api/shared/contactRequests');
const { createContactRequestNotifier, contactRequestEmailText, TOPIC_LABELS, ADMIN_LINE, NAME_NOTE } = require('../api/shared/contactRequestEmail');
const registry = require('../api/shared/protectedAssets/dashboardRegistry');

const uid = n => `74000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SUBJECT = uid(1) + ':' + uid(3), SCOPE = Object.freeze({ tenantId: 'tenant-a', organisationId: 'organisation-a' });
const AT = '2026-11-18T22:00:00.000Z';
const BODY = Object.freeze({ operationId: uid(900), topic: 'results', consentVersion: 'contact-request-v1' });
const ENV = Object.freeze({ NOFRIES_CONTACT_REQUEST_EMAIL_ENABLED: 'true', RESEND_API_KEY: 'synthetic-key',
    NOFRIES_ENQUIRY_EMAIL_FROM: 'web@example.invalid', NOFRIES_ENQUIRY_TO: 'staff@example.invalid', NOFRIES_ENQUIRY_DELIVERY_VERIFIED: 'true',
    NOFRIES_ENQUIRY_RATE_LIMIT_BLOB_URL: 'https://syntheticlimit.blob.core.windows.net/enquiry-rate-limit/public-enquiry-v1.json' });
const NOTICE = Object.freeze({ organisationName: 'Synthetic Organisation Ltd', topic: 'results', requestedAt: AT });

async function contextFor() {
    return createTenantRequestContext({ authenticate: async () => ({ authenticated: true, subjectKey: SUBJECT }),
        resolveScope: async () => SCOPE, clock: () => AT, createRequestId: () => uid(50) }).resolve({});
}
// Rows keyed by request id plus the 0026 daily key. "committed" flips only after
// the transaction callback has settled, as a real COMMIT would.
function database({ failAudit = false, failName = false, failDay = false } = {}) {
    const rows = new Map(), statements = [], state = { committed: 0 };
    const client = { async query(sql, params) {
        const text = sql.replace(/\s+/g, ' ').trim();
        statements.push(text);
        if (text.includes('FROM nofries.dashboard_organisations')) {
            if (failName) throw new Error('synthetic display name failure');
            expect(params).toEqual([SCOPE.tenantId, SCOPE.organisationId]);
            return { rows: [{ display_name: 'Synthetic Organisation Ltd' }] };
        }
        if (text.startsWith('SELECT EXISTS')) {
            if (failDay) throw new Error('synthetic day check failure');
            expect(params.slice(0, 3)).toEqual([SCOPE.tenantId, SCOPE.organisationId, expect.any(String)]);
            return { rows: [{ found: [...rows.values()].some(row => row[1] === params[1] && row[2] !== params[2] && row[6].slice(0, 10) === params[3].slice(0, 10)) }] };
        }
        if (text.startsWith('SELECT')) {
            const row = rows.get(params[1]);
            return { rows: row ? [{ organisation_id: row[1], subject_key: row[3], topic: row[4], consent_version: row[5] }] : [] };
        }
        const daily = [...rows.values()].some(row => row[1] === params[1] && row[4] === params[4]);
        if (rows.has(params[2]) || daily) return { rowCount: 0 };
        rows.set(params[2], params);
        return { rowCount: 1 };
    } };
    return { rows, statements, state, port: {
        database: { withTenantTransaction: async (tenantId, work) => { const value = await work(client); state.committed += 1; return value; } },
        clock: () => AT,
        audit: { createEvent: (context, action) => ({ context, ...action }),
            writeEvent: async () => { if (failAudit) throw new Error('synthetic audit failure'); } } } };
}

describe('writer: when the staff notification is called', () => {
    test('once, after the transaction commits, with the organisation name, topic and time only', async () => {
        const d = database(), context = await contextFor(), seen = [];
        const onStored = jest.fn(notice => { seen.push(d.state.committed); });
        await expect(writeContactRequest({ ...d.port, context, onStored }, BODY)).resolves.toEqual({ schemaVersion: 1, status: 'requested' });
        expect(onStored).toHaveBeenCalledTimes(1);
        expect(onStored.mock.calls[0][0]).toEqual({ organisationName: 'Synthetic Organisation Ltd', topic: 'results', requestedAt: AT });
        expect(Object.isFrozen(onStored.mock.calls[0][0])).toBe(true);
        expect(seen).toEqual([1]);
    });
    test('never for a same-operation retry or a same-day repeat', async () => {
        const d = database(), context = await contextFor(), onStored = jest.fn();
        await writeContactRequest({ ...d.port, context, onStored }, BODY);
        await expect(writeContactRequest({ ...d.port, context, onStored }, BODY)).resolves.toEqual({ schemaVersion: 1, status: 'requested' });
        await expect(writeContactRequest({ ...d.port, context, onStored }, { ...BODY, operationId: uid(901) }))
            .resolves.toEqual({ schemaVersion: 1, status: 'already_requested' });
        expect(onStored).toHaveBeenCalledTimes(1);
        expect(d.statements.filter(sql => sql.includes('dashboard_organisations'))).toHaveLength(1);
    });
    test('never when the transaction fails, and the organisation is not read when no notifier is given', async () => {
        const failed = database({ failAudit: true }), context = await contextFor(), onStored = jest.fn();
        await expect(writeContactRequest({ ...failed.port, context, onStored }, BODY)).rejects.toThrow();
        expect(onStored).not.toHaveBeenCalled();
        const plain = database();
        await writeContactRequest({ ...plain.port, context }, BODY);
        expect(plain.statements.some(sql => sql.includes('dashboard_organisations'))).toBe(false);
    });
    test('only the organisation\'s first stored row of the NZ day notifies; later topics are stored silently', async () => {
        const d = database(), context = await contextFor(), onStored = jest.fn();
        await writeContactRequest({ ...d.port, context, onStored }, BODY);
        await expect(writeContactRequest({ ...d.port, context, onStored }, { ...BODY, operationId: uid(902), topic: 'tier1_support' }))
            .resolves.toEqual({ schemaVersion: 1, status: 'requested' });
        expect(d.rows.size).toBe(2);
        expect(onStored).toHaveBeenCalledTimes(1);
        // The second row did not read the display name either.
        expect(d.statements.filter(sql => sql.includes('dashboard_organisations'))).toHaveLength(1);
    });
    test('a failing day check or display-name read fails the request and notifies nobody', async () => {
        const context = await contextFor();
        for (const options of [{ failName: true }, { failDay: true }]) {
            const d = database(options), onStored = jest.fn();
            await expect(writeContactRequest({ ...d.port, context, onStored }, BODY)).rejects.toThrow('synthetic');
            expect(onStored).not.toHaveBeenCalled(); expect(d.state.committed).toBe(0);
        }
    });
    test('an operation conflict with the notifier wired notifies nobody', async () => {
        const d = database(), context = await contextFor(), onStored = jest.fn();
        await writeContactRequest({ ...d.port, context }, BODY);
        await expect(writeContactRequest({ ...d.port, context, onStored }, { ...BODY, topic: 'monthly_proof' }))
            .rejects.toMatchObject({ code: 'contact_request_operation_conflict', statusCode: 409 });
        expect(onStored).not.toHaveBeenCalled();
    });
    test('a throwing or rejecting notifier does not change the customer result', async () => {
        const context = await contextFor();
        for (const onStored of [() => { throw new Error('synthetic'); }, async () => { throw new Error('synthetic'); }]) {
            const d = database();
            await expect(writeContactRequest({ ...d.port, context, onStored }, BODY)).resolves.toEqual({ schemaVersion: 1, status: 'requested' });
        }
    });
});

describe('notifier', () => {
    function harness({ env = ENV, reserve = async () => ({ allowed: true }), response = { ok: true } } = {}) {
        const fetchImpl = jest.fn(async () => { if (response instanceof Error) throw response; return response; });
        const rateLimiter = { reserve: jest.fn(reserve) }, log = jest.fn();
        return { fetchImpl, rateLimiter, log, notify: createContactRequestNotifier({ env, fetchImpl, rateLimiter, log }) };
    }
    test('sends one plain email to the enquiry mailbox, charged against the enquiry budget', async () => {
        const h = harness();
        await expect(h.notify(NOTICE)).resolves.toBe('contact_request_email_sent');
        expect(h.rateLimiter.reserve).toHaveBeenCalledTimes(1);
        expect(h.fetchImpl).toHaveBeenCalledTimes(1);
        const body = JSON.parse(h.fetchImpl.mock.calls[0][1].body);
        expect(body).toEqual({ from: 'web@example.invalid', to: ['staff@example.invalid'], subject: 'Dashboard contact request',
            text: ['A dashboard customer asked No Fries to contact them.', '', 'Organisation: Synthetic Organisation Ltd',
                NAME_NOTE, 'Topic: Results', 'Requested: 19 November 2026', '', ADMIN_LINE].join('\n') });
        expect(h.log).toHaveBeenCalledWith('contact_request_email_sent');
    });
    test('the staff mailbox defaults to the enquiry default when no recipient is set', async () => {
        const { NOFRIES_ENQUIRY_TO, ...env } = ENV, h = harness({ env });
        await h.notify(NOTICE);
        expect(JSON.parse(h.fetchImpl.mock.calls[0][1].body).to).toEqual(['hello@nofries.nz']);
    });
    test('content carries no customer address, assessment field or extra notice field', async () => {
        const h = harness();
        await h.notify({ ...NOTICE, organisationName: 'Synthetic\r\nBcc: x@example.invalid\u2028Org',
            email: 'customer@example.invalid', answers: { q1: 'secret-answer' }, score: 42, message: 'free text' });
        const body = JSON.parse(h.fetchImpl.mock.calls[0][1].body);
        expect(Object.keys(body).sort()).toEqual(['from', 'subject', 'text', 'to']);
        expect(body.text).not.toMatch(/customer@example|secret-answer|42|free text|\r|\u2028/);
        expect(body.text).toContain('Organisation: Synthetic Bcc: x@example.invalid Org');
        expect(body.text.split('\n')).toHaveLength(8);
    });
    test('NEL, paragraph separators, C1 controls and Unicode format characters never reach the email', async () => {
        const h = harness();
        const name = 'Syn\u0085the\u2029tic\u0080\u009f Org\u202e dlroW\u202c\u200b\u200d\u2066Ltd\u2069\ufeff';
        await h.notify({ ...NOTICE, organisationName: name });
        const text = JSON.parse(h.fetchImpl.mock.calls[0][1].body).text;
        expect(text).not.toMatch(/[\u0080-\u009f\u2028\u2029]/);
        expect(text).not.toMatch(/\p{Cf}/u);
        expect(text.split('\n')[2]).toBe('Organisation: Syn the tic Org dlroWLtd');
        expect(text.split('\n')[3]).toBe(NAME_NOTE);
        expect(contactRequestEmailText({ ...NOTICE, organisationName: '\u200b\u202e\u0085' })).toContain('Organisation: (no display name)');
    });
    test('every topic has a human label: "Results" or the service display name', () => {
        expect(TOPIC_LABELS).toEqual(Object.fromEntries([['results', 'Results'], ...registry.services.map(s => [s.key, s.label])]));
        expect(contactRequestEmailText({ ...NOTICE, topic: 'tier1_support' })).toContain('Topic: Tier 1 support');
    });
    test.each([undefined, '', 'false', 'TRUE', ' true ', '1'])('flag %p sends nothing and reserves no budget', async flag => {
        const env = { ...ENV }; if (flag === undefined) delete env.NOFRIES_CONTACT_REQUEST_EMAIL_ENABLED; else env.NOFRIES_CONTACT_REQUEST_EMAIL_ENABLED = flag;
        const h = harness({ env });
        await expect(h.notify(NOTICE)).resolves.toBe('contact_request_email_disabled');
        expect(h.rateLimiter.reserve).not.toHaveBeenCalled(); expect(h.fetchImpl).not.toHaveBeenCalled();
    });
    test('an exhausted or unavailable budget skips the send', async () => {
        const limited = harness({ reserve: async () => ({ allowed: false, retryAfter: 60 }) });
        await expect(limited.notify(NOTICE)).resolves.toBe('contact_request_email_rate_limited');
        const broken = harness({ reserve: async () => { throw new Error('synthetic'); } });
        await expect(broken.notify(NOTICE)).resolves.toBe('contact_request_email_rate_limit_unavailable');
        expect(limited.fetchImpl).not.toHaveBeenCalled(); expect(broken.fetchImpl).not.toHaveBeenCalled();
    });
    test('missing delivery, budget or verified-delivery settings skip the send before any reservation', async () => {
        for (const [key, value] of [['RESEND_API_KEY'], ['NOFRIES_ENQUIRY_EMAIL_FROM'], ['NOFRIES_ENQUIRY_RATE_LIMIT_BLOB_URL'],
            ['NOFRIES_ENQUIRY_DELIVERY_VERIFIED'], ['NOFRIES_ENQUIRY_DELIVERY_VERIFIED', 'TRUE']]) {
            const env = { ...ENV }; delete env[key]; if (value !== undefined) env[key] = value;
            const h = harness({ env });
            await expect(h.notify(NOTICE)).resolves.toBe('contact_request_email_unavailable');
            expect(h.rateLimiter.reserve).not.toHaveBeenCalled(); expect(h.fetchImpl).not.toHaveBeenCalled();
        }
    });
    test('send failures and invalid notices resolve to a logged code and never reject', async () => {
        for (const [response, code] of [[{ ok: false, status: 500 }, 'contact_request_email_send_failed'],
            [new Error('synthetic network'), 'contact_request_email_send_failed']]) {
            const h = harness({ response });
            await expect(h.notify(NOTICE)).resolves.toBe(code);
            expect(h.log).toHaveBeenCalledWith(code);
        }
        const h = harness();
        await expect(h.notify({ ...NOTICE, topic: 'other' })).resolves.toBe('contact_request_email_invalid');
        await expect(h.notify({ ...NOTICE, requestedAt: 'not a time' })).resolves.toBe('contact_request_email_invalid');
        expect(h.rateLimiter.reserve).not.toHaveBeenCalled();
        const throwingLog = createContactRequestNotifier({ env: ENV, fetchImpl: async () => ({ ok: true }),
            rateLimiter: { reserve: async () => ({ allowed: true }) }, log: () => { throw new Error('synthetic'); } });
        await expect(throwingLog(NOTICE)).resolves.toBe('contact_request_email_sent');
    });
    test('the default log line is code-only', async () => {
        const info = jest.spyOn(console, 'info').mockImplementation(() => {});
        try {
            await createContactRequestNotifier({ env: ENV, fetchImpl: async () => ({ ok: false }),
                rateLimiter: { reserve: async () => ({ allowed: true }) } })(NOTICE);
            expect(info.mock.calls).toEqual([[JSON.stringify({ event: 'contact_request_email', code: 'contact_request_email_send_failed' })]]);
        } finally { info.mockRestore(); }
    });
});
