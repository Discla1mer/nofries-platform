'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { AUDITS, audit, packageCheck, main } = require('../pr-release-preflight');
const root = path.resolve(__dirname, '../..');
const clean = { auditReportVersion: 2, vulnerabilities: {} };
const good = { status: 0, stdout: JSON.stringify(clean) };
const quiet = () => {};

test('all release audit commands and flags match the existing controller', () => {
    assert.deepEqual(AUDITS.map(x => x[1]), [
        ['audit', '--audit-level=moderate', '--omit=optional', '--json'],
        ['audit', '--omit=dev', '--audit-level=moderate', '--json'],
        ['--prefix', 'api', 'audit', '--omit=dev', '--audit-level=moderate', '--json']
    ]);
    // The public repository intentionally contains no private release controller.
    const builder = path.join(root, 'scripts/release/build-unified-packages.sh');
    if (fs.existsSync(builder)) {
        const source = fs.readFileSync(builder, 'utf8');
        for (const [label, args, flag] of AUDITS) {
            assert.ok(source.includes(`audit_to_json ${label} "$audit_dir/${label}.json" npm ${args.join(' ')}`));
            assert.ok(source.includes(`${flag} "$audit_dir/${label}.json"`));
        }
    }
});
test('status one reports reach release policy unchanged and temporary files are cleaned', () => {
    const calls = []; let directory;
    audit({ log: quiet, execute(command, args, options) {
        calls.push({ command, args });
        assert.equal(options.shell, false); assert.equal(options.timeout, 300000);
        assert.equal(options.env.GITHUB_ENV, '/dev/null');
        if (command === 'npm') return { ...good, status: 1 };
        assert.equal(command, process.execPath);
        assert.equal(args[0], 'scripts/check-dependency-audit.js');
        assert.deepEqual(args.filter(x => x.startsWith('--')), AUDITS.map(x => x[2]));
        for (const file of args.filter(x => path.isAbsolute(x))) {
            directory = path.dirname(file);
            assert.equal(fs.statSync(file).mode & 0o777, 0o600);
            assert.deepEqual(JSON.parse(fs.readFileSync(file)), clean);
        }
        return { status: 0 };
    } });
    assert.equal(calls.length, 4); assert.equal(fs.existsSync(directory), false);
});
for (const [name, result] of [
    ['transport exit', { status: 2, stdout: '{}' }],
    ['timeout', { status: null, error: new Error('timeout') }],
    ['signal', { status: 0, signal: 'SIGTERM', stdout: '{}' }],
    ['empty response', { status: 0, stdout: '' }]
]) test(`${name} fails closed after collecting all audit surfaces`, () => {
    let n = 0;
    assert.throws(() => audit({ log: quiet, execute(command) {
        assert.equal(command, 'npm'); return n++ === 0 ? result : good;
    } }), /release_preflight_audit_unavailable:root-optional/);
    assert.equal(n, 3);
});

