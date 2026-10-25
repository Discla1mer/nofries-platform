'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const yaml = require('js-yaml');
const { PRIORITY_SUITES, assertComplete, prioritizeSuites } = require('../ci-journey-order');

const root = path.resolve(__dirname, '../..');
const suite = relative => ({ path: path.join(root, relative), context: { config: { rootDir: root } } });
const documentationGuard = "steps.presentation_scope.outputs.profile != 'documentation'";

test('journey/isolation suites precede slow unrelated suites without losing default relative order', () => {
    const slow = suite('test/unrelatedSlow.test.js'), journey = suite(PRIORITY_SUITES[0]);
    const newSuite = suite('new-component/new-feature.test.js'), isolation = suite(PRIORITY_SUITES[7]);
    const input = [slow, journey, newSuite, isolation];
    assert.deepEqual(prioritizeSuites(input, root), [journey, isolation, slow, newSuite]);
    assert.deepEqual(input, [slow, journey, newSuite, isolation]);
});

test('all configured priority paths exist in this repository', () => {
    assert.equal(new Set(PRIORITY_SUITES).size, PRIORITY_SUITES.length);
    for (const file of PRIORITY_SUITES) assert.equal(fs.statSync(path.join(root, file)).isFile(), true, file);
});

test('new, unknown and outside-root suites remain present', () => {
    const unknown = suite('test/newTenantIsolation.test.js');
    const outside = { path: path.resolve(root, '../test/customerProductionJourney.test.js') };
    const input = [unknown, outside, suite(PRIORITY_SUITES[2])];
    const output = prioritizeSuites(input, root);
    assertComplete(input, output);
    assert.deepEqual(output.slice(1), [unknown, outside]);
});

test('focused runs without a priority suite and empty runs preserve their exact input', () => {
    const input = [suite('test/unrelated.test.js')];
    assert.deepEqual(prioritizeSuites(input, root), input);
    assert.deepEqual(prioritizeSuites([], root), []);
});

test('an already prioritised run preserves default ordering and suite identities', () => {
    const input = [suite(PRIORITY_SUITES[3]), suite(PRIORITY_SUITES[1]), suite('test/other.test.js')];
    const output = prioritizeSuites(input, root);
    input.forEach((entry, index) => assert.equal(output[index], entry));
});

for (const [label, change] of [
    ['dropped suite', input => input.slice(1)],
    ['duplicated suite', input => [input[0], input[0]]],
    ['added suite', input => [...input, suite('test/unexpected.test.js')]],
    ['replaced object at the same path', input => [input[0], { ...input[1] }]],
    ['unexpected path', input => [input[0], suite('test/unexpected.test.js')]]
]) {
    test(`completeness rejects ${label}`, () => {
        const input = [suite('test/a.test.js'), suite('test/b.test.js')];
        assert.throws(() => assertComplete(input, change(input)), /CI suite ordering/);
    });
}

for (const invalid of [undefined, [null], [{ path: '' }], [{ path: 123 }]]) {
    test(`invalid discovery fails closed: ${JSON.stringify(invalid)}`, () => {
        assert.throws(() => prioritizeSuites(invalid, root), /CI suite/);
    });
}

test('duplicate discovered paths fail closed even when objects differ', () => {
    assert.throws(() => prioritizeSuites([suite('test/a.test.js'), suite('test/a.test.js')], root), /duplicate/);
});

test('relative and invalid repository roots fail closed', () => {
    for (const invalid of ['.', '', undefined]) {
        assert.throws(() => prioritizeSuites([suite('test/a.test.js')], invalid), /absolute repository root/);
    }
});

test('simulated POSIX roots keep exact path matching without similar-name selection', () => {
    const input = [{ path: '/workspace/test/other.test.js' },
        { path: '/workspace/test/customerProductionJourney.test.js' },
        { path: '/workspace/test/customerProductionJourney.test.js.backup' }];
    assert.deepEqual(prioritizeSuites(input, '/workspace'), [input[1], input[0], input[2]]);
});

test('simulated Windows paths with spaces and mixed separators preserve completeness', () => {
    const input = [{ path: 'C:\\work space\\test\\other.test.js' },
        { path: 'C:/work space/test/customerProductionJourney.test.js' }];
    assert.deepEqual(prioritizeSuites(input, 'C:\\work space'), [input[1], input[0]]);
});

test('priority tests exercise actual save, logout, fresh return and tenant boundaries', () => {
    const journey = fs.readFileSync(path.join(root, 'test/customerProductionJourney.test.js'), 'utf8');
    assert.match(journey, /logout/i);
    assert.match(journey, /resume|return/i);
    assert.match(journey, /assessment/i);
    assert.match(journey, /tenant|organisation/i);
});

