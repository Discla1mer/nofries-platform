'use strict';
const { createOrganisationSetup, workEmail, COOKIE } = require('../api/shared/organisationSetup');
const { createProductionOrganisationSetup, AzureOrganisationSetupStore } = require('../lib/organisationSetupProduction');
const clone = value => JSON.parse(JSON.stringify(value));
function fixture(existing, overrides = {}) {
    const records = existing || new Map(), sent = [];
    const clock = { at: Date.parse('2026-09-27T09:00:00Z') };
    const store = {
        async load(key) { return records.has(key) ? clone(records.get(key)) : null; },
        async create(key, record) { if (records.has(key)) return false; records.set(key, { version: 1, record: clone(record) }); return true; },
        async replace(key, version, record) { if (records.get(key)?.version !== version) return false;
            records.set(key, { version: version + 1, record: clone(record) }); return true; }
    };
    const sendEmail = jest.fn(async value => { sent.push(value); });
    const configuration = { store, sendEmail, origin: 'https://nofries.nz', now: () => clock.at, ...overrides };
    let service = createOrganisationSetup(configuration);
    const displayedRequests = new Map();
    const call = async (route, body, cookie, extra = {}) => {
        const response = await service.handle({ method: body ? 'POST' : 'GET', path: '/api/organisation-setup/' + route,
            headers: { origin: 'https://nofries.nz', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json',
                ...(cookie ? { cookie } : {}), ...(displayedRequests.has(cookie) ? { 'x-nofries-setup-request': displayedRequests.get(cookie) } : {}) },
            body, clientKey: 'test-network', ...extra });
        const newCookie = response.headers?.['Set-Cookie']?.split(';')[0];
        if (newCookie && response.body.requestId) displayedRequests.set(newCookie, response.body.requestId);
        return response;
    };
    const start = async (email = 'owner@acme.example', organisationName = 'Acme Organisation', clientKey = 'test-network') => {
        const response = await call('request', { email, organisationName }, null, { clientKey });
        return { response, cookie: response.headers?.['Set-Cookie']?.split(';')[0], code: sent.at(-1)?.code };
    };
    return { records, sent, clock, store, call, start, sendEmail, restart() { service = createOrganisationSetup(configuration); } };
}
test('verified organisation setup is server-owned, durable and grants no application authority', async () => {
    const h = fixture(), start = await h.start();
    expect(start.response.status).toBe(202);
    expect(start.response.headers['Set-Cookie']).toMatch(/HttpOnly; Secure; SameSite=Strict/);
    expect(JSON.stringify(start.response.body)).not.toContain(start.code);
    expect(JSON.stringify([...h.records.values()])).not.toContain(start.code);
    const result = await h.call('verify', { code: start.code }, start.cookie);
    expect(result).toMatchObject({ status: 200, body: { state: 'verified', organisationName: 'Acme Organisation', accessGranted: false } });
    h.restart();
    expect((await h.call('state', undefined, start.cookie)).body).toEqual(result.body);
    const saved = [...h.records.values()].find(x => x.record.requestId).record;
    expect(saved.codeHash).toBeNull(); expect(saved.verifiedAt).toBe(h.clock.at);
    expect(saved).not.toHaveProperty('tenantId'); expect(saved).not.toHaveProperty('principalId');
    expect(saved).not.toHaveProperty('termsAccepted'); expect(saved).not.toHaveProperty('membership');
});
test('a valid code cannot be used in another browser or with a scope cookie', async () => {
    const h = fixture(), a = await h.start('a@acme.example'), b = await h.start('b@acme.example');
    expect((await h.call('verify', { code: a.code }, b.cookie)).status).toBe(400);
    expect((await h.call('verify', { code: a.code }, '__Host-nofries_scope_access=anything')).status).toBe(401);
    expect((await h.call('state')).body).toEqual({ state: 'start' });
    expect((await h.call('verify', { code: a.code }, a.cookie + '; ' + a.cookie)).status).toBe(401);
});
test('attempt exhaustion and expiry deny the correct code without verification', async () => {
    const h = fixture(), a = await h.start();
    const wrong = a.code === '00000000' ? '11111111' : '00000000';
    for (let i = 0; i < 5; i++) expect((await h.call('verify', { code: wrong }, a.cookie)).status).toBe(i === 4 ? 429 : 400);
    expect((await h.call('verify', { code: a.code }, a.cookie)).body.code).toBe('verification_attempts_exhausted');
    const b = await h.start('another@acme.example'); h.clock.at += 600000;
    expect((await h.call('verify', { code: b.code }, b.cookie)).body.code).toBe('verification_code_expired');
    h.clock.at += 86400000;
    expect((await h.call('state', undefined, b.cookie)).body.state).toBe('start');
});
test('concurrent verification commits once and safely resumes the same proof', async () => {
    const h = fixture(), a = await h.start();
    const results = await Promise.all([h.call('verify', { code: a.code }, a.cookie), h.call('verify', { code: a.code }, a.cookie)]);
    expect(results.map(x => x.status).sort()).toEqual([200, 409]);
    expect((await h.call('verify', { code: a.code }, a.cookie)).body.state).toBe('verified');
    expect(h.sent).toHaveLength(1);
});
test.each([
    ['http://nofries.nz', 'same-origin'], ['https://evil.example', 'same-origin'], ['', 'same-origin'], ['https://nofries.nz', 'cross-site']
])('origin %s / fetch-site %s is rejected before persistence or delivery', async (origin, fetchSite) => {
    const h = fixture();
    const r = await h.call('request', { email: 'a@acme.example', organisationName: 'Acme' }, null,
        { headers: { origin, 'sec-fetch-site': fetchSite, 'content-type': 'application/json' } });
    expect(r.status).toBe(403); expect(h.records.size).toBe(0); expect(h.sent).toHaveLength(0);
});
test('extra client authority fields, malformed email and control characters are rejected before delivery', async () => {
    const h = fixture();
    expect((await h.call('request', { email: 'a@acme.example', organisationName: 'Acme', tenantId: 'chosen' })).status).toBe(400);
    expect((await h.start('a@acme.example', 'Acme\r\nInjected')).response.status).toBe(400);
    for (const email of ['a@localhost', 'a..b@acme.example', 'a@bad-.example', 'a\r\nb@acme.example']) {
        expect((await h.start(email)).response.status).toBe(400);
    }
    expect(h.sent).toHaveLength(0);
    expect(workEmail(' Owner+setup@Acme.Example ')).toBe('owner+setup@acme.example');
});
test('mailbox and global delivery limits survive service restart and parallel instances', async () => {
    const h = fixture();
    for (let i = 0; i < 3; i++) expect((await h.start()).response.status).toBe(202);
    h.restart(); expect((await h.start()).response.status).toBe(429); expect(h.sent).toHaveLength(3);
    const a = fixture(), b = fixture(a.records);
    const responses = await Promise.all(Array.from({ length: 30 }, (_, i) =>
        (i % 2 ? a : b).start('owner' + i + '@acme.example', 'Acme ' + i, 'network-' + i)));
    expect(a.sent.length + b.sent.length).toBeLessThanOrEqual(20);
    expect(responses.some(x => x.response.status === 429)).toBe(true);
});
test('uncertain delivery is explicit, is not retried and can be verified if the code arrived', async () => {
    const h = fixture(); h.sendEmail.mockImplementation(async value => { h.sent.push(value); throw new Error('provider unavailable'); });
    const a = await h.start(); expect(a.response.body.delivery).toBe('unconfirmed');
    expect(h.sendEmail).toHaveBeenCalledTimes(1);
    expect((await h.call('verify', { code: a.code }, a.cookie)).body.state).toBe('verified');
});
test('storage failure fails closed without delivery', async () => {
    const h = fixture(); h.store.load = async () => { throw new Error('private details'); };
    const result = await h.start(); expect(result.response).toEqual({ status: 503, body: { code: 'setup_unavailable' } });
    expect(h.sent).toHaveLength(0);
});
test('request reference must be durable before code delivery and contains no bearer capability', async () => {
    const h = fixture(), a = await h.start();
    const [referenceKey, saved] = [...h.records].find(([name]) => name.startsWith('references/'));
    expect(referenceKey).toMatch(/^references\/[a-f0-9]{64}$/);
    const verified = await h.call('verify', { code: a.code }, a.cookie);
    expect(saved.record).toEqual({ schemaVersion: 1, requestId: verified.body.requestId,
        requestKey: expect.stringMatching(/^requests\/[a-f0-9]{64}$/), expiresAt: h.clock.at + 86400000 });
    expect(JSON.stringify(saved)).not.toContain(a.code);
    expect(JSON.stringify(saved)).not.toContain(a.cookie.split('=')[1]);
    const blocked = fixture(), original = blocked.store.create;
    blocked.store.create = (name, record) => name.startsWith('references/') ? false : original(name, record);
    expect((await blocked.start()).response.status).toBe(503); expect(blocked.sent).toHaveLength(0);
});
test.each(['state', 'verify'])('legacy verified proof resumes through %s without new email, proof mutation or expiry extension', async route => {
    const h = fixture(), a = await h.start();
    const original = await h.call('verify', { code: a.code }, a.cookie);
    const [referenceKey, reference] = [...h.records].find(([name]) => name.startsWith('references/'));
    const source = clone(h.records.get(reference.record.requestKey));
    h.records.delete(referenceKey); h.clock.at += 600001; h.restart();
    const resumed = await h.call(route, route === 'verify' ? { code: a.code } : undefined, a.cookie);
    expect(resumed.body).toEqual(original.body); expect(resumed.headers).toBeUndefined();
    expect(h.records.get(referenceKey).record).toEqual(reference.record);
    expect(h.records.get(reference.record.requestKey)).toEqual(source);
    expect(h.sent).toHaveLength(1); expect(resumed.body.accessGranted).toBe(false);
});
test.each(['awaiting_code', 'verified'])('starter rollout preserves the legacy %s continuation', async status => {
    const readContinuation = jest.fn(async () => 'pending_activation');
    const starterSetup = { read: jest.fn(async () => 'details_required'), save: jest.fn() };
    const h = fixture(undefined, { starterSetup, readContinuation }), a = await h.start();
    if (status === 'verified') await h.call('verify', { code: a.code }, a.cookie);
    const [, row] = [...h.records].find(([key]) => key.startsWith('requests/'));
    delete row.record.accountType;
    starterSetup.read.mockClear(); const before = clone(row.record);
    const verified = await h.call('verify', { code: a.code }, a.cookie);
    expect(verified).toMatchObject({ status: 200, body: { state: 'verified', accountType: 'company', nextStep: 'pending_activation' } });
    expect((await h.call('state', undefined, a.cookie)).body).toEqual(verified.body);
    expect(readContinuation).toHaveBeenCalled(); expect(starterSetup.read).not.toHaveBeenCalled();
    expect((await h.call('details', { anything: true }, a.cookie)).status).toBe(409);
    expect(starterSetup.save).not.toHaveBeenCalled(); expect(h.sent).toHaveLength(1);
    const after = [...h.records].find(([key]) => key.startsWith('requests/'))[1].record;
    expect(after).not.toHaveProperty('accountType'); expect(after.expiresAt).toBe(before.expiresAt);
    if (status === 'verified') expect(after).toEqual(before);
});
test('legacy awaiting-code request is indexed only after genuine verification and concurrent resume is idempotent', async () => {
    const h = fixture(), a = await h.start();
    const [referenceKey, reference] = [...h.records].find(([name]) => name.startsWith('references/'));
    h.records.delete(referenceKey);
    expect((await h.call('state', undefined, a.cookie)).body.state).toBe('awaiting_code');
    expect(h.records.has(referenceKey)).toBe(false);
    expect((await h.call('verify', { code: a.code }, a.cookie)).body.state).toBe('verified');
    expect(h.records.get(referenceKey).record).toEqual(reference.record);
    h.records.delete(referenceKey);
    const resumed = await Promise.all([h.call('state', undefined, a.cookie), h.call('state', undefined, a.cookie)]);
    expect(resumed.map(r => r.status)).toEqual([200, 200]);
    expect(h.records.get(referenceKey).record).toEqual(reference.record); expect(h.sent).toHaveLength(1);
});
test.each(['requestKey', 'requestId', 'expiresAt', 'extra'])('legacy locator %s collision fails closed without overwriting another reference', async field => {
    const h = fixture(), a = await h.start(); await h.call('verify', { code: a.code }, a.cookie);
    const [referenceKey, reference] = [...h.records].find(([name]) => name.startsWith('references/'));
    const colliding = clone(reference);
    colliding.record[field] = field === 'expiresAt' ? reference.record.expiresAt + 1 : field === 'requestKey' ? 'requests/' + 'f'.repeat(64)
        : field === 'requestId' ? '11111111-2222-4333-8444-555555555555' : 'unexpected';
    h.records.set(referenceKey, colliding);
    expect(await h.call('state', undefined, a.cookie)).toEqual({ status: 503, body: { code: 'setup_unavailable' } });
    expect((await h.call('verify', { code: a.code }, a.cookie)).status).toBe(503);
    expect(h.records.get(referenceKey)).toEqual(colliding); expect(h.sent).toHaveLength(1);
});
test('absent cookie and expired legacy proof create no reference and cannot renew setup', async () => {
    const h = fixture(), a = await h.start(); await h.call('verify', { code: a.code }, a.cookie);
    const [referenceKey, reference] = [...h.records].find(([name]) => name.startsWith('references/'));
    h.records.delete(referenceKey);
    expect((await h.call('state')).body).toEqual({ state: 'start' }); expect(h.records.has(referenceKey)).toBe(false);
    h.clock.at = reference.record.expiresAt;
    expect((await h.call('state', undefined, a.cookie)).body).toEqual({ state: 'start' });
    expect((await h.call('verify', { code: a.code }, a.cookie)).status).toBe(410);
    expect(h.records.has(referenceKey)).toBe(false); expect(h.sent).toHaveLength(1);
});
test('concurrent conflicting legacy locator creation fails exact readback without changing the proof', async () => {
    const h = fixture(), a = await h.start(); await h.call('verify', { code: a.code }, a.cookie);
    const [referenceKey, reference] = [...h.records].find(([name]) => name.startsWith('references/'));
    const original = h.store.create, proof = clone(h.records.get(reference.record.requestKey));
    h.records.delete(referenceKey);
    const collision = { ...reference.record, requestKey: 'requests/' + 'f'.repeat(64) };
    h.store.create = async (name, record) => {
        if (name !== referenceKey) return original(name, record);
        await original(name, collision); return false;
    };
    expect((await h.call('state', undefined, a.cookie)).status).toBe(503);
    expect(h.records.get(referenceKey).record).toEqual(collision);
    expect(h.records.get(reference.record.requestKey)).toEqual(proof); expect(h.sent).toHaveLength(1);
});
test.each(['codeHash', 'verifiedAt', 'expiresAt', 'email', 'extra'])('invalid legacy verified %s cannot create a proof locator', async field => {
    const h = fixture(), a = await h.start(); await h.call('verify', { code: a.code }, a.cookie);
    const [referenceKey, reference] = [...h.records].find(([name]) => name.startsWith('references/'));
    h.records.delete(referenceKey);
    const source = h.records.get(reference.record.requestKey).record;
    source[field] = field === 'codeHash' ? 'a'.repeat(64) : field === 'verifiedAt' ? source.createdAt - 1
        : field === 'expiresAt' ? source.expiresAt + 1 : field === 'email' ? 'invalid@localhost' : 'unexpected';
    expect((await h.call('state', undefined, a.cookie)).status).toBe(503);
    expect(h.records.has(referenceKey)).toBe(false); expect(h.sent).toHaveLength(1);
});
test('production setup is opt-in and refuses incomplete delivery configuration', () => {
    expect(createProductionOrganisationSetup({})).toBeNull();
    expect(() => createProductionOrganisationSetup({ NOFRIES_ORGANISATION_SETUP_ENABLED: 'true' })).toThrow('organisation_setup_configuration_invalid');
});
test('Azure store uses conditional writes and treats conflicts as failed commits', async () => {
    const uploadData = jest.fn().mockResolvedValueOnce({}).mockRejectedValueOnce({ statusCode: 412 });
    const getBlockBlobClient = jest.fn(() => ({ uploadData }));
    const store = new AzureOrganisationSetupStore({ getBlockBlobClient });
    const key = 'requests/' + 'a'.repeat(64), value = { schemaVersion: 1, expiresAt: 123 };
    expect(await store.create(key, value)).toBe(true);
    expect(await store.replace(key, 'current-etag', value)).toBe(false);
    expect(uploadData.mock.calls[0][1].conditions).toEqual({ ifNoneMatch: '*' });
    expect(uploadData.mock.calls[1][1].conditions).toEqual({ ifMatch: 'current-etag' });
    expect(getBlockBlobClient).toHaveBeenCalledWith('browser-auth/organisation-setup/' + key + '.json');
});

