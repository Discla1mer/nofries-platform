'use strict';

// Real synthetic OIDC callback, parent cookie, original issuance proof and
// operator capture. ONLY the finite native repository/SQL gate is mocked below;
// these tests do not establish PostgreSQL, deployed gate or production authority.
jest.mock('../api/shared/appLifecycle/postgresDashboardRuntimeRepository', () => ({
    ...jest.requireActual('../api/shared/appLifecycle/postgresDashboardRuntimeRepository'),
    createPostgresDashboardAdministrationRepository: jest.fn()
}));

const { IncomingMessage } = require('node:http');
const { Socket } = require('node:net');
const { createHash } = require('node:crypto');
const { Readable } = require('node:stream');
const { createBrowserAuthService } = require('../api/shared/browserAuth');
const { MemoryBrowserSessionStore } = require('../api/shared/browserSessionStore');
const { createDashboardOperatorSession } = require('../api/shared/dashboardOperatorSession');
const { createPostgresDashboardAdministrationRepository: nativeFactory } = require('../api/shared/appLifecycle/postgresDashboardRuntimeRepository');
const { createDashboardAdminRuntime } = require('../api/shared/dashboardAdmin/runtimeAdapter');
const { createDashboardAdminApprovalReader } = require('../api/shared/dashboardAdmin/approvalStore');
const { headKey, revisionKey } = require('../api/shared/dashboardAdmin/approvalRecords');
const { canonical, hash } = require('../api/shared/appLifecycle/dashboardRuntimeRecords');
const { createDashboardAdminService, normaliseSelector } = require('../api/shared/dashboardAdmin/service');
const { verifyAuditPhasePair, projectAuditRow } = require('../api/shared/dashboardAdmin/auditEnvelope');
const { dataCodec } = require('../api/shared/appLifecycle/postgresDashboardBootstrap');
const { fixture, SUBJECT: TARGET_SUBJECT } = require('./fixtures/dashboardFixture');

const TENANT = '10000000-0000-4000-8000-000000000001';
const CLIENT = '10000000-0000-4000-8000-000000000002';
const OID = '10000000-0000-4000-8000-000000000003';
const OTHER = '10000000-0000-4000-8000-000000000004';
const INSTANCE = '10000000-0000-4000-8000-000000000005';
const EPOCH = '10000000-0000-4000-8000-000000000006';
const BINDING = '10000000-0000-4000-8000-000000000007';
const LOOKUP = '10000000-0000-4000-8000-000000000008';
const NOW = Date.parse('2026-10-19T02:00:00.000Z');
const ACTOR = TENANT + ':' + OID;
const principal = { provider: 'entra-bff', isAuthenticated: true, subjectKey: ACTOR };
const clone = value => JSON.parse(JSON.stringify(value));
const cookie = response => response.cookie.split(';')[0];
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const pause = () => new Promise(resolve => setImmediate(resolve));
const denied = () => Object.assign(new Error('synthetic native gate denied'), { statusCode: 403, code: 'onboarding_access_denied' });
const ambiguous = () => Object.assign(new Error('synthetic uncertain COMMIT acknowledgement'), { statusCode: 503, code: 'onboarding_outcome_ambiguous' });

