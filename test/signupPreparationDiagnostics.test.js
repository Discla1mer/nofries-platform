'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createPostgresDashboardRuntimeRepository } = require('../api/shared/appLifecycle/postgresDashboardRuntimeRepository');
const records = require('../api/shared/appLifecycle/dashboardRuntimeRecords');
const starter = require('../api/shared/customerSignup/starterProvisioning');
const { createSignupDiagnostics } = require('../api/shared/customerSignup/signupDiagnostics');
const { withSignupSupportContext } = require('../api/shared/customerSignup/signupSupportContext');
const diagnostic = require('../api/shared/customerSignup/signupPreparationDiagnostic');

// Frozen PR635 backend baseline, including its passive registration-layout guard.
const BASE = '017925841f7522f2c1c21079a7cea6caf5f251ff';
const NOW = '2026-10-22T09:00:00.000Z';
const PRIVATE = 'SYNTHETIC_PRIVATE_SQL_BODY_TOKEN_CONSTRAINT_MESSAGE';
const REFERENCE = 'NF-0123456789ABCDEF';
const INSTANCE = '70000000-0000-4000-8000-000000000007';
const EPOCH = '80000000-0000-4000-8000-000000000008';
const clone = value => JSON.parse(JSON.stringify(value));
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const PLAN = require('../api/shared/customerSignup/starterTrialPlan.json');
const SLOT_IDS = ['requestId', 'tenantId', 'organisationId', 'grantId', 'scheduleId', 'activationId',
    'bootstrapOperationId', 'acceptOperationId', 'publicationOperationId', 'bindingId', 'authorityId', 'membershipId', 'admissionOperationId'];
let baseFactory;
beforeAll(() => {
    const root = path.resolve(__dirname, '..'), file = path.join(root, 'api/shared/appLifecycle/postgresDashboardRuntimeRepository.js');
    const source = fs.readFileSync(path.join(root, 'test/fixtures/signupPreparation/pr635-runtime-baseline.js.txt'), 'utf8');
    expect(sha(source)).toBe('909ac8432a84a7bc146ed60ec095ed95a727ced861f5596e200ae9518247b3ef');
    const isolated = { exports: {} };
    const localRequire = request => require(request.startsWith('.') ? path.resolve(path.dirname(file), request) : request);
    // Evaluate the exact base text in this Jest realm, sharing unchanged codecs.
    // A native Module._compile would give plain objects a different prototype.
    const evaluate = new Function('require', 'module', 'exports', '__filename', '__dirname', source);
    evaluate(localRequire, isolated, isolated.exports, file, path.dirname(file));
    baseFactory = isolated.exports.createPostgresDashboardRuntimeRepository;
});

function fixtureData() {
    let ordinal = 1;
    const id = () => `00000000-0000-4000-8000-${String(ordinal++).padStart(12, '0')}`;
    const slot = { ...Object.fromEntries(SLOT_IDS.map(key => [key, id()])), kind: 'own', organisationName: 'Synthetic company' };
    const subjectKey = `${id()}:${id()}`;
    const account = { schemaVersion: 1, accountId: id(), planId: PLAN.planId, planSha256: records.hash(PLAN),
        email: 'synthetic@example.test', accountType: 'company', setupRequestId: slot.requestId, setupSha256: 'a'.repeat(64),
        createdAt: NOW, activation: null, organisations: [slot], identitySubjectKey: subjectKey };
    const source = { offerInput: { planId: PLAN.planId,
        ...Object.fromEntries(['tenantId', 'organisationId', 'organisationName', 'grantId', 'scheduleId', 'kind'].map(key => [key, slot[key]])),
        accountType: 'company', contact: { name: 'Synthetic Owner', role: 'Owner', address: 'Synthetic address', registrationId: null,
            email: account.email, authorityEvidenceId: id() }, framework: { moduleId: 'cyber_security', profileId: 'synthetic', version: '1', scoringVersion: '1' } },
        subjectKey, issuerSubjectKey: subjectKey, invitationId: id(), createdAt: NOW };
    return { account, requestId: slot.requestId, source };
}

