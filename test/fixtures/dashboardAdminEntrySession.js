'use strict';

// Genuine HTTP callback, original issuance proof and native session command.
// Only provider/store/SQL transports are synthetic. Gates, receipts and audits
// are produced by the real runtime; PostgreSQL RLS/locks remain separate tests.
const crypto = require('node:crypto');
const request = require('supertest');
const { createNoFriesApp } = require('../../server');
const { MemoryBrowserSessionStore } = require('../../api/shared/browserSessionStore');
const { projectCurrentRow } = require('../../api/shared/appLifecycle/dashboardRuntimeRecords');
const uid = n => '85000000-0000-4000-8000-' + String(n).padStart(12, '0');
const TENANT = uid(1), CLIENT = uid(2), OID = uid(3), INSTANCE = uid(4), EPOCH = uid(5);
const SUBJECT = TENANT + ':' + OID;
const NOW = Date.parse('2026-10-21T00:00:00.000Z');
const clone = value => JSON.parse(JSON.stringify(value));
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
let serial = 0;

function createEntrySql(state, { instanceId = INSTANCE, restoreEpoch = EPOCH, now = NOW } = {}) {
    state.clients ||= []; state.releases ||= [];
    const primary = { dashboard_runtime_instance: 'instance_id', dashboard_session_gates: 'session_sha256',
        dashboard_runtime_receipts: 'receipt_id', dashboard_runtime_audit: 'event_id' };
    state.tables = Object.fromEntries(Object.keys(primary).map(name => [name, []]));
    state.tables.dashboard_runtime_instance.push(projectCurrentRow('instance', {
        schemaVersion: 1, instanceId, revision: 1, restoreEpoch, ingressStatus: 'enabled',
        changedAt: new Date(now).toISOString(), evidenceRef: 'synthetic-test-only', evidenceSha256: digest('synthetic')
    }, { receiptId: uid(6) }));
    state.trace = [];
    const jsonColumns = new Set(['payload', 'identity_payload', 'scope_json']);
    const decode = (key, value) => jsonColumns.has(key) && typeof value === 'string' ? JSON.parse(value) : value;
    return { end: jest.fn(), connect: jest.fn(async () => {
        let tables = null;
        const release = jest.fn(() => { state.releases.push(state.trace.length); });
        state.clients.push({ release });
        return { release, async query(text, params = []) {
            const sql = typeof text === 'string' ? text : text.text;
            const event = { sql, params: clone(params) }; state.trace.push(event);
            if (state.beforeSql) await state.beforeSql(event);
            let rows = [];
            if (/^BEGIN(?: READ ONLY)?$/.test(sql)) tables = clone(state.tables);
            else if (sql === 'COMMIT') { state.tables = tables; tables = null; }
            else if (sql === 'ROLLBACK') tables = null;
            else if (/^SELECT octet_length/.test(sql)) rows = [{ payload_bytes: Buffer.byteLength(params[0]) }];
            else if (/^(SET LOCAL |SELECT (set_config\(|pg_advisory_))/.test(sql)) { /* fixed control statements */ }
            else {
                let match = sql.match(/^INSERT INTO nofries\.(\w+) \(([^)]+)\)\s+VALUES /);
                if (match) {
                    const [, table, names] = match;
                    if (!primary[table] || !tables) throw new Error('Unexpected controlled INSERT');
                    const row = Object.fromEntries(names.split(', ').map((key, i) => [key, decode(key, params[i])]));
                    if (tables[table].some(value => value[primary[table]] === row[primary[table]])) throw new Error('Synthetic duplicate key');
                    tables[table].push(row); rows = [clone(row)];
                } else if ((match = sql.match(/^UPDATE nofries\.(\w+) SET (.+) WHERE (\w+) = \$(\d+) RETURNING /))) {
                    const [, table, assignments, key, position] = match;
                    const row = tables[table].find(value => value[key] === params[Number(position) - 1]);
                    if (row) { for (const assignment of assignments.split(', ')) {
                        const [, column, index] = assignment.match(/^(\w+) = \$(\d+)$/);
                        row[column] = decode(column, params[Number(index) - 1]);
                    } rows = [clone(row)]; }
                } else if ((match = sql.match(/^SELECT .+ FROM nofries\.(\w+)\s+WHERE /))) {
                    const table = match[1]; if (!primary[table] || !tables) throw new Error('Unexpected controlled SELECT');
                    rows = tables[table].filter(row => [...sql.matchAll(/\b(\w+)\s*=\s*\$(\d+)\b/g)]
                        .every(([, column, position]) => row[column] === params[Number(position) - 1]));
                    if (table === 'dashboard_runtime_audit' && sql.includes("event_type='dashboard.admin.signup_list'")) {
                        rows = rows.filter(row => row.event_type === 'dashboard.admin.signup_list' &&
                            row.payload.serviceEvent.requestId === params[3] && row.payload.serviceEvent.phase === params[4]);
                    }
                    if (sql.includes('ORDER BY (CASE WHEN')) {
                        rows = rows.filter(row => { const receipt = row.payload, record = receipt.result.record;
                            const before = receipt.originalFacts.domainReceipt.originalFacts.predecessor;
                            return record.revision > (before ? before.revision : -1) && record.revision <= params[1] &&
                                (record.revision > params[2] || record.revision === params[2] && row.receipt_id > params[3]);
                        }).sort((a, b) => a.payload.result.record.revision - b.payload.result.record.revision || a.receipt_id.localeCompare(b.receipt_id)).slice(0, params[4]);
                    }
                    rows = clone(rows);
                } else throw new Error('Unexpected controlled SQL');
            }
            const result = { rows, rowCount: rows.length };
            if (state.afterSql) await state.afterSql(event, result);
            return result;
        } };
    }) };
}