async function harness(options = {}) {
    const state = { now: NOW, epoch: EPOCH, bytes: 1, requests: 0, ids: 0, gateReady: true, validateHook: null, persistResult: true,
        readHook: null, persistHook: null, reconcileHook: null };
    const env = { NOFRIES_REQUIRE_AUTH: 'true', NOFRIES_PUBLIC_URL: 'https://synthetic.invalid',
        NOFRIES_ENTRA_TENANT_ID: TENANT, NOFRIES_ENTRA_CLIENT_ID: CLIENT,
        NOFRIES_ENTRA_CLIENT_SECRET: 'synthetic-test-only-secret', NOFRIES_ALLOWED_SUBJECTS: ACTOR + ',' + TENANT + ':' + OTHER };
    const store = new MemoryBrowserSessionStore(), proofs = new Map(), ledger = new Map(), trace = [], captures = [];
    const proofStore = { createOriginalProof: jest.fn(async (key, value) => { if (proofs.has(key)) throw new Error('collision'); proofs.set(key, clone(value)); }),
        readOriginalProof: jest.fn(async key => proofs.has(key) ? clone(proofs.get(key)) : null) };
    const clientApplication = { getAuthCodeUrl: jest.fn(async args => {
        const url = new URL('https://login.microsoftonline.com/' + TENANT + '/oauth2/v2.0/authorize');
        for (const [key, value] of Object.entries({ client_id: CLIENT, redirect_uri: args.redirectUri,
            response_mode: 'form_post', state: args.state, nonce: args.nonce,
            code_challenge: args.codeChallenge, code_challenge_method: 'S256' })) url.searchParams.set(key, value);
        return url.href;
    }), acquireTokenByCode: jest.fn(async args => ({ idTokenClaims: { aud: CLIENT, tid: TENANT,
        oid: args.code === 'other' ? OTHER : OID, iss: 'https://login.microsoftonline.com/' + TENANT + '/v2.0', nonce: args.nonce,
        exp: Math.floor(state.now / 1000) + 3600, name: 'Synthetic operator', preferred_username: 'synthetic@example.invalid' },
    account: { localAccountId: OID, tenantId: TENANT }, accessToken: 'synthetic-unpersisted-token', idToken: 'synthetic-unpersisted-id-token' })),
    getTokenCache: () => ({ removeAccount: async () => {} }) };
    const browserAuthOptions = { env, store, clientApplication,
        cryptoProvider: { generatePkceCodes: async () => ({ verifier: 'v'.repeat(64), challenge: 'c'.repeat(43) }) },
        randomBytes: size => Buffer.alloc(size, state.bytes++) };
    const clock = () => new Date(state.now).toISOString();
    const sessionOptions = { browserAuthOptions, identityPolicy: { policyId: 'synthetic-operator-policy', policyRevision: 0,
        issuer: 'https://login.microsoftonline.com/' + TENANT + '/v2.0', identityTenantId: TENANT, audience: CLIENT },
    proofStore, clock, readExternalRuntimeEpoch: async () => ({ instanceId: INSTANCE, restoreEpoch: state.epoch }),
    newRequestId: () => '20000000-0000-4000-8000-' + (++state.requests).toString().padStart(12, '0'), requestBudgetMs: 1000 };
    const issuer = createDashboardOperatorSession(sessionOptions), browser = createBrowserAuthService({ ...browserAuthOptions, now: () => state.now });
    async function login(code = 'operator', wrapped = true) {
        const start = await browser.beginLogin({ returnTo: '/operator' });
        const input = { body: { code, state: new URL(start.location).searchParams.get('state') }, cookieHeader: cookie(start) };
        return (wrapped ? issuer.callbackService : browser).completeLogin(input);
    }
    const loginResult = await login('operator', options.withProof !== false);
    // Install spies after the authorised synthetic callback, before the runtime
    // captures its backing-store methods. Capture/reconciliation must never
    // reach these actual mutators, including browserAuth's invalid-parent cleanup.
    const storeWrites = Object.fromEntries(['createTransaction', 'consumeTransaction', 'deleteTransaction', 'cancelTransaction',
        'createSession', 'deleteSession'].map(name => [name, jest.spyOn(store, name)]));
    function request(cookieValue = cookie(loginResult)) {
        const value = new IncomingMessage(new Socket()); value.method = 'POST'; value.url = '/api/dashboard-admin/lookup';
        value.headers = { cookie: cookieValue }; return value;
    }
    const f = fixture({ now: clock() }), selector = { provider: 'legacy', subjectKey: TARGET_SUBJECT, ...f.scope };
    const snapshot = { tenantAggregate: f.tenantAggregate, membershipState: f.membershipState, entitlementState: f.entitlementState,
        flags: f.flags, advisorAssignments: [], usage: f.entitlementState.grants.map(dataCodec.newUsage) };
    state.binding = { schemaVersion: 1, bindingId: BINDING, revision: 1, status: 'active', action: 'dashboard.authority.read', purpose: 'signup_support',
        operatorSubjectKey: ACTOR, instanceId: INSTANCE, selector: clone(selector), approvedAt: new Date(NOW - 2000).toISOString(),
        validFrom: new Date(NOW - 1000).toISOString(), validUntil: new Date(NOW + 60000).toISOString(), approvalReference: 'synthetic-private-approval',
        identityPolicy: { policyId: 'synthetic-operator-policy', policyRevision: 0 },
        auditPolicy: { reference: 'synthetic-private-retention-policy', revision: 2,
            agreementVersion: 'nf-dashboard-2026-09-r2', retention: { unit: 'calendar_months', count: 13 } } };
    let readApprovedBinding = jest.fn(async input => { if (state.bindingHook) await state.bindingHook(input); return clone(state.binding); });
    if (options.approvalReader) {
        const approvalEpoch = state.epoch;
        const target = { operatorSubjectKey: ACTOR, purpose: 'signup_support', instanceId: INSTANCE };
        const reader = createDashboardAdminApprovalReader({ instanceId: INSTANCE, clock,
            readExternalRuntimeEpoch: sessionOptions.readExternalRuntimeEpoch, requestBudgetMs: 1000,
            authorityContainer: { getBlockBlobClient(key) { return { async download(_offset, _length, input) {
                if (state.approvalMissing) throw Object.assign(new Error('synthetic absent'), { statusCode: 404, code: 'BlobNotFound' });
                const revoked = state.approvalRevoked === true;
                const record = { schemaVersion: 1, recordType: 'dashboard_admin_approval_revision', ...target,
                    restoreEpoch: approvalEpoch, revision: revoked ? 2 : state.binding.revision, status: revoked ? 'revoked' : 'active',
                    changedAt: state.binding.approvedAt, decisionReference: state.binding.approvalReference,
                    binding: revoked ? null : clone(state.binding) };
                const head = { schemaVersion: 1, recordType: 'dashboard_admin_approval_head', ...target,
                    restoreEpoch: approvalEpoch, revision: record.revision, status: record.status, recordSha256: hash(record) };
                const value = key === headKey(target) ? head : key === revisionKey(target, hash(record)) ? record : null;
                if (!value) throw Object.assign(new Error('synthetic absent'), { statusCode: 404, code: 'BlobNotFound' });
                const etag = '"' + hash(value) + '"';
                if (input.conditions && input.conditions.ifMatch !== etag) throw Object.assign(new Error('synthetic changed'), { statusCode: 412 });
                const bytes = Buffer.from(canonical(value));
                return { etag, contentLength: bytes.length, readableStreamBody: Readable.from([bytes]) };
            } }; } } });
        readApprovedBinding = jest.fn(reader.readApprovedBinding);
    }
    let nativeConfiguration;
    async function mockedNativeValidate(req, selected) {
        const capture = await nativeConfiguration.captureRequest(req);
        // Explicitly mocked native readiness, not an invented capture or actor.
        if (!state.gateReady || !capture?.operatorIssuanceProof || capture.kind !== 'operator_dashboard') throw denied();
        if (await nativeConfiguration.authoriseAdministration({ request: req, selector: selected, capture }) !== true) throw denied();
        captures.push(capture);
        if (state.validateHook) await state.validateHook({ request: req, selector: selected, capture });
        return { schemaVersion: 1, state: 'ready', purpose: 'operator_dashboard', capture };
    }
    const repository = { validateSession: jest.fn(mockedNativeValidate),
        readAuthoritySnapshot: jest.fn(async (req, selected) => { await mockedNativeValidate(req, selected); trace.push('snapshot');
            if (state.readHook) return state.readHook(req, selected); return { snapshot, revisions: dataCodec.revisionVector(snapshot), evaluatedAt: clock() }; }),
        persistAudit: jest.fn(async (req, envelope, selected, attempt) => { await mockedNativeValidate(req, selected); trace.push('persist:' + envelope.event.phase);
            if (state.persistHook) await state.persistHook({ request: req, envelope, selector: selected, attempt });
            nativeConfiguration.beforeQuery('COMMIT');
            ledger.set(envelope.event.eventId, projectAuditRow(envelope)); trace.push('ack:' + envelope.event.phase); return state.persistResult; }),
        reconcileAudit: jest.fn(async (req, envelope, selected, attempt) => { await mockedNativeValidate(req, selected); trace.push('reconcile:' + envelope.event.phase);
            if (state.reconcileHook) return state.reconcileHook({ request: req, envelope, selector: selected, attempt });
            if (!ledger.has(envelope.event.eventId)) throw ambiguous(); return true; }) };
    nativeFactory.mockImplementationOnce(config => { nativeConfiguration = config; return repository; });
    const runtimeInput = { ...sessionOptions, pool: { connect: jest.fn(() => { throw new Error('No SQL in adapter protocol tests'); }) },
        instanceId: INSTANCE, historyBudget: { maxRecords: 4096, maxBytes: 67108864, maxDurationMs: 60000 },
        newId: () => '30000000-0000-4000-8000-' + (++state.ids).toString().padStart(12, '0'), readApprovedBinding };
    const runtime = createDashboardAdminRuntime(runtimeInput);
    function serviceFor(req) {
        return createDashboardAdminService({ ...runtime,
            authoriseOperator: input => runtime.authoriseOperator({ ...input, request: req }),
            readAuthoritySnapshot: (scope, actor, selected) => runtime.readAuthoritySnapshot(scope, actor, selected, { request: req, selector: selected }),
            audit: (event, selected) => runtime.audit(event, { request: req, selector: selected }) });
    }
    function event(outcome = 'attempt', overrides = {}, selected = selector) {
        return { schemaVersion: 1, category: 'dashboard_admin_read', requestId: LOOKUP, actorSubjectKey: ACTOR,
            targetSha256: createHash('sha256').update(JSON.stringify(normaliseSelector(selected))).digest('hex'), outcome, occurredAt: clock(), ...overrides };
    }
    return { state, env, store, proofs, proofStore, browser, issuer, login, loginResult, request, selector, snapshot, runtime,
        runtimeInput, repository, readApprovedBinding, trace, ledger, captures, serviceFor, event, storeWrites,
        nativeValidate: mockedNativeValidate,
        get nativeConfiguration() { return nativeConfiguration; } };
}