// A SQL transport contract double: serialize the actual INSERTs and SELECTs.
// The real compiler/runtime/bootstrap build and validate their own rows/receipt.
// Native PostgreSQL tests separately establish SQL/RLS/constraint correctness.
function runtimeFixture(factory, options = {}) {
    const provisioning = fixtureData(), prepared = starter.compileStarterProvisioning(provisioning);
    let durable = { dashboard_runtime_instance: [records.projectCurrentRow('instance', { schemaVersion: 1,
        instanceId: INSTANCE, revision: 1, restoreEpoch: EPOCH, ingressStatus: 'enabled', changedAt: NOW,
        evidenceRef: 'synthetic-evidence', evidenceSha256: 'e'.repeat(64) }, { receiptId: '90000000-0000-4000-8000-000000000009' })] };
    const state = { trace: [], releases: [], connects: 0, providerReads: 0, epochReads: 0, commits: 0, rollbacks: 0,
        faults: 0, lostCommit: false, clockFailure: false };
    const fault = () => options.errorFactory ? options.errorFactory(state) : Object.assign(new Error(PRIVATE), {
        code: options.sqlstate || '23514', detail: PRIVATE, hint: PRIVATE, constraint: PRIVATE, routine: PRIVATE });
    const controlResponse = kind => {
        if (options.controlResult) return options.controlResult(kind);
        const key = kind === 'COMMIT' ? 'commitTag' : 'rollbackTag';
        return { rows: [], command: Object.hasOwn(options, key) ? options[key] : kind };
    };
    const matches = sql => options.sql && options.sql(sql);
    const pool = { async end() {}, async connect() {
        state.connects++;
        if (options.connectFailure) { state.faults++; throw fault(); }
        let draft;
        return { release(discard) { state.releases.push(Boolean(discard)); }, async query(sql, params = []) {
            state.trace.push({ sql, params: clone(params) });
            if (sql === 'ROLLBACK') {
                state.rollbacks++; if (options.rollbackFailure) { state.faults++; throw Object.assign(new Error(PRIVATE), { code: '08006' }); }
                draft = undefined; return controlResponse('ROLLBACK');
            }
            if (matches(sql)) { state.faults++; throw fault(); }
            if (sql === 'BEGIN' || sql === 'BEGIN READ ONLY') { draft = clone(durable); return { rows: [], command: 'BEGIN' }; }
            if (sql === 'COMMIT') {
                state.commits++; if (options.commitTag !== 'ROLLBACK') durable = draft || durable; draft = undefined;
                if (options.loseCommit && !state.lostCommit) { state.lostCommit = true; throw Object.assign(new Error(PRIVATE), { code: '08006' }); }
                if (options.lateCommitFailure) state.clockFailure = true;
                return controlResponse('COMMIT');
            }
            // Exact legacy layout and missing-header transport facts. These reads
            // supply no registration, authority or consent to the real guard.
            if (sql === "SELECT a.atttypid = 'pg_catalog.text'::pg_catalog.regtype AS is_text, a.attnotnull AS not_null,\n        EXISTS (SELECT 1 FROM pg_catalog.pg_constraint p\n          JOIN pg_catalog.pg_attribute t ON t.attrelid=c.oid AND t.attname='identity_tenant_id' AND NOT t.attisdropped\n          JOIN pg_catalog.pg_attribute s ON s.attrelid=c.oid AND s.attname='subject_key' AND NOT s.attisdropped\n          WHERE p.conrelid=c.oid AND p.contype='p' AND p.conkey=ARRAY[t.attnum,s.attnum,a.attnum]::smallint[]) AS scoped_primary_key\n        FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid\n        JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace\n        WHERE n.nspname='nofries' AND c.relname='signup_registrations' AND c.relkind='r'\n          AND a.attname='row_key' AND a.attnum>0 AND NOT a.attisdropped LIMIT 2") {
                expect(params).toEqual([]); return { rows: [] };
            }
            if (sql === "SELECT identity_tenant_id, subject_key, revision, payload FROM nofries.signup_registrations\n            WHERE identity_tenant_id=$1 AND subject_key=$2 LIMIT 2 FOR UPDATE") {
                expect(params).toEqual([provisioning.source.subjectKey.slice(0, 36), provisioning.source.subjectKey]);
                return { rows: [] };
            }
            if (sql === "SELECT set_config('nofries.tenant_id',$1,true),set_config('nofries.signup_subject_key',$2,true)") {
                expect(params).toEqual([provisioning.source.subjectKey.slice(0, 36), provisioning.source.subjectKey]);
                return { rows: [] };
            }
            if (sql.startsWith('SET LOCAL') || sql.includes('set_config') || sql.includes('pg_advisory_xact_lock')) return { rows: [] };
            const table = sql.match(/(?:FROM|INTO|UPDATE) nofries\.(dashboard_\w+)/)?.[1];
            if (!table) throw new Error('Unexpected synthetic SQL family');
            const tables = draft || durable, rows = tables[table] || (tables[table] = []);
            if (sql.startsWith('SELECT')) {
                const conditions = [...(sql.split(' WHERE ')[1] || '').matchAll(/(\w+)\s*=\s*\$(\d+)/g)];
                const found = rows.filter(row => conditions.every(match => row[match[1]] === params[Number(match[2]) - 1]));
                return { rows: clone(found), rowCount: found.length };
            }
            if (sql.startsWith('INSERT')) {
                const columns = sql.match(/\(([^)]+)\) VALUES/)[1].split(/\s*,\s*/);
                const expressions = sql.match(/VALUES \((.+?)\)(?: ON CONFLICT| RETURNING|$)/)[1].split(/\s*,\s*/);
                const row = Object.fromEntries(columns.map((column, index) => {
                    const parameter = expressions[index].match(/\$(\d+)/);
                    let value = parameter ? params[Number(parameter[1]) - 1] : Number(expressions[index]);
                    if (['payload', 'preparation', 'activation'].includes(column)) value = JSON.parse(value);
                    return [column, value];
                }));
                if (table === 'dashboard_starter_accounts') row.activated_at = null;
                if (table === 'dashboard_starter_scopes') row.activation = null;
                const key = table === 'dashboard_starter_accounts' ? 'account_id' : 'tenant_id';
                if (sql.includes('ON CONFLICT') && rows.some(existing => existing[key] === row[key])) return { rows: [], rowCount: 0 };
                rows.push(row); return { rows: sql.includes('RETURNING') ? [{ tenant_id: row.tenant_id }] : [], rowCount: 1 };
            }
            throw new Error('Unexpected synthetic SQL operation');
        } };
    } };
    const identity = { policyId: 'synthetic-policy', policyRevision: 1, issuer: 'https://identity.example.test/v2.0',
        identityTenantId: provisioning.source.subjectKey.slice(0, 36), oid: provisioning.source.subjectKey.slice(37), audience: 'synthetic-client' };
    const runtime = factory({ pool, clock() { if (state.clockFailure) throw new Error(PRIVATE); return NOW; }, instanceId: INSTANCE,
        historyBudget: { maxRecords: 4096, maxBytes: 67108864, maxDurationMs: 60000 },
        readExternalRuntimeEpoch: async () => { state.epochReads++; return { instanceId: INSTANCE, restoreEpoch: EPOCH }; },
        newId: () => 'a0000000-0000-4000-8000-000000000001', newGenerationToken: () => 'f'.repeat(64),
        captureRequest: async () => ({ requestId: 'b0000000-0000-4000-8000-000000000001', deadline: '2026-10-22T09:01:00.000Z',
            sessionSha256: 'c'.repeat(64), kind: 'customer', identityPayload: identity, instanceId: INSTANCE, restoreEpoch: EPOCH,
            issuedAt: '2026-10-22T08:59:00.000Z', expiresAt: '2026-10-22T10:00:00.000Z', operatorIssuanceProof: null, discovery: null }),
        readVerifiedOnboardingProof: async () => null, readPreparedCaseCapability: async () => null, authoriseOperatorOperation: () => false,
        readStarterProvisioning: async () => {
            state.providerReads++; if (options.providerFailure || options.failRecoveryProvider && state.lostCommit) throw fault();
            return { provisioning, deadline: '2026-10-22T09:01:00.000Z' };
        } });
    return { runtime, prepared, state, durable: () => clone(durable), selector: { requestId: provisioning.requestId, phase: options.phase || 'prepare' } };
}
function errorShape(error) { return error ? { name: error.name, code: error.code, statusCode: error.statusCode, message: error.message } : null; }
async function observe(factory, options = {}, stage = 'organisation_preparation', reference = REFERENCE) {
    const f = runtimeFixture(factory, options), events = [], report = createSignupDiagnostics({ now: () => Date.parse(NOW), sink: event => events.push(event) });
    let value, error;
    const response = await withSignupSupportContext(async () => {
        try { value = await f.runtime.starterProvisioning({}, f.selector); return { status: 200, body: { value } }; }
        catch (caught) { error = caught; report(stage, caught); return { status: 503, body: { error: 'Signup is unavailable', code: 'signup_unavailable' } }; }
    }, { newReference: () => reference, readReleaseIdentity: () => null });
    return { f, value, error, events, response };
}
async function parity(options) {
    const previous = await observe(baseFactory, options), current = await observe(createPostgresDashboardRuntimeRepository, options);
    expect(errorShape(current.error)).toEqual(errorShape(previous.error)); expect(current.value).toEqual(previous.value);
    expect(current.f.state.trace).toEqual(previous.f.state.trace); expect(current.f.state.releases).toEqual(previous.f.state.releases);
    expect(current.f.durable()).toEqual(previous.f.durable());
    expect(current.response.status).toBe(previous.response.status); expect(current.response.body).toEqual(previous.response.body);
    expect(current.response.headers).toEqual(previous.response.headers);
    return current;
}
function privateEvent(result) {
    expect(result.events).toHaveLength(1);
    const event = result.events[0]; expect(event.supportReference).toBe(REFERENCE);
    expect(result.response.headers['X-NoFries-Support-Reference']).toBe(event.supportReference);
    expect(Object.keys(event)).toEqual(['timestamp', 'code', 'stage', 'supportReference', 'preparation']);
    expect(Object.keys(event.preparation)).toEqual(['checkpoint', 'sqlStateFamily', 'transactionOutcome']);
    expect(Object.isFrozen(event)).toBe(true); expect(Object.isFrozen(event.preparation)).toBe(true);
    const encoded = JSON.stringify(event);
    for (const value of [PRIVATE, result.f.prepared.email, result.f.prepared.subjectKey, result.f.prepared.accountId,
        result.f.prepared.scope.tenantId, result.f.prepared.scope.organisationId, 'INSERT ', 'SELECT ', '23514', '08006']) expect(encoded).not.toContain(value);
    return event.preparation;
}

