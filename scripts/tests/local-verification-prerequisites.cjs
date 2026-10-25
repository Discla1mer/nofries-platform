'use strict';

// Built-in Node tests: fixtures never import dependency code or launch a browser.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { checkPrerequisites } = require('../check-local-verification.cjs');

function fixture(t) {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-prerequisites-test-'));
    const root = path.join(temporary, 'project');
    fs.mkdirSync(root);
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const write = (relative, value, mode) => {
        const file = path.join(root, relative);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), { mode });
    };
    const dependencies = { jest: '30.5.2', promptfoo: '0.124.0', '@nofries/prerequisite-fixture': '1.0.0',
        'vendor-fixture': 'file:vendor/fixture.tgz' };
    const manifest = { engines: { node: '>=22.22.0' }, devDependencies: dependencies };
    const lock = { packages: { '': { devDependencies: dependencies } } };
    for (const [name, declared] of Object.entries({ ...dependencies, playwright: '1.0.0' })) {
        const version = declared.startsWith('file:') ? '1.0.0-local.1' : declared;
        const actualName = name === 'vendor-fixture' ? '@nofries/vendor-fixture' : name;
        write(`node_modules/${name}/package.json`, {
            name: actualName, version, main: 'entry.cjs', exports: './entry.cjs', bin: { [name]: 'cli.cjs' }
        });
        // Imports or tool execution beyond bounded npm probes would fail the healthy test.
        write(`node_modules/${name}/entry.cjs`, 'throw new Error("Dependency code must not execute");');
        write(`node_modules/${name}/cli.cjs`, '#!/bin/false\n', 0o755);
        lock.packages[`node_modules/${name}`] = { name: actualName, version };
    }
    write('package.json', manifest);
    write('package-lock.json', lock);
    write('vendor/fixture.tgz', 'presence only; deliberately not an archive');
    fs.mkdirSync(path.join(root, 'node_modules/.bin'));
    for (const name of ['jest', 'promptfoo']) fs.symlinkSync(`../${name}/cli.cjs`, path.join(root, 'node_modules/.bin', name));
    fs.mkdirSync(path.join(root, 'bin'));
    fs.symlinkSync(process.execPath, path.join(root, 'bin/node'));
    write('bin/npm', `#!${process.execPath}\n'use strict';
const args = process.argv.slice(2);
if (args.slice(-3).join(' ') !== '--offline --ignore-scripts --no-update-notifier') process.exit(8);
if (args[0] === '--version') console.log('11.0.0');
else process.exit(9);
`, 0o755);
    for (const directory of ['scratch', 'cache']) fs.mkdirSync(path.join(root, directory));
    write('cache/existing', 'keep me');
    const env = { PATH: path.join(root, 'bin'), TMPDIR: path.join(root, 'scratch'),
        npm_config_cache: path.join(root, 'cache'), CHROMIUM_EXECUTABLE_PATH: process.execPath };
    const run = (browser = true) => checkPrerequisites({ root, env, browser });
    return { root, write, manifest, env, run };
}

const failures = checks => checks.filter(check => !check.ok);
function onlyFailure(checks, code, actionable) {
    assert.deepEqual(failures(checks).map(check => check.code), [code]);
    assert.match(failures(checks)[0].detail, actionable);
}

test('healthy declared versions, vendor alias, hidden exports, tools and browser fixture pass; probes clean up', t => {
    const f = fixture(t);
    assert.deepEqual(failures(f.run()), []);
    assert.deepEqual(fs.readdirSync(f.env.TMPDIR), []);
    assert.deepEqual(fs.readdirSync(f.env.npm_config_cache), ['existing']);
    assert.equal(fs.readFileSync(path.join(f.env.npm_config_cache, 'existing'), 'utf8'), 'keep me');
});

test('wrong Jest gives an actionable version failure', t => {
    const f = fixture(t);
    const file = path.join(f.root, 'node_modules/jest/package.json');
    const metadata = JSON.parse(fs.readFileSync(file));
    f.write('node_modules/jest/package.json', { ...metadata, version: '29.7.0' });
    onlyFailure(f.run(), 'DEPENDENCY_VERSION', /jest: installed 29\.7\.0, locked 30\.5\.2; select/);
});