beforeEach(() => nativeFactory.mockReset());

test('the concrete protected-store reader supports a genuine synthetic staff lookup through the runtime and audit protocol', async () => {
    const h = await harness({ approvalReader: true });
    const result = await h.serviceFor(h.request()).lookup(principal, h.selector);
    expect(result.result.status).toBe('found');
    expect(h.repository.readAuthoritySnapshot).toHaveBeenCalledTimes(1);
    expect(h.ledger.size).toBe(2);
    expect(h.readApprovedBinding.mock.calls.length).toBeGreaterThan(3);
    for (const spy of Object.values(h.storeWrites)) expect(spy).not.toHaveBeenCalled();
});

test.each(['missing', 'revoked', 'foreign target', 'old epoch'])('source-bound %s approval denies before snapshot or audit', async mode => {
    const h = await harness({ approvalReader: true });
    if (mode === 'missing') h.state.approvalMissing = true;
    if (mode === 'revoked') h.state.approvalRevoked = true;
    if (mode === 'foreign target') h.state.binding.selector.organisationId = 'synthetic-other-org';
    if (mode === 'old epoch') h.state.epoch = '10000000-0000-4000-8000-000000000099';
    await expect(h.serviceFor(h.request()).lookup(principal, h.selector)).rejects.toMatchObject({ statusCode: 403 });
    expect(h.repository.readAuthoritySnapshot).not.toHaveBeenCalled(); expect(h.ledger.size).toBe(0);
});

