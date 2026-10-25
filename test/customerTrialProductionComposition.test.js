'use strict';
const assert = require('node:assert/strict');
const request = require('supertest');
const { customerProductionHarness, uid } = require('./helpers/customerProductionHarness');
const { retainedTrialFixture, clone } = require('./fixtures/retainedTrialReadFixture');
const { subjectHash } = require('../api/shared/customerSignup/customerAuthority');
const { starterAccountKey } = require('../api/shared/customerSignup/starterAccountAllocation');
const { THREE_MONTH_PLAN_ID, LEGACY_PLAN_ID, approvedStarterPlan } = require('../api/shared/customerSignup/customerStarterPlan');
const { normaliseSessionRow } = require('../api/shared/appLifecycle/dashboardRuntimeRecords');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const express = require('express');
const { execFileSync } = require('node:child_process');

async function sqlTransport(f) {
    let raw; await f.options.database.withTenantTransaction(f.account.organisations[0].tenantId, tx => { raw = tx; });
    const audits = new Map(), calls = [], controls = { failAudit: false, loseCommitResponse: false, afterCommit: null };
    return { audits, calls, controls, pool: { async end() {}, async connect() {
        let active = false, beforeGate, beforeAudits;
        return { release() {}, async query(sql, params = []) {
            calls.push(sql);
            if (sql === 'BEGIN') { active = true; beforeGate = clone(f.state.gate); beforeAudits = new Map(audits); return { rows: [] }; }
            if (sql === 'ROLLBACK') {
                if (active) { f.state.gate = beforeGate; audits.clear(); for (const [key, value] of beforeAudits) audits.set(key, value); }
                active = false; return { rows: [] };
            }
            if (sql === 'COMMIT') {
                active = false; if (controls.afterCommit) controls.afterCommit();
                if (controls.loseCommitResponse) { controls.loseCommitResponse = false; throw new Error('synthetic committed response lost'); }
                return { rows: [] };
            }
            if (sql.startsWith('SET LOCAL') || sql.includes('pg_advisory_xact_lock(')) return { rows: [] };
            if (/^INSERT INTO nofries\.dashboard_session_gates/.test(sql)) {
                const keys = /\(([^)]+)\)/.exec(sql)[1].split(',').map(s => s.trim());
                f.state.gate = normaliseSessionRow(Object.fromEntries(keys.map((key, i) => [key, key === 'identity_payload' ? JSON.parse(params[i]) : params[i]])));
                return { rows: [], rowCount: 1 };
            }
            if (sql.includes('FROM nofries.dashboard_runtime_audit')) return { rows: audits.has(params[0]) ? [clone(audits.get(params[0]))] : [] };
            if (/^INSERT INTO nofries\.dashboard_runtime_audit/.test(sql)) {
                if (controls.failAudit) throw new Error('synthetic audit outage');
                const keys = /\(([^)]+)\)/.exec(sql)[1].split(',').map(s => s.trim());
                const row = Object.fromEntries(keys.map((key, i) => [key, ['scope_json', 'payload'].includes(key) ? JSON.parse(params[i]) : params[i]]));
                assert.equal(audits.has(row.event_id), false); audits.set(row.event_id, row); return { rows: [], rowCount: 1 };
            }
            return raw.query(sql, params);
        } };
    } } };
}

