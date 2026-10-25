'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { REPOSITORY, createApi, main } = require('../release-batch.js');

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const D = 'd'.repeat(40);
const ROOT = `repos/${REPOSITORY}`;
const NOW = Date.parse('2026-10-20T12:00:00Z');
const SECRET = 'ASSERTION_TOKEN_SENTINEL_DO_NOT_PRINT';
function setup(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'release-batch-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const calls = [];
  const fixture = {
    [`${ROOT}/git/ref/heads/main`]: { ref: 'refs/heads/main', object: { type: 'commit', sha: A } },
    [`${ROOT}/pulls/569`]: pr(569, B),
    [`${ROOT}/pulls/556`]: pr(556, C)
  };
  const api = endpoint => {
    calls.push(endpoint);
    assert.ok(Object.hasOwn(fixture, endpoint), `Unexpected endpoint ${endpoint}`);
    const value = fixture[endpoint];
    if (value instanceof Error) throw value;
    return structuredClone(value);
  };
  const dependencies = { cwd, api, clock: () => NOW };
  const freezeArgs = ['freeze', '--manifest', 'batch.json', '--candidate', `569:${B}`, '--input', `556:${C}`];
  return { cwd, fixture, calls, dependencies, freezeArgs, freeze: () => main(freezeArgs, dependencies), check: () => main(['check', '--manifest', 'batch.json'], dependencies), status: () => main(['status', '--manifest', 'batch.json'], dependencies) };
}
function pr(number, head) {
  return { number, state: 'open', head: { sha: head, repo: { full_name: REPOSITORY } }, base: { sha: A, ref: 'main', repo: { full_name: REPOSITORY } } };
}
function run(file, id, overrides = {}) {
  return { id, run_attempt: 1, workflow_id: file === 'ci.yml' ? 11 : 12, path: `.github/workflows/${file}`, repository: { id: 1, full_name: REPOSITORY }, head_repository: { id: 1, full_name: REPOSITORY }, head_sha: B, event: 'pull_request', pull_requests: [{ number: 569, head: { sha: B, repo: { id: 1 } }, base: { repo: { id: 1 } } }], status: 'completed', conclusion: 'success', created_at: '2026-10-20T10:00:00Z', updated_at: '2026-10-20T11:00:00Z', ...overrides };
}
function job(id, runId, overrides = {}) {
  return { id, run_id: runId, run_attempt: 1, head_sha: B, status: 'completed', conclusion: 'success', started_at: '2026-10-20T10:00:00Z', completed_at: '2026-10-20T11:00:00Z', name: SECRET, steps: [{ number: 1, name: SECRET, status: 'completed', conclusion: 'success', started_at: '2026-10-20T10:00:00Z', completed_at: '2026-10-20T10:05:00Z' }], ...overrides };
}
function workflows(fixture) {
  for (const [file, workflowId, runId] of [['ci.yml', 11, 100], ['prospect-live-eval.yml', 12, 200]]) {
    const value = run(file, runId);
    fixture[`${ROOT}/actions/workflows/${file}`] = { id: workflowId, path: `.github/workflows/${file}`, name: SECRET };
    fixture[`${ROOT}/actions/workflows/${file}/runs?head_sha=${B}&exclude_pull_requests=false&per_page=100&page=1`] = { total_count: 1, workflow_runs: [value] };
    fixture[`${ROOT}/actions/runs/${runId}`] = value;
    fixture[`${ROOT}/actions/runs/${runId}/attempts/1/jobs?per_page=100&page=1`] = { total_count: 1, jobs: [job(runId + 1, runId)] };
  }
}

