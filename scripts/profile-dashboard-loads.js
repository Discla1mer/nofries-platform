'use strict';

// Opt-in synthetic signed-in HTTP read replay; real application and PostgreSQL.
// Run from the repository revision being measured. All generated databases,
// roles, storage and listeners are cleaned up. No live identity/storage I/O.
// CPU includes this Node process's HTTP client; it excludes PostgreSQL CPU.
// Request sequences follow dashboardLoadWaterfall.test.js; this is not browser TTI.
const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');

function configuration(argv, env) {
    if (!argv.length) return null;
    if (argv.length !== 1 || argv[0] !== '--run-local') throw new Error('Only --run-local is supported; remote and production targets are disabled.');
    let url;
    try { url = new URL(env.NOFRIES_TEST_DATABASE_URL); } catch { throw new Error('An explicit disposable loopback test database is required.'); }
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1' ||
        url.pathname !== '/nofries_ci' || url.search || url.hash ||
        !url.username || env.NOFRIES_PROFILE_DISPOSABLE_CLUSTER !== 'true') {
        throw new Error('Use only nofries_ci on a disposable 127.0.0.1 cluster.');
    }
    const runs = Number(env.NOFRIES_PROFILE_RUNS || 12);
    if (!Number.isSafeInteger(runs) || runs < 1 || runs > 100) throw new Error('Use 1 to 100 measured runs.');
    if (env.NOFRIES_PROFILE_OVERVIEW_BUNDLE && !['true', 'false'].includes(env.NOFRIES_PROFILE_OVERVIEW_BUNDLE)) throw new Error('Invalid bundle option.');
    return { databaseUrl: url.href, runs, bundle: env.NOFRIES_PROFILE_OVERVIEW_BUNDLE === 'true' };
}

// Deny outbound sockets even if a future fixture accidentally calls a real SDK.
// Numeric loopback only: no DNS names, redirects, Unix sockets or proxy fallback.
function localSockets(ports) {
    const net = require('node:net'), original = net.Socket.prototype.connect;
    net.Socket.prototype.connect = function (...args) {
        const input = Array.isArray(args[0]) ? args[0] : args;
        const options = typeof input[0] === 'object' ? input[0] : { port: input[0], host: input[1] };
        if (options.host !== '127.0.0.1' || options.path || !ports.has(Number(options.port))) {
            throw new Error('Journey network destination denied.');
        }
        return original.apply(this, args);
    };
    return () => { net.Socket.prototype.connect = original; };
}

async function cleanupAll(tasks) {
    let ok = true;
    for (const task of tasks.reverse()) {
        try { await task(); } catch { ok = false; }
    }
    return ok;
}

