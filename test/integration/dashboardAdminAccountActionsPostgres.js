'use strict';

// Synthetic disposable PostgreSQL coverage. The production connection paths and
// private reset controller are deliberately not involved in this fixture.
const crypto = require('node:crypto');
const { IncomingMessage } = require('node:http');
const { Socket } = require('node:net');
const { Readable } = require('node:stream');
const requestHttp = require('supertest');
const { Pool } = require('pg');
const { createNoFriesApp } = require('../../server');
const { createBrowserAuthService } = require('../../api/shared/browserAuth');
const { MemoryBrowserSessionStore } = require('../../api/shared/browserSessionStore');
const { createDashboardOperatorSession } = require('../../api/shared/dashboardOperatorSession');
const { createDashboardAdminAccountActionRuntime } = require('../../api/shared/dashboardAdmin/accountActionRuntime');
const { AzureAccountActionConfirmationStore } = require('../../api/shared/dashboardAdmin/azureAccountActionConfirmationStore');
const { applyMigrations } = require('../../scripts/db-migrate');
const { createPostgresDashboardAdministrationRepository, createPostgresDashboardRuntimeRepository,
    createPostgresDashboardMaintenanceRepository } = require('../../api/shared/appLifecycle/postgresDashboardRuntimeRepository');
const { createPostgresDashboardRepository } = require('../../api/shared/appLifecycle/postgresDashboardRepository');
const { createPostgresDatabase } = require('../../api/shared/database/postgres');
const { dataCodec } = require('../../api/shared/appLifecycle/postgresDashboardBootstrap');
const { applyMembershipCommand } = require('../../api/shared/appLifecycle/membershipDomain');
const { hash } = require('../../api/shared/appLifecycle/dashboardRuntimeRecords');
const { commandDigest } = require('../../api/shared/dashboardAdmin/accountActionRecords');
const { fixture, NOW, SUBJECT } = require('../fixtures/dashboardFixture');
const { isolatedTestUrl } = require('./dashboardAdminSignupPostgres');
const { trackPoolClientEnds } = require('../helpers/postgresPoolLifecycle');

