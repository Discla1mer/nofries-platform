'use strict';
const { createAccountWipeExecutor, APPROVAL_MS, OUTCOME_RESERVE_MS, OUTCOME_MIN_MS } = require('../api/shared/dashboardAdmin/accountWipeExecutor');
const { readAccountWipeGraphSettings, createAccountWipeGraphToken, EXCHANGE_SCOPE, GRAPH_SCOPE } = require('../api/shared/dashboardAdmin/accountWipeGraphToken');

const uid = n => '70000000-0000-4000-8000-' + String(n).padStart(12, '0');
const EMAIL = 'synthetic.owner@example.test';
const SUBJECT = uid(1) + ':' + uid(2);
const ACTOR = { subjectKey: uid(90) + ':' + uid(91) };
const SESSION = 'a'.repeat(64), OTHER_SESSION = 'b'.repeat(64);
const DIGEST = 'c'.repeat(64);
const signal = () => new AbortController().signal;

function inventory(overrides = {}) {
    return { account: { accountId: uid(10) }, subjectKey: SUBJECT, tenantIds: [uid(20), uid(21)], ...overrides };
}
function harness({ kind = 'external_starter', found = inventory(), identity = true, legacy = false, role = true, auditFails = [], markers = null, auditStalls = [], probe = null } = {}) {
    const calls = [], records = [];
    let clock = Date.parse('2026-11-15T01:00:00.000Z'), ids = 0, current = found;
    const storage = {
        inventory: jest.fn(async email => { calls.push(['inventory', email]); return current; }),
        delete: jest.fn(async () => { calls.push(['storage']); current = null; return { blobs: 7, versions: 3, versionsRemaining: 0, versionsUnverified: 0 }; })
    };
    const repository = {
        reset: jest.fn(async scope => { calls.push(['reset', scope]); return { mode: 'reset', tenants: 2, counts: { a: 2, b: 3 } }; }),
        delete: jest.fn(async scope => { calls.push(['delete', scope]); return { mode: 'delete', tenants: 2, counts: { a: 4, b: 1 } }; }),
        ...(probe ? { probe: jest.fn(async scope => { calls.push(['probe', scope]); return probe(scope); }) } : {})
    };
    const remover = { remove: jest.fn(async subject => { calls.push(['identity', subject]); return { removed: true, alreadyGone: false }; }),
        check: jest.fn(async () => true) };
    const executor = createAccountWipeExecutor({
        sources: [{ kind, storage }], repository, identity: identity ? remover : null, legacyIndexConfigured: legacy,
        ensureRole: async () => { calls.push(['role']); if (!role) throw new Error('no role'); },
        audit: async event => { if (auditStalls.includes(event.phase)) return new Promise(() => {}); if (auditFails.includes(event.phase)) throw new Error('down'); records.push(event); },
        auditTimeoutMs: 30, log: () => {},
        targetDigest: email => email === EMAIL ? DIGEST : 'd'.repeat(64), retryMarkers: markers,
        now: () => clock, newId: () => uid(500 + ++ids)
    });
    return { executor, storage, repository, remover, calls, records, tick: ms => { clock += ms; }, set: value => { current = value; } };
}
const approval = (action, extra = {}) => ({ actor: ACTOR, sessionSha256: SESSION, action, email: ' Synthetic.Owner@Example.test ',
    confirmEmail: EMAIL, confirmWord: action.toUpperCase(), ...extra });
const apply = (approvalId, extra = {}) => ({ actor: ACTOR, sessionSha256: SESSION, approvalId, email: EMAIL, ...extra });
const order = calls => calls.map(([name]) => name).filter(name => !['role', 'inventory'].includes(name));

