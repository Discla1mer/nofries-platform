'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { configuration, localSockets, cleanupAll, formatReport } = require('../authenticated-customer-journey');
const env = { NOFRIES_JOURNEY_DATABASE_URL: 'postgresql://synthetic:synthetic@127.0.0.1:5432/nofries_journey',
    NOFRIES_JOURNEY_DISPOSABLE_CLUSTER: 'true' };

test('default is off even with configured credentials; unknown or production flags fail before loading application', () => {
    assert.equal(configuration([], env), null);
    for (const args of [['--run'], ['--base-url', 'https://nofries.nz'], ['--run-local', '--owner-approved-production'],
        ['--production'], ['--run-local', '--tenant', 'dedicated']]) assert.throws(() => configuration(args, env));
    const result = spawnSync(process.execPath, [require.resolve('../authenticated-customer-journey')], { encoding: 'utf8' });
    assert.equal(result.status, 0); assert.match(result.stdout, /^DISABLED:/);
    const denied = spawnSync(process.execPath, [require.resolve('../authenticated-customer-journey'), '--base-url', 'https://secret@example.test'], { encoding: 'utf8' });
    assert.equal(denied.status, 2); assert.ok(!denied.stderr.includes('secret@example'));
});

test('only an explicitly disposable numeric loopback database is allowed', () => {
    assert.equal(configuration(['--run-local'], env).databaseUrl, env.NOFRIES_JOURNEY_DATABASE_URL);
    for (const value of ['', 'postgresql://u:p@nofries.nz/nofries_journey', 'postgresql://u:p@localhost/nofries_journey',
        'postgresql://u:p@127.0.0.1/production', 'postgresql://u:p@127.0.0.1/nofries_journey?host=nofries.nz',
        'postgresql://u:p@127.0.0.1/nofries_journey#override', 'https://u:p@127.0.0.1/nofries_journey']) {
        assert.throws(() => configuration(['--run-local'], { ...env, NOFRIES_JOURNEY_DATABASE_URL: value }));
    }
    assert.throws(() => configuration(['--run-local'], { ...env, NOFRIES_JOURNEY_DISPOSABLE_CLUSTER: 'false' }));
    assert.throws(() => configuration(['--run-local'], { NOFRIES_DATABASE_URL: env.NOFRIES_JOURNEY_DATABASE_URL }));
});

test('socket guard rejects production, aliases, Unix sockets and unapproved ports before connecting', () => {
    const net = require('node:net'), original = net.Socket.prototype.connect;
    const restore = localSockets(new Set([5432]));
    try {
        for (const options of [{ host: 'nofries.nz', port: 443 }, { host: 'localhost', port: 5432 },
            { host: '127.0.0.1', port: 9999 }, { path: '/tmp/postgres.sock' }]) {
            const socket = new net.Socket();
            try { assert.throws(() => socket.connect(options), /destination denied/); } finally { socket.destroy(); }
        }
    } finally { restore(); }
    assert.equal(net.Socket.prototype.connect, original);
});

test('cleanup attempts every resource in reverse order and fails the run on any cleanup error', async () => {
    const calls = [];
    assert.equal(await cleanupAll([async () => calls.push('pool'), async () => { calls.push('database'); throw new Error('secret'); },
        async () => calls.push('server')]), false);
    assert.deepEqual(calls, ['server', 'database', 'pool']);
});

test('socket guard permits only the owned HTTP listener and a synthetic authentication callback', async () => {
    const { customerProductionHarness } = require('../../test/helpers/customerProductionHarness');
    const request = require('supertest');
    const h = customerProductionHarness({ starter: true, external: true, now: Date.now() });
    const server = require('node:http').createServer(h.app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const restore = localSockets(new Set([server.address().port]));
    try {
        const start = await request(server).get('/api/external-customer-auth/login').redirects(0).timeout(5000);
        assert.equal(start.status, 302);
        const callback = await h.sameOrigin(request(server).post('/api/external-customer-auth/callback'))
            .set('Cookie', start.headers['set-cookie'][0].split(';')[0]).type('form').timeout(5000)
            .send({ code: 'synthetic-managed-code', state: new URL(start.headers.location).searchParams.get('state') });
        assert.equal(callback.status, 303);
    } finally { restore(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('report uses numbered PASS/FAIL, step and URL without diagnostic payloads', () => {
    const output = formatReport({ ok: false, steps: [{ ok: false, name: 'save answers and verify fresh read',
        error: 'secret-cookie', body: { token: 'secret-code' }, probes: [{ method: 'POST', url: 'http://127.0.0.1:1234/api/dashboard/ncsc/assessments', status: 503 }] }] });
    assert.match(output, /FAIL step 1: save answers/); assert.match(output, /POST http:\/\/127\.0\.0\.1:1234\/api\/dashboard\/ncsc\/assessments -> HTTP 503/);
    assert.doesNotMatch(output, /secret-cookie|secret-code/);
});