test.each(['mailbox', 'network'])('rejected %s requests cannot consume other organisations global email capacity', async limit => {
    const h = fixture(), count = limit === 'mailbox' ? 3 : 5;
    for (let i = 0; i < count; i++) {
        const email = limit === 'mailbox' ? 'same@acme.example' : 'owner' + i + '@acme.example';
        expect((await h.start(email, 'Acme', 'limited-network')).response.status).toBe(202);
    }
    for (let i = 0; i < 25; i++) {
        const email = limit === 'mailbox' ? 'same@acme.example' : 'blocked' + i + '@acme.example';
        expect((await h.start(email, 'Acme', 'limited-network')).response.status).toBe(429);
    }
    h.restart();
    expect((await h.start('owner@another.example', 'Another organisation', 'another-network')).response.status).toBe(202);
    expect(h.sent).toHaveLength(count + 1);
});

test.each([
    ['company', 'test fries limited', 'hello@nofries.nz'],
    ['company', 'Example Organisation', 'tester@gmail.com'],
    ['consultant', 'Independent advisor', 'tester@outlook.com'],
    ['consultant', 'Consulting workspace', 'tester@unrelated.example']
])('accepts %s signup with unrelated name and personal/work email', async (accountType, organisationName, email) => {
    const h = fixture();
    const started = await h.call('request', { accountType, organisationName, email });
    expect(started.status).toBe(202); expect(started.body.accountType).toBe(accountType);
    const cookie = started.headers['Set-Cookie'].split(';')[0];
    const verified = await h.call('verify', { code: h.sent[0].code }, cookie);
    expect(verified.body).toMatchObject({ state: 'verified', accountType, organisationName, accessGranted: false });
    h.restart(); expect((await h.call('state', undefined, cookie)).body).toEqual(verified.body);
    expect(h.sent).toHaveLength(1);
});
test.each([null, '', 'staff', 'operator', 'Consultant', {}, ['company']])('invalid account type %p fails before storage or email', async accountType => {
    const h = fixture();
    expect((await h.call('request', { accountType, organisationName: 'Example', email: 'tester@gmail.com' })).body.code).toBe('account_type_invalid');
    expect(h.records.size).toBe(0); expect(h.sent).toHaveLength(0);
});
test('verification cannot change the account type and legacy proofs keep company semantics without mutation', async () => {
    const h = fixture(), a = await h.start('tester@gmail.com');
    expect((await h.call('verify', { code: a.code, accountType: 'consultant' }, a.cookie)).status).toBe(400);
    const record = [...h.records.values()].find(x => x.record.codeHash).record;
    delete record.accountType;
    expect((await h.call('verify', { code: a.code }, a.cookie)).body.accountType).toBe('company');
    const saved = [...h.records.values()].find(x => x.record.status === 'verified').record;
    expect(saved).not.toHaveProperty('accountType');
});

