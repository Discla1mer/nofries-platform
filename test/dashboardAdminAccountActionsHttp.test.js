'use strict';

const { Readable } = require('node:stream');
const { createDashboardAdminHandlers } = require('../api/shared/dashboardAdmin/handlers');
const { createDashboardAdminAccountActionService } = require('../api/shared/dashboardAdmin/accountActionService');
const { readBrowserSessionDetails } = require('../api/shared/browserAuth');
const { MemoryBrowserSessionStore } = require('../api/shared/browserSessionStore');
const { hash } = require('../api/shared/appLifecycle/dashboardRuntimeRecords');
const { DashboardAdminError } = require('../api/shared/dashboardAdmin/service');

const uid = n => '73000000-0000-4000-8000-' + String(n).padStart(12, '0');
const TENANT = uid(1), ACTOR = uid(2), CLIENT = uid(3), SUBJECT = TENANT + ':' + ACTOR;
const TOKEN = Buffer.alloc(32, 73).toString('base64url'), COOKIE = '__Host-nofries-auth=' + TOKEN;
const NOW = '2026-10-28T05:00:00.000Z';
const SELECTOR = { provider: 'external', subjectKey: TENANT + ':' + uid(4), tenantId: 'synthetic-tenant', organisationId: 'synthetic-organisation' };

function wire(route, body, headers = {}, method = 'POST') {
    const request = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
    request.method = method; request.url = request.originalUrl = '/api/dashboard-admin/' + route;
    request.headers = { cookie: COOKIE, ...(method === 'POST' ? { 'content-type': 'application/json',
        origin: 'https://nofries.invalid', 'sec-fetch-site': 'same-origin' } : {}), ...headers };
    return request;
}
async function harness() {
    const env = { NOFRIES_REQUIRE_AUTH: 'true', NOFRIES_PUBLIC_URL: 'https://nofries.invalid', NOFRIES_ENTRA_TENANT_ID: TENANT,
        NOFRIES_ENTRA_CLIENT_ID: CLIENT, NOFRIES_ENTRA_CLIENT_SECRET: 'synthetic-only',
        NOFRIES_ALLOWED_SUBJECTS: SUBJECT, NOFRIES_ADMIN_SUBJECTS: SUBJECT };
    const store = new MemoryBrowserSessionStore();
    const record = { v: 1, kind: 'browser_session', issuedAt: Date.parse(NOW) - 60000,
        idleExpiresAt: Date.parse(NOW) + 60000, absoluteExpiresAt: Date.parse(NOW) + 600000,
        identity: { provider: 'entra-bff', isAuthenticated: true, tenantId: TENANT, principalId: ACTOR,
            subjectKey: SUBJECT, name: 'Synthetic staff', email: 'staff@example.invalid' } };
    await store.createSession(TOKEN, record);
    const state = { allowed: true, version: hash('initial'), displayLabel: null, writes: 0, revokedAfterCommit: false };
    const confirmations = new Map(), receipts = new Map();
    const ports = {
        authoriseOperator: jest.fn(async ({ selector }) => state.allowed && (selector === null || hash(selector) === hash(SELECTOR))),
        adapter: {
            inspect: jest.fn(async () => ({ selector: SELECTOR, version: state.version, displayName: 'Original organisation',
                displayLabel: state.displayLabel, membership: { membershipId: 'membership-one', status: 'active',
                    validFrom: '2026-10-01T00:00:00.000Z', validUntil: '2027-10-01T00:00:00.000Z' }, actions: ['edit'], witness: { synthetic: true } })),
            commit: jest.fn(async (command, context) => {
                await context.beforeCommit();
                if (command.expectedVersion !== state.version) throw new DashboardAdminError(409, 'dashboard_admin_conflict');
                state.displayLabel = command.patch.displayLabel; state.version = hash(command); state.writes++;
                const receipt = { operationId: command.operationId, commandSha256: command.commandSha256,
                    status: 'succeeded', version: state.version, occurredAt: NOW };
                receipts.set(command.operationId, receipt);
                if (state.revokedAfterCommit) await store.deleteSession(TOKEN);
                return receipt;
            }),
            outcome: jest.fn(async command => receipts.get(command.operationId) || null)
        }, confirmationStore: { create: async (key, value, beforeWrite) => { await beforeWrite(); confirmations.set(key, value); return true; },
            load: async key => confirmations.get(key) || null }, clock: () => NOW, requestBudgetMs: 1000
    };
    const service = createDashboardAdminAccountActionService(ports);
    const options = { accountActionService: service, env, requestBudgetMs: 1000,
        readOperatorSession: header => readBrowserSessionDetails(header, { env, store, now: () => Date.parse(NOW) }) };
    const handler = createDashboardAdminHandlers(options);
    const run = (route, body, headers, method) => handler.handle(wire(route, body, headers, method), route);
    return { env, store, state, ports, options, handler, run };
}
const prepare = h => h.run('actions/prepare', { selector: SELECTOR, action: 'edit', patch: { displayLabel: 'Support label' } });
function privateResult(result, status) {
    expect(result.status).toBe(status);
    expect(result.headers['Cache-Control']).toBe('private, no-store, max-age=0');
    expect(result.headers['X-Robots-Tag']).toBe('noindex, nofollow');
    expect(JSON.stringify(result.body)).not.toMatch(/synthetic-only|PRIVATE_PROVIDER_DETAIL/);
}

