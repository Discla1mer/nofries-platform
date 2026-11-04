'use strict';
const https = require('node:https');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const { PATHS, checkHealth, request, run, formatReport } = require('../scripts/production-health-monitor');
const NOW = Date.parse('2026-11-05T00:00:00Z');
const validTo = new Date(NOW + 60 * 86400000).toUTCString();
const env = { NOFRIES_MONITOR_ENABLED: 'true', NOFRIES_MONITOR_ALERT_WEBHOOK: 'https://alerts.invalid/path?token=canary' };
const healthy = path => ({ status: 200, validTo, type: path.startsWith('/api/') ? 'application/json' : 'text/html',
    text: path === '/api/health' ? '{"status":"ok"}' : path.startsWith('/api/') ? '{"state":{"status":"create_account"}}' : '<html></html>' });
const report = (override = {}) => checkHealth({ now: NOW, requestImpl: async url => ({ ...healthy(url.pathname), ...override[url.pathname] }) });

test('healthy pages, API, signup and certificate pass', async () => {
    const result = await report();
    expect(result.ok).toBe(true); expect(result.results).toHaveLength(9);
    expect(result.certificateDaysRemaining).toBe(60);
});
test.each([['/signup', { status: 302 }], ['/dashboard', { type: 'application/json' }],
    ['/api/health', { text: '{"status":"failed"}' }], ['/api/health', { text: 'invalid json' }],
    ['/api/customer-signup/state', { status: 503 }], ['/', { status: 0 }]])('rejects unhealthy %s: %j', async (path, changed) => {
    expect((await report({ [path]: changed })).ok).toBe(false);
});
test('selected external provider cannot be masked by a healthy inactive legacy provider', async () => {
    const external = { '/signup': { text: "customerTransport: 'external'" }, '/api/customer-signup/state': { status: 410 } };
    expect((await report(external)).ok).toBe(true);
    expect((await report({ ...external, '/api/customer-signup/state': {}, '/api/external-customer-signup/state': { status: 503 } })).ok).toBe(false);
});
test.each([[-1, false], [29, false], [30, true]])('certificate threshold %i days is %s', async (days, expected) => {
    const result = await report({ '/': { validTo: new Date(NOW + days * 86400000).toUTCString() } });
    expect(result.ok).toBe(expected);
});
test('missing certificate and secret-bearing errors fail without leaking bodies or exceptions', async () => {
    const r = await checkHealth({ now: NOW, requestImpl: async () => { throw new Error('canary'); } });
    expect(r.ok).toBe(false); expect(formatReport(r)).not.toContain('canary');
    const bad = await report({ '/api/health': { text: '{"status":"canary"}' }, '/': { validTo: undefined } });
    expect(bad.ok).toBe(false); expect(formatReport(bad)).not.toContain('canary');
});
test.each([{}, { NOFRIES_MONITOR_ENABLED: 'false' }, { NOFRIES_MONITOR_ENABLED: 'TRUE' },
    { NOFRIES_MONITOR_ENABLED: 'true' }, { ...env, NOFRIES_MONITOR_ALERT_WEBHOOK: 'http://alerts.invalid/canary' },
    { ...env, NOFRIES_MONITOR_ALERT_WEBHOOK: 'https://user:canary@alerts.invalid' }])('configuration is fail-closed before ALL network activity: %j', async config => {
    const probe = jest.fn(), deliver = jest.fn(), log = jest.fn();
    await run({ env: config, probe, deliver, log });
    expect(probe).not.toHaveBeenCalled(); expect(deliver).not.toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toContain('canary');
});
test('healthy enabled runs do not notify; unhealthy runs send one sanitized text alert', async () => {
    const deliver = jest.fn(async () => ({ status: 204 })), log = jest.fn();
    expect(await run({ env, probe: () => report(), deliver, log })).toBe(0);
    expect(deliver).not.toHaveBeenCalled();
    expect(await run({ env, probe: () => report({ '/': { status: 503, text: 'canary' } }), deliver, log })).toBe(1);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][1].payload.text).toContain('FAIL /');
    expect(JSON.stringify(deliver.mock.calls[0][1]) + JSON.stringify(log.mock.calls)).not.toContain('canary');
});
test.each([0, 302, 429, 500])('alert delivery HTTP %i fails the job without retrying or exposing destination', async status => {
    const deliver = jest.fn(async () => ({ status })), log = jest.fn();
    expect(await run({ env, probe: () => report({ '/': { status: 503 } }), deliver, log })).toBe(2);
    expect(deliver).toHaveBeenCalledTimes(1); expect(JSON.stringify(log.mock.calls)).not.toContain('canary');
});
test('unexpected check/delivery exceptions are sanitized and fail closed', async () => {
    const log = jest.fn(), deliver = jest.fn(async () => { throw Error('canary'); });
    expect(await run({ env, probe: async () => { throw Error('canary'); }, deliver, log })).toBe(2);
    expect(deliver).toHaveBeenCalledTimes(1); expect(JSON.stringify(log.mock.calls)).not.toContain('canary');
});

