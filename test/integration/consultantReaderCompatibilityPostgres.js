'use strict';

// Prospective writer/native recovery qualification includes a private production
// schema verifier. Run that mode in its private checkout, before any DB creation.
if (process.env.NOFRIES_COMPAT_WRITER_ROOT) {
    throw new Error('consultant_native_writer_qualification_requires_private_controller_checkout');
}

// Synthetic recovery qualification. The writer is an explicitly selected,
// immutable external checkout; the reader is this checkout's actual factory.
// Raw retained fixtures let the ordinary source gate run without that checkout.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const request = require('supertest');
const { customerProductionHarness } = require('../helpers/customerProductionHarness');
const { createProductionApplication } = require('../../lib/productionApplication');
const readerFactory = process.env.NOFRIES_COMPAT_READER_ROOT
    ? require(path.join(path.resolve(process.env.NOFRIES_COMPAT_READER_ROOT), 'lib/productionApplication')).createProductionApplication
    : createProductionApplication;
const fixtureRoot = path.resolve(__dirname, '../fixtures/consultantReader');
const WRITER_SHA = '8c09c32a6df6d70da87376db25e59c4f31dce48c';
const FIXTURE_TIME = Date.parse('2027-01-24T00:00:00.000Z');
const details = { name: 'Synthetic Representative', role: 'Owner', address: 'Synthetic address',
    registrationId: '', authorityConfirmed: true };
const id = () => crypto.randomUUID();
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const post = (h, route, cookie, body, csrfToken) => h.sameOrigin(request(h.app).post(route))
    .set('Cookie', cookie).set('X-CSRF-Token', csrfToken || '').send(body);
const lifecycleBlob = key => /^(customer-starter\/|customer-subjects\/|customer-schedules\/|customer-terms\/|customer-term-offers\/|customer-signup-recoveries\/|browser-auth\/customer-signup\/invitations\/)/.test(key);

// Count BEFORE delegating, including rejected conditional writes and writes
// later rolled back. State equality by itself cannot establish this property.
function effects() {
    const control = { armed: false, attempts: [], reads: [], pages: [], allowedAudit: [] };
    control.mutation = event => {
        if (!control.armed) return;
        control.attempts.push(event);
        throw new Error('Synthetic reader lifecycle mutation attempt: ' + JSON.stringify(event));
    };
    control.sdk = ({ dependencies }) => {
        const Base = dependencies.BlobServiceClient, decorated = new WeakMap();
        dependencies.BlobServiceClient = class extends Base {
            getContainerClient(name) {
                const container = super.getContainerClient(name);
                if (decorated.has(container)) return decorated.get(container);
                const value = Object.create(container);
                value.getBlockBlobClient = key => {
                    const blob = container.getBlockBlobClient(key), wrapped = Object.create(blob);
                    for (const method of ['uploadData', 'delete', 'deleteIfExists']) wrapped[method] = async (...args) => {
                        if (lifecycleBlob(key)) control.mutation({ storage: 'blob', container: name, key, method });
                        if (control.beforeBlob) await control.beforeBlob({ container: name, key, method, args });
                        return blob[method](...args);
                    };
                    wrapped.download = async (...args) => {
                        if (control.armed) control.reads.push({ container: name, key, offset: args[0], count: args[1] });
                        const response = await blob.download(...args);
                        if (control.afterRead) await control.afterRead({ container: name, key });
                        return response;
                    };
                    return wrapped;
                };
                // SDK-only stand-in. Each iterator returns ONE finite page,
                // preserving the production Azure .byPage continuation contract.
                value.listBlobsFlat = options => ({ byPage({ continuationToken, maxPageSize }) {
                    assert.ok(Number.isSafeInteger(maxPageSize) && maxPageSize > 0 && maxPageSize <= 50);
                    const keys = [...container.records.keys()].filter(key => key.startsWith(options.prefix)).sort();
                    const offset = continuationToken ? Number(continuationToken) : 0;
                    assert.ok(Number.isSafeInteger(offset) && offset >= 0);
                    const selected = keys.slice(offset, offset + maxPageSize);
                    control.pages.push({ prefix: options.prefix, maxPageSize, offset, returned: selected.length });
                    return (async function* () { yield { segment: { blobItems: selected.map(name => ({ name })) },
                        continuationToken: offset + selected.length < keys.length ? String(offset + selected.length) : undefined }; })();
                } });
                decorated.set(container, value); return value;
            }
        };
    };
    control.pool = pool => ({ async end() {}, async connect() {
        const client = await pool.connect();
        return { release: (...args) => client.release(...args), async query(sql, params = []) {
            const text = typeof sql === 'string' ? sql : sql.text;
            if (control.armed && /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|MERGE\s+INTO|TRUNCATE|ALTER|CREATE|DROP)\s+(?:TABLE\s+)?nofries\./i.test(text)) {
                // Read audits are a required existing effect. Validate their
                // event, rather than exempting the audit table wholesale.
                const payload = params.map(value => { try { return typeof value === 'string' ? JSON.parse(value) : null; } catch { return null; } })
                    .find(value => value && value.eventId && value.action);
                if (/^INSERT INTO nofries\.dashboard_runtime_audit\b/.test(text) && payload &&
                    payload.operationId === null && payload.outcome === 'succeeded' &&
                    ['readSession', 'discoverBindings', 'readDashboardAdmission', 'readDashboardBootstrap', 'readDashboardReadiness'].includes(payload.action)) {
                    require('../../api/shared/appLifecycle/dashboardRuntimeEvents').normaliseRuntimeReadAudit({
                        sessionSha256: params[1], instanceId: params[2], authorityId: params[3], event: payload });
                    control.allowedAudit.push(payload);
                }
                else control.mutation({ storage: 'postgres', statement: text.replace(/\s+/g, ' ').slice(0, 240) });
            }
            if (control.armed && /\bSELECT\s+nofries\.[a-z_]+\s*\(/i.test(text)) control.mutation({ storage: 'postgres', statement: text });
            if (control.beforeSql) await control.beforeSql({ sql: text, params });
            const result = await client.query(sql, params);
            if (control.afterSql) await control.afterSql({ sql: text, params, result });
            return result;
        } };
    } });
    control.assertQuiet = () => assert.deepEqual(control.attempts, [], 'reader attempted a lifecycle mutation');
    return control;
}

