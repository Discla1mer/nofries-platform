'use strict';

const { Readable } = require('node:stream');
const { createNcscPolicyReader, createNcscPolicyPublisher, archiveKey } = require('../api/shared/customerSignup/ncscPolicyStore');
const { createDurableNcscSubmissionQuotaResolver } = require('../lib/ncscSubmissionPolicy');
const { ACCEPTED_PROFILE_REF } = require('../api/shared/assessmentEngine/ncscAssessmentEvaluator');
const NOW = '2026-09-28T00:00:00.000Z', LATER = '2026-10-01T00:00:00.000Z';
const uid = n => `60000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const policy = (changes = {}) => ({ schemaVersion: 1, tenantId: 'synthetic-a', organisationId: 'synthetic-org',
    productGrantId: 'synthetic-product', agreementRef: 'synthetic-agreement', moduleId: 'cyber_security', profileRef: { ...ACCEPTED_PROFILE_REF },
    policyId: 'synthetic-policy', policyRevision: 0, validFrom: '2026-09-01T00:00:00.000Z', validUntil: LATER,
    limit: 'assessment_runs', amount: 1, ...changes });
const entry = (changes = {}) => ({ schemaVersion: 1, policy: policy(changes), approval: {
    approvalId: uid(1), evidenceRef: 'synthetic-approval', evidenceSha256: 'a'.repeat(64), approvedAt: NOW } });
const command = (value = entry(), changes = {}) => ({ schemaVersion: 1, entry: value,
    expectedIndexRevision: null, expectedIndexSha256: null, ...changes });
const selection = (changes = {}) => ({ tenantId: 'synthetic-a', organisationId: 'synthetic-org', productGrantId: 'synthetic-product',
    agreementRef: 'synthetic-agreement', moduleId: 'cyber_security', profileRef: { ...ACCEPTED_PROFILE_REF },
    assessmentId: 'synthetic-assessment', actorSubjectKey: `${uid(2)}:${uid(3)}`, expectedRevision: 1, submissionRevision: 2, at: NOW, ...changes });
function harness() {
    let revision = 0, at = NOW; const records = new Map(), hooks = { upload: async () => {}, download: async () => {} };
    const container = { getBlockBlobClient: key => ({
        async download() {
            await hooks.download(key);
            const found = records.get(key);
            if (!found) throw Object.assign(new Error('private'), { statusCode: 404, code: 'BlobNotFound' });
            return { etag: found.etag, contentLength: found.bytes.length, readableStreamBody: Readable.from([found.bytes]) };
        },
        async uploadData(bytes, options) {
            await hooks.upload(key, bytes, options);
            const old = records.get(key);
            if (options.conditions.ifNoneMatch === '*' ? old : !old || old.etag !== options.conditions.ifMatch)
                throw Object.assign(new Error('private'), { statusCode: 412 });
            records.set(key, { bytes, etag: `etag-${++revision}` });
        }
    }) };
    const beforeWrite = jest.fn(async () => {});
    const publisher = createNcscPolicyPublisher({ authorityContainer: container, clock: () => at, beforeWrite });
    const reader = createNcscPolicyReader({ authorityContainer: container });
    return { records, hooks, container, publisher, reader, beforeWrite, setTime(value) { at = value; },
        resolve: createDurableNcscSubmissionQuotaResolver(reader) };
}
test('additional organisations publish separately without source changes; runtime capability is read-only', async () => {
    const h = harness(); expect(Object.keys(h.reader)).toEqual(['readPolicies']);
    await h.publisher.publish(command());
    await h.publisher.publish(command(entry({ organisationId: 'another-org', policyId: 'another-policy', amount: 2 })));
    expect(await h.resolve(selection())).toEqual(policy());
    expect(await h.resolve(selection({ organisationId: 'another-org' }))).toEqual(policy({ organisationId: 'another-org', policyId: 'another-policy', amount: 2 }));
    await expect(h.resolve(selection({ tenantId: 'foreign' }))).rejects.toMatchObject({ code: 'ncsc_submission_unavailable' });
    expect(h.records.size).toBe(4);
});
test('publication retries are exact and old archives remain readable after a future revision', async () => {
    const h = harness(), first = await h.publisher.publish(command());
    expect(await h.publisher.publish(command())).toEqual(first);
    const expected = await h.publisher.inspect(command());
    const next = entry({ policyRevision: 1, validFrom: LATER, validUntil: '2026-11-01T00:00:00.000Z', amount: 2 });
    await h.publisher.publish(command(next, expected));
    expect(await h.resolve(selection())).toEqual(policy());
    expect(await h.resolve(selection({ at: LATER }))).toEqual(next.policy);
    expect(await h.publisher.publish(command())).toEqual(first);
    expect(h.records.has(archiveKey(entry()))).toBe(true);
});
test('exact completed publication reconciles after expiry without writing or extending authority', async () => {
    const h = harness(), original = await h.publisher.publish(command());
    const before = [...h.records.entries()]; h.beforeWrite.mockClear(); h.setTime(LATER);
    expect(await h.publisher.publish(command())).toEqual(original);
    expect([...h.records.entries()]).toEqual(before); expect(h.beforeWrite).not.toHaveBeenCalled();
    await expect(h.resolve(selection({ at: LATER }))).rejects.toMatchObject({ code: 'ncsc_submission_unavailable' });
});
test('expiry still rejects a new publication and cannot reconcile changed approval evidence', async () => {
    const h = harness(); await h.publisher.publish(command());
    const expected = await h.publisher.inspect(command()), before = [...h.records.entries()];
    h.beforeWrite.mockClear(); h.setTime(LATER);
    await expect(h.publisher.publish(command(entry({ organisationId: 'expired-new-org', policyId: 'new-policy' }))))
        .rejects.toThrow('ncsc_policy_publication_conflict');
    const changed = entry(); changed.approval.evidenceSha256 = 'b'.repeat(64);
    await expect(h.publisher.publish(command(changed, expected))).rejects.toThrow('ncsc_policy_publication_conflict');
    expect([...h.records.entries()]).toEqual(before); expect(h.beforeWrite).not.toHaveBeenCalled();
});
test.each([
    { policyRevision: 1 }, { amount: 0 }, { policyRevision: 1, validFrom: LATER, policyId: 'replacement' },
    { policyRevision: 0, amount: 2 }
])('invalid or rewriting next policy is refused without publishing %p', async changes => {
    const h = harness(); await h.publisher.publish(command()); const before = [...h.records.entries()];
    const expected = await h.publisher.inspect(command());
    await expect(h.publisher.publish(command(entry(changes), expected))).rejects.toThrow();
    expect([...h.records.entries()]).toEqual(before);
});
test('a stale expected index cannot overwrite a different publisher', async () => {
    const h = harness(); await h.publisher.publish(command());
    const next = entry({ policyRevision: 1, validFrom: LATER, validUntil: '2026-11-01T00:00:00.000Z' });
    const expected = await h.publisher.inspect(command());
    await h.publisher.publish(command(next, expected));
    await expect(h.publisher.publish(command({ ...next, policy: { ...next.policy, amount: 2 } }, expected)))
        .rejects.toThrow('ncsc_policy_publication_conflict');
    expect(await h.resolve(selection({ at: LATER }))).toEqual(next.policy);
});
test('an ETag race after archive creation preserves the existing index', async () => {
    const h = harness(); await h.publisher.publish(command());
    const expected = await h.publisher.inspect(command());
    const next = entry({ policyRevision: 1, validFrom: LATER, validUntil: '2026-11-01T00:00:00.000Z' });
    h.hooks.upload = async (key, _bytes, options) => {
        if (options.conditions.ifMatch) h.records.get(key).etag = 'concurrent-etag';
    };
    await expect(h.publisher.publish(command(next, expected))).rejects.toThrow('ncsc_policy_publication_conflict');
    expect(await h.resolve(selection())).toEqual(policy());
    await expect(h.resolve(selection({ at: LATER }))).rejects.toMatchObject({ code: 'ncsc_submission_unavailable' });
    expect(h.records.has(archiveKey(next))).toBe(true);
});
test('archive corruption fails closed without replacing retained data', async () => {
    const h = harness(); await h.publisher.publish(command());
    const key = archiveKey(entry()); h.records.get(key).bytes = Buffer.from('{}');
    await expect(h.resolve(selection())).rejects.toThrow('ncsc_policy_store_unavailable');
    await expect(h.publisher.publish(command())).rejects.toThrow();
    expect(h.records.get(key).bytes.toString()).toBe('{}');
});
test('public body fields cannot be used as policy records or storage paths', async () => {
    const h = harness();
    await expect(h.publisher.publish({ ...command(), emailVerified: true })).rejects.toThrow();
    await expect(h.reader.readPolicies({ ...selection(), path: 'customer-subjects/arbitrary.json' })).rejects.toThrow();
    expect(h.records.size).toBe(0); expect(h.beforeWrite).not.toHaveBeenCalled();
});
test('approved input mutation while storage is pending cannot alter policy or evidence', async () => {
    const h = harness(), input = command(); let release, entered;
    const started = new Promise(resolve => { entered = resolve; });
    const wait = new Promise(resolve => { release = resolve; });
    h.hooks.download = async () => { entered(); await wait; };
    const pending = h.publisher.publish(input); await started;
    input.entry.policy.amount = 99; input.entry.approval.evidenceSha256 = 'b'.repeat(64); release();
    await pending; expect(await h.resolve(selection())).toEqual(policy());
});
// Private controller assertion remains in the private repository.
