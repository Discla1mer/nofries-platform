'use strict';
const assert = require('node:assert/strict');
const { createBrowserAuthService, readBrowserSessionDetails } = require('../api/shared/browserAuth');
const { retainedTrialAuthFixture } = require('./fixtures/retainedTrialAuthFixture');
const { createDashboardAuthorityStore } = require('../api/shared/dashboardAuthorityStore');
const { Readable } = require('node:stream');
const { createRetainedTrialAssessmentReader } = require('../api/shared/customerSignup/retainedTrialAssessmentReader');
const { clone } = require('./fixtures/retainedTrialReadFixture');
const { normaliseSessionRow } = require('../api/shared/appLifecycle/dashboardRuntimeRecords');

const RETAINED_COOKIE = '__Host-nofries-retained-read', RETAINED_TX = RETAINED_COOKIE + '-tx';
const ORDINARY_COOKIE = '__Host-nofries-external-customer', ORDINARY_TX = ORDINARY_COOKIE + '-tx';
const id = cookie => cookie.split(';')[0].split('=')[1];
const ordinaryOptions = h => Object.fromEntries(Object.entries(h.browserAuthOptions).filter(([key]) => key !== 'customerPurpose'));

test('retained purpose uses separate closed cookies and proof while keeping the registered callback and scopes', async () => {
    const h = await retainedTrialAuthFixture(), logged = await h.login();
    assert.ok(logged.begun.cookie.startsWith(RETAINED_TX + '='));
    assert.ok(logged.result.cookie.startsWith(RETAINED_COOKIE + '='));
    for (const attribute of ['Secure', 'HttpOnly', 'SameSite=Lax', 'Path=/'])
        assert.ok(logged.result.cookie.split('; ').includes(attribute));
    assert.match(logged.result.location, /^\/api\/retained-results\?bindingId=/);
    assert.ok(h.calls.filter(c => c.redirectUri).every(c => c.redirectUri === 'https://nofries.invalid/api/external-customer-auth/callback'));
    assert.ok(h.calls.filter(c => c.scopes).every(c => JSON.stringify(c.scopes) === JSON.stringify(['openid', 'profile', 'email'])));
    const capture = await h.session.captureRequest(logged.request);
    assert.equal(capture.kind, 'customer');
    assert.equal(h.proofs.get(capture.sessionSha256).kind, 'customer_retained_read_issuance');
    const record = h.store.sessions.get(id(logged.result.cookie));
    assert.equal(record.customerPurpose, 'retained_read');
    assert.equal(record.customerAssurance.stage, 'retained_read');
    assert.equal(record.absoluteExpiresAt, h.now() + 3600000);
});

test('ordinary cookie/session readers cannot adopt or delete a transplanted retained SID', async () => {
    const h = await retainedTrialAuthFixture(), logged = await h.login(), sid = id(logged.result.cookie);
    await assert.rejects(readBrowserSessionDetails(ORDINARY_COOKIE + '=' + sid, { ...ordinaryOptions(h), now: h.now }),
        e => e.code === 'browser_auth_session_purpose_invalid');
    assert.ok(h.store.sessions.has(sid));
    assert.ok(await h.session.captureRequest(logged.request));
});

test('ordinary callback cannot consume a retained transaction even with matching state and a transplanted cookie', async () => {
    const h = await retainedTrialAuthFixture(), { callback } = await h.begin(), txid = id(callback.cookieHeader);
    const normal = createBrowserAuthService({ ...ordinaryOptions(h), now: h.now });
    await assert.rejects(normal.completeLogin({ ...callback, cookieHeader: ORDINARY_TX + '=' + txid }));
    assert.ok(h.store.transactions.has(txid));
    assert.equal(h.calls.filter(c => c.kind === 'exchange').length, 0);
    const result = await h.session.callbackService.completeLogin(callback);
    assert.ok(result.cookie.startsWith(RETAINED_COOKIE + '='));
    await assert.rejects(h.session.callbackService.completeLogin(callback));
    assert.equal(h.calls.filter(c => c.kind === 'exchange').length, 1);
});

