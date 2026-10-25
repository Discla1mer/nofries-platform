'use strict';

// A separate direct invocation emits a clearly synthetic native notice after
// the regression command succeeds; node:test output itself uses TAP prefixes.
if (process.argv[2] === '--qualify') {
    if (process.env.GITHUB_EVENT_NAME === 'pull_request' && process.env.GITHUB_JOB === 'application') {
        process.stdout.write('::notice title=Synthetic CI report qualification::application: SYNTHETIC_DIAGNOSTIC; bounded native reporting only; regression tests passed\n');
    }
    process.exit(0);
}
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const Reporter = require('../ci-test-reporter');
const { collect, MAX_OUTPUT_BYTES, MAX_FAILURES } = require('../publish-ci-test-report');
const root = path.resolve(__dirname, '../..');
const SENTINEL = 'PRIVATE_PAYLOAD_MUST_NEVER_ESCAPE';
const binding = { sha: 'a'.repeat(40), run: '123', attempt: '1', scope: 'application' };
const canonical = [...Reporter.suiteIds()][0];
function temporary(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-ci-report-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return directory;
}
function environment(file, scope = 'application') {
    return { GITHUB_SHA: binding.sha, GITHUB_RUN_ID: binding.run, GITHUB_RUN_ATTEMPT: binding.attempt,
        CI_TEST_SCOPE: scope, CI_TEST_REPORT_PATH: file };
}
function report(overrides = {}) {
    return { version: 1, binding, counts: { suites: 1, passed: 0, failed: 1, skipped: 0, todo: 0 }, elapsedMs: 25,
        suites: [{ id: canonical, category: 'TEST_FAILURE', passed: 0, failed: 1, skipped: 0, todo: 0, elapsedMs: 20 }], ...overrides };
}
function publish(file, outcome = 'failure', env = environment(file)) { return collect({ env, outcome, root }); }
function unavailable(result) {
    assert.match(result.summary, /REPORT_UNAVAILABLE/);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(SENTINEL));
    assert.ok(Buffer.byteLength(result.summary + result.annotation) < MAX_OUTPUT_BYTES);
}
function reporter(file) {
    // Isolated state avoids process.env mutation and still exercises callbacks.
    return Object.assign(Object.create(Reporter.prototype), {
        disabled: false, rows: [], started: Date.now(), binding, ids: new Set([canonical]), output: file
    });
}
function result(overrides = {}) {
    const value = { testFilePath: path.join(root, canonical), numPassingTests: 0, numFailingTests: 1,
        numPendingTests: 0, numTodoTests: 0, perfStats: { start: 100, end: 120 }, ...overrides };
    for (const key of ['testResults', 'failureMessage', 'console', 'snapshot']) {
        Object.defineProperty(value, key, { get() { throw new Error(SENTINEL); } });
    }
    return value;
}
function complete(instance, overrides = {}) {
    assert.doesNotThrow(() => instance.onRunComplete(null, { wasInterrupted: false, numTotalTestSuites: instance.rows.length, ...overrides }));
}
test('allowlist covers every independently discovered tracked suite, including dotted basenames', t => {
    const tracked = spawnSync('git', ['ls-files', '-z', '--', 'test'], {
        cwd: root, encoding: 'utf8', timeout: 3000, maxBuffer: Reporter.MAX_BYTES
    });
    assert.equal(tracked.error, undefined); assert.equal(tracked.status, 0);
    // Discover test suffixes independently of the reporter's pathname grammar.
    const expected = tracked.stdout.split('\0').filter(id => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(id));
    const ids = Reporter.suiteIds();
    assert.deepEqual([...ids].sort(), expected.slice().sort());
    const file = path.join(temporary(t), 'complete.json');
    const instance = Object.assign(reporter(file), { ids });
    for (const id of ['test/bundledServicePlan.integration.test.js', 'test/scopingStartup.integration.test.js']) {
        assert.ok(expected.includes(id), 'regression fixture must remain a tracked suite');
        instance.onTestResult(null, result({ testFilePath: path.join(root, id) }));
    }
    complete(instance);
    assert.equal(instance.disabled, false);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(parsed.counts.suites, 2);
    assert.equal(Reporter.validReport(parsed, binding, ids), true);
    assert.match(publish(file).annotation, /bundledServicePlan\.integration\.test\.js: TEST_FAILURE/);
    assert.match(publish(file).annotation, /scopingStartup\.integration\.test\.js: TEST_FAILURE/);
});
test('safe projection ignores poisoned assertion/log getters and emits only approved fields', t => {
    const file = path.join(temporary(t), 'complete.json');
    const instance = reporter(file);
    assert.doesNotThrow(() => instance.onTestResult(null, result()));
    complete(instance);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(Reporter.validReport(parsed, binding, new Set([canonical])), true);
    assert.deepEqual(Object.keys(parsed.suites[0]).sort(), ['id', 'category', 'passed', 'failed', 'skipped', 'todo', 'elapsedMs'].sort());
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), new RegExp(SENTINEL));
    assert.match(publish(file).annotation, new RegExp(`${canonical}: TEST_FAILURE`));
    assert.match(publish(file).summary, /suites=1; passed=0; failed=1/);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});