test('genuine preparation success preserves base SQL, parameters, receipt, result and response without a failure event', async () => {
    const result = await parity({}); expect(result.value.status).toBe('prepared'); expect(result.events).toEqual([]);
    expect(result.f.durable().dashboard_operation_receipts).toHaveLength(1); expect(result.f.state.commits).toBe(1);
});
test('lost COMMIT acknowledgement reconciles the genuine receipt without emitting a failure event', async () => {
    const result = await parity({ loseCommit: true }); expect(result.value.status).toBe('prepared'); expect(result.events).toEqual([]);
    expect(result.f.state.connects).toBe(2); expect(result.f.durable().dashboard_operation_receipts).toHaveLength(1);
});
test('known committed late failure remains committed and preserves the original base failure', async () => {
    const result = await parity({ lateCommitFailure: true }); expect(result.error).toBeDefined();
    expect(privateEvent(result).transactionOutcome).toBe('committed'); expect(result.f.state.rollbacks).toBe(0);
});
test('lost COMMIT plus rollback acknowledgement never claims the original transaction rolled back', async () => {
    const result = await parity({ loseCommit: true, failRecoveryProvider: true }); expect(result.error.code).toBe('onboarding_outcome_ambiguous');
    expect(privateEvent(result).transactionOutcome).toBe('unknown'); expect(result.f.state.rollbacks).toBe(1);
    expect(result.f.state.lostCommit).toBe(true); expect(result.f.state.commits).toBe(1);
    expect(result.f.durable().dashboard_operation_receipts).toHaveLength(1);
});
test('acknowledged recovery COMMIT remains committed after a late failure while retaining the first connection failure', async () => {
    const result = await parity({ loseCommit: true, lateCommitFailure: true });
    expect(result.error.code).toBe('onboarding_outcome_ambiguous');
    expect(privateEvent(result)).toEqual({ checkpoint: 'transaction_commit', sqlStateFamily: 'connection', transactionOutcome: 'committed' });
    expect(result.f.state.commits).toBe(2); expect(result.f.durable().dashboard_operation_receipts).toHaveLength(1);
});

