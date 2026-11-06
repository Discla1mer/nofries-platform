'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const checker = path.resolve(__dirname, '../check-runtime-install.js');

test('isolated install workflow is separate, unprivileged and fail-closed', () => {
    const root = path.resolve(__dirname, '../..');
    const source = fs.readFileSync(path.join(root, '.github/workflows/pr-runtime-install.yml'), 'utf8');
    assert.match(source, /on:\n  pull_request:\n/);
    assert.doesNotMatch(source, /workflow_dispatch:|pull_request_target|workflow_run:|secrets\.|id-token:|environment:|continue-on-error|upload-artifact/);
    assert.match(source, /permissions:\n  contents: read/);
    assert.match(source, /persist-credentials: false/);
    assert.match(source, /package-manager-cache: false/);
    assert.match(source, /node scripts\/check-runtime-install.js/);
    assert.doesNotMatch(source, /npm ci|pr-release-preflight|npm audit/);
    for (const match of source.matchAll(/uses: ([^\s]+)/g)) assert.match(match[1], /@[a-f0-9]{40}$/);
});

function fixture(run) {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-runtime-fixture-'));
    const root = path.join(temporary, 'package');
    const write = (name, contents) => {
        const file = path.join(root, name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, contents);
    };
    write('package.json', JSON.stringify({ dependencies: { 'synthetic-runtime': '1.0.0' } }));
    write('node_modules/synthetic-runtime/index.js', 'module.exports = {};');
    write('lib/productionApplication.js', 'exports.createProductionApplication = () => {};');
    write('server.js', 'exports.createNoFriesApp = () => {};');
    write('health/index.js', 'module.exports = () => {};');
    write('shared/database/postgres.js', 'exports.createPostgresDatabase = () => {};');
    const check = kind => spawnSync(process.execPath,
        ['--no-global-search-paths', checker, '--load', root, kind],
        { encoding: 'utf8', env: { PATH: process.env.PATH, NODE_ENV: 'production' } });
    try { run({ root, temporary, write, check }); }
    finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

for (const kind of ['app-service', 'api']) {
    test(`loads the installed ${kind} runtime`, () => fixture(({ check }) => {
        const result = check(kind);
        assert.equal(result.status, 0, result.stderr);
    }));
}
test('missing installed dependency fails', () => fixture(({ root, check }) => {
    fs.rmSync(path.join(root, 'node_modules'), { recursive: true });
    assert.notEqual(check('api').status, 0);
}));
test('parent development dependency cannot satisfy the package', () => fixture(({ root, temporary, check }) => {
    fs.renameSync(path.join(root, 'node_modules'), path.join(temporary, 'node_modules'));
    const result = check('api');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /outside the installed package/);
}));
test('symlink to dependencies outside the package fails', () => fixture(({ root, temporary, check }) => {
    const outside = path.join(temporary, 'dependencies');
    fs.renameSync(path.join(root, 'node_modules'), outside);
    fs.symlinkSync(outside, path.join(root, 'node_modules'), 'dir');
    assert.notEqual(check('api').status, 0);
}));
test('transitive parent fallback fails', () => fixture(({ temporary, write, check }) => {
    const outside = path.join(temporary, 'node_modules', 'parent-only');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'index.js'), 'module.exports = {};');
    write('node_modules/synthetic-runtime/index.js', "module.exports = require('parent-only');");
    const result = check('api');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /outside its isolated package/);
}));
test('missing production composition fails', () => fixture(({ root, check }) => {
    fs.unlinkSync(path.join(root, 'lib/productionApplication.js'));
    assert.notEqual(check('app-service').status, 0);
}));
test('unknown package profile fails', () => fixture(({ check }) => {
    assert.notEqual(check('other').status, 0);
}));
