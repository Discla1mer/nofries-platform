'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = global.test || require('node:test');
const { LEGACY_PLAN_ID, THREE_MONTH_PLAN_ID, approvedStarterPlan, accountWindow, starterAuthorityExpiry,
    compileStarterSchedule, compileStarterPreparation, compileStarterActivation } = require('../api/shared/customerSignup/customerStarterPlan');
const { hash } = require('../api/shared/appLifecycle/dashboardRuntimeRecords');
const { normaliseEntitlementState, consumeEntitlementLimit } = require('../api/shared/appLifecycle/entitlementDomain');
const { dataCodec: { validateUsage } } = require('../api/shared/appLifecycle/postgresDashboardBootstrap');
const { createStarterAccountAllocator, starterAccountRecord } = require('../api/shared/customerSignup/starterAccountAllocation');
const { createStarterSetupDetails, starterSetupRecord } = require('../api/shared/customerSignup/starterSetupDetails');
const { compileStarterProvisioning, compileStarterAdmission, retainedStarterPreparation,
    retainedStarterActivation } = require('../api/shared/customerSignup/starterProvisioning');
const id = n => '10000000-0000-4000-8000-' + String(n).padStart(12, '0');
const SUBJECT = id(5) + ':' + id(6);
const clone = value => JSON.parse(JSON.stringify(value));
function offer(planId) {
    return { tenantId: id(1), organisationId: id(2), organisationName: 'Synthetic Compatibility Ltd',
        accountType: 'company', kind: 'own', grantId: id(3), scheduleId: id(4),
        ...(planId === undefined ? {} : { planId }),
        contact: { name: 'Synthetic Representative', role: 'Owner', email: 'synthetic@example.test',
            address: 'Synthetic address', registrationId: null, authorityEvidenceId: 'synthetic-compatibility-declaration' },
        framework: { moduleId: 'cyber_security', profileId: 'synthetic-cyber', version: '1.0', scoringVersion: 'synthetic-1' } };
}
function prepared(planId, createdAt = '2026-10-15T01:00:00.000Z', occurredAt = '2026-10-31T12:34:56.789Z', overrides = {}) {
    const source = { offerInput: { ...offer(planId), ...overrides }, subjectKey: SUBJECT, issuerSubjectKey: SUBJECT,
        invitationId: id(7), createdAt };
    const preparation = compileStarterPreparation(source);
    const receipt = { receiptId: id(8), invitationId: preparation.invitationId, subjectKey: SUBJECT,
        ...preparation.scope, ...preparation.terms, scheduleId: preparation.schedule.scheduleId,
        scheduleDigest: preparation.schedule.scheduleDigest, acceptedAt: Date.parse(occurredAt), status: 'pending_admission', dashboardAccess: false };
    const input = { preparation, accountId: id(9), activationId: id(10), membershipId: id(11), acceptance: receipt,
        occurredAt, accountActivatedAt: null };
    return { source, preparation, receipt, input, result: () => compileStarterActivation(input) };
}

test('legacy plan, schedule, pending preparation and activation replay retain baseline digests', () => {
    // Golden values were calculated from immutable base b9e259ee, before edits.
    const f = prepared(undefined, '2026-09-29T00:00:00.000Z', '2026-10-01T12:00:00.000Z'), a = f.result();
    assert.equal(approvedStarterPlan().sha256, '171183757f61a1c7ce51667ff33a782558ae509cbb1d398538e22e95567c1ffb');
    assert.equal(f.preparation.schedule.scheduleDigest, '0e6bed2582bc0811e49b20de32fc3b9e7591311af625b08869190f051834bd9a');
    assert.equal(hash(f.preparation), '5093ab7c88c4c7f8bae6196b8352993c25fc9ef1fb0882caed6e2af604b0cd1f');
    assert.equal(hash(a.activationIntent), 'ed6c3100b2f5db102138a1b73bbd6561c91e8e72f534474023830eeb7e0b7f4a');
    assert.equal(hash(a.nextState), '7f70b59ff877c55496d3acb7d702ca60898956b054a1af9f5b590d36a2e89fd2');
    assert.equal(a.activationIntent.validUntil, '2026-10-15T12:00:00.000Z');
});