async function configured({ client = false, planId = THREE_MONTH_PLAN_ID, retainedRead = true, allowNewSignup = false } = {}) {
    const identity = { policyId: 'synthetic-managed-customer-policy', policyRevision: 1,
        issuer: `https://${uid(101)}.ciamlogin.com/${uid(101)}/v2.0`, identityTenantId: uid(101), oid: uid(103), audience: uid(102) };
    const f = await retainedTrialFixture({ client, identity });
    f.state.subject.expiresAt = Date.parse(f.account.activation.validUntil);
    const sql = await sqlTransport(f), exchanges = [];
    const h = customerProductionHarness({ starter: true, external: true, pool: sql.pool,
        instanceId: f.state.instance.instanceId, restoreEpoch: f.state.instance.restoreEpoch,
        configureExternal({ dependencies, state }) {
            dependencies.clock = () => f.state.now;
            dependencies.externalCustomer.trial = { planId, retainedRead };
            dependencies.externalCustomer.allowNewSignup = allowNewSignup;
            state.externalEmail = f.email; state.externalClaims = { exp: Date.parse(f.state.now) / 1000 + 3600 };
            const original = dependencies.externalCustomer.client.clientApplication.acquireTokenByCode;
            dependencies.externalCustomer.client.clientApplication.acquireTokenByCode = async input => { exchanges.push({ redirectUri: input.redirectUri, scopes: input.scopes }); return original(input); };
        } });
    const records = h.getContainer('external-starter-authority').records;
    const saveSubject = () => records.set(`customer-subjects/${subjectHash(f.actor)}.json`, Buffer.from(JSON.stringify(f.state.subject)));
    saveSubject(); records.set(`customer-starter/${starterAccountKey(f.email)}.json`, Buffer.from(JSON.stringify(f.state.account)));
    const query = new URLSearchParams(f.input).toString(), url = '/api/retained-results?' + query;
    async function loginRetained(app = h.app) {
        const begun = await request(app).get(url + '&signin=1');
        assert.equal(begun.status, 302);
        const tx = begun.headers['set-cookie'][0].split(';')[0];
        const body = { state: new URL(begun.headers.location).searchParams.get('state'), code: 'synthetic-code' };
        const response = await request(app).post('/api/external-customer-auth/callback').set('Cookie', tx).type('form').send(body);
        return { begun, tx, body, response, cookie: response.headers['set-cookie']?.[0]?.split(';')[0] || '' };
    }
    return { h, f, sql, exchanges, saveSubject, query, url, loginRetained };
}

test('ordinary production composition leaves the new route off and accepts no browser offer selector', async () => {
    const h = customerProductionHarness({ starter: true, external: true });
    assert.ok([404, 410].includes((await request(h.app).get('/api/retained-results?bindingId=' + uid(200) + '&assessmentId=saved-assessment')).status));
    const result = await request(h.app).get('/api/external-customer-auth/login?planId=' + THREE_MONTH_PLAN_ID);
    assert.equal(result.status, 302);
    assert.ok(result.headers['set-cookie'][0].startsWith('__Host-nofries-external-customer-tx='));
    assert.equal(h.getContainer('external-starter-authority').records.size, 0);
});

test('trusted pilot selection is closed and refuses a new offer without its retained-read source mount', () => {
    for (const trial of [{ planId: THREE_MONTH_PLAN_ID, retainedRead: false }, { planId: 'unknown', retainedRead: true },
        { planId: LEGACY_PLAN_ID, retainedRead: 'true' }, { planId: THREE_MONTH_PLAN_ID, retainedRead: true, qa: true }]) {
        assert.throws(() => customerProductionHarness({ starter: true, external: true,
            configureExternal({ dependencies }) { dependencies.externalCustomer.trial = trial; } }));
    }
});

