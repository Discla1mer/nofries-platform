'use strict';

const crypto = require('node:crypto');
const request = require('supertest');
const { customerProductionHarness, signupSql } = require('./helpers/customerProductionHarness');
const { subjectHash, termsOfferKey, scheduleArchiveKey } = require('../api/shared/customerSignup/customerAuthority');
const { compileStarterProvisioning } = require('../api/shared/customerSignup/starterProvisioning');
const { canonicalDigest } = require('../api/shared/appLifecycle/dashboardOnboardingDomain');
const { prepareRecoveryAuthorization } = require('../api/shared/customerSignup/savedSignupRecovery');

// This whole-test allowance includes setup, sign-in, consent and its replay:
// nine serial HTTP requests. Runtime limits and negative-test defaults stay exact.
const SAVED_CONSENT_JOURNEY_TIMEOUT_MS = 20000;

const clone = value => JSON.parse(JSON.stringify(value));
const readJson = (container, key) => JSON.parse(container.records.get(key).toString());
const writeJson = (container, key, value) => container.records.set(key, Buffer.from(JSON.stringify(value)));
let warning;
beforeEach(() => {
    require('../api/shared/abuseProtection').resetAbuseProtectionForTests();
    warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => warning.mockRestore());

// Keep the general HTTP fixture's deliberate starter SQL failure unchanged.
// This local adapter represents a retained, inactive preparation only. The
// native PostgreSQL journey separately proves activation and dashboard access.
async function savedConsultant() {
    const pool = signupSql(), connect = pool.connect;
    const sqlState = { scope: null, queries: [] };
    pool.connect = async () => {
        const client = await connect();
        return { ...client, async query(sql, params = []) {
            sqlState.queries.push(sql);
            if (sql.startsWith('SELECT preparation,activation FROM nofries.dashboard_starter_scopes')) {
                const scope = sqlState.scope;
                const matches = scope && scope.preparation.scope.tenantId === params[0] &&
                    scope.preparation.scope.organisationId === params[1] && scope.preparation.subjectKey === params[2];
                return { rows: matches ? [clone(scope)] : [], rowCount: matches ? 1 : 0 };
            }
            return client.query(sql, params);
        } };
    };
    const h = customerProductionHarness({ starter: true, now: Date.now(), pool });
    const email = 'saved-consultant@example.invalid';
    h.state.directoryUsers = [{ id: h.state.oid, mail: email, userPrincipalName: email,
        otherMails: [], proxyAddresses: [], userType: 'Member', accountEnabled: true }];
    const start = await h.sameOrigin(request(h.app).post('/api/organisation-setup/request'))
        .send({ email, accountType: 'consultant', organisationName: 'Preserved synthetic Consultant workspace' });
    expect(start.status).toBe(202);
    const setupCookie = start.headers['set-cookie'][0].split(';')[0];
    const setup = action => h.sameOrigin(request(h.app).post('/api/organisation-setup/' + action))
        .set('Cookie', setupCookie).set('X-NoFries-Setup-Request', start.body.requestId);
    const code = h.state.delivered.find(value => value.kind === 'code').text.match(/\b[0-9]{8}\b/)[0];
    expect((await setup('verify').send({ code })).body.nextStep).toBe('details_required');
    expect((await setup('details').send({ name: 'Synthetic representative', role: 'Owner',
        address: 'Synthetic saved address', registrationId: '', authorityConfirmed: true })).status).toBe(503);

    const starter = h.getContainer('starter-authority');
    const authorityKey = [...starter.records.keys()].find(key => key.startsWith('customer-subjects/'));
    const authority = readJson(starter, authorityKey);
    const accountKey = [...starter.records.keys()].find(key => key.startsWith('customer-starter/starter-accounts/'));
    const account = readJson(starter, accountKey), slot = account.organisations[0];
    const contextKey = `customer-starter/contexts/${slot.organisationId}.json`, context = readJson(starter, contextKey);
    const preparation = compileStarterProvisioning({ account, requestId: slot.requestId, source: context.source });
    sqlState.scope = { preparation, activation: null };
    const invitationKey = `browser-auth/customer-signup/invitations/${authority.invitationDigest}.json`;
    const auth = h.getContainer('nofries-browser-auth');
    const invitation = readJson(auth, invitationKey);
    const delivered = h.state.delivered.filter(value => value.kind === 'member_invitation');
    expect(delivered).toHaveLength(1);
    const invitationToken = delivered[0].text.match(/#invitation=([A-Za-z0-9_-]{43})/)[1];
    const login = await h.login({ authority, invitationToken });
    expect(login.response.status).toBe(303);
    auth.records.delete(invitationKey);
    const approvalKey = `customer-signup-recoveries/${subjectHash(authority.subjectKey)}.json`;
    const approval = prepareRecoveryAuthorization({ context: { authority, accountId: account.accountId,
        preparationSha256: canonicalDigest(preparation), invitation, sessionId: crypto.randomBytes(32).toString('base64url'),
        verifiedAt: Date.now(), expiresAt: Date.now() + 3600000 }, approvalRef: 'synthetic-explicit-recovery-approval',
        approvedAt: Date.now(), expiresAt: Date.now() + 600000 });
    const approve = () => writeJson(h.getContainer('customer-authority'), approvalKey, approval);
    const get = () => request(h.app).get('/api/customer-signup/state').set('Cookie', login.cookie);
    const terms = { accepted: true, termsVersion: authority.termsVersion, termsDigest: authority.termsDigest,
        scheduleId: authority.scheduleId, scheduleDigest: authority.scheduleDigest };
    const post = (csrf, input = terms) => h.sameOrigin(request(h.app).post('/api/customer-signup/terms'))
        .set('Cookie', login.cookie).set('X-CSRF-Token', csrf || 'missing').send(input);
    const savedBytes = () => [...h.state.containers].flatMap(([name, container]) =>
        [...container.records].map(([key, bytes]) => [name, key, bytes.toString('base64')]));
    warning.mockClear();
    return { h, authority, authorityKey, account, accountKey, slot, preparation, contextKey, sqlState,
        starter, auth, invitation, invitationKey, approval, approvalKey, approve, login, get, post, terms, savedBytes };
}

test('missing invitation and no receipt still deny without separately approved recovery and preserve the saved Consultant', async () => {
    const f = await savedConsultant(), before = f.savedBytes();
    const response = await f.get();
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ state: { status: 'unavailable' } });
    expect(f.savedBytes()).toEqual(before);
    expect(f.h.pool.receipts.size).toBe(0); expect(f.h.pool.registrations.size).toBe(0);
    expect(f.h.state.delivered).toHaveLength(2);
});

