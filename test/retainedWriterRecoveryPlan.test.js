'use strict';
const { hash } = require('../api/shared/appLifecycle/dashboardRuntimeRecords');
const { createRetainedWriterRecoveryPlan } = require('../api/shared/customerSignup/retainedWriterRecoveryPlan');
const uid = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
function evidence() {
    const binding = { operationId: uid(1), sourceSha: 'a'.repeat(40), writerDigest: 'b'.repeat(64), targetDigest: 'c'.repeat(64), fenceId: uid(2), fenceGeneration: 4 };
    const bindingSha256 = hash(binding), base = { bindingSha256 };
    const pointer = () => ({ ...base, originalVersion: 'version-1', originalSha256: 'd'.repeat(64), currentVersion: null, currentSha256: null });
    return { schemaVersion: 1, binding,
        fence: { ...base, retained: true, current: true, noSuccessor: true, markerClearStopped: true },
        drain: { ...base, admissionStopped: true, allWritersCovered: true, detachedSettled: true, issuedReconciled: true },
        account: pointer(), authority: pointer(), dependencies: { ...base, sqlUnchanged: true, indexReconciled: true }, audit: { ...base, complete: true } };
}
const make = verifier => createRetainedWriterRecoveryPlan({ verifyEvidence: verifier });
test('requires a separately supplied verifier and fails closed on refusal, exception or non-boolean', async () => {
    expect(await make()(evidence())).toMatchObject({ status: 'blocked', code: 'verifier_unavailable', authoritative: false });
    for (const verifier of [() => false, () => 1, () => { throw Error('secret'); }])
        expect(await make(verifier)(evidence())).toEqual({ status: 'blocked', code: 'evidence_unverified', authoritative: false });
});
test('returns a non-authoritative ordered proposal, with immutable detached verifier input', async () => {
    const e = evidence(); let seen;
    const result = await make(async value => { seen = value; e.binding.fenceGeneration = 9; return true; })(e);
    expect(Object.isFrozen(seen.drain)).toBe(true); expect(seen.binding.fenceGeneration).toBe(4);
    expect(result).toEqual({ status: 'assessment', code: 'prerequisites_reported', authoritative: false,
        executionAuthorized: false, evidenceSha256: hash(seen), prerequisites: [
            'independently_verify_current_fence_and_writer_drain', 'independently_verify_original_and_current_pointer_versions',
            'independently_verify_dependencies_and_audit', 'design_atomic_execution_and_separate_authorization'] });
    expect(Object.isFrozen(result.prerequisites)).toBe(true);
});
test.each([
    ['fence', 'retained', 'fence_unconfirmed'], ['fence', 'current', 'fence_unconfirmed'],
    ['fence', 'noSuccessor', 'fence_unconfirmed'], ['fence', 'markerClearStopped', 'fence_unconfirmed'],
    ['drain', 'admissionStopped', 'drain_unconfirmed'], ['drain', 'allWritersCovered', 'drain_unconfirmed'],
    ['drain', 'detachedSettled', 'drain_unconfirmed'], ['drain', 'issuedReconciled', 'drain_unconfirmed'],
    ['dependencies', 'sqlUnchanged', 'dependencies_unconfirmed'], ['dependencies', 'indexReconciled', 'dependencies_unconfirmed'],
    ['audit', 'complete', 'audit_unconfirmed']
])('blocks missing %s.%s evidence', async (part, key, code) => {
    const e = evidence(); e[part][key] = false;
    expect(await make(() => true)(e)).toMatchObject({ status: 'blocked', code });
});
test.each(['fence', 'drain', 'account', 'authority', 'dependencies', 'audit'])('rejects cross-bound %s evidence before verifier', async part => {
    const e = evidence(), verify = jest.fn(() => true); e[part].bindingSha256 = 'f'.repeat(64);
    expect(await make(verify)(e)).toMatchObject({ status: 'blocked', code: 'invalid_evidence' }); expect(verify).not.toHaveBeenCalled();
});
test('refuses conflicting pointers and does not propose restoring present originals', async () => {
    const e = evidence(); e.account.currentVersion = 'version-2'; e.account.currentSha256 = 'e'.repeat(64);
    expect(await make(() => true)(e)).toMatchObject({ code: 'pointer_conflict' });
    e.account.currentSha256 = e.account.originalSha256;
    expect(await make(() => true)(e)).toMatchObject({ code: 'pointer_conflict' });
    e.account.currentVersion = e.account.originalVersion;
    expect(await make(() => true)(e)).toMatchObject({ status: 'assessment', executionAuthorized: false });
});
test('rejects accessors and unexpected properties without invoking them', async () => {
    const e = evidence(), getter = jest.fn(); Object.defineProperty(e.drain, 'detachedSettled', { enumerable: true, get: getter });
    expect(await make(() => true)(e)).toMatchObject({ code: 'invalid_evidence' }); expect(getter).not.toHaveBeenCalled();
    const extra = evidence(); extra.audit.extra = true;
    expect(await make(() => true)(extra)).toMatchObject({ code: 'invalid_evidence' });
});

test.each(['refuse', 'throw'])('concurrent verifier %s cannot borrow another call’s attestation', async outcome => {
    const first = evidence(), second = evidence();
    second.binding.operationId = uid(3);
    const secondBinding = hash(second.binding);
    for (const part of ['fence', 'drain', 'account', 'authority', 'dependencies', 'audit']) second[part].bindingSha256 = secondBinding;
    let releaseFirst, releaseSecond;
    const firstGate = new Promise(resolve => { releaseFirst = resolve; });
    const secondGate = new Promise(resolve => { releaseSecond = resolve; });
    const snapshots = [];
    const evaluate = make(async snapshot => {
        snapshots.push(snapshot);
        if (snapshot.binding.operationId === uid(1)) { await firstGate; return true; }
        await secondGate;
        if (outcome === 'throw') throw Error('verifier failed');
        return false;
    });
    const accepted = evaluate(first), rejected = evaluate(second);
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]).not.toBe(snapshots[1]);
    first.binding.fenceGeneration = 10; second.binding.fenceGeneration = 11;
    releaseFirst();
    const assessment = await accepted;
    expect(assessment).toMatchObject({ status: 'assessment', authoritative: false, executionAuthorized: false, evidenceSha256: hash(snapshots[0]) });
    expect(snapshots.map(snapshot => snapshot.binding.fenceGeneration)).toEqual([4, 4]);
    releaseSecond();
    expect(await rejected).toEqual({ status: 'blocked', code: 'evidence_unverified', authoritative: false });
});