for (const selectNew of [false, true]) test(`actual setup uses only the trusted selected offer (three months=${selectNew})`, async () => {
    const h = customerProductionHarness({ starter: true, external: true, configureExternal({ dependencies }) {
        if (selectNew) dependencies.externalCustomer.trial = { planId: THREE_MONTH_PLAN_ID, retainedRead: true };
    } });
    const plan = approvedStarterPlan(selectNew ? THREE_MONTH_PLAN_ID : LEGACY_PLAN_ID);
    if (selectNew) {
        const termsText = fs.readFileSync(path.join(__dirname, '../docs/legal/drafts/nf-dashboard-2026-10-r3.txt'), 'utf8');
        h.getContainer('customer-authority').records.set(`customer-terms/${plan.termsDigest}.json`,
            Buffer.from(JSON.stringify({ termsText, termsVersion: plan.termsVersion, termsDigest: plan.termsDigest })));
    }
    const login = await h.loginExternal(); assert.equal(login.response.status, 303);
    const state = await request(h.app).get('/api/external-customer-signup/state').set('Cookie', login.cookie);
    assert.equal(state.body.state.status, 'setup_details');
    const input = { accountType: 'company', organisationName: 'Synthetic selected pilot',
        details: { name: 'Synthetic Representative', role: 'Owner', address: 'Synthetic address', registrationId: '', authorityConfirmed: true } };
    const response = await h.sameOrigin(request(h.app).post('/api/external-customer-signup/setup'))
        .set('Cookie', login.cookie).set('X-CSRF-Token', state.body.csrfToken).send(input);
    assert.equal(response.status, 200); assert.equal(response.body.state.status, 'continue_authentication');
    const records = h.getContainer('external-starter-authority').records;
    const account = JSON.parse([...records].find(([key]) => key.includes('/starter-accounts/'))[1]);
    const setup = JSON.parse([...records].find(([key]) => key.includes('/starter-setups/'))[1]);
    assert.equal(account.planId, plan.planId); assert.equal(account.activation, null);
    assert.equal(setup.offer.terms.termsVersion, plan.termsVersion); assert.equal(setup.offer.terms.termsDigest, plan.termsDigest);
    assert.equal(setup.offerInput.planId, selectNew ? plan.planId : undefined);
    // Request data cannot switch to another offer, QA class or purpose.
    const changed = await h.sameOrigin(request(h.app).post('/api/external-customer-signup/setup'))
        .set('Cookie', login.cookie).set('X-CSRF-Token', state.body.csrfToken).send({ ...input, planId: selectNew ? LEGACY_PLAN_ID : THREE_MONTH_PLAN_ID });
    assert.ok(changed.status >= 400); assert.equal(JSON.parse([...records].find(([key]) => key.includes('/starter-accounts/'))[1]).planId, plan.planId);
});

for (const client of [false, true]) test(`actual production launcher joins the retained callback, immutable proof, exact read, audit and HTML (client=${client})`, async () => {
    const t = await configured({ client }), before = JSON.stringify({ account: t.f.state.account, versions: t.f.versionRows, scopes: [...t.f.scopes] });
    const signedOut = await request(t.h.app).get(t.url);
    assert.equal(signedOut.status, 401); assert.match(signedOut.text, /Sign in to saved results/); assert.equal(t.sql.calls.length, 0);
    const login = await t.loginRetained();
    assert.equal(login.response.status, 303); assert.equal(login.response.headers.location, t.url);
    assert.match(login.cookie, /^__Host-nofries-retained-read=/);
    assert.ok(login.begun.headers['set-cookie'].some(c => c.startsWith('__Host-nofries-external-customer-tx=;')));
    assert.deepEqual(t.exchanges, [{ redirectUri: 'https://nofries.nz/api/external-customer-auth/callback', scopes: ['openid', 'profile', 'email'] }]);
    const page = await request(t.h.app).get(t.url).set('Cookie', login.cookie);
    assert.equal(page.status, 200); assert.match(page.text, /Reported attainment: <strong>100.0%/);
    assert.doesNotMatch(page.text, /<script|textarea|contenteditable|assessment\.write/);
    assert.match(page.headers['cache-control'], /private, no-store/); assert.equal(page.headers['x-robots-tag'], 'noindex, nofollow');
    assert.equal(t.sql.audits.size, 1); assert.equal(t.f.state.gate.selectedBindingId, t.f.slot.bindingId);
    const backend = await request(t.h.app).get('/api/retained-results?' + t.query).set('Cookie', login.cookie);
    assert.equal(backend.status, 200); assert.match(backend.headers['cache-control'], /private, no-store/);
    assert.equal(backend.headers['x-robots-tag'], 'noindex, nofollow');
    assert.equal(backend.headers['content-security-policy'], page.headers['content-security-policy']);
    assert.equal(t.sql.audits.size, 2);
    assert.equal(JSON.stringify({ account: t.f.state.account, versions: t.f.versionRows, scopes: [...t.f.scopes] }), before);
    const replay = await request(t.h.app).post('/api/external-customer-auth/callback').set('Cookie', login.tx).type('form').send(login.body);
    assert.equal(replay.status, 401); assert.equal(t.exchanges.length, 1);
    const normal = await t.h.loginExternal(); assert.ok(normal.response.status >= 400);
    const forged = login.cookie.replace('__Host-nofries-retained-read=', '__Host-nofries-external-customer=');
    assert.ok((await request(t.h.app).get('/api/dashboard/session').set('Cookie', forged)).status >= 400);
    assert.equal((await request(t.h.app).get(t.url).set('Cookie', login.cookie)).status, 200);
});