test('a source revocation observed after the attempt prevents the canonical snapshot', async () => {
    const h = await harness({ approvalReader: true });
    h.state.persistHook = async () => { h.state.approvalRevoked = true; };
    await expect(h.serviceFor(h.request()).lookup(principal, h.selector)).rejects.toMatchObject({ statusCode: 503 });
    expect(h.repository.readAuthoritySnapshot).not.toHaveBeenCalled();
});

test('a source revocation during the canonical read withholds the result', async () => {
    const h = await harness({ approvalReader: true });
    h.state.readHook = async () => {
        h.state.approvalRevoked = true;
        return { snapshot: h.snapshot, revisions: dataCodec.revisionVector(h.snapshot), evaluatedAt: h.runtime.clock() };
    };
    await expect(h.serviceFor(h.request()).lookup(principal, h.selector)).rejects.toMatchObject({ statusCode: 403 });
    expect(h.repository.readAuthoritySnapshot).toHaveBeenCalledTimes(1);
});

test('genuine callback proof and cookie feed native capture; shell admission is not wildcard target authority', async () => {
    const h = await harness(), req = h.request();
    expect(await h.runtime.authoriseOperator({ principal, selector: null, request: req })).toBe(true);
    expect(h.repository.validateSession).toHaveBeenCalledWith(req, null);
    expect(h.proofStore.createOriginalProof).toHaveBeenCalledTimes(1);
    expect(h.captures[0]).toMatchObject({ kind: 'operator_dashboard', instanceId: INSTANCE,
        identityPayload: { identityTenantId: TENANT, oid: OID }, operatorIssuanceProof: { kind: 'operator_dashboard_issuance' } });
    expect(h.proofs.has(h.captures[0].sessionSha256)).toBe(true);
    expect(await h.runtime.authoriseOperator({ principal, selector: { ...h.selector, provider: 'external' }, request: req })).toBe(false);
    expect(h.repository.readAuthoritySnapshot).not.toHaveBeenCalled();
    expect(Object.keys(h.runtime).sort()).toEqual(['audit', 'authoriseOperator', 'clock', 'readAuthoritySnapshot', 'requestBudgetMs']);
    expect(h.runtimeInput.pool.connect).not.toHaveBeenCalled();
});

test('production composition has no implicit approved-binding resolver', async () => {
    const h = await harness();
    expect(() => createDashboardAdminRuntime({ ...h.runtimeInput, readApprovedBinding: undefined }))
        .toThrow('dashboard_admin_unavailable');
});

test.each([
    ['absent', h => { h.state.binding = null; }],
    ['revoked', h => { h.state.binding.status = 'revoked'; }],
    ['expired', h => { h.state.binding.validUntil = new Date(NOW).toISOString(); }],
    ['not yet valid', h => { h.state.binding.validFrom = new Date(NOW + 1).toISOString(); }],
    ['approval after start', h => { h.state.binding.approvedAt = new Date(NOW).toISOString(); }],
    ['over one-hour window', h => { h.state.binding.validUntil = new Date(NOW + 3600000).toISOString(); }],
    ['wrong operator', h => { h.state.binding.operatorSubjectKey = TENANT + ':' + OTHER; }],
    ['wrong instance', h => { h.state.binding.instanceId = EPOCH; }],
    ['wrong provider', h => { h.state.binding.selector.provider = 'external'; }],
    ['wrong subject', h => { h.state.binding.selector.subjectKey = TENANT + ':' + OTHER; }],
    ['wrong tenant', h => { h.state.binding.selector.tenantId = 'another-tenant'; }],
    ['wrong organisation', h => { h.state.binding.selector.organisationId = 'another-organisation'; }],
    ['wrong purpose', h => { h.state.binding.purpose = 'account_reset'; }],
    ['wrong action', h => { h.state.binding.action = 'dashboard.authority.write'; }],
    ['wrong identity policy', h => { h.state.binding.identityPolicy.policyId = 'different-policy'; }],
    ['revised identity policy', h => { h.state.binding.identityPolicy.policyRevision++; }],
    ['missing retention policy', h => { delete h.state.binding.auditPolicy; }],
    ['legacy day count', h => { h.state.binding.auditPolicy.retentionDays = 395; }],
    ['wrong agreement version', h => { h.state.binding.auditPolicy.agreementVersion = 'nf-dashboard-2026-09-r1'; }],
    ['day unit', h => { h.state.binding.auditPolicy.retention.unit = 'days'; }],
    ['wrong calendar month count', h => { h.state.binding.auditPolicy.retention.count = 12; }],
    ['unverified extra retention field', h => { h.state.binding.auditPolicy.retention.days = 395; }],
    ['negative policy revision', h => { h.state.binding.auditPolicy.revision = -1; }]
])('approved binding fails closed for %s before target reads or audit writes', async (_name, change) => {
    const h = await harness(); change(h);
    expect(await h.runtime.authoriseOperator({ principal, selector: h.selector, request: h.request() })).toBe(false);
    expect(h.repository.readAuthoritySnapshot).not.toHaveBeenCalled(); expect(h.repository.persistAudit).not.toHaveBeenCalled();
});

