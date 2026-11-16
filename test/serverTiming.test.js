'use strict';

const serverTiming = require('../api/shared/serverTiming');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test('records named stages, repeat counts and a total inside one request', async () => {
    const value = await serverTiming.run(async state => {
        await serverTiming.measure('session', () => pause(5));
        await serverTiming.measure('db', () => pause(1));
        await serverTiming.measure('db', () => pause(1));
        return serverTiming.header(state);
    });
    expect(value).toMatch(/^session;dur=\d+\.\d, db;dur=\d+\.\d;desc="2", total;dur=\d+\.\d$/);
});

test('keeps concurrent requests apart', async () => {
    const [a, b] = await Promise.all([
        serverTiming.run(async state => { await serverTiming.measure('epoch', () => pause(2)); return serverTiming.header(state); }),
        serverTiming.run(async state => { await serverTiming.measure('connect', () => pause(2)); return serverTiming.header(state); })
    ]);
    expect(a).toMatch(/^epoch;dur=/); expect(a).not.toContain('connect');
    expect(b).toMatch(/^connect;dur=/); expect(b).not.toContain('epoch');
});

test('outside a request, measure is a plain call and records nothing', async () => {
    await expect(serverTiming.measure('db', async () => 7)).resolves.toBe(7);
});

test('a failing step still records its time and rethrows the same error', async () => {
    const failure = new Error('boom');
    const value = await serverTiming.run(async state => {
        await expect(serverTiming.measure('db', async () => { throw failure; })).rejects.toBe(failure);
        return serverTiming.header(state);
    });
    expect(value).toMatch(/^db;dur=/);
});

test('only fixed lowercase stage names are emitted, and the stage count is capped', async () => {
    const value = await serverTiming.run(async state => {
        serverTiming.record('Bad Name', 1); serverTiming.record('x;y', 1); serverTiming.record('ok', Number.NaN);
        for (let i = 0; i < 20; i += 1) serverTiming.record('s' + i, 1);
        return serverTiming.header(state);
    });
    expect(value).not.toMatch(/Bad|x;y|ok;/);
    expect(value.split(', ')).toHaveLength(13);
});
