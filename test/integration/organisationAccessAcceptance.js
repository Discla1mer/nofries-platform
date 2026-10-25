'use strict';

// Registered by the existing PostgreSQL gate. Identity/Blob providers are
// synthetic; the production HTTP application, membership and SQL are genuine.
const crypto = require('node:crypto');
const request = require('supertest');
const { applyMigrations } = require('../../scripts/db-migrate');
const { customerProductionHarness } = require('../helpers/customerProductionHarness');
const { trackPoolClientEnds } = require('../helpers/postgresPoolLifecycle');
const { createPostgresDashboardMaintenanceRepository } = require('../../api/shared/appLifecycle/postgresDashboardRuntimeRepository');
const { createPostgresDatabase } = require('../../api/shared/database/postgres');
const { dataStorage } = require('../../api/shared/appLifecycle/postgresDashboardBootstrap');
const { applyMembershipCommand } = require('../../api/shared/appLifecycle/membershipDomain');
const { hash } = require('../../api/shared/appLifecycle/dashboardRuntimeRecords');
const { subjectHash } = require('../../api/shared/customerSignup/customerAuthority');
const { createCommand, saveCommand } = require('../fixtures/ncscAssessmentFixture');

const id = () => crypto.randomUUID();
const generationHeader = 'X-NoFries-Dashboard-Generation';
const details = { name: 'Synthetic Representative', role: 'Owner', address: 'Synthetic address',
    registrationId: '', authorityConfirmed: true };
const displayName = 'Identical synthetic organisation';