test.each([
    ['account CHECK', sql => sql.startsWith('INSERT INTO nofries.dashboard_starter_accounts '), '23514', 'starter_account_insert', 'integrity_constraint'],
    ['scope permission', sql => sql.startsWith('INSERT INTO nofries.dashboard_starter_scopes '), '42501', 'starter_scope_insert', 'access_or_schema'],
    ['bootstrap tenant', sql => sql.startsWith('INSERT INTO nofries.dashboard_tenants '), '23505', 'bootstrap_tenant_insert', 'integrity_constraint'],
    ['bootstrap child', sql => sql.startsWith('INSERT INTO nofries.dashboard_organisations '), '42P01', 'bootstrap_child_write', 'access_or_schema'],
    ['bootstrap receipt', sql => sql.startsWith('INSERT INTO nofries.dashboard_operation_receipts '), 'P0001', 'bootstrap_receipt_write', 'trigger_or_procedure'],
    ['role', sql => sql === 'SET LOCAL ROLE nofries_runtime', '42501', 'database_context', 'access_or_schema'],
    ['timeout round trip', sql => sql === "SELECT set_config('statement_timeout', $1, true)", '57014', 'transaction_timeout', 'operator_intervention'],
    ['instance read', sql => sql.includes('FROM nofries.dashboard_runtime_instance'), '08006', 'instance_read', 'connection']
])('first raw failure survives wrappers and clean rollback: %s', async (_name, sql, sqlstate, checkpoint, sqlStateFamily) => {
    const result = await parity({ sql, sqlstate }); expect(result.error.code).toBe('onboarding_unavailable');
    expect(privateEvent(result)).toEqual({ checkpoint, sqlStateFamily, transactionOutcome: 'rolled_back' });
    expect(result.f.state.commits).toBe(0); expect(result.f.state.rollbacks).toBe(1);
});

