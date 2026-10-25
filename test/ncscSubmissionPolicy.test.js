'use strict';

const { createNcscSubmissionQuotaResolver: createResolver } = require('../lib/ncscSubmissionPolicy');
const { MODULE_ID, ACCEPTED_PROFILE_REF } = require('../api/shared/assessmentEngine/ncscAssessmentEvaluator');
const policy = (changes = {}) => ({ schemaVersion: 1, tenantId: 'synthetic-a', organisationId: 'synthetic-org',
    productGrantId: 'synthetic-product', agreementRef: 'synthetic-agreement', moduleId: MODULE_ID,
    profileRef: { ...ACCEPTED_PROFILE_REF }, policyId: 'synthetic-policy', policyRevision: 0,
    validFrom: '2026-09-01T00:00:00.000Z', validUntil: '2026-10-01T00:00:00.000Z',
    limit: 'assessment_runs', amount: 1, ...changes });
const manifest = (...policies) => ({ schemaVersion: 1, policies });
const selection = (changes = {}) => ({ tenantId: 'synthetic-a', organisationId: 'synthetic-org',
    productGrantId: 'synthetic-product', agreementRef: 'synthetic-agreement', moduleId: MODULE_ID,
    profileRef: { ...ACCEPTED_PROFILE_REF }, assessmentId: 'synthetic-assessment',
    actorSubjectKey: '10000000-0000-4000-8000-000000000001:20000000-0000-4000-8000-000000000002',
    expectedRevision: 1, submissionRevision: 2, at: '2026-09-16T00:00:00.000Z', ...changes });

test('returns the retained policy synchronously and detaches every mutable input', () => {
    const source = manifest(policy()), resolver = createResolver(source);
    source.policies[0].amount = 99; source.policies[0].profileRef.profileId = 'changed';
    const result = resolver(selection());
    expect(result).toEqual(policy()); expect(result).not.toBeInstanceOf(Promise);
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.profileRef)).toBe(true);
    expect(() => { result.amount = 2; }).toThrow(TypeError);
    expect(resolver(selection())).toEqual(policy());
});
test.each(['tenantId', 'organisationId', 'productGrantId', 'agreementRef', 'moduleId'])('denies mismatched %s', key => {
    expect(() => createResolver(manifest(policy()))(selection({ [key]: 'other' }))).toThrow('ncsc_submission_policy_unavailable');
});
test.each([
    { profileRef: { ...ACCEPTED_PROFILE_REF, profileId: 'other' } },
    { actorSubjectKey: 'unverified' }, { expectedRevision: null }, { expectedRevision: -1 },
    { submissionRevision: 1 }, { submissionRevision: 3 },
    { expectedRevision: Number.MAX_SAFE_INTEGER, submissionRevision: Number.MAX_SAFE_INTEGER },
    { at: '2026-08-31T23:59:59.999Z' }, { at: '2026-10-01T00:00:00.000Z' }, { extra: true }
])('denies invalid or out-of-window selection %j', change => {
    expect(() => createResolver(manifest(policy()))(selection(change))).toThrow('ncsc_submission_policy_unavailable');
});
test('uses inclusive start and exclusive end with exactly adjacent retained revisions', () => {
    const second = policy({ policyRevision: 1, validFrom: '2026-10-01T00:00:00.000Z', validUntil: '2026-11-01T00:00:00.000Z', amount: 2 });
    const resolver = createResolver(manifest(policy(), second));
    expect(resolver(selection({ at: policy().validFrom }))).toEqual(policy());
    expect(resolver(selection({ at: second.validFrom }))).toEqual(second);
});
test.each([
    {}, { schemaVersion: 2, policies: [policy()] }, manifest(...Array(129).fill(policy())),
    manifest(policy({ amount: 0 })), manifest(policy({ amount: -1 })), manifest(policy({ amount: 1.5 })),
    manifest(policy({ amount: Number.MAX_SAFE_INTEGER + 1 })), manifest(policy({ policyRevision: -1 })),
    manifest(policy({ validUntil: policy().validFrom })), manifest(policy({ validFrom: '2026-02-30T00:00:00.000Z' })),
    manifest(policy({ limit: 'unlimited' })), manifest(policy({ moduleId: 'other' })),
    manifest(policy({ profileRef: { ...ACCEPTED_PROFILE_REF, extra: true } })), manifest(policy({ extra: true })),
    manifest(policy(), policy({ tenantId: 'other' })),
    manifest(policy(), policy({ policyId: 'different-policy' }))
])('rejects invalid or ambiguous policy manifests', input => {
    expect(() => createResolver(input)).toThrow('ncsc_submission_policy_unavailable');
});
test('separate scopes use separate retained policies without deriving fields from selection', () => {
    const other = policy({ tenantId: 'synthetic-b', policyId: 'synthetic-other-policy', amount: 2 });
    const resolver = createResolver(manifest(policy(), other));
    expect(resolver(selection({ tenantId: 'synthetic-b' }))).toEqual(other);
});
test('rejects accessors and proxies without evaluating their hooks', () => {
    let calls = 0;
    const input = manifest(policy());
    Object.defineProperty(input.policies[0], 'amount', { enumerable: true, get() { calls++; return 1; } });
    expect(() => createResolver(input)).toThrow('ncsc_submission_policy_unavailable');
    expect(() => createResolver(new Proxy(manifest(policy()), { get() { calls++; throw new Error('private'); } }))).toThrow('ncsc_submission_policy_unavailable');
    expect(calls).toBe(0);
});
test('the shipped empty manifest permits draft routes but cannot select a submission policy', () => {
    const shipped = require('../lib/ncscSubmissionPolicies.json');
    expect(shipped).toEqual(manifest());
    const resolve = createResolver(shipped);
    expect(() => resolve(selection())).toThrow('ncsc_submission_policy_unavailable');
    let failure; try { resolve(selection()); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: 'ncsc_submission_unavailable' });
    expect(() => resolve(selection({ tenantId: 'another-tenant', organisationId: 'another-org' })))
        .toThrow('ncsc_submission_policy_unavailable');
});