describe('delete', () => {
    test('runs database, then Blob, then Graph, once, and records attempt and outcome', async () => {
        const h = harness();
        const approved = await h.executor.approve(approval('delete'), signal());
        expect(approved).toMatchObject({ action: 'delete', organisations: 2, store: 'external' });
        expect(Date.parse(approved.approvalExpiresAt) - Date.parse('2026-11-15T01:00:00.000Z')).toBe(APPROVAL_MS);
        h.calls.length = 0;
        const result = await h.executor.execute(apply(approved.approvalId), signal());
        expect(order(h.calls)).toEqual(['delete', 'storage', 'identity']);
        expect(h.repository.delete).toHaveBeenCalledWith({ accountId: uid(10), subjectKey: SUBJECT, tenantIds: [uid(20), uid(21)] }, undefined);
        expect(h.remover.remove).toHaveBeenCalledWith(SUBJECT, { signal: expect.any(AbortSignal), deadline: undefined, pendingPermanent: false });
        expect(result).toMatchObject({ outcome: 'succeeded', stages: { database: 'done', storage: 'done', identity: 'done' },
            failedStage: null, code: null, counts: { databaseRows: 5, blobs: 7, versions: 3 }, recorded: true });
        expect(h.records.map(r => r.phase)).toEqual(['approval', 'attempt', 'outcome']);
    });

    test('audit records hold digests, stages and counts, never the email or subject', async () => {
        const h = harness();
        const { approvalId } = await h.executor.approve(approval('delete'), signal());
        await h.executor.execute(apply(approvalId), signal());
        const text = JSON.stringify(h.records);
        for (const secret of [EMAIL, 'synthetic', SUBJECT, uid(2), uid(10), uid(20), ACTOR.subjectKey]) expect(text.toLowerCase()).not.toContain(secret.toLowerCase());
        expect(h.records[0]).toMatchObject({ category: 'dashboard_admin_account_wipe', targetSha256: DIGEST, actorSha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    });

    test('a legacy (workforce) account is not sent to External ID', async () => {
        const h = harness({ kind: 'legacy_starter' });
        const { approvalId } = await h.executor.approve(approval('delete'), signal());
        const result = await h.executor.execute(apply(approvalId), signal());
        expect(result.stages).toEqual({ database: 'done', storage: 'done', identity: 'not_applicable' });
        expect(h.remover.remove).not.toHaveBeenCalled();
    });

    test.each([
        ['legacy signup index configured', { legacy: true }, 'account_wipe_legacy_index_configured'],
        ['Graph not configured', { identity: false }, 'account_wipe_identity_not_configured'],
        ['database role unavailable', { role: false }, 'account_wipe_role_unavailable'],
        ['no such account', { found: null }, 'account_wipe_account_not_found'],
        ['no recorded sign-in subject', { found: inventory({ subjectKey: null }) }, 'account_wipe_subject_unknown']
    ])('%s: refused at approval before anything is changed', async (_, options, code) => {
        const h = harness(options);
        await expect(h.executor.approve(approval('delete'), signal())).rejects.toMatchObject({ code });
        expect(order(h.calls)).toEqual([]);
        expect(h.records).toEqual([expect.objectContaining({ phase: 'approval_refused', code, targetSha256: DIGEST })]);
    });

    test('a database refusal (session reference) changes nothing and later stages do not run', async () => {
        const h = harness();
        const { approvalId } = await h.executor.approve(approval('delete'), signal());
        h.repository.delete.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'account_wipe_reference_blocked' }));
        const result = await h.executor.execute(apply(approvalId), signal());
        expect(result).toMatchObject({ outcome: 'refused', code: 'account_wipe_reference_blocked', failedStage: null,
            stages: { database: 'failed', storage: 'pending', identity: 'pending' } });
        expect(h.storage.delete).not.toHaveBeenCalled(); expect(h.remover.remove).not.toHaveBeenCalled();
        expect(h.records.at(-1)).toMatchObject({ phase: 'outcome', outcome: 'refused', code: 'account_wipe_reference_blocked' });
    });

    test('Blob failure after the database is a recorded partial; a fresh approval finishes it idempotently', async () => {
        const h = harness();
        let { approvalId } = await h.executor.approve(approval('delete'), signal());
        h.storage.delete.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'account_wipe_storage_unavailable' }));
        const first = await h.executor.execute(apply(approvalId), signal());
        expect(first).toMatchObject({ outcome: 'partial', failedStage: 'storage', code: 'account_wipe_storage_unavailable',
            stages: { database: 'done', storage: 'failed', identity: 'pending' } });
        expect(h.records.at(-1)).toMatchObject({ outcome: 'partial', failedStage: 'storage' });
        // The database rows are gone now, so the repository reports the account missing.
        h.repository.delete.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'account_wipe_account_not_found' }));
        ({ approvalId } = await h.executor.approve(approval('delete'), signal()));
        const retry = await h.executor.execute(apply(approvalId), signal());
        expect(retry).toMatchObject({ outcome: 'succeeded', stages: { database: 'absent', storage: 'done', identity: 'done' } });
    });

    test('Graph failure after Blob is partial; the retry removes the user from the held reference', async () => {
        const h = harness();
        let { approvalId } = await h.executor.approve(approval('delete'), signal());
        h.remover.remove.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'account_wipe_identity_forbidden' }));
        const first = await h.executor.execute(apply(approvalId), signal());
        expect(first).toMatchObject({ outcome: 'partial', failedStage: 'identity', stages: { database: 'done', storage: 'done', identity: 'failed' } });
        // Storage now finds nothing, but the approval is still allowed for the held identity.
        ({ approvalId } = await h.executor.approve(approval('delete'), signal()));
        h.calls.length = 0;
        const retry = await h.executor.execute(apply(approvalId), signal());
        expect(order(h.calls)).toEqual(['identity']);
        expect(retry).toMatchObject({ outcome: 'succeeded', stages: { database: 'absent', storage: 'absent', identity: 'done' } });
        // Once removed, nothing is held and a further delete finds no account.
        await expect(h.executor.approve(approval('delete'), signal())).rejects.toMatchObject({ code: 'account_wipe_account_not_found' });
    });

    test('leftover Blob versions with no held identity reference are partial, so staff remove the user by hand', async () => {
        const h = harness({ found: inventory({ account: null, subjectKey: null, tenantIds: [] }) });
        const { approvalId } = await h.executor.approve(approval('delete'), signal());
        const result = await h.executor.execute(apply(approvalId), signal());
        expect(h.repository.delete).not.toHaveBeenCalled();
        expect(result).toMatchObject({ outcome: 'partial', failedStage: 'identity', code: 'account_wipe_identity_reference_lost',
            stages: { database: 'absent', storage: 'done', identity: 'failed' } });
    });

    test('an outcome that cannot be recorded is still reported, flagged as unrecorded', async () => {
        const h = harness({ auditFails: ['outcome'] });
        const { approvalId } = await h.executor.approve(approval('delete'), signal());
        expect(await h.executor.execute(apply(approvalId), signal())).toMatchObject({ outcome: 'succeeded', recorded: false });
    });

    test('no attempt record means nothing runs', async () => {
        const h = harness({ auditFails: ['attempt'] });
        const { approvalId } = await h.executor.approve(approval('delete'), signal());
        await expect(h.executor.execute(apply(approvalId), signal())).rejects.toMatchObject({ code: 'account_wipe_audit_unavailable' });
        expect(order(h.calls)).toEqual([]);
    });
});