async function atFixtureTime(work) {
    const NativeDate = global.Date;
    global.Date = class extends NativeDate {
        constructor(...args) { super(...(args.length ? args : [FIXTURE_TIME])); }
        static now() { return FIXTURE_TIME; }
    };
    try { return await work(); } finally { global.Date = NativeDate; }
}
function durable(h) {
    return [...h.state.containers].flatMap(([container, value]) => [...value.records]
        .filter(([key]) => lifecycleBlob(key)).map(([key, bytes]) => ({ container, key, bytes: bytes.toString('utf8') })))
        .sort((a, b) => (a.container + '/' + a.key).localeCompare(b.container + '/' + b.key));
}
function restore(h, records, payloads) {
    for (const { container, key, sha256 } of records) {
        const bytes = payloads[sha256]; assert.equal(sha(bytes), sha256);
        const slash = container.indexOf('/');
        h.getContainer(container.slice(slash + 1), container.slice(0, slash)).records.set(key, Buffer.from(bytes));
    }
}
function writer(root) {
    assert.ok(root && path.isAbsolute(root), 'pass an explicit absolute --writer-root');
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), WRITER_SHA);
    assert.equal(execFileSync('git', ['diff', '--name-only', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), '', 'writer tracked source must be clean');
    return require(path.join(root, 'lib/productionApplication')).createProductionApplication;
}

async function generateFrozenFixtures(writerRoot) {
    const factory = writer(writerRoot), snapshots = {};
    await atFixtureTime(async () => {
        for (const stage of ['before_claim', 'incomplete_claim', 'committed_claim']) {
            const control = effects();
            const h = customerProductionHarness({ starter: true, external: true, applicationFactory: factory,
                configureExternal(input) {
                    control.sdk(input);
                    const Base = input.dependencies.BlobServiceClient;
                    input.dependencies.BlobServiceClient = class extends Base {
                        getContainerClient(name) {
                            const container = super.getContainerClient(name), value = Object.create(container);
                            value.getBlockBlobClient = key => {
                                const blob = container.getBlockBlobClient(key), result = Object.create(blob);
                                result.uploadData = async (...args) => {
                                    if (stage === 'before_claim' && /external-claims\/[^/]+\.json$/.test(key) ||
                                        stage === 'incomplete_claim' && key.endsWith('.complete.json')) throw new Error('Synthetic writer interruption before ' + stage);
                                    return blob.uploadData(...args);
                                };
                                return result;
                            }; return value;
                        }
                    };
                } });
            const login = await h.loginExternal(); assert.equal(login.response.status, 303);
            const before = await request(h.app).get('/api/external-customer-signup/state').set('Cookie', login.cookie);
            assert.equal(before.body.state.status, 'setup_details');
            const submitted = await post(h, '/api/external-customer-signup/setup', login.cookie,
                { accountType: 'consultant', organisationName: 'Synthetic frozen consultant', details }, before.body.csrfToken);
            assert.equal(submitted.status, stage === 'committed_claim' ? 200 : 503, JSON.stringify(submitted.body));
            snapshots[stage] = durable(h);
            assert.ok(snapshots[stage].some(value => value.key.includes('/starter-setups/') && value.bytes.includes('unlimited-v1')));
            const claims = snapshots[stage].filter(value => /external-claims\/[^/]+\.json$/.test(value.key));
            assert.equal(claims.length, stage === 'before_claim' ? 0 : stage === 'incomplete_claim' ? 1 : 2);
        }
    });
    // Content addressing deduplicates unchanged legal archives while retaining
    // their exact UTF-8 bytes; the reader never recompiles expected writer data.
    const payloads = {};
    for (const [stage, records] of Object.entries(snapshots)) snapshots[stage] = records.map(({ container, key, bytes }) => {
        const sha256 = sha(bytes); payloads[sha256] = bytes; return { container, key, sha256 };
    });
    const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, synthetic: true, fixtureTime: FIXTURE_TIME, payloads, snapshots }) + '\n');
    fs.writeFileSync(path.join(fixtureRoot, 'writer8c09-claims.json'), bytes);
    const files = ['lib/productionApplication.js', 'lib/starterSignupProduction.js', 'lib/customerSignupProduction.js',
        'api/shared/customerSignup/starterSetupDetails.js', 'api/shared/customerSignup/starterAccountAllocation.js',
        'api/shared/customerSignup/customerStarterPlan.js', 'database/migrations/0012_consultant_organisations.sql'];
    const provenance = { schemaVersion: 1, synthetic: true, writerHead: WRITER_SHA,
        writerTree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: writerRoot, encoding: 'utf8' }).trim(),
        fixtureSha256: sha(bytes), fixtureTime: new Date(FIXTURE_TIME).toISOString(),
        generation: 'node scripts/tests/consultant-reader-compatibility.cjs --generate --writer-root <clean frozen writer checkout>',
        sourceSha256: Object.fromEntries(files.map(file => [file, sha(fs.readFileSync(path.join(writerRoot, file)))])),
        interruptions: { before_claim: 'reject first external-claims upload before storage', incomplete_claim: 'reject completion marker upload before storage', committed_claim: 'ordinary completed writer claim, before consent' } };
    fs.writeFileSync(path.join(fixtureRoot, 'writer8c09-provenance.json'), JSON.stringify(provenance, null, 2) + '\n');
    return { bytes: bytes.length, sha256: provenance.fixtureSha256 };
}

