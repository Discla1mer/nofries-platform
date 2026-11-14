'use strict';
const { Readable } = require('node:stream');
const { createAccountListReader, MAX_ACCOUNTS } = require('../api/shared/dashboardAdmin/accountListStore');
const { createDashboardAdminHandlers } = require('../api/shared/dashboardAdmin/handlers');
const { starterAccountKey, starterAccountRecord } = require('../api/shared/customerSignup/starterAccountAllocation');
const { approvedStarterPlan, accountWindow } = require('../api/shared/customerSignup/customerStarterPlan');
const { subjectHash } = require('../api/shared/customerSignup/customerAuthority');

const uid = n => '20000000-0000-4000-8000-' + String(n).padStart(12, '0');
const TENANT = uid(1), STAFF = uid(1) + ':' + uid(2), NOW = Date.parse('2026-11-14T03:00:00.000Z');
const source = { schemaVersion: 1, kind: 'external_starter', storageAccount: 'syntheticstore', container: 'synthetic-external',
    providerKind: 'external-id', providerTenantId: TENANT, providerConfigurationSha256: '1'.repeat(64) };
const SLOT_IDS = ['tenantId', 'organisationId', 'grantId', 'scheduleId', 'activationId', 'bootstrapOperationId', 'acceptOperationId',
    'publicationOperationId', 'bindingId', 'authorityId', 'membershipId', 'admissionOperationId'];

function account(n, { email = `customer${n}@example.test`, type = 'company', activated = true, createdAt = NOW - n * 60000 } = {}) {
    const plan = approvedStarterPlan(), subjectKey = TENANT + ':' + uid(500 + n);
    const slot = { requestId: uid(100 * n + 1), kind: 'own', organisationName: `Synthetic org ${n}`,
        ...Object.fromEntries(SLOT_IDS.map((key, i) => [key, uid(100 * n + 10 + i)])) };
    const at = new Date(createdAt + 1000).toISOString();
    const record = starterAccountRecord({ schemaVersion: 1, accountId: uid(100 * n), planId: plan.planId, planSha256: plan.sha256, email,
        accountType: type, setupRequestId: slot.requestId, setupSha256: 'a'.repeat(64), createdAt: new Date(createdAt).toISOString(),
        activation: activated ? { subjectKey, receiptId: uid(100 * n + 50), activatedAt: at, validUntil: accountWindow(at, plan.planId).validUntil } : null,
        organisations: [slot], identitySubjectKey: subjectKey });
    const authority = { schemaVersion: 1, subjectKey, email, revision: 1, status: 'active', invitationDigest: 'b'.repeat(64), invitationId: 'synthetic-invite',
        tenantId: slot.tenantId, organisationId: slot.organisationId, termsVersion: 'synthetic-terms', termsDigest: 'c'.repeat(64), bindingId: null,
        accountType: type, expiresAt: NOW - 1000 };
    return { record, authority, subjectKey };
}
function container(blobs) {
    return {
        listBlobsFlat({ prefix }) {
            const names = [...blobs.keys()].sort().filter(name => name.startsWith(prefix));
            const iterator = (async function* () { for (const name of names) yield { name }; }());
            iterator.byPage = () => (async function* () { yield { segment: { blobItems: names.map(name => ({ name })) }, continuationToken: undefined }; }());
            return iterator;
        },
        getBlockBlobClient(name) { return { async download() {
            if (!blobs.has(name)) throw Object.assign(new Error('missing'), { statusCode: 404, code: 'BlobNotFound' });
            const bytes = Buffer.from(JSON.stringify(blobs.get(name)));
            return { etag: '"synthetic"', contentLength: bytes.length, readableStreamBody: Readable.from([bytes]) };
        } }; }
    };
}
const put = (blobs, item, { authority = true } = {}) => {
    blobs.set('customer-starter/' + starterAccountKey(item.record.email) + '.json', item.record);
    if (authority) blobs.set(`customer-subjects/${subjectHash(item.subjectKey)}.json`, item.authority);
};
const signal = () => new AbortController().signal;

