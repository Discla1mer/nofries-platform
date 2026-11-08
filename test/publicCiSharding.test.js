'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const yaml = require('js-yaml');

const root = path.resolve(__dirname, '..');
const workflow = yaml.load(fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8'));
const pkg = require('../package.json');
const { unit, build, application } = workflow.jobs;
const gate = application.steps.find(step => step.name === 'Require all application jobs to succeed');

test('four shards cover the ordinary Jest discovery exactly once', () => {
    expect(unit.strategy.matrix).toEqual({ shard: [1, 2, 3, 4] });
    expect(unit.strategy['fail-fast']).toBe(false);
    expect(unit['continue-on-error']).toBeUndefined();
    expect(unit.if).toBeUndefined();
    const command = unit.steps.find(step => step.name === 'Run Jest shard');
    expect(command.if).toBeUndefined();
    expect(command['continue-on-error']).toBeUndefined();
    expect(command.run).toMatch(/^npx jest --runInBand --shard=\$\{\{ matrix.shard \}\}\/4$/);
    expect(pkg.scripts['test:ci']).toBe('jest --runInBand');
    const discover = args => {
        const result = spawnSync(process.execPath,
            [require.resolve('jest/bin/jest'), ...args, '--listTests', '--json'],
            { cwd: root, encoding: 'utf8', timeout: 20000 });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
        return JSON.parse(result.stdout);
    };
    const ordinary = discover(pkg.scripts['test:ci'].split(' ').slice(1));
    const shards = unit.strategy.matrix.shard.map(shard => discover(
        command.run.replace('${{ matrix.shard }}', String(shard)).split(' ').slice(2)));
    expect(ordinary.length).toBeGreaterThan(0);
    for (const files of shards) expect(files.length).toBeGreaterThan(0);
    const combined = shards.flat();
    expect(new Set(combined).size).toBe(combined.length);
    expect(combined.sort()).toEqual(ordinary.sort());
}, 120000);

test('the required gate always waits for the shards and build without masking errors', () => {
    expect(application.if).toBe('always()');
    expect([...application.needs].sort()).toEqual(['build', 'unit']);
    expect(application['continue-on-error']).toBeUndefined();
    expect(build['continue-on-error']).toBeUndefined();
    expect(gate.if).toBeUndefined();
    expect(gate['continue-on-error']).toBeUndefined();
    expect(gate.env).toEqual({ UNIT: '${{ needs.unit.result }}', BUILD: '${{ needs.build.result }}' });
});

const results = ['success', 'failure', 'cancelled', 'skipped'];
test.each(results.flatMap(unitResult => results.map(buildResult => [unitResult, buildResult])))
    ('the actual gate shell handles unit=%s build=%s', (unitResult, buildResult) => {
        const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', gate.run],
            { encoding: 'utf8', timeout: 5000, env: { PATH: process.env.PATH, UNIT: unitResult, BUILD: buildResult } });
        expect(result.error).toBeUndefined();
        expect(result.status === 0).toBe(unitResult === 'success' && buildResult === 'success');
    });

test('the build job still executes every non-Jest verify command and uncached mock evaluation', () => {
    expect(build.if).toBeUndefined();
    const verifyCommands = pkg.scripts.verify.split(' && ');
    expect(verifyCommands.shift()).toBe('npm run test:ci');
    for (const command of [...verifyCommands, 'npm run eval:prospect:promptfoo']) {
        const step = build.steps.find(candidate => candidate.run === command);
        expect(step).toBeDefined();
        expect(step.if).toBeUndefined();
        expect(step['continue-on-error']).toBeUndefined();
    }
    expect(pkg.scripts['eval:prospect:promptfoo']).toContain('--no-cache');
    const packageStep = build.steps.find(step => step.name === 'Build runtime package and verify install closure');
    expect(packageStep.run).toContain('npm run build:app-service');
    expect(packageStep.run).toContain('npm ci --ignore-scripts --omit=dev --omit=optional --dry-run --offline --audit=false');
    expect(packageStep.if).toBeUndefined();
    expect(packageStep['continue-on-error']).toBeUndefined();
});