test('first CHECK family/checkpoint survives rollback failure and a different recovery SQLSTATE', async () => {
    const result = await parity({ sql: sql => sql.startsWith('INSERT INTO nofries.dashboard_starter_scopes '), rollbackFailure: true,
        errorFactory: state => Object.assign(new Error(PRIVATE), { code: state.connects === 1 ? '23514' : '42501' }) });
    expect(result.error.code).toBe('onboarding_outcome_ambiguous');
    expect(privateEvent(result)).toEqual({ checkpoint: 'starter_scope_insert', sqlStateFamily: 'integrity_constraint', transactionOutcome: 'unknown' });
    expect(result.f.state.connects).toBe(2); expect(result.f.state.rollbacks).toBe(2);
});

test('provider failure reports a preparation checkpoint before any database operation', async () => {
    const result = await parity({ providerFailure: true });
    expect(privateEvent(result)).toEqual({ checkpoint: 'provider_read', sqlStateFamily: 'unavailable', transactionOutcome: 'not_started' });
    expect(result.f.state.trace).toEqual([]); expect(result.f.state.connects).toBe(0);
});

test('database connect failure retains the owned coarse connection family without a started transaction', async () => {
    const result = await parity({ connectFailure: true, sqlstate: '08006' });
    expect(privateEvent(result)).toEqual({ checkpoint: 'database_connect', sqlStateFamily: 'connection', transactionOutcome: 'not_started' });
    expect(result.f.state.trace).toEqual([]);
});

test('activation failures preserve base behavior and carry no preparation metadata', async () => {
    const result = await parity({ phase: 'activate', sql: sql => sql === 'SET LOCAL ROLE nofries_runtime', sqlstate: '42501' });
    expect(result.error).toBeDefined(); expect(result.events).toHaveLength(1); expect(result.events[0]).not.toHaveProperty('preparation');
    expect(result.f.state.faults).toBeGreaterThan(0);
    expect(diagnostic.readPreparationDiagnostic(result.error)).toBeNull();
});

test.each([
    ['unknown', () => Object.assign(new Error(PRIVATE), { code: 'ZZZZZ' }), 'unavailable'],
    ['Node errno', () => Object.assign(new Error(PRIVATE), { code: 'EPIPE' }), 'unavailable'],
    ['malformed', () => Object.assign(new Error(PRIVATE), { code: PRIVATE }), 'unavailable'],
    ['newline', () => Object.assign(new Error(PRIVATE), { code: '23514\n' }), 'unavailable'],
    ['nonstring', () => Object.assign(new Error(PRIVATE), { code: { private: PRIVATE } }), 'unavailable'],
    ['missing', () => new Error(PRIVATE), 'unavailable'],
    ['inherited', () => Object.assign(Object.create({ code: '23514' }), { message: PRIVATE }), 'unavailable']
])('raw %s SQLSTATE never exposes provider strings or changes the original error/result', async (_name, errorFactory, sqlStateFamily) => {
    const result = await parity({ sql: sql => sql.startsWith('INSERT INTO nofries.dashboard_starter_accounts '), errorFactory });
    expect(privateEvent(result)).toEqual({ checkpoint: 'starter_account_insert', sqlStateFamily, transactionOutcome: 'rolled_back' });
});