test('retained callback cannot consume an ordinary transaction', async () => {
    const h = await retainedTrialAuthFixture(), normal = createBrowserAuthService({ ...ordinaryOptions(h), now: h.now });
    const begun = await normal.beginLogin(), txid = id(begun.cookie);
    await assert.rejects(h.session.callbackService.completeLogin({ cookieHeader: RETAINED_TX + '=' + txid,
        body: { code: 'synthetic-code', state: new URL(begun.location).searchParams.get('state') } }));
    assert.ok(h.store.transactions.has(txid));
    assert.equal(h.calls.filter(c => c.kind === 'exchange').length, 0);
});

test('purpose options are closed and require the existing external customer realm', async () => {
    const h = await retainedTrialAuthFixture();
    for (const customerPurpose of ['dashboard', 'retained', false, null, {}, '../operator']) {
        assert.throws(() => createBrowserAuthService({ ...h.browserAuthOptions, customerPurpose }),
            e => e.code === 'browser_auth_customer_purpose_invalid');
    }
    assert.throws(() => createBrowserAuthService({ ...h.browserAuthOptions, customerTransport: undefined }),
        e => e.code === 'browser_auth_customer_purpose_invalid');
});

test('retained purpose keeps nonce, current proof, revocation and runtime epoch checks', async () => {
    const bad = await retainedTrialAuthFixture(); bad.badNonce(); await assert.rejects(bad.login());
    assert.equal(bad.store.sessions.size, 0);
    const h = await retainedTrialAuthFixture(), logged = await h.login();
    assert.ok(await h.session.captureRequest(logged.request));
    h.f.state.subject.status = 'revoked';
    assert.equal(await h.session.captureRequest(logged.request), null);
    const changed = await retainedTrialAuthFixture(), other = await changed.login();
    changed.changeEpoch(); assert.equal(await changed.session.captureRequest(other.request), null);
});

test('ordinary logout cannot delete a competing retained purpose session', async () => {
    const h = await retainedTrialAuthFixture(), logged = await h.login(), sid = id(logged.result.cookie);
    const normal = createBrowserAuthService({ ...ordinaryOptions(h), now: h.now });
    await assert.rejects(normal.logout({ cookieHeader: ORDINARY_COOKIE + '=' + sid }),
        e => e.code === 'browser_auth_session_purpose_invalid');
    assert.ok(h.store.sessions.has(sid));
    await h.browser.logout({ cookieHeader: logged.result.cookie.split(';')[0] });
    assert.equal(h.store.sessions.has(sid), false);
});

test('ordinary issuance refuses a retained assurance even when given a genuine ordinary transaction', async () => {
    const h = await retainedTrialAuthFixture(), normal = createBrowserAuthService({ ...ordinaryOptions(h), now: h.now });
    const begun = await normal.beginLogin();
    await assert.rejects(normal.completeLogin({ cookieHeader: begun.cookie.split(';')[0],
        body: { code: 'synthetic-code', state: new URL(begun.location).searchParams.get('state') } }),
    { code: 'browser_auth_session_purpose_invalid' });
    assert.equal(h.store.sessions.size, 0); assert.equal(h.proofs.size, 0);
});

test('retained callback refuses an exchange that exceeds its original request budget', async () => {
    const h = await retainedTrialAuthFixture(), client = h.browserAuthOptions.clientApplication, original = client.acquireTokenByCode;
    client.acquireTokenByCode = async input => {
        const result = await original(input);
        h.f.state.now = new Date(h.now() + h.sessionOptions.requestBudgetMs).toISOString();
        return result;
    };
    await assert.rejects(h.login());
    assert.equal(h.store.sessions.size, 0); assert.equal(h.proofs.size, 0);
});

