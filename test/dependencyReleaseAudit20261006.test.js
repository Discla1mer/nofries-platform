'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const testCase = globalThis.test || require('node:test').test;
const root = path.join(__dirname, '..');

// Keep module loading, git fixtures and zlib instrumentation in disposable children.
// These fixtures never start an HTTP server, use a remote, or bootstrap a proxy agent.
function runNode(source) {
    const result = spawnSync(process.execPath, ['-e', source], {
        cwd: root,
        encoding: 'utf8',
        timeout: 10000,
        env: { ...process.env, NODE_OPTIONS: '', NODE_NO_WARNINGS: '0' }
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 0, result.stderr);
    return result;
}

function assertGitGuard({ config = [], args, message }) {
    runNode(`
        const assert = require('node:assert/strict');
        const fs = require('node:fs');
        const os = require('node:os');
        const path = require('node:path');
        const { simpleGit } = require('simple-git');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-git-config-guard-'));
        (async () => {
            try {
                const git = simpleGit({
                    baseDir: dir,
                    binary: path.join(dir, 'must-not-spawn'),
                    config: ${JSON.stringify(config)}
                }).env({ PATH: process.env.PATH });
                await assert.rejects(git.raw(${JSON.stringify(args)}), error => {
                    assert.doesNotMatch(error.message, /ENOENT/);
                    assert.match(error.message, new RegExp(${JSON.stringify(message)}));
                    return true;
                });
            } finally { fs.rmSync(dir, { recursive: true, force: true }); }
        })().catch(error => { console.error(error); process.exitCode = 1; });
    `);
}

testCase('simple-git blocks trailer command configuration before any helper can spawn', () => {
    assertGitGuard({
        config: ['trailer.audit.cmd=/nonexecuted'],
        args: ['interpret-trailers', '--trailer', 'audit:synthetic'],
        message: 'trailer'
    });
});

testCase('simple-git blocks configuration file inclusion before spawning git', () => {
    assertGitGuard({
        config: ['include.path=/nonexistent'],
        args: ['status'],
        message: 'include'
    });
});

testCase('simple-git disables option abbreviation in the Git environment before any command can spawn', () => {
    runNode(`
        const assert = require('node:assert/strict');
        const childProcess = require('node:child_process');
        let intercepted;
        // The supported fix belongs to Git's argument parser. Inspect the actual
        // spawn boundary without creating an OS process or executing a helper.
        childProcess.spawn = (binary, args, options) => {
            intercepted = { binary, args, options };
            throw new Error('fixture_spawn_blocked');
        };
        const { simpleGit } = require('simple-git');
        (async () => {
            for (const option of ['--receive-p=/nonexecuted', '--exe=/nonexecuted']) {
                intercepted = undefined;
                const git = simpleGit({ binary: '/nonexistent/must-not-spawn' }).env({ PATH: process.env.PATH });
                await assert.rejects(git.raw(['push', option, 'synthetic-remote']), /fixture_spawn_blocked/);
                assert.ok(intercepted);
                assert.equal(intercepted.binary, '/nonexistent/must-not-spawn');
                assert.deepEqual(intercepted.args, ['push', option, 'synthetic-remote']);
                assert.equal(intercepted.options.env.GIT_TEST_DISALLOW_ABBREVIATED_OPTIONS, 'true');
            }
        })().catch(error => { console.error(error); process.exitCode = 1; });
    `);
});

testCase('simple-git uses the repaired parser to block VISUAL before spawning a process', () => {
    runNode(`
        const assert = require('node:assert/strict');
        const fs = require('node:fs');
        const os = require('node:os');
        const path = require('node:path');
        const { createRequire } = require('node:module');
        const { simpleGit } = require('simple-git');
        const fromGit = createRequire(require.resolve('simple-git'));
        const parser = fromGit('@simple-git/argv-parser');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-git-guard-'));
        (async () => {
            try {
                const editor = path.join(dir, 'nonexecuted-editor');
                const env = { PATH: process.env.PATH, TERM: 'xterm', VISUAL: editor };
                const problems = parser.vulnerabilityCheck(['commit', '--amend'], env);
                assert.ok(problems.some(problem => problem.category === 'allowUnsafeEditor'));
                // A regression would try the nonexistent binary and fail with ENOENT,
                // rather than the required unsafe-editor rejection before spawn.
                const git = simpleGit({ baseDir: dir, binary: path.join(dir, 'must-not-spawn') }).env(env);
                await assert.rejects(git.raw(['commit', '--amend']), error => {
                    assert.match(error.message, /VISUAL/);
                    assert.match(error.message, /allowUnsafeEditor/);
                    return true;
                });
                assert.equal(fs.existsSync(editor), false);
            } finally { fs.rmSync(dir, { recursive: true, force: true }); }
        })().catch(error => { console.error(error); process.exitCode = 1; });
    `);
});

testCase('simple-git keeps the supported named import, status and revparse working on a disposable local repository', () => {
    runNode(`
        const assert = require('node:assert/strict');
        const fs = require('node:fs');
        const os = require('node:os');
        const path = require('node:path');
        const { execFileSync } = require('node:child_process');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-git-compatible-'));
        (async () => {
            try {
                const env = { PATH: process.env.PATH, LC_ALL: 'C' };
                execFileSync('git', ['init', '--quiet', dir], { env, stdio: 'pipe' });
                const { simpleGit } = await import('simple-git');
                assert.equal(typeof simpleGit, 'function');
                const git = simpleGit(dir).env(env);
                assert.equal((await git.status()).isClean(), true);
                assert.equal(fs.realpathSync(await git.revparse(['--show-toplevel'])), fs.realpathSync(dir));
                fs.writeFileSync(path.join(dir, 'synthetic.txt'), 'synthetic fixture');
                assert.deepEqual((await git.status()).not_added, ['synthetic.txt']);
            } finally { fs.rmSync(dir, { recursive: true, force: true }); }
        })().catch(error => { console.error(error); process.exitCode = 1; });
    `);
});

testCase('root js-yaml 4 load and dump retain safe YAML validation with supported argparse 2', () => {
    const yaml = require('js-yaml');
    const yamlEntry = require.resolve('js-yaml');
    const fromYaml = createRequire(yamlEntry);
    assert.equal(fromYaml('argparse/package.json').version, '2.0.1');
    assert.equal(require('js-yaml/package.json').version, '4.3.2');
    assert.deepEqual(yaml.load('enabled: true\nname: synthetic\nitems: [a, b]\n'), {
        enabled: true, name: 'synthetic', items: ['a', 'b']
    });
    assert.throws(() => yaml.load('key: one\nkey: two\n'), /duplicated mapping key/);
    assert.throws(() => yaml.load('!!js/function function () { return 1; }'), /unknown tag/);
    assert.deepEqual(yaml.load(yaml.dump({ synthetic: ['one', 'two'] })), {
        synthetic: ['one', 'two']
    });
});

testCase('the supported js-yaml 4 CLI keeps conversion, flags, help and version without deprecation warnings', () => {
    const cli = path.join(path.dirname(require.resolve('js-yaml/package.json')), 'bin/js-yaml.js');
    function invoke(args, input) {
        const result = spawnSync(process.execPath, [cli, ...args], {
            cwd: root, input, encoding: 'utf8', timeout: 10000,
            env: { ...process.env, NODE_OPTIONS: '', NODE_NO_WARNINGS: '0' }
        });
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stderr);
        assert.doesNotMatch(result.stderr, /DeprecationWarning/);
        assert.doesNotMatch(result.stderr, /TypeError|ReferenceError|SyntaxError/);
        return result;
    }
    const converted = invoke(['-c', '--to-json', '--trace', '-'], 'message: synthetic\ncount: 3\n');
    assert.deepEqual(JSON.parse(converted.stdout), { message: 'synthetic', count: 3 });
    const defaultInput = invoke([], '{"message":"synthetic","count":3}');
    assert.deepEqual(require('js-yaml').load(defaultInput.stdout), { message: 'synthetic', count: 3 });
    const help = invoke(['--help'], '');
    assert.match(help.stdout, /--compact/);
    assert.match(help.stdout, /--trace/);
    assert.doesNotMatch(help.stdout, /--to-json/);
    assert.equal(invoke(['--version'], '').stdout.trim(), '4.3.2');
});