describe('unactivated legacy account (subject only in the organisation context)', () => {
    // Storage removes the context (stage 3) before the account record (stage 5).
    // After a failure between them, the inventory no longer finds the subject.
    const contextGone = () => inventory({ subjectKey: null });
    function store() {
        const rows = new Map();
        return { rows, read: jest.fn(async digest => rows.get(digest) ?? null), write: jest.fn(async (digest, record) => { rows.set(digest, record); }) };
    }

    test('a retry in the same process uses the reference taken before the first delete', async () => {
        const h = harness({ kind: 'legacy_starter' });
        let { approvalId } = await h.executor.approve(approval('delete'), signal());
        h.storage.delete.mockImplementationOnce(async () => { h.set(contextGone()); throw Object.assign(new Error('x'), { code: 'account_wipe_storage_unavailable' }); });
        expect((await h.executor.execute(apply(approvalId), signal())).outcome).toBe('partial');
        h.repository.delete.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'account_wipe_account_not_found' }));
        ({ approvalId } = await h.executor.approve(approval('delete'), signal()));
        const retry = await h.executor.execute(apply(approvalId), signal());
        expect(h.repository.delete).toHaveBeenLastCalledWith({ accountId: uid(10), subjectKey: SUBJECT, tenantIds: [uid(20), uid(21)] }, undefined);
        expect(retry).toMatchObject({ outcome: 'succeeded', stages: { database: 'absent', storage: 'done', identity: 'not_applicable' } });
    });

    test('after a restart, the durable digest-only marker lets the retry skip the finished database part', async () => {
        const markers = store(), first = harness({ kind: 'legacy_starter', markers });
        const { approvalId } = await first.executor.approve(approval('delete'), signal());
        first.storage.delete.mockImplementationOnce(async () => { throw Object.assign(new Error('x'), { code: 'account_wipe_storage_unavailable' }); });
        expect((await first.executor.execute(apply(approvalId), signal())).outcome).toBe('partial');
        const marker = markers.rows.get(DIGEST);
        expect(marker).toMatchObject({ databaseDone: true, targetSha256: DIGEST, accountSha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
        expect(JSON.stringify(marker)).not.toMatch(new RegExp([EMAIL, uid(10), uid(2)].join('|')));
        // A new process: nothing in memory, the subject no longer discoverable.
        const second = harness({ kind: 'legacy_starter', markers, found: contextGone() });
        const again = await second.executor.approve(approval('delete'), signal());
        const retry = await second.executor.execute(apply(again.approvalId), signal());
        expect(second.repository.delete).not.toHaveBeenCalled();
        expect(retry).toMatchObject({ outcome: 'succeeded', stages: { database: 'absent', storage: 'done', identity: 'not_applicable' } });
    });

    test('a marker for another account with the same email is not trusted', async () => {
        const markers = store();
        markers.rows.set(DIGEST, { schemaVersion: 1, targetSha256: DIGEST, accountSha256: 'e'.repeat(64), databaseDone: true });
        const h = harness({ kind: 'legacy_starter', markers, found: contextGone() });
        await expect(h.executor.approve(approval('delete'), signal())).rejects.toMatchObject({ code: 'account_wipe_subject_unknown' });
    });

    test('a database refusal keeps no new retry reference', async () => {
        const h = harness();
        const { approvalId } = await h.executor.approve(approval('delete'), signal());
        h.repository.delete.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'account_wipe_reference_blocked' }));
        await h.executor.execute(apply(approvalId), signal());
        h.set(null);
        await expect(h.executor.approve(approval('delete'), signal())).rejects.toMatchObject({ code: 'account_wipe_account_not_found' });
    });
});

describe('run deadline', () => {
    test('the deadline reaches the database transaction; expiry there is a rolled-back, retryable outcome', async () => {
        const h = harness();
        let { approvalId } = await h.executor.approve(approval('delete'), signal());
        const run = signal(), deadline = Date.now() + 30000;
        h.repository.delete.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'account_wipe_timed_out' }));
        const result = await h.executor.execute(apply(approvalId, { deadline }), run);
        expect(h.repository.delete).toHaveBeenCalledWith(expect.any(Object), { signal: expect.any(AbortSignal), deadline: deadline - OUTCOME_RESERVE_MS });
        expect(result).toMatchObject({ outcome: 'timed_out_rolled_back', code: 'account_wipe_timed_out', failedStage: null,
            stages: { database: 'failed', storage: 'pending', identity: 'pending' } });
        expect(h.storage.delete).not.toHaveBeenCalled();
        expect(h.records.at(-1)).toMatchObject({ phase: 'outcome', outcome: 'timed_out_rolled_back' });
        ({ approvalId } = await h.executor.approve(approval('delete'), signal()));
        expect((await h.executor.execute(apply(approvalId, { deadline }), signal())).outcome).toBe('succeeded');
    });
});