test.each(['revision', 'auditPolicy', 'approvalReference'])('a pinned approved binding cannot be replaced through %s', async key => {
    const h = await harness(), req = h.request();
    expect(await h.runtime.authoriseOperator({ principal, selector: h.selector, request: req })).toBe(true);
    if (key === 'revision') h.state.binding.revision++;
    if (key === 'auditPolicy') h.state.binding.auditPolicy.revision++;
    if (key === 'approvalReference') h.state.binding.approvalReference = 'another-approval';
    expect(await h.runtime.authoriseOperator({ principal, selector: h.selector, request: req })).toBe(false);
    expect(h.repository.readAuthoritySnapshot).not.toHaveBeenCalled();
});

test.each(['plain request', 'missing cookie', 'customer cookie', 'proofless parent', 'missing proof', 'wrong proof', 'wrong principal', 'revoked gate'])
('private ports require genuine original staff session: %s', async mode => {
    const h = await harness({ withProof: mode !== 'proofless parent' }); let req = h.request(), user = principal;
    if (mode === 'plain request') req = { headers: { cookie: cookie(h.loginResult) } };
    if (mode === 'missing cookie') req = h.request('');
    if (mode === 'customer cookie') req = h.request(cookie(h.loginResult).replace('__Host-nofries-auth', '__Host-nofries-customer'));
    if (mode === 'missing proof') h.proofs.clear();
    if (mode === 'wrong proof') [...h.proofs.values()][0].identitySha256 = 'f'.repeat(64);
    if (mode === 'wrong principal') user = { ...principal, subjectKey: TENANT + ':' + OTHER };
    if (mode === 'revoked gate') h.state.gateReady = false;
    expect(await h.runtime.authoriseOperator({ principal: user, selector: h.selector, request: req })).toBe(false);
    expect(h.repository.readAuthoritySnapshot).not.toHaveBeenCalled(); expect(h.repository.persistAudit).not.toHaveBeenCalled();
});

test('complete service lookup acknowledges attempt, reads once and durably pairs a minimised terminal envelope', async () => {
    const h = await harness(), req = h.request(), result = await h.serviceFor(req).lookup(principal, h.selector);
    expect(result.result.status).toBe('found'); expect(h.repository.readAuthoritySnapshot).toHaveBeenCalledTimes(1);
    expect(h.trace.filter(x => /^(ack|snapshot)/.test(x))).toEqual(['ack:attempt', 'snapshot', 'ack:terminal']);
    const [attempt, terminal] = h.repository.persistAudit.mock.calls.map(args => args[1]);
    expect(verifyAuditPhasePair(attempt, terminal)).toEqual({ attempt, terminal });
    expect(terminal.event).toMatchObject({ phase: 'terminal', outcome: 'found', actorSubjectKey: ACTOR });
    expect(h.repository.persistAudit.mock.calls[1][3]).toEqual(attempt);
    expect(h.ledger.size).toBe(2);
    const disclosed = JSON.stringify(result), retained = JSON.stringify([...h.ledger.values()]);
    for (const sensitive of [cookie(h.loginResult), 'synthetic-test-only-secret', 'synthetic-unpersisted-token',
        'operatorIssuanceProof', 'sessionSha256', 'restoreEpoch', 'synthetic-private-approval', 'synthetic-private-retention-policy']) {
        expect(disclosed).not.toContain(sensitive);
    }
    expect(retained).not.toContain(TARGET_SUBJECT); expect(retained).not.toContain('synthetic-unpersisted');
});

test('snapshot cannot start before acknowledged attempt, and failed audit prevents any service snapshot', async () => {
    const h = await harness(), req = h.request();
    await h.runtime.authoriseOperator({ principal, selector: h.selector, request: req });
    await expect(h.runtime.readAuthoritySnapshot({ tenantId: h.selector.tenantId, organisationId: h.selector.organisationId }, { authenticated: true, subjectKey: ACTOR }, h.selector,
        { request: req, selector: h.selector })).rejects.toMatchObject({ statusCode: 403 });
    expect(h.repository.readAuthoritySnapshot).not.toHaveBeenCalled();
    h.state.persistHook = async () => { throw new Error('private-writer-detail'); };
    await expect(h.serviceFor(h.request()).lookup(principal, h.selector)).rejects.toMatchObject({ statusCode: 503, message: 'dashboard_admin_unavailable' });
    expect(h.repository.readAuthoritySnapshot).not.toHaveBeenCalled();
});

