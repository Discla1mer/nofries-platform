'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const yaml = require('js-yaml');
const { checkSplitReport, ELAPSED_CASE, ELAPSED_PATTERN, EXCLUDE_PATTERN } = require('../scripts/check-postgres-split');

const root = path.resolve(__dirname, '..');
const workflow = yaml.load(fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8'));
const { 'postgres-native': native, 'postgres-elapsed': elapsed, postgres: gate } = workflow.jobs;
const gateStep = gate.steps.find(step => step.name === 'Require all postgres jobs to succeed');
const testStep = (job, name) => job.steps.find(step => step.name === name);
const nativeStep = testStep(native, 'Apply migrations twice and run native tenant-isolation tests');
const elapsedStep = testStep(elapsed, 'Apply migrations twice and run the real-clock expiry case');

const PREFIX = 'Dashboard runtime with real restricted PostgreSQL fresh external callback after expiry';
const CASES = [[false, 'elapsed recovery'], [true, 'committed receipt recovery'], [false, 'future receipt denial']]
    .map(([committed, name]) => `${PREFIX} (receipt committed before expiry: ${committed}; case: ${name})`);

test('the required postgres gate always waits for both native jobs without masking errors', () => {
    expect(gate.if).toBe('always()');
    expect([...gate.needs].sort()).toEqual(['postgres-elapsed', 'postgres-native']);
    for (const job of [gate, native, elapsed]) expect(job['continue-on-error']).toBeUndefined();
    for (const job of [native, elapsed]) expect(job.if).toBeUndefined();
    expect(gateStep.if).toBeUndefined();
    expect(gateStep.env).toEqual({ NATIVE: '${{ needs.postgres-native.result }}', ELAPSED: '${{ needs.postgres-elapsed.result }}' });
});

const results = ['success', 'failure', 'cancelled', 'skipped'];
test.each(results.flatMap(a => results.map(b => [a, b])))('the actual gate shell handles native=%s elapsed=%s', (nativeResult, elapsedResult) => {
    const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', gateStep.run],
        { encoding: 'utf8', timeout: 5000, env: { PATH: process.env.PATH, NATIVE: nativeResult, ELAPSED: elapsedResult } });
    expect(result.error).toBeUndefined();
    expect(result.status === 0).toBe(nativeResult === 'success' && elapsedResult === 'success');
});

test('both native jobs use the same database, setup, migrations and suite; only the name filter differs', () => {
    expect(elapsed.services).toEqual(native.services);
    expect(elapsed['runs-on']).toBe(native['runs-on']);
    const setup = job => job.steps.slice(0, job.steps.indexOf(job === native ? nativeStep : elapsedStep));
    expect(setup(elapsed)).toEqual(setup(native));
    expect(elapsedStep.env).toEqual(nativeStep.env);
    for (const step of [nativeStep, elapsedStep]) {
        expect(step.if).toBeUndefined();
        expect(step['continue-on-error']).toBeUndefined();
        expect(step.run.split('\n').slice(0, 2)).toEqual(['npm run db:migrate', 'npm run db:migrate']);
    }
    expect(nativeStep.run).toContain(`npm run test:postgres -- --testNamePattern='${EXCLUDE_PATTERN}' --json --outputFile="$RUNNER_TEMP/native.json"`);
    expect(nativeStep.run).toContain('node scripts/check-postgres-split.js without "$RUNNER_TEMP/native.json"');
    expect(elapsedStep.run).toContain(`npm run test:postgres -- --testNamePattern='${ELAPSED_PATTERN}' --json --outputFile="$RUNNER_TEMP/elapsed.json"`);
    expect(elapsedStep.run).toContain('node scripts/check-postgres-split.js only "$RUNNER_TEMP/elapsed.json"');
    expect(testStep(native, 'Verify opt-in authenticated journey and failure cleanup')).toBeDefined();
});

test('the filters select exactly the elapsed-recovery case and its complement', () => {
    const source = fs.readFileSync(path.join(root, 'test/integration/dashboardRuntimePostgres.js'), 'utf8');
    expect(source).toContain("[[false, 'elapsed recovery'], [true, 'committed receipt recovery'], [false, 'future receipt denial']]");
    expect(source).toContain("'fresh external callback after expiry (receipt committed before expiry: %s; case: %s)'");
    const only = new RegExp(ELAPSED_PATTERN), without = new RegExp(EXCLUDE_PATTERN);
    expect(CASES.map(name => only.test(name))).toEqual([true, false, false]);
    expect(CASES.map(name => without.test(name))).toEqual([false, true, true]);
    expect(CASES.map(name => ELAPSED_CASE.test(name))).toEqual([true, false, false]);
});

function report(statuses, overrides = {}) {
    const assertionResults = statuses.map(([fullName, status]) => ({ fullName, status }));
    return { success: true, numFailedTests: 0, numRuntimeErrorTestSuites: 0, testResults: [{ assertionResults }], ...overrides };
}
const [ELAPSED, OTHER_A, OTHER_B] = [CASES[0], CASES[1], 'Some other native test'];

test('the split check accepts each job only when every test ran in exactly one job', () => {
    expect(checkSplitReport(report([[ELAPSED, 'pending'], [OTHER_A, 'passed'], [OTHER_B, 'passed']]), 'without')).toEqual({ ran: 2, filtered: 1 });
    expect(checkSplitReport(report([[ELAPSED, 'passed'], [OTHER_A, 'pending'], [OTHER_B, 'pending']]), 'only')).toEqual({ ran: 1, filtered: 2 });
});

test.each([
    ['the elapsed case ran in the native job', report([[ELAPSED, 'passed'], [OTHER_A, 'passed']]), 'without', /meant for the other job/],
    ['another test was skipped in the native job', report([[ELAPSED, 'pending'], [OTHER_A, 'pending']]), 'without', /did not pass/],
    ['the elapsed case was skipped in its own job', report([[ELAPSED, 'pending'], [OTHER_A, 'pending']]), 'only', /did not pass/],
    ['other tests ran in the elapsed job', report([[ELAPSED, 'passed'], [OTHER_A, 'passed']]), 'only', /meant for the other job/],
    ['the elapsed case is missing', report([[OTHER_A, 'passed']]), 'without', /exactly one/],
    ['the elapsed case is duplicated', report([[ELAPSED, 'pending'], [ELAPSED, 'pending'], [OTHER_A, 'passed']]), 'without', /exactly one/],
    ['the run failed', report([[ELAPSED, 'pending'], [OTHER_A, 'passed']], { success: false }), 'without', /did not succeed/],
    ['a suite crashed', report([[ELAPSED, 'pending'], [OTHER_A, 'passed']], { numRuntimeErrorTestSuites: 1 }), 'without', /did not succeed/],
    ['the report is empty', report([], { testResults: [] }), 'without', /empty/],
    ['the mode is unknown', report([[ELAPSED, 'pending'], [OTHER_A, 'passed']]), 'all', /mode/]
])('the split check refuses a report where %s', (_label, value, mode, message) => {
    expect(() => checkSplitReport(value, mode)).toThrow(message);
});