test('callback ambiguity consumes neither competing purpose; a fresh begin selects its own transaction', async () => {
    const t = await configured();
    const ordinary = await request(t.h.app).get('/api/external-customer-auth/login');
    const retained = await request(t.h.app).get(t.url + '&signin=1');
    const ordinaryTx = ordinary.headers['set-cookie'][0].split(';')[0], retainedTx = retained.headers['set-cookie'][0].split(';')[0];
    const body = { code: 'synthetic-code', state: new URL(retained.headers.location).searchParams.get('state') };
    const ambiguous = await request(t.h.app).post('/api/external-customer-auth/callback').set('Cookie', ordinaryTx + '; ' + retainedTx).type('form').send(body);
    assert.equal(ambiguous.status, 400); assert.equal(t.exchanges.length, 0);
    const success = await request(t.h.app).post('/api/external-customer-auth/callback').set('Cookie', retainedTx).type('form').send(body);
    assert.equal(success.status, 303); assert.equal(t.exchanges.length, 1);
    const freshOrdinary = await request(t.h.app).get('/api/external-customer-auth/login');
    assert.ok(freshOrdinary.headers['set-cookie'].some(c => c.startsWith('__Host-nofries-retained-read-tx=;')));
});

test('actual retained page denies foreign bindings, extra authority hints, edits and cross-origin logout', async () => {
    const t = await configured(), login = await t.loginRetained(); assert.equal(login.response.status, 303);
    const foreign = await request(t.h.app).get('/api/retained-results?bindingId=' + uid(222) + '&assessmentId=saved-assessment').set('Cookie', login.cookie);
    assert.equal(foreign.status, 403); assert.doesNotMatch(foreign.text, /Reported attainment|Saved responses/);
    assert.equal((await request(t.h.app).get(t.url + '&tenantId=' + t.f.slot.tenantId).set('Cookie', login.cookie)).status, 400);
    assert.equal((await request(t.h.app).post('/api/retained-results').set('Cookie', login.cookie).send({ action: 'save' })).status, 400);
    assert.ok((await t.h.sameOrigin(request(t.h.app).post('/api/dashboard/ncsc/assessments')).set('Cookie', login.cookie).send({ action: 'create' })).status >= 400);
    assert.equal((await request(t.h.app).post('/api/retained-results').set('Origin', 'https://foreign.invalid').set('Cookie', login.cookie).type('form').send('')).status, 403);
    assert.equal(t.sql.audits.size, 0);
});

