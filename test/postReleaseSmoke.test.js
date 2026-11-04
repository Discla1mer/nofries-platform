'use strict';

// Runs the post-release smoke script against the genuine production
// application composition with synthetic providers. Synthetic data only.
const SHA = 'a'.repeat(40);
jest.mock('../api/shared/releaseManifest.json', () => ({ schemaVersion: 2, releaseSha: 'a'.repeat(40), runId: '1' }));

const { runSmoke, parseArgs, formatReport, READ_ONLY_PATHS, SIGN_IN_CHECK } = require('../scripts/post-release-smoke');
const { customerProductionHarness } = require('./helpers/customerProductionHarness');

let servers = [];
beforeAll(() => { jest.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(async () => { await Promise.all(servers.map(s => new Promise(r => s.close(r)))); servers = []; });

// Records every durable side effect the harness can observe: blob records and
// versions in every storage account, SQL statements, delivered mail and
// identity-provider sign-in requests.
function tracked(options) {
    const h = customerProductionHarness(options), sql = [], writes = [];
    const instrument = c => {
        const get = c.getBlockBlobClient.bind(c);
        c.getBlockBlobClient = key => {
            const client = get(key);
            for (const method of ['uploadData', 'delete', 'deleteIfExists']) {
                const original = client[method].bind(client);
                client[method] = (...args) => { writes.push(method); return original(...args); };
            }
            return client;
        };
    };
    for (const c of h.state.containers.values()) instrument(c);
    const set = h.state.containers.set.bind(h.state.containers);
    h.state.containers.set = (key, c) => { instrument(c); return set(key, c); };
    const connect = h.pool.connect.bind(h.pool);
    h.pool.connect = async () => {
        const client = await connect(), query = client.query.bind(client);
        client.query = (text, params) => { sql.push(String(text)); return query(text, params); };
        return client;
    };
    const snapshot = () => JSON.stringify({
        blobs: [...h.state.containers].map(([name, c]) => [name, [...c.records].map(([k, v]) => [k, Buffer.from(v).toString('base64')])]),
        writes: writes.length, sql: sql.length, mail: h.state.delivered.length, signIn: h.state.authRequests.length
    });
    return { h, snapshot };
}
async function serve(h) {
    const server = h.app.listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    servers.push(server);
    return `http://127.0.0.1:${server.address().port}`;
}
// The committed release.json is served from disk; return the same synthetic
// manifest the health endpoint sees, as a released package would.
const releasedFetch = (manifest = { schemaVersion: 2, releaseSha: SHA, runId: '1' }) => (url, init) =>
    new URL(url).pathname === '/release.json'
        ? Promise.resolve(new Response(JSON.stringify(manifest), { headers: { 'content-type': 'application/json' } }))
        : fetch(url, init);
const failed = report => report.results.filter(r => !r.ok).map(r => r.name);
const CONFIGS = { 'organisation setup and assessments': { starter: true }, 'external customer sign-in': { external: true }, 'external-only signup': { starter: true, external: true, customerSignup: false } };

test.each(Object.entries(CONFIGS))('every default probe is write-free with %s', async (_, options) => {
    const { h, snapshot } = tracked(options), base = await serve(h);
    for (const path of READ_ONLY_PATHS) {
        const before = snapshot();
        await fetch(base + path, { redirect: 'manual' });
        expect([path, snapshot()]).toEqual([path, before]);
    }
});

test('the default run passes and writes nothing against the production composition', async () => {
    const { h, snapshot } = tracked({ starter: true }), base = await serve(h), before = snapshot();
    const report = await runSmoke({ baseUrl: base, expectSha: SHA, allowHttp: true, fetchImpl: releasedFetch() });
    expect(failed(report)).toEqual([]);
    expect(report).toMatchObject({ ok: true, readOnly: true });
    expect(report.results.map(r => r.name)).not.toContain(SIGN_IN_CHECK.name);
    expect(snapshot()).toEqual(before);
});

test('the default run never requests a sign-in route', async () => {
    const requested = [];
    await runSmoke({ baseUrl: 'https://example.invalid', fetchImpl: url => { requested.push(new URL(url).pathname); return Promise.reject(new Error('offline')); } });
    expect(requested.sort()).toEqual([...READ_ONLY_PATHS].sort());
    for (const path of SIGN_IN_CHECK.paths) expect(requested).not.toContain(path);
});

test('the opt-in sign-in probe is labelled and its write is real', async () => {
    const { h, snapshot } = tracked({ starter: true }), base = await serve(h), before = snapshot();
    const report = await runSmoke({ baseUrl: base, allowHttp: true, includeSignInRedirect: true, fetchImpl: releasedFetch() });
    expect(failed(report)).toEqual([]);
    expect(report.readOnly).toBe(false);
    expect(snapshot()).not.toEqual(before);
    expect(parseArgs(['--include-sign-in-redirect'])).toEqual({ includeSignInRedirect: true });
});

test('fails when the site serves a different release than expected', async () => {
    const report = await runSmoke({ baseUrl: await serve(tracked({ starter: true }).h), expectSha: 'b'.repeat(40), allowHttp: true, fetchImpl: releasedFetch() });
    expect(failed(report)).toEqual(['health reports ok with a release SHA']);
});

test('fails when release.json disagrees with the running build', async () => {
    const report = await runSmoke({ baseUrl: await serve(tracked({ starter: true }).h), allowHttp: true,
        fetchImpl: releasedFetch({ schemaVersion: 2, releaseSha: 'c'.repeat(40), runId: '1' }) });
    expect(failed(report)).toEqual(['release.json matches health']);
});

test('fails when the assessment API is not wired', async () => {
    const report = await runSmoke({ baseUrl: await serve(tracked({}).h), allowHttp: true, fetchImpl: releasedFetch() });
    expect(failed(report)).toEqual(['assessment API is wired and requires sign-in']);
});

test('treats an unreachable site as a failure on every check', async () => {
    const report = await runSmoke({ baseUrl: 'https://example.invalid', fetchImpl: () => Promise.reject(new Error('offline')) });
    expect(report.ok).toBe(false);
    expect(report.results.every(r => !r.ok)).toBe(true);
});

test('only issues credential-free GET requests without following redirects', async () => {
    const calls = [];
    await runSmoke({ baseUrl: 'https://example.invalid', includeSignInRedirect: true,
        fetchImpl: (url, init) => { calls.push(init); return Promise.reject(new Error('offline')); } });
    expect(calls.length).toBe(READ_ONLY_PATHS.length + SIGN_IN_CHECK.paths.length);
    for (const init of calls) {
        expect(init).toMatchObject({ method: 'GET', redirect: 'manual', credentials: 'omit' });
        expect(Object.keys(init.headers)).toEqual(['Accept']);
        expect(init.body).toBeUndefined();
    }
});

test('rejects unsafe targets and unknown arguments', async () => {
    await expect(runSmoke({ baseUrl: 'http://example.com' })).rejects.toThrow('https');
    await expect(runSmoke({ baseUrl: 'https://example.com/app' })).rejects.toThrow('origin only');
    await expect(runSmoke({ baseUrl: 'https://example.com', expectSha: 'main' })).rejects.toThrow('40-character');
    expect(() => parseArgs(['--write'])).toThrow('Unknown argument');
});

test('a flag missing its value fails instead of skipping the check', () => {
    expect(() => parseArgs(['--base-url', 'https://example.com', '--expect-sha'])).toThrow('--expect-sha requires a value');
    expect(() => parseArgs(['--expect-sha', '--base-url', 'https://example.com'])).toThrow('--expect-sha requires a value');
    expect(() => parseArgs(['--expect-sha', ''])).toThrow('--expect-sha requires a value');
    expect(() => parseArgs(['--base-url'])).toThrow('--base-url requires a value');
    expect(parseArgs(['--base-url', 'https://example.com', '--expect-sha', 'a'.repeat(40)]))
        .toEqual({ baseUrl: 'https://example.com', expectSha: 'a'.repeat(40) });
});

// Canary values are synthetic; none may reach a report or an argument error.
test('failure output names the exact step and URL without echoing server secrets', async () => {
    const secret = 'synthetic-secret-canary';
    const report = await runSmoke({ baseUrl: 'https://example.invalid', fetchImpl: async () =>
        new Response(JSON.stringify({ code: secret, releaseSha: secret }), { status: 503,
            headers: { location: `https://example.invalid/?token=${secret}`, 'set-cookie': `session=${secret}` } }) });
    const output = formatReport(report);
    expect(output).toContain('FAIL step 11: assessment API is wired and requires sign-in (expected HTTP 401, got 503)');
    expect(output).toContain('GET https://example.invalid/api/dashboard/ncsc/assessments -> HTTP 503');
    expect(output).toContain('FAIL post-release smoke: 0/11 checks passed.');
    expect(JSON.stringify(report) + output).not.toContain(secret);
    expect(() => parseArgs([`--${secret}`])).toThrow('Unknown argument;');
    try { parseArgs([`--${secret}`]); } catch (error) { expect(error.message).not.toContain(secret); }
});

test('network errors are labelled without printing exception details', async () => {
    const report = await runSmoke({ baseUrl: 'https://example.invalid', fetchImpl: async () => { throw new Error('synthetic-secret'); } });
    expect(formatReport(report)).toContain('GET https://example.invalid/api/health -> NETWORK/TIMEOUT failure');
    expect(formatReport(report)).not.toContain('synthetic-secret');
});

test.each(['https://user:synthetic-secret@example.invalid', 'https://example.invalid?token=synthetic-secret',
    'https://example.invalid#synthetic-secret', 'synthetic-secret'])('unsafe base URL never makes a request or leaks input: %s', async baseUrl => {
    const fetchImpl = jest.fn();
    await expect(runSmoke({ baseUrl, fetchImpl })).rejects.not.toThrow('synthetic-secret');
    expect(fetchImpl).not.toHaveBeenCalled();
});

test('CLI returns 0 for pass, 1 for failed checks and 2 for invalid arguments', async () => {
    const { spawn } = require('node:child_process');
    const http = require('node:http');
    let missingAssessment = false;
    const server = http.createServer((req, res) => {
        const path = req.url;
        res.setHeader('content-type', 'application/json');
        if (path === '/api/health' || path === '/release.json') return res.end(JSON.stringify({ status: 'ok', releaseSha: SHA }));
        if (['/signup', '/login', '/dashboard'].includes(path)) { res.setHeader('content-type', 'text/html'); return res.end('<html></html>'); }
        if (path === '/api/customer-signup/state') return res.end(JSON.stringify({ state: { status: 'create_account' } }));
        if (path.includes('organisation-setup')) return res.end(JSON.stringify({ state: 'start' }));
        if (path === '/api/dashboard/login') { res.writeHead(302, { location: '/login' }); return res.end(); }
        res.statusCode = missingAssessment && path.endsWith('/assessments') ? 404 : 401; res.end('{}');
    });
    server.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r)); servers.push(server);
    const base = `http://127.0.0.1:${server.address().port}`;
    const cli = args => new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [require.resolve('../scripts/post-release-smoke'), ...args]);
        let output = ''; child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
        child.on('error', reject); child.on('close', code => resolve({ code, output }));
    });
    const args = ['--base-url', base, '--allow-http', '--expect-sha', SHA];
    const pass = await cli(args); expect(pass.code).toBe(0); expect(pass.output).toContain('PASS post-release smoke: 11/11');
    missingAssessment = true;
    const fail = await cli(args); expect(fail.code).toBe(1);
    expect(fail.output).toContain(`GET ${base}/api/dashboard/ncsc/assessments -> HTTP 404`);
    expect(fail.output).toContain('FAIL post-release smoke: 10/11');
    const invalid = await cli(['--synthetic-secret']); expect(invalid.code).toBe(2); expect(invalid.output).not.toContain('synthetic-secret');
});

test('external-only signup passes and cannot hide a broken selected provider behind legacy state', async () => {
    const { h, snapshot } = tracked({ starter: true, external: true, customerSignup: false });
    const base = await serve(h), before = snapshot();
    expect((await fetch(base + '/api/customer-signup/state')).status).toBe(410);
    const report = await runSmoke({ baseUrl: base, allowHttp: true, fetchImpl: releasedFetch() });
    expect(failed(report)).toEqual([]); expect(snapshot()).toEqual(before);
    const broken = await runSmoke({ baseUrl: base, allowHttp: true, fetchImpl: (url, init) => {
        if (url.pathname === '/api/customer-signup/state') return Promise.resolve(new Response(JSON.stringify({ state: { status: 'create_account' } })));
        if (url.pathname === '/api/external-customer-signup/state') return Promise.resolve(new Response('{}', { status: 503 }));
        return releasedFetch()(url, init);
    } });
    expect(failed(broken)).toEqual(['signup starts at create_account']);
    expect(formatReport(broken)).toContain('/api/external-customer-signup/state: expected create_account, got HTTP 503');
});