test('the actual immutable proof store persists and reconciles the retained kind without adopting an ordinary proof', async () => {
    const h = await retainedTrialAuthFixture(), logged = await h.login();
    const capture = await h.session.captureRequest(logged.request), saved = new Map();
    const authority = createDashboardAuthorityStore({ instanceId: capture.instanceId, epochContainer: {}, proofContainer: {
        getBlockBlobClient: path => ({ async uploadData(bytes) {
            if (saved.has(path)) throw Object.assign(new Error('synthetic immutable conflict'), { statusCode: 412 });
            saved.set(path, Buffer.from(bytes));
        }, async download() {
            const bytes = saved.get(path);
            if (!bytes) throw Object.assign(new Error('synthetic missing'), { statusCode: 404, code: 'BlobNotFound' });
            return { readableStreamBody: Readable.from([bytes]), contentLength: bytes.length };
        } })
    } });
    const proof = h.proofs.get(capture.sessionSha256);
    await authority.proofStore.createOriginalProof(capture.sessionSha256, proof);
    await authority.proofStore.createOriginalProof(capture.sessionSha256, proof);
    assert.deepEqual(await authority.proofStore.readOriginalProof(capture.sessionSha256), proof);
    await assert.rejects(authority.proofStore.createOriginalProof(capture.sessionSha256, { ...proof, kind: 'customer_dashboard_issuance' }));
    assert.equal(saved.size, 1);
});

// Synthetic SQL transport with explicit rollback and lost-COMMIT-response
// controls. Native constraints/RLS and actual COMMIT are qualified separately.
async function auditedFixture(options) {
    const h = await retainedTrialAuthFixture(options), logged = await h.login(), audits = new Map(), sql = [];
    const base = h.f.options.database;
    const state = { failAudit: false, loseCommitResponse: false, afterCommit: null };
    const database = { async withTenantTransaction(tenant, work) {
        const beforeGate = clone(h.f.state.gate), beforeAudit = new Map(audits);
        let result;
        try {
            result = await base.withTenantTransaction(tenant, tx => work({ async query(text, params) {
                sql.push(text);
                if (text.includes('pg_advisory_xact_lock(')) return { rows: [] };
                if (/^INSERT INTO nofries\.dashboard_session_gates/.test(text)) {
                    const columns = /\(([^)]+)\)/.exec(text)[1].split(',').map(s => s.trim());
                    const row = Object.fromEntries(columns.map((key, i) => [key, key === 'identity_payload' ? JSON.parse(params[i]) : params[i]]));
                    h.f.state.gate = normaliseSessionRow(row); return { rows: [], rowCount: 1 };
                }
                if (text.includes('FROM nofries.dashboard_runtime_audit')) return { rows: audits.has(params[0]) ? [clone(audits.get(params[0]))] : [] };
                if (/^INSERT INTO nofries\.dashboard_runtime_audit/.test(text)) {
                    if (state.failAudit) throw new Error('synthetic audit outage');
                    const columns = /\(([^)]+)\)/.exec(text)[1].split(',').map(s => s.trim());
                    const row = Object.fromEntries(columns.map((key, i) => [key, ['scope_json', 'payload'].includes(key) ? JSON.parse(params[i]) : params[i]]));
                    assert.equal(audits.has(row.event_id), false); audits.set(row.event_id, row); return { rows: [], rowCount: 1 };
                }
                return tx.query(text, params);
            } }));
        } catch (error) {
            h.f.state.gate = beforeGate; audits.clear(); for (const [key, value] of beforeAudit) audits.set(key, value);
            throw error;
        }
        if (state.afterCommit) state.afterCommit();
        if (state.loseCommitResponse) { state.loseCommitResponse = false; throw new Error('synthetic committed response lost'); }
        return result;
    } };
    const reader = createRetainedTrialAssessmentReader({ ...h.f.options, captureRequest: h.session.captureRequest, database, auditRead: true });
    return { ...h, logged, audits, sql, state, database, reader };
}