module.exports = function registerOrganisationAccessAcceptance() {
    const testUrl = String(process.env.NOFRIES_TEST_DATABASE_URL || '').trim();
    (testUrl ? describe : describe.skip)('Managed customer organisation ownership with real PostgreSQL', () => {
        const runKey = crypto.randomBytes(8).toString('hex');
        const databaseName = `nf_org_acceptance_${runKey}`, runtimeRole = `nf_org_runtime_${runKey}`;
        const password = `synthetic-only-${runKey}`;
        let controlPool, ownerPool, runtimePool, closeOwner, closeRuntime;
        let databaseCreated = false, roleCreated = false;

        beforeAll(async () => {
            const { Pool } = require('pg');
            controlPool = new Pool({ connectionString: testUrl, max: 1 });
            // These generated identifiers are fixed-prefix hexadecimal names.
            await controlPool.query(`CREATE DATABASE ${databaseName}`); databaseCreated = true;
            const ownerUrl = new URL(testUrl); ownerUrl.pathname = '/' + databaseName;
            ownerPool = new Pool({ connectionString: ownerUrl.toString(), max: 2 });
            closeOwner = trackPoolClientEnds(ownerPool);
            await applyMigrations({ pool: ownerPool });
            await controlPool.query(`CREATE ROLE ${runtimeRole} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT`);
            roleCreated = true;
            await controlPool.query(`GRANT nofries_runtime TO ${runtimeRole} WITH INHERIT FALSE, SET TRUE, ADMIN FALSE`);
            const runtimeUrl = new URL(ownerUrl); runtimeUrl.username = runtimeRole; runtimeUrl.password = password;
            runtimePool = new Pool({ connectionString: runtimeUrl.toString(), max: 2, connectionTimeoutMillis: 5000 });
            closeRuntime = trackPoolClientEnds(runtimePool);
            expect((await runtimePool.query('SELECT rolsuper, rolbypassrls, rolcreaterole FROM pg_roles WHERE rolname=current_user')).rows)
                .toEqual([{ rolsuper: false, rolbypassrls: false, rolcreaterole: false }]);
        });
        afterAll(async () => {
            if (closeRuntime) await closeRuntime();
            if (closeOwner) await closeOwner();
            if (controlPool) {
                try {
                    // Never delete pre-existing test records. Only this suite's
                    // freshly created database and role belong to its teardown.
                    if (databaseCreated) await controlPool.query(`DROP DATABASE ${databaseName}`);
                    if (roleCreated) await controlPool.query(`DROP ROLE ${runtimeRole}`);
                } finally { await controlPool.end(); }
            }
        });

        async function application() {
            require('../../api/shared/abuseProtection').resetAbuseProtectionForTests();
            const instanceId = id(), restoreEpoch = id(), actorSubjectKey = id() + ':' + id();
            const maintenance = createPostgresDashboardMaintenanceRepository({ pool: ownerPool, instanceId,
                clock: () => new Date().toISOString(), newId: id,
                historyBudget: { maxRecords: 4096, maxBytes: 67108864, maxDurationMs: 60000 },
                readExternalRuntimeEpoch: async () => ({ instanceId, restoreEpoch }),
                authoriseMaintenanceOperation: facts => ['initializeRuntimeInstance', 'enableRuntimeIngress'].includes(facts.operationType)
                    && facts.command.actorSubjectKey === actorSubjectKey });
            const command = before => ({ operationId: id(), actorSubjectKey, expectedRevision: before?.revision ?? null,
                expectedRecordSha256: before ? hash(before) : null, restoreEpoch,
                evidenceRef: 'synthetic-test-instance', evidenceSha256: hash('synthetic-test-instance') });
            const initialized = await maintenance.initializeRuntimeInstance(command());
            await maintenance.enableRuntimeIngress(command(initialized.record));
            return customerProductionHarness({ pool: runtimePool, instanceId, restoreEpoch, now: Date.now(),
                starter: true, external: true });
        }
        const post = (h, path, cookie, body, csrfToken) => h.sameOrigin(request(h.app).post(path))
            .set('Cookie', cookie).set('X-CSRF-Token', csrfToken || '').send(body);
        async function customer(h, accountType) {
            h.state.externalOid = id(); h.state.externalEmail = `synthetic-${id()}@example.test`;
            const subjectKey = h.dependencies.externalCustomer.identityProvider.tenantId + ':' + h.state.externalOid;
            expect(h.env.NOFRIES_ALLOWED_SUBJECTS).not.toContain(subjectKey);
            const provisional = await h.loginExternal(); expect(provisional.response.status).toBe(303);
            const state = await request(h.app).get('/api/external-customer-signup/state').set('Cookie', provisional.cookie);
            expect(state.body.state).toEqual({ status: 'setup_details', email: h.state.externalEmail });
            const submitted = await post(h, '/api/external-customer-signup/setup', provisional.cookie,
                { accountType, organisationName: displayName, details }, state.body.csrfToken);
            expect(submitted.status).toBe(200); expect(submitted.body.state.status).toBe('continue_authentication');
            const login = await h.loginExternal(); expect(login.response.status).toBe(303);
            const consent = await h.consentExternal(login.cookie);
            expect(consent.before.body.state.status).toBe('terms');
            expect(consent.response.status).toBe(200);
            expect(consent.response.body.state).toEqual({ status: 'continue_to_dashboard', accountType });
            const session = await request(h.app).get('/api/dashboard/session').set('Cookie', login.cookie);
            expect(session.status).toBe(200); expect(session.body.accountType).toBe(accountType);
            const authority = JSON.parse(h.getContainer('external-starter-authority').records
                .get(`customer-subjects/${subjectHash(subjectKey)}.json`));
            expect(authority.subjectKey).toBe(subjectKey);
            // Consultant activation starts unselected; select its actual home.
            const own = await directory(h, login.cookie);
            expect(own).toHaveLength(1);
            const value = { cookie: login.cookie, csrfToken: consent.before.body.csrfToken, subjectKey, authority,
                bindingId: own[0].bindingId, generation: session.body.generation };
            if (session.body.selectedBindingId !== value.bindingId) await select(h, value, value.bindingId);
            return value;
        }
        async function directory(h, cookie) {
            const bindings = []; let after = null;
            do {
                const page = await request(h.app).get('/api/dashboard/organisations?limit=1' + (after ? '&afterBindingId=' + after : ''))
                    .set('Cookie', cookie);
                expect(page.status).toBe(200); expect(page.body.bindings.length).toBeLessThanOrEqual(1);
                bindings.push(...page.body.bindings);
                expect(bindings.length).toBeLessThanOrEqual(4);
                after = page.body.nextAfterBindingId;
            } while (after);
            return bindings;
        }
        async function select(h, customer, bindingId) {
            const result = await post(h, '/api/dashboard/selection', customer.cookie,
                { operationId: id(), bindingId, expectedGeneration: customer.generation });
            expect(result.status).toBe(200); expect(result.body.selectedBindingId).toBe(bindingId);
            customer.generation = result.body.generation;
            return result;
        }
        async function clients(h, customer) {
            const result = await request(h.app).get('/api/customer-signup/clients').set('Cookie', customer.cookie);
            expect(result.status).toBe(200); expect(result.body.state.status).toBe('clients');
            return result.body;
        }
        async function offerClient(h, customer, requestId = id()) {
            const before = await clients(h, customer);
            const response = await post(h, '/api/customer-signup/clients', customer.cookie,
                { action: 'create', requestId, organisationName: displayName, details }, before.csrfToken);
            expect(response.status).toBe(200); expect(response.body.state.status).toBe('terms');
            const { termsVersion, termsDigest, scheduleId, scheduleDigest } = response.body.state;
            return { requestId, csrfToken: response.body.csrfToken, state: response.body.state,
                terms: { accepted: true, termsVersion, termsDigest, scheduleId, scheduleDigest } };
        }
        async function acceptClient(h, customer, offer) {
            const before = await directory(h, customer.cookie);
            const accepted = await post(h, '/api/customer-signup/clients', customer.cookie,
                { action: 'accept', requestId: offer.requestId, terms: offer.terms }, offer.csrfToken);
            expect(accepted.status).toBe(200); expect(accepted.body.state.status).toBe('ready');
            const after = await directory(h, customer.cookie);
            expect(after).toHaveLength(before.length + 1);
            return after.find(binding => !before.some(prior => prior.bindingId === binding.bindingId)).bindingId;
        }
        async function snapshot(h) {
            // Include immutable receipts, memberships, bindings, usage and audit,
            // not only row counts; a forbidden action must not rewrite history.
            const names = (await ownerPool.query("SELECT tablename FROM pg_tables WHERE schemaname='nofries' ORDER BY tablename")).rows;
            const sql = {};
            for (const { tablename } of names) {
                expect(tablename).toMatch(/^[a-z0-9_]+$/);
                sql[tablename] = (await ownerPool.query(`SELECT to_jsonb(t) AS row FROM nofries.${tablename} t ORDER BY to_jsonb(t)::text`)).rows;
            }
            const authority = [...h.getContainer('external-starter-authority').records]
                .map(([key, bytes]) => [key, bytes.toString()]).sort(([a], [b]) => a.localeCompare(b));
            return { sql, authority };
        }
        function denied(response) {
            // The existing client route sanitizes ownership/terms failures into
            // this generic contract. Successful owner operations below ensure
            // the same route is working; a CSRF/auth/other failure is not proof.
            expect(response.status).toBe(503);
            expect(response.body).toEqual({ code: 'starter_signup_unavailable' });
            expect(response.headers.location).toBeUndefined();
        }
        const bootstrap = (h, customer) => request(h.app).get('/api/dashboard/bootstrap').set('Cookie', customer.cookie)
            .set(generationHeader, customer.generation);

        test('independent Company and Consultants cannot adopt client requests, terms or bindings despite matching names and request IDs', async () => {
            const h = await application();
            const company = await customer(h, 'company'), a = await customer(h, 'consultant'), b = await customer(h, 'consultant');
            const offeredA = await offerClient(h, a);
            const resumedA = await post(h, '/api/customer-signup/clients', a.cookie,
                { action: 'resume', requestId: offeredA.requestId }, offeredA.csrfToken);
            expect(resumedA.status).toBe(200); expect(resumedA.body.state).toEqual(offeredA.state);
            const listB = await clients(h, b);
            expect(company.csrfToken).toBeTruthy();
            const before = await snapshot(h);
            for (const action of ['resume', 'accept']) {
                const body = { action, requestId: offeredA.requestId, ...(action === 'accept' ? { terms: offeredA.terms } : {}) };
                denied(await post(h, '/api/customer-signup/clients', b.cookie, body, listB.csrfToken));
            }
            denied(await post(h, '/api/customer-signup/clients', company.cookie,
                { action: 'create', requestId: id(), organisationName: displayName, details }, company.csrfToken));
            expect(await snapshot(h)).toEqual(before);

            // A request ID is scoped to its authenticated account, not a global
            // capability. An independent legitimate create gets different terms.
            const offeredB = await offerClient(h, b, offeredA.requestId);
            expect(offeredB.terms.scheduleId).not.toBe(offeredA.terms.scheduleId);
            expect(offeredB.terms.scheduleDigest).not.toBe(offeredA.terms.scheduleDigest);
            const beforeWrongTerms = await snapshot(h);
            denied(await post(h, '/api/customer-signup/clients', b.cookie,
                { action: 'accept', requestId: offeredB.requestId, terms: offeredA.terms }, offeredB.csrfToken));
            expect(await snapshot(h)).toEqual(beforeWrongTerms);
            const clientA = await acceptClient(h, a, offeredA), clientB = await acceptClient(h, b, offeredB);
            expect(clientA).not.toBe(clientB);
            for (const [owner, expected] of [[company, [company.bindingId]], [a, [a.bindingId, clientA]], [b, [b.bindingId, clientB]]]) {
                const owned = await directory(h, owner.cookie);
                expect(owned.map(value => value.bindingId).sort()).toEqual(expected.sort());
                expect(owned.every(value => value.organisationLabel === displayName)).toBe(true);
            }
            const beforeForeignSelection = await snapshot(h);
            for (const [attacker, bindingId] of [[company, clientA], [a, clientB], [b, clientA]]) {
                const result = await post(h, '/api/dashboard/selection', attacker.cookie,
                    { operationId: id(), bindingId, expectedGeneration: attacker.generation });
                expect(result.status).toBe(403); expect(result.body).toEqual({ code: 'dashboard_access_denied' });
            }
            expect(await snapshot(h)).toEqual(beforeForeignSelection);
            await select(h, a, clientA); await select(h, b, clientB);
            for (const [owner, bindingId] of [[company, company.bindingId], [a, clientA], [b, clientB]]) {
                const view = await bootstrap(h, owner); expect(view.status).toBe(200);
                const scope = (await ownerPool.query('SELECT tenant_id,organisation_id FROM nofries.dashboard_identity_bindings WHERE binding_id=$1', [bindingId])).rows[0];
                expect(view.body.context.organisationId).toBe(scope.organisation_id);
            }
        });

        test('client-only membership suspension blocks a retained selected session without disabling valid home or another customer', async () => {
            const h = await application(), consultant = await customer(h, 'consultant'), company = await customer(h, 'company');
            const client = await acceptClient(h, consultant, await offerClient(h, consultant));
            expect((await clients(h, consultant)).state.remaining).toBe(2);
            await select(h, consultant, client);
            const assessmentPost = command => {
                const { action, assessmentId, ...body } = command;
                return post(h, '/api/dashboard/ncsc/assessments' + (action === 'create' ? '' : '/' + assessmentId + '/' + action), consultant.cookie,
                    action === 'create' ? { assessmentId, ...body } : body)
                    .set(generationHeader, consultant.generation);
            };
            expect((await assessmentPost(createCommand())).status).toBe(201);
            const retainedGeneration = consultant.generation;
            const binding = (await ownerPool.query('SELECT tenant_id,organisation_id FROM nofries.dashboard_identity_bindings WHERE binding_id=$1', [client])).rows[0];
            const scope = { tenantId: binding.tenant_id, organisationId: binding.organisation_id };
            await createPostgresDatabase({ pool: ownerPool }).withTenantTransaction(scope.tenantId, async tx => {
                const current = await dataStorage.loadSnapshotForUpdate(tx, scope);
                expect(current.membershipState.memberships).toHaveLength(1);
                const next = applyMembershipCommand(current.membershipState, current.tenantAggregate, {
                    ...scope, expectedRevision: current.membershipState.revision, actorSubjectKey: consultant.subjectKey,
                    now: new Date().toISOString(), action: 'suspend', payload: { membershipId: current.membershipState.memberships[0].membershipId } });
                await dataStorage.updateMembershipState(tx, next);
            });
            const before = await snapshot(h);
            expect((await bootstrap(h, consultant)).status).toBe(403);
            const blockedRead = await request(h.app).get('/api/dashboard/ncsc/assessments/assessment-a')
                .set('Cookie', consultant.cookie).set(generationHeader, retainedGeneration);
            expect(blockedRead.status).toBe(403); expect(blockedRead.body).toEqual({ code: 'ncsc_access_denied' });
            const blockedSave = await assessmentPost(saveCommand());
            expect(blockedSave.status).toBe(403); expect(blockedSave.body).toEqual({ code: 'ncsc_access_denied' });
            const blockedSelect = await post(h, '/api/dashboard/selection', consultant.cookie,
                { operationId: id(), bindingId: client, expectedGeneration: retainedGeneration });
            expect(blockedSelect.status).toBe(403); expect(blockedSelect.body).toEqual({ code: 'dashboard_access_denied' });
            expect(await snapshot(h)).toEqual(before);
            // Discovery lists active identity bindings, including a retained
            // binding whose membership was suspended. That route is not access
            // authority: selection and every resource check the live member.
            expect((await directory(h, consultant.cookie)).map(value => value.bindingId).sort())
                .toEqual([consultant.bindingId, client].sort());
            await select(h, consultant, consultant.bindingId);
            expect(consultant.generation).not.toBe(retainedGeneration);
            expect((await bootstrap(h, consultant)).status).toBe(200);
            expect((await snapshot(h)).authority).toEqual(before.authority);
            expect((await bootstrap(h, company)).status).toBe(200);
            expect((await directory(h, company.cookie)).map(value => value.bindingId)).toEqual([company.bindingId]);
        });
    });
};