test('raw code getter and Proxy traps are never invoked by diagnostic classification', async () => {
    let getters = 0, traps = 0;
    const fixtures = [() => Object.defineProperty(new Error(PRIVATE), 'code', { get() { getters++; throw new Error(PRIVATE); } }),
        () => new Proxy(new Error(PRIVATE), { getOwnPropertyDescriptor() { traps++; throw new Error(PRIVATE); }, get() { traps++; throw new Error(PRIVATE); } })];
    for (const errorFactory of fixtures) {
        const result = await parity({ sql: sql => sql.startsWith('INSERT INTO nofries.dashboard_starter_accounts '), errorFactory });
        expect(privateEvent(result).sqlStateFamily).toBe('unavailable');
    }
    expect(getters).toBe(0); expect(traps).toBe(0);
});

test('parallel failed preparations retain their own first checkpoint and existing support reference', async () => {
    const references = ['NF-1111111111111111', 'NF-2222222222222222'];
    const results = await Promise.all([
        observe(createPostgresDashboardRuntimeRepository, { sql: sql => sql.startsWith('INSERT INTO nofries.dashboard_starter_accounts '), sqlstate: '23514' }, 'organisation_preparation', references[0]),
        observe(createPostgresDashboardRuntimeRepository, { sql: sql => sql.startsWith('INSERT INTO nofries.dashboard_starter_scopes '), sqlstate: '42501' }, 'organisation_preparation', references[1])
    ]);
    results.forEach((result, index) => {
        expect(result.events).toHaveLength(1); expect(result.events[0].supportReference).toBe(references[index]);
        expect(result.response.headers['X-NoFries-Support-Reference']).toBe(references[index]);
    });
    expect(results.map(result => result.events[0].preparation.checkpoint)).toEqual(['starter_account_insert', 'starter_scope_insert']);
    expect(results[0].events[0].preparation).not.toBe(results[1].events[0].preparation);
});

test('disabled/successful recorders cannot create metadata and unowned error properties cannot forge it', () => {
    const recorder = diagnostic.createPreparationDiagnostic(), error = new Error(PRIVATE);
    recorder.mark('starter_account_insert'); recorder.beginAttempt(); recorder.control('begin_ok'); recorder.fail(error);
    expect(recorder.snapshot()).toBeNull(); expect(diagnostic.attachPreparationDiagnostic(error, recorder)).toBe(error);
    expect(diagnostic.readPreparationDiagnostic(error)).toBeNull();
    recorder.enable(); expect(recorder.snapshot()).toBeNull();
    const forged = Object.assign(new Error(PRIVATE), { preparation: { checkpoint: PRIVATE, sqlStateFamily: PRIVATE, transactionOutcome: PRIVATE } });
    expect(diagnostic.readPreparationDiagnostic(forged)).toBeNull();
    diagnostic.attachPreparationDiagnostic(forged, { snapshot: () => Object.freeze({ checkpoint: 'starter_account_insert', sqlStateFamily: 'connection', transactionOutcome: 'rolled_back' }) });
    expect(diagnostic.readPreparationDiagnostic(forged)).toBeNull();
});

test('recorder retains its first failure while a later acknowledged commit is authoritative', () => {
    const recorder = diagnostic.createPreparationDiagnostic(); recorder.enable();
    const first = recorder.beginAttempt(); recorder.control('begin_ok', first); recorder.fail({ code: '23514' }, 'starter_scope_insert', first);
    recorder.control('rollback_ok', first);
    expect(recorder.snapshot().transactionOutcome).toBe('rolled_back');
    const second = recorder.beginAttempt(); recorder.control('begin_ok', second); recorder.fail({ code: '42501' }, 'starter_account_insert', second);
    recorder.control('commit_ok', second);
    expect(recorder.snapshot()).toEqual({ checkpoint: 'starter_scope_insert', sqlStateFamily: 'integrity_constraint', transactionOutcome: 'committed' });
    recorder.control('rollback_ok', first);
    expect(recorder.snapshot()).toEqual({ checkpoint: 'starter_scope_insert', sqlStateFamily: 'integrity_constraint', transactionOutcome: 'committed' });
});

