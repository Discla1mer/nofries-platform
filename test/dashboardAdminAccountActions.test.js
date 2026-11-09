'use strict';

const { Readable } = require('node:stream');
const { createExpiryAction } = require('../api/shared/dashboardAdmin/accountActionsExpiry');
const { createDashboardAdminHandlers } = require('../api/shared/dashboardAdmin/handlers');
const { hash } = require('../api/shared/appLifecycle/dashboardRuntimeRecords');
const { customerAuthorityExpiryCommandHash } = require('../api/shared/dashboardAdmin/customerAuthorityExpiry');
const { subjectHash } = require('../api/shared/customerSignup/customerAuthority');
const { entrySessionFixture, uid, SUBJECT, INSTANCE, EPOCH, NOW } = require('./fixtures/dashboardAdminEntrySession');
const iso = time => new Date(time).toISOString(), clone = value => JSON.parse(JSON.stringify(value));
const actor = { provider: 'entra-bff', isAuthenticated: true, subjectKey: SUBJECT };
const selector = { provider: 'external', subjectKey: uid(10) + ':' + uid(11), tenantId: uid(12), organisationId: uid(13) };
const route = 'extend-expired-access', url = '/api/dashboard-admin/' + route;
function fixture() {
    const trace = [], rows = new Map(), state = { fail: '', blocked: false };
    function container(name) {
        return { url: `https://syntheticstore.blob.core.windows.net/${name}`, pipeline: { options: { retryOptions: { maxTries: 1 } } }, getBlockBlobClient(key) {
            const path = name + '/' + key;
            return { async download() {
                const saved = rows.get(path), bytes = Buffer.from(JSON.stringify(saved.record));
                return { contentLength: bytes.length, etag: saved.etag, readableStreamBody: Readable.from([bytes]) };
            }, async uploadData(bytes, options) {
                trace.push(path);
                if (state.fail && path.endsWith(state.fail)) throw new Error('PRIVATE_PROVIDER_DETAIL');
                const before = rows.get(path);
                if (options.conditions.ifMatch && (state.blocked || options.conditions.ifMatch !== before?.etag) ||
                    options.conditions.ifNoneMatch && before) throw Object.assign(new Error('PRIVATE_CONFLICT_DETAIL'), { statusCode: 412 });
                rows.set(path, { record: JSON.parse(bytes.toString()), etag: '"next"' });
                if (state.lostResponse && name === 'authority') {
                    rows.get(path).record.status = 'revoked'; // Another writer after this committed CAS.
                    throw new Error('PRIVATE_LOST_RESPONSE');
                }
                return { etag: '"next"' };
            } };
        } };
    }
    const source = { schemaVersion: 1, kind: 'external_starter', storageAccount: 'syntheticstore', container: 'authority',
        providerKind: 'external-id', providerTenantId: uid(10), providerConfigurationSha256: 'a'.repeat(64) };
    const record = { schemaVersion: 1, subjectKey: selector.subjectKey, email: 'synthetic@example.invalid', revision: 0,
        status: 'active', invitationDigest: 'b'.repeat(64), invitationId: 'synthetic-invite', tenantId: selector.tenantId,
        organisationId: selector.organisationId, termsVersion: 'synthetic-terms', termsDigest: 'c'.repeat(64), bindingId: null, expiresAt: NOW - 1000 };
    const key = `authority/customer-subjects/${subjectHash(selector.subjectKey)}.json`;
    rows.set(key, { record, etag: '"before"' });
    const context = { operatorSubjectKey: SUBJECT, sessionSha256: 'd'.repeat(64), instanceId: INSTANCE,
        restoreEpoch: EPOCH, identityPolicySha256: 'e'.repeat(64) };
    const config = { source, authorityContainer: container('authority'), auditContainer: container('audit'),
        readContext: jest.fn(async () => clone(context)), readApprovedExtension: jest.fn(async () => clone(approved)), clock: () => iso(NOW) };
    const command = { schemaVersion: 1, purpose: 'customer_authority_expiry_extension', operationId: uid(14),
        target: { sourceSha256: hash(source), subjectKey: selector.subjectKey, tenantId: selector.tenantId, organisationId: selector.organisationId },
        beforeSha256: hash(record), beforeEtag: '"before"', beforeRevision: 0, beforeExpiresAt: iso(record.expiresAt), newExpiresAt: iso(NOW + 86400000) };
    const bound = () => ({ ...context, auditConfigurationSha256: hash({ purpose: 'dashboard_admin_account_actions', containerUrl: config.auditContainer.url }) });
    const approved = { command, approval: { schemaVersion: 1, purpose: command.purpose, status: 'active', approvalId: uid(15), revision: 0,
        context: bound(), commandSha256: customerAuthorityExpiryCommandHash(command, bound()), approvedExpiresAt: command.newExpiresAt,
        issuedAt: iso(NOW), expiresAt: iso(NOW + 60000) } };
    const input = { selector, operationId: command.operationId, confirmationEmail: record.email, newExpiresAt: command.newExpiresAt };
    const action = createExpiryAction(config);
    const execute = () => action.execute(actor, input, { request: {}, signal: new AbortController().signal });
    return { config, action, execute, record, context, approved, input, rows, key, trace, state,
        terminal: () => rows.get(`audit/dashboard-admin-account-actions/${command.operationId}/terminal.json`)?.record };
}