test('missing dependency is distinct from version failure', t => {
    const f = fixture(t);
    fs.rmSync(path.join(f.root, 'node_modules/@nofries/prerequisite-fixture'), { recursive: true });
    onlyFailure(f.run(), 'DEPENDENCY_MISSING', /prerequisite-fixture.*select a complete existing locked installation/);
});

test('unusable cache fails deterministically even as root, without changing its contents', t => {
    const f = fixture(t);
    f.write('cache-is-file', 'preserve');
    f.env.npm_config_cache = path.join(f.root, 'cache-is-file');
    onlyFailure(f.run(), 'CACHE_WRITABLE', /writable npm_config_cache/);
    assert.equal(fs.readFileSync(f.env.npm_config_cache, 'utf8'), 'preserve');
});

test('cache selection is explicit, unambiguous and never creates a missing cache', t => {
    const f = fixture(t);
    const selected = f.env.npm_config_cache;
    delete f.env.npm_config_cache;
    onlyFailure(f.run(), 'CACHE_SELECTION', /Set npm_config_cache/);
    f.env.npm_config_cache = selected;
    f.env.NPM_CONFIG_CACHE = path.join(f.root, 'other-cache');
    onlyFailure(f.run(), 'CACHE_SELECTION', /conflicting case-insensitive/);
    delete f.env.NPM_CONFIG_CACHE;
    f.env.npm_config_cache = path.join(f.root, 'missing-cache');
    onlyFailure(f.run(), 'CACHE_WRITABLE', /existing writable npm_config_cache/);
    assert.equal(fs.existsSync(f.env.npm_config_cache), false);
});

test('cache values cannot be transformed by npm or overridden through mixed-case keys', t => {
    const f = fixture(t);
    f.write('blocked-cache', 'preserve');
    fs.mkdirSync(path.join(f.root, '${CACHE_LEAF}'));
    f.env.CACHE_LEAF = 'blocked-cache';
    f.env.npm_config_cache = path.join(f.root, '${CACHE_LEAF}');
    onlyFailure(f.run(), 'CACHE_SELECTION', /without whitespace or substitutions/);
    f.env.npm_config_cache = path.join(f.root, 'cache');
    f.env.Npm_Config_Cache = path.join(f.root, 'blocked-cache');
    onlyFailure(f.run(), 'CACHE_SELECTION', /conflicting case-insensitive/);
    delete f.env.Npm_Config_Cache;
    f.env.npm_config_cache += ' ';
    onlyFailure(f.run(), 'CACHE_SELECTION', /without whitespace or substitutions/);
    assert.deepEqual(fs.readdirSync(path.join(f.root, '${CACHE_LEAF}')), []);
});

test('missing browser is actionable only in browser mode', t => {
    const f = fixture(t);
    f.env.CHROMIUM_EXECUTABLE_PATH = path.join(f.root, 'absent-browser');
    onlyFailure(f.run(), 'BROWSER_MISSING', /CHROMIUM_EXECUTABLE_PATH.*existing executable Chromium/);
    assert.deepEqual(failures(f.run(false)), []);
    assert.equal(f.run(false).some(check => /BROWSER|PLAYWRIGHT/.test(check.code)), false);
});

test('a writable cache root does not mask an unusable existing npm temporary directory', t => {
    const f = fixture(t);
    f.write('cache/_cacache/tmp', 'preserve');
    onlyFailure(f.run(), 'CACHE_WRITABLE', /writable npm_config_cache/);
    assert.equal(fs.readFileSync(path.join(f.env.npm_config_cache, '_cacache/tmp'), 'utf8'), 'preserve');
    assert.deepEqual(fs.readdirSync(f.env.npm_config_cache), ['_cacache', 'existing']);
    assert.deepEqual(fs.readdirSync(path.join(f.env.npm_config_cache, '_cacache')), ['tmp']);
});