test('a pending attempt acknowledgement holds the snapshot until it settles', async () => {
    const h = await harness(), waiting = deferred(), entered = deferred();
    h.state.persistHook = async ({ envelope }) => { if (envelope.event.phase === 'attempt') { entered.resolve(); await waiting.promise; } };
    const lookup = h.serviceFor(h.request()).lookup(principal, h.selector); await entered.promise;
    expect(h.repository.readAuthoritySnapshot).not.toHaveBeenCalled(); waiting.resolve();
    expect((await lookup).result.status).toBe('found'); expect(h.repository.readAuthoritySnapshot).toHaveBeenCalledTimes(1);
});

test('duplicate identical phases acknowledge once; changed phase, actor or terminal pair never adds an audit row', async () => {
    const h = await harness(), req = h.request(), context = { request: req, selector: h.selector };
    await h.runtime.authoriseOperator({ principal, selector: h.selector, request: req });
    const attempt = h.event(); await expect(h.runtime.audit(attempt, context)).resolves.toBe(true);
    await expect(h.runtime.audit(clone(attempt), context)).resolves.toBe(true);
    expect(h.repository.persistAudit).toHaveBeenCalledTimes(1);
    await h.runtime.audit(h.event('found'), context); await h.runtime.audit(h.event('found'), context);
    expect(h.repository.persistAudit).toHaveBeenCalledTimes(2);
    await expect(h.runtime.audit(h.event('not_found'), context)).rejects.toBeDefined();
    expect(h.repository.persistAudit).toHaveBeenCalledTimes(2);
    const foreign = h.request(); await h.runtime.authoriseOperator({ principal, selector: h.selector, request: foreign });
    await expect(h.runtime.audit(h.event('found'), { request: foreign, selector: h.selector })).rejects.toBeDefined();
    expect(h.repository.persistAudit).toHaveBeenCalledTimes(2);
});

test.each(['attempt', 'terminal'])('ambiguous %s COMMIT reconciles exactly once without reinsert or snapshot redo', async phase => {
    const h = await harness();
    h.state.persistHook = async ({ envelope }) => {
        if (envelope.event.phase === phase) { h.ledger.set(envelope.event.eventId, projectAuditRow(envelope)); throw ambiguous(); }
    };
    expect((await h.serviceFor(h.request()).lookup(principal, h.selector)).result.status).toBe('found');
    expect(h.repository.persistAudit).toHaveBeenCalledTimes(2); expect(h.repository.reconcileAudit).toHaveBeenCalledTimes(1);
    expect(h.repository.reconcileAudit.mock.calls[0][1].event.phase).toBe(phase);
    expect(h.repository.readAuthoritySnapshot).toHaveBeenCalledTimes(1); expect(h.ledger.size).toBe(2);
});

test.each(['absent', 'conflicting', 'revoked'])('failed ambiguous terminal readback %s withholds the result without replay', async mode => {
    const h = await harness();
    h.state.persistHook = async ({ envelope }) => { if (envelope.event.phase === 'terminal') throw ambiguous(); };
    h.state.reconcileHook = async () => { if (mode === 'revoked') { h.state.gateReady = false; return true; } throw new Error('private readback ' + mode); };
    await expect(h.serviceFor(h.request()).lookup(principal, h.selector)).rejects.toMatchObject({ statusCode: 503, message: 'dashboard_admin_unavailable' });
    expect(h.repository.persistAudit).toHaveBeenCalledTimes(2); expect(h.repository.reconcileAudit).toHaveBeenCalledTimes(1);
    expect(h.repository.readAuthoritySnapshot).toHaveBeenCalledTimes(1);
});

test.each(['expired binding', 'revised binding', 'revoked gate', 'revoked parent', 'restore epoch', 'aborted request'])
('revocation during snapshot await withholds account data: %s', async mode => {
    const h = await harness(), req = h.request(), entered = deferred(), resume = deferred();
    h.state.readHook = async () => { entered.resolve(); await resume.promise; return { snapshot: h.snapshot,
        revisions: dataCodec.revisionVector(h.snapshot), evaluatedAt: new Date(h.state.now).toISOString() }; };
    const lookup = h.serviceFor(req).lookup(principal, h.selector); const outcome = lookup.catch(error => error); await entered.promise;
    if (mode === 'expired binding') h.state.now = Date.parse(h.state.binding.validUntil);
    if (mode === 'revised binding') h.state.binding.revision++;
    if (mode === 'revoked gate') h.state.gateReady = false;
    if (mode === 'revoked parent') h.store.sessions.clear();
    if (mode === 'restore epoch') h.state.epoch = BINDING;
    if (mode === 'aborted request') req.aborted = true;
    resume.resolve(); const error = await outcome;
    expect([403, 503]).toContain(error.statusCode);
    expect(['dashboard_admin_access_denied', 'dashboard_admin_unavailable']).toContain(error.message);
    expect(error).not.toHaveProperty('result');
    expect(h.repository.readAuthoritySnapshot).toHaveBeenCalledTimes(1);
    expect(h.repository.persistAudit).toHaveBeenCalledTimes(1);
});