for (const client of [false, true]) test(`audited fresh retained read commits only its fixed session and read event (client=${client})`, async () => {
    const h = await auditedFixture({ client }), before = JSON.stringify({ account: h.f.state.account, scopes: [...h.f.scopes], versions: h.f.versionRows });
    const result = await h.reader.read(h.logged.request, h.f.input);
    assert.equal(result.readOnly, true); assert.equal(result.assessment.assessmentId, h.f.input.assessmentId);
    assert.equal(h.audits.size, 1); assert.equal(h.f.state.gate.selectedBindingId, h.f.slot.bindingId);
    assert.equal(h.f.state.gate.revision, 0);
    const row = [...h.audits.values()][0];
    assert.equal(row.payload.action, 'assessment.read'); assert.equal(row.payload.result, 'succeeded');
    assert.equal(row.tenant_id, h.f.slot.tenantId); assert.equal(row.organisation_id, h.f.slot.organisationId);
    assert.equal(row.session_sha256, h.f.state.gate.sessionSha256);
    assert.equal(row.operation_id, null); assert.ok(!JSON.stringify(row).includes('rationale'));
    assert.equal(JSON.stringify({ account: h.f.state.account, scopes: [...h.f.scopes], versions: h.f.versionRows }), before);
    assert.ok(h.sql.filter(text => /^(?:INSERT|UPDATE|DELETE)/.test(text)).every(text => /^INSERT INTO nofries\.dashboard_(?:session_gates|runtime_audit)\b/.test(text)));
});

test('audit failure rolls back its new gate and exposes no result; a fresh checked retry succeeds', async () => {
    const h = await auditedFixture(); h.state.failAudit = true;
    await assert.rejects(h.reader.read(h.logged.request, h.f.input), { code: 'retained_read_unavailable' });
    assert.equal(h.audits.size, 0); assert.equal(h.f.state.gate, null);
    h.state.failAudit = false; assert.equal((await h.reader.read(h.logged.request, h.f.input)).readOnly, true);
    assert.equal(h.audits.size, 1);
});

test('lost COMMIT response exposes no result and reconciles one immutable audit on a repeated request', async () => {
    const h = await auditedFixture(); h.state.loseCommitResponse = true;
    await assert.rejects(h.reader.read(h.logged.request, h.f.input), { code: 'retained_read_unavailable' });
    assert.equal(h.audits.size, 1); const original = JSON.stringify([...h.audits]);
    h.f.state.now = new Date(h.now() + 1).toISOString();
    assert.equal((await h.reader.read(h.logged.request, h.f.input)).readOnly, true);
    assert.equal(JSON.stringify([...h.audits]), original);
    assert.equal(h.sql.filter(text => /^INSERT INTO nofries\.dashboard_runtime_audit/.test(text)).length, 1);
});

test('same request cannot change selector or adopt conflicting audit evidence', async () => {
    const h = await auditedFixture(); await h.reader.read(h.logged.request, h.f.input);
    await assert.rejects(h.reader.read(h.logged.request, { ...h.f.input, assessmentId: 'another-assessment' }), { code: 'retained_read_denied' });
    [...h.audits.values()][0].payload.result = 'denied';
    await assert.rejects(h.reader.read(h.logged.request, h.f.input), { code: 'retained_read_unavailable' });
    assert.equal(h.audits.size, 1);
});

for (const end of ['revoked', 'expired', 'epoch']) test(`post-COMMIT ${end} prevents buffered result disclosure`, async () => {
    const h = await auditedFixture();
    h.state.afterCommit = () => {
        if (end === 'revoked') h.f.state.subject.status = 'revoked';
        if (end === 'expired') h.f.state.now = new Date(h.now() + 3600000).toISOString();
        if (end === 'epoch') h.changeEpoch();
    };
    await assert.rejects(h.reader.read(h.logged.request, h.f.input), { code: end === 'expired' ? 'retained_read_unavailable' : 'retained_read_denied' });
    assert.equal(h.audits.size, 1);
});