test('closed new plan removes the assessment cap and preserves commercial and data restrictions', () => {
    const p = approvedStarterPlan(THREE_MONTH_PLAN_ID);
    assert.equal(p.durationMonths, 3); assert.equal(p.durationDays, undefined);
    assert.equal(p.assessmentSubmissionsPerOrganisation, null);
    assert.equal(p.usersPerOrganisation, 1); assert.equal(p.companyOrganisations, 1);
    assert.equal(p.consultantWorkspaces, 1); assert.equal(p.consultantClientOrganisations, 3);
    assert.equal(p.aiRequests + p.evidenceBytes + p.reportExports + p.priceNzd, 0);
    assert.equal(p.automaticPaidConversion, false); assert.equal(p.deleteDataAtExpiry, false);
    assert.equal(p.readSavedResultsAfterExpiry, true); assert.ok(Object.isFrozen(p));
    for (const unknown of ['unknown', '__proto__', 'internal-qa', null, 2]) assert.throws(() => approvedStarterPlan(unknown));
    assert.equal(approvedStarterPlan().planId, LEGACY_PLAN_ID, 'compatible readers do not enable new allocations');
});

for (const [start, end] of [
    ['2026-10-31T12:34:56.789Z', '2027-01-31T12:34:56.789Z'],
    ['2026-11-30T23:59:59.999Z', '2027-02-28T23:59:59.999Z'],
    ['2027-01-31T00:00:00.000Z', '2027-04-30T00:00:00.000Z'],
    ['2027-11-30T08:20:33.123Z', '2028-02-29T08:20:33.123Z'],
    ['2028-02-29T08:20:33.123Z', '2028-05-29T08:20:33.123Z'],
    ['2028-08-31T00:00:00.000Z', '2028-11-30T00:00:00.000Z']
]) test(`UTC calendar trial preserves clock and clamps ${start.slice(0, 10)}`, () => {
    assert.deepEqual(accountWindow(start, THREE_MONTH_PLAN_ID), { validFrom: start, validUntil: end });
});

test('new version has separate offer bytes and genuine consent fixes one replay-stable window', () => {
    const f = prepared(THREE_MONTH_PLAN_ID), a = f.result();
    assert.match(f.preparation.schedule.scheduleText, /3 calendar months/);
    assert.match(f.preparation.schedule.scheduleText, /no assessment or submission cap/);
    assert.match(f.preparation.schedule.scheduleText, /read-only access to saved results/);
    assert.doesNotMatch(f.preparation.schedule.scheduleText, /5 assessment submissions|14 days from/);
    assert.equal(a.activationIntent.validUntil, '2027-01-31T12:34:56.789Z');
    assert.equal(a.activationIntent.planId, THREE_MONTH_PLAN_ID);
    assert.deepEqual(compileStarterActivation({ ...f.input, preparation: compileStarterPreparation(clone(f.source)) }), a);
    assert.throws(() => compileStarterActivation({ ...f.input, acceptance: { ...f.receipt, ...approvedStarterPlan() } }));
    assert.throws(() => compileStarterSchedule({ ...offer(THREE_MONTH_PLAN_ID), planId: 'unknown' }));
    assert.throws(() => compileStarterSchedule({ ...offer(THREE_MONTH_PLAN_ID),
        contact: { ...offer().contact, authorityEvidenceId: approvedStarterPlan().approvalRef } }));
    assert.throws(() => compileStarterPreparation({ ...f.source, createdAt: '2026-10-14T23:59:59.999Z' }));
});

test('consultant clients inherit the original clamped account end and cannot restart the term', () => {
    const f = prepared(THREE_MONTH_PLAN_ID, '2026-11-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z', { accountType: 'consultant', kind: 'client' });
    const result = compileStarterActivation({ ...f.input, accountActivatedAt: '2026-10-31T12:34:56.789Z' });
    assert.equal(result.activationIntent.accountActivatedAt, '2026-10-31T12:34:56.789Z');
    assert.equal(result.activationIntent.validUntil, '2027-01-31T12:34:56.789Z');
    assert.equal(result.nextState.membershipState.memberships[0].validFrom, f.input.occurredAt);
    assert.throws(() => compileStarterActivation({ ...f.input, accountActivatedAt: result.activationIntent.accountActivatedAt,
        occurredAt: result.activationIntent.validUntil }));
});

