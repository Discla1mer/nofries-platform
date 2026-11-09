'use strict';

const request = require('supertest');
const { customerProductionHarness } = require('./helpers/customerProductionHarness');
const { createProductionApplication } = require('../lib/productionApplication');

let warning;
beforeEach(() => { require('../api/shared/abuseProtection').resetAbuseProtectionForTests(); warning = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { warning.mockRestore(); });
const events = () => warning.mock.calls.map(([line]) => JSON.parse(line));
function expectPrivate(eventsSeen, user, cookie, response, workspaceRead) {
    const reference = response.headers['x-nofries-support-reference'];
    expect(reference).toHaveLength(19); expect(reference).toMatch(/^NF-[A-F0-9]{16}$/);
    for (const event of eventsSeen) {
        expect(Object.keys(event)).toEqual(['timestamp', 'code', 'stage', 'supportReference', ...(workspaceRead ? ['workspaceRead'] : [])]);
        if (workspaceRead) expect(event.workspaceRead).toEqual(workspaceRead);
        expect(event.supportReference).toBe(reference);
        expect(new Date(event.timestamp).toISOString()).toBe(event.timestamp);
    }
    const text = JSON.stringify(eventsSeen);
    for (const secret of [user.invitationToken, user.authority.email, user.authority.subjectKey,
        user.authority.invitationDigest, user.authority.organisationId, cookie, 'synthetic-provider-secret']) {
        expect(text).not.toContain(secret);
    }
}

async function savedConsultantOwnWorkspace() {
    const h = customerProductionHarness({ starter: true, now: Date.now() });
    const email = 'synthetic-consultant@example.invalid';
    h.state.directoryUsers = [{ id: h.state.oid, mail: email, userPrincipalName: email,
        otherMails: [], proxyAddresses: [], userType: 'Member', accountEnabled: true }];
    const start = await h.sameOrigin(request(h.app).post('/api/organisation-setup/request'))
        .send({ email, accountType: 'consultant', organisationName: 'Synthetic consultant workspace' });
    expect(start.status).toBe(202);
    const setupCookie = start.headers['set-cookie'][0].split(';')[0];
    const post = action => h.sameOrigin(request(h.app).post('/api/organisation-setup/' + action))
        .set('Cookie', setupCookie).set('X-NoFries-Setup-Request', start.body.requestId);
    expect((await post('verify').send({ code: h.state.delivered[0].text.match(/\b[0-9]{8}\b/)[0] })).body.nextStep).toBe('details_required');
    // Genuine source composition saves the own-slot account, completed delivery
    // and authority before the synthetic SQL fixture rejects preparation.
    expect((await post('details').send({ name: 'Synthetic representative', role: 'Owner',
        address: 'Synthetic address', registrationId: '', authorityConfirmed: true })).status).toBe(503);
    const authorityEntry = [...h.getContainer('starter-authority').records].find(([key]) => key.startsWith('customer-subjects/'));
    expect(authorityEntry).toBeDefined();
    const authority = JSON.parse(authorityEntry[1].toString());
    const deliveries = h.state.delivered.filter(value => value.kind === 'member_invitation');
    expect(deliveries).toHaveLength(1);
    const user = { authority, invitationToken: deliveries[0].text.match(/#invitation=([A-Za-z0-9_-]{43})/)[1] };
    const login = await h.login(user);
    expect(login.response.status).toBe(303);
    warning.mockClear();
    return { h, user, login };
}

test('Consultant own-workspace state retains the safe account-store failure code without repeating saved setup', async () => {
    const { h, user, login } = await savedConsultantOwnWorkspace();
    const container = h.getContainer('starter-authority');
    const before = [...container.records].map(([key, bytes]) => [key, bytes.toString('base64')]);
    const original = container.getBlockBlobClient;
    let reads = 0;
    container.getBlockBlobClient = key => {
        const blob = original(key);
        if (!key.startsWith('customer-starter/starter-accounts/')) return blob;
        return { ...blob, async download() { reads++; throw new Error('synthetic-provider-secret'); } };
    };
    const response = await request(h.app).get('/api/customer-signup/state').set('Cookie', login.cookie);
    expect(reads).toBe(1);
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'Signup is unavailable', code: 'signup_unavailable' });
    const workspaceRead = { phase: 'passive_starter', checkpoint: 'account_match' };
    expect(events()).toEqual([{ timestamp: expect.any(String), code: 'starter_store_unavailable', stage: 'organisation_preparation', supportReference: response.headers['x-nofries-support-reference'], workspaceRead }]);
    expectPrivate(events(), user, login.cookie, response, workspaceRead);
    expect([...container.records].map(([key, bytes]) => [key, bytes.toString('base64')])).toEqual(before);
    expect(h.state.delivered).toHaveLength(2);
    expect(h.pool.receipts.size).toBe(0); expect(h.pool.registrations.size).toBe(0);
});

test.each([
    ['connection', 'postgres_connection_failed', 'scope_transaction'],
    ['begin', 'postgres_begin_failed', 'scope_transaction'],
    ['query', 'postgres_query_failed', 'scope_query'],
    ['rollback', 'postgres_rollback_failed', 'scope_query'],
    ['commit', 'postgres_commit_failed', 'scope_transaction_completion'],
    ['decode', 'onboarding_input_invalid', 'preparation_decode']
])('Consultant workspace %s failure preserves the original error and safe read checkpoint', async (boundary, code, checkpoint) => {
    const { h, user, login } = await savedConsultantOwnWorkspace();
    const connect = h.pool.connect;
    const before = [...h.getContainer('starter-authority').records].map(([key, bytes]) => [key, bytes.toString('base64')]);
    let failures = 0;
    h.pool.connect = async () => {
        if (boundary === 'connection') { failures++; throw new Error('synthetic-provider-secret'); }
        const client = await connect();
        return { ...client, async query(sql, params) {
            if (boundary === 'begin' && sql === 'BEGIN' || boundary === 'commit' && sql === 'COMMIT' ||
                boundary === 'rollback' && sql === 'ROLLBACK') { failures++; throw new Error('synthetic-provider-secret'); }
            if (sql.startsWith('SELECT preparation,activation FROM nofries.dashboard_starter_scopes')) {
                if (['query', 'rollback'].includes(boundary)) { failures++; throw new Error('synthetic-provider-secret'); }
                if (boundary === 'decode') { failures++; return { rows: [{ preparation: {}, activation: null }] }; }
                return { rows: [] };
            }
            return client.query(sql, params);
        } };
    };
    const response = await request(h.app).get('/api/customer-signup/state').set('Cookie', login.cookie);
    expect(failures).toBe(boundary === 'rollback' ? 2 : 1);
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'Signup is unavailable', code: 'signup_unavailable' });
    const workspaceRead = { phase: 'passive_starter', checkpoint };
    expect(events()).toEqual([{ timestamp: expect.any(String), code, stage: 'organisation_preparation', supportReference: response.headers['x-nofries-support-reference'], workspaceRead }]);
    expectPrivate(events(), user, login.cookie, response, workspaceRead);
    expect([...h.getContainer('starter-authority').records].map(([key, bytes]) => [key, bytes.toString('base64')])).toEqual(before);
    expect(h.state.delivered).toHaveLength(2);
    expect(h.pool.receipts.size).toBe(0); expect(h.pool.registrations.size).toBe(0);
});