test('commit uncertainty survives rollback acknowledgement and known commit is never downgraded', () => {
    const uncertain = diagnostic.createPreparationDiagnostic(); uncertain.enable(); const attempt = uncertain.beginAttempt();
    uncertain.control('begin_ok', attempt); uncertain.control('commit_sent', attempt); uncertain.fail({ code: '08006' }, 'transaction_commit', attempt);
    uncertain.control('commit_failed', attempt); uncertain.control('rollback_ok', attempt);
    expect(uncertain.snapshot().transactionOutcome).toBe('unknown');
    const known = diagnostic.createPreparationDiagnostic(); known.enable(); const knownAttempt = known.beginAttempt();
    known.control('commit_ok', knownAttempt); known.fail(new Error(PRIVATE), 'transaction_commit', knownAttempt);
    known.control('rollback_ok', knownAttempt); known.control('rollback_failed', knownAttempt); known.control('commit_failed', knownAttempt);
    expect(known.snapshot().transactionOutcome).toBe('committed');
});

test('a rolled-back first attempt does not hide an unresolved recovery transaction', () => {
    const recorder = diagnostic.createPreparationDiagnostic(); recorder.enable();
    const first = recorder.beginAttempt(); recorder.control('begin_ok', first); recorder.fail({ code: '23514' }, 'starter_scope_insert', first);
    recorder.control('rollback_ok', first); expect(recorder.snapshot().transactionOutcome).toBe('rolled_back');
    const second = recorder.beginAttempt(); recorder.control('begin_sent', second); recorder.control('commit_failed', second);
    expect(recorder.snapshot()).toEqual({ checkpoint: 'starter_scope_insert', sqlStateFamily: 'integrity_constraint', transactionOutcome: 'unknown' });
});

test.each([
    ['08006', 'connection'], ['22001', 'data_exception'], ['23514', 'integrity_constraint'], ['25006', 'transaction_state'],
    ['28P01', 'database_authorization'], ['40001', 'transaction_rollback'], ['42501', 'access_or_schema'], ['53300', 'resource_limit'],
    ['55P03', 'object_state_or_lock'], ['57014', 'operator_intervention'], ['P0001', 'trigger_or_procedure'], ['ZZZZZ', 'unavailable']
])('owned SQLSTATE %s records only its fixed family', (code, family) => {
    const recorder = diagnostic.createPreparationDiagnostic(); recorder.enable(); recorder.fail({ code, message: PRIVATE }, 'starter_scope_insert');
    expect(recorder.snapshot()).toEqual({ checkpoint: 'starter_scope_insert', sqlStateFamily: family, transactionOutcome: 'not_started' });
});

test('query classifier accepts fixed operation families without coercing or retaining arbitrary SQL text', () => {
    let coercions = 0; const unsafe = { toString() { coercions++; return PRIVATE; } };
    for (const value of [undefined, null, unsafe, PRIVATE, 'x'.repeat(16385)]) expect(diagnostic.queryCheckpoint(value)).toBeNull();
    expect(coercions).toBe(0);
    expect(diagnostic.queryCheckpoint("SELECT set_config('statement_timeout', $1, true)")).toBe('transaction_timeout');
    expect(diagnostic.queryCheckpoint('SET LOCAL statement_timeout = 0')).toBe('transaction_timeout');
    expect(diagnostic.queryCheckpoint('COMMIT')).toBe('transaction_commit');
});

test.each([
    ['COMMIT', 'committed'], ['ROLLBACK', 'rolled_back'], ['UNKNOWN', 'unknown'], [undefined, 'unknown'], [PRIVATE, 'unknown']
])('terminal failure after resolved COMMIT promise requires the actual command tag %s', async (commitTag, transactionOutcome) => {
    const result = await parity({ lateCommitFailure: true, commitTag });
    expect(result.error).toBeDefined(); expect(privateEvent(result).transactionOutcome).toBe(transactionOutcome);
    if (commitTag === 'ROLLBACK') expect(result.f.durable().dashboard_operation_receipts).toBeUndefined();
});

test.each([
    ['ROLLBACK', 'rolled_back'], ['COMMIT', 'unknown'], ['UNKNOWN', 'unknown'], [undefined, 'unknown'], [PRIVATE, 'unknown']
])('rollback completion after first CHECK failure requires its actual command tag %s', async (rollbackTag, transactionOutcome) => {
    const result = await parity({ sql: sql => sql.startsWith('INSERT INTO nofries.dashboard_starter_accounts '), rollbackTag });
    expect(privateEvent(result)).toEqual({ checkpoint: 'starter_account_insert', sqlStateFamily: 'integrity_constraint', transactionOutcome });
});

