'use strict';
const assert = require('node:assert/strict');
const test = global.test || require('node:test');
const crypto = require('node:crypto');
const { approvedStarterPlan, accountWindow, compileStarterSchedule, compileStarterPreparation, compileStarterActivation } = require('../api/shared/customerSignup/customerStarterPlan');
const { createBootstrapOperations } = require('../api/shared/appLifecycle/postgresDashboardBootstrap');
const { resolveEntitlements, consumeEntitlementLimit } = require('../api/shared/appLifecycle/entitlementDomain');
const { normaliseMembershipState } = require('../api/shared/appLifecycle/membershipDomain');
const { hash } = require('../api/shared/appLifecycle/dashboardRuntimeRecords');
const SUBJECT = '10000000-0000-4000-8000-000000000001:10000000-0000-4000-8000-000000000002';
const ISSUER = '10000000-0000-4000-8000-000000000001:10000000-0000-4000-8000-000000000003';
const AT = '2026-09-29T00:00:00.000Z', LATER = '2026-10-04T12:00:00.000Z';
function offerInput(overrides = {}) {
    return { tenantId: crypto.randomUUID(), organisationId: crypto.randomUUID(), organisationName: 'Test fries limited',
        accountType: 'company', kind: 'own', grantId: crypto.randomUUID(), scheduleId: crypto.randomUUID(),
        contact: { name: 'Synthetic Tester', role: 'Authorised tester', email: 'tester@gmail.com',
            address: 'Synthetic test address', registrationId: null, authorityEvidenceId: 'synthetic-declaration' },
        framework: { moduleId: 'cyber_security', profileId: 'synthetic-cyber', version: '1.0', scoringVersion: 'synthetic-1' }, ...overrides };
}
function fixture(overrides = {}) {
    const source = { offerInput: offerInput(overrides), subjectKey: SUBJECT, invitationId: crypto.randomUUID(),
        issuerSubjectKey: ISSUER, createdAt: AT };
    const preparation = compileStarterPreparation(source);
    const acceptance = { receiptId: crypto.randomUUID(), invitationId: preparation.invitationId,
        subjectKey: SUBJECT, ...preparation.scope, ...preparation.terms, scheduleId: preparation.schedule.scheduleId,
        scheduleDigest: preparation.schedule.scheduleDigest, acceptedAt: Date.parse(LATER) - 1000,
        status: 'pending_admission', dashboardAccess: false };
    const input = { preparation, accountId: crypto.randomUUID(), activationId: crypto.randomUUID(),
        membershipId: crypto.randomUUID(), acceptance, occurredAt: LATER,
        accountActivatedAt: overrides.kind === 'client' ? AT : null };
    return { source, preparation, acceptance, input, activate: () => compileStarterActivation(input) };
}
test('approved starter defaults are finite, immutable, free and preserve data at expiry', () => {
    const p = approvedStarterPlan();
    assert.equal(p.durationDays, 14); assert.equal(p.assessmentSubmissionsPerOrganisation, 5);
    assert.equal(p.usersPerOrganisation, 1); assert.equal(p.consultantClientOrganisations, 3);
    assert.equal(p.priceNzd, 0); assert.equal(p.automaticPaidConversion, false); assert.equal(p.deleteDataAtExpiry, false);
    assert.equal(p.aiRequests + p.evidenceBytes + p.reportExports, 0); assert.ok(Object.isFrozen(p));
    assert.throws(() => { p.durationDays = 365; }, TypeError);
});
test('fourteen-day access uses UTC from the retained account activation, including calendar boundaries', () => {
    assert.deepEqual(accountWindow('2026-12-25T12:30:45.000Z'), {
        validFrom: '2026-12-25T12:30:45.000Z', validUntil: '2027-01-08T12:30:45.000Z' });
    assert.throws(() => accountWindow('2026-09-01T00:00:00.000Z'));
    assert.throws(() => accountWindow('2026-09-29'));
});
test('personal email and unrelated organisation name produce a stable immutable offer without a predicted start', () => {
    const source = offerInput(), a = compileStarterSchedule(source), b = compileStarterSchedule(source);
    assert.deepEqual(a, b);
    assert.equal(a.schedule.scheduleDigest, crypto.createHash('sha256').update(a.schedule.scheduleText).digest('hex'));
    assert.match(a.schedule.scheduleText, /tester@gmail\.com/);
    assert.match(a.schedule.scheduleText, /records no acceptance/);
    assert.match(a.schedule.scheduleText, /14 days from account activation/);
    assert.doesNotMatch(a.schedule.scheduleText, /2026-09-29T/);
    assert.throws(() => compileStarterSchedule({ ...source, activatedAt: AT }));
});
test('pre-consent preparation has no grant, member, invitation, allowance or trial clock and passes the actual bootstrap codec', () => {
    const { preparation: p } = fixture(), state = p.initialState;
    assert.deepEqual(state.entitlementState.grants, []);
    assert.deepEqual(state.membershipState.memberships, []); assert.deepEqual(state.membershipState.invitations, []);
    assert.deepEqual(state.flags.enabled, {}); assert.deepEqual(state.advisorAssignments, []);
    assert.equal(p.validFrom, undefined); assert.equal(p.validUntil, undefined);
    assert.equal(state.tenantAggregate.organisations[0].domains.length, 0);
    assert.equal(resolveEntitlements(state.entitlementState, state.tenantAggregate, p.scope, AT, state.flags).product, null);
    const result = createBootstrapOperations({ clock: () => AT, authoriseAdministration: () => false }).prepareInitialisation({
        ...p.scope, operationId: crypto.randomUUID(), actorSubjectKey: ISSUER, type: 'organisation.initialise',
        expectedRevisions: { tenant: null, organisation: null, membership: null, entitlement: null, flags: null,
            advisorAssignments: [], usage: [] }, payload: {} }, state);
    assert.equal(result.tenantId, p.scope.tenantId);
});
test('delayed consent starts a full fourteen-day term at activation and binds the dates and accepted offer into the transaction intent', () => {
    const f = fixture(), { nextState: s, activationIntent: r } = f.activate(), grant = s.entitlementState.grants[0];
    assert.equal(grant.validFrom, LATER); assert.equal(grant.validUntil, '2026-10-18T12:00:00.000Z');
    assert.equal(r.accountActivatedAt, LATER); assert.equal(r.occurredAt, LATER); assert.equal(r.validUntil, grant.validUntil);
    assert.equal(r.acceptanceSha256, hash(f.acceptance)); assert.equal(r.acceptanceReceiptId, f.acceptance.receiptId);
    assert.equal(r.scheduleDigest, f.preparation.schedule.scheduleDigest);
    assert.equal(r.initialStateSha256, hash(f.preparation.initialState)); assert.equal(r.nextStateSha256, hash(s));
    assert.deepEqual(f.preparation.schedule, compileStarterSchedule(f.source.offerInput).schedule);
    assert.equal(s.membershipState.memberships[0].createdAt, LATER);
    assert.equal(s.membershipState.memberships[0].grantEvidenceId, 'synthetic-declaration');
    assert.deepEqual(normaliseMembershipState(s.membershipState), s.membershipState);
    assert.ok(Object.isFrozen(r)); assert.ok(Object.isFrozen(s));
});
test('starter eligibility has no staff/adviser/provider, evidence, export or AI expansion and expiry preserves the record', () => {
    const f = fixture(), { nextState: s, activationIntent: r } = f.activate();
    const e = resolveEntitlements(s.entitlementState, s.tenantAggregate, f.preparation.scope, LATER, s.flags);
    assert.equal(e.product.code, 'dashboard_score'); assert.equal(e.modules.cyber_security.eligible, true);
    for (const module of ['evidence', 'board_reports', 'ai_governance', 'it_optimisation', 'services']) assert.equal(e.modules[module].eligible, false);
    assert.equal(e.admissionGranted, false); assert.equal(e.providerAccessGranted, false);
    assert.equal(e.governanceWorkflowEligible, false);
    assert.equal(resolveEntitlements(s.entitlementState, s.tenantAggregate, f.preparation.scope, r.validUntil, s.flags).product, null);
    assert.equal(s.tenantAggregate.organisations[0].recordStatus, 'active');
});
test('consultant client activation shares the original term and creates no backdated membership', () => {
    const f = fixture({ accountType: 'consultant', kind: 'client' }), { nextState: s, activationIntent: r } = f.activate();
    assert.equal(r.accountActivatedAt, AT); assert.equal(r.validUntil, accountWindow(AT).validUntil);
    assert.equal(s.membershipState.memberships[0].validFrom, LATER);
    assert.equal(s.membershipState.memberships[0].validUntil, r.validUntil);
    assert.match(f.preparation.schedule.scheduleText, /1 workspace plus up to 3 client organisations/);
    assert.throws(() => fixture({ accountType: 'company', kind: 'client' }));
    assert.throws(() => compileStarterActivation({ ...f.input, accountActivatedAt: null }));
    assert.throws(() => compileStarterActivation({ ...f.input, accountActivatedAt: '2026-10-05T00:00:00.000Z' }));
    assert.throws(() => compileStarterActivation({ ...f.input, occurredAt: r.validUntil }));
});
test('the new consultant count policy changes only new schedule wording and preserves price, term, seats and consent', () => {
    const f = fixture({ accountType: 'consultant', kind: 'client', consultantOrganisationPolicy: 'unlimited-v1' });
    const { nextState, activationIntent } = f.activate();
    assert.match(f.preparation.schedule.scheduleText, /No product limit on the number of client organisations managed/);
    assert.match(f.preparation.schedule.scheduleText, /each organisation still requires its own authority, accepted scope and active access/);
    assert.doesNotMatch(f.preparation.schedule.scheduleText, /up to 3 client organisations/);
    assert.match(f.preparation.schedule.scheduleText, /Price: NZ\$0\. No payment authority, automatic renewal or conversion to paid access/);
    assert.match(f.preparation.schedule.scheduleText, /Extra services require separate express agreement/);
    assert.equal(activationIntent.validUntil, accountWindow(AT).validUntil);
    assert.deepEqual(nextState.entitlementState.grants[0].limits,
        { assessment_runs: 5, memberships: 1, ai_requests: 0, evidence_bytes: 0, report_exports: 0 });
    for (const consultantOrganisationPolicy of [null, false, 'unlimited', 'free-organisations']) {
        assert.throws(() => compileStarterSchedule({ ...f.source.offerInput, consultantOrganisationPolicy }));
    }
    assert.throws(() => compileStarterSchedule(offerInput({ consultantOrganisationPolicy: 'unlimited-v1' })));
    assert.throws(() => compileStarterActivation({ ...f.input, acceptance: null }));
    const historical = { ...f.source.offerInput }; delete historical.consultantOrganisationPolicy;
    const oldSchedule = compileStarterSchedule(historical);
    assert.match(oldSchedule.schedule.scheduleText, /up to 3 client organisations/);
    assert.notEqual(oldSchedule.schedule.scheduleDigest, f.preparation.schedule.scheduleDigest);
    assert.throws(() => compileStarterActivation({ ...f.input, acceptance: { ...f.acceptance,
        scheduleDigest: oldSchedule.schedule.scheduleDigest } }));
});
test('historical consultant schedules reproduce their original exact digests for both retained plans', () => {
    const id = n => '10000000-0000-4000-8000-' + String(n).padStart(12, '0');
    const input = { tenantId: id(1), organisationId: id(2), organisationName: 'Synthetic retained consultant',
        accountType: 'consultant', kind: 'client', grantId: id(3), scheduleId: id(4),
        contact: { name: 'Synthetic representative', role: 'Owner', email: 'synthetic@example.test',
            address: 'Synthetic address', registrationId: null, authorityEvidenceId: 'synthetic-declaration' },
        framework: { moduleId: 'cyber_security', profileId: 'synthetic-cyber', version: '1', scoringVersion: '1' } };
    assert.equal(compileStarterSchedule(input).schedule.scheduleDigest, 'b2a9f3c6c731bd9a7a68145c20e50f2549104005854b7a791756fb02e584e764');
    assert.equal(compileStarterSchedule({ ...input, planId: 'nf-starter-2026-10-r2' }).schedule.scheduleDigest,
        '1e455d1af6348acb28b33659f5953da9c6d2ca4c8c1c0a950698c54058ad69aa');
    const old = compileStarterSchedule({ ...input, planId: 'nf-starter-2026-10-r2' });
    const current = compileStarterSchedule({ ...input, planId: 'nf-starter-2026-10-r2', consultantOrganisationPolicy: 'unlimited-v1' });
    assert.deepEqual(current.terms, old.terms);
    assert.match(current.schedule.scheduleText, /3 calendar months/);
    assert.match(current.schedule.scheduleText, /Price: NZ\$0/);
});
test('the first member consumes the only seat and the existing quota engine permits exactly five submissions', () => {
    const f = fixture(), { nextState: s } = f.activate(), grant = s.entitlementState.grants[0];
    assert.deepEqual(grant.limits, { assessment_runs: 5, memberships: 1, ai_requests: 0, evidence_bytes: 0, report_exports: 0 });
    let usage = s.usage[0]; assert.equal(usage.counters.memberships, 1); assert.equal(usage.revision, 1);
    const spend = (limit, moduleId, framework) => {
        usage = consumeEntitlementLimit(s.entitlementState, s.tenantAggregate, usage, { ...f.preparation.scope,
            grantId: grant.grantId, expectedEntitlementRevision: 1, expectedFlagRevision: 1,
            expectedUsageRevision: usage.revision, moduleId, limit, amount: 1, framework }, LATER, s.flags);
    };
    assert.throws(() => spend('memberships', 'overview', null), /limit_exceeded/);
    for (let i = 0; i < 5; i++) spend('assessment_runs', 'cyber_security', { profileId: 'synthetic-cyber', version: '1.0' });
    assert.throws(() => spend('assessment_runs', 'cyber_security', { profileId: 'synthetic-cyber', version: '1.0' }), /limit_exceeded/);
    assert.throws(() => spend('ai_requests', 'cyber_security', null), /feature_disabled/);
    assert.equal(usage.counters.assessment_runs, 5);
});
test('foreign or altered consent and pre-consent activation are rejected', () => {
    const f = fixture();
    for (const change of [{ subjectKey: ISSUER }, { organisationId: crypto.randomUUID() }, { tenantId: crypto.randomUUID() },
        { invitationId: crypto.randomUUID() }, { scheduleId: crypto.randomUUID() }, { scheduleDigest: 'a'.repeat(64) },
        { termsDigest: 'b'.repeat(64) }, { termsVersion: 'unapproved' }, { acceptedAt: Date.parse(AT) - 1 },
        { acceptedAt: Date.parse(LATER) + 1 }, { dashboardAccess: true }]) {
        assert.throws(() => compileStarterActivation({ ...f.input, acceptance: { ...f.acceptance, ...change } }));
    }
    assert.throws(() => compileStarterActivation({ ...f.input, acceptance: null }));
    assert.throws(() => compileStarterActivation({ ...f.input, accountActivatedAt: AT }));
});
test('unknown plan/role fields, invalid IDs and generic plan approval as representative evidence fail closed', () => {
    const source = offerInput();
    for (const extra of [{ plan: 'unlimited' }, { roles: ['operator'] }, { priceNzd: 100 }, { activatedAt: AT }]) {
        assert.throws(() => compileStarterSchedule({ ...source, ...extra }));
    }
    assert.throws(() => compileStarterSchedule({ ...source, tenantId: source.organisationId }));
    assert.throws(() => compileStarterSchedule({ ...source, accountType: 'operator' }));
    for (const authorityEvidenceId of ['', approvedStarterPlan().approvalRef, approvedStarterPlan().planId]) {
        assert.throws(() => compileStarterSchedule({ ...source, contact: { ...source.contact, authorityEvidenceId } }));
    }
    assert.throws(() => compileStarterSchedule({ ...source, organisationName: 'Name\nExtra terms' }));
});
test('a preparation must come from the compiler and restarting from the same durable inputs preserves the activation proposal', () => {
    const f = fixture();
    const clone = value => JSON.parse(JSON.stringify(value));
    assert.throws(() => compileStarterActivation({ ...f.input, preparation: clone(f.preparation) }));
    const restored = compileStarterPreparation(clone(f.source));
    assert.deepEqual(compileStarterActivation({ ...f.input, preparation: restored }), f.activate());
});

test('the count policy predicate recognises only the consultant policy marker', () => {
    const { usesUnlimitedConsultantPolicy } = require('../api/shared/customerSignup/customerStarterPlan');
    assert.equal(usesUnlimitedConsultantPolicy({accountType:'consultant',consultantOrganisationPolicy:'unlimited-v1'}),true);
    for(const value of [undefined,null,{}, {accountType:'company',consultantOrganisationPolicy:'unlimited-v1'},
        {accountType:'consultant'}, {accountType:'consultant',consultantOrganisationPolicy:'future'},
        {accountType:'consultant',consultantOrganisationPolicy:true}]) assert.equal(usesUnlimitedConsultantPolicy(value),false);
});
