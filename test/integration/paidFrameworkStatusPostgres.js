'use strict';

// Registered by the disposable PostgreSQL/real HTTP suite. The trusted fixture
// inserts synthetic activated starter client rows and paid revision heads with
// the owner pool; requests, session captures, SQL roles, RLS and audit are genuine.
module.exports = function registerPaidFrameworkStatusPostgres({ httpSetup, httpJson, getOwnerPool, loginClean,
    subject, nextId, exportAll, evidenceSeedDatabase, generationHeader }) {
    const crypto = require('node:crypto');
    const { createPostgresDashboardRepository } = require('../../api/shared/appLifecycle/postgresDashboardRepository');
    const { STATUS_SQL } = require('../../api/shared/assessmentLifecycle/paidFrameworkStatus');
    const NIST = { moduleId: 'cyber_security', profileId: 'nf-nist-csf-2-0-core', version: '2026-09-08.1' };
    const ISO = { moduleId: 'cyber_security', profileId: 'nf-iso-27001-2022-readiness', version: '2026-11-19.1' };
    const ROUTE = 'organisations/paid-framework-status';
    const CAPABILITIES = 'work-queue-v1 account-label-v1 contact-request-v1 starter-details-v1 questionnaire-details-v1 account-identity-v1 paid-status-v1';
    const clone = value => JSON.parse(JSON.stringify(value));
    const owner = () => getOwnerPool();

    async function setup({ paid = true, accountType = 'consultant', pin = NIST } = {}) {
        const h = await httpSetup({ customerProvider: true, customerAccountType: accountType, paidFrameworksEnabled: paid,
            prepareCanonical(initial) {
                initial.membershipState = { ...initial.membershipState,
                    invitations: initial.membershipState.invitations.map(row => ({ ...row, roles: ['admin'] })),
                    memberships: initial.membershipState.memberships.map(row => ({ ...row, roles: ['admin'] })) };
                initial.entitlementState = { ...initial.entitlementState, grants: initial.entitlementState.grants.map((grant, index) =>
                    index === 0 ? { ...grant, modules: ['cyber_security', 'overview'], frameworks: [clone(pin)] } : grant) };
                initial.flags = { ...initial.flags, enabled: { ...initial.flags.enabled, cyber_security: true }, frameworks: [clone(pin)] };
            } });
        await h.initialize();
        const session = await h.get('session'); httpJson(session, 200); h.generation = session.body.generation;
        h.status = (generation = h.generation) => h.get(ROUTE, generation);
        return h;
    }
    async function account(h, principalSubject = subject(h.principal)) {
        const id = crypto.randomUUID(), at = new Date(Date.parse(h.state.now) - 60000).toISOString();
        await owner().query(`INSERT INTO nofries.dashboard_starter_accounts (account_id,email_sha256,subject_key,account_type,created_at,activated_at)
            VALUES ($1,$2,$3,'consultant',$4,$4)`, [id, crypto.randomBytes(32).toString('hex'), principalSubject, at]);
        return { id, subjectKey: principalSubject };
    }
    async function client(starter, binding, ordinal, activated = true) {
        const scope = binding.scope;
        const { authority_id: authorityId } = (await owner().query('SELECT authority_id FROM nofries.dashboard_identity_bindings WHERE binding_id=$1',
            [binding.bindingId])).rows[0];
        await owner().query(`INSERT INTO nofries.dashboard_starter_scopes (tenant_id,organisation_id,account_id,account_type,subject_key,
            ordinal,authority_id,binding_id,preparation,activation) VALUES ($1,$2,$3,'consultant',$4,$5,$6,$7,$8::jsonb,$9::jsonb)`,
        [scope.tenantId, scope.organisationId, starter.id, starter.subjectKey, ordinal, authorityId,
            binding.bindingId, JSON.stringify({ planId: 'nf-starter-2026-09-r1', scope, subjectKey: starter.subjectKey,
                accountType: 'consultant', kind: 'client' }), activated ? JSON.stringify({ synthetic: 'activated' }) : null]);
    }
    async function head(scope, assessmentId, revision, status, updatedAt, pin = NIST) {
        const record = { state: { tenantId: scope.tenantId, organisationId: scope.organisationId, assessmentId, revision,
            moduleId: 'cyber_security', profileRef: { profileId: pin.profileId, profileVersion: pin.version }, status, updatedAt } };
        await owner().query(`INSERT INTO nofries.dashboard_framework_revisions (tenant_id,organisation_id,profile_id,profile_version,
            assessment_id,revision,idempotency_key,intent_sha256,record_sha256,record) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
        [scope.tenantId, scope.organisationId, pin.profileId, pin.version, assessmentId, revision, 'key-' + revision,
            'a'.repeat(64), 'b'.repeat(64), JSON.stringify(record)]);
    }
    const scopeFor = () => ({ tenantId: crypto.randomUUID(), organisationId: crypto.randomUUID() });
    const row = (binding, status) => ({ bindingId: binding.bindingId, moduleId: 'cyber_security', profileId: NIST.profileId,
        version: NIST.version, status });
    const byBinding = (a, b) => a.bindingId < b.bindingId ? -1 : 1;
    async function asOtherSubject(h, work) {
        const originalOid = h.principal.oid;
        try { h.principal.oid = crypto.randomUUID(); return await work(subject(h.principal)); }
        finally { h.principal.oid = originalOid; }
    }
    async function withoutPaidTuple(h, binding) {
        const repository = createPostgresDashboardRepository({ database: evidenceSeedDatabase(h), clock: () => h.state.now,
            authoriseAdministration: command => ['authority.read', 'flags.update'].includes(command.type) && command.tenantId === binding.scope.tenantId
                && command.organisationId === binding.scope.organisationId && command.actorSubjectKey === subject(h.principal) });
        const current = await repository.readAuthoritySnapshot(binding.scope, { authenticated: true, subjectKey: subject(h.principal) });
        await repository.executeAuthorityCommand({ ...binding.scope, operationId: nextId(), actorSubjectKey: subject(h.principal),
            type: 'flags.update', expectedRevisions: clone(current.revisions), payload: { ...clone(current.snapshot.flags),
                revision: current.revisions.flags + 1, frameworks: [] } });
    }
    async function revoke(h, binding) {
        await owner().query("UPDATE nofries.dashboard_identity_bindings SET revision=revision+1,status='revoked',updated_at=$1 WHERE binding_id=$2",
            [h.state.now, binding.bindingId]);
    }

    describe('HTTP adviser paid assessment status with real tenant isolation', () => {
        test('an authorised adviser sees status only for activated, entitled clients, with per-client audit and no other change', async () => {
            const h = await setup(), starter = await account(h);
            const a = await h.addBinding(scopeFor()), b = await h.addBinding(scopeFor());
            const pending = await h.addBinding(scopeFor()), free = await h.addBinding(scopeFor());
            await client(starter, a, 1); await client(starter, b, 2); await client(starter, pending, 3, false); await client(starter, free, 4);
            await withoutPaidTuple(h, free);
            // A: an open attempt outranks a newer submission, and only each assessment's newest revision counts.
            await head(a.scope, 'open', 0, 'created', '2026-09-07T00:10:00.000Z');
            await head(a.scope, 'open', 1, 'in-progress', '2026-09-07T00:20:00.000Z');
            await head(a.scope, 'done', 0, 'created', '2026-09-07T00:10:00.000Z');
            await head(a.scope, 'done', 1, 'submitted', '2026-09-07T00:30:00.000Z');
            for (const target of [pending, free]) await head(target.scope, 'hidden', 0, 'submitted', '2026-09-07T00:30:00.000Z');
            // Same organisation ID in another tenant, bound only to another subject, with its own client proof.
            const foreign = await asOtherSubject(h, async otherSubject => {
                const binding = await h.addBinding({ tenantId: crypto.randomUUID(), organisationId: b.scope.organisationId });
                const otherScope = { ...scopeFor() };
                const other = await h.addBinding(otherScope);
                await client(await account(h, otherSubject), other, 1);
                return [binding, other];
            });
            for (const binding of foreign) await head(binding.scope, 'foreign', 0, 'submitted', '2026-09-07T00:30:00.000Z');
            const before = await exportAll(), traceStart = h.f.state.trace.length;
            const response = await h.status(); httpJson(response, 200);
            expect(response.headers['cache-control']).toMatch(/private, no-store/);
            expect(response.body).toEqual({ rows: [row(a, 'in_progress'), row(b, 'not_started')].sort(byBinding) });
            const text = JSON.stringify(response.body);
            for (const hidden of [h.binding, pending, free, ...foreign]) expect(text).not.toContain(hidden.bindingId);
            expect(text).not.toMatch(/tenantId|organisationId|assessmentId|updatedAt|organisationLabel|open|done/);
            // One aggregate per contributing client, each bound to that client's own scope.
            const statusReads = h.f.state.trace.slice(traceStart).filter(event => event.sql === STATUS_SQL && event.phase !== 'after');
            expect(statusReads.map(event => event.params.slice(0, 2)).sort()).toEqual([a.scope, b.scope]
                .map(scope => [scope.tenantId, scope.organisationId]).sort());
            const after = await exportAll();
            for (const table of Object.keys(before).filter(table => table !== 'dashboard_runtime_audit')) expect(after[table]).toEqual(before[table]);
            const audit = after.dashboard_runtime_audit.filter(item => !before.dashboard_runtime_audit.some(old => old.event_id === item.event_id));
            expect(audit.map(item => [item.tenant_id, item.organisation_id, item.session_sha256, item.payload.action, item.payload.module]).sort())
                .toEqual([a, b].map(binding => [binding.scope.tenantId, binding.scope.organisationId, h.sessionSha256, 'adviser.client_status.read', 'cyber_security']).sort());
            const session = await h.get('session'); httpJson(session, 200);
            expect(session.body).toMatchObject({ selectedBindingId: h.binding.bindingId, generation: h.generation });
            await loginClean();
        });

        test('the cursor excludes the preceding client and only the granted ISO version contributes status', async () => {
            const h = await setup({ pin: ISO }), starter = await account(h);
            const clients = [await h.addBinding(scopeFor()), await h.addBinding(scopeFor())].sort(byBinding);
            const [first, second] = clients;
            await client(starter, first, 1);
            await client(starter, second, 2);
            await head(second.scope, 'current', 0, 'submitted', h.state.now, ISO);
            await head(second.scope, 'old', 0, 'created', h.state.now, { ...ISO, version: '2026-01-01.1' });
            const response = await h.get(ROUTE + '?afterBindingId=' + first.bindingId, h.generation);
            httpJson(response, 200);
            expect(response.body.rows).toEqual([{ bindingId: second.bindingId, ...ISO, status: 'submitted' }]);
            const end = await h.get(ROUTE + '?afterBindingId=' + second.bindingId, h.generation);
            httpJson(end, 200);
            expect(end.body.rows).toEqual([]);
        });

        test('a removed client membership contributes neither status nor read audit', async () => {
            const h = await setup(), starter = await account(h), a = await h.addBinding(scopeFor());
            await client(starter, a, 1);
            const initial = await h.status();
            httpJson(initial, 200);
            expect(initial.body.rows).toEqual([row(a, 'not_started')]);
            const actorSubjectKey = subject(h.principal);
            const repository = createPostgresDashboardRepository({ database: evidenceSeedDatabase(h), clock: () => h.state.now,
                authoriseAdministration: command => ['authority.read', 'membership.command'].includes(command.type)
                    && command.actorSubjectKey === actorSubjectKey && command.tenantId === a.scope.tenantId
                    && command.organisationId === a.scope.organisationId });
            const current = await repository.readAuthoritySnapshot(a.scope, { authenticated: true, subjectKey: actorSubjectKey });
            await repository.executeAuthorityCommand({ ...a.scope, operationId: nextId(), actorSubjectKey,
                type: 'membership.command', expectedRevisions: clone(current.revisions), payload: { action: 'remove',
                    payload: { membershipId: current.snapshot.membershipState.memberships[0].membershipId } } });
            const before = await exportAll();
            const next = await h.status();
            httpJson(next, 200);
            expect(next.body.rows).toEqual([]);
            expect((await exportAll()).dashboard_runtime_audit).toEqual(before.dashboard_runtime_audit);
        });

        test('revocation hides the client on the next request and fails a request already assembling', async () => {
            const h = await setup(), starter = await account(h);
            const a = await h.addBinding(scopeFor()), b = await h.addBinding(scopeFor());
            await client(starter, a, 1); await client(starter, b, 2);
            httpJson(await h.status(), 200);
            await revoke(h, a);
            const next = await h.status(); httpJson(next, 200);
            expect(next.body).toEqual({ rows: [row(b, 'not_started')] });
            let injected = false;
            h.f.state.hook = async event => {
                if (!injected && event.phase === 'after' && event.sql === STATUS_SQL) { injected = true; await revoke(h, b); }
            };
            const before = await exportAll();
            let response;
            try { response = await h.status(); } finally { h.f.state.hook = null; }
            expect(injected).toBe(true);
            httpJson(response, 403, 'framework_access_denied');
            expect(response.body.rows).toBeUndefined();
            const after = await exportAll();
            expect(after.dashboard_runtime_audit).toEqual(before.dashboard_runtime_audit);
            await loginClean();
        });

        test.each([['an unknown status', 'scored', '2026-09-07T00:30:00.000Z'], ['a malformed update time', 'submitted', 'yesterday']])
        ('%s in any current head makes the whole page unavailable', async (_label, status, updatedAt) => {
            const h = await setup(), starter = await account(h);
            const a = await h.addBinding(scopeFor()), b = await h.addBinding(scopeFor());
            await client(starter, a, 1); await client(starter, b, 2);
            await head(a.scope, 'good', 0, 'submitted', '2026-09-07T00:30:00.000Z');
            await head(b.scope, 'bad', 0, 'created', '2026-09-07T00:10:00.000Z');
            await head(b.scope, 'bad', 1, status, updatedAt);
            const before = await exportAll();
            const response = await h.status(); httpJson(response, 503, 'framework_unavailable');
            expect(response.body.rows).toBeUndefined();
            expect((await exportAll()).dashboard_runtime_audit).toEqual(before.dashboard_runtime_audit);
            await loginClean();
        });

        test.each([['company account', { accountType: 'company' }], ['stale generation', {}], ['missing generation', {}]])
        ('%s is refused before any status read', async (label, options) => {
            const h = await setup(options), starter = await account(h), a = await h.addBinding(scopeFor());
            await client(starter, a, 1);
            const traceStart = h.f.state.trace.length;
            const response = label === 'stale generation' ? await h.status('c'.repeat(64))
                : label === 'missing generation' ? await h.get(ROUTE) : await h.status();
            expect(response.status).toBe(403); expect(response.body.rows).toBeUndefined();
            expect(h.f.state.trace.slice(traceStart).some(event => /dashboard_framework_revisions|dashboard_starter_scopes/.test(event.sql))).toBe(false);
            await loginClean();
        });

        test('with the flag off the route is unknown and the session is unchanged', async () => {
            const h = await setup({ paid: false }), starter = await account(h), a = await h.addBinding(scopeFor());
            await client(starter, a, 1); await head(a.scope, 'x', 0, 'submitted', '2026-09-07T00:30:00.000Z');
            const before = await exportAll(), traceStart = h.f.state.trace.length;
            httpJson(await h.status(), 404, 'dashboard_not_found');
            const offered = await h.get('session').set('X-NoFries-Dashboard-Capabilities', CAPABILITIES);
            const current = await h.get('session').set('X-NoFries-Dashboard-Capabilities', CAPABILITIES.replace(' paid-status-v1', ''));
            httpJson(offered, 200); expect(offered.body).toEqual(current.body);
            expect(offered.body).not.toHaveProperty('paidFrameworkStatusAvailable');
            expect(h.f.state.trace.slice(traceStart).some(event => /dashboard_framework_revisions|dashboard_starter_scopes/.test(event.sql))).toBe(false);
            // Session reads keep their ordinary runtime audit; nothing else changes.
            const after = await exportAll();
            for (const table of Object.keys(before).filter(table => table !== 'dashboard_runtime_audit')) expect(after[table]).toEqual(before[table]);
            expect(after.dashboard_runtime_audit.filter(item => !before.dashboard_runtime_audit.some(old => old.event_id === item.event_id))
                .map(item => item.payload.action)).toEqual(['readSession', 'readSession']);
            await loginClean();
        });

        test('with the flag on a consultant session advertises the status read', async () => {
            const h = await setup();
            const offered = await h.get('session').set('X-NoFries-Dashboard-Capabilities', CAPABILITIES); httpJson(offered, 200);
            expect(offered.body.paidFrameworkStatusAvailable).toBe(true);
            expect(generationHeader).toBe('X-NoFries-Dashboard-Generation');
            await loginClean();
        });
    });
};
