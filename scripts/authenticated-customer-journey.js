'use strict';

// Opt-in, local-only HTTP journey. This is not a live identity/mail acceptance test.
const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');

function configuration(argv, env) {
    if (!argv.length) return null;
    if (argv.length !== 1 || argv[0] !== '--run-local') throw new Error('Only --run-local is supported; remote and production targets are disabled.');
    let url;
    try { url = new URL(env.NOFRIES_JOURNEY_DATABASE_URL); } catch { throw new Error('A dedicated local journey database is required.'); }
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1' ||
        url.pathname !== '/nofries_journey' || url.search || url.hash ||
        !url.username || env.NOFRIES_JOURNEY_DISPOSABLE_CLUSTER !== 'true') {
        throw new Error('Use only the dedicated disposable loopback nofries_journey cluster.');
    }
    return { databaseUrl: url.href };
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

function formatReport(report) {
    return ['Mode: OPT-IN LOCAL AUTHENTICATED HTTP JOURNEY (synthetic providers; real application and PostgreSQL).',
        ...report.steps.flatMap((s, i) => [`${s.ok ? 'PASS' : 'FAIL'} step ${i + 1}: ${s.name}`,
            ...s.probes.map(p => `  ${p.method} ${p.url} -> ${p.status ? 'HTTP ' + p.status : 'NETWORK/TIMEOUT failure'}`)]),
        `${report.ok ? 'PASS' : 'FAIL'} authenticated customer journey: ${report.steps.filter(s => s.ok).length}/${report.steps.length} checks passed.`].join('\n') + '\n';
}

async function runLocalJourney(config, { failAfter = null } = {}) {
    // Validate again at the execution boundary; no caller may supply a remote app.
    configuration(['--run-local'], { NOFRIES_JOURNEY_DATABASE_URL: config.databaseUrl, NOFRIES_JOURNEY_DISPOSABLE_CLUSTER: 'true' });
    const ports = new Set([Number(new URL(config.databaseUrl).port || 5432)]);
    const restoreSockets = localSockets(ports), cleanup = [], steps = [];
    let current, origin, h, server;
    const step = async (name, work) => {
        current = { name, probes: [], ok: false }; steps.push(current);
        await work();
        if (name === failAfter) throw new Error('Synthetic journey failure.');
        current.ok = true;
    };
    try {
        const { Pool } = require('pg');
        const request = require('supertest');
        const { trackPoolClientEnds } = require('../test/helpers/postgresPoolLifecycle');
        const { customerProductionHarness } = require('../test/helpers/customerProductionHarness');
        const { applyMigrations } = require('./db-migrate');
        const { createPostgresDashboardMaintenanceRepository } = require('../api/shared/appLifecycle/postgresDashboardRuntimeRepository');
        const { hash } = require('../api/shared/appLifecycle/dashboardRuntimeRecords');
        const { allResponses, createCommand, saveCommand, submitCommand } = require('../test/fixtures/ncscAssessmentFixture');
        const pool = url => new Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
        const key = randomBytes(8).toString('hex'), db = 'nf_journey_' + key, role = 'nf_journey_' + key;
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
        let cookie = '', generation = '', binding, submitted, saved, draft;
        async function call(method, path, body, expected = 200, csrf = '') {
            assert.ok(path.startsWith('/') && !path.startsWith('//'));
            const url = new URL(path, origin); assert.equal(url.origin, origin);
            const probe = { method, url: url.origin + url.pathname, status: 0 }; current.probes.push(probe);
            let req = request(server)[method.toLowerCase()](path).redirects(0).timeout({ response: 10000, deadline: 15000 })
                .set('Cookie', cookie).set('X-NoFries-Dashboard-Generation', generation);
            if (method === 'POST') {
                req = h.sameOrigin(req).set('X-CSRF-Token', csrf);
                if (path === '/api/external-customer-auth/callback') req = req.type('form');
                req = req.send(body);
            }
            const result = await req; probe.status = result.status; assert.equal(result.status, expected); return result;
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
        const assessmentId = 'journey-' + key, draftId = 'draft-' + key;
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
        await step('save a second draft for return and resume', async () => {
            await mutate(createCommand(draftId, 'draft-create-' + key), 201);
            draft = await mutate(saveCommand(draftId, 0, 'draft-save-' + key, allResponses().slice(0, 3)));
            assert.equal(draft.progress.answered, 3);
        });
        await step('sign out and reject revoked session', async () => {
            await call('POST', '/api/dashboard/logout', {});
            // Replay the old cookie deliberately: clearing a client jar is insufficient.
            await call('GET', '/api/dashboard/session', null, 401);
            await call('GET', assessments + '/' + assessmentId, null, 401);
            cookie = ''; generation = '';
            await call('GET', '/api/dashboard/session', null, 401);
        });
        await step('return with fresh login and recover identical results', async () => {
            await call('GET', '/login'); await login(); await session(true);
            assert.deepEqual((await call('GET', assessments + '/' + assessmentId)).body.assessment, submitted);
            assert.deepEqual((await call('GET', assessments + '/' + draftId)).body.assessment, draft);
        });
        await step('resume and save the same draft', async () => {
            const resumed = await mutate(saveCommand(draftId, draft.revision, 'resume-' + key, [allResponses('no')[3]]));
            assert.equal(resumed.revision, draft.revision + 1); assert.equal(resumed.progress.answered, 4);
            for (const answer of draft.responses) assert.deepEqual(resumed.responses.find(a => a.itemId === answer.itemId), answer);
            assert.deepEqual((await call('GET', assessments + '/' + draftId)).body.assessment, resumed);
            await call('POST', '/api/dashboard/logout', {});
        });
    } catch {
        // Never emit assertion bodies, SQL, cookies, codes, redirect URLs or SDK errors.
        if (!current) steps.push({ name: 'prepare isolated local stack', probes: [], ok: false });
    } finally {
        const ok = await cleanupAll(cleanup);
        steps.push({ name: 'remove synthetic storage, database, role and listener', probes: [], ok });
        restoreSockets();
    }
    return { ok: steps.every(s => s.ok), steps };
}

async function main() {
    const config = configuration(process.argv.slice(2), process.env);
    if (!config) { process.stdout.write('DISABLED: opt in with --run-local on a disposable local cluster.\n'); return; }
    // Application warnings can contain provider details; only the bounded report is emitted.
    const warn = console.warn, error = console.error;
    console.warn = console.error = () => {};
    try {
        const report = await runLocalJourney(config);
        process.stdout.write(formatReport(report)); process.exitCode = report.ok ? 0 : 1;
    } finally { console.warn = warn; console.error = error; }
}
if (require.main === module) main().catch(() => { process.stderr.write('FAIL arguments: use --run-local with a dedicated disposable loopback database; production is disabled.\n'); process.exitCode = 2; });
module.exports = { configuration, localSockets, cleanupAll, runLocalJourney, formatReport };