function registerConsultantReaderCompatibility() {
    const api = global.describe ? { describe, test, before: beforeAll, after: afterAll } : require('node:test');
    api.describe('Frozen writer Consultant reader compatibility', () => {
        api.test('fixture provenance binds actual writer bytes, stages and prospective DDL without changing the operator catalog', () => {
            const bytes = fs.readFileSync(path.join(fixtureRoot, 'writer8c09-claims.json'));
            const provenance = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'writer8c09-provenance.json')));
            assert.equal(provenance.writerHead, WRITER_SHA); assert.equal(sha(bytes), provenance.fixtureSha256);
            assert.equal(sha(fs.readFileSync(path.join(fixtureRoot, 'prospective-organisation-count.sql'))),
                provenance.sourceSha256['database/migrations/0012_consultant_organisations.sql']);
            assert.equal(JSON.stringify(fs.readdirSync(path.resolve(__dirname, '../../database/migrations'))
                .filter(name => /^\d+.*\.sql$/.test(name)).sort()), JSON.stringify([
                '0001_core_service_desk.sql', '0002_lifecycle.sql', '0003_dashboard.sql',
                '0004_ncsc_assessments.sql', '0005_dashboard_runtime.sql', '0006_dashboard_host_events.sql',
                '0007_evidence_metadata.sql', '0008_signup_acceptance_receipts.sql',
                '0009_signup_registrations.sql', '0010_signup_acceptance_schedule.sql',
                '0011_starter_signup.sql', '0016_dashboard_improvement_plans.sql'
            ]));
        });
        for (const stage of ['before_claim', 'incomplete_claim', 'committed_claim']) api.test(`${stage}: normal enabled reader exposes saved own details and never completes a new-policy lifecycle`, async () => atFixtureTime(async () => {
            require('../../api/shared/abuseProtection').resetAbuseProtectionForTests();
            const frozen = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'writer8c09-claims.json')));
            const control = effects(), h = customerProductionHarness({ starter: true, external: true, configureExternal: control.sdk, applicationFactory: readerFactory });
            assert.equal(h.env.NOFRIES_STARTER_SIGNUP_ENABLED, 'true'); assert.equal(h.dependencies.externalCustomer.allowNewSignup, true);
            const login = await h.loginExternal(); assert.equal(login.response.status, 303, JSON.stringify(login.response.body));
            const writable = await request(h.app).get('/api/external-customer-signup/state').set('Cookie', login.cookie);
            assert.equal(writable.body.state.status, 'setup_details'); assert.ok(writable.body.csrfToken);
            // A real previously open tab retains its genuine session CSRF while
            // another writer saves the shared durable state. No auth is mocked.
            restore(h, frozen.snapshots[stage], frozen.payloads);
            const baseline = durable(h); control.armed = true;
            const state = await request(h.app).get('/api/external-customer-signup/state').set('Cookie', login.cookie);
            assert.equal(state.status, 200, JSON.stringify(state.body));
            assert.equal(state.body.state.status, 'setup_read_only', JSON.stringify(state.body));
            for (const body of [{ resume: true }, { accountType: 'consultant', organisationName: 'Synthetic frozen consultant', details }]) {
                const response = await post(h, '/api/external-customer-signup/setup', login.cookie, body, writable.body.csrfToken);
                assert.equal(response.status, 200, JSON.stringify(response.body));
                assert.equal(response.body.state.status, 'setup_read_only', JSON.stringify(response.body));
            }
            control.assertQuiet(); assert.deepEqual(durable(h), baseline); assert.equal(h.state.delivered.length, 0);
        }));
    });
    registerNative(api);
}

