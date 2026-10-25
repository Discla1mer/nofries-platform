'use strict';
const records = require('../api/shared/dashboardAdmin/signupListingRecords');
const { hash } = require('../api/shared/appLifecycle/dashboardRuntimeRecords');
const { uid, ACTOR, clone, record } = require('./fixtures/dashboardAdminSignupFixture');
const TARGET = { instanceId: uid(80), operatorSubjectKey: ACTOR, provider: 'legacy',
    populationId: 'synthetic-population', indexId: 'synthetic-index', sourceBindingSha256: 'a'.repeat(64) };
const AT = '2026-10-20T07:30:00.000Z', EPOCH = uid(81);
function fixture(count = 2) {
    const entries = Array.from({ length: count }, (_, i) => {
        const value = record(i + 1); return { recordId: value.recordId, binding: value.binding };
    });
    const index = { manifest: { schemaVersion: 2, provider: TARGET.provider, populationId: TARGET.populationId,
        indexId: TARGET.indexId, entries }, sourceReferences: entries.map((entry, i) => ({ entry: clone(entry),
        accountKey: 'starter-accounts/' + hash({ synthetic: i }) })), revision: 3, restoreEpoch: EPOCH,
        sourceBindingSha256: TARGET.sourceBindingSha256, complete: true };
    const policy = { coverage: 'complete_application_signups', approvedAt: '2026-10-20T06:00:00.000Z',
        validFrom: '2026-10-20T07:00:00.000Z', validUntil: null, decisionWindowMs: 3600000, pageSize: 25,
        fields: ['email', 'organisation', 'accountType', 'milestones'], auditPolicy: { reference: 'synthetic-audit', revision: 1,
            agreementVersion: 'nf-dashboard-2026-09-r2', retention: { unit: 'calendar_months', count: 13 } } };
    const revision = { schemaVersion: 1, recordType: 'dashboard_admin_signup_policy_revision', ...TARGET,
        restoreEpoch: EPOCH, revision: 2, status: 'active', changedAt: policy.approvedAt,
        decisionReference: 'synthetic-approval', policy };
    const head = { schemaVersion: 1, recordType: 'dashboard_admin_signup_policy_head', ...TARGET,
        restoreEpoch: EPOCH, revision: 2, status: 'active', recordSha256: hash(revision) };
    return { policy, revision, head, index };
}

test('closed policy, exact head/archive and complete cross-tenant index produce a frozen short-lived decision', () => {
    const f = fixture(); f.index.manifest.entries[1].binding.tenantId = uid(99);
    f.index.sourceReferences[1].entry = clone(f.index.manifest.entries[1]);
    const head = records.listingHead(f.head, TARGET), revision = records.listingRevision(f.revision, head);
    const index = records.completeListingIndex(f.index, TARGET, EPOCH), decision = records.listingDecision(revision, index, AT);
    expect(decision).toMatchObject({ schemaVersion: 2, capability: 'signupList', operatorSubjectKey: ACTOR,
        issuedAt: '2026-10-20T07:00:00.000Z', expiresAt: '2026-10-20T08:00:00.000Z', maxRows: 2, maxPageSize: 2, maxPages: 1,
        scope: { kind: 'finite_manifest', manifestSha256: hash(index.manifest) } });
    expect(Object.isFrozen(decision.scope)).toBe(true); expect(Object.isFrozen(index.sourceReferences[0].entry.binding)).toBe(true);
    expect(decision.authorityRevision).toBe(records.decisionRevision(2, 3));
    expect(records.listingDecision(revision, index, '2026-10-20T07:59:59.999Z')).toEqual(decision);
    expect(records.listingDecision(revision, index, '2026-10-20T08:00:00.000Z')).not.toEqual(decision);
});

test('until-revoked policy continues into later decision windows without silently extending a finite policy', () => {
    const f = fixture();
    expect(records.listingDecision(f.revision, f.index, '2027-01-01T00:10:00.000Z')).toMatchObject({
        issuedAt: '2027-01-01T00:00:00.000Z', expiresAt: '2027-01-01T01:00:00.000Z' });
    f.policy.validUntil = '2026-10-20T07:45:00.000Z';
    expect(records.listingDecision(f.revision, f.index, AT).expiresAt).toBe(f.policy.validUntil);
    expect(records.listingDecision(f.revision, f.index, f.policy.validUntil)).toBeNull();
    expect(records.listingDecision(f.revision, f.index, '2026-10-20T06:59:59.999Z')).toBeNull();
    f.revision.status = 'revoked'; expect(records.listingDecision(f.revision, f.index, AT)).toBeNull();
});

