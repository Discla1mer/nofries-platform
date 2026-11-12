'use strict';

const outbox = require('../api/shared/lifecycleEmail/outboxWriter');

const scope = { tenantId: 'tenant-a', organisationId: 'organisation-a', accountId: '20000000-0000-4000-8000-000000000001' };
function client(rowCount = 1) {
    const calls = [];
    return { calls, query: async (sql, args) => { calls.push({ sql, args }); return { rows: [], rowCount }; } };
}

describe('lifecycle email outbox writer', () => {
    test('the flag is on only for exactly "true"', () => {
        expect(outbox.lifecycleEmailEnqueueEnabled({ NOFRIES_LIFECYCLE_EMAIL_ENQUEUE_ENABLED: 'true' })).toBe(true);
        for (const value of [undefined, '', 'TRUE', 'True', '1', 'yes', ' true', 'true\n']) {
            expect(outbox.lifecycleEmailEnqueueEnabled({ NOFRIES_LIFECYCLE_EMAIL_ENQUEUE_ENABLED: value })).toBe(false);
        }
        expect(outbox.lifecycleEmailEnqueueEnabled({})).toBe(false);
    });

    test('template versions are the type plus -v1 and cannot be changed', () => {
        const { TEMPLATE_VERSIONS } = require('../api/shared/lifecycleEmail/templateVersions');
        expect(TEMPLATE_VERSIONS).toEqual({ welcome: 'welcome-v1', result_summary: 'result-summary-v1',
            nudge_unfinished: 'nudge-unfinished-v1', reassess_reminder: 'reassess-reminder-v1' });
        expect(Object.isFrozen(TEMPLATE_VERSIONS)).toBe(true);
    });

    test('enqueue writes one deduplicated row with only runtime-insertable columns', async () => {
        const c = client();
        expect(await outbox.enqueue(c, { ...scope, type: 'result_summary', dedupeKey: 'a'.repeat(64),
            notBefore: '2026-11-12T00:00:00.000Z', params: { assessmentId: 'assessment-a', gapCount: 3 } })).toBe(true);
        const [{ sql, args }] = c.calls;
        expect(sql).toMatch(/ON CONFLICT \(account_id, organisation_id, email_type, dedupe_key\) DO NOTHING/);
        expect(sql).toMatch(/\(outbox_id, tenant_id, organisation_id, account_id, email_type, dedupe_key, template_version, params, not_before\)/);
        expect(args.slice(1)).toEqual(['tenant-a', 'organisation-a', scope.accountId, 'result_summary', 'a'.repeat(64),
            'result-summary-v1', '{"assessmentId":"assessment-a","gapCount":3}', '2026-11-12T00:00:00.000Z']);
        expect(args[0]).toMatch(/^[0-9a-f-]{36}$/);
        expect(await outbox.enqueue(client(0), { ...scope, type: 'reassess_reminder', dedupeKey: 'assessment-a',
            notBefore: '2027-02-10T00:00:00.000Z' })).toBe(false);
    });

    test('params, types, keys and scope are refused before any SQL unless identifier-shaped or a bounded integer', async () => {
        const base = { ...scope, type: 'result_summary', dedupeKey: 'k', notBefore: '2026-11-12T00:00:00.000Z' };
        for (const bad of [{ params: { assessmentId: 'Hi Sam, your results' } }, { params: { assessmentId: 'a@b' } },
            { params: { email: 'someone@example.invalid' } }, { params: { gapCount: '3' } }, { params: { gapCount: 2.5 } },
            { params: { gapCount: -1 } }, { params: { gapCount: 1001 } }, { params: [] }, { type: 'marketing' },
            { dedupeKey: 'has space' }, { accountId: 'not-a-uuid' }, { tenantId: '' }, { notBefore: 'soon' }]) {
            const c = client();
            await expect(outbox.enqueue(c, { ...base, ...bad })).rejects.toBeInstanceOf(outbox.OutboxWriteError);
            expect(c.calls).toEqual([]);
        }
    });

    test('cancelPending moves only this account\'s pending rows of the named types to cancelled', async () => {
        const c = client(2);
        expect(await outbox.cancelPending(c, { ...scope, types: ['nudge_unfinished', 'reassess_reminder'] })).toBe(2);
        expect(c.calls[0].sql).toMatch(/UPDATE nofries\.email_outbox SET status = 'cancelled'\s+WHERE tenant_id = \$1 AND organisation_id = \$2 AND account_id = \$3 AND status = 'pending'/);
        expect(c.calls[0].args).toEqual(['tenant-a', 'organisation-a', scope.accountId, ['nudge_unfinished', 'reassess_reminder']]);
        await expect(outbox.cancelPending(client(), { ...scope, types: [] })).rejects.toBeInstanceOf(outbox.OutboxWriteError);
        await expect(outbox.cancelPending(client(), { ...scope, types: ['other'] })).rejects.toBeInstanceOf(outbox.OutboxWriteError);
    });
});