test('production state logs the swallowed terms failure while retaining the exact public state and manual consent', async () => {
    const h = customerProductionHarness(), user = h.addUser(), login = await h.login(user);
    const ready = await request(h.app).get('/api/customer-signup/state').set('Cookie', login.cookie);
    expect(ready.body.state.status).toBe('terms');
    expect(warning).not.toHaveBeenCalled();
    user.withdrawOffer();
    const response = await request(h.app).get('/api/customer-signup/state').set('Cookie', login.cookie);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ state: { status: 'unavailable' } });
    expect(events()).toEqual([{ timestamp: expect.any(String), code: 'signup_terms_unavailable', stage: 'terms_offer', supportReference: response.headers['x-nofries-support-reference'] }]);
    expectPrivate(events(), user, login.cookie, response);
    expect(h.pool.receipts.size).toBe(0); expect(h.pool.registrations.size).toBe(0);
});

test('a missing invitation without durable consent logs the precise continuation failure without recreating it', async () => {
    const h = customerProductionHarness(), user = h.addUser(), login = await h.login(user);
    user.deleteBootstrap();
    const authRecords = h.getContainer('nofries-browser-auth').records;
    const beforeKeys = [...authRecords.keys()];
    const response = await request(h.app).get('/api/customer-signup/state').set('Cookie', login.cookie);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ state: { status: 'unavailable' } });
    expect(events()).toEqual([
        { timestamp: expect.any(String), code: 'signup_continuation_unavailable', stage: 'continuation_receipt', supportReference: response.headers['x-nofries-support-reference'] },
        { timestamp: expect.any(String), code: 'signup_continuation_unavailable', stage: 'signup_continuation', supportReference: response.headers['x-nofries-support-reference'] }
    ]);
    expectPrivate(events(), user, login.cookie, response);
    expect([...authRecords.keys()]).toEqual(beforeKeys);
    expect(h.pool.receipts.size).toBe(0); expect(h.pool.registrations.size).toBe(0);
});

