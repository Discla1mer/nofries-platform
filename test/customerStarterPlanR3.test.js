'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const test = global.test || require('node:test');
const { LEGACY_PLAN_ID, THREE_MONTH_PLAN_ID, THREE_MONTH_PLAN_R3_ID, THREE_MONTH_PLAN_IDS, APPROVED_PLAN_IDS, isThreeMonthPlan,
    approvedStarterPlan, accountWindow, starterAuthorityExpiry, compileStarterSchedule, compileStarterPreparation,
    compileStarterActivation } = require('../api/shared/customerSignup/customerStarterPlan');
const id = n => '10000000-0000-4000-8000-' + String(n).padStart(12, '0');
const SUBJECT = id(5) + ':' + id(6);
const drafts = path.join(__dirname, '../docs/legal/drafts');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function offer(planId, overrides = {}) {
    return { tenantId: id(1), organisationId: id(2), organisationName: 'Synthetic Compatibility Ltd',
        accountType: 'company', kind: 'own', grantId: id(3), scheduleId: id(4),
        ...(planId === undefined ? {} : { planId }),
        contact: { name: 'Synthetic Representative', role: 'Owner', email: 'synthetic@example.test',
            address: 'Synthetic address', registrationId: null, authorityEvidenceId: 'synthetic-compatibility-declaration' },
        framework: { moduleId: 'cyber_security', profileId: 'synthetic-cyber', version: '1.0', scoringVersion: 'synthetic-1' }, ...overrides };
}

test('the r3 plan is a closed copy of the three-month trial under the r4 agreement', () => {
    const r2 = approvedStarterPlan(THREE_MONTH_PLAN_ID), r3 = approvedStarterPlan(THREE_MONTH_PLAN_R3_ID);
    assert.deepEqual(THREE_MONTH_PLAN_IDS, [THREE_MONTH_PLAN_ID, THREE_MONTH_PLAN_R3_ID]);
    assert.deepEqual(APPROVED_PLAN_IDS, [LEGACY_PLAN_ID, THREE_MONTH_PLAN_ID, THREE_MONTH_PLAN_R3_ID]);
    assert.ok(isThreeMonthPlan(THREE_MONTH_PLAN_R3_ID)); assert.ok(isThreeMonthPlan(THREE_MONTH_PLAN_ID));
    for (const other of [LEGACY_PLAN_ID, 'unknown', undefined, null, '__proto__']) assert.equal(isThreeMonthPlan(other), false);
    // Only identity, approval and agreement differ. Limits, price and data rules are the same.
    const differing = ['planId', 'approvalRef', 'approvedAt', 'termsVersion', 'termsDigest', 'sha256'];
    for (const key of Object.keys(r2)) {
        if (differing.includes(key)) assert.notEqual(r3[key], r2[key], key); else assert.deepEqual(r3[key], r2[key], key);
    }
    assert.deepEqual(Object.keys(r3), Object.keys(r2));
    assert.equal(r3.termsVersion, 'nf-dashboard-2026-11-r4'); assert.equal(r3.approvedAt, '2026-11-09T00:00:00.000Z');
    assert.equal(r3.priceNzd, 0); assert.equal(r3.automaticPaidConversion, false); assert.ok(Object.isFrozen(r3));
    assert.equal(approvedStarterPlan().planId, LEGACY_PLAN_ID, 'the new plan is never the default');
});