test('new grants permit sixth and later submissions while seats, usage integrity and expiry stay bounded', () => {
    const f = prepared(THREE_MONTH_PLAN_ID), s = f.result().nextState, grant = s.entitlementState.grants[0];
    let usage = s.usage[0];
    const spend = (amount = 1, limit = 'assessment_runs', at = f.input.occurredAt) => consumeEntitlementLimit(s.entitlementState, s.tenantAggregate,
        usage, { ...f.preparation.scope, grantId: grant.grantId, expectedEntitlementRevision: 1, expectedFlagRevision: 1,
            expectedUsageRevision: usage.revision, moduleId: limit === 'memberships' ? 'overview' : 'cyber_security', limit, amount,
            framework: limit === 'assessment_runs' ? { profileId: 'synthetic-cyber', version: '1.0' } : null }, at, s.flags);
    for (let n = 0; n < 25; n++) usage = spend();
    assert.equal(usage.counters.assessment_runs, 25); assert.equal(grant.limits.assessment_runs, null);
    assert.deepEqual(validateUsage(usage, s.entitlementState), usage);
    assert.throws(() => spend(1, 'memberships'), /limit_exceeded/);
    assert.throws(() => spend(1, 'assessment_runs', grant.validUntil), /quota_grant_mismatch/);
    usage = { ...usage, counters: { ...usage.counters, assessment_runs: Number.MAX_SAFE_INTEGER } };
    assert.throws(() => spend(), /limit_exceeded/);
    assert.throws(() => validateUsage({ ...usage, counters: { ...usage.counters, assessment_runs: null } }, s.entitlementState));
    for (const key of ['memberships', 'ai_requests', 'evidence_bytes', 'report_exports']) {
        const state = clone(s.entitlementState); state.grants[0].limits[key] = null;
        assert.throws(() => normaliseEntitlementState(state, s.tenantAggregate));
    }
});

function allocatorFixture(planId = THREE_MONTH_PLAN_ID, at = Date.parse('2026-10-31T12:34:56.789Z')) {
    const rows = new Map(); let fact, next = 20, time = at;
    const options = { planId, now: () => time, newId: () => id(next++),
        captureOwner: async () => ({ subjectKey: SUBJECT, email: 'synthetic@example.test' }), readActivation: async () => clone(fact),
        store: { load: async key => rows.has(key) ? clone(rows.get(key)) : null,
            create: async (key, record) => { if (rows.has(key)) return false; rows.set(key, { record: clone(record), version: 1 }); return true; },
            replace: async (key, version, record) => { if (rows.get(key)?.version !== version) return false;
                rows.set(key, { record: clone(record), version: version + 1 }); return true; } } };
    const allocator = createStarterAccountAllocator(options), proof = { schemaVersion: 1, requestId: id(12),
        email: 'synthetic@example.test', organisationName: 'Synthetic Compatibility Ltd', accountType: 'consultant',
        status: 'verified', codeHash: null, attempts: 0, createdAt: at - 1000, codeExpiresAt: at + 599000,
        expiresAt: at + 86399000, verifiedAt: at };
    return { options, allocator, proof, rows, setTime: value => { time = value; }, async activate(account) {
        fact = { email: account.email, subjectKey: SUBJECT, accountId: account.accountId,
            organisationId: account.organisations[0].organisationId, receiptId: id(19), activatedAt: new Date(at).toISOString() };
        return allocator.activate({});
    } };
}

test('durable new allocation and setup pin their version; a changed default cannot alter old reservations', async () => {
    const f = allocatorFixture(), account = await f.allocator.reserveInitial(f.proof);
    assert.equal(account.planId, THREE_MONTH_PLAN_ID);
    const setupRows = new Map(), setup = createStarterSetupDetails({ accounts: f.allocator, now: f.options.now,
        newId: () => id(50), framework: async () => offer().framework,
        store: { load: async key => setupRows.get(key) || null, create: async (key, value) => { setupRows.set(key, value); return true; } } });
    const saved = await setup.save(f.proof, { name: 'Synthetic Representative', role: 'Owner', address: 'Synthetic address', registrationId: null, authorityConfirmed: true });
    assert.equal(saved.offerInput.planId, THREE_MONTH_PLAN_ID); assert.deepEqual(starterSetupRecord(clone(saved)), saved);
    const active = await f.activate(account); assert.equal(active.activation.validUntil, '2027-01-31T12:34:56.789Z');
    f.setTime(Date.parse('2026-12-01T00:00:00.000Z'));
    assert.deepEqual(await createStarterAccountAllocator({ ...f.options, planId: LEGACY_PLAN_ID }).activate({}), active);
    assert.throws(() => starterAccountRecord({ ...active, planId: LEGACY_PLAN_ID }));
    assert.throws(() => starterSetupRecord({ ...saved, planId: LEGACY_PLAN_ID }));
    const old = allocatorFixture(LEGACY_PLAN_ID), original = await old.allocator.reserveInitial(old.proof);
    assert.deepEqual(await createStarterAccountAllocator({ ...old.options, planId: THREE_MONTH_PLAN_ID }).reserveInitial(old.proof), original);
    assert.equal(original.planId, LEGACY_PLAN_ID);
});