const clone = value => JSON.parse(JSON.stringify(value));
const quote = value => '"' + value.replace(/"/g, '""') + '"';
const START = new Date(Date.parse(NOW) - 60000).toISOString();
const END = new Date(Date.parse(NOW) + 3600000).toISOString();
const OTHER_SUBJECT = SUBJECT.slice(0, -1) + '2';
const WRITES = /^(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/i;
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };

module.exports = function registerDashboardAdminAccountActionsPostgresTests() {
    const testUrl = String(process.env.NOFRIES_TEST_DATABASE_URL || '').trim();
    (testUrl ? describe : describe.skip)('Native scoped administration account actions', () => {
        const runKey = crypto.randomBytes(6).toString('hex');
        const databaseName = 'nf_admin_actions_' + runKey, runtimeRole = 'nf_admin_actions_runtime_' + runKey;
        let control, owner, runtimePool, closeOwner, closeRuntime, databaseCreated = false, roleCreated = false, sequence = 100;
        const nextId = () => '89000000-0000-4000-8000-' + String(++sequence).padStart(12, '0');

        beforeAll(async () => {
            const url = new URL(isolatedTestUrl(testUrl));
            control = new Pool({ connectionString: testUrl, max: 1 });
            await control.query(`CREATE DATABASE ${quote(databaseName)}`); databaseCreated = true;
            url.pathname = '/' + databaseName;
            owner = new Pool({ connectionString: url.toString(), max: 2 });
            closeOwner = trackPoolClientEnds(owner);
            const client = await owner.connect();
            try { await applyMigrations({ client }); } finally { client.release(); }
            const password = 'synthetic-actions-only-' + runKey;
            await control.query(`CREATE ROLE ${quote(runtimeRole)} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT`);
            roleCreated = true;
            await control.query(`GRANT nofries_runtime TO ${quote(runtimeRole)} WITH INHERIT FALSE, SET TRUE, ADMIN FALSE`);
            url.username = runtimeRole; url.password = password;
            runtimePool = new Pool({ connectionString: url.toString(), max: 2, connectionTimeoutMillis: 5000 });
            closeRuntime = trackPoolClientEnds(runtimePool);
        }, 30000);

        afterAll(async () => {
            const closed = await Promise.allSettled([closeRuntime?.(), closeOwner?.()]);
            if (control) {
                try {
                    if (closed.some(result => result.status === 'rejected')) throw new Error('account_action_native_cleanup_failed');
                    if (databaseCreated) await control.query(`DROP DATABASE ${quote(databaseName)}`);
                    if (roleCreated) await control.query(`DROP ROLE ${quote(runtimeRole)}`);
                } finally { await control.end(); }
            }
        });

        async function harness({ self = false } = {}) {
            const instanceId = nextId(), restoreEpoch = nextId();
            const identity = { policyId: 'synthetic-account-actions', policyRevision: 1,
                issuer: 'https://identity.example.invalid/v2.0', identityTenantId: nextId(), oid: nextId(), audience: nextId() };
            if (self) [identity.identityTenantId, identity.oid] = SUBJECT.split(':');
            const actor = identity.identityTenantId + ':' + identity.oid, request = Object.freeze({ syntheticRequestId: nextId() });
            const capture = { requestId: nextId(), deadline: new Date(Date.parse(NOW) + 60000).toISOString(),
                sessionSha256: hash(nextId()), kind: 'operator_dashboard', identityPayload: identity, instanceId, restoreEpoch,
                issuedAt: START, expiresAt: END, discovery: null, operatorIssuanceProof: null };
            capture.operatorIssuanceProof = { schemaVersion: 1, kind: 'operator_dashboard_issuance',
                sessionSha256: capture.sessionSha256, identitySha256: hash(identity), instanceId, restoreEpoch, issuedAt: START, expiresAt: END };
            const state = { now: NOW, allowed: true, authoritySha256: 'a'.repeat(64), externalEpoch: restoreEpoch,
                trace: [], before: null, after: null, loseCommit: false, allowOther: false };
            const pool = { end: () => runtimePool.end(), async connect() {
                const client = await runtimePool.connect();
                return { release: value => client.release(value), async query(sql, params = []) {
                    state.trace.push({ sql, params: clone(params) });
                    if (state.before) await state.before(sql, params);
                    const result = await client.query(sql, params);
                    if (state.after) await state.after(sql, params, result);
                    if (sql === 'COMMIT' && state.loseCommit) { state.loseCommit = false; throw new Error('synthetic lost COMMIT response'); }
                    return result;
                } };
            } };
            const common = { clock: () => state.now, instanceId, historyBudget: { maxRecords: 4096, maxBytes: 67108864, maxDurationMs: 60000 },
                readExternalRuntimeEpoch: async () => ({ instanceId, restoreEpoch: state.externalEpoch }), newId: nextId };
            const maintenance = createPostgresDashboardMaintenanceRepository({ ...common, pool: owner, authoriseMaintenanceOperation: () => true });
            const maintenanceCommand = before => ({ operationId: nextId(), actorSubjectKey: actor,
                expectedRevision: before?.revision ?? null, expectedRecordSha256: before ? hash(before) : null, restoreEpoch,
                evidenceRef: 'synthetic-native-actions', evidenceSha256: 'e'.repeat(64) });
            const first = await maintenance.initializeRuntimeInstance(maintenanceCommand(null));
            await maintenance.enableRuntimeIngress(maintenanceCommand(first.record));
            const captureRequest = async req => req === request ? clone(capture) : null;
            const runtime = createPostgresDashboardRuntimeRepository({ ...common, pool, captureRequest,
                readVerifiedOnboardingProof: async () => null, readPreparedCaseCapability: async () => null,
                authoriseOperatorOperation: () => false, newGenerationToken: () => hash(nextId()) });
            await runtime.initializeOperatorSession(request, { operationId: nextId() });

            const f = clone(fixture()), tenantId = 'synthetic-actions-' + runKey + '-' + sequence;
            function replaceTenant(value) {
                if (!value || typeof value !== 'object') return;
                if (Object.hasOwn(value, 'tenantId')) value.tenantId = tenantId;
                Object.values(value).forEach(replaceTenant);
            }
            replaceTenant(f);
            for (const [action, payload, actorSubjectKey] of [
                ['invite', { invitationId: 'other-invitation', subjectKey: OTHER_SUBJECT, roles: ['viewer'], validFrom: START,
                    validUntil: END, grantEvidenceId: 'other-evidence', expiresAt: END }, SUBJECT],
                ['accept', { invitationId: 'other-invitation', membershipId: 'other-membership' }, OTHER_SUBJECT]
            ]) f.membershipState = applyMembershipCommand(f.membershipState, f.tenantAggregate, { ...f.scope,
                expectedRevision: f.membershipState.revision, actorSubjectKey, now: NOW, action, payload });
            const selector = { provider: 'legacy', subjectKey: SUBJECT, ...f.scope };
            const snapshot = { tenantAggregate: f.tenantAggregate, membershipState: f.membershipState,
                entitlementState: f.entitlementState, flags: f.flags, advisorAssignments: [], usage: f.entitlementState.grants.map(dataCodec.newUsage) };
            for (const [table, value] of [
                ['dashboard_tenants', snapshot.tenantAggregate.tenant], ['dashboard_organisations', snapshot.tenantAggregate.organisations[0]],
                ['dashboard_membership_states', snapshot.membershipState], ['dashboard_entitlement_states', snapshot.entitlementState],
                ['dashboard_feature_flags', snapshot.flags], ...snapshot.usage.map(value => ['dashboard_usage', value])
            ]) {
                const columns = ['tenant_id', ...(table === 'dashboard_tenants' ? [] : ['organisation_id']),
                    ...(table === 'dashboard_usage' ? ['grant_id'] : []), 'schema_version', 'revision', 'payload'];
                const values = [value.tenantId, ...(table === 'dashboard_tenants' ? [] : [value.organisationId]),
                    ...(table === 'dashboard_usage' ? [value.grantId] : []), 1, value.revision, JSON.stringify(value)];
                await owner.query(`INSERT INTO nofries.${table} (${columns.join(',')}) VALUES (${columns.map((_, i) => '$' + (i + 1)).join(',')})`, values);
            }
            const customerState = new Map();
            const accountActionState = { async writeState(value) { customerState.set(hash(value), clone(value)); return hash(value); },
                async readState(key) { return clone(customerState.get(key)); } };
            const options = { ...common, pool, captureRequest, accountActionState, authoriseAdministration: context => context.request === request,
                authoriseAccountAction: context => state.allowed && context.request === request && context.capture.kind === 'operator_dashboard' &&
                    (context.selector === null || hash(context.selector) === hash(selector) ||
                        state.allowOther && hash(context.selector) === hash({ ...selector, subjectKey: OTHER_SUBJECT }))
                    ? { authoritySha256: state.authoritySha256, listMembers: true } : null };
            const repository = createPostgresDashboardAdministrationRepository(options);
            const canonicalPool = { end: () => runtimePool.end(), async connect() {
                const client = await runtimePool.connect();
                return { release: value => client.release(value), async query(sql, params) {
                    const result = await client.query(sql, params);
                    if (sql === 'BEGIN') await client.query('SET LOCAL ROLE nofries_runtime');
                    return result;
                } };
            } };
            const canonical = createPostgresDashboardRepository({ database: createPostgresDatabase({ pool: canonicalPool }),
                clock: () => state.now, authoriseAdministration: () => true });
            const read = async () => (await repository.readAuthoritySnapshot(request, selector)).snapshot;
            const inspect = (selected = selector) => repository.inspectAccountAction(request, selected);
            const command = async (action, patch = null, selected = selector) => {
                const observed = await inspect(selected);
                const value = { schemaVersion: 1, operationId: nextId(), actorSubjectKey: actor, selector: clone(selected),
                    expectedVersion: observed.version, action, patch, preparedAt: state.now,
                    expiresAt: new Date(Date.parse(state.now) + 300000).toISOString(), witness: clone(observed.witness) };
                return { ...value, commandSha256: commandDigest(value) };
            };
            // Mutation evidence is compared separately from mandatory read-audit
            // receipts, so re-inspection cannot hide or manufacture a write.
            const receipts = async () => (await owner.query("SELECT operation_id,payload FROM nofries.dashboard_operation_receipts WHERE tenant_id=$1 AND organisation_id=$2 AND payload->>'operationType'<>'dashboard.admin.account_inspection' ORDER BY operation_id",
                [selector.tenantId, selector.organisationId])).rows;
            const inspectionAudits = async () => (await owner.query("SELECT payload FROM nofries.dashboard_operation_receipts WHERE tenant_id=$1 AND organisation_id=$2 AND payload->>'operationType'='dashboard.admin.account_inspection' ORDER BY operation_id",
                [selector.tenantId, selector.organisationId])).rows;
            const admission = subjectKey => canonical.readAdmissionSnapshot(f.scope, { authenticated: true, subjectKey });
            state.trace.length = 0;
            return { repository, options, runtime, request, selector, actor, identity, instanceId, restoreEpoch,
                common, pool, state, capture, snapshot, read, inspect, command, receipts, inspectionAudits, admission };
        }

        async function httpHarness() {
            const h = await harness(), tenant = h.identity.identityTenantId, clientId = h.identity.audience, oid = h.identity.oid;
            const env = { NOFRIES_REQUIRE_AUTH: 'true', NOFRIES_PUBLIC_URL: 'https://synthetic-actions.invalid',
                NOFRIES_ENTRA_TENANT_ID: tenant, NOFRIES_ENTRA_CLIENT_ID: clientId,
                NOFRIES_ENTRA_CLIENT_SECRET: 'synthetic-local-oidc-only', NOFRIES_ALLOWED_SUBJECTS: h.actor, NOFRIES_ADMIN_SUBJECTS: h.actor };
            const store = new MemoryBrowserSessionStore(), proofs = new Map(), blobs = new Map(), blobWrites = [];
            const proofStore = { async createOriginalProof(key, value) {
                if (proofs.has(key)) throw new Error('synthetic proof conflict'); proofs.set(key, clone(value));
            }, async readOriginalProof(key) { return proofs.has(key) ? clone(proofs.get(key)) : null; } };
            const clientApplication = { async getAuthCodeUrl(args) {
                const url = new URL('https://login.microsoftonline.com/' + tenant + '/oauth2/v2.0/authorize');
                for (const [key, value] of Object.entries({ client_id: clientId, redirect_uri: args.redirectUri,
                    response_mode: 'form_post', state: args.state, nonce: args.nonce,
                    code_challenge: args.codeChallenge, code_challenge_method: 'S256' })) url.searchParams.set(key, value);
                return url.href;
            }, async acquireTokenByCode(args) { return { idTokenClaims: { aud: clientId, tid: tenant, oid,
                iss: 'https://login.microsoftonline.com/' + tenant + '/v2.0', nonce: args.nonce,
                exp: Math.floor(Date.parse(h.state.now) / 1000) + 3600,
                name: 'Synthetic native operator', preferred_username: 'operator@example.invalid' },
            account: { localAccountId: oid, tenantId: tenant }, accessToken: 'synthetic-discarded-token', idToken: 'synthetic-discarded-id-token' }; },
            getTokenCache: () => ({ removeAccount: async () => {} }) };
            const browserAuthOptions = { env, store, clientApplication,
                cryptoProvider: { generatePkceCodes: async () => ({ verifier: 'v'.repeat(64), challenge: 'c'.repeat(43) }) } };
            const sessionOptions = { browserAuthOptions,
                identityPolicy: { policyId: 'synthetic-native-http-actions', policyRevision: 1,
                    issuer: 'https://login.microsoftonline.com/' + tenant + '/v2.0', identityTenantId: tenant, audience: clientId },
                proofStore, clock: h.common.clock, readExternalRuntimeEpoch: h.common.readExternalRuntimeEpoch,
                newRequestId: nextId, requestBudgetMs: 10000 };
            const issuer = createDashboardOperatorSession(sessionOptions);
            const browser = createBrowserAuthService({ ...browserAuthOptions, now: () => Date.parse(h.state.now) });
            const start = await browser.beginLogin({ returnTo: '/operator' });
            const login = await issuer.callbackService.completeLogin({ body: { code: 'synthetic-code',
                state: new URL(start.location).searchParams.get('state') }, cookieHeader: start.cookie.split(';')[0] });
            const cookie = login.cookie.split(';')[0];
            const nativeRequest = new IncomingMessage(new Socket()); nativeRequest.method = 'POST';
            nativeRequest.url = '/api/dashboard-admin/session'; nativeRequest.headers = { cookie };
            const native = createPostgresDashboardRuntimeRepository({ ...h.common, pool: h.pool,
                captureRequest: req => issuer.captureRequest(req), readVerifiedOnboardingProof: async () => null,
                readPreparedCaseCapability: async () => null, authoriseOperatorOperation: () => false, newGenerationToken: () => hash(nextId()) });
            await native.initializeOperatorSession(nativeRequest, { operationId: nextId() });
            const confirmationStore = new AzureAccountActionConfirmationStore({ getBlockBlobClient(key) {
                return { async uploadData(body, options) {
                    expect(options.conditions).toEqual({ ifNoneMatch: '*' });
                    if (blobs.has(key)) throw Object.assign(new Error('synthetic existing blob'), { statusCode: 412 });
                    blobs.set(key, Buffer.from(body)); blobWrites.push(key);
                }, async download() {
                    if (!blobs.has(key)) throw Object.assign(new Error('synthetic absent blob'), { statusCode: 404, code: 'BlobNotFound' });
                    const bytes = blobs.get(key); return { contentLength: bytes.length, readableStreamBody: Readable.from([bytes]) };
                } };
            } });
            const approvalState = { value: { schemaVersion: 1, bindingId: nextId(), revision: 1, status: 'active', purpose: 'account_support',
                operatorSubjectKey: h.actor, instanceId: h.instanceId, restoreEpoch: h.restoreEpoch, selector: clone(h.selector),
                actions: ['delete', 'edit', 'restore'], approvedAt: START, validFrom: START,
                validUntil: new Date(Date.parse(NOW) + 600000).toISOString(), approvalReference: 'synthetic-independent-action-approval',
                identityPolicy: { policyId: sessionOptions.identityPolicy.policyId, policyRevision: sessionOptions.identityPolicy.policyRevision },
                auditPolicy: { reference: 'synthetic-action-retention', revision: 1, agreementVersion: 'nf-dashboard-2026-09-r2',
                    retention: { unit: 'calendar_months', count: 13 } } } };
            const ports = createDashboardAdminAccountActionRuntime({ ...sessionOptions, pool: h.pool,
                instanceId: h.instanceId, historyBudget: h.common.historyBudget, newId: nextId,
                readApprovedActionBinding: async () => clone(approvalState.value), confirmationStore });
            const dashboard = { ...sessionOptions, pool: h.pool, instanceId: h.instanceId, historyBudget: h.common.historyBudget,
                newId: nextId, newGenerationToken: () => hash(nextId()), newOperationId: nextId };
            const app = createNoFriesApp({ dashboard, dashboardAdminAccountActions: ports });
            const post = (route, body, suppliedCookie = cookie) => requestHttp(app).post('/api/dashboard-admin/actions/' + route)
                .set('Cookie', suppliedCookie).set('Origin', env.NOFRIES_PUBLIC_URL).set('Sec-Fetch-Site', 'same-origin').send(body);
            return { ...h, app, cookie, post, env, store, proofs, blobs, blobWrites, approvalState, native, nativeRequest };
        }

        test('restricted login preserves forced RLS and immutable operation evidence', async () => {
            const rows = await owner.query(`SELECT relrowsecurity,relforcerowsecurity,
                has_table_privilege('nofries_runtime',oid,'UPDATE') AS can_update,
                has_table_privilege('nofries_runtime',oid,'DELETE') AS can_delete
                FROM pg_class WHERE oid='nofries.dashboard_operation_receipts'::regclass`);
            expect(rows.rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true, can_update: false, can_delete: false }]);
            const client = await runtimePool.connect();
            try { await expect(client.query('SELECT * FROM nofries.dashboard_membership_states')).rejects.toHaveProperty('code', '42501'); }
            finally { client.release(); }
        });

        test('soft deletion denies every member, retains data, replays once and recovers with original grants', async () => {
            const h = await harness(), before = await h.read(), command = await h.command('archive');
            const result = await h.repository.commitAccountAction(h.request, command);
            expect(result.status).toBe('succeeded');
            await expect(h.admission(SUBJECT)).rejects.toHaveProperty('statusCode');
            await expect(h.admission(OTHER_SUBJECT)).rejects.toHaveProperty('statusCode');
            const removed = await h.read();
            expect(removed.tenantAggregate.organisations[0].recordStatus).toBe('suspended');
            expect(removed.membershipState).toEqual(before.membershipState);
            expect(removed.entitlementState).toEqual(before.entitlementState);
            expect(await h.repository.commitAccountAction(h.request, command)).toEqual(result);
            expect((await h.inspect()).actions).toContain('unarchive');
            await h.repository.commitAccountAction(h.request, await h.command('unarchive'));
            await expect(h.admission(SUBJECT)).resolves.toHaveProperty('membershipState');
            await expect(h.admission(OTHER_SUBJECT)).resolves.toHaveProperty('membershipState');
            expect((await h.read()).membershipState).toEqual(before.membershipState);
            const events = (await h.receipts()).filter(r => r.payload.operationType === 'dashboard.admin.organisation_deletion');
            expect(events).toHaveLength(2);
            expect(JSON.stringify(events)).not.toContain(before.tenantAggregate.organisations[0].displayName);
        }, 15000);

        test('inspection durably audits disclosure, offers available actions and keeps reset unavailable', async () => {
            const h = await harness(), result = await h.inspect();
            expect(result.selector).toEqual(h.selector);
            expect(result.actions).toContain('delete');
            expect(result.actions).toContain('edit'); expect(result.actions).not.toContain('reset'); expect(result.actions).not.toContain('restore');
            expect(result.displayLabel).toBeNull();
            expect(result.members.map(m => m.subjectKey).sort()).toEqual([SUBJECT, OTHER_SUBJECT].sort());
            expect(h.state.trace.filter(({ sql }) => WRITES.test(sql))).toHaveLength(1);
            expect(h.state.trace.filter(({ sql }) => WRITES.test(sql))[0].sql).toMatch(/^INSERT INTO nofries\.dashboard_operation_receipts/);
            const audits = await h.inspectionAudits(); expect(audits).toHaveLength(1);
            expect(JSON.stringify(audits)).not.toContain(result.displayName);
            expect(JSON.stringify(audits)).not.toContain('synthetic-membership');
            expect(await h.receipts()).toEqual([]);
        });

        test('inspection fails closed when its durable disclosure audit cannot be inserted', async () => {
            const h = await harness();
            h.state.before = async sql => { if (/^INSERT INTO nofries\.dashboard_operation_receipts\b/.test(sql)) throw new Error('synthetic audit storage failure'); };
            await expect(h.inspect()).rejects.toHaveProperty('statusCode');
            h.state.before = null;
            expect(await h.inspectionAudits()).toEqual([]); expect(await h.receipts()).toEqual([]);
        });

        test('staff label edit persists across repository recreation without changing canonical identity or authority', async () => {
            const h = await harness(), before = await h.read();
            const command = await h.command('edit', { displayLabel: 'Synthetic staff review label' });
            const result = await h.repository.commitAccountAction(h.request, command);
            expect(result).toMatchObject({ status: 'succeeded', operationId: command.operationId });
            const reopened = createPostgresDashboardAdministrationRepository(h.options);
            const observed = await reopened.inspectAccountAction(h.request, h.selector);
            expect(observed.displayLabel).toBe('Synthetic staff review label');
            expect(observed.displayName).toBe(before.tenantAggregate.organisations[0].displayName);
            expect(await h.read()).toEqual(before);
            const receipts = await h.receipts(); h.state.trace.length = 0;
            expect(JSON.stringify(receipts)).not.toContain('Synthetic staff review label');
            await expect(reopened.commitAccountAction(h.request, command)).resolves.toEqual(result);
            expect(h.state.trace.some(({ sql }) => WRITES.test(sql))).toBe(false);
            expect(await h.receipts()).toEqual(receipts);
        });

        test('label edits reject a stale confirmation and preserve previous immutable receipts', async () => {
            const h = await harness(), first = await h.command('edit', { displayLabel: 'First label' });
            const stale = await h.command('edit', { displayLabel: 'Stale label' });
            await h.repository.commitAccountAction(h.request, first);
            const before = await h.receipts();
            await expect(h.repository.commitAccountAction(h.request, stale)).rejects.toHaveProperty('statusCode');
            expect(await h.receipts()).toEqual(before);
            await h.repository.commitAccountAction(h.request, await h.command('edit', { displayLabel: 'Second label' }));
            expect((await h.inspect()).displayLabel).toBe('Second label');
            const after = await h.receipts();
            for (const retained of before) expect(after).toContainEqual(retained);
        });

        test('delete persists only the selected membership suspension and immediately denies its admission', async () => {
            const h = await harness(), before = await h.read(), command = await h.command('delete');
            await expect(h.admission(SUBJECT)).resolves.toHaveProperty('membershipState');
            const result = await h.repository.commitAccountAction(h.request, command);
            expect(result).toMatchObject({ status: 'succeeded', operationId: command.operationId, commandSha256: command.commandSha256 });
            const after = await h.read();
            expect(after.membershipState.revision).toBe(before.membershipState.revision + 1);
            expect(after.membershipState.memberships.find(row => row.subjectKey === SUBJECT).status).toBe('suspended');
            expect(after.membershipState.memberships.find(row => row.subjectKey === OTHER_SUBJECT))
                .toEqual(before.membershipState.memberships.find(row => row.subjectKey === OTHER_SUBJECT));
            expect(after.membershipState.invitations).toEqual(before.membershipState.invitations);
            for (const key of ['tenantAggregate', 'entitlementState', 'flags', 'advisorAssignments', 'usage']) expect(after[key]).toEqual(before[key]);
            await expect(h.admission(SUBJECT)).rejects.toHaveProperty('statusCode');
            await expect(h.admission(OTHER_SUBJECT)).resolves.toHaveProperty('membershipState');
            expect((await h.receipts()).length).toBeGreaterThanOrEqual(2);
        });

        test('restore after repository recreation preserves grant bounds, membership IDs and original entitlements', async () => {
            const h = await harness(), original = await h.read();
            await h.repository.commitAccountAction(h.request, await h.command('delete'));
            const reloaded = createPostgresDashboardAdministrationRepository(h.options);
            expect((await reloaded.inspectAccountAction(h.request, h.selector)).actions).toContain('restore');
            const command = await h.command('restore');
            await expect(reloaded.commitAccountAction(h.request, command)).resolves.toMatchObject({ status: 'succeeded' });
            const restored = await h.read(), membership = restored.membershipState.memberships.find(row => row.subjectKey === SUBJECT);
            const before = original.membershipState.memberships.find(row => row.subjectKey === SUBJECT);
            for (const key of Object.keys(before).filter(key => !['updatedAt', 'updatedBy'].includes(key))) expect(membership[key]).toEqual(before[key]);
            expect(restored.entitlementState).toEqual(original.entitlementState);
            expect(restored.usage).toEqual(original.usage);
            await expect(h.admission(SUBJECT)).resolves.toHaveProperty('membershipState');
        });

        test('unrelated member removals do not erase recovery while stale confirmations still fail', async () => {
            const h = await harness(), other = { ...h.selector, subjectKey: OTHER_SUBJECT };
            h.state.allowOther = true;
            await h.repository.commitAccountAction(h.request, await h.command('delete'));
            const staleRestore = await h.command('restore');
            await h.repository.commitAccountAction(h.request, await h.command('delete', null, other));
            await expect(h.repository.commitAccountAction(h.request, staleRestore)).rejects.toHaveProperty('statusCode');
            expect((await h.inspect()).actions).toContain('restore');
            await h.repository.commitAccountAction(h.request, await h.command('restore'));
            expect((await h.read()).membershipState.memberships.find(row => row.subjectKey === OTHER_SUBJECT).status).toBe('suspended');
            expect((await h.inspect(other)).actions).toContain('restore');
            await h.repository.commitAccountAction(h.request, await h.command('restore', null, other));
            expect((await h.read()).membershipState.memberships.filter(row => [SUBJECT, OTHER_SUBJECT].includes(row.subjectKey))
                .every(row => row.status === 'active')).toBe(true);
        });

        test.each(['admin', 'native'])('missing intervening %s receipt prevents recovery', async missing => {
            const h = await harness(), other = { ...h.selector, subjectKey: OTHER_SUBJECT };
            h.state.allowOther = true;
            await h.repository.commitAccountAction(h.request, await h.command('delete'));
            const otherDelete = await h.command('delete', null, other);
            await h.repository.commitAccountAction(h.request, otherDelete);
            const prefix = missing === 'admin' ? 'admin-account-action:' : 'admin-membership:';
            await owner.query('DELETE FROM nofries.dashboard_operation_receipts WHERE tenant_id=$1 AND organisation_id=$2 AND operation_id=$3',
                [h.selector.tenantId, h.selector.organisationId, prefix + otherDelete.operationId]);
            expect((await h.inspect()).actions).not.toContain('restore');
        });

        test('corrupt intervening native receipt fails closed', async () => {
            const h = await harness(), other = { ...h.selector, subjectKey: OTHER_SUBJECT };
            h.state.allowOther = true;
            await h.repository.commitAccountAction(h.request, await h.command('delete'));
            const otherDelete = await h.command('delete', null, other);
            await h.repository.commitAccountAction(h.request, otherDelete);
            await owner.query('UPDATE nofries.dashboard_operation_receipts SET result_sha256=$4 WHERE tenant_id=$1 AND organisation_id=$2 AND operation_id=$3',
                [h.selector.tenantId, h.selector.organisationId, 'admin-membership:' + otherDelete.operationId, 'f'.repeat(64)]);
            await expect(h.inspect()).rejects.toHaveProperty('statusCode');
        });

        test('same-member out-of-band changes never reuse an old delete receipt even when bytes match', async () => {
            const h = await harness(), other = { ...h.selector, subjectKey: OTHER_SUBJECT };
            h.state.allowOther = true;
            await h.repository.commitAccountAction(h.request, await h.command('delete'));
            const original = await h.read(), priorMember = original.membershipState.memberships.find(row => row.subjectKey === SUBJECT);
            let changed = original.membershipState;
            for (const action of ['resume', 'suspend']) changed = applyMembershipCommand(changed, original.tenantAggregate, {
                tenantId: h.selector.tenantId, organisationId: h.selector.organisationId, expectedRevision: changed.revision,
                actorSubjectKey: h.actor, now: NOW, action, payload: { membershipId: priorMember.membershipId } });
            expect(changed.memberships.find(row => row.subjectKey === SUBJECT)).toEqual(priorMember);
            await owner.query('UPDATE nofries.dashboard_membership_states SET revision=$3,payload=$4::jsonb WHERE tenant_id=$1 AND organisation_id=$2',
                [h.selector.tenantId, h.selector.organisationId, changed.revision, JSON.stringify(changed)]);
            await h.repository.commitAccountAction(h.request, await h.command('delete', null, other));
            expect((await h.inspect()).actions).not.toContain('restore');
        });

        test('exact repeat returns its retained receipt without repeating the canonical mutation', async () => {
            const h = await harness(), command = await h.command('delete');
            const first = await h.repository.commitAccountAction(h.request, command), snapshot = await h.read(), receipts = await h.receipts();
            h.state.trace.length = 0;
            await expect(h.repository.commitAccountAction(h.request, command)).resolves.toEqual(first);
            expect(h.state.trace.some(({ sql }) => WRITES.test(sql))).toBe(false);
            expect(await h.read()).toEqual(snapshot); expect(await h.receipts()).toEqual(receipts);
        });

        test('repeating an old delete after restore cannot suspend the account again', async () => {
            const h = await harness(), deletion = await h.command('delete');
            const deleted = await h.repository.commitAccountAction(h.request, deletion);
            const restoration = await h.command('restore');
            const restored = await h.repository.commitAccountAction(h.request, restoration);
            const snapshot = await h.read(), receipts = await h.receipts(); h.state.trace.length = 0;
            await expect(h.repository.commitAccountAction(h.request, deletion)).resolves.toEqual(deleted);
            await expect(h.repository.commitAccountAction(h.request, restoration)).resolves.toEqual(restored);
            expect(h.state.trace.some(({ sql }) => WRITES.test(sql))).toBe(false);
            expect(await h.read()).toEqual(snapshot); expect(await h.receipts()).toEqual(receipts);
            await expect(h.admission(SUBJECT)).resolves.toHaveProperty('membershipState');
        });

        test('a staff label edited during suspension survives restore without changing grant evidence', async () => {
            const h = await harness(), original = await h.read();
            await h.repository.commitAccountAction(h.request, await h.command('delete'));
            await h.repository.commitAccountAction(h.request, await h.command('edit', { displayLabel: 'Awaiting access review' }));
            expect((await h.inspect()).actions).toContain('restore');
            await h.repository.commitAccountAction(h.request, await h.command('restore'));
            expect((await h.inspect()).displayLabel).toBe('Awaiting access review');
            const restored = await h.read();
            expect(restored.entitlementState).toEqual(original.entitlementState);
            expect(restored.membershipState.invitations).toEqual(original.membershipState.invitations);
        });

        test('simultaneous exact confirmations retain one action and one membership mutation', async () => {
            const h = await harness(), original = await h.read(), command = await h.command('delete');
            const results = await Promise.allSettled([h.repository.commitAccountAction(h.request, command),
                h.repository.commitAccountAction(h.request, command)]);
            const succeeded = results.filter(result => result.status === 'fulfilled');
            expect(succeeded.length).toBeGreaterThanOrEqual(1);
            for (const result of results.filter(result => result.status === 'rejected')) expect(result.reason).toHaveProperty('statusCode');
            for (const result of succeeded) expect(result.value).toEqual(succeeded[0].value);
            expect((await h.read()).membershipState.revision).toBe(original.membershipState.revision + 1);
            const receipts = await h.receipts();
            expect(receipts.filter(row => row.operation_id === 'admin-account-action:' + command.operationId)).toHaveLength(1);
            expect(receipts.filter(row => row.operation_id === 'admin-membership:' + command.operationId)).toHaveLength(1);
            await expect(h.repository.accountActionOutcome(h.request, command)).resolves.toEqual(succeeded[0].value);
        });

        test('outcome waits behind an in-flight canonical write and then observes its committed receipt', async () => {
            const h = await harness(), command = await h.command('delete'), entered = deferred(), release = deferred();
            let commit, outcome;
            h.state.after = async sql => {
                if (/^UPDATE nofries\.dashboard_membership_states\b/.test(sql)) { entered.resolve(); await release.promise; }
            };
            try {
                commit = h.repository.commitAccountAction(h.request, command);
                await entered.promise;
                outcome = h.repository.accountActionOutcome(h.request, command);
                let blocked = false;
                for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
                    const rows = await owner.query("SELECT pid FROM pg_stat_activity WHERE datname=$1 AND cardinality(pg_blocking_pids(pid))>0 AND query LIKE 'SELECT * FROM nofries.dashboard_tenants%'", [databaseName]);
                    blocked = rows.rows.length > 0;
                    if (!blocked) await new Promise(resolve => setTimeout(resolve, 10));
                }
                expect(blocked).toBe(true);
                release.resolve();
                const [saved, checked] = await Promise.all([commit, outcome]);
                expect(checked).toEqual(saved); expect(saved.status).toBe('succeeded');
            } finally {
                release.resolve(); h.state.after = null;
                await Promise.allSettled([commit, outcome].filter(Boolean));
            }
        }, 15000);

        test('lost COMMIT response is recovered from persisted evidence without another data write', async () => {
            const h = await harness(), command = await h.command('delete'); h.state.loseCommit = true;
            await expect(h.repository.commitAccountAction(h.request, command)).rejects.toMatchObject({ statusCode: 503 });
            const retained = await h.receipts();
            expect(retained.length).toBeGreaterThanOrEqual(2);
            h.state.trace.length = 0;
            const reopened = createPostgresDashboardAdministrationRepository(h.options);
            await expect(reopened.accountActionOutcome(h.request, command)).resolves.toMatchObject({ status: 'succeeded', operationId: command.operationId });
            expect(h.state.trace.some(({ sql }) => WRITES.test(sql))).toBe(false);
            expect(await h.receipts()).toEqual(retained);
            expect((await h.read()).membershipState.memberships.find(row => row.subjectKey === SUBJECT).status).toBe('suspended');
        });

        test('failed receipt write rolls back canonical change; an exact retry can commit once', async () => {
            const h = await harness(), original = await h.read(), command = await h.command('delete');
            h.state.before = async sql => { if (/^INSERT INTO nofries\.dashboard_operation_receipts\b/.test(sql)) throw new Error('synthetic receipt storage failure'); };
            await expect(h.repository.commitAccountAction(h.request, command)).rejects.toHaveProperty('statusCode');
            h.state.before = null;
            expect(await h.read()).toEqual(original); expect(await h.receipts()).toEqual([]);
            await expect(h.repository.commitAccountAction(h.request, command)).resolves.toMatchObject({ status: 'succeeded' });
            expect((await h.read()).membershipState.revision).toBe(original.membershipState.revision + 1);
        });

        test.each(['session', 'policy', 'policy-replacement', 'epoch', 'expiry'])('current %s revocation denies commit and receipt recovery without data changes', async reason => {
            const h = await harness(), command = await h.command('delete'), original = await h.read();
            if (reason === 'session') await h.runtime.revokeSession(h.request, { operationId: nextId() });
            if (reason === 'policy') h.state.allowed = false;
            if (reason === 'policy-replacement') h.state.authoritySha256 = 'b'.repeat(64);
            if (reason === 'epoch') h.state.externalEpoch = nextId();
            if (reason === 'expiry') h.state.now = command.expiresAt;
            h.state.trace.length = 0;
            await expect(h.repository.commitAccountAction(h.request, command)).rejects.toHaveProperty('statusCode');
            await expect(h.repository.accountActionOutcome(h.request, command)).rejects.toHaveProperty('statusCode');
            expect(h.state.trace.some(({ sql }) => WRITES.test(sql))).toBe(false);
            const persisted = (await owner.query('SELECT payload FROM nofries.dashboard_membership_states WHERE tenant_id=$1 AND organisation_id=$2',
                [h.selector.tenantId, h.selector.organisationId])).rows[0].payload;
            expect(persisted).toEqual(original.membershipState); expect(await h.receipts()).toEqual([]);
        });

        test('policy revoked after provisional membership UPDATE rolls back all canonical and receipt writes', async () => {
            const h = await harness(), original = await h.read(), command = await h.command('delete');
            h.state.after = async sql => { if (/^UPDATE nofries\.dashboard_membership_states\b/.test(sql)) h.state.allowed = false; };
            await expect(h.repository.commitAccountAction(h.request, command)).rejects.toHaveProperty('statusCode');
            h.state.after = null; h.state.allowed = true;
            expect(await h.read()).toEqual(original); expect(await h.receipts()).toEqual([]);
        });

        test('policy replacement after provisional write rolls back even when the replacement still grants the action', async () => {
            const h = await harness(), original = await h.read(), command = await h.command('delete');
            h.state.after = async sql => { if (/^UPDATE nofries\.dashboard_membership_states\b/.test(sql)) h.state.authoritySha256 = 'c'.repeat(64); };
            await expect(h.repository.commitAccountAction(h.request, command)).rejects.toHaveProperty('statusCode');
            h.state.after = null;
            expect(await h.read()).toEqual(original); expect(await h.receipts()).toEqual([]);
        });

        test('revocation after COMMIT withholds acknowledgement and recovery without duplicating the retained mutation', async () => {
            const h = await harness(), command = await h.command('delete');
            h.state.after = async sql => { if (sql === 'COMMIT') h.state.allowed = false; };
            await expect(h.repository.commitAccountAction(h.request, command)).rejects.toHaveProperty('statusCode');
            h.state.after = null;
            const receipts = await h.receipts(); expect(receipts.length).toBeGreaterThanOrEqual(2);
            h.state.trace.length = 0;
            await expect(h.repository.accountActionOutcome(h.request, command)).rejects.toHaveProperty('statusCode');
            expect(h.state.trace.some(({ sql }) => WRITES.test(sql))).toBe(false); expect(await h.receipts()).toEqual(receipts);
            h.state.allowed = true;
            await expect(h.repository.accountActionOutcome(h.request, command)).resolves.toMatchObject({ status: 'succeeded' });
            expect(await h.receipts()).toEqual(receipts);
        });

        test('an operator cannot suspend their own exact membership', async () => {
            const h = await harness({ self: true }), original = await h.read();
            expect((await h.inspect()).actions).not.toContain('delete');
            await expect(h.repository.commitAccountAction(h.request, await h.command('delete'))).rejects.toHaveProperty('statusCode');
            expect(await h.read()).toEqual(original); expect(await h.receipts()).toEqual([]);
        });

        test.each(['selector', 'actor', 'version', 'operation'])('tampered %s cannot replay a retained operation', async mode => {
            const h = await harness(), command = await h.command('delete');
            await h.repository.commitAccountAction(h.request, command);
            const snapshot = await h.read(), receipts = await h.receipts(), changed = clone(command);
            if (mode === 'selector') changed.selector.subjectKey = OTHER_SUBJECT;
            if (mode === 'actor') changed.actorSubjectKey = SUBJECT;
            if (mode === 'version') changed.expectedVersion = 'f'.repeat(64);
            if (mode === 'operation') changed.action = 'restore';
            changed.commandSha256 = commandDigest(changed);
            await expect(h.repository.commitAccountAction(h.request, changed)).rejects.toHaveProperty('statusCode');
            expect(await h.read()).toEqual(snapshot); expect(await h.receipts()).toEqual(receipts);
        });

        test('a second stale confirmation cannot produce another suspension receipt', async () => {
            const h = await harness(), first = await h.command('delete'), stale = await h.command('delete');
            await h.repository.commitAccountAction(h.request, first);
            const receipts = await h.receipts();
            await expect(h.repository.commitAccountAction(h.request, stale)).rejects.toHaveProperty('statusCode');
            expect(await h.receipts()).toEqual(receipts);
        });

        test('restore is not offered for a suspension outside the retained admin delete flow', async () => {
            const h = await harness(), original = await h.read();
            const suspended = applyMembershipCommand(original.membershipState, original.tenantAggregate, {
                tenantId: h.selector.tenantId, organisationId: h.selector.organisationId,
                expectedRevision: original.membershipState.revision, actorSubjectKey: h.actor, now: NOW,
                action: 'suspend', payload: { membershipId: 'synthetic-membership' } });
            await owner.query('UPDATE nofries.dashboard_membership_states SET revision=$3,payload=$4::jsonb WHERE tenant_id=$1 AND organisation_id=$2',
                [h.selector.tenantId, h.selector.organisationId, suspended.revision, JSON.stringify(suspended)]);
            expect((await h.inspect()).actions).not.toContain('restore');
            await expect(h.repository.commitAccountAction(h.request, await h.command('restore'))).rejects.toHaveProperty('statusCode');
            expect((await h.read()).membershipState).toEqual(suspended); expect(await h.receipts()).toEqual([]);
        });

        test('reset remains unavailable and writes no canonical state or evidence', async () => {
            const h = await harness(), original = await h.read(), command = await h.command('reset');
            h.state.trace.length = 0;
            await expect(h.repository.commitAccountAction(h.request, command)).rejects.toHaveProperty('statusCode');
            expect(h.state.trace.some(({ sql }) => WRITES.test(sql))).toBe(false);
            expect(await h.read()).toEqual(original); expect(await h.receipts()).toEqual([]);
        });

        test('receipt check before commit returns no committed evidence and never executes the action', async () => {
            const h = await harness(), original = await h.read(), command = await h.command('delete');
            h.state.trace.length = 0;
            await expect(h.repository.accountActionOutcome(h.request, command)).resolves.toBeNull();
            expect(h.state.trace.some(({ sql }) => WRITES.test(sql))).toBe(false);
            expect(await h.read()).toEqual(original); expect(await h.receipts()).toEqual([]);
        });

        test('actual Express + genuine BFF proof + native runtime performs label/delete/restore and repeats only retained outcomes', async () => {
            const h = await httpHarness(), original = await h.read();
            const capabilities = await requestHttp(h.app).get('/api/dashboard-admin/capabilities').set('Cookie', h.cookie);
            expect(capabilities.status).toBe(200); expect(capabilities.body.accountActions).toBe(true);
            expect(capabilities.body.lookup).toBe(false);
            const inspect = await h.post('inspect', h.selector);
            expect(inspect.status).toBe(200); expect(inspect.body.witness).toBeUndefined();
            const prepare = async (action, patch = null) => {
                const response = await h.post('prepare', { selector: h.selector, action, patch, ...(action === 'delete' ? { confirmationName: inspect.body.displayName } : {}) });
                expect(response.status).toBe(200);
                return { confirmationToken: response.body.confirmationToken };
            };
            const label = await prepare('edit', { displayLabel: 'Layered native support label' });
            expect(await h.receipts()).toEqual([]); expect(h.blobWrites).toHaveLength(1);
            const edited = await h.post('execute', label); expect(edited.status).toBe(200); expect(edited.body.status).toBe('succeeded');
            expect((await h.post('execute', label)).body).toEqual(edited.body);
            expect((await h.post('outcome', label)).body).toEqual(edited.body);
            expect(await h.read()).toEqual(original);
            const deletion = await prepare('delete'), deleted = await h.post('execute', deletion);
            expect(deleted.status).toBe(200); expect(deleted.body.status).toBe('succeeded');
            await expect(h.admission(SUBJECT)).rejects.toHaveProperty('statusCode');
            const restoration = await prepare('restore'), restored = await h.post('execute', restoration);
            expect(restored.status).toBe(200); expect(restored.body.status).toBe('succeeded');
            await expect(h.admission(SUBJECT)).resolves.toHaveProperty('membershipState');
            const receipts = await h.receipts();
            expect((await h.post('execute', deletion)).body).toEqual(deleted.body);
            expect(await h.receipts()).toEqual(receipts);
            const observed = await h.post('inspect', h.selector);
            expect(observed.body.displayLabel).toBe('Layered native support label');
            expect(observed.body.displayName).toBe(original.tenantAggregate.organisations[0].displayName);
            expect((await h.read()).entitlementState).toEqual(original.entitlementState);
            expect(h.proofs.size).toBe(1); expect(h.blobWrites).toHaveLength(6);
            expect(JSON.stringify(receipts)).not.toContain('Layered native support label');
            for (const response of [inspect, edited, deleted, restored]) {
                expect(response.headers['cache-control']).toBe('private, no-store, max-age=0');
                expect(response.text).not.toMatch(/synthetic-local-oidc-only|authoritySha256|expectedRevisions|restoreReceipt/);
            }
        }, 30000);

        test('layered HTTP refuses customer cookies and absent independent action approval before mutations', async () => {
            const h = await httpHarness(), original = await h.read();
            const customerCookie = h.cookie.replace('__Host-nofries-auth=', '__Host-nofries-customer=');
            expect((await h.post('inspect', h.selector, customerCookie)).status).toBe(401);
            h.approvalState.value = null;
            expect((await h.post('prepare', { selector: h.selector, action: 'delete', patch: null, confirmationName: (await h.read()).tenantAggregate.organisations[0].displayName })).status).toBe(403);
            expect(h.blobWrites).toEqual([]); expect(await h.receipts()).toEqual([]); expect(await h.read()).toEqual(original);
        }, 15000);

        test('layered HTTP rejects a changed action approval after confirmation was retained', async () => {
            const h = await httpHarness(), original = await h.read();
            const prepared = await h.post('prepare', { selector: h.selector, action: 'delete', patch: null, confirmationName: (await h.read()).tenantAggregate.organisations[0].displayName });
            expect(prepared.status).toBe(200);
            h.approvalState.value.revision++;
            const token = { confirmationToken: prepared.body.confirmationToken };
            expect((await h.post('execute', token)).status).toBe(403);
            expect((await h.post('outcome', token)).status).toBe(403);
            expect(await h.receipts()).toEqual([]); expect(await h.read()).toEqual(original);
        }, 15000);

        test('layered HTTP denies a revoked native operator gate despite its valid BFF cookie and original proof', async () => {
            const h = await httpHarness();
            await h.native.revokeSession(h.nativeRequest, { operationId: nextId() });
            const response = await h.post('prepare', { selector: h.selector, action: 'delete', patch: null, confirmationName: (await h.read()).tenantAggregate.organisations[0].displayName });
            expect(response.status).toBe(403); expect(h.blobWrites).toEqual([]); expect(await h.receipts()).toEqual([]);
        }, 15000);

        test('layered HTTP proves an expired absent confirmation did not start and refuses later dispatch', async () => {
            const h = await httpHarness(), original = await h.read();
            const prepared = await h.post('prepare', { selector: h.selector, action: 'delete', patch: null, confirmationName: (await h.read()).tenantAggregate.organisations[0].displayName });
            expect(prepared.status).toBe(200);
            h.state.now = prepared.body.expiresAt;
            const token = { confirmationToken: prepared.body.confirmationToken }, outcome = await h.post('outcome', token);
            expect(outcome.status).toBe(200); expect(outcome.body.status).toBe('not_started_expired');
            expect((await h.post('execute', token)).status).toBe(409);
            expect(await h.receipts()).toEqual([]);
            const persisted = (await owner.query('SELECT payload FROM nofries.dashboard_membership_states WHERE tenant_id=$1 AND organisation_id=$2',
                [h.selector.tenantId, h.selector.organisationId])).rows[0].payload;
            expect(persisted).toEqual(original.membershipState);
        }, 15000);

        test('layered HTTP reconciles a lost native COMMIT using retained Azure confirmation bytes and one persisted action', async () => {
            const h = await httpHarness();
            const prepared = await h.post('prepare', { selector: h.selector, action: 'delete', patch: null, confirmationName: (await h.read()).tenantAggregate.organisations[0].displayName });
            expect(prepared.status).toBe(200);
            const token = { confirmationToken: prepared.body.confirmationToken };
            h.state.after = async (sql, params) => {
                if (/^INSERT INTO nofries\.dashboard_operation_receipts\b/.test(sql) && String(params[2]).startsWith('admin-account-action:')) h.state.loseCommit = true;
            };
            expect((await h.post('execute', token)).status).toBe(503);
            h.state.after = null;
            const receipts = await h.receipts(); expect(receipts).toHaveLength(2);
            const recovered = await h.post('outcome', token);
            expect(recovered.status).toBe(200); expect(recovered.body.status).toBe('succeeded');
            expect((await h.post('execute', token)).body).toEqual(recovered.body);
            expect(await h.receipts()).toEqual(receipts); expect(h.blobWrites).toHaveLength(2);
        }, 15000);
    });
};