async function profileDashboardLoads(config) {
    // Validate again at the execution boundary; no caller may supply a remote app.
    config = configuration(['--run-local'], { NOFRIES_TEST_DATABASE_URL: config.databaseUrl, NOFRIES_PROFILE_DISPOSABLE_CLUSTER: 'true',
        NOFRIES_PROFILE_RUNS: String(config.runs), NOFRIES_PROFILE_OVERVIEW_BUNDLE: String(config.bundle) });
    const { execFileSync } = require('node:child_process');
    const profile = { revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        node: process.version, runs: config.runs, warmups: 3, bundle: config.bundle, rows: [] };
    const ports = new Set([Number(new URL(config.databaseUrl).port || 5432)]);
    const restoreSockets = localSockets(ports), cleanup = [], steps = [];
    let current, origin, h, server;
    const step = async (name, work) => {
        current = { name, ok: false }; steps.push(current);
        await work();
        current.ok = true;
    };
    try {
        const { Pool } = require(require.resolve('pg', { paths: [process.cwd()] }));
        const request = require(require.resolve('supertest', { paths: [process.cwd()] }));
        const { trackPoolClientEnds } = require(process.cwd() + '/test/helpers/postgresPoolLifecycle');
        const { customerProductionHarness } = require(process.cwd() + '/test/helpers/customerProductionHarness');
        const { applyMigrations } = require(process.cwd() + '/scripts/db-migrate');
        const { createPostgresDashboardMaintenanceRepository } = require(process.cwd() + '/api/shared/appLifecycle/postgresDashboardRuntimeRepository');
        const { hash } = require(process.cwd() + '/api/shared/appLifecycle/dashboardRuntimeRecords');
        const { allResponses, createCommand, saveCommand, submitCommand } = require(process.cwd() + '/test/fixtures/ncscAssessmentFixture');
        const pool = url => new Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
        let counter = null;
        const key = randomBytes(8).toString('hex'), db = 'nf_profile_' + key, role = 'nf_profile_' + key;
        let owner, runtime;
        await step('prepare isolated local stack', async () => {
            const control = pool(config.databaseUrl); cleanup.push(trackPoolClientEnds(control));
            await control.query(`CREATE DATABASE ${db}`);
            cleanup.push(async () => {
                await control.query(`DROP DATABASE ${db}`);
                assert.equal((await control.query('SELECT 1 FROM pg_database WHERE datname=$1', [db])).rowCount, 0);
            });
            const ownerUrl = new URL(config.databaseUrl); ownerUrl.pathname = '/' + db;
            owner = pool(ownerUrl.href); cleanup.push(trackPoolClientEnds(owner));
            await applyMigrations({ pool: owner });
            const password = randomBytes(24).toString('hex');
            await control.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT`);
            // Drop role after its database; all cleanup actions are attempted even on failure.
            cleanup.splice(1, 0, async () => {
                await control.query(`DROP ROLE ${role}`);
                assert.equal((await control.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role])).rowCount, 0);
            });
            await control.query(`GRANT nofries_runtime TO ${role} WITH INHERIT FALSE, SET TRUE, ADMIN FALSE`);
            ownerUrl.username = role; ownerUrl.password = password;
            runtime = pool(ownerUrl.href); cleanup.push(trackPoolClientEnds(runtime));
            runtime.on('connect', client => {
                const query = client.query.bind(client);
                client.query = async (...args) => {
                    const measured = counter, started = performance.now();
                    const timeout = typeof args[0] === 'string' && args[0].includes("set_config('statement_timeout'");
                    if (measured) {
                        measured.wire++;
                        if (timeout) measured.timeout++;
                    }
                    try { return await query(...args); }
                    finally { if (measured && timeout) measured.timeoutMs += performance.now() - started; }
                };
            });
            assert.deepEqual((await runtime.query('SELECT rolsuper, rolbypassrls, rolcreaterole FROM pg_roles WHERE rolname=current_user')).rows,
                [{ rolsuper: false, rolbypassrls: false, rolcreaterole: false }]);
            const instanceId = randomUUID(), restoreEpoch = randomUUID(), actorSubjectKey = randomUUID() + ':' + randomUUID();
            const maintenance = createPostgresDashboardMaintenanceRepository({ pool: owner, instanceId,
                clock: () => new Date().toISOString(), newId: randomUUID,
                historyBudget: { maxRecords: 4096, maxBytes: 67108864, maxDurationMs: 60000 },
                readExternalRuntimeEpoch: async () => ({ instanceId, restoreEpoch }),
                authoriseMaintenanceOperation: facts => ['initializeRuntimeInstance', 'enableRuntimeIngress'].includes(facts.operationType)
                    && facts.command.actorSubjectKey === actorSubjectKey });
            const command = before => ({ operationId: randomUUID(), actorSubjectKey, expectedRevision: before?.revision ?? null,
                expectedRecordSha256: before ? hash(before) : null, restoreEpoch,
                evidenceRef: 'synthetic-journey', evidenceSha256: hash('synthetic-journey') });
            const initialized = await maintenance.initializeRuntimeInstance(command());
            await maintenance.enableRuntimeIngress(command(initialized.record));
            h = customerProductionHarness({ pool: runtime, instanceId, restoreEpoch, now: Date.now(), starter: true, external: true });
            h.state.externalOid = randomUUID(); h.state.externalEmail = `synthetic-${key}@example.test`;
            cleanup.push(async () => {
                for (const c of h.state.containers.values()) c.records.clear();
                h.state.containers.clear(); h.state.delivered.length = 0; h.state.authRequests.length = 0;
                assert.equal(h.state.containers.size, 0);
            });
            server = require('node:http').createServer(h.app);
            cleanup.push(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
            await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
            ports.add(server.address().port); origin = `http://127.0.0.1:${server.address().port}`;
        });
        let cookie = '', generation = '', binding, submitted, saved;
        async function call(method, path, body, expected = 200, csrf = '') {
            assert.ok(path.startsWith('/') && !path.startsWith('//'));
            const url = new URL(path, origin); assert.equal(url.origin, origin);
            let req = request(server)[method.toLowerCase()](path).redirects(0).timeout({ response: 10000, deadline: 15000 })
                .set('Cookie', cookie).set('X-NoFries-Dashboard-Generation', generation);
            if (method === 'POST') {
                req = h.sameOrigin(req).set('X-CSRF-Token', csrf);
                if (path === '/api/external-customer-auth/callback') req = req.type('form');
                req = req.send(body);
            }
            const result = await req; assert.equal(result.status, expected); return result;
        }
        async function login() {
            cookie = ''; generation = '';
            const start = await call('GET', '/api/external-customer-auth/login', null, 302);
            cookie = start.headers['set-cookie'][0].split(';')[0];
            // Read the synthetic IdP state; never follow the external Location URL.
            const state = new URL(start.headers.location).searchParams.get('state');
            const callback = await call('POST', '/api/external-customer-auth/callback',
                { code: 'synthetic-managed-code', state }, 303);
            cookie = callback.headers['set-cookie'][0].split(';')[0];
        }
        async function session(returning = false) {
            if (returning) {
                const stale = await call('GET', '/api/dashboard/session', null, 409);
                assert.equal(stale.body.code, 'dashboard_initialization_required');
                await call('POST', '/api/dashboard/session', { operationId: randomUUID() });
            }
            const value = (await call('GET', '/api/dashboard/session')).body;
            assert.equal(value.authenticated, true); assert.equal(value.purpose, 'customer');
            assert.equal(value.accountType, 'company'); generation = value.generation;
            const directory = (await call('GET', '/api/dashboard/organisations')).body;
            assert.equal(directory.bindings.length, 1);
            assert.equal(directory.bindings[0].organisationLabel, 'Synthetic journey company');
            assert.equal(value.selectedBindingId, directory.bindings[0].bindingId);
            if (binding) assert.equal(value.selectedBindingId, binding);
            binding = value.selectedBindingId;
        }
        const assessments = '/api/dashboard/ncsc/assessments';
        const assessmentId = 'profile-' + key;
        async function mutate(command, status = 200) {
            const { action, assessmentId: id, ...body } = command;
            return (await call('POST', assessments + (action === 'create' ? '' : '/' + id + '/' + action),
                action === 'create' ? { assessmentId: id, ...body } : body, status)).body.assessment;
        }
        await step('signup and authenticated company admission', async () => {
            await call('GET', '/signup');
            await call('GET', '/api/dashboard/session', null, 401);
            await login();
            const before = (await call('GET', '/api/external-customer-signup/state')).body;
            assert.equal(before.state.status, 'setup_details');
            const setup = await call('POST', '/api/external-customer-signup/setup', {
                accountType: 'company', organisationName: 'Synthetic journey company',
                details: { name: 'Synthetic Representative', role: 'Owner', address: 'Synthetic address', registrationId: '', authorityConfirmed: true }
            }, 200, before.csrfToken);
            assert.equal(setup.body.state.status, 'continue_authentication');
            await login();
            const terms = (await call('GET', '/api/external-customer-signup/state')).body;
            assert.equal(terms.state.status, 'terms');
            const accepted = await call('POST', '/api/external-customer-signup/terms', {
                accepted: true, ...Object.fromEntries(['termsVersion', 'termsDigest', 'scheduleId', 'scheduleDigest'].map(k => [k, terms.state[k]]))
            }, 200, terms.csrfToken);
            assert.equal(accepted.body.state.status, 'continue_to_dashboard');
            await call('GET', '/dashboard'); await session();
        });
        await step('create first assessment', async () => {
            assert.deepEqual((await call('GET', assessments)).body.assessments, []);
            const created = await mutate(createCommand(assessmentId, 'create-' + key), 201);
            assert.equal(created.revision, 0); assert.equal(created.assessmentId, assessmentId);
        });
        await step('save answers and verify fresh read', async () => {
            const answers = allResponses('yes');
            answers[0] = { ...answers[0], optionId: 'not_applicable', rationale: { text: 'Synthetic journey rationale.' } };
            saved = await mutate(saveCommand(assessmentId, 0, 'save-' + key, answers));
            assert.equal(saved.status, 'in-progress'); assert.equal(saved.responses.length, answers.length);
            for (const answer of answers) assert.deepEqual(saved.responses.find(a => a.itemId === answer.itemId), answer);
            assert.deepEqual((await call('GET', assessments + '/' + assessmentId)).body.assessment, saved);
        });
        await step('submit once and retain results', async () => {
            submitted = await mutate(submitCommand(assessmentId, saved.revision, 'submit-' + key));
            assert.equal(submitted.status, 'submitted'); assert.ok(submitted.submission?.evaluation);
            assert.equal(submitted.submission.evaluation.provenance.assessmentId, assessmentId);
            // An unapproved N/A claim remains provisional; it is not proof of compliance.
            assert.equal(submitted.submission.evaluation.countsCompletion.completionStatus, 'provisional');
            assert.ok(submitted.submission.evaluation.countsCompletion.claimedNotApplicableAtoms > 0);
            assert.equal(submitted.progress.answered, allResponses().length);
            assert.deepEqual(submitted.responses, saved.responses);
            assert.deepEqual((await call('GET', assessments + '/' + assessmentId)).body.assessment, submitted);
        });

        await step('measure signed-in reads', async () => {
            const paths = ['/api/dashboard/session', '/api/dashboard/organisations?limit=50', '/api/dashboard/bootstrap',
                '/api/dashboard/modules/cyber_security', '/api/dashboard/app.js', '/api/dashboard/dashboard.css',
                '/api/dashboard/session', assessments, assessments + '/' + assessmentId];
            const count = config.runs, mode = config.bundle;
            for (let run = -3; run < count; run++) {
                for (const page of ['overview', 'cyber-security']) {
                    const selected = page === 'cyber-security' ? paths.slice(0, -1) : mode
                        ? [...paths.slice(0, -2), '/api/dashboard/modules/overview?view=first-paint'] : paths;
                    for (const path of selected) {
                        counter = { wire: 0, timeout: 0, timeoutMs: 0 };
                        const before = process.cpuUsage();
                        const started = performance.now();
                        const response = await call('GET', path);
                        const elapsed = performance.now() - started;
                        const cpu = process.cpuUsage(before);
                        if (run >= 0) profile.rows.push({ run, page, route: path.replace(assessmentId, ':assessment'),
                            ...counter, ms: elapsed, cpuMs: (cpu.user + cpu.system) / 1000,
                            timing: response.headers['server-timing'] || '' });
                        counter = null;
                    }
                }
            }
            assert.equal(profile.rows.length, count * (mode ? 16 : 17));
        });
    } catch {
        // Never emit assertion bodies, SQL, cookies, codes, redirect URLs or SDK errors.
        if (!current) steps.push({ name: 'prepare isolated local stack', ok: false });
    } finally {
        const ok = await cleanupAll(cleanup);
        steps.push({ name: 'remove synthetic storage, database, role and listener', ok });
        restoreSockets();
    }
    if (!steps.every(s => s.ok)) throw new Error('Local profile failed: ' + steps.filter(s => !s.ok).map(s => s.name).join(', '));
    return profile;
}


async function main() {
    const config = configuration(process.argv.slice(2), process.env);
    if (!config) { process.stdout.write('DISABLED: opt in with --run-local on a disposable local cluster.\n'); return; }
    const warn = console.warn, error = console.error;
    console.warn = console.error = () => {};
    try { process.stdout.write(JSON.stringify(await profileDashboardLoads(config), null, 2) + '\n'); }
    finally { console.warn = warn; console.error = error; }
}
if (require.main === module) main().catch(() => {
    // No assertion bodies, SQL, cookies, redirect URLs or provider errors.
    process.stderr.write('Local dashboard profile failed; no measurements published.\n'); process.exitCode = 1;
});
module.exports = { configuration, profileDashboardLoads };
