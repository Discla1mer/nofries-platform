'use strict';

// Genuine synthetic staff callback/issuance, native repository, transaction
// wrapper and listing writer. Only the SQL transport is an in-memory fixture;
// these tests do not prove PostgreSQL RLS, constraints, locks or live durability.
const { IncomingMessage } = require('node:http');
const { Socket } = require('node:net');
const { createBrowserAuthService } = require('../../api/shared/browserAuth');
const { MemoryBrowserSessionStore } = require('../../api/shared/browserSessionStore');
const { createDashboardOperatorSession } = require('../../api/shared/dashboardOperatorSession');
const { createDashboardAdminSignupRuntime } = require('../../api/shared/dashboardAdmin/signupAuditRuntimeAdapter');
const { createFiniteSignupPageReader } = require('../../api/shared/dashboardAdmin/finiteSignupIndex');
const { hash, projectCurrentRow } = require('../../api/shared/appLifecycle/dashboardRuntimeRecords');
const { fixture, clone } = require('./dashboardAdminSignupData');

const uid = n => '74000000-0000-4000-8000-' + String(n).padStart(12, '0');
const TENANT = uid(1), CLIENT = uid(2), OID = uid(3), INSTANCE = uid(4), EPOCH = uid(5);
const SUBJECT = TENANT + ':' + OID;
const principal = { provider: 'entra-bff', isAuthenticated: true, subjectKey: SUBJECT };
const deferred = () => { let resolve; return { promise: new Promise(r => { resolve = r; }), resolve: value => resolve(value) }; };