test('production state logs an outer organisation preparation failure but keeps the generic HTTP error', async () => {
    const h = customerProductionHarness(), user = h.addUser(), login = await h.login(user);
    h.pool.connect = async () => { throw new Error('synthetic-provider-secret'); };
    const response = await request(h.app).get('/api/customer-signup/state').set('Cookie', login.cookie);
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'Signup is unavailable', code: 'signup_unavailable' });
    const workspaceRead = { phase: 'passive_state', checkpoint: 'passive_journal' };
    expect(events()).toEqual([{ timestamp: expect.any(String), code: 'signup_acceptance_journal_unavailable', stage: 'organisation_preparation', supportReference: response.headers['x-nofries-support-reference'], workspaceRead }]);
    expectPrivate(events(), user, login.cookie, response, workspaceRead);
    expect(h.pool.receipts.size).toBe(0); expect(h.pool.registrations.size).toBe(0);
});

test('production state observes an asynchronous projection rejection after identity rechecks without admitting the user', async () => {
    const h = customerProductionHarness(), user = h.addUser(), login = await h.login(user);
    expect((await h.consent(login.cookie)).response.body.state.status).toBe('pending_admission');
    let policies = 0;
    h.state.changePolicy = policy => { if (++policies === 5) policy.state = 'disabled'; };
    const response = await request(h.app).get('/api/customer-signup/state').set('Cookie', login.cookie);
    expect(policies).toBe(5);
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'Signup is unavailable', code: 'signup_unavailable' });
    expect(events()).toEqual([{ timestamp: expect.any(String), code: 'browser_auth_customer_mfa_required', stage: 'admission_projection', supportReference: response.headers['x-nofries-support-reference'] }]);
    expectPrivate(events(), user, login.cookie, response);
    expect(h.pool.receipts.size).toBe(1); expect(h.pool.registrations.size).toBe(1);
});