testCase('Express numeric one-hop trust still selects the nearest forwarded address', () => {
    const express = require('express');
    const proxyaddr = require('proxy-addr');
    const app = express();
    app.set('trust proxy', 1);
    const trust = app.get('trust proxy fn');
    const req = {
        socket: { remoteAddress: '192.0.2.10' },
        headers: { 'x-forwarded-for': '198.51.100.12, 203.0.113.8' }
    };
    assert.equal(trust(req.socket.remoteAddress, 0), true);
    assert.equal(trust('203.0.113.8', 1), false);
    assert.equal(proxyaddr(req, trust), '203.0.113.8');
    assert.deepEqual(proxyaddr.all(req, trust), ['192.0.2.10', '203.0.113.8']);
    assert.equal(proxyaddr({ ...req, headers: {} }, trust), '192.0.2.10');
});

testCase('IPv6 trust subnets no longer accidentally trust unrelated IPv4 addresses', () => {
    const proxyaddr = require('proxy-addr');
    for (const subnet of ['::ffff:10.0.0.0/8', '::/1']) {
        assert.equal(proxyaddr.compile(subnet)('203.0.113.8'), false, subnet);
        assert.equal(proxyaddr.compile([subnet, '192.0.2.0/24'])('203.0.113.8'), false, subnet);
    }
    const mapped = proxyaddr.compile('::ffff:10.0.0.0/104');
    assert.equal(mapped('10.1.2.3'), true);
    assert.equal(mapped('203.0.113.8'), false);
    const ipv6 = proxyaddr.compile('2001:db8::/32');
    assert.equal(ipv6('2001:db8::1234'), true);
    assert.equal(ipv6('2001:db9::1234'), false);
});