test('interleaved genuine native requests retain separate capture, audit IDs and attempt acknowledgements', async () => {
    const h = await harness(), a = h.request(), b = h.request(), entered = deferred(), release = deferred();
    h.state.persistHook = async ({ request, envelope }) => {
        if (request === a && envelope.event.phase === 'attempt') { entered.resolve(); await release.promise; }
    };
    const first = h.serviceFor(a).lookup(principal, h.selector); await entered.promise;
    const second = await h.serviceFor(b).lookup(principal, h.selector);
    expect(second.result.status).toBe('found'); expect(h.repository.readAuthoritySnapshot).toHaveBeenCalledTimes(1);
    expect(h.repository.readAuthoritySnapshot.mock.calls[0][0]).toBe(b);
    release.resolve(); expect((await first).result.status).toBe('found');
    const attempts = h.repository.persistAudit.mock.calls.filter(args => args[1].event.phase === 'attempt');
    expect(new Set(attempts.map(args => args[1].event.requestId)).size).toBe(2);
    expect(new Set(attempts.map(args => args[1].event.lookupRequestId)).size).toBe(2);
    expect(new Set(attempts.map(args => args[1].sessionSha256)).size).toBe(1);
    expect(h.repository.readAuthoritySnapshot).toHaveBeenCalledTimes(2); expect(h.ledger.size).toBe(4);
});

test.each([false, undefined, 'true', 1])('native attempt acknowledgement must be literal true: %p', async value => {
    const h = await harness(); h.state.persistResult = value;
    await expect(h.serviceFor(h.request()).lookup(principal, h.selector)).rejects.toMatchObject({ statusCode: 503 });
    expect(h.repository.persistAudit).toHaveBeenCalledTimes(1); expect(h.repository.reconcileAudit).not.toHaveBeenCalled();
    expect(h.repository.readAuthoritySnapshot).not.toHaveBeenCalled();
});

test('the native beforeQuery guard refuses calls outside its private invocation and stops expiry immediately before COMMIT', async () => {
    const h = await harness(); expect(() => h.nativeConfiguration.beforeQuery('SELECT')).toThrow('dashboard_admin_unavailable');
    h.state.binding.validUntil = new Date(NOW + 500).toISOString();
    h.state.persistHook = async () => { h.state.now = Date.parse(h.state.binding.validUntil); };
    await expect(h.serviceFor(h.request()).lookup(principal, h.selector)).rejects.toMatchObject({ statusCode: 503 });
    expect(h.repository.readAuthoritySnapshot).not.toHaveBeenCalled(); expect(h.ledger.size).toBe(0);
    expect(h.trace).not.toContain('ack:attempt');
});

test('private read/audit ports refuse request-shaped objects and foreign selector context before native disclosure', async () => {
    const h = await harness(), req = h.request(), scope = { tenantId: h.selector.tenantId, organisationId: h.selector.organisationId };
    const fake = { headers: req.headers };
    await expect(h.runtime.audit(h.event(), { request: fake, selector: h.selector })).rejects.toMatchObject({ statusCode: 403 });
    await expect(h.runtime.readAuthoritySnapshot(scope, { authenticated: true, subjectKey: ACTOR }, h.selector,
        { request: fake, selector: h.selector })).rejects.toMatchObject({ statusCode: 403 });
    await h.runtime.authoriseOperator({ principal, selector: h.selector, request: req });
    await h.runtime.audit(h.event(), { request: req, selector: h.selector });
    await expect(h.runtime.readAuthoritySnapshot(scope, { authenticated: true, subjectKey: ACTOR }, h.selector,
        { request: req, selector: { ...h.selector, provider: 'external' } })).rejects.toMatchObject({ statusCode: 403 });
    expect(h.repository.readAuthoritySnapshot).not.toHaveBeenCalled();
});

test('parallel snapshot port calls for one acknowledged native lookup cannot duplicate the target read', async () => {
    const h = await harness(), req = h.request(), context = { request: req, selector: h.selector };
    await h.runtime.authoriseOperator({ principal, selector: h.selector, request: req }); await h.runtime.audit(h.event(), context);
    const barrier = deferred(), entered = deferred();
    h.state.validateHook = async () => { entered.resolve(); await barrier.promise; };
    const args = [{ tenantId: h.selector.tenantId, organisationId: h.selector.organisationId }, { authenticated: true, subjectKey: ACTOR }, h.selector, context];
    const first = h.runtime.readAuthoritySnapshot(...args), second = h.runtime.readAuthoritySnapshot(...args);
    const settled = Promise.allSettled([first, second]); await entered.promise; await pause(); barrier.resolve(); await settled;
    expect(h.repository.readAuthoritySnapshot).toHaveBeenCalledTimes(1);
});