function registerNative(api) {
    const writerRoot = process.env.NOFRIES_COMPAT_WRITER_ROOT, testUrl = process.env.NOFRIES_TEST_DATABASE_URL;
    const suite = writerRoot && testUrl ? api.describe : api.describe.skip;
    suite('Actual writer to reader recovery with restricted PostgreSQL', () => {
        const key = crypto.randomBytes(8).toString('hex'), databaseName = `nf_reader_${key}`, runtimeRole = `nf_reader_role_${key}`;
        const password = `synthetic-only-${key}`;
        let controlPool, ownerPool, runtimePool, closeOwner, closeRuntime, factory, createdDatabase = false, createdRole = false;
        api.before(async () => {
            factory = writer(writerRoot);
            const { Pool } = require('pg');
            const { trackPoolClientEnds } = require('../helpers/postgresPoolLifecycle');
            controlPool = new Pool({ connectionString: testUrl, max: 1 });
            await controlPool.query(`CREATE DATABASE ${databaseName}`); createdDatabase = true;
            const ownerUrl = new URL(testUrl); ownerUrl.pathname = '/' + databaseName;
            ownerPool = new Pool({ connectionString: ownerUrl.toString(), max: 2 }); closeOwner = trackPoolClientEnds(ownerPool);
            await require('../../scripts/db-migrate').applyMigrations({ pool: ownerPool });
            // Prospective writer schema is TEST DATA, not this predecessor's
            // operator migration catalog. Verify exact immutable writer bytes.
            const ddl = fs.readFileSync(path.join(fixtureRoot, 'prospective-organisation-count.sql'));
            const source = fs.readFileSync(path.join(writerRoot, 'database/migrations/0012_consultant_organisations.sql'));
            assert.equal(sha(ddl), sha(source)); await ownerPool.query(ddl.toString());
            await ownerPool.query('INSERT INTO nofries.schema_migrations (migration_id,checksum_sha256) VALUES ($1,$2)',
                ['0014_consultant_organisations.sql', sha(ddl)]);
            assert.equal((await ownerPool.query('SELECT count(*) AS count FROM nofries.schema_migrations')).rows[0].count, '13');
            await assert.rejects(require('../../scripts/dashboard-maintenance-cli').verifySchema(ownerPool), { code: 'maintenance_schema_drift' });
            await controlPool.query(`CREATE ROLE ${runtimeRole} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT`); createdRole = true;
            await controlPool.query(`GRANT nofries_runtime TO ${runtimeRole} WITH INHERIT FALSE, SET TRUE, ADMIN FALSE`);
            const runtimeUrl = new URL(ownerUrl); runtimeUrl.username = runtimeRole; runtimeUrl.password = password;
            runtimePool = new Pool({ connectionString: runtimeUrl.toString(), max: 2, connectionTimeoutMillis: 5000 });
            closeRuntime = trackPoolClientEnds(runtimePool);
            assert.deepEqual((await runtimePool.query('SELECT rolsuper,rolbypassrls,rolcreaterole FROM pg_roles WHERE rolname=current_user')).rows,
                [{ rolsuper: false, rolbypassrls: false, rolcreaterole: false }]);
        });
        api.after(async () => {
            if (closeRuntime) await closeRuntime(); if (closeOwner) await closeOwner();
            if (controlPool) try {
                if (createdDatabase) await controlPool.query(`DROP DATABASE ${databaseName}`);
                if (createdRole) await controlPool.query(`DROP ROLE ${runtimeRole}`);
            } finally { await controlPool.end(); }
        });
        async function application(initialFactory = factory) {
            require('../../api/shared/abuseProtection').resetAbuseProtectionForTests();
            require(path.join(writerRoot, 'api/shared/abuseProtection')).resetAbuseProtectionForTests();
            const instanceId = id(), restoreEpoch = id(), actorSubjectKey = id() + ':' + id();
            const { hash } = require('../../api/shared/appLifecycle/dashboardRuntimeRecords');
            const maintenance = require('../../api/shared/appLifecycle/postgresDashboardRuntimeRepository').createPostgresDashboardMaintenanceRepository({
                pool: ownerPool, instanceId, clock: () => new Date().toISOString(), newId: id,
                historyBudget: { maxRecords: 4096, maxBytes: 67108864, maxDurationMs: 60000 },
                readExternalRuntimeEpoch: async () => ({ instanceId, restoreEpoch }),
                authoriseMaintenanceOperation: facts => ['initializeRuntimeInstance', 'enableRuntimeIngress'].includes(facts.operationType) && facts.command.actorSubjectKey === actorSubjectKey });
            const command = before => ({ operationId: id(), actorSubjectKey, expectedRevision: before?.revision ?? null,
                expectedRecordSha256: before ? hash(before) : null, restoreEpoch, evidenceRef: 'synthetic-reader-compatibility', evidenceSha256: hash('synthetic-reader-compatibility') });
            const initialized = await maintenance.initializeRuntimeInstance(command());
            await maintenance.enableRuntimeIngress(command(initialized.record));
            const control = effects();
            const h = customerProductionHarness({ pool: control.pool(runtimePool), instanceId, restoreEpoch,
                starter: true, external: true, now: Date.now(), applicationFactory: initialFactory, configureExternal: control.sdk });
            return { h, control };
        }
        async function customer(h, accountType = 'consultant') {
            h.state.externalOid = id(); h.state.externalEmail = `synthetic-${id()}@example.test`;
            const provisional = await h.loginExternal(); assert.equal(provisional.response.status, 303);
            const before = await request(h.app).get('/api/external-customer-signup/state').set('Cookie', provisional.cookie);
            const submitted = await post(h, '/api/external-customer-signup/setup', provisional.cookie,
                { accountType, organisationName: 'Synthetic recovery account', details }, before.body.csrfToken);
            assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
            const login = await h.loginExternal(); assert.equal(login.response.status, 303);
            const accepted = await h.consentExternal(login.cookie);
            assert.equal(accepted.response.status, 200, JSON.stringify(accepted.response.body));
            assert.equal(accepted.response.body.state.status, 'continue_to_dashboard');
            const { starterAccountKey } = require(path.join(writerRoot, 'api/shared/customerSignup/starterAccountAllocation'));
            const accountKey = `customer-starter/${starterAccountKey(h.state.externalEmail)}.json`;
            const account = JSON.parse(h.getContainer('external-starter-authority').records.get(accountKey));
            return { cookie: login.cookie, account, accountKey, csrfToken: accepted.before.body.csrfToken,
                subjectKey: h.dependencies.externalCustomer.identityProvider.tenantId + ':' + h.state.externalOid };
        }
        async function offer(h, owner, requestId = id()) {
            const before = await request(h.app).get('/api/customer-signup/clients').set('Cookie', owner.cookie);
            assert.equal(before.status, 200, JSON.stringify(before.body));
            const response = await post(h, '/api/customer-signup/clients', owner.cookie,
                { action: 'create', requestId, organisationName: 'Synthetic recovery client', details }, before.body.csrfToken);
            assert.equal(response.status, 200, JSON.stringify(response.body)); assert.equal(response.body.state.status, 'terms');
            const { termsVersion, termsDigest, scheduleId, scheduleDigest } = response.body.state;
            return { requestId, csrfToken: response.body.csrfToken,
                terms: { accepted: true, termsVersion, termsDigest, scheduleId, scheduleDigest } };
        }
        async function accept(h, owner, offered) {
            const response = await post(h, '/api/customer-signup/clients', owner.cookie,
                { action: 'accept', requestId: offered.requestId, terms: offered.terms }, offered.csrfToken);
            assert.equal(response.status, 200, JSON.stringify(response.body)); assert.equal(response.body.state.status, 'ready');
        }
        async function snapshot(h) {
            const names = (await ownerPool.query("SELECT tablename FROM pg_tables WHERE schemaname='nofries' AND tablename<>'dashboard_runtime_audit' ORDER BY tablename")).rows;
            const sql = {};
            for (const { tablename } of names) {
                assert.match(tablename, /^[a-z0-9_]+$/);
                sql[tablename] = (await ownerPool.query(`SELECT to_jsonb(t) AS row FROM nofries.${tablename} t ORDER BY to_jsonb(t)::text`)).rows;
            }
            return { sql, blobs: durable(h) };
        }
        api.test('four activated clients, mixed pending sidecars and aliases survive reader paging, stale commands and exact committed replay without mutation', async () => {
            const { h, control } = await application(), owner = await customer(h), accepted = [];
            for (let index = 0; index < 4; index++) { const value = await offer(h, owner); await accept(h, owner, value); accepted.push(value); }
            const pending = await offer(h, owner);
            let interrupted = false;
            control.beforeSql = ({ sql }) => { if (!interrupted && sql.startsWith('INSERT INTO nofries.signup_registrations')) {
                interrupted = true; throw new Error('Synthetic interruption after consent receipt and before registration');
            } };
            const warning = await post(h, '/api/customer-signup/clients', owner.cookie,
                { action: 'accept', requestId: pending.requestId, terms: pending.terms }, pending.csrfToken);
            control.beforeSql = null; assert.ok(interrupted); assert.equal(warning.status, 503);
            const pendingSlot = JSON.parse(h.getContainer('external-starter-authority').records
                .get(`customer-starter/starter-clients/${owner.account.accountId}/${pending.requestId}.json`)).slot;
            assert.equal((await ownerPool.query('SELECT count(*) AS count FROM nofries.signup_acceptance_receipts WHERE tenant_id=$1 AND organisation_id=$2',
                [pendingSlot.tenantId, pendingSlot.organisationId])).rows[0].count, '1');
            const registration = (await ownerPool.query('SELECT payload FROM nofries.signup_registrations WHERE subject_key=$1', [owner.subjectKey])).rows[0].payload;
            assert.ok(!registration.registrations.some(value => value.organisationId === pendingSlot.organisationId));
            const { createStarterAccountAllocator } = require(path.join(writerRoot, 'api/shared/customerSignup/starterAccountAllocation'));
            const { AzureStarterAccountStore } = require(path.join(writerRoot, 'api/shared/customerSignup/azureStarterAccountStore'));
            const sdk = new h.dependencies.BlobServiceClient('https://syntheticdata123.blob.core.windows.net');
            const allocator = createStarterAccountAllocator({ store: new AzureStarterAccountStore(sdk.getContainerClient('external-starter-authority')),
                captureOwner: async () => ({ subjectKey: owner.subjectKey, email: owner.account.email }), readActivation: async () => null });
            for (let index = 0; index < 47; index++) await allocator.reserveClient({}, { requestId: id(), organisationName: 'Synthetic unprepared sidecar' });
            assert.equal([...h.getContainer('external-starter-authority').records.keys()]
                .filter(key => key.startsWith(`customer-starter/starter-client-bindings/${owner.account.accountId}/`)).length, 52);
            assert.equal((await ownerPool.query('SELECT count(*) AS count FROM nofries.dashboard_starter_scopes WHERE account_id=$1 AND activation IS NOT NULL', [owner.account.accountId])).rows[0].count, '5');
            const originalAccount = h.getContainer('external-starter-authority').records.get(owner.accountKey).toString();
            h.recomposeWithApplication(readerFactory);
            const baseline = await snapshot(h); control.pages.length = 0; control.armed = true;
            const first = await request(h.app).get('/api/customer-signup/clients').set('Cookie', owner.cookie);
            assert.equal(first.status, 200, JSON.stringify(first.body)); assert.equal(first.body.state.status, 'clients_read_only');
            assert.equal(first.body.state.clients.length, 50); assert.equal(first.body.state.remaining, null); assert.ok(first.body.state.nextCursor);
            const second = await request(h.app).get('/api/customer-signup/clients').query({ cursor: first.body.state.nextCursor }).set('Cookie', owner.cookie);
            assert.equal(second.status, 200, JSON.stringify(second.body)); assert.equal(second.body.state.clients.length, 2); assert.equal(second.body.state.nextCursor, null);
            const repeated = await request(h.app).get('/api/customer-signup/clients').set('Cookie', owner.cookie);
            assert.deepEqual(repeated.body.state, first.body.state);
            assert.equal(new Set([...first.body.state.clients, ...second.body.state.clients].map(row => row.requestId)).size, 52);
            for (const value of accepted) {
                const target = await request(h.app).get('/api/customer-signup/clients').query({ requestId: value.requestId }).set('Cookie', owner.cookie);
                assert.equal(target.status, 200, JSON.stringify(target.body)); assert.equal(target.body.state.clients[0].status, 'ready');
                for (const action of ['resume', 'resume_acceptance', 'accept']) {
                    const result = await post(h, '/api/customer-signup/clients', owner.cookie,
                        { action, requestId: value.requestId, ...(action === 'accept' ? { terms: value.terms } : {}) }, first.body.csrfToken);
                    assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.state.status, 'ready');
                }
            }
            for (const body of [{ action: 'resume_acceptance', requestId: pending.requestId },
                { action: 'create', requestId: id(), organisationName: 'Synthetic denied fresh client', details },
                { action: 'create', requestId: pending.requestId, organisationName: 'Synthetic recovery client', details }]) {
                const result = await post(h, '/api/customer-signup/clients', owner.cookie, body, first.body.csrfToken);
                assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.state.status, 'setup_read_only');
            }
            const own = await request(h.app).get('/api/external-customer-signup/state').set('Cookie', owner.cookie);
            assert.equal(own.status, 200, JSON.stringify(own.body)); assert.equal(own.body.state.status, 'continue_to_dashboard');
            const ownReplay = await post(h, '/api/external-customer-signup/setup', owner.cookie, { resume: true }, owner.csrfToken);
            assert.equal(ownReplay.status, 200, JSON.stringify(ownReplay.body)); assert.equal(ownReplay.body.state.status, 'setup_read_only');
            control.assertQuiet(); assert.deepEqual(await snapshot(h), baseline);
            assert.equal(h.getContainer('external-starter-authority').records.get(owner.accountKey).toString(), originalAccount);
            assert.ok(control.pages.length >= 3); assert.ok(control.pages.every(page => page.maxPageSize <= 50 && page.returned <= 50));
        });
        api.test('lost SQL activation acknowledgement in the account mirror is read-only and cannot reset or repair the original account', async () => {
            const { h, control } = await application();
            h.state.externalOid = id(); h.state.externalEmail = `synthetic-${id()}@example.test`;
            const provisional = await h.loginExternal();
            const before = await request(h.app).get('/api/external-customer-signup/state').set('Cookie', provisional.cookie);
            assert.equal((await post(h, '/api/external-customer-signup/setup', provisional.cookie,
                { accountType: 'consultant', organisationName: 'Synthetic lost mirror', details }, before.body.csrfToken)).status, 200);
            const login = await h.loginExternal(); let interrupted = false;
            control.beforeBlob = ({ key, method, args }) => {
                if (method === 'uploadData' && /\/starter-accounts\//.test(key) && JSON.parse(args[0]).activation !== null) {
                    interrupted = true; throw new Error('Synthetic unavailable activation mirror');
                }
            };
            const accepted = await h.consentExternal(login.cookie); control.beforeBlob = null;
            assert.ok(interrupted); assert.equal(accepted.response.status, 503);
            const account = durable(h).find(value => /\/starter-accounts\//.test(value.key));
            assert.ok(account); assert.equal(JSON.parse(account.bytes).activation, null);
            assert.equal((await ownerPool.query('SELECT count(*) AS count FROM nofries.dashboard_starter_scopes WHERE account_id=$1 AND activation IS NOT NULL',
                [JSON.parse(account.bytes).accountId])).rows[0].count, '1');
            h.recomposeWithApplication(readerFactory);
            const baseline = await snapshot(h); control.armed = true;
            const resumed = await request(h.app).get('/api/external-customer-signup/state').set('Cookie', login.cookie);
            assert.equal(resumed.status, 200, JSON.stringify(resumed.body)); assert.equal(resumed.body.state.status, 'setup_read_only');
            const result = await post(h, '/api/external-customer-signup/setup', login.cookie, { resume: true }, accepted.before.body.csrfToken);
            assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.state.status, 'setup_read_only');
            control.assertQuiet(); assert.deepEqual(await snapshot(h), baseline);
        });
        api.test('reader preserves cross-account and selected-organisation isolation, missing-alias denial, final revocation checks and parent membership checks', async () => {
            const { h, control } = await application(), a = await customer(h);
            const one = await offer(h, a), two = await offer(h, a);
            await accept(h, a, one); await accept(h, a, two);
            const b = await customer(h), offeredB = await offer(h, b, one.requestId);
            const starter = h.getContainer('external-starter-authority');
            const slot = value => JSON.parse(starter.records.get(`customer-starter/starter-clients/${a.account.accountId}/${value.requestId}.json`)).slot;
            const firstSlot = slot(one), secondSlot = slot(two);
            async function select(owner, bindingId) {
                const session = await request(h.app).get('/api/dashboard/session').set('Cookie', owner.cookie);
                assert.equal(session.status, 200, JSON.stringify(session.body));
                const response = await post(h, '/api/dashboard/selection', owner.cookie,
                    { operationId: id(), bindingId, expectedGeneration: session.body.generation });
                assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body.generation;
            }
            await select(a, firstSlot.bindingId);
            const session = await request(h.app).get('/api/dashboard/session').set('Cookie', a.cookie);
            const command = require('../fixtures/ncscAssessmentFixture').createCommand();
            const { action, assessmentId, ...body } = command;
            const created = await post(h, '/api/dashboard/ncsc/assessments', a.cookie, { assessmentId, ...body })
                .set('X-NoFries-Dashboard-Generation', session.body.generation);
            assert.equal(created.status, 201, JSON.stringify(created.body));
            let generation = await select(a, secondSlot.bindingId);
            h.recomposeWithApplication(readerFactory);
            let baseline = await snapshot(h); control.armed = true;
            const missing = await request(h.app).get('/api/dashboard/ncsc/assessments/' + assessmentId)
                .set('Cookie', a.cookie).set('X-NoFries-Dashboard-Generation', generation);
            assert.equal(missing.status, 404, JSON.stringify(missing.body));
            const ownBootstrap = await request(h.app).get('/api/dashboard/bootstrap').set('Cookie', a.cookie)
                .set('X-NoFries-Dashboard-Generation', generation);
            assert.equal(ownBootstrap.status, 200, JSON.stringify(ownBootstrap.body));
            const listA = await request(h.app).get('/api/customer-signup/clients').set('Cookie', a.cookie);
            const listB = await request(h.app).get('/api/customer-signup/clients').set('Cookie', b.cookie);
            for (const value of [{ action: 'resume', requestId: two.requestId }, { action: 'accept', requestId: one.requestId, terms: one.terms }]) {
                const denied = await post(h, '/api/customer-signup/clients', b.cookie, value, listB.body.csrfToken);
                if (value.action === 'resume') assert.ok(denied.status >= 400, JSON.stringify(denied.body));
                else { assert.equal(denied.status, 200, JSON.stringify(denied.body)); assert.equal(denied.body.state.status, 'setup_read_only'); }
            }
            const foreignSelection = await post(h, '/api/dashboard/selection', b.cookie,
                { operationId: id(), bindingId: firstSlot.bindingId, expectedGeneration: (await request(h.app).get('/api/dashboard/session').set('Cookie', b.cookie)).body.generation });
            assert.equal(foreignSelection.status, 403, JSON.stringify(foreignSelection.body));
            assert.notEqual(offeredB.terms.scheduleDigest, one.terms.scheduleDigest);
            control.assertQuiet(); assert.deepEqual(await snapshot(h), baseline);

            const aliasKey = `customer-starter/starter-client-bindings/${a.account.accountId}/${firstSlot.bindingId}.json`;
            const alias = starter.records.get(aliasKey); assert.ok(alias); starter.records.delete(aliasKey);
            baseline = await snapshot(h);
            const absentAlias = await post(h, '/api/customer-signup/clients', a.cookie,
                { action: 'resume_acceptance', requestId: one.requestId }, listA.body.csrfToken);
            assert.equal(absentAlias.status, 200, JSON.stringify(absentAlias.body)); assert.equal(absentAlias.body.state.status, 'setup_read_only');
            control.assertQuiet(); assert.deepEqual(await snapshot(h), baseline); starter.records.set(aliasKey, alias);

            // Revoke after the first invitation read, during a later awaited
            // owner-authority read. Only the external test actor mutates data.
            const context = JSON.parse(starter.records.get(`customer-starter/contexts/${firstSlot.organisationId}.json`));
            const invitations = h.getContainer('nofries-browser-auth').records;
            const invitationKey = `browser-auth/customer-signup/invitations/${context.invitation.tokenDigest}.json`;
            const originalInvitation = invitations.get(invitationKey); let observed = false, revoked = false;
            control.afterRead = ({ key }) => {
                if (key === invitationKey) observed = true;
                if (observed && !revoked && key.startsWith('customer-subjects/')) {
                    revoked = true;
                    const value = JSON.parse(originalInvitation);
                    invitations.set(invitationKey, Buffer.from(JSON.stringify({ ...value, status: 'revoked', revision: value.revision + 1 })));
                }
            };
            const revokedInvitation = await post(h, '/api/customer-signup/clients', a.cookie,
                { action: 'resume_acceptance', requestId: one.requestId }, listA.body.csrfToken);
            control.afterRead = null; assert.ok(revoked); assert.ok(revokedInvitation.status >= 400);
            control.assertQuiet(); invitations.set(invitationKey, originalInvitation);

            observed = false; revoked = false;
            const registrationStore = require('../../api/shared/customerSignup/postgresSignupRegistrationStore').createPostgresSignupRegistrationStore({
                database: require('../../api/shared/database/postgres').createPostgresDatabase({ pool: ownerPool }) });
            control.afterRead = async ({ key }) => {
                if (key === invitationKey) observed = true;
                if (observed && !revoked && key.startsWith('customer-subjects/')) {
                    revoked = true;
                    const reference = { subjectKey: a.subjectKey, tenantId: firstSlot.tenantId, organisationId: firstSlot.organisationId,
                        invitationId: context.invitation.invitationId };
                    const current = await registrationStore.readForInvitation(reference);
                    await registrationStore.revokeRegistration({ ...reference, expectedRevision: current.revision });
                }
            };
            const revokedRegistration = await post(h, '/api/customer-signup/clients', a.cookie,
                { action: 'resume_acceptance', requestId: one.requestId }, listA.body.csrfToken);
            control.afterRead = null; assert.ok(revoked); assert.ok(revokedRegistration.status >= 400); control.assertQuiet();

            const { createPostgresDatabase } = require('../../api/shared/database/postgres');
            const { dataStorage } = require('../../api/shared/appLifecycle/postgresDashboardBootstrap');
            const { applyMembershipCommand } = require('../../api/shared/appLifecycle/membershipDomain');
            async function suspend(target) {
                const scope = { tenantId: target.tenantId, organisationId: target.organisationId };
                await createPostgresDatabase({ pool: ownerPool }).withTenantTransaction(scope.tenantId, async tx => {
                    const state = await dataStorage.loadSnapshotForUpdate(tx, scope);
                    const membership = state.membershipState.memberships.find(value => value.subjectKey === a.subjectKey);
                    const next = applyMembershipCommand(state.membershipState, state.tenantAggregate, {
                        ...scope, expectedRevision: state.membershipState.revision, actorSubjectKey: a.subjectKey, now: new Date().toISOString(),
                        action: 'suspend', payload: { membershipId: membership.membershipId } });
                    await dataStorage.updateMembershipState(tx, next);
                });
            }
            await suspend(secondSlot); baseline = await snapshot(h);
            const clientSuspended = await request(h.app).get('/api/dashboard/bootstrap').set('Cookie', a.cookie)
                .set('X-NoFries-Dashboard-Generation', generation);
            assert.equal(clientSuspended.status, 403, JSON.stringify(clientSuspended.body));
            control.assertQuiet(); assert.deepEqual(await snapshot(h), baseline);
            await suspend(a.account.organisations[0]); baseline = await snapshot(h);
            const parentSuspended = await post(h, '/api/customer-signup/clients', a.cookie,
                { action: 'resume_acceptance', requestId: two.requestId }, listA.body.csrfToken);
            assert.ok(parentSuspended.status >= 400, JSON.stringify(parentSuspended.body));
            control.assertQuiet(); assert.deepEqual(await snapshot(h), baseline);
            const unaffected = await request(h.app).get('/api/customer-signup/clients').set('Cookie', b.cookie);
            assert.equal(unaffected.status, 200, JSON.stringify(unaffected.body)); assert.equal(unaffected.body.state.status, 'clients_read_only');
            control.assertQuiet(); assert.deepEqual(await snapshot(h), baseline);
        });
        api.test('historical embedded client reservation without context still reaches its original terms after a genuine interrupted floor create', async () => {
            const { h, control } = await application(readerFactory), owner = await customer(h);
            const originalSetup = durable(h).find(value => value.key.includes('/starter-setups/'));
            assert.equal(JSON.parse(originalSetup.bytes).offerInput.consultantOrganisationPolicy, undefined);
            const list = await request(h.app).get('/api/customer-signup/clients').set('Cookie', owner.cookie);
            assert.equal(list.body.state.status, 'clients'); assert.equal(list.body.state.remaining, 3);
            const requestId = id(), body = { action: 'create', requestId, organisationName: 'Synthetic interrupted historical client', details };
            let interrupted = false;
            control.beforeBlob = ({ key, method, args }) => {
                if (!interrupted && method === 'uploadData' && key.includes('/contexts/') && JSON.parse(args[0]).declaration) {
                    interrupted = true; throw new Error('Synthetic interruption after historical reservation and before client context');
                }
            };
            const failed = await post(h, '/api/customer-signup/clients', owner.cookie, body, list.body.csrfToken);
            control.beforeBlob = null; assert.ok(interrupted); assert.equal(failed.status, 503);
            const saved = JSON.parse(h.getContainer('external-starter-authority').records.get(owner.accountKey));
            assert.equal(saved.organisations.length, 2); const reserved = saved.organisations[1]; assert.equal(reserved.requestId, requestId);
            assert.equal(h.getContainer('external-starter-authority').records.has(`customer-starter/contexts/${reserved.organisationId}.json`), false);
            const resumed = await post(h, '/api/customer-signup/clients', owner.cookie, body, list.body.csrfToken);
            assert.equal(resumed.status, 200, JSON.stringify(resumed.body)); assert.equal(resumed.body.state.status, 'terms');
            assert.equal(resumed.body.state.scheduleId, reserved.scheduleId);
            const context = JSON.parse(h.getContainer('external-starter-authority').records.get(`customer-starter/contexts/${reserved.organisationId}.json`));
            assert.equal(context.source.offerInput.consultantOrganisationPolicy, undefined);
            assert.deepEqual(JSON.parse(h.getContainer('external-starter-authority').records.get(owner.accountKey)), saved);
        });
        api.test('actual writer wins a late client context conflict and floor stops before later archive, invitation or SQL effects', async () => {
            const { h, control } = await application(readerFactory), owner = await customer(h);
            const list = await request(h.app).get('/api/customer-signup/clients').set('Cookie', owner.cookie);
            const body = { action: 'create', requestId: id(), organisationName: 'Synthetic concurrent policy client', details };
            let raced = false, baseline, writerResponse;
            control.beforeBlob = async ({ key, method, args }) => {
                if (!raced && method === 'uploadData' && key.includes('/contexts/') && JSON.parse(args[0]).declaration) {
                    raced = true;
                    h.recomposeWithApplication(factory);
                    writerResponse = await post(h, '/api/customer-signup/clients', owner.cookie, body, list.body.csrfToken);
                    assert.equal(writerResponse.status, 200, JSON.stringify(writerResponse.body)); assert.equal(writerResponse.body.state.status, 'terms');
                    const context = JSON.parse(h.getContainer('external-starter-authority').records.get(key));
                    assert.equal(context.source.offerInput.consultantOrganisationPolicy, 'unlimited-v1');
                    h.recomposeWithApplication(readerFactory);
                    baseline = await snapshot(h); control.armed = true;
                }
            };
            const response = await post(h, '/api/customer-signup/clients', owner.cookie, body, list.body.csrfToken);
            control.beforeBlob = null; assert.ok(raced); assert.ok(writerResponse);
            assert.equal(response.status, 200, JSON.stringify(response.body)); assert.equal(response.body.state.status, 'setup_read_only');
            control.assertQuiet(); assert.deepEqual(await snapshot(h), baseline);
        });
    });
}

module.exports = registerConsultantReaderCompatibility;
module.exports.generateFrozenFixtures = generateFrozenFixtures;
module.exports.effects = effects;
if (require.main === module) registerConsultantReaderCompatibility();