testCase('compression releases a live gzip stream when the response closes prematurely', () => {
    runNode(`
        const assert = require('node:assert/strict');
        const { EventEmitter } = require('node:events');
        const zlib = require('node:zlib');
        const createGzip = zlib.createGzip;
        let gzip;
        Object.defineProperty(zlib, 'createGzip', { configurable: true, value(...args) {
            gzip = createGzip(...args);
            return gzip;
        }});
        class Response extends EventEmitter {
            constructor() { super(); this.headers = new Map(); this.statusCode = 200; this.headersSent = false; }
            getHeader(name) { return this.headers.get(name.toLowerCase()); }
            setHeader(name, value) { this.headers.set(name.toLowerCase(), value); }
            removeHeader(name) { this.headers.delete(name.toLowerCase()); }
            writeHead() { this.headersSent = true; return this; }
            write() { return false; }
            end() { throw new Error('premature close must not complete the response'); }
        }
        (async () => {
            const response = new Response();
            response.setHeader('Content-Type', 'text/plain');
            const request = { method: 'GET', headers: { 'accept-encoding': 'gzip' } };
            let nextCalls = 0;
            require('compression')({ threshold: 0 })(request, response, () => { nextCalls += 1; });
            assert.equal(nextCalls, 1);
            response.write('synthetic response still in progress');
            assert.equal(response.getHeader('Content-Encoding'), 'gzip');
            assert.ok(gzip);
            assert.equal(gzip.destroyed, false);
            try {
                response.emit('close');
                await new Promise(resolve => setImmediate(resolve));
                assert.equal(gzip.destroyed, true);
                assert.equal(gzip.closed, true);
            } finally { gzip.destroy(); }
        })().catch(error => { console.error(error); process.exitCode = 1; });
    `);
});
