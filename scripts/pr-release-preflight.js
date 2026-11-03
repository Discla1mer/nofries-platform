'use strict';

// Unprivileged PR feedback only. Reuse release policy and application builders;
// never call the production controller or fabricate its admission evidence.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const AUDITS = Object.freeze([
    ['root-optional', ['audit', '--audit-level=moderate', '--omit=optional', '--json'], '--release-root-optional-report'],
    ['root-runtime', ['audit', '--omit=dev', '--audit-level=moderate', '--json'], '--release-root-runtime-report'],
    ['api-runtime', ['--prefix', 'api', 'audit', '--omit=dev', '--audit-level=moderate', '--json'], '--release-api-runtime-report']
]);
function run(command, args, options) { return spawnSync(command, args, options); }
function options(root, capture = false) {
    return { cwd: root, shell: false, timeout: 300000, killSignal: 'SIGKILL',
        encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, GITHUB_ENV: '/dev/null', GITHUB_PATH: '/dev/null',
            GITHUB_OUTPUT: '/dev/null', GITHUB_STEP_SUMMARY: '/dev/null' },
        stdio: capture ? ['ignore', 'pipe', 'inherit'] : ['ignore', 'inherit', 'inherit'] };
}
function succeeded(result) { return result && !result.error && !result.signal && result.status === 0; }
function audit({ root = ROOT, execute = run, log = console.log } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-pr-audit-'));
    const flags = [], failed = [];
    try {
        // Collect every surface even when a request fails; never reinterpret a
        // registry/transport error or missing report as a clean audit.
        for (const [label, args, flag] of AUDITS) {
            log(`Release pre-flight audit: ${label}`);
            let result;
            try { result = execute('npm', args, options(root, true)); } catch { result = null; }
            if (!result || result.error || result.signal || ![0, 1].includes(result.status)
                || typeof result.stdout !== 'string' || !result.stdout.trim()) {
                failed.push(label); continue;
            }
            const report = path.join(dir, `${label}.json`);
            fs.writeFileSync(report, result.stdout, { flag: 'wx', mode: 0o600 });
            flags.push(flag, report);
        }
        if (failed.length) throw new Error(`release_preflight_audit_unavailable:${failed.join(',')}`);
        // Release mode is deliberately unconditional: no unchanged-baseline
        // shortcut and no build-only Moderate exceptions.
        if (!succeeded(execute(process.execPath, ['scripts/check-dependency-audit.js', ...flags], options(root)))) {
            throw new Error('release_preflight_policy_failed');
        }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
function packageCheck({ root = ROOT, execute = run, log = console.log } = {}) {
    const commands = [
        // These existing focused tests execute both real build scripts and
        // validate runtime inclusion/exclusion, routes and SWA size limits.
        [process.execPath, ['node_modules/jest/bin/jest.js', '--runInBand', '--runTestsByPath',
            'test/appServicePackage.test.js', 'test/customerStaticBuild.test.js']],
        ['npm', ['--prefix', 'app-service-dist', 'ci', '--omit=dev', '--omit=optional', '--ignore-scripts', '--dry-run', '--offline', '--audit=false']],
        ['npm', ['--prefix', 'api', 'ci', '--omit=dev', '--ignore-scripts', '--dry-run', '--offline', '--audit=false']]
    ];
    for (const [index, [command, args]] of commands.entries()) {
        log(`Release pre-flight package check: ${index + 1}/${commands.length}`);
        if (!succeeded(execute(command, args, options(root)))) throw new Error(`release_preflight_package_failed:${index + 1}`);
    }
}
function main(argv = process.argv.slice(2)) {
    if (argv.length !== 1 || !['audit', 'package'].includes(argv[0])) throw new Error('release_preflight_usage');
    if (argv[0] === 'audit') audit(); else packageCheck();
}
if (require.main === module) {
    try { main(); }
    catch (error) {
        const message = /^release_preflight_[a-z_]+(?::[a-z0-9,-]+)?$/.test(error.message) ? error.message : 'release_preflight_failed';
        process.stderr.write(message + '\n'); process.exitCode = 1;
    }
}
module.exports = { AUDITS, audit, packageCheck, main };