test('freeze verifies exact heads, saves immutable provenance and check tolerates later main/input advances', t => {
  const s = setup(t);
  assert.equal(s.freeze().exitCode, 0);
  const before = fs.readFileSync(path.join(s.cwd, 'batch.json'), 'utf8');
  assert.equal(JSON.parse(before).candidate.head, B);
  assert.equal(s.check().output.state, 'unchanged');
  s.fixture[`${ROOT}/git/ref/heads/main`].object.sha = D;
  s.fixture[`${ROOT}/pulls/556`].head.sha = D;
  const result = s.check();
  assert.equal(result.exitCode, 0);
  assert.equal(result.output.currentMain, D);
  assert.deepEqual(result.output.inputs[0], { pr: 556, expectedHead: C, currentHead: D, disposition: 'next_batch' });
  assert.equal(fs.readFileSync(path.join(s.cwd, 'batch.json'), 'utf8'), before);
  const count = s.calls.length;
  assert.equal(s.freeze().output.code, 'MANIFEST_EXISTS');
  assert.equal(s.calls.length, count);
});

test('candidate drift fails check/status and does not read workflows', t => {
  const s = setup(t);
  s.freeze();
  s.fixture[`${ROOT}/pulls/569`].head.sha = D;
  assert.equal(s.check().exitCode, 1);
  assert.equal(s.status().output.state, 'drift');
  assert.ok(s.calls.every(endpoint => !endpoint.includes('/actions/')));
});

test('freeze mismatch, base race, invalid bindings, duplicate inputs and foreign repos fail without a file', t => {
  const s = setup(t);
  s.fixture[`${ROOT}/pulls/556`].head.sha = D;
  assert.equal(s.freeze().output.code, 'HEAD_DRIFT');
  s.fixture[`${ROOT}/pulls/556`].head.sha = C;
  s.fixture[`${ROOT}/pulls/569`].base.sha = D;
  assert.equal(s.freeze().output.code, 'CANDIDATE_BASE_DRIFT');
  s.fixture[`${ROOT}/pulls/569`].base.sha = A;
  s.fixture[`${ROOT}/pulls/556`].head.repo.full_name = 'foreign/repo';
  assert.equal(s.freeze().output.code, 'METADATA_INVALID');
  for (const args of [
    ['freeze', '--manifest', 'x.json', '--candidate', '569:abc', '--input', `556:${C}`],
    [...s.freezeArgs, '--input', `556:${D}`],
    [...s.freezeArgs, '--repo', 'foreign/repo'],
    ['freeze', '--manifest', 'x.json', '--candidate', `refs/heads/main:${B}`, '--input', `556:${C}`]
  ]) assert.equal(main(args, s.dependencies).exitCode, 1);
  assert.equal(fs.existsSync(path.join(s.cwd, 'batch.json')), false);
});

test('path traversal, existing symlink, parent symlink and manifest symlink reads fail safely', t => {
  const s = setup(t);
  const target = path.join(s.cwd, 'target.json');
  fs.writeFileSync(target, SECRET);
  fs.symlinkSync(target, path.join(s.cwd, 'batch.json'));
  assert.equal(s.freeze().output.code, 'MANIFEST_EXISTS');
  assert.equal(s.check().output.code, 'MANIFEST_INVALID');
  fs.mkdirSync(path.join(s.cwd, 'real'));
  fs.symlinkSync(path.join(s.cwd, 'real'), path.join(s.cwd, 'link'));
  for (const file of ['../outside.json', '/tmp/outside.json', 'link/batch.json']) {
    const args = [...s.freezeArgs];
    args[2] = file;
    assert.equal(main(args, s.dependencies).output.code, 'MANIFEST_PATH');
  }
  assert.equal(fs.readFileSync(target, 'utf8'), SECRET);
});

test('fresh status binds run attempt, metadata and durations and omits arbitrary strings', t => {
  const s = setup(t);
  s.freeze();
  workflows(s.fixture);
  const result = s.status();
  assert.equal(result.exitCode, 0);
  assert.equal(result.output.observedAt, '2026-10-20T12:00:00.000Z');
  assert.equal(result.output.liveDeployment, 'unknown');
  assert.equal(result.output.workflows[0].slowestJobs[0].durationMs, 3600000);
  assert.equal(result.output.workflows[0].slowestJobs[0].slowestSteps[0].durationMs, 300000);
  assert.equal(result.output.workflows[0].url, `https://github.com/${REPOSITORY}/actions/runs/100/attempts/1`);
  assert.ok(!JSON.stringify(result).includes(SECRET));
  const before = s.calls.length;
  s.status();
  assert.ok(s.calls.length > before, 'status must reread metadata');
});