for (const [label, modify] of [
    ['unknown suite', () => result({ testFilePath: path.join(root, `test/${SENTINEL}.test.js`) })],
    ['control characters', () => result({ testFilePath: path.join(root, `${canonical}\n::error::${SENTINEL}`) })],
    ['outside repository', () => result({ testFilePath: path.join('/tmp', canonical) })],
    ['poisoned allowed getter', () => Object.defineProperty(result(), 'numFailingTests', { get() { throw new Error(SENTINEL); } })],
    ['poisoned runtime getter', () => Object.defineProperty(result(), 'testExecError', { get() { throw new Error(SENTINEL); } })],
    ['invalid counts', () => result({ numFailingTests: Infinity })],
    ['invalid timing', () => result({ perfStats: { start: 100, end: -1 } })]
]) test(`${label} disables evidence without throwing or persisting payload`, t => {
    const file = path.join(temporary(t), 'complete.json');
    const instance = reporter(file);
    assert.doesNotThrow(() => instance.onTestResult(null, modify()));
    complete(instance);
    assert.equal(fs.existsSync(file), false);
    unavailable(publish(file));
});
test('interrupted, incomplete, duplicate and overflowing runs never invent completed evidence', t => {
    const directory = temporary(t);
    for (const mode of ['interrupted', 'incomplete', 'duplicate', 'overflow']) {
        const file = path.join(directory, `${mode}.json`);
        const instance = reporter(file);
        instance.onTestResult(null, result());
        if (mode === 'duplicate') instance.onTestResult(null, result());
        if (mode === 'overflow') { instance.rows = Array(Reporter.MAX_SUITES).fill(instance.rows[0]); instance.onTestResult(null, result()); }
        complete(instance, mode === 'interrupted' ? { wasInterrupted: true } : mode === 'incomplete' ? { numTotalTestSuites: 2 } : {});
        assert.equal(fs.existsSync(file), false);
        unavailable(publish(file));
    }
});
test('exclusive completion does not replace reports or delete an unowned partial', t => {
    const file = path.join(temporary(t), 'complete.json');
    fs.writeFileSync(file, SENTINEL);
    let instance = reporter(file);
    instance.onTestResult(null, result()); complete(instance);
    assert.equal(fs.readFileSync(file, 'utf8'), SENTINEL);
    fs.writeFileSync(`${file}.partial`, SENTINEL);
    instance = reporter(file);
    instance.onTestResult(null, result()); complete(instance);
    assert.equal(fs.readFileSync(`${file}.partial`, 'utf8'), SENTINEL);
});
test('closed categories classify ordinary failures, runtime errors, passes and skips', t => {
    const directory = temporary(t);
    for (const [category, extra] of [
        ['TEST_FAILURE', {}], ['SUITE_FAILURE', { numFailingTests: 0, testExecError: { message: SENTINEL } }],
        ['PASSED', { numFailingTests: 0, numPassingTests: 2 }], ['SKIPPED', { numFailingTests: 0, numPendingTests: 1 }]
    ]) {
        const file = path.join(directory, `${category}.json`);
        const instance = reporter(file);
        instance.onTestResult(null, result(extra)); complete(instance);
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        assert.equal(parsed.suites[0].category, category);
        assert.doesNotMatch(fs.readFileSync(file, 'utf8'), new RegExp(SENTINEL));
    }
});
test('publisher rejects malformed, oversized, missing, symlink and unexpected reports', t => {
    const directory = temporary(t), file = path.join(directory, 'report.json');
    unavailable(publish(file));
    for (const source of ['{', SENTINEL, JSON.stringify({ ...report(), [SENTINEL]: SENTINEL }), ' '.repeat(Reporter.MAX_BYTES + 1)]) {
        fs.writeFileSync(file, source); unavailable(publish(file));
    }
    fs.unlinkSync(file);
    const target = path.join(directory, 'target.json'); fs.writeFileSync(target, JSON.stringify(report())); fs.symlinkSync(target, file);
    unavailable(publish(file));
    unavailable(publish(directory));
    unavailable(collect({ get env() { throw new Error(SENTINEL); } }));
});
test('publisher binds source/run/attempt/scope, outcome and exact numeric schema', t => {
    const file = path.join(temporary(t), 'report.json');
    for (const mutate of [
        value => { value.binding = { ...binding, sha: 'b'.repeat(40) }; },
        value => { value.binding = { ...binding, run: '124' }; },
        value => { value.binding = { ...binding, attempt: '2' }; },
        value => { value.binding = { ...binding, scope: 'postgres' }; },
        value => { value.binding = { ...binding, scope: SENTINEL }; },
        value => { value.suites[0].id = `test/${SENTINEL}.test.js`; },
        value => { value.suites[0].category = SENTINEL; },
        value => { value.suites[0].category = 'PASSED'; },
        value => { value.suites[0].failed = -1; },
        value => { value.suites[0].failed = '1'; },
        value => { value.suites[0].elapsedMs = 86400001; },
        value => { value.counts.failed = 2; },
        value => { value.suites.push(value.suites[0]); value.counts.suites = 2; value.counts.failed = 2; }
    ]) {
        const value = report(); mutate(value); fs.writeFileSync(file, JSON.stringify(value)); unavailable(publish(file));
    }
    fs.writeFileSync(file, JSON.stringify(report()));
    for (const outcome of ['cancelled', 'skipped', '', 'success', SENTINEL]) unavailable(publish(file, outcome));
    for (const invalid of ['0', SENTINEL, '1\n']) unavailable(publish(file, 'failure', { ...environment(file), GITHUB_RUN_ID: invalid }));
});
test('passing observations have counts and no error annotation; failed steps cannot reuse them', t => {
    const file = path.join(temporary(t), 'report.json');
    const instance = reporter(file); instance.onTestResult(null, result({ numPassingTests: 1, numFailingTests: 0 })); complete(instance);
    const published = publish(file, 'success'); assert.equal(published.annotation, ''); assert.match(published.summary, /passed=1; failed=0/);
    unavailable(publish(file, 'failure'));
});
test('all currently tracked suites fit persistence bounds and passing native output stays small', t => {
    const file = path.join(temporary(t), 'report.json');
    const ids = [...Reporter.suiteIds()];
    const value = report({ suites: ids.map(id => ({ id, category: 'PASSED', passed: 40, failed: 0, skipped: 0, todo: 0, elapsedMs: 1000 })) });
    value.counts = { suites: ids.length, passed: ids.length * 40, failed: 0, skipped: 0, todo: 0 };
    const json = JSON.stringify(value); assert.ok(Buffer.byteLength(json) < Reporter.MAX_BYTES);
    fs.writeFileSync(file, json);
    const published = publish(file, 'success'); assert.equal(published.annotation, ''); assert.doesNotMatch(published.summary, /UNAVAILABLE|TRUNCATED/);
    assert.ok(Buffer.byteLength(published.summary) < 1024);
});
test('nonregular FIFO input cannot block the publisher read', t => {
    if (process.platform === 'win32') { t.skip('POSIX runner probe'); return; }
    const fifo = path.join(temporary(t), 'pipe');
    assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
    const child = spawnSync(process.execPath, ['-e',
        'try { require(process.argv[1]).readBounded(process.argv[2]); process.exit(2); } catch { process.exit(0); }',
        path.join(root, 'scripts/ci-test-reporter.js'), fifo], { timeout: 2000, encoding: 'utf8' });
    assert.equal(child.error, undefined); assert.equal(child.status, 0); assert.equal(child.stdout + child.stderr, '');
});
test('native output is capped even for many failures', t => {
    const file = path.join(temporary(t), 'report.json');
    const ids = [...Reporter.suiteIds()].slice(0, MAX_FAILURES + 1);
    assert.ok(ids.length > MAX_FAILURES);
    const value = report({ suites: ids.map(id => ({ id, category: 'TEST_FAILURE', passed: 0, failed: 1, skipped: 0, todo: 0, elapsedMs: 1 })) });
    value.counts.suites = ids.length; value.counts.failed = ids.length;
    fs.writeFileSync(file, JSON.stringify(value));
    const published = publish(file); assert.match(published.summary, /TRUNCATED/);
    assert.equal(published.summary.split('| TEST_FAILURE |').length - 1, MAX_FAILURES);
    assert.ok(Buffer.byteLength(published.summary + published.annotation) <= MAX_OUTPUT_BYTES);
});
test('unloadable publisher emits only the fixed launcher fallback; qualification is explicitly synthetic', t => {
    const fixture = temporary(t);
    fs.copyFileSync(path.join(root, 'scripts/publish-ci-test-report.js'), path.join(fixture, 'publish.js'));
    const child = spawnSync(process.execPath, [path.join(fixture, 'publish.js')], { encoding: 'utf8', env: environment(path.join(fixture, 'absent')) });
    assert.equal(child.status, 0); assert.equal(child.stderr, ''); unavailable({ summary: child.stdout, annotation: '' });
    const regression = path.join(__dirname, 'ci-test-reporting.cjs');
    const qualify = env => spawnSync(process.execPath, [regression, '--qualify'], { encoding: 'utf8', env }).stdout;
    assert.match(qualify({ GITHUB_EVENT_NAME: 'pull_request', GITHUB_JOB: 'application' }), /^::notice title=Synthetic CI report qualification::/);
    assert.equal(qualify({ GITHUB_EVENT_NAME: 'push', GITHUB_JOB: 'application' }), '');
    assert.equal(qualify({ GITHUB_EVENT_NAME: 'pull_request', GITHUB_JOB: 'verification' }), '');
});
test('actual workflow commands preserve npm status, selectors and additive reporters through launcher fallback', t => {
    const fixture = temporary(t), bin = path.join(fixture, 'bin');
    fs.mkdirSync(bin); fs.mkdirSync(path.join(fixture, 'scripts'));
    fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$NPM_ARGUMENT_TRACE"\nexit "$NPM_PROBE_STATUS"\n', { mode: 0o700 });
    const workflow = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
    const command = name => {
        const step = workflow.split(`      - name: ${name}\n`)[1].split('\n      - ')[0];
        return step.split('        run: |\n')[1].split('\n').map(line => line.replace(/^          /, '')).join('\n');
    };
    const application = command('Run selected application coverage with full fallback');
    const postgres = command('Run PostgreSQL repository and RLS tests');
    const trace = path.join(fixture, 'args.txt');
    const launch = (script, profile, status) => spawnSync('bash', ['--noprofile', '--norc', '-c', script], {
        cwd: fixture, encoding: 'utf8', timeout: 5000,
        env: { PATH: `${bin}${path.delimiter}${process.env.PATH}`, PRESENTATION_PROFILE: profile,
            NPM_ARGUMENT_TRACE: trace, NPM_PROBE_STATUS: String(status) }
    });
    for (const available of [false, true]) {
        fs.writeFileSync(path.join(fixture, 'scripts/ci-test-reporter.js'), available ? 'module.exports = class {};\n' : `throw Error('${SENTINEL}');\n`);
        for (const script of [application, postgres]) for (const status of [0, 7]) {
            const child = launch(script, 'full', status);
            assert.equal(child.status, status); assert.equal(child.stderr, ''); assert.doesNotMatch(child.stdout, new RegExp(SENTINEL));
            const args = fs.readFileSync(trace, 'utf8').trim().split('\n');
            if (script === application) assert.deepEqual(args.slice(0, 4), ['run', 'test:ci', '--', '--testSequencer=./scripts/ci-journey-sequencer.js']);
            else assert.deepEqual(args.slice(0, 7), ['run', 'test:postgres', '--', 'test/dashboardManagedCatalog.test.js',
                'test/dashboardManagedCapabilities.test.js', 'test/dashboardRuntimeBootstrap.test.js', 'test/dashboardPitrRuntime.test.js']);
            assert.equal(args.includes('--reporters=default'), available);
            assert.equal(args.includes('--reporters=./scripts/ci-test-reporter.js'), available);
        }
    }
    const presentation = launch(application, 'presentation', 0); assert.equal(presentation.status, 0);
    const args = fs.readFileSync(trace, 'utf8').trim().split('\n');
    assert.deepEqual(args.slice(0, 4), ['run', 'test:ci', '--', '--runTestsByPath']);
    assert.deepEqual(args.slice(4, -2), ['test/customerSignupJourney.test.js', 'test/signupDocument.test.js',
        'test/customerProviderCoexistence.test.js', 'test/hostedCustomerEntry.test.js', 'test/dashboardLoader.test.js',
        'test/dashboardDocument.test.js', 'test/dashboardPackaging.test.js', 'test/customerSetupAccountChange.test.js',
        'test/externalCustomerAdmission.test.js', 'test/customerSignupClient.test.js']);
    for (const profile of ['documentation', 'presentation']) {
        fs.unlinkSync(trace); assert.equal(launch(postgres, profile, 7).status, 0); assert.equal(fs.existsSync(trace), false);
        fs.writeFileSync(trace, 'reset');
    }
});
test('real locked Jest keeps default output, suite counts and success/failure exit with broken diagnostics', { timeout: 120000 }, t => {
    let jestPackage;
    try { jestPackage = require.resolve('jest/package.json'); } catch { t.skip('locked Jest dependency is not installed'); return; }
    const fixture = temporary(t);
    fs.mkdirSync(path.join(fixture, 'test')); fs.mkdirSync(path.join(fixture, 'scripts'));
    fs.copyFileSync(path.join(root, 'scripts/ci-test-reporter.js'), path.join(fixture, 'scripts/ci-test-reporter.js'));
    fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ name: 'synthetic-report-test', jest: { testEnvironment: 'node' } }));
    const suite = path.join(fixture, 'test/synthetic.test.js');
    fs.writeFileSync(suite, "test('synthetic success', () => expect(1).toBe(1)); test.skip('skip', () => {}); test.todo('todo');\n");
    for (const args of [['init', '-q'], ['add', 'test/synthetic.test.js']]) {
        const git = spawnSync('git', args, { cwd: fixture, encoding: 'utf8' }); assert.equal(git.status, 0);
    }
    const jest = path.join(path.dirname(jestPackage), 'bin/jest.js');
    assert.equal(require(jestPackage).version, JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).devDependencies.jest);
    const run = (name, extra = [], output = path.join(fixture, `${name}.json`)) => {
        const child = spawnSync(process.execPath, [jest, '--runInBand', '--no-cache', '--reporters=default',
            '--reporters=./scripts/ci-test-reporter.js', ...extra], { cwd: fixture, encoding: 'utf8', timeout: 30000,
            env: { ...process.env, ...environment(output), CI: '1', NO_COLOR: '1' }, maxBuffer: 1024 * 1024 });
        assert.equal(child.error, undefined); assert.equal(child.signal, null);
        return { ...child, report: fs.existsSync(output) ? JSON.parse(fs.readFileSync(output, 'utf8')) : null };
    };
    const passed = run('passed'); assert.equal(passed.status, 0); assert.match(passed.stderr, /PASS test\/synthetic.test.js/);
    assert.deepEqual(passed.report.counts, { suites: 1, passed: 1, failed: 0, skipped: 1, todo: 1 });
    fs.appendFileSync(suite, `test('${SENTINEL}', () => expect('${SENTINEL}').toBe('different'));\n`);
    const failed = run('failed'); assert.equal(failed.status, 1); assert.equal(failed.report.counts.failed, 1);
    assert.doesNotMatch(JSON.stringify(failed.report), new RegExp(SENTINEL));
    fs.writeFileSync(path.join(fixture, 'test/runtime.test.js'), `throw Error('${SENTINEL}');\n`);
    fs.writeFileSync(path.join(fixture, 'test/skipped.test.js'), "test.skip('skipped suite', () => {});\n");
    assert.equal(spawnSync('git', ['add', 'test/runtime.test.js', 'test/skipped.test.js'], { cwd: fixture }).status, 0);
    const runtime = run('runtime'); assert.equal(runtime.status, 1); assert.equal(runtime.report.counts.suites, 3);
    assert.equal(runtime.report.suites.find(row => row.id === 'test/runtime.test.js').category, 'SUITE_FAILURE');
    assert.equal(runtime.report.suites.find(row => row.id === 'test/skipped.test.js').category, 'SKIPPED');
    assert.doesNotMatch(JSON.stringify(runtime.report), new RegExp(SENTINEL));
    fs.unlinkSync(path.join(fixture, 'test/runtime.test.js')); fs.unlinkSync(path.join(fixture, 'test/skipped.test.js'));
    assert.equal(run('unwritable-failed', [], path.join(fixture, 'missing', 'report.json')).status, 1);
    fs.writeFileSync(suite, "test('success', () => expect(true).toBe(true));\n");
    assert.equal(run('unwritable-success', [], path.join(fixture, 'missing', 'report.json')).status, 0);
    // Execute the same quiet module-load guard used by the workflow.
    fs.writeFileSync(path.join(fixture, 'scripts/ci-test-reporter.js'), `throw new Error('${SENTINEL}');\n`);
    const launch = `set -euo pipefail\nreporter_args=()\nif node -e 'try { if (typeof require("./scripts/ci-test-reporter") !== "function") process.exit(1); } catch { process.exit(1); }' >/dev/null 2>&1; then\nreporter_args=(--reporters=default --reporters=./scripts/ci-test-reporter.js)\nfi\nnode "$JEST_PROBE_PATH" --runInBand --no-cache "\${reporter_args[@]}"`;
    const fallback = () => spawnSync('bash', ['--noprofile', '--norc', '-c', launch], { cwd: fixture, encoding: 'utf8', timeout: 30000,
        env: { ...process.env, JEST_PROBE_PATH: jest, CI: '1', NO_COLOR: '1' }, maxBuffer: 1024 * 1024 });
    assert.equal(fallback().status, 0);
    fs.appendFileSync(suite, "test('failure', () => expect(false).toBe(true));\n");
    const blocked = fallback(); assert.equal(blocked.status, 1); assert.doesNotMatch(blocked.stdout + blocked.stderr, new RegExp(SENTINEL));
});