test.each(['occurredAt', 'targetSha256', 'requestId', 'actorSubjectKey'])('an acknowledged attempt is immutable across changed %s', async key => {
    const h = await harness(), req = h.request(), context = { request: req, selector: h.selector }, first = h.event();
    await h.runtime.authoriseOperator({ principal, selector: h.selector, request: req }); await h.runtime.audit(first, context);
    const changed = { ...first, [key]: key === 'occurredAt' ? new Date(NOW + 1).toISOString() :
        key === 'targetSha256' ? 'f'.repeat(64) : key === 'requestId' ? INSTANCE : TENANT + ':' + OTHER };
    await expect(h.runtime.audit(changed, context)).rejects.toBeDefined();
    expect(h.repository.persistAudit).toHaveBeenCalledTimes(1); expect(h.repository.readAuthoritySnapshot).not.toHaveBeenCalled();
});

test.each([false, undefined, 'true'])('ambiguous reconciliation requires literal true acknowledgement: %p', async value => {
    const h = await harness();
    h.state.persistHook = async ({ envelope }) => { if (envelope.event.phase === 'attempt') throw ambiguous(); };
    h.state.reconcileHook = async () => value;
    await expect(h.serviceFor(h.request()).lookup(principal, h.selector)).rejects.toMatchObject({ statusCode: 503 });
    expect(h.repository.persistAudit).toHaveBeenCalledTimes(1); expect(h.repository.reconcileAudit).toHaveBeenCalledTimes(1);
    expect(h.repository.readAuthoritySnapshot).not.toHaveBeenCalled();
});

test.each(['expired', 'invalid'])('genuine %s parent during ambiguous readback denies without cleanup or other backing-store writes', async kind => {
    const h = await harness(), req = h.request(), entered = deferred(), resume = deferred();
    const parentId = cookie(h.loginResult).split('=')[1], parent = h.store.sessions.get(parentId);
    const retainedProofs = JSON.stringify([...h.proofs.entries()]), proofWrites = h.proofStore.createOriginalProof.mock.calls.length;
    h.state.persistHook = async ({ envelope }) => {
        if (envelope.event.phase === 'terminal') {
            // Mock a committed terminal row with lost acknowledgement. The
            // reconciliation path itself must perform no insertion or cleanup.
            h.ledger.set(envelope.event.eventId, projectAuditRow(envelope)); throw ambiguous();
        }
    };
    h.state.reconcileHook = async ({ request, selector }) => {
        entered.resolve(); await resume.promise;
        // Re-run the genuine configured capture and literal-true policy after
        // the await, representing the native readback's current-session fence.
        await h.nativeValidate(request, selector); return true;
    };
    const outcome = h.serviceFor(req).lookup(principal, h.selector).catch(error => error);
    await entered.promise;
    const auditRowsBefore = JSON.stringify([...h.ledger.entries()]);
    const snapshotsBefore = h.repository.readAuthoritySnapshot.mock.calls.length;
    if (kind === 'expired') { parent.idleExpiresAt = NOW + 5; h.state.now = NOW + 10; }
    else parent.identity.subjectKey = TENANT + ':' + OTHER;
    resume.resolve();
    expect(await outcome).toMatchObject({ statusCode: 503, message: 'dashboard_admin_unavailable' });
    expect(h.repository.reconcileAudit).toHaveBeenCalledTimes(1);
    expect(h.repository.persistAudit).toHaveBeenCalledTimes(2);
    expect(snapshotsBefore).toBe(1); expect(h.repository.readAuthoritySnapshot).toHaveBeenCalledTimes(1);
    expect(JSON.stringify([...h.ledger.entries()])).toBe(auditRowsBefore);
    for (const mutation of Object.values(h.storeWrites)) expect(mutation).not.toHaveBeenCalled();
    expect(h.proofStore.createOriginalProof).toHaveBeenCalledTimes(proofWrites);
    expect(JSON.stringify([...h.proofs.entries()])).toBe(retainedProofs);
    expect(h.store.sessions.has(parentId)).toBe(true);
    expect(h.runtimeInput.pool.connect).not.toHaveBeenCalled();
});

test.each(['expired', 'invalid'])('initial shell denial for a genuine %s parent performs zero backing-store cleanup writes', async kind => {
    const h = await harness(), req = h.request(), parentId = cookie(h.loginResult).split('=')[1];
    const parent = h.store.sessions.get(parentId), retainedProofs = JSON.stringify([...h.proofs.entries()]);
    const proofWrites = h.proofStore.createOriginalProof.mock.calls.length;
    if (kind === 'expired') { parent.idleExpiresAt = NOW + 5; h.state.now = NOW + 10; }
    else parent.identity.subjectKey = TENANT + ':' + OTHER;
    expect(await h.runtime.authoriseOperator({ principal, selector: null, request: req })).toBe(false);
    for (const mutation of Object.values(h.storeWrites)) expect(mutation).not.toHaveBeenCalled();
    expect(h.proofStore.createOriginalProof).toHaveBeenCalledTimes(proofWrites);
    expect(JSON.stringify([...h.proofs.entries()])).toBe(retainedProofs);
    expect(h.store.sessions.has(parentId)).toBe(true);
    expect(h.repository.persistAudit).not.toHaveBeenCalled(); expect(h.repository.reconcileAudit).not.toHaveBeenCalled();
    expect(h.repository.readAuthoritySnapshot).not.toHaveBeenCalled(); expect(h.runtimeInput.pool.connect).not.toHaveBeenCalled();
});