test('explicit recovery offers the retained legal text without an invitation, receipt, registration or data write', async () => {
    const f = await savedConsultant(); f.approve();
    const before = f.savedBytes(), scope = clone(f.sqlState.scope);
    f.sqlState.queries.length = 0;
    const response = await f.get();
    expect(response.status).toBe(200);
    expect(response.body.state).toMatchObject({ status: 'terms', termsVersion: f.authority.termsVersion,
        termsDigest: f.authority.termsDigest, scheduleId: f.authority.scheduleId, scheduleDigest: f.authority.scheduleDigest });
    expect(response.body.state.termsText).toBe(f.h.termsText);
    expect(response.body.state.scheduleText).toContain('Preserved synthetic Consultant workspace');
    expect(response.body.csrfToken).toEqual(expect.any(String));
    expect(f.savedBytes()).toEqual(before); expect(f.sqlState.scope).toEqual(scope);
    expect(f.sqlState.queries.some(sql => /^(INSERT|UPDATE|DELETE)\b/.test(sql.trimStart()))).toBe(false);
    expect(f.h.pool.receipts.size).toBe(0); expect(f.h.pool.registrations.size).toBe(0);
    expect(f.auth.records.has(f.invitationKey)).toBe(false);
    expect(f.h.state.delivered).toHaveLength(2);
});