test('provisioning/admission replay pins new plan and rejects changing retained plan or expiry', async () => {
    const f = allocatorFixture(), account = await f.allocator.reserveInitial(f.proof), slot = account.organisations[0];
    const source = prepared(THREE_MONTH_PLAN_ID).source;
    source.offerInput = { ...source.offerInput, ...Object.fromEntries(['tenantId', 'organisationId', 'organisationName', 'grantId', 'scheduleId', 'kind'].map(k => [k, slot[k]])), accountType: 'consultant' };
    source.createdAt = new Date(f.options.now()).toISOString();
    const p = compileStarterProvisioning({ account, requestId: slot.requestId, source });
    const acceptance = { ...prepared(THREE_MONTH_PLAN_ID).receipt, invitationId: p.invitationId, ...p.scope,
        ...p.terms, scheduleId: p.schedule.scheduleId, scheduleDigest: p.schedule.scheduleDigest };
    const identity = { policyId: 'synthetic-starter', policyRevision: 1, issuer: 'https://identity.example.test/v2.0',
        identityTenantId: id(5), oid: id(6), audience: 'synthetic-client' };
    const a = compileStarterAdmission({ preparation: p, acceptance, identity, occurredAt: source.createdAt, accountActivatedAt: null });
    assert.deepEqual(retainedStarterPreparation(clone(p)), p); assert.deepEqual(retainedStarterActivation(clone(p), clone(a.activation)), a);
    assert.throws(() => retainedStarterPreparation({ ...p, planId: LEGACY_PLAN_ID }));
    assert.throws(() => retainedStarterActivation(p, { ...a.activation, validUntil: '2027-02-01T12:34:56.789Z' }));
    const changed = clone(source); delete changed.offerInput.planId;
    assert.throws(() => compileStarterProvisioning({ account, requestId: slot.requestId, source: changed }));
});

test('versioned agreement has only the intended new trial clause and preserves payment and breach periods', () => {
    const root = path.join(__dirname, '../docs/legal/drafts');
    const old = fs.readFileSync(path.join(root, 'nf-dashboard-2026-09-r2.txt'), 'utf8');
    const current = fs.readFileSync(path.join(root, 'nf-dashboard-2026-10-r3.txt'), 'utf8');
    const crypto = require('node:crypto'), plan = approvedStarterPlan(THREE_MONTH_PLAN_ID);
    assert.equal(crypto.createHash('sha256').update(current).digest('hex'), plan.termsDigest);
    assert.equal(crypto.createHash('sha256').update(old).digest('hex'), approvedStarterPlan().termsDigest);
    const withoutNewClause = current.replace(/For a new complimentary starter schedule identified as nf-starter-2026-10-r2,[\s\S]*?\n\n(?=If a payment is overdue)/, '')
        .replace('Version: nf-dashboard-2026-10-r3', 'Version: nf-dashboard-2026-09-r2');
    assert.equal(withoutNewClause, old.trimEnd() + '\n');
    assert.match(current, /at least 14 days to resolve it before suspending for non-payment/);
    assert.match(current, /material breach that remains unresolved 14 days after written notice/);
    assert.equal(starterAuthorityExpiry(Date.parse('2026-11-30T00:00:00.000Z'), THREE_MONTH_PLAN_ID), Date.parse('2027-02-28T23:59:59.999Z'));
    assert.equal(starterAuthorityExpiry(1, LEGACY_PLAN_ID), 1 + 14 * 86400000);
});