describe('saved results cross the actual configured frontend admission boundary', () => {
    let configs, temporary;
    const endpoint = '/api/retained-results';
    beforeAll(() => {
        const root = path.resolve(__dirname, '..');
        temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-retained-static-'));
        const { PUBLIC_ROOT_FILES } = require('../lib/publicAssets');
        for (const file of ['package.json', 'scripts/build-static.js', 'staticwebapp.config.json', ...PUBLIC_ROOT_FILES]) {
            fs.mkdirSync(path.dirname(path.join(temporary, file)), { recursive: true });
            fs.copyFileSync(path.join(root, file), path.join(temporary, file));
        }
        for (const name of ['api', 'app', 'assets', 'images', 'js', 'lib', 'azure']) {
            fs.cpSync(path.join(root, name), path.join(temporary, name), { recursive: true,
                filter: source => !path.relative(root, source).split(path.sep).includes('node_modules') });
        }
        execFileSync(process.execPath, [path.join(temporary, 'scripts/build-static.js')], { cwd: temporary, stdio: 'pipe' });
        const built = fs.readFileSync(path.join(temporary, 'dist/staticwebapp.config.json'), 'utf8');
        assert.ok(Buffer.byteLength(built, 'utf8') <= 20000);
        configs = {
            source: JSON.parse(fs.readFileSync(path.join(root, 'staticwebapp.config.json'))),
            example: JSON.parse(fs.readFileSync(path.join(root, 'azure/staticwebapp.config.example.json'))),
            built: JSON.parse(built)
        };
    });
    afterAll(() => { if (temporary) fs.rmSync(temporary, { recursive: true, force: true }); });
    const matched = (config, method, url) => config.routes.find(route =>
        (route.route.endsWith('*') ? url.startsWith(route.route.slice(0, -1)) : route.route === url) &&
        (!route.methods || route.methods.includes(method)));
    const roles = route => route?.allowedRoles ?? ['anonymous'];
    function fronted(app, config, passed) {
        const edge = express();
        edge.use((req, res, next) => {
            const route = matched(config, req.method, req.path);
            // This is the documented first-match source model, not a live SWA
            // probe. A BFF cookie never invents an authenticated SWA principal.
            if (!route || !roles(route).includes('anonymous')) return res.sendStatus(401);
            passed.push([req.method, req.path]); next();
        });
        edge.use(app); return edge;
    }

    test.each(['source', 'example', 'built'])('%s admits only the exact GET/POST handoff before the unchanged protected catch-all', name => {
        const config = configs[name];
        for (const method of ['GET', 'POST']) {
            const rule = matched(config, method, endpoint);
            assert.equal(rule?.route, endpoint); assert.deepEqual(rule.methods, ['GET', 'POST']);
            assert.deepEqual(roles(rule), ['anonymous']);
            assert.equal(rule.headers, undefined, 'Use the actual backend private/CSP response headers');
            assert.ok(config.routes.indexOf(rule) < config.routes.findIndex(route => route.route === '/api/*'));
        }
        for (const method of ['HEAD', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
            assert.equal(matched(config, method, endpoint)?.route, '/api/*');
            assert.deepEqual(roles(matched(config, method, endpoint)), ['authenticated']);
        }
        for (const method of ['GET', 'POST']) for (const target of [endpoint + '/', endpoint + '/login', endpoint + '/logout', endpoint + '-extra', '/api/private-retained-results']) {
            assert.deepEqual(roles(matched(config, method, target)), ['authenticated']);
        }
    });

    test.each(['source', 'example', 'built'])('%s route removal causally blocks real BFF read/sign-in; restoring it reaches genuine callback and audited result', async name => {
        const t = await configured(), passed = [], edge = fronted(t.h.app, configs[name], passed);
        const anon = await request(edge).get(t.url);
        assert.equal(anon.status, 401); assert.match(anon.text, /Sign in to saved results/);
        assert.match(anon.headers['cache-control'], /private, no-store, max-age=0/);
        assert.equal(anon.headers['x-robots-tag'], 'noindex, nofollow');
        assert.equal(t.sql.calls.length, 0); assert.equal(t.exchanges.length, 0);
        const login = await t.loginRetained(edge); assert.equal(login.response.status, 303);
        const deniedPassed = [], removed = { ...configs[name], routes: configs[name].routes.filter(route => route.route !== endpoint) };
        const denied = fronted(t.h.app, removed, deniedPassed);
        assert.equal((await request(denied).get(t.url).set('Cookie', login.cookie)).status, 401);
        assert.equal((await request(denied).get(t.url + '&signin=1').set('Cookie', login.cookie)).status, 401);
        assert.deepEqual(deniedPassed, []); assert.equal(t.sql.audits.size, 0); assert.equal(t.exchanges.length, 1);
        const result = await request(edge).get(t.url).set('Cookie', login.cookie);
        assert.equal(result.status, 200); assert.match(result.text, /Reported attainment/);
        assert.equal(result.headers['content-security-policy'], require('../lib/retainedTrialReadDocument').contentSecurityPolicy);
        assert.equal(t.sql.audits.size, 1);
        const rejectedLogout = await request(edge).post(endpoint).set('Origin', 'https://foreign.invalid').set('Cookie', login.cookie).type('form').send('');
        assert.equal(rejectedLogout.status, 403); assert.ok(passed.some(([method, url]) => method === 'POST' && url === endpoint));
        assert.equal((await request(edge).get(t.url).set('Cookie', login.cookie)).status, 200);
    });

    test('closed sign-in marker and empty logout reject edits, ambiguity and authority hints without effects', async () => {
        const t = await configured(), login = await t.loginRetained(), before = JSON.stringify(t.f.versionRows);
        for (const extra of ['signin=0', 'signin=1&signin=1', 'signin=1&tenantId=' + t.f.slot.tenantId, 'bindingId=' + t.f.slot.bindingId]) {
            assert.equal((await request(t.h.app).get(t.url + '&' + extra).set('Cookie', login.cookie)).status, 400);
        }
        for (const [type, body] of [['json', { action: 'save' }], ['json', {}], ['form', 'action=save'], ['text', 'action=save']]) {
            assert.equal((await t.h.sameOrigin(request(t.h.app).post(endpoint)).set('Cookie', login.cookie).type(type).send(body)).status, 400);
        }
        assert.equal((await t.h.sameOrigin(request(t.h.app).post(endpoint + '?action=save')).set('Cookie', login.cookie).type('form').send('')).status, 400);
        assert.equal(t.sql.audits.size, 0); assert.equal(t.exchanges.length, 1); assert.equal(JSON.stringify(t.f.versionRows), before);
        // First-read logout has no SQL gate yet. The same exact POST endpoint
        // removes only this purpose session; it cannot create a result audit.
        const logout = await t.h.sameOrigin(request(t.h.app).post(endpoint)).set('Cookie', login.cookie).type('form').send('');
        assert.equal(logout.status, 303); assert.equal(logout.headers.location, '/');
        assert.equal((await request(t.h.app).get(t.url).set('Cookie', login.cookie)).status, 401);
        assert.equal(t.sql.audits.size, 0); assert.equal(JSON.stringify(t.f.versionRows), before);
    });
});

test('actual HTTP audit failure withholds the rendered result and rolls back only new session/audit state', async () => {
    const t = await configured(), login = await t.loginRetained(); t.sql.controls.failAudit = true;
    const failed = await request(t.h.app).get(t.url).set('Cookie', login.cookie);
    assert.equal(failed.status, 503); assert.doesNotMatch(failed.text, /Reported attainment|Saved responses/);
    assert.equal(t.sql.audits.size, 0); assert.equal(t.f.state.gate, null);
    t.sql.controls.failAudit = false;
    assert.equal((await request(t.h.app).get(t.url).set('Cookie', login.cookie)).status, 200);
    assert.equal(t.sql.audits.size, 1);
});

test('actual HTTP unknown COMMIT result withholds output; a new HTTP read records a new checked attempt without assessment changes', async () => {
    const t = await configured(), login = await t.loginRetained(), before = JSON.stringify(t.f.versionRows);
    t.sql.controls.loseCommitResponse = true;
    const failed = await request(t.h.app).get(t.url).set('Cookie', login.cookie);
    assert.equal(failed.status, 503); assert.doesNotMatch(failed.text, /Reported attainment/); assert.equal(t.sql.audits.size, 1);
    assert.equal((await request(t.h.app).get(t.url).set('Cookie', login.cookie)).status, 200);
    assert.equal(t.sql.audits.size, 2); assert.equal(JSON.stringify(t.f.versionRows), before);
});

test('rollback stops new offers while the legacy selector still serves already-created new-plan saved results', async () => {
    const t = await configured({ planId: LEGACY_PLAN_ID, retainedRead: true, allowNewSignup: false });
    const original = JSON.stringify(t.f.state.account), login = await t.loginRetained();
    assert.equal(login.response.status, 303); assert.equal((await request(t.h.app).get(t.url).set('Cookie', login.cookie)).status, 200);
    t.h.state.externalOid = uid(233); t.h.state.externalEmail = 'unknown@example.test';
    assert.ok((await t.h.loginExternal()).response.status >= 400);
    assert.equal(JSON.stringify(t.f.state.account), original);
    assert.equal(t.f.account.planId, THREE_MONTH_PLAN_ID); assert.equal(approvedStarterPlan().planId, LEGACY_PLAN_ID);
});