test('actual checked consent persists once with original identifiers even when downstream activation is unavailable', async () => {
    const f = await savedConsultant(); f.approve();
    const ready = await f.get(); expect(ready.body.state.status).toBe('terms');
    const before = f.savedBytes(), earliest = Date.now();
    const accepted = await f.post(ready.body.csrfToken);
    // The local SQL fixture deliberately cannot activate. Real activation and
    // dashboard access are exercised against restricted native PostgreSQL.
    expect(accepted.status).toBe(503);
    expect(f.h.pool.receipts.size).toBe(1); expect(f.h.pool.registrations.size).toBe(1);
    const receipt = [...f.h.pool.receipts.values()][0].receipt;
    expect(receipt).toEqual({ receiptId: f.approval.receiptId, invitationId: f.authority.invitationId,
        subjectKey: f.authority.subjectKey, tenantId: f.authority.tenantId, organisationId: f.authority.organisationId,
        termsVersion: f.authority.termsVersion, termsDigest: f.authority.termsDigest,
        scheduleId: f.authority.scheduleId, scheduleDigest: f.authority.scheduleDigest,
        acceptedAt: expect.any(Number), status: 'pending_admission', dashboardAccess: false });
    expect(receipt.acceptedAt).toBeGreaterThanOrEqual(earliest); expect(receipt.acceptedAt).toBeLessThanOrEqual(Date.now());
    const durable = clone([...f.h.pool.receipts]), registrations = clone([...f.h.pool.registrations]);
    expect((await f.post(ready.body.csrfToken)).status).toBe(503);
    expect([...f.h.pool.receipts]).toEqual(durable); expect([...f.h.pool.registrations]).toEqual(registrations);
    expect(f.savedBytes()).toEqual(before); expect(f.account.activation).toBeNull();
    expect(f.auth.records.has(f.invitationKey)).toBe(false); expect(f.h.state.delivered).toHaveLength(2);
}, SAVED_CONSENT_JOURNEY_TIMEOUT_MS);

test.each(['unchecked', 'changed schedule', 'missing csrf', 'foreign origin', 'resume without consent'])
('recovery does not fabricate consent for %s', async variant => {
    const f = await savedConsultant(); f.approve();
    const ready = await f.get(); expect(ready.body.state.status).toBe('terms');
    const before = f.savedBytes();
    let response;
    if (variant === 'foreign origin') response = await request(f.h.app).post('/api/customer-signup/terms')
        .set('Cookie', f.login.cookie).set('Origin', 'https://other.example.invalid').set('Sec-Fetch-Site', 'cross-site')
        .set('X-CSRF-Token', ready.body.csrfToken).send(f.terms);
    else if (variant === 'resume without consent') response = await f.h.sameOrigin(request(f.h.app).post('/api/customer-signup/resume'))
        .set('Cookie', f.login.cookie).set('X-CSRF-Token', ready.body.csrfToken).send({});
    else response = await f.post(variant === 'missing csrf' ? null : ready.body.csrfToken,
        { ...f.terms, ...(variant === 'unchecked' ? { accepted: false } : {}),
            ...(variant === 'changed schedule' ? { scheduleDigest: 'f'.repeat(64) } : {}) });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(f.h.pool.receipts.size).toBe(0); expect(f.h.pool.registrations.size).toBe(0);
    expect(f.savedBytes()).toEqual(before); expect(f.h.state.delivered).toHaveLength(2);
});

test.each(['expired approval', 'foreign account', 'foreign preparation', 'changed approval subject',
    'withdrawn offer', 'incomplete original attempt', 'changed retained binding', 'present revoked invitation'])