test('retained plans keep their exact hashes and the SQL proposal pins the new one', () => {
    assert.equal(approvedStarterPlan().sha256, '171183757f61a1c7ce51667ff33a782558ae509cbb1d398538e22e95567c1ffb');
    assert.equal(approvedStarterPlan(THREE_MONTH_PLAN_ID).sha256, '52b690a1c36613938a50b86faa95a6cc1a01d6aafb3c42f0438eee3871e06024');
    const r3 = approvedStarterPlan(THREE_MONTH_PLAN_R3_ID);
    const proposal = fs.readFileSync(path.join(__dirname, '../database/proposals/customer_starter_plan_r3.sql'), 'utf8');
    for (const plan of APPROVED_PLAN_IDS.map(planId => approvedStarterPlan(planId))) {
        for (const pinned of [plan.planId, plan.sha256, plan.termsVersion, plan.termsDigest]) assert.ok(proposal.includes(pinned), pinned);
    }
    assert.equal(proposal.split(r3.sha256).length - 1, 2);
    assert.match(proposal, /UNAPPLIED PROPOSAL ONLY/);
    assert.doesNotMatch(proposal, /\b(?:UPDATE|DELETE\s+FROM|INSERT\s+INTO|GRANT)\s+nofries\./i);
    assert.doesNotMatch(proposal, /SECURITY\s+DEFINER|DISABLE\s+ROW\s+LEVEL\s+SECURITY|interval\s+'(?:90|93)\s+days'/i);
    assert.match(proposal, /jsonb_array_length\(grant_value#>'\{0,modules\}'\) = 3/);
    assert.ok(!JSON.stringify(fs.readdirSync(path.join(__dirname, '../database/migrations'))).includes('customer_starter_plan_r3'));
});

test('the r4 agreement matches its pinned digest and changes only the intended clauses of r3', () => {
    const r3Text = fs.readFileSync(path.join(drafts, 'nf-dashboard-2026-10-r3.txt'), 'utf8');
    const r4Text = fs.readFileSync(path.join(drafts, 'nf-dashboard-2026-11-r4.txt'), 'utf8');
    assert.equal(sha(r4Text), approvedStarterPlan(THREE_MONTH_PLAN_R3_ID).termsDigest);
    assert.equal(sha(r3Text), approvedStarterPlan(THREE_MONTH_PLAN_ID).termsDigest);
    assert.doesNotMatch(r4Text, /DRAFT|NOT OPERATIVE/);
    const same = text => text.replace('nf-dashboard-2026-10-r3', 'V').replace('nf-dashboard-2026-11-r4', 'V')
        .replace('nf-starter-2026-10-r2', 'P').replace('nf-starter-2026-11-r3', 'P').split('\n');
    const before = same(r3Text), after = same(r4Text);
    const removed = before.filter(line => !after.includes(line)), added = after.filter(line => !before.includes(line));
    assert.equal(removed.length, 4); assert.equal(added.length, 5);
    assert.match(added[0], /NZ\$1,000 for complimentary access/);
    assert.match(added[0], /confidentiality, privacy and security obligations have a separate higher limit/);
    assert.match(added[1], /^\(b\) .*NZ\$1,000 in total/);
    assert.match(added[2], /^\(c\) .*clause 4 .*clause 5 .*greater of NZ\$10,000/);
    assert.match(added[3], /^A contract year .*a single NZ\$1,000 amount for that year/);
    assert.match(removed[2], /^A contract year .*a single NZ\$100 amount for that year/);
    assert.match(added[4], /^12\.7 .*Fair Trading Act 1986 \(sections 26A and 46H to 46M\).*Privacy Act 2020/);
    assert.match(r4Text, /For a new complimentary starter schedule identified as nf-starter-2026-11-r3, the trial lasts three calendar months/);
    assert.match(r4Text, /at least 14 days to resolve it before suspending for non-payment/);
    assert.match(r4Text, /material breach that remains unresolved 14 days after written notice/);
});

test('the r3 schedule lists only released modules and leaves retained schedules byte-identical', () => {
    const legacy = compileStarterSchedule(offer()), r2 = compileStarterSchedule(offer(THREE_MONTH_PLAN_ID));
    const r3 = compileStarterSchedule(offer(THREE_MONTH_PLAN_R3_ID));
    for (const old of [legacy, r2]) {
        assert.match(old.schedule.scheduleText, /\nIncluded: Overview, manual Cyber Security assessment and Improvement Plan\.\n/);
        assert.match(old.schedule.scheduleText, /\nPrivacy notice: privacy\.html, 29 September 2026\.\n/);
    }
    const lines = text => text.split('\n'), a = lines(r2.schedule.scheduleText), b = lines(r3.schedule.scheduleText);
    assert.equal(a.length, b.length);
    const changed = b.filter((line, index) => line !== a[index]);
    assert.deepEqual(changed, [
        `Schedule: ${id(4)}; version: nf-starter-2026-11-r3`,
        'Included: Overview and manual Cyber Security assessment. The Improvement Plan is included when it is released.',
        'Privacy notice: privacy.html, 9 November 2026.',
        `Agreement: nf-dashboard-2026-11-r4; SHA-256: ${approvedStarterPlan(THREE_MONTH_PLAN_R3_ID).termsDigest}.`]);
    assert.equal(r3.schedule.scheduleDigest, sha(r3.schedule.scheduleText));
    assert.deepEqual(r3.terms, { termsVersion: 'nf-dashboard-2026-11-r4', termsDigest: approvedStarterPlan(THREE_MONTH_PLAN_R3_ID).termsDigest });
    assert.match(fs.readFileSync(path.join(__dirname, '../privacy.html'), 'utf8'), /Last updated: 9 November 2026/);
    // A plan or approval reference is never evidence of a person's authority.
    const plan = approvedStarterPlan(THREE_MONTH_PLAN_R3_ID);
    for (const authorityEvidenceId of [plan.planId, plan.approvalRef]) for (const planId of APPROVED_PLAN_IDS) {
        const input = offer(planId); input.contact = { ...input.contact, authorityEvidenceId };
        assert.throws(() => compileStarterSchedule(input));
    }
});

test('the r3 plan uses the same three-month window and cannot start before its approval', () => {
    for (const at of ['2026-11-30T23:59:59.999Z', '2027-01-31T00:00:00.000Z', '2027-11-30T08:20:33.123Z', '2028-02-29T08:20:33.123Z']) {
        assert.equal(accountWindow(at, THREE_MONTH_PLAN_R3_ID).validUntil, accountWindow(at, THREE_MONTH_PLAN_ID).validUntil);
        assert.equal(starterAuthorityExpiry(Date.parse(at), THREE_MONTH_PLAN_R3_ID), starterAuthorityExpiry(Date.parse(at), THREE_MONTH_PLAN_ID));
    }
    assert.throws(() => accountWindow('2026-11-08T23:59:59.999Z', THREE_MONTH_PLAN_R3_ID));
    const source = { offerInput: offer(THREE_MONTH_PLAN_R3_ID), subjectKey: SUBJECT, issuerSubjectKey: SUBJECT, invitationId: id(7) };
    assert.throws(() => compileStarterPreparation({ ...source, createdAt: '2026-11-08T23:59:59.999Z' }));
    const occurredAt = '2026-11-30T12:34:56.789Z';
    const preparation = compileStarterPreparation({ ...source, createdAt: '2026-11-09T01:00:00.000Z' });
    const acceptance = { receiptId: id(8), invitationId: preparation.invitationId, subjectKey: SUBJECT, ...preparation.scope,
        ...preparation.terms, scheduleId: preparation.schedule.scheduleId, scheduleDigest: preparation.schedule.scheduleDigest,
        acceptedAt: Date.parse(occurredAt), status: 'pending_admission', dashboardAccess: false };
    const input = { preparation, accountId: id(9), activationId: id(10), membershipId: id(11), acceptance, occurredAt, accountActivatedAt: null };
    const activation = compileStarterActivation(input);
    assert.equal(activation.activationIntent.planId, THREE_MONTH_PLAN_R3_ID);
    assert.equal(activation.activationIntent.planSha256, approvedStarterPlan(THREE_MONTH_PLAN_R3_ID).sha256);
    assert.equal(activation.activationIntent.validUntil, '2027-02-28T12:34:56.789Z');
    const grant = activation.nextState.entitlementState.grants[0];
    assert.deepEqual([...grant.modules].sort(), ['cyber_security', 'improvement_plan', 'overview']);
    assert.equal(grant.limits.assessment_runs, null); assert.equal(grant.limits.memberships, 1);
    // Consent to another agreement version cannot activate this offer.
    const old = approvedStarterPlan(THREE_MONTH_PLAN_ID);
    assert.throws(() => compileStarterActivation({ ...input,
        acceptance: { ...acceptance, termsVersion: old.termsVersion, termsDigest: old.termsDigest } }));
});