test('a failing production diagnostic sink cannot change the failed customer state', async () => {
    const h = customerProductionHarness(), user = h.addUser(), login = await h.login(user);
    const signupDiagnostics = jest.fn(() => { throw new Error('synthetic-provider-secret'); });
    const app = createProductionApplication(h.env, { ...h.dependencies, signupDiagnostics });
    user.withdrawOffer();
    const response = await request(app).get('/api/customer-signup/state').set('Cookie', login.cookie);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ state: { status: 'unavailable' } });
    expect(signupDiagnostics).toHaveBeenCalledTimes(1);
    expect(Object.isFrozen(signupDiagnostics.mock.calls[0][0])).toBe(true);
    expectPrivate(signupDiagnostics.mock.calls.map(([event]) => event), user, login.cookie, response);
    expect(warning).not.toHaveBeenCalled();
    expect(h.pool.receipts.size).toBe(0); expect(h.pool.registrations.size).toBe(0);
});


// These are fault reproductions, not evidence that a fault occurred in production.
// Exercise the real HTTP composition and codecs with synthetic storage responses.
function savedPreparation(h) {
    const entries = [...h.getContainer('starter-authority').records];
    const account = JSON.parse(entries.find(([key]) => key.startsWith('customer-starter/starter-accounts/'))[1]);
    const context = JSON.parse(entries.find(([key]) => key.startsWith('customer-starter/contexts/'))[1]);
    return require('../api/shared/customerSignup/starterProvisioning').compileStarterProvisioning({
        account, requestId: account.organisations[0].requestId, source: context.source,
        ...(Object.hasOwn(context, 'slot') ? { slot: context.slot } : {}) });
}

test.each([
    ['missing account', 'account_match', 'signup_state_unavailable'],
    ['context transport', 'retained_preparation', 'signup_state_unavailable'],
    ['malformed context JSON', 'retained_preparation', 'signup_state_unavailable'],
    ['missing context', 'retained_preparation', 'signup_state_unavailable'],
    ['context account mismatch', 'retained_preparation', 'signup_state_unavailable'],
    ['duplicate scope rows', 'scope_cardinality', 'signup_state_unavailable'],
    ['inconsistent preparation', 'preparation_decode', 'signup_state_unavailable'],
    ['scope binding mismatch', 'preparation_match', 'signup_state_unavailable'],
    ['malformed activation', 'activation_decode', 'onboarding_input_invalid']
])('root-cause reproduction: %s', async (fault, checkpoint, code) => {
    const { h, user, login } = await savedConsultantOwnWorkspace();
    const container = h.getContainer('starter-authority'), preparation = savedPreparation(h);
    const accountKey = [...container.records.keys()].find(key => key.startsWith('customer-starter/starter-accounts/'));
    const contextKey = [...container.records.keys()].find(key => key.startsWith('customer-starter/contexts/'));
    if (fault === 'missing account') container.records.delete(accountKey);
    if (fault === 'missing context') container.records.delete(contextKey);
    if (fault === 'malformed context JSON') container.records.set(contextKey, Buffer.from('{'));
    if (fault === 'context account mismatch') {
        const context = JSON.parse(container.records.get(contextKey));
        context.accountId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
        container.records.set(contextKey, Buffer.from(JSON.stringify(context)));
    }
    const original = container.getBlockBlobClient;
    let injected = 0;
    container.getBlockBlobClient = key => {
        const blob = original(key);
        if (fault !== 'context transport' || key !== contextKey) return blob;
        return { ...blob, async download() { injected++; throw new Error('synthetic-provider-secret'); } };
    };
    const connect = h.pool.connect;
    h.pool.connect = async () => {
        const client = await connect();
        return { ...client, async query(sql, params) {
            if (!sql.startsWith('SELECT preparation,activation FROM nofries.dashboard_starter_scopes')) return client.query(sql, params);
            injected++;
            const p = JSON.parse(JSON.stringify(preparation));
            if (fault === 'inconsistent preparation') p.email = 'other@example.invalid';
            if (fault === 'scope binding mismatch') p.slot.bindingId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
            const row = { preparation: p, activation: fault === 'malformed activation' ? {} : null };
            return { rows: fault === 'duplicate scope rows' ? [row, row] : [row] };
        } };
    };
    const before = [...container.records].map(([key, bytes]) => [key, bytes.toString('base64')]);
    const response = await request(h.app).get('/api/customer-signup/state').set('Cookie', login.cookie);
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'Signup is unavailable', code: 'signup_unavailable' });
    const workspaceRead = { phase: 'passive_starter', checkpoint };
    expect(events()).toEqual([{ timestamp: expect.any(String), code, stage: 'organisation_preparation',
        supportReference: response.headers['x-nofries-support-reference'], workspaceRead }]);
    expectPrivate(events(), user, login.cookie, response, workspaceRead);
    if (fault === 'context transport' || checkpoint.startsWith('scope_') || ['preparation_decode', 'preparation_match', 'activation_decode'].includes(checkpoint)) expect(injected).toBe(1);
    expect([...container.records].map(([key, bytes]) => [key, bytes.toString('base64')])).toEqual(before);
    expect(h.state.delivered).toHaveLength(2);
    expect(h.pool.receipts.size).toBe(0); expect(h.pool.registrations.size).toBe(0);
});