test('real BFF session, independent action capability, preview, commit and repeat receipt through actual service', async () => {
    const h = await harness();
    const caps = await h.run('capabilities', undefined, {}, 'GET');
    privateResult(caps, 200); expect(caps.body).toEqual({ lookup: false, recovery: [], accountActions: true });
    const found = await h.run('actions/inspect', SELECTOR); privateResult(found, 200); expect(found.body.witness).toBeUndefined();
    const preview = await prepare(h); privateResult(preview, 200); expect(h.state.writes).toBe(0);
    expect(preview.body.before.displayName).toBe('Original organisation');
    const token = { confirmationToken: preview.body.confirmationToken };
    const first = await h.run('actions/execute', token), repeat = await h.run('actions/execute', token);
    privateResult(first, 200); expect(repeat.body).toEqual(first.body); expect(h.state.writes).toBe(1);
    expect((await h.run('actions/outcome', token)).body).toEqual(first.body);
});
test.each(['', '__Host-nofries-customer=' + TOKEN, '__Host-nofries-external-customer=' + TOKEN])('rejects non-staff cookie %s before any action source', async cookie => {
    const h = await harness(); privateResult(await h.run('actions/inspect', SELECTOR, { cookie }), 401);
    expect(h.ports.authoriseOperator).not.toHaveBeenCalled(); expect(h.ports.adapter.inspect).not.toHaveBeenCalled();
});
test('valid staff read-only permission does not substitute for independent action authority', async () => {
    const h = await harness(); h.state.allowed = false;
    const service = { authorise: async () => true, capabilities: async () => ({ lookup: true, recovery: [] }), lookup: async () => ({}) };
    const handler = createDashboardAdminHandlers({ ...h.options, service });
    const response = await handler.handle(wire('actions/inspect', SELECTOR), 'actions/inspect');
    privateResult(response, 403); expect(h.ports.adapter.inspect).not.toHaveBeenCalled();
});
test.each(['actions/inspect', 'actions/prepare', 'actions/execute', 'actions/outcome'])('%s requires exact same-origin JSON POST', async route => {
    const h = await harness();
    privateResult(await h.run(route, {}, { origin: 'https://evil.invalid' }), 403);
    privateResult(await h.run(route, {}, { 'sec-fetch-site': 'cross-site' }), 403);
    privateResult(await h.run(route, {}, { 'content-type': 'text/plain' }), 415);
    privateResult(await h.run(route, undefined, {}, 'GET'), 405);
    expect(h.ports.adapter.commit).not.toHaveBeenCalled();
});
test('strict allowlist rejects identity, role and unrecognized request fields', async () => {
    const h = await harness();
    for (const field of ['email', 'roles', 'subjectKey', 'tenantId', 'displayName']) {
        privateResult(await h.run('actions/prepare', { selector: SELECTOR, action: 'edit', patch: { displayLabel: 'Label', [field]: 'forged' } }), 400);
    }
    privateResult(await h.run('actions/execute', { confirmationToken: TOKEN, actorSubjectKey: SUBJECT }), 400);
    expect(h.state.writes).toBe(0);
});
test('stale preparation returns conflict without source mutation', async () => {
    const h = await harness(), preview = await prepare(h); h.state.version = hash('changed');
    const response = await h.run('actions/execute', { confirmationToken: preview.body.confirmationToken });
    privateResult(response, 409); expect(response.body).toEqual({ code: 'dashboard_admin_conflict' }); expect(h.state.writes).toBe(0);
});
test('revocation after commit withholds result; durable outcome remains available after genuine reauthentication', async () => {
    const h = await harness(), preview = await prepare(h); h.state.revokedAfterCommit = true;
    const response = await h.run('actions/execute', { confirmationToken: preview.body.confirmationToken });
    privateResult(response, 401); expect(h.state.writes).toBe(1); expect(h.ports.adapter.commit).toHaveBeenCalledTimes(1);
});
test('unknown reset execution stays unavailable and no account action is inferred', async () => {
    const h = await harness();
    privateResult(await h.run('actions/prepare', { selector: SELECTOR, action: 'reset', patch: null }), 503);
    expect(h.state.writes).toBe(0);
});