describe('review fixes', () => {
    test('a COMMIT with an unknown result is audited and reported as unknown, never as nothing changed; a delete retry converges', async () => {
        const h = harness();
        let { approvalId } = await h.executor.approve(approval('delete'), signal());
        h.repository.delete.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'account_wipe_commit_unknown' }));
        const first = await h.executor.execute(apply(approvalId), signal());
        expect(first).toMatchObject({ outcome: 'unknown', code: 'account_wipe_commit_unknown', stages: { database: 'unknown', storage: 'pending', identity: 'pending' } });
        expect(h.records.at(-1)).toMatchObject({ phase: 'outcome', outcome: 'unknown' });
        expect(h.storage.delete).not.toHaveBeenCalled();
        // It had committed: the retry finds nothing of the account in the database.
        h.repository.delete.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'account_wipe_account_not_found' }));
        ({ approvalId } = await h.executor.approve(approval('delete'), signal()));
        expect(await h.executor.execute(apply(approvalId), signal())).toMatchObject({ outcome: 'succeeded', stages: { database: 'absent', storage: 'done', identity: 'done' } });
    });

    test('a subject mismatch in the database refuses the delete before Blob or Graph', async () => {
        const h = harness();
        const { approvalId } = await h.executor.approve(approval('delete'), signal());
        h.repository.delete.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'account_wipe_subject_mismatch' }));
        expect(await h.executor.execute(apply(approvalId), signal())).toMatchObject({ outcome: 'refused', code: 'account_wipe_subject_mismatch' });
        expect(h.storage.delete).not.toHaveBeenCalled(); expect(h.remover.remove).not.toHaveBeenCalled();
    });

    test('an unusable Graph credential refuses delete at approval and at apply, before anything irreversible', async () => {
        const h = harness();
        h.remover.check.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'account_wipe_identity_unavailable' }));
        await expect(h.executor.approve(approval('delete'), signal())).rejects.toMatchObject({ code: 'account_wipe_identity_unavailable' });
        const { approvalId } = await h.executor.approve(approval('delete'), signal());
        h.remover.check.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'account_wipe_identity_unavailable' }));
        expect(await h.executor.execute(apply(approvalId), signal())).toMatchObject({ outcome: 'refused', code: 'account_wipe_identity_unavailable' });
        expect(order(h.calls)).toEqual([]);
        // Reset never needs Graph.
        const r = harness(); r.remover.check.mockRejectedValue(new Error('x'));
        const reset = await r.executor.approve(approval('reset'), signal());
        expect((await r.executor.execute(apply(reset.approvalId), signal())).outcome).toBe('succeeded');
    });

    test('an identity pending in deleted items is a retryable partial', async () => {
        const h = harness();
        const { approvalId } = await h.executor.approve(approval('delete'), signal());
        h.remover.remove.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'account_wipe_identity_pending' }));
        expect(await h.executor.execute(apply(approvalId), signal())).toMatchObject({ outcome: 'partial', failedStage: 'identity', code: 'account_wipe_identity_pending' });
    });

    test.each([
        ['approval_refused', 'approve', h => h.executor.approve(approval('delete', { confirmWord: 'NO' }), signal()), 'account_wipe_confirmation_mismatch'],
        ['execute_refused', 'execute', h => h.executor.execute(apply(uid(999)), signal()), 'account_wipe_approval_invalid']
    ])('every refusal leaves a %s record without email or subject', async (phase, _, act, code) => {
        const h = harness();
        await expect(act(h)).rejects.toMatchObject({ code });
        expect(h.records).toEqual([expect.objectContaining({ phase, code, outcome: 'refused', targetSha256: DIGEST, actorSha256: expect.stringMatching(/^[0-9a-f]{64}$/) })]);
        expect(JSON.stringify(h.records).toLowerCase()).not.toMatch(new RegExp([EMAIL, ACTOR.subjectKey].join('|')));
    });

    test('busy and refusals decided by the route are recorded too', async () => {
        const h = harness();
        await h.executor.refused({ actor: ACTOR, step: 'approve', email: 'not an email', code: 'account_wipe_input_invalid' });
        expect(h.records).toEqual([expect.objectContaining({ phase: 'approval_refused', code: 'account_wipe_input_invalid', targetSha256: null })]);
    });

    test('an outcome record that cannot be stored is logged with the operation id only', async () => {
        const logs = [], h = harness({ auditFails: ['outcome'] });
        const executor = createAccountWipeExecutor({ sources: [{ kind: 'external_starter', storage: h.storage }], repository: h.repository, identity: h.remover,
            legacyIndexConfigured: false, ensureRole: async () => {}, audit: async event => { if (event.phase === 'outcome') throw new Error('down'); },
            targetDigest: () => DIGEST, log: message => logs.push(message) });
        const { approvalId } = await executor.approve(approval('reset'), signal());
        await executor.execute(apply(approvalId), signal());
        expect(logs).toEqual([`[dashboard-admin-account-wipe] outcome_unrecorded ${approvalId}`]);
    });

    test('the stage budget leaves room for the outcome record inside the overall deadline', async () => {
        const h = harness(), deadline = Date.parse('2026-11-15T01:00:25.000Z');
        const { approvalId } = await h.executor.approve(approval('reset'), signal());
        await h.executor.execute(apply(approvalId, { deadline }), signal());
        expect(h.repository.reset.mock.calls[0][1].deadline).toBe(deadline - OUTCOME_RESERVE_MS);
    });
});

describe('second review round', () => {
    test('a user pending permanent deletion stays pending across retries until a permanent delete is confirmed', async () => {
        const h = harness();
        let { approvalId } = await h.executor.approve(approval('delete'), signal());
        h.remover.remove.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'account_wipe_identity_pending' }));
        expect((await h.executor.execute(apply(approvalId), signal())).code).toBe('account_wipe_identity_pending');
        // Retry: the reference is held with the pending state and passed on.
        h.remover.remove.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'account_wipe_identity_pending' }));
        ({ approvalId } = await h.executor.approve(approval('delete'), signal()));
        expect((await h.executor.execute(apply(approvalId), signal())).outcome).toBe('partial');
        expect(h.remover.remove.mock.calls[1][1]).toMatchObject({ pendingPermanent: true });
        // Confirmed at last: only now is the reference cleared.
        ({ approvalId } = await h.executor.approve(approval('delete'), signal()));
        expect((await h.executor.execute(apply(approvalId), signal())).outcome).toBe('succeeded');
        expect(h.remover.remove.mock.calls[2][1]).toMatchObject({ pendingPermanent: true });
        await expect(h.executor.approve(approval('delete'), signal())).rejects.toMatchObject({ code: 'account_wipe_account_not_found' });
    });

    test('a stalled attempt record is bounded: nothing runs and the account is not left locked', async () => {
        const h = harness({ auditStalls: ['attempt'] });
        let { approvalId } = await h.executor.approve(approval('reset'), signal());
        await expect(h.executor.execute(apply(approvalId), signal())).rejects.toMatchObject({ code: 'account_wipe_audit_unavailable' });
        expect(h.repository.reset).not.toHaveBeenCalled();
        ({ approvalId } = await h.executor.approve(approval('reset'), signal()));
        // Still stalled, but refused as unavailable, never as busy: the lock was released.
        await expect(h.executor.execute(apply(approvalId), signal())).rejects.toMatchObject({ code: 'account_wipe_audit_unavailable' });
    });

    test('a stalled outcome record after destructive stages returns unrecorded, logs and releases the lock', async () => {
        const logs = [], h = harness({ auditStalls: ['outcome'] });
        const executor = createAccountWipeExecutor({ sources: [{ kind: 'external_starter', storage: h.storage }], repository: h.repository, identity: h.remover,
            legacyIndexConfigured: false, ensureRole: async () => {}, audit: event => event.phase === 'outcome' ? new Promise(() => {}) : Promise.resolve(),
            targetDigest: () => DIGEST, auditTimeoutMs: 30, log: message => logs.push(message) });
        let { approvalId } = await executor.approve(approval('reset'), signal());
        const started = Date.now();
        expect(await executor.execute(apply(approvalId, { deadline: Date.now() - 1 }), signal())).toMatchObject({ outcome: 'succeeded', recorded: false });
        // The outcome write still gets its minimum slice even past the deadline, then gives up.
        expect(Date.now() - started).toBeGreaterThanOrEqual(OUTCOME_MIN_MS - 50);
        expect(logs).toEqual([`[dashboard-admin-account-wipe] outcome_unrecorded ${approvalId}`]);
        ({ approvalId } = await executor.approve(approval('reset'), signal()));
        expect((await executor.execute(apply(approvalId), signal())).recorded).toBe(false);
    });
});