test('absent, accessor and Proxy control-command tags remain unknown without property access', async () => {
    let getters = 0, traps = 0;
    for (const controlResult of [() => ({ rows: [] }), () => Object.defineProperty({ rows: [] }, 'command', { get() { getters++; return 'COMMIT'; } }),
        () => new Proxy({ rows: [] }, { getOwnPropertyDescriptor() { traps++; throw new Error(PRIVATE); }, get(_target, key) { if (key === 'then') return undefined; traps++; throw new Error(PRIVATE); } })]) {
        const result = await parity({ lateCommitFailure: true, controlResult });
        expect(privateEvent(result).transactionOutcome).toBe('unknown');
    }
    expect(getters).toBe(0); expect(traps).toBe(0);
});

test('production signup-state reports the original runtime failure with its existing support reference and unchanged public response', async () => {
    const request = require('supertest');
    const { customerProductionHarness, signupSql } = require('./helpers/customerProductionHarness');
    require('../api/shared/abuseProtection').resetAbuseProtectionForTests();
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
        const pool = signupSql(), connect = pool.connect; let instanceFailures = 0;
        pool.connect = async () => {
            const client = await connect();
            return { ...client, async query(sql, params) {
                if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { ...await client.query(sql, params), command: sql };
                if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
                if (sql.startsWith('SELECT preparation,activation FROM nofries.dashboard_starter_scopes')) return { rows: [], rowCount: 0 };
                if (sql.includes('FROM nofries.dashboard_runtime_instance')) {
                    instanceFailures++; throw Object.assign(new Error(PRIVATE), { code: '42501', detail: PRIVATE });
                }
                return client.query(sql, params);
            } };
        };
        const h = customerProductionHarness({ starter: true, now: Date.now(), pool });
        const email = 'diagnostic-consultant@example.invalid';
        h.state.directoryUsers = [{ id: h.state.oid, mail: email, userPrincipalName: email, otherMails: [], proxyAddresses: [], userType: 'Member', accountEnabled: true }];
        const start = await h.sameOrigin(request(h.app).post('/api/organisation-setup/request'))
            .send({ email, accountType: 'consultant', organisationName: 'Synthetic diagnostic workspace' });
        expect(start.status).toBe(202);
        const setupCookie = start.headers['set-cookie'][0].split(';')[0];
        const setup = action => h.sameOrigin(request(h.app).post('/api/organisation-setup/' + action))
            .set('Cookie', setupCookie).set('X-NoFries-Setup-Request', start.body.requestId);
        const code = h.state.delivered[0].text.match(/\b[0-9]{8}\b/)[0];
        expect((await setup('verify').send({ code })).body.nextStep).toBe('details_required');
        expect((await setup('details').send({ name: 'Synthetic representative', role: 'Owner', address: 'Synthetic address', registrationId: '', authorityConfirmed: true })).status).toBe(503);
        const authorityEntry = [...h.getContainer('starter-authority').records].find(([key]) => key.startsWith('customer-subjects/'));
        expect(authorityEntry).toBeDefined();
        const authority = JSON.parse(authorityEntry[1].toString());
        const delivery = h.state.delivered.find(value => value.kind === 'member_invitation');
        const invitationToken = delivery.text.match(/#invitation=([A-Za-z0-9_-]{43})/)[1];
        const login = await h.login({ authority, invitationToken }); expect(login.response.status).toBe(303);
        warning.mockClear(); instanceFailures = 0;
        const response = await request(h.app).get('/api/customer-signup/state').set('Cookie', login.cookie);
        expect(instanceFailures).toBe(1); expect(response.status).toBe(503);
        expect(response.body).toEqual({ error: 'Signup is unavailable', code: 'signup_unavailable' });
        const events = warning.mock.calls.map(([line]) => JSON.parse(line)); expect(events).toHaveLength(1);
        expect(events[0]).toEqual({ timestamp: expect.any(String), code: 'signup_state_unavailable', stage: 'organisation_preparation',
            supportReference: response.headers['x-nofries-support-reference'],
            preparation: { checkpoint: 'instance_read', sqlStateFamily: 'access_or_schema', transactionOutcome: 'rolled_back' } });
        expect(events[0].supportReference).toMatch(/^NF-[A-F0-9]{16}$/);
        expect(response.headers['x-nofries-signup-stage']).toBe('workspace_preparation');
        expect(response.headers['x-nofries-signup-reason']).toBe('step_unconfirmed');
        for (const value of [PRIVATE, email, authority.subjectKey, authority.organisationId, invitationToken, login.cookie]) expect(JSON.stringify(events)).not.toContain(value);
        expect(pool.receipts.size).toBe(0); expect(pool.registrations.size).toBe(0);
    } finally { warning.mockRestore(); }
});
