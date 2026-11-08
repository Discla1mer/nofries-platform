'use strict';
const fs = require('node:fs');
const net = require('node:net');
const { once } = require('node:events');
const { createHarness, bounded } = require('./helpers/enquiryProcessHarness');
const { LIMIT, WINDOW_MS, TIMEOUT_MS } = require('../api/shared/enquiryRateLimit');

test('shared quota survives forced cross-process races and worker/store restarts', async () => {
    const fixture = createHarness();
    try {
        await bounded((async () => {
            await fixture.start(4);
            const results = await fixture.run([12, 12, 12, 12]);
            const [drain] = await fixture.run([LIMIT]);
            expect(results.reduce((sum, x) => sum + x.sent, drain.sent)).toBe(LIMIT);
            expect(fixture.conflicts()).toBeGreaterThanOrEqual(3);
            expect(fixture.state().body.expires).toHaveLength(LIMIT);
            await fixture.stop();
            await fixture.start();
            expect(await fixture.run([3])).toEqual([{ sent: 0, limited: 3, unavailable: 0 }]);
            fixture.advance(WINDOW_MS + TIMEOUT_MS + 1000);
            expect(await fixture.run([1])).toEqual([{ sent: 1, limited: 0, unavailable: 0 }]);
        })(), 25000, 'complete scenario');
    } finally { await fixture.cleanup(); }
    expect(fixture.workers.every(x => x.closed)).toBe(true);
    expect(fs.existsSync(fixture.dir)).toBe(false);
}, 30000);

test('a stalled worker and open store socket are terminated and state removed on failure', async () => {
    const fixture = createHarness();
    let socket, closed;
    try {
        await fixture.start();
        socket = net.connect(fixture.port(), '127.0.0.1');
        closed = once(socket, 'close');
        await bounded(once(socket, 'connect'), 2000, 'fixture connection');
        await expect(fixture.run([1], { stall: true, deadlineMs: 100 })).rejects.toThrow('worker completion');
    } finally {
        await fixture.cleanup();
        if (socket) socket.destroy();
        if (closed) await bounded(closed, 2000, 'client socket close');
    }
    expect(fixture.workers.every(x => x.closed && x.signal === 'SIGKILL')).toBe(true);
    expect(fs.existsSync(fixture.dir)).toBe(false);
}, 15000);
