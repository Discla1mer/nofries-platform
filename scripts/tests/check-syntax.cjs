const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { SOURCE_DIRECTORIES, ROOT_FILES } = require('../check-syntax');
const checker = path.resolve(__dirname, '../check-syntax.js');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nofries syntax '));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const directory of SOURCE_DIRECTORIES) fs.mkdirSync(path.join(root, directory), { recursive: true });
    for (const file of ROOT_FILES) fs.writeFileSync(path.join(root, file), 'const valid = true;\n');
    return root;
}

function run(root) {
    return spawnSync(process.execPath, ['-e', 'process.exitCode = require(process.argv[1]).checkSyntax(process.argv[2]);', checker, root], { encoding: 'utf8' });
}

test('checks nested .js and .cjs files with spaces without executing source', (t) => {
    const root = fixture(t);
    const nested = path.join(root, 'api', 'path with spaces');
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(nested, 'valid module.cjs'), 'throw new Error("must not execute source");\n');
    const result = run(root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Syntax checks passed \(4 JavaScript files\)/);
});

for (const extension of ['js', 'cjs']) {
    test(`fails when a nested .${extension} file has invalid syntax`, (t) => {
        const root = fixture(t);
        fs.writeFileSync(path.join(root, 'app', `invalid.${extension}`), 'const = ;\n');
        const result = run(root);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /Syntax check failed:/);
        assert.match(result.stderr, /SyntaxError/);
    });
}

test('excludes nested node_modules and non-JavaScript files', (t) => {
    const root = fixture(t);
    const dependencies = path.join(root, 'api', 'node_modules', 'dependency');
    fs.mkdirSync(dependencies, { recursive: true });
    fs.writeFileSync(path.join(dependencies, 'invalid.js'), 'const = ;\n');
    fs.writeFileSync(path.join(root, 'js', 'data.json'), 'not JavaScript');
    const result = run(root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\(3 JavaScript files\)/);
});

test('fails when a required source directory is missing', (t) => {
    const root = fixture(t);
    fs.rmdirSync(path.join(root, 'evals'));
    const result = run(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unable to enumerate JavaScript sources:/);
});

test('fails when a required root source is missing', (t) => {
    const root = fixture(t);
    fs.unlinkSync(path.join(root, 'server.js'));
    const result = run(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Syntax check failed: server.js/);
});
