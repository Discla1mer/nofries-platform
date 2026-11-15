'use strict';
const { createAccountWipeExecutor, APPROVAL_MS } = require('../api/shared/dashboardAdmin/accountWipeExecutor');
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
function harness({ kind = 'external_starter', found = inventory(), identity = true, legacy = false, role = true, auditFails = [] } = {}) {
    const calls = [], records = [];
    let clock = Date.parse('2026-11-15T01:00:00.000Z'), ids = 0, current = found;
    const storage = {
        inventory: jest.fn(async email => { calls.push(['inventory', email]); return current; }),
        delete: jest.fn(async () => { calls.push(['storage']); current = null; return { blobs: 7, versions: 3, versionsRemaining: 0, versionsUnverified: 0 }; })
    };
    const repository = {
        reset: jest.fn(async scope => { calls.push(['reset', scope]); return { mode: 'reset', tenants: 2, counts: { a: 2, b: 3 } }; }),
        delete: jest.fn(async scope => { calls.push(['delete', scope]); return { mode: 'delete', tenants: 2, counts: { a: 4, b: 1 } }; })
    };
    const remover = { remove: jest.fn(async subject => { calls.push(['identity', subject]); return { removed: true, alreadyGone: false }; }) };
    const executor = createAccountWipeExecutor({
        sources: [{ kind, storage }], repository, identity: identity ? remover : null, legacyIndexConfigured: legacy,
        ensureRole: async () => { calls.push(['role']); if (!role) throw new Error('no role'); },
        audit: async event => { if (auditFails.includes(event.phase)) throw new Error('down'); records.push(event); },
        targetDigest: email => email === EMAIL ? DIGEST : 'd'.repeat(64),
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
        expect(h.repository.delete).toHaveBeenCalledWith({ accountId: uid(10), subjectKey: SUBJECT, tenantIds: [uid(20), uid(21)] });
        expect(h.remover.remove).toHaveBeenCalledWith(SUBJECT);
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
        expect(order(h.calls)).toEqual([]); expect(h.records).toEqual([]);
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

describe('approval', () => {
    test.each([
        ['wrong typed email', { confirmEmail: 'someone.else@example.test' }],
        ['wrong word', { confirmWord: 'RESET' }],
        ['lower-case word', { confirmWord: 'delete' }],
        ['missing word', { confirmWord: undefined }]
    ])('%s is refused', async (_, extra) => {
        const h = harness();
        await expect(h.executor.approve(approval('delete', extra), signal())).rejects.toMatchObject({ code: 'account_wipe_confirmation_mismatch' });
        expect(h.records).toEqual([]);
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