test.each([
    ['unexpected population rule', p => { p.coverage = 'selected_accounts'; }],
    ['extra field', p => { p.extra = true; }],
    ['extra disclosed field', p => { p.fields.push('rawDiagnostic'); }],
    ['wrong field order', p => { p.fields.reverse(); }],
    ['approval after validity start', p => { p.approvedAt = AT; }],
    ['reversed validity', p => { p.validUntil = p.validFrom; }],
    ['overlong decision', p => { p.decisionWindowMs = 3600001; }],
    ['zero decision', p => { p.decisionWindowMs = 0; }],
    ['fractional decision', p => { p.decisionWindowMs = 1000.5; }],
    ['unbounded page', p => { p.pageSize = 26; }],
    ['zero page', p => { p.pageSize = 0; }],
    ['unapproved retention', p => { p.auditPolicy.retention.count = 12; }],
    ['days replacing calendar months', p => { p.auditPolicy.retention = { unit: 'days', count: 395 }; }],
    ['foreign agreement', p => { p.auditPolicy.agreementVersion = 'other'; }],
    ['audit policy omitted', p => { delete p.auditPolicy; }]
])('rejects policy %s', (_, mutate) => { const f = fixture(); mutate(f.policy); expect(() => records.listingPolicy(f.policy)).toThrow(); });

test.each(['instanceId', 'operatorSubjectKey', 'provider', 'populationId', 'indexId', 'sourceBindingSha256'])('head key is bound to %s', key => {
    const other = { ...TARGET, [key]: key === 'instanceId' ? uid(82) : key === 'operatorSubjectKey' ? `${uid(1)}:${uid(83)}` :
        key === 'provider' ? 'external' : key === 'sourceBindingSha256' ? 'b'.repeat(64) : 'synthetic-other' };
    expect(records.listingHeadKey(other)).not.toBe(records.listingHeadKey(TARGET));
    expect(() => records.listingHead(fixture().head, other)).toThrow();
});

test('archive binds every record byte, active policy and revision; revoked record has no retained grant', () => {
    const f = fixture(); const value = clone(f.revision); value.decisionReference = 'different';
    expect(() => records.listingRevision(value, f.head)).toThrow();
    value.status = 'revoked'; value.policy = null; value.revision++;
    const head = { ...f.head, revision: value.revision, status: value.status, recordSha256: hash(value) };
    expect(records.listingRevision(value, head).policy).toBeNull();
    value.policy = f.policy; head.recordSha256 = hash(value);
    expect(() => records.listingRevision(value, head)).toThrow();
    const changed = clone(f.revision); changed.policy.approvedAt = '2026-10-20T05:00:00.000Z';
    expect(() => records.listingRevision(changed, { ...f.head, recordSha256: hash(changed) })).toThrow();
});

test.each([
    ['incomplete', x => { x.complete = false; }],
    ['missing completeness', x => { delete x.complete; }],
    ['different restore epoch', x => { x.restoreEpoch = uid(90); }],
    ['different exact source', x => { x.sourceBindingSha256 = 'b'.repeat(64); }],
    ['different provider', x => { x.manifest.provider = 'external'; }],
    ['different population', x => { x.manifest.populationId = 'other'; }],
    ['different index', x => { x.manifest.indexId = 'other'; }],
    ['single-tenant manifest substitute', x => { x.manifest.schemaVersion = 1; x.manifest.tenantId = uid(1); }],
    ['missing reference', x => { x.sourceReferences.pop(); }],
    ['foreign reference', x => { x.sourceReferences[0].entry.binding.tenantId = uid(90); }],
    ['duplicate source', x => { x.sourceReferences[1].accountKey = x.sourceReferences[0].accountKey; }],
    ['arbitrary blob path', x => { x.sourceReferences[0].accountKey = 'other/private'; }],
    ['negative revision', x => { x.revision = -1; }],
    ['extra index field', x => { x.diagnostics = 'private'; }]
])('rejects index %s', (_, mutate) => { const f = fixture(); mutate(f.index); expect(() => records.completeListingIndex(f.index, TARGET, EPOCH)).toThrow(); });

test('resource limits refuse the complete population instead of selecting the first hundred or limiting traversal', () => {
    const many = fixture(101); expect(() => records.completeListingIndex(many.index, TARGET, EPOCH)).toThrow();
    const limited = fixture(11); limited.policy.pageSize = 1;
    expect(() => records.listingDecision(limited.revision, limited.index, AT)).toThrow();
    const empty = fixture(0); expect(records.listingDecision(empty.revision, empty.index, AT)).toMatchObject({ maxRows: 1, maxPageSize: 1, maxPages: 1 });
});

test('both revisions are injectively represented and unsafe arithmetic refuses', () => {
    const pairs = new Set();
    for (let policy = 0; policy < 20; policy++) for (let index = 0; index < 20; index++) pairs.add(records.decisionRevision(policy, index));
    expect(pairs.size).toBe(400);
    expect(() => records.decisionRevision(Number.MAX_SAFE_INTEGER, 1)).toThrow();
    expect(() => records.decisionRevision(0, -0)).toThrow();
    const f = fixture(); const original = records.listingDecision(f.revision, f.index, AT);
    f.index.revision++;
    expect(records.listingDecision(f.revision, f.index, AT)).not.toEqual(original);
});

test('finite decision end is capped and out-of-contract calendar overflow fails closed', () => {
    const f = fixture(); f.policy.validFrom = '9999-12-31T23:59:59.000Z';
    f.policy.approvedAt = f.policy.validFrom;
    expect(() => records.listingDecision(f.revision, f.index, f.policy.validFrom)).toThrow();
    f.policy.validUntil = '9999-12-31T23:59:59.999Z';
    expect(records.listingDecision(f.revision, f.index, f.policy.validFrom).expiresAt).toBe(f.policy.validUntil);
});