function fixture(t, versions = ['10.4.5']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-policy-test-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    for (const name of ['scripts', 'security', 'api']) fs.mkdirSync(path.join(dir, name));
    // Execute the unchanged real policy. Only vendor provenance is stubbed in
    // this synthetic policy fixture; the workflow executes the real verifier.
    fs.copyFileSync(path.join(root, 'scripts/check-dependency-audit.js'), path.join(dir, 'scripts/check-dependency-audit.js'));
    fs.writeFileSync(path.join(dir, 'scripts/verify-adm-zip-memory-only.js'), 'exports.verifyVendor = () => {};');
    const nodes = versions.map((version, i) => [i ? `node_modules/fixture-${i}/node_modules/glob` : 'node_modules/glob', { version }]);
    const lock = { lockfileVersion: 3, packages: { '': {}, ...Object.fromEntries(nodes) } };
    for (const prefix of ['', 'api/']) {
        fs.writeFileSync(path.join(dir, prefix + 'package.json'), '{}');
        fs.writeFileSync(path.join(dir, prefix + 'package-lock.json'), JSON.stringify(lock));
    }
    fs.writeFileSync(path.join(dir, 'security/dependency-audit-exceptions.json'), JSON.stringify({ schemaVersion: 1, exceptions: [] }));
    return { dir, nodes: nodes.map(x => x[0]) };
}
function report(nodes, severity) {
    return { auditReportVersion: 2, vulnerabilities: { glob: { severity, nodes,
        via: [{ url: 'https://github.com/advisories/GHSA-synthetic-glob-test' }] } } };
}
function runPolicy(f, payload) {
    let response;
    const execute = (command, args, options) => {
        if (command === 'npm') return { status: 1, stdout: JSON.stringify(payload) };
        response = spawnSync(command, args, { ...options, stdio: 'pipe' }); return response;
    };
    let error;
    try { audit({ root: f.dir, execute, log: quiet }); } catch (e) { error = e; }
    return { error, response };
}
test('real policy rejects the multi-version glob failure before release', t => {
    const f = fixture(t, ['10.4.5', '11.0.1']);
    const result = runPolicy(f, report(f.nodes, 'high'));
    assert.match(result.error.message, /release_preflight_policy_failed/);
    assert.match(result.response.stderr, /multiple installed versions require separate review/);
});
for (const severity of ['moderate', 'high', 'critical']) test(`real release policy blocks ${severity}`, t => {
    const f = fixture(t), result = runPolicy(f, report(f.nodes, severity));
    assert.match(result.error.message, /release_preflight_policy_failed/);
    assert.match(result.response.stderr, /frozen release Moderate\/High\/Critical gate/);
});
test('real policy permits a clean response, rejects malformed and registry-error JSON', t => {
    const f = fixture(t);
    assert.equal(runPolicy(f, clean).error, undefined);
    for (const bad of [{}, { ...clean, error: { code: 'E503' } }]) {
        assert.match(runPolicy(f, bad).error.message, /release_preflight_policy_failed/);
    }
});
test('build-only Moderate acceptance cannot weaken release mode', t => {
    const f = fixture(t);
    fs.writeFileSync(path.join(f.dir, 'security/dependency-audit-exceptions.json'), JSON.stringify({ schemaVersion: 1, exceptions: [{
        id: 'synthetic', status: 'accepted', scope: 'build-only', trackingId: 'test', severity: 'moderate',
        advisoryIds: ['GHSA-SYNTHETIC-GLOB-TEST'], surfaces: ['root-all'], package: 'glob', version: '10.4.5',
        nodePaths: f.nodes, reachability: 'synthetic', mitigations: ['synthetic'], affectedCapabilities: ['synthetic'],
        owner: 'test', acceptedAt: '2020-01-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z',
        targetMilestone: 'test', promotionConditions: ['test'], sourceUrls: ['https://example.invalid']
    }] }));
    const result = runPolicy(f, report(f.nodes, 'moderate'));
    assert.match(result.response.stderr, /frozen release Moderate\/High\/Critical gate/);
    assert.ok(result.error);
});
test('package checks reuse real builders through focused tests, with offline install dry-runs', () => {
    const calls = [];
    packageCheck({ log: quiet, execute(command, args) {
        calls.push([command, args]); return { status: 0, stdout: 'a'.repeat(40) + '\n' };
    } });
    assert.equal(calls.length, 5);
    assert.deepEqual(calls[1][1], ['scripts/stamp-release.js', 'a'.repeat(40), '1']);
    assert.ok(calls[2][1].includes('test/appServicePackage.test.js'));
    assert.ok(calls[2][1].includes('test/customerStaticBuild.test.js'));
    for (const [, args] of calls.slice(3)) for (const flag of ['--dry-run', '--offline', '--ignore-scripts', '--audit=false']) assert.ok(args.includes(flag));
    assert.equal(calls[4][1].includes('--omit=optional'), false);
});
for (const failAt of [1, 2, 3, 4]) test(`package stage ${failAt} failure cannot report success`, () => {
    let n = -1;
    assert.throws(() => packageCheck({ log: quiet, execute() {
        n++; return { status: n === failAt ? 1 : 0, stdout: 'a'.repeat(40) + '\n' };
    } }), new RegExp(`release_preflight_package_failed:${failAt}`));
    assert.equal(n, failAt);
});
test('only a PR-triggered read-only isolated workflow is added', () => {
    const source = fs.readFileSync(path.join(root, '.github/workflows/pr-release-preflight.yml'), 'utf8');
    assert.match(source, /on:\n  pull_request:\n/);
    assert.doesNotMatch(source, /pull_request_target|workflow_run:|workflow_dispatch:|secrets\.|id-token:|environment:|continue-on-error|upload-artifact/);
    assert.match(source, /permissions:\n  contents: read/);
    assert.match(source, /persist-credentials: false/); assert.match(source, /package-manager-cache: false/);
    assert.match(source, /steps.install.outcome == 'success'/);
    assert.match(source, /node scripts\/pr-release-preflight.js audit/);
    assert.match(source, /node scripts\/pr-release-preflight.js package/);
    for (const match of source.matchAll(/uses: ([^\s]+)/g)) assert.match(match[1], /@[a-f0-9]{40}$/);
    assert.throws(() => main(['dispatch']), /release_preflight_usage/);
});