describe('real HTTPS transport with a local synthetic certificate', () => {
    let server, base, cert, trusted;
    const seen = [];
    beforeAll(async () => {
        const forge = require('node-forge');
        const keys = forge.pki.rsa.generateKeyPair(2048), c = forge.pki.createCertificate();
        c.publicKey = keys.publicKey; c.serialNumber = '01';
        c.validity.notBefore = new Date(Date.now() - 86400000); c.validity.notAfter = new Date(Date.now() + 90 * 86400000);
        c.setSubject([{ name: 'commonName', value: 'localhost' }]); c.setIssuer(c.subject.attributes);
        c.setExtensions([{ name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] }]);
        c.sign(keys.privateKey, forge.md.sha256.create()); cert = forge.pki.certificateToPem(c);
        server = https.createServer({ key: forge.pki.privateKeyToPem(keys.privateKey), cert }, (req, res) => {
            seen.push({ method: req.method, path: req.url, headers: req.headers });
            if (req.url === '/hang') return;
            if (req.url === '/big') return res.end(Buffer.alloc(1024 * 1024 + 1));
            if (req.url === '/redirect') { res.writeHead(302, { location: '/canary', 'set-cookie': 'token=canary' }); return res.end('canary'); }
            res.setHeader('content-type', 'text/html'); res.end('<html>synthetic</html>');
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        base = `https://127.0.0.1:${server.address().port}`;
        trusted = (url, options, cb) => https.request(url, { ...options, ca: cert }, cb);
    });
    afterAll(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    test('validates TLS, observes expiry, sends credential-free GET and never follows redirects', async () => {
        const r = await request(new URL('/', base), { requestImpl: trusted });
        expect(r.status).toBe(200); expect(Date.parse(r.validTo)).toBeGreaterThan(Date.now());
        expect(await request(new URL('/', base))).toEqual({ status: 0 }); // untrusted chain
        expect(await request(new URL('/', base), { requestImpl: (url, options, cb) =>
            trusted(url, { ...options, servername: 'wrong.invalid' }, cb) })).toEqual({ status: 0 });
        const offset = seen.length;
        expect((await request(new URL('/redirect', base), { requestImpl: trusted })).status).toBe(302);
        expect(seen.slice(offset).map(x => x.path)).toEqual(['/redirect']);
        for (const req of seen) {
            expect(req.method).toBe('GET'); expect(req.headers.cookie).toBeUndefined(); expect(req.headers.authorization).toBeUndefined();
            expect(req.headers['accept-encoding']).toBe('identity'); expect(req.headers['cache-control']).toBe('no-cache');
        }
    });
    test('bounded body and stalled response terminate', async () => {
        expect(await request(new URL('/big', base), { requestImpl: trusted })).toEqual({ status: 0 });
        expect(await request(new URL('/hang', base), { requestImpl: trusted, timeoutMs: 30 })).toEqual({ status: 0 });
    });
    test('alert POST uses JSON and does not follow a redirect', async () => {
        const offset = seen.length;
        expect((await request(new URL('/redirect', base), { requestImpl: trusted, payload: { text: 'synthetic alert' } })).status).toBe(302);
        expect(seen.slice(offset)).toHaveLength(1);
        expect(seen[offset].method).toBe('POST'); expect(seen[offset].headers['content-type']).toBe('application/json');
    });
});
test('absolute deadline covers DNS/connect stalls and destroys the request', async () => {
    jest.useFakeTimers();
    try {
        const req = new EventEmitter(); req.end = jest.fn(); req.destroy = jest.fn();
        const pending = request(new URL('https://example.invalid'), { requestImpl: () => req, timeoutMs: 50 });
        await jest.advanceTimersByTimeAsync(50);
        expect(await pending).toEqual({ status: 0 }); expect(req.destroy).toHaveBeenCalledTimes(1);
    } finally { jest.useRealTimers(); }
});

// Reuse #17's production-harness proof: observe ALL durable writes, not just
// successful responses, on each actual route without invoking auth-start routes.
test.each([{ starter: true }, { starter: true, external: true, customerSignup: false }])('every probe is read-only against production composition: %j', async options => {
    const { customerProductionHarness } = require('./helpers/customerProductionHarness');
    const supertest = require('supertest'), h = customerProductionHarness(options), mutations = [];
    const instrument = container => {
        const get = container.getBlockBlobClient.bind(container);
        container.getBlockBlobClient = key => {
            const client = get(key);
            for (const name of ['uploadData', 'delete', 'deleteIfExists']) {
                const original = client[name].bind(client);
                client[name] = (...args) => { mutations.push(name); return original(...args); };
            }
            return client;
        };
    };
    for (const c of h.state.containers.values()) instrument(c);
    const set = h.state.containers.set.bind(h.state.containers);
    h.state.containers.set = (key, c) => { instrument(c); return set(key, c); };
    const connect = h.pool.connect.bind(h.pool);
    h.pool.connect = async () => { mutations.push('sql connection'); return connect(); };
    const before = JSON.stringify({ mail: h.state.delivered, auth: h.state.authRequests });
    for (const path of PATHS) await supertest(h.app).get(path);
    expect(mutations).toEqual([]);
    expect(JSON.stringify({ mail: h.state.delivered, auth: h.state.authRequests })).toBe(before);
});
test('workflow is schedule-only, gated, read-only and isolated from PR secrets', () => {
    const yaml = require('js-yaml');
    const workflow = yaml.load(fs.readFileSync(require.resolve('../.github/workflows/production-health.yml'), 'utf8'));
    expect(Object.keys(workflow.on)).toEqual(['schedule']);
    expect(workflow.on.schedule).toEqual([{ cron: '7,22,37,52 * * * *' }]);
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(workflow.jobs.monitor.if).toContain("vars.NOFRIES_MONITOR_ENABLED == 'true'");
    expect(workflow.jobs.monitor.if).toContain("github.repository == 'Discla1mer/nofries-platform'");
    expect(workflow.jobs.monitor.timeoutMinutes || workflow.jobs.monitor['timeout-minutes']).toBe(5);
    for (const step of workflow.jobs.monitor.steps.filter(x => x.uses)) expect(step.uses).toMatch(/@[0-9a-f]{40}$/);
    expect(workflow.jobs.monitor.steps[0].with['persist-credentials']).toBe(false);
});