describe('third review round', () => {
    test('an approval is bound to the account seen: a re-signup with the same email is a changed target', async () => {
        const h = harness();
        const first = await h.executor.approve(approval('delete'), signal());
        const second = await h.executor.approve(approval('delete'), signal());
        // The customer signs up again before the second approval is used: new account id.
        h.set(inventory({ account: { accountId: uid(11) } }));
        const result = await h.executor.execute(apply(second.approvalId), signal());
        expect(result).toMatchObject({ outcome: 'refused', code: 'account_wipe_target_changed' });
        expect(order(h.calls)).toEqual([]);
        void first;
    });

    test('a different sign-in subject for the same account id is a changed target', async () => {
        for (const swap of [inventory({ subjectKey: uid(1) + ':' + uid(3) })]) {
            const h = harness();
            const { approvalId } = await h.executor.approve(approval('reset'), signal());
            h.set(swap);
            expect((await h.executor.execute(apply(approvalId), signal())).code).toBe('account_wipe_target_changed');
            expect(h.repository.reset).not.toHaveBeenCalled();
        }
    });

    test('a successful or partial run voids every other approval for the email', async () => {
        const h = harness();
        const first = await h.executor.approve(approval('delete'), signal());
        const second = await h.executor.approve(approval('delete'), signal());
        expect((await h.executor.execute(apply(first.approvalId), signal())).outcome).toBe('succeeded');
        await expect(h.executor.execute(apply(second.approvalId), signal())).rejects.toMatchObject({ code: 'account_wipe_approval_invalid' });
        const p = harness();
        const a = await p.executor.approve(approval('delete'), signal()), b = await p.executor.approve(approval('delete'), signal());
        p.storage.delete.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'account_wipe_storage_unavailable' }));
        expect((await p.executor.execute(apply(a.approvalId), signal())).outcome).toBe('partial');
        await expect(p.executor.execute(apply(b.approvalId), signal())).rejects.toMatchObject({ code: 'account_wipe_approval_invalid' });
    });

    test('finishing a partial delete is allowed only for the approved account', async () => {
        const h = harness();
        let { approvalId } = await h.executor.approve(approval('delete'), signal());
        h.remover.remove.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'account_wipe_identity_unavailable', softDeleted: true }));
        expect((await h.executor.execute(apply(approvalId), signal())).outcome).toBe('partial');
        // Storage is gone; the resume approval is bound to the held account.
        ({ approvalId } = await h.executor.approve(approval('delete'), signal()));
        h.calls.length = 0;
        expect((await h.executor.execute(apply(approvalId), signal())).outcome).toBe('succeeded');
        // The soft-deleted state was carried, so the retry demanded a confirmed permanent delete.
        expect(h.remover.remove.mock.calls[1][1]).toMatchObject({ pendingPermanent: true });
    });

    test('a stalled role probe is cut off at the run deadline', async () => {
        const h = harness();
        const executor = createAccountWipeExecutor({ sources: [{ kind: 'external_starter', storage: h.storage }], repository: h.repository, identity: h.remover,
            legacyIndexConfigured: false, ensureRole: () => new Promise(() => {}), audit: async () => {}, targetDigest: () => DIGEST, log: () => {} });
        const controller = new AbortController(); setTimeout(() => controller.abort(), 20);
        await expect(executor.approve(approval('reset'), controller.signal)).rejects.toMatchObject({ code: 'account_wipe_timed_out' });
    });
});

test('without a deadline the attempt record gets the full audit timeout', async () => {
    const h = harness();
    const executor = createAccountWipeExecutor({ sources: [{ kind: 'external_starter', storage: h.storage }], repository: h.repository, identity: h.remover,
        legacyIndexConfigured: false, ensureRole: async () => {}, targetDigest: () => DIGEST, auditTimeoutMs: 200, log: () => {},
        audit: () => new Promise(resolve => setTimeout(resolve, 10)) });
    const { approvalId } = await executor.approve(approval('reset'), signal());
    expect(await executor.execute(apply(approvalId), signal())).toMatchObject({ outcome: 'succeeded', recorded: true });
});