function entrySessionFixture({ customer = true, externalCustomer = true, activation = false, appOptions = {} } = {}) {
    const state = { now: NOW, bytes: 1, sequence: 100, epoch: EPOCH, clients: [], releases: [] };
    const nextId = () => uid(++state.sequence);
    const env = { NOFRIES_REQUIRE_AUTH: 'true', NOFRIES_PUBLIC_URL: 'https://entry-session.invalid',
        NOFRIES_ENTRA_TENANT_ID: TENANT, NOFRIES_ENTRA_CLIENT_ID: CLIENT,
        NOFRIES_ENTRA_CLIENT_SECRET: 'synthetic-entry-staff-secret', NOFRIES_ALLOWED_SUBJECTS: SUBJECT,
        NOFRIES_ADMIN_SUBJECTS: SUBJECT, NOFRIES_CUSTOMER_ENTRA_CLIENT_ID: uid(7),
        NOFRIES_CUSTOMER_ENTRA_CLIENT_SECRET: 'synthetic-entry-customer-secret' };
    const store = new MemoryBrowserSessionStore(), proofs = new Map();
    const storeSpies = Object.fromEntries(['createTransaction', 'consumeTransaction', 'deleteTransaction', 'cancelTransaction',
        'createSession', 'loadSession', 'deleteSession'].map(name => [name, jest.spyOn(store, name)]));
    const proofStore = { createOriginalProof: jest.fn(async (key, value) => {
        if (proofs.has(key)) throw new Error('synthetic-entry-proof-collision'); proofs.set(key, clone(value));
    }), readOriginalProof: jest.fn(async key => proofs.has(key) ? clone(proofs.get(key)) : null) };
    const clientApplication = { getAuthCodeUrl: jest.fn(async input => {
        const url = new URL('https://login.microsoftonline.com/' + TENANT + '/oauth2/v2.0/authorize');
        for (const [key, value] of Object.entries({ client_id: CLIENT, redirect_uri: input.redirectUri,
            response_mode: 'form_post', state: input.state, nonce: input.nonce,
            code_challenge: input.codeChallenge, code_challenge_method: 'S256' })) url.searchParams.set(key, value);
        return url.href;
    }), acquireTokenByCode: jest.fn(async input => ({ idTokenClaims: { aud: CLIENT, tid: TENANT, oid: OID,
        iss: 'https://login.microsoftonline.com/' + TENANT + '/v2.0', nonce: input.nonce,
        exp: Math.floor(state.now / 1000) + 3600, name: 'Synthetic operator', preferred_username: 'entry@example.invalid' },
        account: { tenantId: TENANT, localAccountId: OID } })),
    getTokenCache: () => ({ removeAccount: async () => {} }) };
    const pool = createEntrySql(state), readExternalRuntimeEpoch = jest.fn(async () => ({ instanceId: INSTANCE, restoreEpoch: state.epoch }));
    const dashboard = { browserAuthOptions: { env, store, clientApplication,
        cryptoProvider: { generatePkceCodes: async () => ({ verifier: 'v'.repeat(64), challenge: 'c'.repeat(43) }) },
        randomBytes: size => Buffer.alloc(size, state.bytes++) },
    identityPolicy: { policyId: 'synthetic-entry-policy', policyRevision: 1,
        issuer: 'https://login.microsoftonline.com/' + TENANT + '/v2.0', identityTenantId: TENANT, audience: CLIENT },
    proofStore, clock: () => new Date(state.now).toISOString(), readExternalRuntimeEpoch,
    newRequestId: jest.fn(nextId), requestBudgetMs: 10000, pool, instanceId: INSTANCE,
    historyBudget: { maxRecords: 4096, maxBytes: 67108864, maxDurationMs: 60000 },
    newId: jest.fn(nextId), newOperationId: jest.fn(nextId), newGenerationToken: jest.fn(() => digest(nextId())) };
    const policy = () => ({ begin: jest.fn(async () => { throw new Error('synthetic-customer-not-requested'); }),
        verify: jest.fn(async () => { throw new Error('synthetic-customer-not-requested'); }), recheck: jest.fn(async () => {}) });
    const customerSpies = { legacy: { policy: policy(), resolveActivationBinding: jest.fn(async () => { throw new Error('synthetic-no-customer-binding'); }) },
        external: { policy: policy(), resolveActivationBinding: jest.fn(async () => { throw new Error('synthetic-no-customer-binding'); }) },
        activation: { read: jest.fn(async () => { throw new Error('synthetic-no-activation'); }), writeCompletion: jest.fn() } };
    if (customer) dashboard.customer = customerSpies.legacy;
    if (externalCustomer) {
        const tenant = uid(8), client = uid(9), issuer = 'https://' + tenant + '.ciamlogin.com/' + tenant + '/v2.0';
        dashboard.externalCustomer = { ...customerSpies.external,
            identityProvider: { kind: 'external-id', tenantId: tenant, clientId: client,
                authority: 'https://synthetic-entry.ciamlogin.com/', issuer,
                authorizationEndpoint: 'https://synthetic-entry.ciamlogin.com/' + tenant + '/oauth2/v2.0/authorize' },
            identityPolicy: { policyId: 'synthetic-entry-external-policy', policyRevision: 1, issuer, identityTenantId: tenant, audience: client },
            client: { clientSecret: 'synthetic-entry-external-secret', clientApplication } };
    }
    if (activation) dashboard.activation = customerSpies.activation;
    let app = createNoFriesApp({ dashboard, ...appOptions });
    const localSerial = ++serial, ip = '198.19.' + Math.floor(localSerial / 250) + '.' + (localSerial % 250 + 1);
    const send = (method, path, target = app) => request(target)[method](path).set('X-Forwarded-For', ip);
    async function login(target = app) {
        const started = await send('get', '/api/auth/login?returnTo=%2Foperator', target);
        expect(started.status).toBe(302);
        const transaction = started.headers['set-cookie'][0].split(';')[0];
        const callback = await send('post', '/api/auth/callback', target).set('Cookie', transaction).type('form')
            .send({ state: new URL(started.headers.location).searchParams.get('state'), code: 'synthetic-entry-code' });
        expect(callback.status).toBe(303);
        const cookie = callback.headers['set-cookie'].find(value => value.startsWith('__Host-nofries-auth=')).split(';')[0];
        return { cookie, callback, transaction };
    }
    function resetObservations() {
        state.trace.length = 0;
        for (const spy of [...Object.values(storeSpies), ...Object.values(proofStore), readExternalRuntimeEpoch,
            dashboard.newRequestId, dashboard.newId, dashboard.newOperationId, dashboard.newGenerationToken, pool.connect,
            ...Object.values(customerSpies.legacy.policy), customerSpies.legacy.resolveActivationBinding,
            ...Object.values(customerSpies.external.policy), customerSpies.external.resolveActivationBinding,
            ...Object.values(customerSpies.activation)]) spy.mockClear();
    }
    function rebuild(configuration = {}) { app = createNoFriesApp({ dashboard, ...configuration }); return app; }
    return { state, dashboard, env, store, storeSpies, proofs, proofStore, pool, readExternalRuntimeEpoch,
        customerSpies, nextId, send, login, resetObservations, rebuild, get app() { return app; } };
}
module.exports = { entrySessionFixture, createEntrySql, uid, TENANT, CLIENT, OID, SUBJECT, INSTANCE, EPOCH, NOW, clone };
