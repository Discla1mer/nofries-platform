'use strict';

// Usage: SWA_BIN=/absolute/path/to/swa node scripts/tests/swa-api-headers.cjs BEFORE_DIST AFTER_DIST
// Use @azure/static-web-apps-cli@2.0.7 and two built static packages.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { createProductionApplication } = require('../../lib/productionApplication');

const dirs = process.argv.slice(2).map(dir => path.resolve(dir));
assert.equal(dirs.length, 2, 'supply baseline and candidate build directories');
const configs = dirs.map(dir => JSON.parse(fs.readFileSync(path.join(dir, 'staticwebapp.config.json'))));
const app = createProductionApplication({});
const backend = http.createServer(app);
let snapshot;
let originCalls = 0;
const origin = http.createServer((req, res) => {
    originCalls++;
    if (!snapshot) return res.end(); // Emulator readiness request.
    res.writeHead(snapshot.status, snapshot.headers);
    res.end(snapshot.body);
});

async function probe(url, method) {
    const calls = originCalls;
    const response = await fetch(url, { method, redirect: 'manual', signal: AbortSignal.timeout(5000) });
    await response.arrayBuffer();
    const headers = Object.fromEntries(response.headers);
    // Date and hop-by-hop connection lifetime vary by request.
    for (const key of ['date', 'connection', 'keep-alive']) delete headers[key];
    return { status: response.status, headers, forwarded: originCalls > calls };
}

async function main() {
    await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve));
    await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
    const api = 'http://127.0.0.1:' + origin.address().port;
    const children = [];
    try {
        const edges = [];
        for (const [index, dir] of dirs.entries()) {
            const port = 17366 + index;
            const url = 'http://127.0.0.1:' + port;
            const child = spawn(process.env.SWA_BIN || 'swa', ['start', dir, '-w', dir, '-is', api,
                '-q', '127.0.0.1', '-p', String(port)], { cwd: dir, detached: true, stdio: 'ignore',
                env: { ...process.env, SWA_CLI_TELEMETRY_OPTOUT: '1' } });
            children.push(child);
            let ready = false;
            for (let n = 0; n < 100 && !ready; n++) {
                assert.equal(child.exitCode, null, 'emulator exited during startup');
                await delay(100);
                ready = await fetch(url + '/index.html', { redirect: 'manual' }).then(() => true, () => false);
            }
            assert.ok(ready, 'emulator startup timed out');
            edges.push(url);
        }
        const apiRules = config => config.routes.filter(rule => rule.route.startsWith('/api/'));
        const routing = config => apiRules(config).map(({ headers, ...rule }) => rule);
        assert.deepEqual(routing(configs[0]), routing(configs[1]));
        let cases = 0;
        for (const rule of apiRules(configs[0])) {
            const endpoint = rule.route.replace('*', 'header-check');
            const methods = rule.methods || ['GET', 'HEAD', 'POST', 'OPTIONS'];
            const rejected = rule.methods && ['GET', 'POST', 'DELETE'].find(m => !methods.includes(m));
            for (const method of [...methods, ...(rejected ? [rejected] : [])]) {
                // Capture one real backend result for both proxies. Cookies, rate limits and
                // nonce-bearing responses otherwise legitimately differ between requests.
                const result = await fetch('http://127.0.0.1:' + backend.address().port + endpoint, {
                    method, redirect: 'manual', headers: { 'x-forwarded-for': '192.0.2.' + (cases % 250 + 1) }
                });
                const headers = Object.fromEntries(result.headers);
                if (result.headers.has('set-cookie')) headers['set-cookie'] = result.headers.getSetCookie();
                snapshot = { status: result.status, headers, body: Buffer.from(await result.arrayBuffer()) };
                const before = await probe(edges[0] + endpoint, method);
                const after = await probe(edges[1] + endpoint, method);
                const label = method + ' ' + endpoint;
                assert.deepEqual(after, before, label);
                if (rule.route === '/api/*' || method === rejected) {
                    assert.equal(after.forwarded, false, label);
                    assert.equal(after.status, 401, label);
                } else {
                    assert.equal(after.forwarded, true, label);
                    const next = apiRules(configs[1]).find(candidate => candidate.route === rule.route);
                    for (const [name, value] of Object.entries(rule.headers || {})) {
                        if (Object.hasOwn(next.headers || {}, name)) continue;
                        const received = after.headers[name.toLowerCase()];
                        const normalized = received?.replace(/; +/g, ';').replace('noindex, nofollow', 'none');
                        assert.equal(normalized, value, label + ' must receive ' + name + ' from App Service');
                    }
                }
                cases++;
            }
        }
        await new Promise(resolve => origin.close(resolve));
        let unavailable = 0;
        for (const [index, rule] of apiRules(configs[0]).entries()) {
            if (JSON.stringify(rule.headers) === JSON.stringify(apiRules(configs[1])[index].headers)) continue;
            const endpoint = rule.route.replace('*', 'header-check');
            const method = rule.methods?.[0] || 'GET';
            const before = await probe(edges[0] + endpoint, method);
            const after = await probe(edges[1] + endpoint, method);
            assert.deepEqual(after, before, 'unreachable origin: ' + endpoint);
            assert.equal(after.status, 502, endpoint);
            assert.equal(after.forwarded, false, endpoint);
            unavailable++;
        }
        console.log(unavailable + ' matched edge-generated 502 responses');
        console.log(cases + ' effective status/header comparisons across ' + apiRules(configs[0]).length + ' API rules');
    } finally {
        for (const child of children) {
            if (child.pid && child.exitCode === null) process.kill(-child.pid, 'SIGTERM');
        }
        if (origin.listening) origin.close();
        backend.close();
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