test('lists starter accounts newest first with formed date, signup, sign-in state and organisation names', async () => {
    const blobs = new Map(), older = account(2), newer = account(1, { type: 'consultant' }), unfinished = account(3, { activated: false });
    put(blobs, older); put(blobs, newer); put(blobs, unfinished, { authority: false });
    const client = { requestId: uid(901), kind: 'client', organisationName: 'Synthetic client',
        ...Object.fromEntries(SLOT_IDS.map((key, i) => [key, uid(910 + i)])) };
    blobs.set(`customer-starter/starter-clients/${newer.record.accountId}/${client.requestId}.json`, { schemaVersion: 1, accountId: newer.record.accountId, slot: client });
    const revoked = account(4); revoked.authority.status = 'revoked'; put(blobs, revoked);
    blobs.set('customer-starter/starter-accounts/not-a-key.json', {});
    const result = await createAccountListReader([{ source, container: container(blobs) }], () => NOW)(signal());
    expect(result.truncated).toBe(false);
    expect(result.rows.map(row => row.email)).toEqual(['customer1@example.test', 'customer2@example.test', 'customer3@example.test', 'customer4@example.test']);
    expect(result.rows[0]).toEqual({ provider: 'external', readable: true, email: 'customer1@example.test', accountType: 'consultant',
        plan: newer.record.planId, createdAt: newer.record.createdAt, activatedAt: newer.record.activation.activatedAt, signup: 'activated',
        signIn: 'active', organisationsComplete: true, organisations: [{ name: 'Synthetic org 1', kind: 'own' }, { name: 'Synthetic client', kind: 'client' }] });
    expect(result.rows[2]).toMatchObject({ signup: 'unfinished', activatedAt: null, signIn: 'missing' });
    expect(result.rows[3].signIn).toBe('revoked');
    expect(result.rows.some(row => row.selector)).toBe(false);
});

test('selectors are returned only when actions are composed, and never for a misbound sign-in record', async () => {
    const blobs = new Map(), good = account(1), bad = account(2);
    bad.authority.organisationId = uid(999); put(blobs, good); put(blobs, bad);
    const rows = (await createAccountListReader([{ source, container: container(blobs) }], () => NOW)(signal(), true)).rows;
    expect(rows[0].selector).toEqual({ provider: 'external', subjectKey: good.subjectKey,
        tenantId: good.record.organisations[0].tenantId, organisationId: good.record.organisations[0].organisationId });
    expect(rows[1]).toMatchObject({ signIn: 'invalid' }); expect(rows[1].selector).toBeUndefined();
});

test('the legacy admin store is not scanned, unreadable records are flagged and the list is capped', async () => {
    const legacy = { listBlobsFlat() { throw new Error('PRIVATE_UNEXPECTED_SCAN'); }, getBlockBlobClient() { throw new Error('PRIVATE_UNEXPECTED_READ'); } };
    const blobs = new Map();
    for (let n = 1; n <= MAX_ACCOUNTS + 1; n += 1) put(blobs, account(n), { authority: false });
    const broken = account(MAX_ACCOUNTS + 5); blobs.set('customer-starter/' + starterAccountKey(broken.record.email) + '.json', { schemaVersion: 9 });
    const result = await createAccountListReader([{ source: { ...source, kind: 'legacy_admin', providerKind: 'workforce-b2b' }, container: legacy },
        { source, container: container(blobs) }], () => NOW)(signal());
    expect(result.truncated).toBe(true); expect(result.rows).toHaveLength(MAX_ACCOUNTS);
});

const origin = 'https://operator.example.test';
const identity = { provider: 'entra-bff', isAuthenticated: true, subjectKey: STAFF, tenantId: uid(1), principalId: uid(2) };
const wire = (input = {}, method = 'POST') => Object.assign(Readable.from([Buffer.from(JSON.stringify(input))]), {
    method, url: '/api/dashboard-admin/accounts/list', headers: { 'content-type': 'application/json', origin, 'sec-fetch-site': 'same-origin' } });