test('wrong Node and PATH selection are detected', t => {
    const f = fixture(t);
    f.write('package.json', { ...f.manifest, engines: { node: '>=999.0.0' } });
    onlyFailure(f.run(), 'NODE_VERSION', /Select Node satisfying/);
    f.write('package.json', f.manifest);
    fs.unlinkSync(path.join(f.root, 'bin/node'));
    f.write('bin/node', '#!/bin/false\n', 0o755);
    onlyFailure(f.run(), 'NODE_RESOLUTION', /first on PATH/);
});

test('unsupported engine expressions fail closed', t => {
    const f = fixture(t);
    f.write('package.json', { ...f.manifest, engines: { node: '>=22 <25' } });
    onlyFailure(f.run(), 'NODE_VERSION', /only a stable >=major.minor.patch/);
});

test('stale npm-script tool link is detected without executing it', t => {
    const f = fixture(t);
    fs.unlinkSync(path.join(f.root, 'node_modules/.bin/jest'));
    fs.symlinkSync('../promptfoo/cli.cjs', path.join(f.root, 'node_modules/.bin/jest'));
    onlyFailure(f.run(), 'TOOL_RESOLUTION', /jest: repair\/select/);
});

test('correct caller PATH fallback cannot mask a missing root link and stale ancestor tool', t => {
    const f = fixture(t);
    fs.unlinkSync(path.join(f.root, 'node_modules/.bin/jest'));
    fs.symlinkSync('../node_modules/jest/cli.cjs', path.join(f.root, 'bin/jest'));
    f.write('../node_modules/.bin/jest', '#!/bin/false\n', 0o755);
    onlyFailure(f.run(), 'TOOL_RESOLUTION', /jest: repair\/select/);
});

test('unusable scratch and missing vendor input have separate remedies', t => {
    const f = fixture(t);
    f.env.TMPDIR = path.join(f.root, 'absent-scratch');
    onlyFailure(f.run(), 'SCRATCH_WRITABLE', /writable TMPDIR/);
    f.env.TMPDIR = path.join(f.root, 'scratch');
    fs.unlinkSync(path.join(f.root, 'vendor/fixture.tgz'));
    onlyFailure(f.run(), 'VENDOR_INPUT', /restore the declared local vendor archive/);
});

test('manifest-lock declaration drift is not accepted as a healthy install', t => {
    const f = fixture(t);
    f.manifest.devDependencies['@nofries/prerequisite-fixture'] = '2.0.0';
    f.write('package.json', f.manifest);
    onlyFailure(f.run(), 'DEPENDENCY_LOCK', /manifest\/lock metadata disagree/);
});

test('npm timeout is bounded and does not expose subprocess output', t => {
    const f = fixture(t);
    f.write('bin/npm', `#!${process.execPath}\nif (process.argv[2] === '--version') {
console.error('do-not-echo-fixture-output'); setInterval(() => {}, 1000);
} else process.exit(9);\n`);
    const checks = f.run();
    onlyFailure(checks, 'NPM_RESOLUTION', /within 4 seconds/);
    assert.equal(JSON.stringify(checks).includes('do-not-echo-fixture-output'), false);
});

test('npm-style compile-cache activation cannot leave scratch or inherited cache writes', t => {
    const f = fixture(t);
    f.write('bin/compiled.cjs', 'module.exports = "synthetic";');
    f.write('bin/npm', `#!${process.execPath}\nrequire('node:module').enableCompileCache();
require('./compiled.cjs'); console.log('11.0.0');\n`);
    assert.deepEqual(failures(f.run()), []);
    assert.deepEqual(fs.readdirSync(f.env.TMPDIR), []);
    f.write('compile-cache/existing', 'preserve');
    f.env.NODE_COMPILE_CACHE = path.join(f.root, 'compile-cache');
    assert.deepEqual(failures(f.run()), []);
    assert.deepEqual(fs.readdirSync(f.env.NODE_COMPILE_CACHE), ['existing']);
    assert.equal(fs.readFileSync(path.join(f.env.NODE_COMPILE_CACHE, 'existing'), 'utf8'), 'preserve');
});