test('production adapter delivers a personal-email challenge with neutral signup wording', async () => {
    const records = new Map(); let version = 0;
    const container = { getBlockBlobClient(name) { return {
        async download() {
            const row = records.get(name); if (!row) throw { statusCode: 404 };
            return { etag: row.etag, readableStreamBody: require('node:stream').Readable.from([row.bytes]) };
        },
        async uploadData(bytes, options) {
            const row = records.get(name), conditions = options.conditions;
            if (conditions.ifNoneMatch === '*' && row || conditions.ifMatch && conditions.ifMatch !== row?.etag) throw { statusCode: 412 };
            records.set(name, { bytes: Buffer.from(bytes), etag: String(++version) });
        }
    }; } };
    const fetch = jest.fn(async () => ({ ok: true }));
    const service = createProductionOrganisationSetup({
        NOFRIES_ORGANISATION_SETUP_ENABLED: 'true', NOFRIES_DASHBOARD_RUNTIME_ENABLED: 'true',
        NOFRIES_PUBLIC_URL: 'https://nofries.nz', NOFRIES_BROWSER_AUTH_STORAGE_ACCOUNT: 'syntheticacct',
        RESEND_API_KEY: 'synthetic-only-key', NOFRIES_SCOPE_EMAIL_FROM: 'signup@example.invalid'
    }, { ManagedIdentityCredential: class {}, BlobServiceClient: class { getContainerClient() { return container; } }, fetch });
    const headers = { origin: 'https://nofries.nz', 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' };
    const started = await service.handle({ method: 'POST', path: 'request', headers, clientKey: 'synthetic-network',
        body: { accountType: 'consultant', organisationName: 'Independent workspace', email: 'tester@gmail.com' } });
    expect(started.status).toBe(202); expect(fetch).toHaveBeenCalledTimes(1);
    const [url, options] = fetch.mock.calls[0], mail = JSON.parse(options.body);
    expect(url).toBe('https://api.resend.com/emails'); expect(mail.to).toEqual(['tester@gmail.com']);
    expect(mail.subject).toBe('Verify your email for No Fries'); expect(mail.text).not.toContain('work email');
    const verified = await service.handle({ method: 'POST', path: 'verify',
        headers: { ...headers, cookie: started.headers['Set-Cookie'].split(';')[0], 'x-nofries-setup-request': started.body.requestId }, body: { code: mail.text.match(/[0-9]{8}/)[0] } });
    expect(verified.body).toMatchObject({ state: 'verified', accountType: 'consultant', accessGranted: false });
});

test('leaving detaches only the opaque session, preserving verified proof, references and email limits on retry', async () => {
    const h = fixture(), original = await h.start();
    const verified = await h.call('verify', { code: original.code }, original.cookie);
    const before = clone([...h.records]);
    const replace = jest.spyOn(h.store, 'replace');
    for (const cookie of [original.cookie, original.cookie, undefined, COOKIE + '=invalid']) {
        expect(await h.call('state', { action: 'leave' }, cookie, { headers: {
            origin: 'https://nofries.nz', 'content-type': 'application/json', cookie,
            'x-nofries-setup-request': verified.body.requestId
        } })).toEqual({ status: 200, body: { state: 'start' } });
    }
    expect(replace).not.toHaveBeenCalled();
    expect(clone([...h.records].filter(([key]) => !key.startsWith('detached/')))).toEqual(before);
    const markers = [...h.records].filter(([key]) => key.startsWith('detached/'));
    expect(markers).toHaveLength(1);
    expect(markers[0][1].record).toEqual({ schemaVersion: 1, expiresAt: h.clock.at + 86400000 });
    expect(h.sent).toHaveLength(1);
    expect((await h.call('state')).body).toEqual({ state: 'start' });
    h.restart();
    // The proof remains available to administrative reconciliation, while the
    // detached browser session cannot resume it after a restart or lost response.
    expect((await h.call('state', undefined, original.cookie)).body).toEqual({ state: 'start' });
    expect((await h.call('verify', { code: original.code }, original.cookie)).body.code).toBe('setup_expired');
    for (let i = 0; i < 2; i++) { expect((await h.start()).response.status).toBe(202); await h.call('state', { action: 'leave' }); }
    expect((await h.start()).response.status).toBe(429);
    expect(h.sent).toHaveLength(3);
});

test('overlapping leave responses cannot clear a newer request cookie', async () => {
    const h = fixture(), first = await h.start('first@example.test');
    const leave = () => h.call('state', { action: 'leave' }, first.cookie, { headers: {
        origin: 'https://nofries.nz', 'content-type': 'application/json', cookie: first.cookie,
        'x-nofries-setup-request': first.response.body.requestId
    } });
    const [firstResponse, delayedResponse] = await Promise.all([leave(), leave()]);
    expect(firstResponse).toEqual({ status: 200, body: { state: 'start' } });
    const next = await h.start('next@example.test');
    // Deliver the second A response only after the browser has B's cookie.
    const browserCookie = delayedResponse.headers?.['Set-Cookie']?.split(';')[0] || next.cookie;
    expect(browserCookie).toBe(next.cookie);
    expect((await h.call('state', undefined, browserCookie)).body.requestId).toBe(next.response.body.requestId);
    expect((await h.call('verify', { code: next.code }, browserCookie)).body.state).toBe('verified');
    expect((await h.call('state', undefined, first.cookie)).body).toEqual({ state: 'start' });
});

test('accepted details may finish only for their original proof after leave while the next session stays separate', async () => {
    let releaseSave, saving;
    const heldSave = new Promise(resolve => { releaseSave = resolve; });
    const saveStarted = new Promise(resolve => { saving = resolve; });
    const completed = [];
    const h = fixture(undefined, { starterSetup: {
        async read() { return 'details_required'; },
        async save(record, details) {
            saving(); await heldSave;
            completed.push({ requestId: record.requestId, email: record.email, details });
        }
    } });
    const first = await h.start('first@example.test');
    await h.call('verify', { code: first.code }, first.cookie);
    const headers = { origin: 'https://nofries.nz', 'content-type': 'application/json', cookie: first.cookie,
        'x-nofries-setup-request': first.response.body.requestId };
    const details = { name: 'First Representative', authorityConfirmed: true };
    const pending = h.call('details', details, first.cookie, { headers });
    await saveStarted;
    expect((await h.call('state', { action: 'leave' }, first.cookie, { headers })).body).toEqual({ state: 'start' });
    const second = await h.start('second@example.test');
    releaseSave();
    expect((await pending).body).toEqual({ state: 'start' });
    expect(completed).toEqual([{ requestId: first.response.body.requestId, email: 'first@example.test', details }]);
    expect((await h.call('details', details, first.cookie, { headers })).body.code).toBe('setup_expired');
    expect(completed).toHaveLength(1);
    expect((await h.call('state', undefined, second.cookie)).body.requestId).toBe(second.response.body.requestId);
    expect((await h.call('verify', { code: second.code }, second.cookie)).body.state).toBe('verified');
});

test.each(['unavailable', 'uncommitted'])('leave does not acknowledge a %s detach write', async mode => {
    const h = fixture(), first = await h.start(), before = clone([...h.records]);
    const create = h.store.create;
    h.store.create = (key, value) => {
        if (!key.startsWith('detached/')) return create(key, value);
        if (mode === 'unavailable') throw new Error('storage_unavailable');
        return false;
    };
    const response = await h.call('state', { action: 'leave' }, first.cookie, { headers: {
        origin: 'https://nofries.nz', 'content-type': 'application/json', cookie: first.cookie,
        'x-nofries-setup-request': first.response.body.requestId
    } });
    expect(response).toEqual({ status: 503, body: { code: 'setup_unavailable' } });
    expect(clone([...h.records])).toEqual(before);
    expect((await h.call('state', undefined, first.cookie)).body.requestId).toBe(first.response.body.requestId);
});

test.each([
    { method: 'PUT' },
    { body: { action: 'unknown' } },
    { body: {} },
    { headers: { origin: 'https://foreign.example', 'content-type': 'application/json' } },
    { headers: { origin: 'https://nofries.nz', 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' } },
    { headers: { origin: 'https://nofries.nz', 'content-type': 'text/plain' } },
    { originalUrl: '/api/organisation-setup/state?requestId=other' },
    { body: { requestId: 'other' } }
])('leave rejects invalid request %# without clearing cookies or touching saved data', async extra => {
    const h = fixture(), original = await h.start(), before = clone([...h.records]);
    const response = await h.call('state', { action: 'leave' }, original.cookie, extra);
    expect(response.status).toBeGreaterThanOrEqual(400); expect(response.headers).toBeUndefined();
    expect(clone([...h.records])).toEqual(before); expect(h.sent).toHaveLength(1);
});

test('leave requires the displayed active request and preserves another tab’s code on stale or missing context', async () => {
    const h = fixture(), first = await h.start('first@example.test'), second = await h.start('second@example.test');
    const before = clone([...h.records]);
    for (const requestId of [undefined, first.response.body.requestId]) {
        const result = await h.call('state', { action: 'leave' }, second.cookie, { headers: {
            origin: 'https://nofries.nz', 'content-type': 'application/json', cookie: second.cookie,
            'x-nofries-setup-request': requestId
        } });
        expect(result).toEqual({ status: 409, body: { code: 'setup_changed' } });
        expect(clone([...h.records])).toEqual(before);
    }
    expect((await h.call('verify', { code: second.code }, second.cookie)).body.state).toBe('verified');
    expect(h.sent).toHaveLength(2);
});

test.each([false, true])('stale verification cannot spend a newer request’s attempts or verify it when codes coincide=%s', async sameCode => {
    let number = 10;
    const h = fixture(undefined, { randomInt: () => sameCode ? 42 : ++number });
    const first = await h.start('first@example.test'), second = await h.start('second@example.test');
    const before = clone([...h.records]);
    for (const requestId of [undefined, first.response.body.requestId]) {
        const response = await h.call('verify', { code: first.code }, second.cookie, { headers: {
            origin: 'https://nofries.nz', 'content-type': 'application/json', cookie: second.cookie,
            'x-nofries-setup-request': requestId
        } });
        expect(response).toEqual({ status: 409, body: { code: 'setup_changed' } });
        expect(clone([...h.records])).toEqual(before);
    }
    expect((await h.call('verify', { code: second.code }, second.cookie)).body.state).toBe('verified');
});

test.each(['company', 'consultant'])('email-first %s signup requires verification before account choice', async type => {
    const starterSetup = { read: jest.fn(async () => 'details_required'), save: jest.fn(), findAccount: jest.fn(async () => null) };
    const h = fixture(undefined, { starterSetup });
    const start = await h.call('request', { email: 'person@gmail.com' });
    const cookie = start.headers['Set-Cookie'].split(';')[0];
    expect(start.body).toMatchObject({ state: 'awaiting_code', accountType: null });
    expect(starterSetup.findAccount).not.toHaveBeenCalled();
    const selection = { accountType: type, organisationName: 'Example Organisation' };
    expect((await h.call('choose', selection, cookie)).status).toBe(403);
    expect((await h.call('verify', { code: h.sent[0].code }, cookie)).body).toMatchObject({ nextStep: 'choose_account', accessGranted: false });
    expect((await h.call('choose', selection, cookie)).body).toMatchObject({ nextStep: 'details_required', ...selection });
    expect(starterSetup.save).not.toHaveBeenCalled();
    h.restart(); expect((await h.call('state', undefined, cookie)).body).toMatchObject({ nextStep: 'details_required', ...selection });
});

test.each(['company', 'consultant'])('email-first %s selection also completes without the starter feature', async type => {
    const readContinuation = jest.fn(async () => 'pending_activation');
    const h = fixture(undefined, { readContinuation });
    const start = await h.call('request', { email: 'person@gmail.com' });
    const cookie = start.headers['Set-Cookie'].split(';')[0];
    const selected = { accountType: type, organisationName: 'Preserved legacy setup' };
    expect((await h.call('choose', selected, cookie)).status).toBe(403);
    expect((await h.call('verify', { code: h.sent[0].code }, cookie)).body.nextStep).toBe('choose_account');
    expect(readContinuation).not.toHaveBeenCalled();
    const chosen = await h.call('choose', selected, cookie);
    expect(chosen).toMatchObject({ status: 200, body: { state: 'verified', ...selected, nextStep: 'pending_activation', accessGranted: false } });
    expect(readContinuation).toHaveBeenCalledWith(expect.objectContaining({ ...selected, requestId: start.body.requestId, email: 'person@gmail.com', status: 'verified' }));
    h.restart(); expect((await h.call('state', undefined, cookie)).body).toEqual(chosen.body);
    expect((await h.call('details', {}, cookie)).status).toBe(404);
    expect(h.sent).toHaveLength(1);
});

test('verified returning mailbox finds the saved account without choosing or allocating another organisation', async () => {
    const existing = { accountType: 'consultant', organisationName: 'Saved workspace' };
    const starterSetup = { read: jest.fn(), save: jest.fn(), findAccount: jest.fn(async () => existing) };
    const h = fixture(undefined, { starterSetup });
    const start = await h.call('request', { email: 'person@gmail.com' });
    const cookie = start.headers['Set-Cookie'].split(';')[0];
    expect(starterSetup.findAccount).not.toHaveBeenCalled();
    const verified = await h.call('verify', { code: h.sent[0].code }, cookie);
    expect(verified.body).toMatchObject({ nextStep: 'account_found', ...existing, accessGranted: false });
    expect((await h.call('choose', { accountType: 'company', organisationName: 'Replacement' }, cookie)).body.code).toBe('starter_account_exists');
    expect(starterSetup.save).not.toHaveBeenCalled(); expect(starterSetup.read).not.toHaveBeenCalled();
    expect(existing).toEqual({ accountType: 'consultant', organisationName: 'Saved workspace' });
});

test('email proof requires the verified original browser, remains bound through callback, and fails after detach or expiry', async () => {
    const { createVerifiedSetupEmailReader } = require('../api/shared/customerSignup/verifiedSetupEmail');
    const h = fixture(), reader = createVerifiedSetupEmailReader({ store: h.store, now: () => h.clock.at });
    const start = await h.call('request', { email: 'person@gmail.com' });
    const cookie = start.headers['Set-Cookie'].split(';')[0];
    expect(await reader.begin(cookie)).toBeNull();
    await h.call('verify', { code: h.sent[0].code }, cookie);
    const proof = await reader.begin(cookie);
    expect(await reader.verify(proof, 'person@gmail.com')).toBe(true);
    await expect(reader.verify(proof, 'other@gmail.com')).rejects.toMatchObject({ code: 'browser_auth_email_verification_required' });
    await expect(reader.verify({ ...proof, proofDigest: '0'.repeat(64) }, proof.email)).rejects.toMatchObject({ statusCode: 401 });
    await h.call('state', { action: 'leave' }, cookie);
    expect(await reader.begin(cookie)).toBeNull();
    await expect(reader.verify(proof, proof.email)).rejects.toMatchObject({ statusCode: 401 });
    h.clock.at += 86400000;
    await expect(reader.verify(proof, proof.email)).rejects.toMatchObject({ statusCode: 401 });
});

test.each(['detached during read', 'marker store unavailable', 'request store unavailable'])
('login setup reader fails closed when %s', async variant => {
    const { createVerifiedSetupEmailReader } = require('../api/shared/customerSignup/verifiedSetupEmail');
    const h = fixture(), start = await h.start();
    await h.call('verify', { code: start.code }, start.cookie);
    const load = h.store.load;
    let markers = 0;
    h.store.load = async key => {
        if (key.startsWith('detached/')) {
            markers++;
            if (variant === 'marker store unavailable') throw new Error('synthetic storage unavailable');
            if (variant === 'detached during read' && markers === 2) return { record: { schemaVersion: 1, expiresAt: h.clock.at + 1000 } };
        }
        if (key.startsWith('requests/') && variant === 'request store unavailable') throw new Error('synthetic storage unavailable');
        return load(key);
    };
    const reader = createVerifiedSetupEmailReader({ store: h.store, now: () => h.clock.at });
    await expect(reader.begin(start.cookie)).rejects.toMatchObject(variant === 'detached during read'
        ? { statusCode: 401, code: 'browser_auth_email_verification_required' }
        : { message: 'synthetic storage unavailable' });
    if (variant === 'detached during read') expect(markers).toBe(2);
});