function handler({ list = jest.fn(async () => ({ rows: [], truncated: false })), authorise = jest.fn(async actor => actor), env = {} } = {}) {
    const audit = jest.fn(async () => {}), read = jest.fn();
    const service = { authorise, capabilities: async () => ({}), lookup: async () => ({}) };
    return { list, audit, read, handler: createDashboardAdminHandlers({ service, accountLookupReader: { read, list, audit, targetDigest: () => '0'.repeat(64) },
        readOperatorSession: async () => ({ identity }), env: { NOFRIES_PUBLIC_URL: origin, NOFRIES_REQUIRE_AUTH: 'true', NOFRIES_ENTRA_TENANT_ID: uid(1),
            NOFRIES_ALLOWED_SUBJECTS: STAFF, NOFRIES_ADMIN_SUBJECTS: STAFF, NOFRIES_DASHBOARD_ADMIN_ACCOUNT_LOOKUP: 'true', ...env } }) };
}
beforeEach(() => jest.spyOn(console, 'info').mockImplementation(() => {}));
afterEach(() => jest.restoreAllMocks());

test('an authorised list returns rows and writes one list audit record without a target', async () => {
    const h = handler({ list: jest.fn(async () => ({ rows: [{ email: 'customer@example.test' }], truncated: false })) });
    const result = await h.handler.handle(wire(), 'accounts/list');
    expect(result.status).toBe(200); expect(result.body.rows).toHaveLength(1);
    expect(h.list).toHaveBeenCalledWith(expect.anything(), false); expect(h.read).not.toHaveBeenCalled();
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ category: 'dashboard_admin_account_list', targetSha256: null, status: 200, count: 1 }));
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain('customer@example.test');
});

test('the list passes the selector switch only when account actions are on', async () => {
    const h = handler({ env: { NOFRIES_DASHBOARD_ADMIN_ACCOUNT_ACTIONS: 'true' } });
    await h.handler.handle(wire(), 'accounts/list');
    expect(h.list).toHaveBeenCalledWith(expect.anything(), true);
});

test.each([[{ email: 'x@example.test' }], [[]], [{ cursor: 'x' }]])('a non-empty body %j is refused before storage', async input => {
    const h = handler();
    expect((await h.handler.handle(wire(input), 'accounts/list')).status).toBe(400);
    expect(h.list).not.toHaveBeenCalled();
});

test('GET, foreign origin and denied staff authority are refused before storage', async () => {
    let h = handler();
    expect((await h.handler.handle(wire({}, 'GET'), 'accounts/list')).status).toBe(405);
    const foreign = wire(); foreign.headers.origin = 'https://evil.example';
    expect((await h.handler.handle(foreign, 'accounts/list')).status).toBe(403);
    h = handler({ authorise: jest.fn(async () => { throw Object.assign(new Error(), { statusCode: 403 }); }) });
    expect((await h.handler.handle(wire(), 'accounts/list')).status).toBe(403);
    expect(h.list).not.toHaveBeenCalled();
});

test('a failed audit write withholds the list; no list reader means not found', async () => {
    const h = handler({ list: jest.fn(async () => ({ rows: [{ email: 'customer@example.test' }], truncated: false })) });
    h.audit.mockRejectedValue(new Error('down'));
    const result = await h.handler.handle(wire(), 'accounts/list');
    expect(result.status).toBe(503); expect(JSON.stringify(result)).not.toContain('customer@example.test');
    const none = createDashboardAdminHandlers({ service: { authorise: async a => a, capabilities: async () => ({}), lookup: async () => ({}) },
        accountLookupReader: { read: jest.fn(), audit: jest.fn(async () => {}), targetDigest: () => '0'.repeat(64) }, readOperatorSession: async () => ({ identity }),
        env: { NOFRIES_PUBLIC_URL: origin, NOFRIES_REQUIRE_AUTH: 'true', NOFRIES_ENTRA_TENANT_ID: uid(1), NOFRIES_ALLOWED_SUBJECTS: STAFF,
            NOFRIES_ADMIN_SUBJECTS: STAFF, NOFRIES_DASHBOARD_ADMIN_ACCOUNT_LOOKUP: 'true' } });
    expect((await none.handle(wire(), 'accounts/list')).status).toBe(404);
});