function ciStep(source, command, condition) {
    const matches = source.split(/\r?\n      - /).slice(1).filter(step =>
        typeof command === 'string' ? step.includes(command) : command.test(step));
    assert.equal(matches.length, 1, `Expected one CI step for ${command}`);
    const conditions = [...matches[0].matchAll(/^        if:(.*)$/gm)].map(match => match[1].trim());
    assert.deepEqual(conditions, condition === undefined ? [] : [condition], `Unexpected CI condition: ${command}`);
    return matches[0];
}

test('CI retains complete discovery as the fallback and unconditional final-source gates', () => {
    const ci = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
    const full = ciStep(ci, 'npm run test:ci');
    ciStep(ci, 'node --test scripts/tests/ci-journey-order.cjs', documentationGuard);
    assert.match(full, /npm run test:ci -- --testSequencer=\.\/scripts\/ci-journey-sequencer\.js/);
    assert.doesNotMatch(full, /--(?:bail|passWithNoTests|onlyChanged|findRelatedTests|shard|testPathIgnorePatterns|testNamePattern)/);
    for (const command of ['npm run test:postgres', 'npm run validate:governance',
        'node scripts/validate-nonproduction-release.js', 'npm run validate:dynamic-production-launch',
        'npm run validate:unified-production-release', /^run: npm run build$/,
        'Build isolated App Service runtime package', 'npm run check:syntax']) {
        ciStep(ci.replaceAll('\r\n', '\n'), command);
    }
    for (const command of [/^run: npm run eval:prospect$/m, 'Run locked Promptfoo application-path suite']) {
        ciStep(ci.replaceAll('\r\n', '\n'), command, documentationGuard);
    }
    assert.equal((ciStep(ci, 'Verify repeatable PostgreSQL migrations').match(/npm run db:migrate/g) || []).length, 2);
    assert.match(ci, /^  test:/m);
    assert.match(ci, /^  contents: read$/m);
    assert.match(ci, /timeout-minutes: 30/);
    assert.doesNotMatch(ci, /^\s+paths(?:-ignore)?:/m);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert.equal(manifest.scripts['test:ci'], 'jest --runInBand');
    assert.match(manifest.scripts.verify, /npm run test:ci/);
    for (const release of ['release-production.yml', 'release-dynamic-production.yml']) {
        assert.doesNotMatch(fs.readFileSync(path.join(root, '.github/workflows', release), 'utf8'), /ci-journey/);
    }
});