describe('approval', () => {
    test.each([
        ['wrong typed email', { confirmEmail: 'someone.else@example.test' }],
        ['wrong word', { confirmWord: 'RESET' }],
        ['lower-case word', { confirmWord: 'delete' }],
        ['missing word', { confirmWord: undefined }]
    ])('%s is refused', async (_, extra) => {
        const h = harness();
        await expect(h.executor.approve(approval('delete', extra), signal())).rejects.toMatchObject({ code: 'account_wipe_confirmation_mismatch' });
        expect(h.records.map(r => [r.phase, r.code])).toEqual([['approval_refused', 'account_wipe_confirmation_mismatch']]);
    });

    test('an approval that cannot be recorded is not granted', async () => {
        const h = harness({ auditFails: ['approval'] });
        await expect(h.executor.approve(approval('reset'), signal())).rejects.toMatchObject({ code: 'account_wipe_audit_unavailable' });
    });

    test('is single use', async () => {
        const h = harness();
        const { approvalId } = await h.executor.approve(approval('reset'), signal());
        await h.executor.execute(apply(approvalId), signal());
        await expect(h.executor.execute(apply(approvalId), signal())).rejects.toMatchObject({ code: 'account_wipe_approval_invalid' });
        expect(h.repository.reset).toHaveBeenCalledTimes(1);
    });

    test('is bound to the action approved: a reset approval can only reset', async () => {
        const h = harness();
        const { approvalId } = await h.executor.approve(approval('reset'), signal());
        expect(await h.executor.execute(apply(approvalId, { action: 'delete' }), signal())).toMatchObject({ action: 'reset', outcome: 'succeeded' });
        expect(h.repository.reset).toHaveBeenCalledTimes(1);
        expect(h.repository.delete).not.toHaveBeenCalled(); expect(h.storage.delete).not.toHaveBeenCalled(); expect(h.remover.remove).not.toHaveBeenCalled();
    });

    test('the approval record states it is self-issued by the acting staff admin', async () => {
        const h = harness();
        await h.executor.approve(approval('delete'), signal());
        expect(h.records).toEqual([expect.objectContaining({ phase: 'approval', action: 'delete', approvalAuthority: 'self_issued_sole_admin' })]);
    });

    test('expires after 15 minutes', async () => {
        const h = harness();
        const { approvalId } = await h.executor.approve(approval('reset'), signal());
        h.tick(APPROVAL_MS);
        await expect(h.executor.execute(apply(approvalId), signal())).rejects.toMatchObject({ code: 'account_wipe_approval_invalid' });
        expect(h.repository.reset).not.toHaveBeenCalled();
    });

    test.each([
        ['another staff session', { sessionSha256: OTHER_SESSION }],
        ['another staff subject', { actor: { subjectKey: uid(80) + ':' + uid(81) } }],
        ['another account', { email: 'other@example.test' }],
        ['an unknown approval', { approvalId: uid(999) }]
    ])('is bound: %s cannot use it, and a misuse spends it', async (_, extra) => {
        const h = harness();
        const { approvalId } = await h.executor.approve(approval('reset'), signal());
        await expect(h.executor.execute(apply(approvalId, extra), signal())).rejects.toMatchObject({ code: 'account_wipe_approval_invalid' });
        if (!extra.approvalId) await expect(h.executor.execute(apply(approvalId), signal())).rejects.toMatchObject({ code: 'account_wipe_approval_invalid' });
        expect(h.repository.reset).not.toHaveBeenCalled();
    });
});

describe('reset', () => {
    test('clears database data only: no Blob or Graph call, sign-in kept', async () => {
        const h = harness();
        const { approvalId } = await h.executor.approve(approval('reset'), signal());
        const result = await h.executor.execute(apply(approvalId), signal());
        expect(order(h.calls)).toEqual(['reset']);
        expect(result).toMatchObject({ outcome: 'succeeded', stages: { database: 'done' }, counts: { databaseRows: 5, blobs: 0, versions: 0 } });
    });

    test('works without Graph and with the legacy index configured', async () => {
        const h = harness({ identity: false, legacy: true });
        const { approvalId } = await h.executor.approve(approval('reset'), signal());
        expect((await h.executor.execute(apply(approvalId), signal())).outcome).toBe('succeeded');
    });

    test('a tenant the database does not link to the account is refused with nothing changed', async () => {
        const h = harness();
        const { approvalId } = await h.executor.approve(approval('reset'), signal());
        h.repository.reset.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'account_wipe_tenant_mismatch' }));
        expect(await h.executor.execute(apply(approvalId), signal())).toMatchObject({ outcome: 'refused', code: 'account_wipe_tenant_mismatch' });
    });

    test('provider errors are reported only as bounded codes', async () => {
        const h = harness();
        const { approvalId } = await h.executor.approve(approval('reset'), signal());
        h.repository.reset.mockRejectedValueOnce(Object.assign(new Error('PRIVATE ' + EMAIL), { code: '42P01' }));
        const result = await h.executor.execute(apply(approvalId), signal());
        expect(result.code).toBe('account_wipe_unavailable'); expect(JSON.stringify([result, h.records])).not.toContain('PRIVATE');
    });
});

test('an email in both starter stores is never guessed between', async () => {
    const storage = () => ({ inventory: async () => inventory(), delete: async () => ({}) });
    const executor = createAccountWipeExecutor({ sources: [{ kind: 'legacy_starter', storage: storage() }, { kind: 'external_starter', storage: storage() }],
        repository: { reset: jest.fn(), delete: jest.fn() }, identity: null, legacyIndexConfigured: false, ensureRole: async () => {},
        audit: async () => {}, targetDigest: () => DIGEST });
    await expect(executor.approve(approval('reset'), signal())).rejects.toMatchObject({ code: 'account_wipe_account_ambiguous' });
});

test('configuration is checked when composed', () => {
    expect(() => createAccountWipeExecutor({})).toThrow('account_wipe_configuration_invalid');
    expect(() => createAccountWipeExecutor({ sources: [{ kind: 'legacy_admin', storage: { inventory() {}, delete() {} } }] })).toThrow('account_wipe_configuration_invalid');
});