test('new failure supersedes old pass across pages; latest attempt is queried explicitly', t => {
  const s = setup(t);
  s.freeze();
  workflows(s.fixture);
  const endpoint = `${ROOT}/actions/workflows/ci.yml/runs?head_sha=${B}&exclude_pull_requests=false&per_page=100&page=`;
  const old = Array.from({ length: 100 }, (_, index) => run('ci.yml', index + 1, { created_at: `2026-10-19T10:00:${String(index % 60).padStart(2, '0')}Z` }));
  const latest = run('ci.yml', 999, { run_attempt: 2, conclusion: 'failure' });
  s.fixture[`${endpoint}1`] = { total_count: 101, workflow_runs: old };
  s.fixture[`${endpoint}2`] = { total_count: 101, workflow_runs: [latest] };
  s.fixture[`${ROOT}/actions/runs/999`] = latest;
  s.fixture[`${ROOT}/actions/runs/999/attempts/2/jobs?per_page=100&page=1`] = { total_count: 1, jobs: [job(1000, 999, { run_attempt: 2, conclusion: 'failure' })] };
  const result = s.status();
  assert.equal(result.output.workflows[0].conclusion, 'failure');
  assert.equal(result.output.workflows[0].attempt, 2);
  assert.ok(s.calls.includes(`${endpoint}2`));
  assert.ok(s.calls.includes(`${ROOT}/actions/runs/999/attempts/2/jobs?per_page=100&page=1`));
});

test('authentic pull_request runs can have empty associations after candidate PR is independently verified', t => {
  const s = setup(t);
  s.freeze();
  workflows(s.fixture);
  const endpoint = `${ROOT}/actions/workflows/ci.yml/runs?head_sha=${B}&exclude_pull_requests=false&per_page=100&page=1`;
  s.fixture[endpoint].workflow_runs[0].pull_requests = [];
  s.fixture[`${ROOT}/actions/runs/100`].pull_requests = [];
  const result = s.status();
  assert.equal(result.exitCode, 0);
  assert.equal(result.output.workflows[0].state, 'observed');
  assert.ok(s.calls.includes(`${ROOT}/pulls/569`));
  s.fixture[`${ROOT}/pulls/569`].head.sha = D;
  assert.equal(s.status().output.state, 'drift');
});

test('missing, ambiguous, truncated, changing, foreign or excessive run metadata stays unknown', t => {
  const s = setup(t);
  s.freeze();
  const endpoint = `${ROOT}/actions/workflows/ci.yml/runs?head_sha=${B}&exclude_pull_requests=false&per_page=100&page=1`;
  const cases = [
    [{ total_count: 0, workflow_runs: [] }, 'RUN_MISSING'],
    [{ total_count: 2, workflow_runs: [run('ci.yml', 100), run('ci.yml', 101)] }, 'RUN_AMBIGUOUS'],
    [{ total_count: 2, workflow_runs: [run('ci.yml', 100)] }, 'PAGINATION_INCOMPLETE'],
    [{ total_count: 1001, workflow_runs: [] }, 'PAGINATION_INCOMPLETE'],
    [{ total_count: 1, workflow_runs: [run('ci.yml', 100, { head_sha: D })] }, 'METADATA_INVALID'],
    [{ total_count: 1, workflow_runs: [run('ci.yml', 100, { head_repository: { full_name: 'foreign/repo' } })] }, 'METADATA_INVALID'],
    [{ total_count: 1, workflow_runs: [run('ci.yml', 100, { pull_requests: [{ number: 569, head: { sha: D } }] })] }, 'METADATA_INVALID'],
    [{ total_count: 1, workflow_runs: [run('ci.yml', 100, { pull_requests: null })] }, 'METADATA_INVALID'],
    [{ total_count: 1, workflow_runs: [run('ci.yml', 100, { pull_requests: undefined })] }, 'METADATA_INVALID'],
    [{ total_count: 1, workflow_runs: [run('ci.yml', 100, { pull_requests: [{ number: 570, head: { sha: B, repo: { id: 1 } }, base: { repo: { id: 1 } } }] })] }, 'METADATA_INVALID'],
    [{ total_count: 1, workflow_runs: [run('ci.yml', 100, { repository: { full_name: REPOSITORY }, head_repository: { full_name: REPOSITORY } })] }, 'METADATA_INVALID'],
    [{ total_count: 1, workflow_runs: [run('ci.yml', 100, { run_attempt: 2 })] }, 'OBSERVATION_CHANGED']
  ];
  for (const [value, code] of cases) {
    workflows(s.fixture);
    s.fixture[endpoint] = value;
    const result = s.status();
    assert.equal(result.exitCode, 1);
    assert.equal(result.output.workflows[0].state, 'unknown');
    assert.equal(result.output.workflows[0].code, code);
  }
});

