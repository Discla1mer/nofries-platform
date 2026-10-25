'use strict';

// This reporter never reads assertion results, names, messages, stacks or logs.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const MAX_BYTES = 256 * 1024;
const MAX_SUITES = 1024;
const MAX_COUNT = 1000000;
const MAX_MS = 86400000;
const CATEGORIES = new Set(['PASSED', 'TEST_FAILURE', 'SUITE_FAILURE', 'SKIPPED']);
const SCOPES = new Set(['application', 'postgres']);
const own = (object, field) => {
    const descriptor = Object.getOwnPropertyDescriptor(object, field);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new Error('invalid-field');
    return descriptor.value;
};
const integer = (value, maximum = MAX_COUNT) => Number.isSafeInteger(value) && value >= 0 && value <= maximum;
function binding(env) {
    const result = { sha: env.GITHUB_SHA, run: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT, scope: env.CI_TEST_SCOPE };
    if (!validBinding(result)) throw new Error('invalid-binding');
    return result;
}
function validBinding(value) {
    return value && typeof value.sha === 'string' && /^[a-f0-9]{40}$/.test(value.sha) &&
        typeof value.run === 'string' && /^[1-9][0-9]{0,19}$/.test(value.run) &&
        typeof value.attempt === 'string' && /^[1-9][0-9]{0,5}$/.test(value.attempt) && SCOPES.has(value.scope);
}
function suiteIds(root = ROOT) {
    const child = spawnSync('git', ['ls-files', '-z', '--', 'test'], {
        cwd: root, encoding: 'utf8', timeout: 3000, maxBuffer: MAX_BYTES,
        env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1' },
        stdio: ['ignore', 'pipe', 'ignore']
    });
    if (child.error || child.signal || child.status !== 0) throw new Error('allowlist-unavailable');
    // Dotted basenames (for example feature.integration.test.js) are canonical
    // repository IDs too. Every component starts with a non-dot character, so
    // neither '.' nor '..' traversal components can enter the closed allowlist.
    const ids = child.stdout.split('\0').filter(id => /^test\/(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:test|spec)\.[cm]?[jt]sx?$/.test(id));
    if (!ids.length || ids.length > MAX_SUITES) throw new Error('allowlist-invalid');
    return new Set(ids);
}
function readBounded(file) {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('invalid-file');
        const buffer = Buffer.alloc(MAX_BYTES + 1);
        const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
        if (size > MAX_BYTES) throw new Error('oversized-file');
        return buffer.toString('utf8', 0, size);
    } finally { fs.closeSync(fd); }
}
function exactKeys(value, fields) {
    return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === fields.slice().sort().join(',');
}
function validReport(report, expected, ids) {
    if (!exactKeys(report, ['version', 'binding', 'suites', 'counts', 'elapsedMs']) || report.version !== 1 ||
        !exactKeys(report.binding, ['sha', 'run', 'attempt', 'scope']) || !validBinding(report.binding) ||
        Object.keys(expected).some(key => report.binding[key] !== expected[key]) || !integer(report.elapsedMs, MAX_MS) ||
        !exactKeys(report.counts, ['suites', 'passed', 'failed', 'skipped', 'todo']) ||
        !Object.values(report.counts).every(value => integer(value)) ||
        !Array.isArray(report.suites) || !report.suites.length || report.suites.length > MAX_SUITES ||
        report.counts.suites !== report.suites.length) return false;
    const seen = new Set();
    const totals = { passed: 0, failed: 0, skipped: 0, todo: 0 };
    for (const row of report.suites) {
        if (!exactKeys(row, ['id', 'category', 'passed', 'failed', 'skipped', 'todo', 'elapsedMs']) ||
            !ids.has(row.id) || seen.has(row.id) || !CATEGORIES.has(row.category) ||
            !integer(row.elapsedMs, MAX_MS) || !Object.keys(totals).every(key => integer(row[key]))) return false;
        if (row.category !== (row.failed > 0 ? 'TEST_FAILURE' : row.category === 'SUITE_FAILURE' ? 'SUITE_FAILURE' : row.passed > 0 ? 'PASSED' : 'SKIPPED')) return false;
        seen.add(row.id);
        for (const key of Object.keys(totals)) totals[key] += row[key];
    }
    return Object.keys(totals).every(key => integer(totals[key]) && report.counts[key] === totals[key]);
}
class CiTestReporter {
    constructor() {
        this.disabled = false;
        this.rows = [];
        this.started = Date.now();
        try {
            this.binding = binding(process.env);
            this.ids = suiteIds();
            this.output = process.env.CI_TEST_REPORT_PATH;
            if (!path.isAbsolute(this.output)) throw new Error('invalid-output');
        } catch { this.disabled = true; }
    }
    onTestResult(test, result) {
        if (this.disabled) return;
        try {
            if (this.rows.length >= MAX_SUITES) throw new Error('too-many-suites');
            const file = own(result, 'testFilePath');
            if (typeof file !== 'string') throw new Error('invalid-suite');
            const id = path.relative(ROOT, file).split(path.sep).join('/');
            if (!this.ids.has(id)) throw new Error('unknown-suite');
            const row = { id, category: 'SKIPPED', passed: own(result, 'numPassingTests'), failed: own(result, 'numFailingTests'),
                skipped: own(result, 'numPendingTests'), todo: own(result, 'numTodoTests'), elapsedMs: 0 };
            if (![row.passed, row.failed, row.skipped, row.todo].every(value => integer(value))) throw new Error('invalid-count');
            const runtimeError = Object.getOwnPropertyDescriptor(result, 'testExecError');
            if (runtimeError && !Object.hasOwn(runtimeError, 'value')) throw new Error('invalid-error');
            row.category = row.failed > 0 ? 'TEST_FAILURE' : runtimeError?.value ? 'SUITE_FAILURE' : row.passed > 0 ? 'PASSED' : 'SKIPPED';
            const perf = own(result, 'perfStats');
            const start = own(perf, 'start');
            const end = own(perf, 'end');
            row.elapsedMs = end - start;
            if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || !integer(row.elapsedMs, MAX_MS)) throw new Error('invalid-time');
            this.rows.push(row);
        } catch { this.disabled = true; this.rows = []; }
    }
    onRunComplete(contexts, result) {
        if (this.disabled) return;
        let partial;
        let owned = false;
        try {
            // An interrupted run is never represented as a complete result.
            if (own(result, 'wasInterrupted') !== false) throw new Error('interrupted');
            if (own(result, 'numTotalTestSuites') !== this.rows.length) throw new Error('incomplete');
            const counts = { suites: this.rows.length, passed: 0, failed: 0, skipped: 0, todo: 0 };
            for (const row of this.rows) for (const key of ['passed', 'failed', 'skipped', 'todo']) counts[key] += row[key];
            const report = { version: 1, binding: this.binding, counts, elapsedMs: Date.now() - this.started, suites: this.rows };
            if (!validReport(report, this.binding, this.ids)) throw new Error('invalid-report');
            const json = JSON.stringify(report);
            if (Buffer.byteLength(json) > MAX_BYTES) throw new Error('oversized-report');
            partial = `${this.output}.partial`;
            const fd = fs.openSync(partial, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
            owned = true;
            try { fs.writeFileSync(fd, json); } finally { fs.closeSync(fd); }
            // Exclusive hard-link publication is atomic; never replace an existing report.
            fs.linkSync(partial, this.output);
        } catch { /* Diagnostics must never alter Jest's test result or expose an exception. */ }
        finally { if (owned) { try { fs.unlinkSync(partial); } catch { /* Fixed silent fallback. */ } } }
    }
}
module.exports = CiTestReporter;
Object.assign(module.exports, { MAX_BYTES, MAX_SUITES, CATEGORIES, SCOPES, ROOT, binding, validBinding, suiteIds, readBounded, validReport });