describe('Graph token', () => {
    const env = { NOFRIES_EXTERNAL_CUSTOMER_TENANT_ID: uid(1) };
    test('settings: unset is null, partial, malformed or another tenant is invalid', () => {
        expect(readAccountWipeGraphSettings(env)).toBeNull();
        expect(readAccountWipeGraphSettings({ ...env, NOFRIES_ACCOUNT_WIPE_GRAPH_TENANT_ID: uid(1), NOFRIES_ACCOUNT_WIPE_GRAPH_CLIENT_ID: uid(3) }))
            .toEqual({ tenantId: uid(1), clientId: uid(3) });
        for (const bad of [{ NOFRIES_ACCOUNT_WIPE_GRAPH_TENANT_ID: uid(1) }, { NOFRIES_ACCOUNT_WIPE_GRAPH_CLIENT_ID: uid(3) },
            { NOFRIES_ACCOUNT_WIPE_GRAPH_TENANT_ID: uid(4), NOFRIES_ACCOUNT_WIPE_GRAPH_CLIENT_ID: uid(3) },
            { NOFRIES_ACCOUNT_WIPE_GRAPH_TENANT_ID: 'x', NOFRIES_ACCOUNT_WIPE_GRAPH_CLIENT_ID: uid(3) }])
            expect(() => readAccountWipeGraphSettings({ ...env, ...bad })).toThrow('account_wipe_identity_configuration_invalid');
    });

    test('uses the managed identity token as the client assertion for the External ID app', async () => {
        const seen = [];
        class ManagedIdentityCredential { constructor(options) { seen.push(['mi', options]); } async getToken(scope) { seen.push(['mi-token', scope]); return { token: 'assertion' }; } }
        class ClientAssertionCredential {
            constructor(tenantId, clientId, getAssertion) { seen.push(['app', tenantId, clientId]); this.getAssertion = getAssertion; }
            async getToken(scope) { seen.push(['app-token', scope, await this.getAssertion()]); return { token: 'graph-token' }; }
        }
        const getToken = createAccountWipeGraphToken({ tenantId: uid(1), clientId: uid(3), managedIdentityClientId: uid(5), ManagedIdentityCredential, ClientAssertionCredential });
        expect(await getToken()).toBe('graph-token');
        expect(seen).toEqual([['mi', { clientId: uid(5) }], ['app', uid(1), uid(3)], ['mi-token', EXCHANGE_SCOPE], ['app-token', GRAPH_SCOPE, 'assertion']]);
    });
});

describe('choosing the store when an email is in both', () => {
    function both() {
        const calls = [];
        const storage = kind => ({ inventory: jest.fn(async () => inventory({ account: { accountId: kind === 'legacy_starter' ? uid(11) : uid(10) } })),
            delete: jest.fn(async () => { calls.push(['storage', kind]); return { blobs: 1, versions: 0 }; }) });
        const legacy = storage('legacy_starter'), external = storage('external_starter');
        const repository = { reset: jest.fn(), delete: jest.fn(async scope => { calls.push(['delete', scope.accountId]); return { counts: { a: 1 } }; }) };
        const remover = { remove: jest.fn(async () => ({ alreadyGone: false })), check: jest.fn(async () => true) };
        const executor = createAccountWipeExecutor({ sources: [{ kind: 'legacy_starter', storage: legacy }, { kind: 'external_starter', storage: external }],
            repository, identity: remover, legacyIndexConfigured: false, ensureRole: async () => {}, audit: async () => {}, targetDigest: () => DIGEST });
        return { executor, legacy, external, remover, calls };
    }
    test('the named store is acted on and the other is never touched', async () => {
        const h = both();
        const approved = await h.executor.approve(approval('delete', { store: 'legacy' }), signal());
        expect(approved).toMatchObject({ store: 'legacy' });
        const result = await h.executor.execute(apply(approved.approvalId), signal());
        expect(result).toMatchObject({ outcome: 'succeeded', stages: { database: 'done', storage: 'done', identity: 'not_applicable' } });
        expect(h.calls).toEqual([['delete', uid(11)], ['storage', 'legacy_starter']]);
        expect(h.external.inventory).not.toHaveBeenCalled(); expect(h.remover.remove).not.toHaveBeenCalled();
    });
    test('without a store it is still refused, and an unknown store is invalid input', async () => {
        const h = both();
        await expect(h.executor.approve(approval('delete'), signal())).rejects.toMatchObject({ code: 'account_wipe_account_ambiguous' });
        await expect(h.executor.approve(approval('delete', { store: 'both' }), signal())).rejects.toMatchObject({ code: 'account_wipe_input_invalid' });
        expect(h.calls).toEqual([]);
    });
});

describe('an unfinished signup (no sign-in subject recorded)', () => {
    const unfinished = () => inventory({ subjectKey: null });
    test('is deleted when the database holds nothing of it: Blob records go, no database or External ID call', async () => {
        const h = harness({ found: unfinished(), probe: () => ({ mode: 'probe', held: false }) });
        const { approvalId } = await h.executor.approve(approval('delete'), signal());
        h.calls.length = 0;
        const result = await h.executor.execute(apply(approvalId), signal());
        expect(order(h.calls)).toEqual(['probe', 'storage']);
        expect(h.repository.probe).toHaveBeenCalledWith({ accountId: uid(10), subjectKey: null, tenantIds: [uid(20), uid(21)] }, undefined);
        expect(h.repository.delete).not.toHaveBeenCalled(); expect(h.remover.remove).not.toHaveBeenCalled();
        expect(result).toMatchObject({ outcome: 'succeeded', stages: { database: 'absent', storage: 'done', identity: 'none_recorded' }, code: null });
    });
    test('is refused with nothing changed when the database still holds any of it', async () => {
        const h = harness({ found: unfinished(), probe: () => ({ mode: 'probe', held: true }) });
        const { approvalId } = await h.executor.approve(approval('delete'), signal());
        h.calls.length = 0;
        const result = await h.executor.execute(apply(approvalId), signal());
        expect(result).toMatchObject({ outcome: 'refused', code: 'account_wipe_subject_unknown' });
        expect(order(h.calls)).toEqual(['probe']);
    });
    test('a failed probe refuses too, and reset still needs the subject', async () => {
        const h = harness({ found: unfinished(), probe: () => { throw Object.assign(new Error(), { code: 'account_wipe_unavailable' }); } });
        const { approvalId } = await h.executor.approve(approval('delete'), signal());
        expect(await h.executor.execute(apply(approvalId), signal())).toMatchObject({ outcome: 'refused', code: 'account_wipe_unavailable' });
        expect(h.storage.delete).not.toHaveBeenCalled();
        await expect(h.executor.approve(approval('reset'), signal())).rejects.toMatchObject({ code: 'account_wipe_subject_unknown' });
    });
    test('a legacy unfinished signup is not sent to External ID either', async () => {
        const h = harness({ kind: 'legacy_starter', found: unfinished(), probe: () => ({ mode: 'probe', held: false }) });
        const { approvalId } = await h.executor.approve(approval('delete'), signal());
        expect((await h.executor.execute(apply(approvalId), signal())).stages).toEqual({ database: 'absent', storage: 'done', identity: 'not_applicable' });
    });
});