function ciWorkflow() {
    return yaml.load(fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8'));
}

test('CI gives all mandatory work bounded budgets behind the existing strict aggregate', () => {
    const workflow = ciWorkflow();
    assert.deepEqual(workflow.permissions, { contents: 'read' });
    assert.deepEqual(Object.keys(workflow.jobs).sort(), ['application', 'test', 'verification']);
    const expectedTimeouts = { application: 60, verification: 30, test: 30 };
    for (const [jobName, job] of Object.entries(workflow.jobs)) {
        assert.equal(job['runs-on'], 'ubuntu-latest');
        assert.equal(job['timeout-minutes'], expectedTimeouts[jobName], jobName);
        assert.equal(job.permissions, undefined);
        assert.equal(job['continue-on-error'], undefined);
        assert.equal(job.strategy, undefined);
        for (const step of job.steps) assert.equal(step['continue-on-error'], undefined);
    }
    const { application, verification, test: aggregate } = workflow.jobs;
    for (const job of [application, verification]) {
        assert.equal(job.if, undefined, 'Required execution jobs cannot be conditionally skipped');
        assert.equal(job.needs, undefined, 'Execution budgets must be independent');
    }
    assert.equal(application.services, undefined);
    assert.ok(verification.services.postgres);
    assert.deepEqual(aggregate.needs.slice().sort(), Object.keys(workflow.jobs).filter(key => key !== 'test').sort());
    assert.equal(aggregate.if, '${{ always() }}');
    assert.equal(aggregate.name, undefined, 'Preserve the existing required check name');
    assert.equal(aggregate.steps.length, 1);
    assert.equal(aggregate.steps[0].if, undefined);
    assert.equal(aggregate.steps[0].shell, 'bash');
    assert.deepEqual(aggregate.steps[0].env, {
        VERIFICATION_RESULT: '${{ needs.verification.result }}',
        APPLICATION_RESULT: '${{ needs.application.result }}'
    });

    const findVerification = predicate => {
        const matches = verification.steps.filter(predicate);
        assert.equal(matches.length, 1);
        return matches[0];
    };
    const selectedApplication = application.steps.find(step => step.name === 'Run selected application coverage with full fallback');
    assert.ok(selectedApplication);
    assert.equal(selectedApplication.shell, 'bash');
    assert.deepEqual(selectedApplication.env, {
        PRESENTATION_PROFILE: '${{ steps.presentation_scope.outputs.profile }}',
        CI_TEST_SCOPE: 'application',
        CI_TEST_REPORT_PATH: '${{ runner.temp }}/ci-test-application-${{ github.run_id }}-${{ github.run_attempt }}.json'
    });
    assert.match(selectedApplication.run, /if \[\[ "\$\{PRESENTATION_PROFILE:-\}" == documentation \]\]; then\n\s+node --test \.github\/scripts\/ci-documentation-scope-regressions\.cjs\nelif \[\[ "\$\{PRESENTATION_PROFILE:-\}" == presentation \]\]; then/);
    assert.match(selectedApplication.run, /else\n\s+npm run test:ci -- --testSequencer=\.\/scripts\/ci-journey-sequencer\.js "\$\{reporter_args\[@\]\}"\nfi/);
    const diagnosticsRegression = application.steps.find(step => step.name === 'Validate bounded CI evidence');
    assert.deepEqual(diagnosticsRegression, {
        name: 'Validate bounded CI evidence',
        if: documentationGuard,
        run: 'node --test --test-concurrency=1 scripts/tests/ci-test-reporting.cjs scripts/tests/release-batch.cjs\nnode scripts/tests/ci-test-reporting.cjs --qualify\n'
    });
    const diagnosticsPublisher = application.steps.find(step => step.name === 'Publish bounded application test diagnostics');
    assert.equal(diagnosticsPublisher.if, "always() && steps.presentation_scope.outputs.profile != 'documentation'");
    assert.equal(diagnosticsPublisher.shell, 'bash');
    assert.deepEqual(diagnosticsPublisher.env, {
        CI_TEST_SCOPE: 'application',
        CI_TEST_REPORT_PATH: selectedApplication.env.CI_TEST_REPORT_PATH,
        CI_TEST_OUTCOME: '${{ steps.application_tests.outcome }}'
    });
    assert.match(diagnosticsPublisher.run, /node scripts\/publish-ci-test-report.js 2>\/dev\/null/);
    assert.match(diagnosticsPublisher.run, /application: REPORT_UNAVAILABLE/);
    assert.deepEqual(application.steps, [
        findVerification(step => step.uses?.startsWith('actions/checkout@')),
        findVerification(step => step.name === 'Reject committed dependencies and environment secrets'),
        findVerification(step => step.uses?.startsWith('actions/setup-node@')),
        findVerification(step => step.id === 'presentation_scope'),
        findVerification(step => step.name === 'Verify governed local dependency provenance'),
        findVerification(step => step.run === 'npm ci --ignore-scripts --omit=optional --audit=false'),
        { name: 'Validate complete journey-first test ordering', if: documentationGuard, run: 'node --test scripts/tests/ci-journey-order.cjs' },
        diagnosticsRegression,
        selectedApplication,
        diagnosticsPublisher
    ]);
    for (const step of application.steps) {
        const conditional = step === diagnosticsRegression || ['npm ci --ignore-scripts --omit=optional --audit=false',
            'node --test scripts/tests/ci-journey-order.cjs'].includes(step.run);
        assert.equal(step.if, step === diagnosticsPublisher ? diagnosticsPublisher.if : conditional ? documentationGuard : undefined, step.name || step.run);
    }
});

test('the actual CI aggregate script fails every non-success result pair', () => {
    const gate = ciWorkflow().jobs.test.steps[0];
    const states = ['success', 'failure', 'cancelled', 'skipped', '', 'SUCCESS', 'success\n'];
    for (const verification of states) {
        for (const application of states) {
            const result = spawnSync('bash', ['--noprofile', '--norc', '-c', gate.run], {
                encoding: 'utf8', timeout: 5000,
                env: { PATH: process.env.PATH, VERIFICATION_RESULT: verification, APPLICATION_RESULT: application }
            });
            assert.equal(result.error, undefined);
            assert.equal(result.status, verification === 'success' && application === 'success' ? 0 : 1,
                `Unexpected aggregate outcome for ${JSON.stringify([verification, application])}`);
        }
    }
    for (const missing of ['VERIFICATION_RESULT', 'APPLICATION_RESULT']) {
        const env = { PATH: process.env.PATH, VERIFICATION_RESULT: 'success', APPLICATION_RESULT: 'success' };
        delete env[missing];
        const result = spawnSync('bash', ['--noprofile', '--norc', '-c', gate.run], {
            encoding: 'utf8', timeout: 5000, env
        });
        assert.equal(result.error, undefined);
        assert.equal(result.status, 1, `Missing ${missing} must fail closed`);
    }
});

test('real locked Jest preserves discovery/counts, prioritises failures and executes the remainder', { timeout: 120000 }, t => {
    const jestRoot = path.dirname(require.resolve('jest/package.json'));
    const jestPackage = JSON.parse(fs.readFileSync(path.join(jestRoot, 'package.json'), 'utf8'));
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert.equal(jestPackage.version, manifest.devDependencies.jest);
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-ci-order-'));
    t.after(() => {
        assert.equal(path.dirname(fs.realpathSync(fixture)), fs.realpathSync(os.tmpdir()));
        fs.rmSync(fixture, { recursive: true, force: true });
    });
    fs.mkdirSync(path.join(fixture, 'scripts'));
    fs.mkdirSync(path.join(fixture, 'test'));
    for (const name of ['ci-journey-order.js', 'ci-journey-sequencer.js']) {
        fs.copyFileSync(path.join(root, 'scripts', name), path.join(fixture, 'scripts', name));
    }
    fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({
        name: 'nofries-ci-order-synthetic', private: true, jest: { testEnvironment: 'node' }
    }));
    const trace = path.join(fixture, 'trace.jsonl');
    const source = label => `const fs = require('node:fs');\nfs.appendFileSync(${JSON.stringify(trace)}, ${JSON.stringify(label + '\n')});\ntest('synthetic ${label}', () => expect(true).toBe(true));\n`;
    fs.writeFileSync(path.join(fixture, 'test/customerProductionJourney.test.js'), source('journey'));
    fs.writeFileSync(path.join(fixture, 'test/unknownSlow.test.js'), source('unknown') + `/*${'synthetic '.repeat(10000)}*/\n`);
    fs.writeFileSync(path.join(fixture, 'test/newFeature.test.js'), source('new') + "test.skip('intentional skip', () => {});\n");
    const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
        TEMP: process.env.TEMP, TMP: process.env.TMP, CI: '1', NO_COLOR: '1',
        NODE_PATH: [path.dirname(jestRoot), process.env.NODE_PATH].filter(Boolean).join(path.delimiter) };
    const run = (extra, label) => {
        if (fs.existsSync(trace)) fs.unlinkSync(trace);
        const outputFile = path.join(fixture, `${label}.json`);
        const result = spawnSync(process.execPath, [path.join(jestRoot, 'bin/jest.js'),
            '--runInBand', '--no-cache', '--json', `--outputFile=${outputFile}`, ...extra],
        { cwd: fixture, env, encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
        assert.equal(result.error, undefined, result.error?.message);
        assert.equal(result.signal, null, result.stderr);
        return { status: result.status, results: JSON.parse(fs.readFileSync(outputFile, 'utf8')),
            order: fs.readFileSync(trace, 'utf8').trim().split('\n') };
    };
    const baseline = run([], 'baseline');
    const custom = run(['--testSequencer=./scripts/ci-journey-sequencer.js'], 'custom');
    assert.equal(baseline.status, 0);
    assert.equal(custom.status, 0);
    assert.notEqual(baseline.order[0], 'journey');
    assert.equal(custom.order[0], 'journey');
    assert.deepEqual([...custom.order].sort(), ['journey', 'new', 'unknown']);
    assert.deepEqual(custom.results.testResults.map(result => result.name).sort(),
        baseline.results.testResults.map(result => result.name).sort());
    for (const field of ['numTotalTestSuites', 'numPassedTestSuites', 'numTotalTests', 'numPassedTests', 'numPendingTests']) {
        assert.equal(custom.results[field], baseline.results[field], field);
    }
    fs.appendFileSync(path.join(fixture, 'test/customerProductionJourney.test.js'),
        "test('intentional failure must block', () => expect(false).toBe(true));\n");
    const failure = run(['--testSequencer=./scripts/ci-journey-sequencer.js'], 'failure');
    assert.equal(failure.status, 1);
    assert.equal(failure.results.numFailedTests, 1);
    assert.equal(failure.results.numPendingTests, 1);
    assert.equal(failure.results.numTotalTestSuites, 3);
    assert.equal(failure.order[0], 'journey');
    assert.deepEqual([...failure.order].sort(), ['journey', 'new', 'unknown']);
});