test('CAS preserves every other field and durable audit precedes success; replay cannot mutate again', async () => {
    const f = fixture(), before = clone(f.record);
    await expect(f.execute()).resolves.toEqual({ operationId: f.input.operationId, outcome: 'succeeded' });
    expect(f.rows.get(f.key).record).toEqual({ ...before, revision: 1, expiresAt: Date.parse(f.input.newExpiresAt) });
    expect(f.trace.map(path => path.split('/').pop())).toEqual(['attempt.json', f.key.split('/').pop(), 'terminal.json']);
    expect(f.terminal()).toMatchObject({ actorSubjectKey: SUBJECT, action: route, outcome: 'succeeded', occurredAt: iso(NOW),
        before: { status: 'expired', expiresAt: iso(NOW - 1000) }, after: { status: 'active', expiresAt: f.input.newExpiresAt } });
    expect(JSON.stringify(f.terminal())).not.toContain(f.record.email);
    await expect(f.execute()).rejects.toMatchObject({ statusCode: 409 });
    expect(f.rows.size).toBe(3);
});
test.each(['not_expired', 'revoked', 'confirmation', 'conflict', 'audit', 'approval', 'context', 'unknown', 'over_cap'])('%s fails closed', async mode => {
    const f = fixture(); let statusCode = 403;
    if (mode === 'not_expired') { f.record.expiresAt = NOW + 1000; statusCode = 409; }
    if (mode === 'revoked') { f.record.status = 'revoked'; statusCode = 409; }
    if (mode === 'confirmation') { f.input.confirmationEmail = 'wrong@example.invalid'; statusCode = 400; }
    if (mode === 'conflict') { f.state.blocked = true; statusCode = 409; }
    if (mode === 'audit') { f.state.fail = 'attempt.json'; statusCode = 503; }
    if (mode === 'approval') f.approved.approval.status = 'revoked';
    if (mode === 'context') f.config.readContext.mockResolvedValueOnce(clone(f.context)).mockResolvedValue({ ...f.context, restoreEpoch: uid(99) });
    if (mode === 'unknown') { f.config.readContext.mockRejectedValue(new Error('PRIVATE_PROVIDER_DETAIL')); statusCode = 503; }
    if (mode === 'over_cap') {
        f.input.newExpiresAt = f.approved.command.newExpiresAt = f.approved.approval.approvedExpiresAt = iso(NOW + 90 * 86400000 + 1);
        f.approved.approval.commandSha256 = customerAuthorityExpiryCommandHash(f.approved.command, f.approved.approval.context);
    }
    const before = clone(f.record);
    await expect(f.execute()).rejects.toMatchObject({ statusCode });
    expect(f.rows.get(f.key).record).toEqual(before);
    expect(f.trace.filter(path => path === f.key)).toHaveLength(mode === 'conflict' ? 1 : 0);
});
test('failed terminal audit withholds success after the CAS and retains the attempt', async () => {
    const f = fixture(); f.state.fail = 'terminal.json';
    await expect(f.execute()).rejects.toMatchObject({ statusCode: 503 });
    expect(f.rows.get(f.key).record.revision).toBe(1);
    expect([...f.rows.keys()].some(key => key.endsWith('attempt.json'))).toBe(true);
    expect(f.terminal()).toBeUndefined();
});
test('lost success response followed by concurrent revocation stays uncertain', async () => {
    const f = fixture(); f.state.lostResponse = true;
    await expect(f.execute()).rejects.toMatchObject({ statusCode: 503 });
    expect(f.rows.get(f.key).record.revision).toBe(1);
    expect(f.rows.get(f.key).record.status).toBe('revoked');
    expect(f.terminal()).toMatchObject({ outcome: 'uncertain', after: null,
        proposedAfter: { status: 'active', expiresAt: f.input.newExpiresAt } });
});
test.each([undefined, 2])('rejects authority clients whose retries are not explicitly disabled (%s)', async maxTries => {
    const f = fixture(); f.config.authorityContainer.pipeline.options.retryOptions.maxTries = maxTries;
    expect(() => createExpiryAction(f.config)).toThrow('dashboard_admin_unavailable');
    await expect(f.execute()).rejects.toMatchObject({ statusCode: 503 });
    expect(f.trace).not.toContain(f.key);
});
test('another session cannot consume the approved operation audit slot', async () => {
    const f = fixture(); f.approved.approval.context.sessionSha256 = 'f'.repeat(64);
    await expect(f.execute()).rejects.toMatchObject({ statusCode: 403 });
    expect(f.trace).toEqual([]);
});
test('a delayed audit must finish before success resolves', async () => {
    const f = fixture(), get = f.config.auditContainer.getBlockBlobClient;
    let release, reached;
    const pending = new Promise(resolve => { reached = resolve; });
    f.config.auditContainer.getBlockBlobClient = key => {
        const blob = get(key), upload = blob.uploadData;
        blob.uploadData = async (...args) => { if (key.endsWith('terminal.json')) { reached(); await new Promise(resolve => { release = resolve; }); } return upload(...args); };
        return blob;
    };
    let complete = false;
    const result = f.execute().then(() => { complete = true; });
    await pending; expect(complete).toBe(false); release(); await result; expect(complete).toBe(true);
});
test('revocation after durable terminal audit cannot turn committed success into failure', async () => {
    const f = fixture(), get = f.config.auditContainer.getBlockBlobClient;
    f.config.auditContainer.getBlockBlobClient = key => {
        const blob = get(key), upload = blob.uploadData;
        blob.uploadData = async (...args) => {
            const result = await upload(...args);
            if (key.endsWith('terminal.json')) f.config.readContext.mockRejectedValue(new Error('PRIVATE_REVOKED_DETAIL'));
            return result;
        };
        return blob;
    };
    await expect(f.execute()).resolves.toMatchObject({ outcome: 'succeeded' });
    expect(f.config.readContext).toHaveBeenCalledTimes(2);
    expect(f.terminal().outcome).toBe('succeeded');
});
test.each(['disabled', 'anonymous', 'customer', 'non_admin', 'origin', 'success'])('HTTP %s uses staff authorization and logs only a safe code', async mode => {
    const f = fixture(), warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const env = { NOFRIES_REQUIRE_AUTH: 'true', NOFRIES_PUBLIC_URL: 'https://actions.invalid', NOFRIES_ENTRA_TENANT_ID: SUBJECT.slice(0, 36),
        NOFRIES_ALLOWED_SUBJECTS: SUBJECT, NOFRIES_ADMIN_SUBJECTS: mode === 'non_admin' ? '' : SUBJECT,
        NOFRIES_DASHBOARD_ADMIN_ACCOUNT_ACTIONS: mode === 'disabled' ? 'false' : 'true' };
    const identity = { ...actor, tenantId: SUBJECT.slice(0, 36), principalId: SUBJECT.slice(37) };
    if (mode === 'customer') identity.provider = 'external';
    let completed = false;
    const handler = createDashboardAdminHandlers({ env, accountActions: { execute: async (...args) => {
        const result = await f.action.execute(...args); completed = true; return result;
    } },
        service: { authorise: jest.fn(), capabilities: jest.fn(), lookup: jest.fn() },
        readOperatorSession: async () => ({ identity: mode === 'anonymous' || completed ? null : identity }) });
    const req = Readable.from([Buffer.from(JSON.stringify(f.input))]);
    Object.assign(req, { method: 'POST', url, headers: { 'content-type': 'application/json',
        origin: mode === 'origin' ? 'https://other.invalid' : env.NOFRIES_PUBLIC_URL, 'sec-fetch-site': 'same-origin' } });
    try {
        const result = await handler.handle(req, route);
        expect(result.status).toBe(mode === 'success' ? 200 : mode === 'disabled' ? 404 : mode === 'anonymous' ? 401 : 403);
        expect(warning).toHaveBeenCalledTimes(mode === 'success' ? 0 : 1);
        expect(JSON.stringify(warning.mock.calls)).not.toMatch(/PRIVATE|example|synthetic/);
        if (mode !== 'success') expect(f.trace).toEqual([]);
    } finally { warning.mockRestore(); }
});
test('real host and scoped native authorization extend access using a single pool connection', async () => {
    const f = fixture(), h = entrySessionFixture({ customer: false, externalCustomer: false });
    h.env.NOFRIES_DASHBOARD_ADMIN_ACCOUNT_ACTIONS = 'true';
    const connect = h.pool.connect.getMockImplementation(); let leased = false;
    h.pool.connect.mockImplementation(async () => {
        if (leased) throw new Error('SECOND_CONNECTION'); leased = true;
        const client = await connect();
        return { release: value => { leased = false; client.release(value); }, query: (sql, params) =>
            /^(SAVEPOINT |ROLLBACK TO SAVEPOINT |RELEASE SAVEPOINT )/.test(sql) ? Promise.resolve({ rows: [] }) : client.query(sql, params) };
    });
    const binding = { schemaVersion: 1, bindingId: uid(70), revision: 1, status: 'active', action: 'dashboard.authority.read',
        purpose: 'signup_support', operatorSubjectKey: SUBJECT, instanceId: INSTANCE, selector, approvedAt: iso(NOW),
        validFrom: iso(NOW), validUntil: iso(NOW + 3600000), approvalReference: 'synthetic-approval',
        identityPolicy: { policyId: h.dashboard.identityPolicy.policyId, policyRevision: h.dashboard.identityPolicy.policyRevision },
        auditPolicy: { reference: 'synthetic-audit', revision: 1, agreementVersion: 'nf-dashboard-2026-09-r2', retention: { unit: 'calendar_months', count: 13 } } };
    const dashboardAdmin = require('../api/shared/dashboardAdmin/runtimeAdapter').createDashboardAdminRuntime({
        ...Object.fromEntries(['browserAuthOptions', 'identityPolicy', 'proofStore', 'clock', 'readExternalRuntimeEpoch',
            'newRequestId', 'requestBudgetMs', 'pool', 'instanceId', 'historyBudget', 'newId'].map(key => [key, h.dashboard[key]])),
        readApprovedBinding: async () => binding });
    const { readContext, clock, ...configuration } = f.config;
    h.rebuild({ dashboardAdmin, dashboardAdminAccountActions: configuration });
    const { cookie } = await h.login();
    expect((await h.send('post', '/api/dashboard/session').set('Cookie', cookie)
        .set('Origin', h.env.NOFRIES_PUBLIC_URL).set('Sec-Fetch-Site', 'same-origin').send({ operationId: h.nextId() })).status).toBe(200);
    const gate = h.state.tables.dashboard_session_gates[0];
    Object.assign(f.approved.approval.context, { sessionSha256: gate.session_sha256, identityPolicySha256: hash(h.dashboard.identityPolicy) });
    f.approved.approval.commandSha256 = customerAuthorityExpiryCommandHash(f.approved.command, f.approved.approval.context);
    const result = await h.send('post', url).set('Cookie', cookie).set('Origin', h.env.NOFRIES_PUBLIC_URL)
        .set('Sec-Fetch-Site', 'same-origin').send(f.input);
    expect(result.status).toBe(200); expect(f.terminal().outcome).toBe('succeeded');
});