describe('review follow-ups: store-bound retry references and unfinished retries after a restart', () => {
    test('a retry reference from an external delete is never used by a delete aimed at the legacy store', async () => {
        const h = harness();
        h.remover.remove.mockRejectedValueOnce(Object.assign(new Error(), { code: 'account_wipe_identity_forbidden' }));
        const first = await h.executor.approve(approval('delete'), signal());
        expect(await h.executor.execute(apply(first.approvalId), signal())).toMatchObject({ outcome: 'partial', failedStage: 'identity' });
        h.calls.length = 0;
        await expect(h.executor.approve(approval('delete', { store: 'legacy' }), signal())).rejects.toMatchObject({ code: 'account_wipe_account_not_found' });
        expect(h.remover.remove).toHaveBeenCalledTimes(1);
        // The same store still finishes it from the reference.
        const retry = await h.executor.approve(approval('delete', { store: 'external' }), signal());
        expect(await h.executor.execute(apply(retry.approvalId), signal())).toMatchObject({ outcome: 'succeeded', stages: { identity: 'done' } });
    });

    test('an unfinished signup whose storage step failed is still reported as having no sign-in user after a restart', async () => {
        const rows = new Map(), markers = { read: jest.fn(async d => rows.get(d) ?? null), write: jest.fn(async (d, r) => { rows.set(d, r); }) };
        const probe = () => ({ mode: 'probe', held: false });
        const first = harness({ found: inventory({ subjectKey: null }), probe, markers });
        first.storage.delete.mockRejectedValueOnce(Object.assign(new Error(), { code: 'account_wipe_storage_unavailable' }));
        const a = await first.executor.approve(approval('delete'), signal());
        expect(await first.executor.execute(apply(a.approvalId), signal())).toMatchObject({ outcome: 'partial', failedStage: 'storage' });
        expect([...rows.values()][0]).toMatchObject({ databaseDone: true, unfinished: true });
        const restarted = harness({ found: inventory({ subjectKey: null }), probe, markers });
        const b = await restarted.executor.approve(approval('delete'), signal());
        const result = await restarted.executor.execute(apply(b.approvalId), signal());
        expect(result).toMatchObject({ outcome: 'succeeded', stages: { database: 'absent', storage: 'done', identity: 'none_recorded' } });
        expect(restarted.remover.remove).not.toHaveBeenCalled();
    });

    test('a durable marker for a normal account never turns a lost subject into "none recorded"', async () => {
        const rows = new Map([[DIGEST, { schemaVersion: 1, targetSha256: DIGEST, accountSha256: require('node:crypto').createHash('sha256').update(uid(10)).digest('hex'), databaseDone: true }]]);
        const markers = { read: jest.fn(async d => rows.get(d) ?? null), write: jest.fn(async () => {}) };
        const h = harness({ found: inventory({ subjectKey: null }), probe: () => ({ mode: 'probe', held: false }), markers });
        const { approvalId } = await h.executor.approve(approval('delete'), signal());
        expect(await h.executor.execute(apply(approvalId), signal())).toMatchObject({ outcome: 'partial', failedStage: 'identity', code: 'account_wipe_identity_reference_lost' });
    });
});

test('with an email in both stores, deleting the legacy account keeps the external partial delete finishable', async () => {
    const sub = { legacy_starter: uid(31) + ':' + uid(32), external_starter: SUBJECT };
    const current = { legacy_starter: inventory({ account: { accountId: uid(11) }, subjectKey: sub.legacy_starter }), external_starter: inventory() };
    const storage = kind => ({ inventory: jest.fn(async () => current[kind]), delete: jest.fn(async () => { current[kind] = null; return { blobs: 1, versions: 0 }; }) });
    const remover = { remove: jest.fn(async () => ({ alreadyGone: false })), check: jest.fn(async () => true) };
    remover.remove.mockRejectedValueOnce(Object.assign(new Error(), { code: 'account_wipe_identity_forbidden' }));
    const executor = createAccountWipeExecutor({ sources: [{ kind: 'legacy_starter', storage: storage('legacy_starter') }, { kind: 'external_starter', storage: storage('external_starter') }],
        repository: { reset: jest.fn(), delete: jest.fn(async () => ({ counts: { a: 1 } })) }, identity: remover, legacyIndexConfigured: false,
        ensureRole: async () => {}, audit: async () => {}, targetDigest: () => DIGEST });
    const run = async store => { const { approvalId } = await executor.approve(approval('delete', { store }), signal()); return executor.execute(apply(approvalId), signal()); };
    expect(await run('external')).toMatchObject({ outcome: 'partial', failedStage: 'identity' });
    expect(await run('legacy')).toMatchObject({ outcome: 'succeeded', stages: { identity: 'not_applicable' } });
    expect(await run('external')).toMatchObject({ outcome: 'succeeded', stages: { database: 'absent', storage: 'absent', identity: 'done' } });
    expect(remover.remove).toHaveBeenLastCalledWith(SUBJECT, expect.any(Object));
});