('approved recovery denies %s without new authority or consent writes', async variant => {
    const f = await savedConsultant();
    if (variant === 'expired approval') f.approval.expiresAt = f.approval.approvedAt;
    if (variant === 'foreign account') f.approval.accountId = crypto.randomUUID();
    if (variant === 'foreign preparation') f.approval.preparationSha256 = 'f'.repeat(64);
    if (variant === 'changed approval subject') f.approval.subjectKey = f.authority.subjectKey.split(':')[0] + ':' + crypto.randomUUID();
    if (variant === 'withdrawn offer') {
        const key = termsOfferKey(f.authority.tenantId, f.authority.organisationId), offer = readJson(f.starter, key);
        writeJson(f.starter, key, { ...offer, status: 'withdrawn' });
    }
    if (variant === 'incomplete original attempt') {
        const key = `customer-invitation-attempts/${f.slot.requestId}.json`, attempt = readJson(f.starter, key);
        writeJson(f.starter, key, { ...attempt, phase: 'delivering' });
    }
    if (variant === 'changed retained binding') {
        const changed = clone(f.account); changed.organisations[0].bindingId = crypto.randomUUID();
        writeJson(f.starter, f.accountKey, changed);
    }
    if (variant === 'present revoked invitation') writeJson(f.auth, f.invitationKey,
        { ...f.invitation, status: 'revoked', revision: f.invitation.revision + 1 });
    f.approve(); const before = f.savedBytes();
    const response = await f.get();
    expect(response.body.state?.status).not.toBe('terms');
    expect(response.body.state?.status).not.toBe('continue_to_dashboard');
    expect(f.h.pool.receipts.size).toBe(0); expect(f.h.pool.registrations.size).toBe(0);
    expect(f.savedBytes()).toEqual(before); expect(f.h.state.delivered).toHaveLength(2);
});

test.each(['approval withdrawn', 'offer withdrawn', 'authority changed'])
('terms displayed before %s cannot authorize a later consent write', async variant => {
    const f = await savedConsultant(); f.approve();
    const ready = await f.get(); expect(ready.body.state.status).toBe('terms');
    if (variant === 'approval withdrawn') writeJson(f.h.getContainer('customer-authority'), f.approvalKey,
        { ...f.approval, status: 'withdrawn' });
    if (variant === 'offer withdrawn') {
        const key = termsOfferKey(f.authority.tenantId, f.authority.organisationId), offer = readJson(f.starter, key);
        writeJson(f.starter, key, { ...offer, status: 'withdrawn' });
    }
    if (variant === 'authority changed') writeJson(f.starter, f.authorityKey,
        { ...f.authority, revision: f.authority.revision + 1 });
    const before = [...f.starter.records].map(([key, bytes]) => [key, bytes.toString('base64')]);
    expect((await f.post(ready.body.csrfToken)).status).toBeGreaterThanOrEqual(400);
    expect(f.h.pool.receipts.size).toBe(0); expect(f.h.pool.registrations.size).toBe(0);
    expect([...f.starter.records].map(([key, bytes]) => [key, bytes.toString('base64')])).toEqual(before);
    expect(f.h.state.delivered).toHaveLength(2);
});

test('an offer expiring during archive download cannot authorize consent using time sampled before the read', async () => {
    const f = await savedConsultant(); f.approve();
    const offerKey = termsOfferKey(f.authority.tenantId, f.authority.organisationId);
    writeJson(f.starter, offerKey, { ...readJson(f.starter, offerKey), expiresAt: Date.now() + 60000 });
    const ready = await f.get(); expect(ready.body.state.status).toBe('terms');
    const before = f.savedBytes(), archiveKey = scheduleArchiveKey(f.authority.scheduleId, f.authority.scheduleDigest);
    const original = f.starter.getBlockBlobClient;
    let archiveReads = 0;
    f.starter.getBlockBlobClient = key => {
        const blob = original(key);
        if (key !== archiveKey) return blob;
        return { ...blob, async download(...args) {
            const result = await blob.download(...args);
            archiveReads++; f.h.state.clockOffset = 61000;
            return result;
        } };
    };
    expect((await f.post(ready.body.csrfToken)).status).toBe(503);
    expect(archiveReads).toBeGreaterThan(0);
    expect(f.h.pool.receipts.size).toBe(0); expect(f.h.pool.registrations.size).toBe(0);
    expect(f.savedBytes()).toEqual(before); expect(f.h.state.delivered).toHaveLength(2);
});
