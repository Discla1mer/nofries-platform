'use strict';

// Registered by the existing disposable PostgreSQL/real HTTP suite. The only
// new fixture input is an explicit trusted synthetic consultant account type;
// requests, session captures, SQL roles, retained plans and audits are genuine.
module.exports = function registerConsultantWorkQueuePostgres({ improvementHttpSetup, ncscHttpSetup, httpJson,
    getOwnerPool, loginClean, subject, nextId, exportAll, createCommand, saveCommand, submitCommand,
    evidenceSeedDatabase }) {
    const { allResponses } = require('../fixtures/ncscAssessmentFixture');
    const { createPostgresDashboardRepository } = require('../../api/shared/appLifecycle/postgresDashboardRepository');
    const clone = value => JSON.parse(JSON.stringify(value));
    const options = { customerProvider: true, customerAccountType: 'consultant' };
    const queue = (h, query = '', generation = h.generation) => h.get('work-queue' + (query ? '?' + query : ''), generation);
    const rowKey = row => [row.bindingId, row.planId, row.actionId].join('/');

    async function taskRows() {
        const result = {};
        for (const table of ['dashboard_improvement_heads', 'dashboard_improvement_revisions']) {
            result[table] = (await getOwnerPool().query(`SELECT to_jsonb(r) AS value FROM nofries.${table} r
                ORDER BY to_jsonb(r)::text`)).rows.map(row => row.value);
        }
        return result;
    }
    async function setup() {
        const h = await improvementHttpSetup(options);
        const generated = await h.improvementPost(h.generateImprovement()); httpJson(generated, 200);
        h.firstPlan = generated.body.plan;
        return h;
    }
    async function addPlan(h, label = 'second') {
        const binding = await h.addBinding({ tenantId: 'queue-' + label + '-' + nextId(),
            organisationId: h.binding.scope.organisationId });
        h.generation = await h.select(binding, h.generation);
        httpJson(await h.ncscPost(createCommand()), 201);
        httpJson(await h.ncscPost(saveCommand('assessment-a', 0, 'save-a', allResponses('no'))), 200);
        const submitted = await h.ncscPost(submitCommand()); httpJson(submitted, 200);
        const generated = await h.improvementPost({ planId: 'plan-a', type: 'generate', operationId: 'generate-a',
            expectedRevision: null, actionId: null, payload: { assessmentId: 'assessment-a',
                assessmentRevision: submitted.body.assessment.revision,
                assessmentRevisionSha256: submitted.body.assessment.revisionSha256 } });
        httpJson(generated, 200);
        return { binding, plan: generated.body.plan };
    }
    async function disableImprovement(h, binding) {
        const repository = createPostgresDashboardRepository({ database: evidenceSeedDatabase(h), clock: () => h.state.now,
            authoriseAdministration: command => ['authority.read', 'flags.update'].includes(command.type) && command.tenantId === binding.scope.tenantId
                && command.organisationId === binding.scope.organisationId && command.actorSubjectKey === subject(h.principal) });
        // NCSC submission advances usage after the original seed.
        // Bind this sole flag change to the current canonical vector.
        const current = await repository.readAuthoritySnapshot(binding.scope,
            { authenticated: true, subjectKey: subject(h.principal) });
        await repository.executeAuthorityCommand({ ...binding.scope, operationId: nextId(), actorSubjectKey: subject(h.principal),
            type: 'flags.update', expectedRevisions: clone(current.revisions), payload: { ...clone(current.snapshot.flags),
                revision: current.revisions.flags + 1, enabled: { ...current.snapshot.flags.enabled, improvement_plan: false } } });
    }

    describe('HTTP consultant work queue with real tenant isolation', () => {
        test('reads retained actions across clients without changing selection or action records, with per-client native audit', async () => {
            const h = await setup(), other = await addPlan(h);
            h.generation = await h.select(h.binding, h.generation);
            const before = await exportAll(), beforeTasks = await taskRows();
            const traceStart = h.f.state.trace.length;
            const response = await queue(h); httpJson(response, 200);
            expect(response.body).toMatchObject({ schemaVersion: 1, dueDateBasis: 'UTC_calendar_day',
                coverage: { basis: 'current_page', checkedOrganisations: 2, partialOrganisations: 0,
                    unavailableOrganisations: 0, complete: true }, nextCursor: null });
            const expected = [[h.binding, h.firstPlan], [other.binding, other.plan]];
            expect(response.body.rows).toHaveLength(expected.reduce((count, [, plan]) => count + plan.actions.length, 0));
            for (const [binding, plan] of expected) {
                const found = response.body.rows.filter(row => row.bindingId === binding.bindingId);
                expect(found.map(row => row.actionId).sort()).toEqual(plan.actions.map(row => row.actionId).sort());
                expect(found.every(row => row.planId === 'plan-a' && row.planRevision === plan.revision)).toBe(true);
                expect(found[0]).toMatchObject({ assigned: false, ownerEligibility: 'not_checked', dueDate: null,
                    source: { assessmentId: 'assessment-a' } });
                expect(response.body.organisations).toContainEqual(expect.objectContaining({ bindingId: binding.bindingId, state: 'checked' }));
            }
            expect(new Set(response.body.rows.map(rowKey)).size).toBe(response.body.rows.length);
            expect(JSON.stringify(response.body)).not.toMatch(/tenantId|organisationId|ownerSubjectKey|sessionSha256/);
            // Genuine plan reads retain their existing UPDATE locks. The final
            // multi-client authority check takes compatible SHARE locks only;
            // upgrading a previously read tenant can invert starter retry locks.
            const transactions = []; let transaction = null;
            for (const event of h.f.state.trace.slice(traceStart).filter(row => row.phase === 'before')) {
                if (/^BEGIN(?: READ ONLY)?$/i.test(event.sql)) transaction = [];
                else if (transaction && /^(?:COMMIT|ROLLBACK)$/i.test(event.sql)) {
                    transactions.push(transaction); transaction = null;
                } else if (transaction) transaction.push(event);
            }
            const tenantLocks = rows => rows.filter(event => /FROM nofries\.dashboard_tenants\b/.test(event.sql));
            const planTransactions = transactions.filter(rows => rows.some(event => /FROM nofries\.dashboard_improvement_(?:heads|revisions)\b/.test(event.sql)));
            expect(planTransactions.length).toBeGreaterThanOrEqual(4);
            for (const rows of planTransactions) {
                expect(tenantLocks(rows).length).toBeGreaterThan(0);
                expect(tenantLocks(rows).every(event => /FOR UPDATE$/.test(event.sql))).toBe(true);
            }
            const finalLocks = tenantLocks(transactions.filter(rows => tenantLocks(rows).length).at(-1));
            expect(finalLocks.map(event => event.params[0]).sort()).toEqual([h.binding.scope.tenantId, other.binding.scope.tenantId].sort());
            expect(finalLocks.every(event => /FOR SHARE$/.test(event.sql))).toBe(true);
            const after = await exportAll();
            for (const table of Object.keys(before).filter(table => table !== 'dashboard_runtime_audit')) {
                expect(after[table]).toEqual(before[table]);
            }
            expect(await taskRows()).toEqual(beforeTasks);
            const audit = after.dashboard_runtime_audit.filter(row => !before.dashboard_runtime_audit.some(old => old.event_id === row.event_id));
            for (const [binding] of expected) {
                expect(audit).toContainEqual(expect.objectContaining({ tenant_id: binding.scope.tenantId,
                    organisation_id: binding.scope.organisationId, session_sha256: h.sessionSha256,
                    payload: expect.objectContaining({ action: 'improvement.read', result: 'succeeded' }) }));
            }
            const session = await h.get('session'); httpJson(session, 200);
            expect(session.body).toMatchObject({ selectedBindingId: h.binding.bindingId, generation: h.generation });
            await loginClean();
        });

        test('bounded continuation resumes the exact retained plan without duplicate rows or selection writes', async () => {
            const h = await setup(), before = await taskRows();
            const first = await queue(h, 'limit=2'); httpJson(first, 200);
            expect(first.body.rows).toHaveLength(2);
            expect(first.body.coverage).toMatchObject({ partialOrganisations: 1, complete: false });
            expect(typeof first.body.nextCursor).toBe('string');
            const second = await queue(h, 'limit=2&cursor=' + encodeURIComponent(first.body.nextCursor)); httpJson(second, 200);
            expect(second.body.rows).toHaveLength(2);
            expect(new Set([...first.body.rows, ...second.body.rows].map(rowKey)).size).toBe(4);
            expect([...first.body.rows, ...second.body.rows].every(row => row.bindingId === h.binding.bindingId && row.planId === 'plan-a')).toBe(true);
            expect(await taskRows()).toEqual(before);
            const changedGeneration = await h.select(h.binding, h.generation);
            expect(changedGeneration).not.toBe(h.generation);
            httpJson(await queue(h, 'limit=2&cursor=' + encodeURIComponent(first.body.nextCursor), changedGeneration), 409, 'work_queue_changed');
            await loginClean();
        });

        test.each([
            ['operator', {}],
            ['company', { customerProvider: true, customerAccountType: 'company' }],
            ['unclassified customer', { customerProvider: true }]
        ])('rejects the %s account before portfolio SQL or retained task disclosure', async (_label, selected) => {
            const h = await ncscHttpSetup({ ...selected, improvementEnabled: true });
            const boundary = h.f.state.trace.length, before = await taskRows();
            const response = await queue(h); httpJson(response, 403, 'dashboard_access_denied');
            expect(response.body.rows).toBeUndefined();
            expect(h.f.state.trace.slice(boundary).some(event => /dashboard_improvement_(heads|revisions)/.test(event.sql))).toBe(false);
            expect(await taskRows()).toEqual(before); await loginClean();
        });

        test('rejects missing/stale generations and browser-supplied target scope', async () => {
            const h = await setup(), before = await taskRows();
            httpJson(await h.get('work-queue'), 403, 'dashboard_access_denied');
            const stale = await queue(h, '', 'a'.repeat(64)); expect(stale.status).toBe(403);
            for (const query of ['tenantId=foreign', 'organisationId=foreign', 'bindingId=' + nextId(), 'limit=51']) {
                const response = await queue(h, query); expect(response.status).toBe(400);
                expect(response.body.rows).toBeUndefined();
            }
            expect(await taskRows()).toEqual(before); await loginClean();
        });

        test('unavailable client contributes no rows or label, and another subject binding is never enumerated', async () => {
            const h = await setup(), other = await addPlan(h);
            h.generation = await h.select(h.binding, h.generation);
            await disableImprovement(h, other.binding);
            // This trusted fixture operator publishes a real binding for a
            // distinct immutable subject, then restores the signed-in subject.
            const originalOid = h.principal.oid; let foreign;
            try {
                h.principal.oid = nextId();
                foreign = await h.addBinding({ tenantId: 'queue-foreign-' + nextId(), organisationId: 'foreign-only' });
            } finally { h.principal.oid = originalOid; }
            const before = await taskRows(), response = await queue(h); httpJson(response, 200);
            expect(response.body.coverage).toMatchObject({ checkedOrganisations: 1, unavailableOrganisations: 1, complete: true });
            expect(response.body.rows.every(row => row.bindingId === h.binding.bindingId)).toBe(true);
            expect(response.body.organisations.map(row => row.bindingId)).toEqual([h.binding.bindingId]);
            expect(JSON.stringify(response.body)).not.toContain(other.binding.bindingId);
            expect(JSON.stringify(response.body)).not.toContain(foreign.bindingId);
            expect(await taskRows()).toEqual(before); await loginClean();
        });

        test.each(['binding revoked', 'parent expired'])('suppresses the aggregate when %s after an actual action-read COMMIT', async variant => {
            const h = await setup(); let armed = false, injected = false;
            const before = await taskRows();
            h.f.state.hook = async event => {
                if (event.phase === 'after' && /FROM nofries\.dashboard_improvement_revisions\b/.test(event.sql)) armed = true;
                if (!injected && armed && event.phase === 'after' && /^COMMIT\s*$/i.test(event.sql)) {
                    injected = true;
                    if (variant === 'binding revoked') {
                        await getOwnerPool().query("UPDATE nofries.dashboard_identity_bindings SET revision=1,status='revoked',updated_at=$1 WHERE binding_id=$2",
                            [h.state.now, h.binding.bindingId]);
                    } else h.state.now = '2026-09-07T02:00:01.000Z';
                }
            };
            let response;
            try { response = await queue(h); } finally { h.f.state.hook = null; }
            expect(injected).toBe(true);
            expect(response.status).toBe(variant === 'binding revoked' ? 403 : 503);
            expect(response.body.rows).toBeUndefined(); expect(response.body.organisations).toBeUndefined();
            expect(await taskRows()).toEqual(before); await loginClean();
        });
    });
};