test('compact timing samples retain counts; a rerun during job collection invalidates the observation', t => {
  const s = setup(t);
  s.freeze();
  workflows(s.fixture);
  const jobs = Array.from({ length: 6 }, (_, index) => job(300 + index, 100));
  s.fixture[`${ROOT}/actions/runs/100/attempts/1/jobs?per_page=100&page=1`] = { total_count: 6, jobs };
  const result = s.status();
  assert.equal(result.output.workflows[0].jobCount, 6);
  assert.equal(result.output.workflows[0].slowestJobs.length, 5);
  let reads = 0;
  const api = endpoint => {
    const value = s.dependencies.api(endpoint);
    if (endpoint === `${ROOT}/actions/runs/100` && ++reads === 2) value.run_attempt = 2;
    return value;
  };
  const changed = main(['status', '--manifest', 'batch.json'], { ...s.dependencies, api });
  assert.equal(changed.output.workflows[0].code, 'OBSERVATION_CHANGED');
});

test('job pagination is complete and identity checked, including records beyond the first page', t => {
  const s = setup(t);
  s.freeze();
  workflows(s.fixture);
  const first = Array.from({ length: 100 }, (_, index) => job(300 + index, 100));
  const endpoint = `${ROOT}/actions/runs/100/attempts/1/jobs?per_page=100&page=`;
  s.fixture[`${endpoint}1`] = { total_count: 101, jobs: first };
  s.fixture[`${endpoint}2`] = { total_count: 101, jobs: [job(500, 100, { head_sha: D })] };
  assert.equal(s.status().output.workflows[0].code, 'METADATA_INVALID');
  s.fixture[`${endpoint}2`].jobs[0].head_sha = B;
  assert.equal(s.status().output.workflows[0].jobCount, 101);
  s.fixture[`${endpoint}2`].total_count = 102;
  assert.equal(s.status().output.workflows[0].code, 'PAGINATION_INCOMPLETE');
});

test('run/job graph and attempt identity, impossible times and malformed states cannot manufacture success', t => {
  const s = setup(t);
  s.freeze();
  const cases = [
    { run_id: 123 }, { head_sha: D }, { run_attempt: 2 },
    { completed_at: '2026-10-20T09:00:00Z' }, { completed_at: '2026-10-21T09:00:00Z' },
    { status: SECRET }, { conclusion: SECRET }, { steps: Array(101).fill({}) },
    { steps: [job(101, 100).steps[0], job(101, 100).steps[0]] }
  ];
  for (const change of cases) {
    workflows(s.fixture);
    s.fixture[`${ROOT}/actions/runs/100/attempts/1/jobs?per_page=100&page=1`].jobs[0] = job(101, 100, change);
    const result = s.status();
    assert.equal(result.output.state, 'unknown');
    assert.ok(!JSON.stringify(result).includes(SECRET));
  }
});