async function runtimeFixture({ provider = 'legacy', version = 1, twoTenants = false,
    role = 'admin', requestBudgetMs = 10000, withProof = true } = {}) {
    const data = [await fixture(provider)];
    if (twoTenants) data.push(await fixture(provider, { seed: 100 }));
    const state = { now: data[0].clock(), epoch: EPOCH, bytes: 1, requestSerial: 100, idSerial: 200,
        trace: [], audit: [], before: null, after: null, loseCommit: false, authorityHook: null, sourceHook: null };
    const env = { NOFRIES_REQUIRE_AUTH: 'true', NOFRIES_PUBLIC_URL: 'https://native-signups.invalid',
        NOFRIES_ENTRA_TENANT_ID: TENANT, NOFRIES_ENTRA_CLIENT_ID: CLIENT,
        NOFRIES_ENTRA_CLIENT_SECRET: 'synthetic-native-signup-secret', NOFRIES_ALLOWED_SUBJECTS: SUBJECT,
        NOFRIES_ADMIN_SUBJECTS: role === 'admin' ? SUBJECT : '' };
    const store = new MemoryBrowserSessionStore(), proofs = new Map();
    const proofStore = { createOriginalProof: jest.fn(async (key, value) => {
        if (proofs.has(key)) throw new Error('synthetic proof collision'); proofs.set(key, clone(value));
    }), readOriginalProof: jest.fn(async key => proofs.has(key) ? clone(proofs.get(key)) : null) };
    const clientApplication = { getAuthCodeUrl: jest.fn(async args => {
        const url = new URL('https://login.microsoftonline.com/' + TENANT + '/oauth2/v2.0/authorize');
        for (const [key, value] of Object.entries({ client_id: CLIENT, redirect_uri: args.redirectUri,
            response_mode: 'form_post', state: args.state, nonce: args.nonce,
            code_challenge: args.codeChallenge, code_challenge_method: 'S256' })) url.searchParams.set(key, value);
        return url.href;
    }), acquireTokenByCode: jest.fn(async args => ({ idTokenClaims: { aud: CLIENT, tid: TENANT, oid: OID,
        iss: 'https://login.microsoftonline.com/' + TENANT + '/v2.0', nonce: args.nonce,
        exp: Math.floor(Date.parse(state.now) / 1000) + 3600, name: 'Synthetic operator', preferred_username: 'synthetic-native@example.invalid' },
        account: { localAccountId: OID, tenantId: TENANT }, accessToken: 'synthetic-unpersisted-access', idToken: 'synthetic-unpersisted-id' })),
    getTokenCache: () => ({ removeAccount: async () => {} }) };
    const browserAuthOptions = { env, store, clientApplication,
        cryptoProvider: { generatePkceCodes: async () => ({ verifier: 'v'.repeat(64), challenge: 'c'.repeat(43) }) },
        randomBytes: size => Buffer.alloc(size, state.bytes++) };
    const identityPolicy = { policyId: 'synthetic-signup-native-policy', policyRevision: 1,
        issuer: 'https://login.microsoftonline.com/' + TENANT + '/v2.0', identityTenantId: TENANT, audience: CLIENT };
    const sessionOptions = { browserAuthOptions, identityPolicy, proofStore, clock: () => state.now,
        readExternalRuntimeEpoch: async () => ({ instanceId: INSTANCE, restoreEpoch: state.epoch }),
        newRequestId: () => uid(++state.requestSerial), requestBudgetMs };
    const issuer = createDashboardOperatorSession(sessionOptions);
    const browser = createBrowserAuthService({ ...browserAuthOptions, now: () => Date.parse(state.now) });
    const start = await browser.beginLogin({ returnTo: '/operator' });
    const callbackInput = { body: { code: 'synthetic-code', state: new URL(start.location).searchParams.get('state') },
        cookieHeader: start.cookie.split(';')[0] };
    const login = await (withProof ? issuer.callbackService : browser).completeLogin(callbackInput);
    const cookie = login.cookie.split(';')[0];
    const original = [...proofs.values()][0];
    const identity = { ...identityPolicy, oid: OID };
    state.instance = { schemaVersion: 1, instanceId: INSTANCE, revision: 1, restoreEpoch: EPOCH,
        ingressStatus: 'enabled', changedAt: state.now, evidenceRef: 'synthetic-native-only', evidenceSha256: 'a'.repeat(64) };
    state.gate = original ? { schemaVersion: 1, sessionSha256: original.sessionSha256, kind: 'operator_dashboard',
        parentSessionSha256: original.sessionSha256, operatorIssuanceSha256: hash(original), identitySha256: hash(identity),
        identityPayload: identity, subjectKey: SUBJECT, status: 'active', revision: 0, selectionGeneration: 0,
        generationToken: 'b'.repeat(64), selectedBindingId: null, selectedTenantId: null, selectedOrganisationId: null,
        discoveryCaseId: null, discoveryProofId: null, issuedAt: original.issuedAt, expiresAt: original.expiresAt,
        restoreEpoch: EPOCH, instanceId: INSTANCE, createdAt: original.issuedAt, updatedAt: original.issuedAt, revokedAt: null } : null;
    const pool = { end: jest.fn(), connect: jest.fn(async () => {
        let staged = null;
        return { release: jest.fn(), async query(sql, params = []) {
            state.trace.push({ sql, params: clone(params) });
            if (state.before) await state.before(sql, params);
            let result = { rows: [], rowCount: 0 };
            if (/^BEGIN/.test(sql)) staged = [];
            else if (sql === 'COMMIT') {
                state.audit.push(...staged); staged = null;
                if (state.loseCommit) { state.loseCommit = false; throw new Error('synthetic lost COMMIT acknowledgement'); }
            } else if (sql === 'ROLLBACK') staged = null;
            else if (/^(SET LOCAL |SELECT (set_config\(|pg_advisory_))/.test(sql)) { /* Existing fixed controls. */ }
            else if (sql.includes('FROM nofries.dashboard_runtime_instance')) result.rows = state.instance
                ? [projectCurrentRow('instance', clone(state.instance), { receiptId: uid(6) })] : [];
            else if (sql.includes('FROM nofries.dashboard_session_gates')) result.rows = state.gate
                ? [projectCurrentRow('session', clone(state.gate))] : [];
            else if (sql.includes('FROM nofries.dashboard_runtime_audit')) result.rows = [...state.audit, ...(staged || [])].filter(row =>
                row.event_type === 'dashboard.admin.signup_list' && row.instance_id === params[0] && row.session_sha256 === params[1] &&
                row.request_id === params[2] && row.payload.serviceEvent.requestId === params[3] && row.payload.serviceEvent.phase === params[4]).map(clone);
            else if (sql.startsWith('INSERT INTO nofries.dashboard_runtime_audit')) {
                const columns = sql.match(/\(([^)]+)\)/)[1].split(', ');
                staged.push(Object.fromEntries(columns.map((key, i) => [key,
                    ['scope_json', 'payload'].includes(key) ? JSON.parse(params[i]) : params[i]])));
                result.rowCount = 1;
            } else throw new Error('unexpected synthetic signup SQL: ' + sql);
            if (state.after) await state.after(sql, params, result);
            return result;
        } };
    }) };
    const manifest = { schemaVersion: version, provider,
        ...(version === 1 ? { tenantId: data[0].entry.binding.tenantId } : {}),
        populationId: 'synthetic-native-population', indexId: 'synthetic-native-index', entries: data.map(item => item.entry) };
    const grant = { schemaVersion: version, capability: 'signupList', operatorSubjectKey: SUBJECT, provider,
        ...(version === 1 ? { tenantId: manifest.tenantId } : { scope: { kind: 'finite_manifest', manifestSha256: hash(manifest) } }),
        populationId: manifest.populationId, indexId: manifest.indexId, authorityRevision: 1,
        issuedAt: new Date(Date.parse(state.now) - 1000).toISOString(), expiresAt: new Date(Date.parse(state.now) + 60000).toISOString(),
        maxPageSize: 1, maxRows: 4, maxPages: 4, fields: ['email', 'organisation', 'accountType', 'milestones'],
        auditPolicyId: 'synthetic-native-audit-policy' };
    state.grant = clone(grant);
    state.binding = { authoritySha256: hash(grant), manifestSha256: hash(manifest) };
    const resolvePopulationBinding = jest.fn(async () => clone(state.binding));
    const reader = createFiniteSignupPageReader({ manifest, clock: sessionOptions.clock, requestBudgetMs,
        resolvePopulationBinding,
        readEntrySummary: async (entry, context) => {
            if (state.sourceHook) await state.sourceHook(entry);
            const selected = data.find(item => item.entry.recordId === entry.recordId);
            if (!selected) throw new Error('synthetic source missing');
            return selected.read(entry, context);
        } });
    const readSignupPage = jest.fn(reader), readApprovedAuthority = jest.fn(async input => {
        if (state.authorityHook) await state.authorityHook(input);
        return clone(state.grant);
    });
    const runtimeInput = { ...sessionOptions, pool, instanceId: INSTANCE,
        historyBudget: { maxRecords: 4096, maxBytes: 67108864, maxDurationMs: 60000 },
        newId: () => uid(++state.idSerial), readApprovedAuthority, resolvePopulationBinding, readSignupPage };
    const runtime = createDashboardAdminSignupRuntime(runtimeInput);
    const storeWrites = Object.fromEntries(['createTransaction', 'consumeTransaction', 'deleteTransaction', 'createSession', 'deleteSession']
        .map(name => [name, jest.spyOn(store, name)]));
    const dashboard = { ...sessionOptions, pool, instanceId: INSTANCE, historyBudget: runtimeInput.historyBudget,
        newId: runtimeInput.newId, newGenerationToken: () => 'c'.repeat(64), newOperationId: () => uid(++state.idSerial) };
    const event = (phase = 'attempt', outcome = phase === 'attempt' ? 'requested' : 'available') => ({
        schemaVersion: 1, category: 'dashboard_admin_signup_list', requestId: uid(10), actorSubjectKey: SUBJECT,
        authoritySha256: hash(grant), requestSha256: hash({ cursor: null }), page: 1, phase, outcome,
        count: phase === 'attempt' || outcome !== 'available' ? 0 : 1, occurredAt: state.now });
    const request = (cookieValue = cookie) => {
        const req = new IncomingMessage(new Socket()); req.method = 'POST'; req.url = '/api/dashboard-admin/signups';
        req.headers = { cookie: cookieValue }; return req;
    };
    return { state, runtime, runtimeInput, dashboard, data, manifest, grant, event, request, cookie,
        env, store, storeWrites, proofs, proofStore, pool, readSignupPage, readApprovedAuthority, principal };
}

module.exports = { runtimeFixture, uid, SUBJECT, principal, deferred, clone };