test.each(['42501', '42P01', '42703', '08006', '57014', '53300'])(
    'scope SQLSTATE %s is wrapped: checkpoint survives but raw family is unavailable', async sqlstate => {
        const { h, user, login } = await savedConsultantOwnWorkspace();
        const connect = h.pool.connect;
        let failures = 0;
        h.pool.connect = async () => {
            const client = await connect();
            return { ...client, async query(sql, params) {
                if (sql.startsWith('SELECT preparation,activation FROM nofries.dashboard_starter_scopes')) {
                    failures++; throw Object.assign(new Error('synthetic-provider-secret'), { code: sqlstate });
                }
                return client.query(sql, params);
            } };
        };
        const response = await request(h.app).get('/api/customer-signup/state').set('Cookie', login.cookie);
        expect(failures).toBe(1); expect(response.status).toBe(503);
        expect(response.body).toEqual({ error: 'Signup is unavailable', code: 'signup_unavailable' });
        const workspaceRead = { phase: 'passive_starter', checkpoint: 'scope_query' };
        expect(events()).toEqual([{ timestamp: expect.any(String), code: 'postgres_query_failed', stage: 'organisation_preparation',
            supportReference: response.headers['x-nofries-support-reference'], workspaceRead }]);
        expectPrivate(events(), user, login.cookie, response, workspaceRead);
        expect(JSON.stringify(events())).not.toContain(sqlstate);
    });

test('no visible scope with a scoped registration layout remains read-only, without a preparation writer', async () => {
    const { h, login } = await savedConsultantOwnWorkspace();
    const connect = h.pool.connect, queries = [];
    h.pool.connect = async () => {
        const client = await connect();
        return { ...client, async query(sql, params) {
            queries.push(sql);
            if (sql.startsWith('SELECT preparation,activation FROM nofries.dashboard_starter_scopes')) return { rows: [] };
            if (sql.includes('FROM pg_catalog.pg_attribute')) return { rows: [{ is_text: true, not_null: true, scoped_primary_key: true }] };
            return client.query(sql, params);
        } };
    };
    const before = [...h.getContainer('starter-authority').records].map(([key, bytes]) => [key, bytes.toString('base64')]);
    const response = await request(h.app).get('/api/customer-signup/state').set('Cookie', login.cookie);
    expect(response.status).toBe(200); expect(response.body.state.status).toBe('setup_read_only');
    expect(events()).toEqual([]);
    expect(queries.some(sql => /^(INSERT|UPDATE|DELETE)\b/.test(sql))).toBe(false);
    expect([...h.getContainer('starter-authority').records].map(([key, bytes]) => [key, bytes.toString('base64')])).toEqual(before);
    expect(h.pool.receipts.size).toBe(0); expect(h.pool.registrations.size).toBe(0);
});
