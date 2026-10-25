'use strict';

// Genuine production routes and durable recovery logic with synthetic provider,
// Blob and SQL ports; no live identity, browser or PostgreSQL acceptance proof.
const crypto = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');
const request = require('supertest');
const { customerProductionHarness, uid } = require('./helpers/customerProductionHarness');
const { createDom } = require('./fixtures/dashboardDom');
const { buildSignupDocument, buildHostedSignupDocument } = require('../lib/signupDocument');
const { resetAbuseProtectionForTests } = require('../api/shared/abuseProtection');
const { hash } = require('../api/shared/appLifecycle/dashboardRuntimeRecords');

const ROUTE = '/api/external-customer-signup';
const PRIVATE = 'synthetic-private-storage-failure';
const INPUT = Object.freeze({ accountType: 'consultant', organisationName: 'Synthetic retained consultancy',
    details: Object.freeze({ name: 'Synthetic representative', role: 'Owner', address: 'Synthetic business address',
        registrationId: '', authorityConfirmed: true }) });
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

test.each([false, true])('nested retained claim drift stops before writes even with a matching completion digest (%s)', async completed => {
    const { h, s } = await interrupted('completion'), store = h.getContainer('external-starter-authority');
    const key = [...store.records.keys()].find(key => /\/external-claims\/[^/]+\.json$/.test(key) && !key.endsWith('.complete.json'));
    const claim = JSON.parse(store.records.get(key));
    claim.invitation.mfaRequired = true; // Structurally valid, forbidden by this external claim contract.
    store.records.set(key, Buffer.from(JSON.stringify(claim)));
    if (completed) store.records.set(key.replace('.json', '.complete.json'),
        Buffer.from(JSON.stringify({ schemaVersion: 1, claimSha256: hash(claim) })));
    const before = snapshot(h), writes = observeStorage(h);
    expect((await load(h, s.cookie)).status).toBe(503);
    for (const body of [INPUT, { resume: true }]) expect((await post(h, s.cookie, s.csrf, body)).status).toBe(503);
    expect(snapshot(h)).toBe(before); expect(writes).toEqual([]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(PRIVATE);
});

test('a completed resume rechecks session expiry after the retained read before acknowledging continuation', async () => {
    const h = fixture(), s = await session(h);
    expect((await post(h, s.cookie, s.csrf, INPUT)).status).toBe(200);
    const store = h.getContainer('external-starter-authority'), original = store.getBlockBlobClient.bind(store);
    let advanced = false;
    store.getBlockBlobClient = key => {
        const blob = original(key), download = blob.download.bind(blob);
        if (key.endsWith('.complete.json')) blob.download = async (...args) => {
            const response = await download(...args);
            if (!advanced) { h.state.now += 3600001; advanced = true; }
            return response;
        };
        return blob;
    };
    const durable = retained(h, ''), response = await post(h, s.cookie, s.csrf, { resume: true });
    expect(advanced).toBe(true); expect(response.status).toBe(401);
    expect(response.body.code).toBe('signup_signin_required'); expect(response.body.state).toBeUndefined();
    expectRetained(h, durable); expect(h.pool.registrations.size).toBe(0); expect(h.pool.receipts.size).toBe(0);
    expect(response.headers['set-cookie']).toHaveLength(1);
});
const sidKey = cookie => 'browser-auth/sessions/' + digest(cookie.split('=')[1]) + '.json';
let warn;
beforeEach(() => { resetAbuseProtectionForTests(); warn = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => warn.mockRestore());

function fixture() {
    return customerProductionHarness({ starter: true, external: true, customerClientId: uid(105), now: Date.now(),
        configureExternal({ dependencies, state }) { dependencies.clock = () => new Date(state.now).toISOString(); } });
}
const load = (h, cookie) => request(h.app).get(ROUTE + '/state').set('Cookie', cookie);
const post = (h, cookie, csrf, body) => h.sameOrigin(request(h.app).post(ROUTE + '/setup'))
    .set('Cookie', cookie).set('X-CSRF-Token', csrf).send(body);
async function session(h) {
    const login = await h.loginExternal(); expect(login.response.status).toBe(303);
    const state = await load(h, login.cookie);
    expect(state.body.state).toEqual({ status: 'setup_details', email: h.state.externalEmail });
    return { cookie: login.cookie, csrf: state.body.csrfToken };
}
function snapshot(h) {
    return JSON.stringify({ blobs: [...h.state.containers].map(([name, store]) => [name,
        [...store.records].map(([key, bytes]) => [key, digest(bytes)]).sort()]).sort(),
        registrations: [...h.pool.registrations], receipts: [...h.pool.receipts] });
}
function observeStorage(h, failKey = () => false, afterCommit = false) {
    const calls = [];
    for (const [name, store] of h.state.containers) {
        const original = store.getBlockBlobClient.bind(store);
        store.getBlockBlobClient = key => {
            const blob = original(key);
            for (const method of ['uploadData', 'delete', 'deleteIfExists']) {
                const action = blob[method].bind(blob);
                blob[method] = async (...args) => {
                    calls.push({ name, key, method });
                    if (method === 'uploadData' && failKey(name, key)) {
                        if (afterCommit) await action(...args);
                        throw new Error(PRIVATE);
                    }
                    return action(...args);
                };
            }
            return blob;
        };
    }
    return calls;
}
function retained(h, prefix) {
    return [...h.getContainer('external-starter-authority').records]
        .filter(([key]) => key.startsWith(prefix)).map(([key, bytes]) => [key, Buffer.from(bytes)]);
}
function expectRetained(h, entries) {
    for (const [key, bytes] of entries) expect(h.getContainer('external-starter-authority').records.get(key)).toEqual(bytes);
}
async function expectReadOnly(h, cookie) {
    const before = snapshot(h), calls = observeStorage(h);
    const state = await load(h, cookie);
    expect(snapshot(h)).toBe(before); expect(calls).toEqual([]);
    return state;
}

test('an interrupted schedule archive exposes retained setup instead of a blank immutable form', async () => {
    const h = fixture(), s = await session(h); let fault = true;
    observeStorage(h, (name, key) => fault && name.endsWith('/external-starter-authority') && key.startsWith('customer-schedules/'));
    const failed = await post(h, s.cookie, s.csrf, INPUT);
    expect(failed.status).toBe(503); expect(failed.text).not.toContain(PRIVATE);
    expect(retained(h, 'customer-starter/starter-setups/')).toHaveLength(1);
    expect(retained(h, 'customer-subjects/')).toHaveLength(0); fault = false;
    const state = await expectReadOnly(h, s.cookie);
    expect(state.status).toBe(200);
    expect(state.body.state).toEqual({ status: 'resume_setup', email: h.state.externalEmail,
        accountType: INPUT.accountType, organisationName: INPUT.organisationName });
});

const FAULTS = {
    archive: key => key.startsWith('customer-schedules/'),
    offer: key => key.startsWith('customer-term-offers/'),
    claim: key => key.startsWith('customer-starter/external-claims/') && !key.endsWith('.complete.json'),
    context: key => key.startsWith('customer-starter/contexts/'),
    authority: key => key.startsWith('customer-subjects/'),
    completion: key => key.startsWith('customer-starter/external-claims/') && key.endsWith('.complete.json')
};
async function interrupted(kind, afterCommit = false) {
    const h = fixture(), s = await session(h), fault = { active: true, hits: 0 };
    observeStorage(h, (name, key) => {
        if (!fault.active || !name.endsWith('/external-starter-authority') || !FAULTS[kind](key)) return false;
        fault.hits++; return true;
    }, afterCommit);
    const failed = await post(h, s.cookie, s.csrf, INPUT);
    // The existing exact archive writer can acknowledge a lost ACK only after
    // readback proves its committed bytes. Other phases stop for reconciliation.
    expect(failed.status).toBe(afterCommit && ['archive', 'offer'].includes(kind) ? 200 : 503);
    expect(fault.hits).toBeGreaterThan(0);
    expect(failed.text).not.toContain(PRIVATE); expect(failed.headers['set-cookie']).toBeUndefined();
    expect(retained(h, 'customer-starter/starter-accounts/')).toHaveLength(1);
    expect(retained(h, 'customer-starter/starter-setups/')).toHaveLength(1);
    fault.active = false;
    return { h, s, failed };
}

test.each(Object.keys(FAULTS).flatMap(kind => [[kind, false], [kind, true]]))(
    'explicit resume after %s failure (committed=%s) preserves every original durable record and is repeatable', async (kind, committed) => {
        const { h, s } = await interrupted(kind, committed), before = retained(h, '');
        const state = await expectReadOnly(h, s.cookie);
        const complete = [...h.getContainer('external-starter-authority').records.keys()].some(key => key.endsWith('.complete.json'));
        expect(state.status).toBe(200);
        expect(state.body.state.status).toBe(complete ? 'continue_authentication' : 'resume_setup');
        const csrf = state.body.csrfToken || s.csrf;
        const resumed = await post(h, s.cookie, csrf, { resume: true });
        expect(resumed.status).toBe(200); expect(resumed.body.state).toEqual({ status: 'continue_authentication' });
        expectRetained(h, before);
        const completed = snapshot(h);
        const repeated = await post(h, s.cookie, csrf, { resume: true });
        expect(repeated.status).toBe(200); expect(repeated.body).toEqual(resumed.body);
        expect(snapshot(h)).toBe(completed);
        expect(retained(h, 'customer-starter/starter-accounts/')).toHaveLength(1);
        expect(retained(h, 'customer-starter/starter-setups/')).toHaveLength(1);
        expect(retained(h, 'customer-subjects/')).toHaveLength(1);
        expect(h.pool.registrations.size).toBe(0); expect(h.pool.receipts.size).toBe(0);
    });

test.each(['archive', 'claim', 'context', 'authority', 'completion'])('a fresh same-subject SID resumes %s failure using the original declaration and IDs', async kind => {
    const { h, s } = await interrupted(kind), before = retained(h, '');
    const fresh = await h.loginExternal(s.cookie); expect(fresh.response.status).toBe(303); expect(fresh.cookie).not.toBe(s.cookie);
    const state = await expectReadOnly(h, fresh.cookie);
    expect(state.body.state).toEqual({ status: 'resume_setup', email: h.state.externalEmail,
        accountType: INPUT.accountType, organisationName: INPUT.organisationName });
    const resumed = await post(h, fresh.cookie, state.body.csrfToken, { resume: true });
    expect(resumed.status).toBe(200); expect(resumed.body.state).toEqual({ status: 'continue_authentication' });
    expectRetained(h, before);
    const saved = JSON.parse(retained(h, 'customer-starter/starter-setups/')[0][1]);
    expect(saved.offerInput.contact).toEqual({ name: INPUT.details.name, role: INPUT.details.role,
        address: INPUT.details.address, registrationId: null, email: h.state.externalEmail,
        authorityEvidenceId: saved.representativeEvidenceId });
    expect(h.pool.registrations.size).toBe(0); expect(h.pool.receipts.size).toBe(0);
});

test.each(['missing', 'expired', 'malformed', 'duplicate'])('a %s external SID does not become a storage error or discard saved setup', async kind => {
    const { h, s } = await interrupted('archive'), auth = h.getContainer('nofries-browser-auth').records;
    const ownKey = sidKey(s.cookie), before = retained(h, '');
    let presented = s.cookie;
    if (kind === 'missing') auth.delete(ownKey);
    if (kind === 'expired') {
        const record = JSON.parse(auth.get(ownKey)); record.absoluteExpiresAt = h.state.now - 1;
        auth.set(ownKey, Buffer.from(JSON.stringify(record)));
    }
    if (kind === 'malformed') presented = '__Host-nofries-external-customer=not-an-opaque-session';
    if (kind === 'duplicate') presented += '; ' + s.cookie;
    const writes = observeStorage(h), sql = JSON.stringify({ registrations: [...h.pool.registrations], receipts: [...h.pool.receipts] });
    const state = await load(h, presented + '; __Host-nofries-external-customer-tx=' + 'x'.repeat(43));
    expect(state.status).toBe(401); expect(state.body.code).toBe('signup_signin_required');
    expect(state.headers['set-cookie']).toHaveLength(1);
    expect(state.headers['set-cookie'][0]).toMatch(/^__Host-nofries-external-customer=;/);
    expect(state.headers['set-cookie'][0]).toContain('Max-Age=0');
    expect(writes.every(call => call.name.endsWith('/nofries-browser-auth') && call.key === ownKey && ['delete', 'deleteIfExists'].includes(call.method))).toBe(true);
    expectRetained(h, before);
    expect(JSON.stringify({ registrations: [...h.pool.registrations], receipts: [...h.pool.receipts] })).toBe(sql);
});

test('an authentication-store read failure stays503 and withholds every cookie clear', async () => {
    const { h, s } = await interrupted('archive'), store = h.getContainer('nofries-browser-auth');
    const original = store.getBlockBlobClient.bind(store);
    store.getBlockBlobClient = key => {
        const blob = original(key);
        if (key === sidKey(s.cookie)) blob.download = async () => { throw new Error(PRIVATE); };
        return blob;
    };
    const state = await expectReadOnly(h, s.cookie);
    expect(state.status).toBe(503); expect(state.body.code).toBe('signup_unavailable');
    expect(state.headers['set-cookie']).toBeUndefined(); expect(state.text).not.toContain(PRIVATE);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(PRIVATE);
});

test.each(['ContainerNotFound', 'UnknownNamespaceFailure', undefined, 'BlobNotFound'])(
    'cached authentication namespace404 code=%s is distinguished from a confirmed absent SID', async code => {
        const h = fixture(), store = h.getContainer('nofries-browser-auth');
        const properties = jest.spyOn(store, 'getProperties'), s = await session(h);
        expect(properties).toHaveBeenCalled(); // The same adapter already qualified and cached its container.
        properties.mockClear();
        const original = store.getBlockBlobClient.bind(store);
        store.getBlockBlobClient = key => {
            const blob = original(key);
            if (key === sidKey(s.cookie)) blob.download = async () => { throw Object.assign(new Error(PRIVATE),
                { statusCode: 404, ...(code === undefined ? {} : { code }) }); };
            return blob;
        };
        const state = await expectReadOnly(h, s.cookie);
        expect(properties).not.toHaveBeenCalled();
        expect(state.status).toBe(code === 'BlobNotFound' ? 401 : 503);
        expect(state.body.code).toBe(code === 'BlobNotFound' ? 'signup_signin_required' : 'signup_unavailable');
        if (code === 'BlobNotFound') {
            expect(state.headers['set-cookie']).toHaveLength(1);
            expect(state.headers['set-cookie'][0]).toMatch(/^__Host-nofries-external-customer=;/);
        } else expect(state.headers['set-cookie']).toBeUndefined();
        expect(state.text).not.toContain(PRIVATE); expect(state.text).not.toContain(code || 'UnknownNamespaceFailure');
        expect(JSON.stringify(warn.mock.calls)).not.toContain(PRIVATE);
    });

test.each(['incomplete claim', 'published authority', 'completed claim'])(
    'missing declaration with %s stops both status and a full new declaration before any write', async history => {
        let h, s;
        if (history === 'completed claim') {
            h = fixture(); s = await session(h); expect((await post(h, s.cookie, s.csrf, INPUT)).status).toBe(200);
        } else ({ h, s } = await interrupted(history === 'incomplete claim' ? 'context' : 'completion'));
        const store = h.getContainer('external-starter-authority').records;
        const [key] = retained(h, 'customer-starter/starter-setups/')[0]; store.delete(key);
        const state = await expectReadOnly(h, s.cookie);
        expect(state.status).toBe(503); expect(state.body.code).toBe('signup_unavailable');
        expect(state.text).not.toContain(INPUT.organisationName); expect(state.headers['set-cookie']).toBeUndefined();
        const before = snapshot(h), writes = observeStorage(h);
        const denied = await post(h, s.cookie, s.csrf, INPUT);
        expect(denied.status).toBe(503); expect(snapshot(h)).toBe(before); expect(writes).toEqual([]);
    });

test('changed authority under an incomplete claim prevents archive restoration through either resume or full input', async () => {
    const { h, s } = await interrupted('completion'), store = h.getContainer('external-starter-authority').records;
    const [key, bytes] = retained(h, 'customer-subjects/')[0], changed = JSON.parse(bytes); changed.revision++;
    expect(() => require('../api/shared/customerSignup/customerAuthority').authority(changed, changed.subjectKey, h.state.now)).not.toThrow();
    store.set(key, Buffer.from(JSON.stringify(changed)));
    store.delete(retained(h, 'customer-schedules/')[0][0]);
    const state = await expectReadOnly(h, s.cookie);
    expect(state.status).toBe(503); expect(state.headers['set-cookie']).toBeUndefined();
    const before = snapshot(h), writes = observeStorage(h);
    for (const body of [{ resume: true }, INPUT]) {
        const denied = await post(h, s.cookie, s.csrf, body);
        expect(denied.status).toBe(503); expect(snapshot(h)).toBe(before); expect(writes).toEqual([]);
    }
});

test('an activated account missing authority cannot be edited or restore archives before its failure', async () => {
    const h = fixture(), s = await session(h);
    expect((await post(h, s.cookie, s.csrf, INPUT)).status).toBe(200);
    const store = h.getContainer('external-starter-authority').records;
    const [accountKey, bytes] = retained(h, 'customer-starter/starter-accounts/')[0], account = JSON.parse(bytes);
    const activatedAt = new Date(h.state.now).toISOString();
    account.activation = { subjectKey: account.identitySubjectKey, receiptId: uid(900), activatedAt,
        validUntil: require('../api/shared/customerSignup/customerStarterPlan').accountWindow(activatedAt).validUntil };
    expect(() => require('../api/shared/customerSignup/starterAccountAllocation').starterAccountRecord(account)).not.toThrow();
    store.set(accountKey, Buffer.from(JSON.stringify(account)));
    store.delete(retained(h, 'customer-subjects/')[0][0]); store.delete(retained(h, 'customer-schedules/')[0][0]);
    const state = await expectReadOnly(h, s.cookie);
    expect(state.status).toBe(503); expect(state.headers['set-cookie']).toBeUndefined();
    const before = snapshot(h), writes = observeStorage(h);
    const denied = await post(h, s.cookie, s.csrf, INPUT);
    expect(denied.status).toBe(503); expect(snapshot(h)).toBe(before); expect(writes).toEqual([]);
});

test('an ambiguous durable-details read is not presented as an absent reservation or signed-out session', async () => {
    const { h, s } = await interrupted('archive'), store = h.getContainer('external-starter-authority');
    const original = store.getBlockBlobClient.bind(store);
    store.getBlockBlobClient = key => {
        const blob = original(key);
        if (key.startsWith('customer-starter/starter-setups/')) blob.download = async () => { throw new Error(PRIVATE); };
        return blob;
    };
    const state = await expectReadOnly(h, s.cookie);
    expect(state.status).toBe(503); expect(state.body.code).toBe('signup_unavailable');
    expect(state.headers['set-cookie']).toBeUndefined(); expect(state.text).not.toContain(PRIVATE);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(PRIVATE);
});

test.each(['removed', 'changed'])('a completed claim with %s authority is never silently recreated', async change => {
    const h = fixture(), s = await session(h);
    expect((await post(h, s.cookie, s.csrf, INPUT)).status).toBe(200);
    const store = h.getContainer('external-starter-authority').records;
    const [key, bytes] = retained(h, 'customer-subjects/')[0];
    if (change === 'removed') store.delete(key);
    else { const changed = JSON.parse(bytes); changed.revision++; store.set(key, Buffer.from(JSON.stringify(changed))); }
    const state = await expectReadOnly(h, s.cookie);
    expect(state.status).toBe(503); expect(state.body.code).toBe('signup_unavailable');
    const before = snapshot(h), writes = observeStorage(h);
    const denied = await post(h, s.cookie, s.csrf, { resume: true });
    expect(denied.status).toBe(503); expect(snapshot(h)).toBe(before); expect(writes).toEqual([]);
});

test.each([
    { resume: true, details: INPUT.details }, { resume: true, accountType: 'company' },
    { resume: true, organisationName: 'Replacement organisation' }, { resume: false }, { resume: 'true' }
])('a resume request cannot supply or alter desired setup data: %j', async body => {
    const { h, s } = await interrupted('archive'), state = await load(h, s.cookie);
    const before = snapshot(h), writes = observeStorage(h);
    const rejected = await post(h, s.cookie, state.body.csrfToken, body);
    expect(rejected.status).toBe(400); expect(snapshot(h)).toBe(before); expect(writes).toEqual([]);
});

test.each(['changed details', 'changed account type', 'changed organisation'])('%s cannot replace an immutable partial declaration', async change => {
    const { h, s } = await interrupted('archive'), state = await load(h, s.cookie);
    const input = JSON.parse(JSON.stringify(INPUT));
    if (change === 'changed details') input.details.address = 'Different address';
    if (change === 'changed account type') input.accountType = 'company';
    if (change === 'changed organisation') input.organisationName = 'Different organisation';
    const before = snapshot(h), writes = observeStorage(h);
    const rejected = await post(h, s.cookie, state.body.csrfToken, input);
    expect(rejected.status).toBe(503); expect(rejected.text).not.toContain(PRIVATE);
    expect(snapshot(h)).toBe(before); expect(writes).toEqual([]);
});

test('another immutable subject with the same email cannot read or resume the retained setup', async () => {
    const { h } = await interrupted('archive'), before = retained(h, '');
    h.state.externalOid = uid(104);
    const foreign = await h.loginExternal(); expect(foreign.response.status).toBe(303);
    const state = await expectReadOnly(h, foreign.cookie);
    expect(state.status).toBe(503); expect(state.body.code).toBe('signup_unavailable');
    expect(state.text).not.toContain(INPUT.organisationName); expect(state.headers['set-cookie']).toBeUndefined();
    const writes = observeStorage(h), captured = snapshot(h);
    const denied = await post(h, foreign.cookie, 'x'.repeat(43), { resume: true });
    expect(denied.status).not.toBe(200); expect(snapshot(h)).toBe(captured); expect(writes).toEqual([]);
    expectRetained(h, before);
});

test.each(['origin', 'csrf', 'GET'])('partial setup resume retains the %s mutation boundary', async boundary => {
    const { h, s } = await interrupted('archive'), state = await load(h, s.cookie);
    const before = snapshot(h), writes = observeStorage(h);
    let req;
    if (boundary === 'GET') req = request(h.app).get(ROUTE + '/setup').set('Cookie', s.cookie);
    else req = request(h.app).post(ROUTE + '/setup').set('Cookie', s.cookie)
        .set('Origin', boundary === 'origin' ? 'https://untrusted.invalid' : h.env.NOFRIES_PUBLIC_URL)
        .set('Sec-Fetch-Site', boundary === 'origin' ? 'cross-site' : 'same-origin')
        .set('X-CSRF-Token', boundary === 'csrf' ? 'x'.repeat(43) : state.body.csrfToken).send({ resume: true });
    const denied = await req;
    expect(denied.status).toBe(boundary === 'GET' ? 404 : 403);
    expect(snapshot(h)).toBe(before); expect(writes).toEqual([]);
});

test('a reserved account without details exposes its fixed type and organisation without writing', async () => {
    const h = fixture(), s = await session(h); let fault = true;
    observeStorage(h, (name, key) => fault && name.endsWith('/external-starter-authority') && key.startsWith('customer-starter/starter-setups/'));
    expect((await post(h, s.cookie, s.csrf, INPUT)).status).toBe(503);
    expect(retained(h, 'customer-starter/starter-accounts/')).toHaveLength(1);
    expect(retained(h, 'customer-starter/starter-setups/')).toHaveLength(0); fault = false;
    const state = await expectReadOnly(h, s.cookie);
    expect(state.status).toBe(200);
    expect(state.body.state).toEqual({ status: 'setup_details', email: h.state.externalEmail,
        reservation: { accountType: INPUT.accountType, organisationName: INPUT.organisationName } });
});

test.each([false, true])('account-only reservation completion keeps original IDs with a fresh SID=%s', async freshSid => {
    const h = fixture(), s = await session(h); let fault = true;
    observeStorage(h, (name, key) => fault && name.endsWith('/external-starter-authority') && key.startsWith('customer-starter/starter-setups/'));
    expect((await post(h, s.cookie, s.csrf, INPUT)).status).toBe(503); fault = false;
    const before = retained(h, '');
    const cookie = freshSid ? (await h.loginExternal(s.cookie)).cookie : s.cookie;
    const state = await expectReadOnly(h, cookie);
    expect(state.body.state.reservation).toEqual({ accountType: INPUT.accountType, organisationName: INPUT.organisationName });
    const result = await post(h, cookie, state.body.csrfToken, INPUT);
    expect(result.status).toBe(200); expect(result.body.state).toEqual({ status: 'continue_authentication' });
    expectRetained(h, before);
    expect(retained(h, 'customer-starter/starter-accounts/')).toHaveLength(1);
    expect(retained(h, 'customer-starter/starter-setups/')).toHaveLength(1);
    expect(retained(h, 'customer-subjects/')).toHaveLength(1);
});

test('a foreign legacy SID under the external cookie remains untouched and receives no authentication clear', async () => {
    const h = fixture(), user = h.addUser(), legacy = await h.login(user);
    expect(legacy.response.status).toBe(303);
    const presented = '__Host-nofries-external-customer=' + legacy.cookie.split('=')[1];
    const state = await expectReadOnly(h, presented);
    expect(state.status).toBe(503); expect(state.body.code).toBe('signup_unavailable');
    expect(state.headers['set-cookie']).toBeUndefined();
});

test('a presented missing external session requests sign-in and clears only its SID', async () => {
    const h = fixture(), s = await session(h);
    h.getContainer('nofries-browser-auth').records.delete(sidKey(s.cookie));
    const state = await expectReadOnly(h, s.cookie);
    expect(state.status).toBe(401);
    expect(state.body).toEqual({ error: 'Signup is unavailable', code: 'signup_signin_required' });
    expect(state.headers['set-cookie']).toHaveLength(1);
    expect(state.headers['set-cookie'][0]).toMatch(/^__Host-nofries-external-customer=;/);
    expect(state.headers['set-cookie'][0]).toContain('Max-Age=0');
});

async function waitFor(predicate) {
    for (let i = 0; i < 200; i++) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('synthetic document did not settle');
}
function generatedDocument(h, cookie, hosted) {
    const source = { clientSource: fs.readFileSync('api/shared/customerSignup/signupClient.js', 'utf8'),
        journeySource: fs.readFileSync('api/shared/customerSignup/signupJourney.js', 'utf8') };
    const document = hosted ? buildHostedSignupDocument(source)
        : buildSignupDocument({ ...source, customerLogin: true, customerTransport: 'external' });
    const dom = createDom(), create = dom.document.createElement;
    dom.document.createElement = tag => Object.assign(create(tag), { style: {} });
    dom.document.getElementById = id => id === 'signup' ? dom.root : null;
    const assign = jest.fn(), replace = jest.fn(), listeners = {}, payloads = [];
    const fetch = jest.fn(async (url, options) => {
        let req = request(h.app)[options.method.toLowerCase()](url).set(options.headers).set('Cookie', cookie);
        if (options.body) { payloads.push(JSON.parse(options.body)); req = h.sameOrigin(req).send(JSON.parse(options.body)); }
        const response = await req;
        return new Response(response.text, { status: response.status, headers: response.headers });
    });
    vm.runInNewContext(document.runtime, { document: dom.document,
        window: { fetch, location: { search: '?provider=external', hash: '', assign, replace },
            addEventListener(name, fn) { listeners[name] = fn; } }, URLSearchParams, AbortController, TextDecoder, setTimeout, clearTimeout });
    const scriptHash = crypto.createHash('sha256').update(document.runtime).digest('base64');
    expect(document.contentSecurityPolicy).toContain(`script-src 'sha256-${scriptHash}'`);
    expect(document.contentSecurityPolicy).not.toContain("'unsafe-inline'");
    return { ...dom, fetch, assign, replace, payloads, dispose() { listeners.pagehide?.(); } };
}

test.each([false, true])('the generated hosted=%s page loads partial progress read-only and submits canonical resume only after one deliberate click', async hosted => {
    const { h, s } = await interrupted('archive'), before = retained(h, ''), captured = snapshot(h), writes = observeStorage(h);
    const page = generatedDocument(h, s.cookie, hosted);
    try {
        await waitFor(() => page.root.querySelector('h1')?.textContent === 'Resume your workspace setup');
        expect(snapshot(h)).toBe(captured); expect(writes).toEqual([]);
        expect(page.payloads).toEqual([]); expect(page.fetch.mock.calls).toHaveLength(1);
        expect(page.assign).not.toHaveBeenCalled(); expect(page.replace).not.toHaveBeenCalled();
        expect(page.root.textContent).toContain(INPUT.organisationName);
        expect(page.root.textContent).not.toContain(INPUT.details.name);
        expect(page.root.textContent).not.toContain(INPUT.details.address);
        expect(page.root.querySelectorAll('input')).toHaveLength(0);
        const resume = page.root.querySelectorAll('button').find(button => button.textContent === 'Resume workspace setup');
        expect(resume).toBeDefined();
        for (let i = 0; i < 2; i++) for (const click of resume.events.click) click({ preventDefault() {} });
        await waitFor(() => page.root.querySelector('h1')?.textContent === 'Continuing account setup');
        expect(page.payloads).toEqual([{ resume: true }]);
        expect(page.fetch.mock.calls.map(([url, options]) => [options.method, url])).toEqual([
            ['GET', ROUTE + '/state'], ['POST', ROUTE + '/setup']]);
        expect(page.assign).not.toHaveBeenCalled(); expect(page.replace).toHaveBeenCalledTimes(1);
        expect(page.replace).toHaveBeenCalledWith('/api/external-customer-auth/login');
        expectRetained(h, before); expect(h.pool.registrations.size).toBe(0); expect(h.pool.receipts.size).toBe(0);
    } finally { page.dispose(); }
});

test.each([false, true])('the generated hosted=%s page turns an actual missing-session401 into manual fixed sign-in choices without writes or an automatic loop', async hosted => {
    const { h, s } = await interrupted('archive'); h.getContainer('nofries-browser-auth').records.delete(sidKey(s.cookie));
    const before = snapshot(h), writes = observeStorage(h), page = generatedDocument(h, s.cookie, hosted);
    try {
        await waitFor(() => page.root.querySelector('h1')?.textContent === 'Sign in again');
        expect(snapshot(h)).toBe(before); expect(writes).toEqual([]); expect(page.payloads).toEqual([]);
        expect(page.fetch.mock.calls).toHaveLength(1);
        expect(page.assign).not.toHaveBeenCalled(); expect(page.replace).not.toHaveBeenCalled();
        const links = page.root.querySelectorAll('a');
        expect(links.map(link => link.href)).toEqual(['/api/external-customer-auth/login', '/api/external-customer-auth/login?account=choose']);
        expect(page.root.querySelectorAll('form')).toHaveLength(0);
        expect(page.root.textContent).toContain('Your saved setup and work are kept.');
        expect(page.root.textContent).not.toContain(INPUT.organisationName);
    } finally { page.dispose(); }
});