test('stale/backwards observations, future freeze and oversized manifests fail closed', t => {
  const s = setup(t);
  let calls = 0;
  assert.equal(main(s.freezeArgs, { ...s.dependencies, clock: () => NOW + calls++ * 120001 }).output.code, 'OBSERVATION_STALE');
  calls = 0;
  assert.equal(main(s.freezeArgs, { ...s.dependencies, clock: () => NOW - calls++ }).output.code, 'OBSERVATION_STALE');
  s.freeze();
  assert.equal(main(['check', '--manifest', 'batch.json'], { ...s.dependencies, clock: () => NOW - 6000 }).output.code, 'OBSERVATION_CLOCK');
  fs.writeFileSync(path.join(s.cwd, 'batch.json'), ' '.repeat(65537));
  assert.equal(s.check().output.code, 'MANIFEST_INVALID');
});

test('real CLI rejects a FIFO immediately without waiting for a writer', t => {
  const s = setup(t);
  const fifo = path.join(s.cwd, 'batch.json');
  const created = spawnSync('mkfifo', [fifo], { encoding: 'utf8' });
  assert.equal(created.status, 0);
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '../release-batch.js'), 'check', '--manifest', 'batch.json'], { cwd: s.cwd, encoding: 'utf8', timeout: 1500 });
  assert.equal(result.error, undefined, 'FIFO validation must finish before the child timeout');
  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), { state: 'unknown', code: 'MANIFEST_INVALID' });
});

test('real CLI caps reads at MAX+1 even when a regular file grows after fstat', t => {
  const s = setup(t);
  const manifest = path.join(s.cwd, 'batch.json');
  const preload = path.join(s.cwd, 'grow.cjs');
  const receipt = path.join(s.cwd, 'read-count.json');
  fs.writeFileSync(manifest, '{}');
  fs.writeFileSync(preload, `
    const fs = require('node:fs');
    const originalStat = fs.fstatSync;
    const originalRead = fs.readSync;
    let active = false;
    let readBytes = 0;
    let allocatedBytes = 0;
    fs.fstatSync = function (fd) {
      const stat = originalStat(fd);
      fs.writeFileSync(${JSON.stringify(manifest)}, ' '.repeat(1024 * 1024));
      active = true;
      return stat;
    };
    fs.readSync = function (fd, buffer, offset, length, position) {
      const count = originalRead(fd, buffer, offset, length, position);
      if (active) { readBytes += count; allocatedBytes = Math.max(allocatedBytes, buffer.length); }
      return count;
    };
    process.on('exit', () => fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ readBytes, allocatedBytes })));
  `);
  const result = spawnSync(process.execPath, ['--require', preload, path.resolve(__dirname, '../release-batch.js'), 'check', '--manifest', 'batch.json'], { cwd: s.cwd, encoding: 'utf8', timeout: 1500 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), { state: 'unknown', code: 'MANIFEST_INVALID' });
  assert.deepEqual(JSON.parse(fs.readFileSync(receipt, 'utf8')), { readBytes: 65537, allocatedBytes: 65537 });
});

test('API uses argv GET only; failure, stderr, malformed/oversized stdout and thrown errors are never disclosed', () => {
  const results = [
    { status: 1, stdout: SECRET, stderr: SECRET },
    { status: 0, stdout: SECRET, stderr: SECRET },
    { status: 0, stdout: ' '.repeat(4 * 1024 * 1024 + 1), stderr: SECRET },
    { status: 0, stdout: '{}', error: new Error(SECRET) }
  ];
  for (const response of results) {
    let count = 0;
    const api = createApi((program, args, options) => {
      count++;
      assert.equal(program, 'gh');
      assert.deepEqual(args.slice(0, 3), ['api', '--method', 'GET']);
      assert.deepEqual(args.slice(3, 5), ['--hostname', 'github.com']);
      assert.equal(options.shell, false);
      assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
      return response;
    });
    assert.throws(() => api(`${ROOT}/pulls/569`), error => !String(error).includes(SECRET));
    assert.equal(count, 1, 'no retry or alternate endpoint');
  }
});

test('real CLI prints finite usage errors without echoing argument/environment secrets or stderr', () => {
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '../release-batch.js'), SECRET], { encoding: 'utf8', env: { ...process.env, TEST_SENTINEL: SECRET } });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), { state: 'unknown', code: 'USAGE' });
  assert.ok(!result.stdout.includes(SECRET));
});
