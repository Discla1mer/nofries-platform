'use strict';

const { EventEmitter } = require('node:events');
const Pool = require('pg-pool');
const { trackPoolClientEnds } = require('./helpers/postgresPoolLifecycle');

class DelayedEndClient extends EventEmitter {
    constructor(options) {
        super();
        this.options = options;
        this._queryable = true;
        this._ending = false;
        this.closed = false;
        this.endCallbacks = [];
    }
    connect(callback) {
        if (this.options.holdConnect) this.finishConnect = () => callback();
        else callback();
    }
    end(callback) {
        this._ending = true;
        if (callback) this.endCallbacks.push(callback);
    }
    finishTransport() {
        for (const callback of this.endCallbacks.splice(0)) callback();
    }
    finishEnd() {
        this.finishTransport();
        this.closed = true;
        this.emit('end');
    }
}

function setup(options = {}) {
    const pool = new Pool({ Client: DelayedEndClient, max: 2, idleTimeoutMillis: 0, ...options });
    const close = trackPoolClientEnds(pool);
    return { pool, close };
}

const nextTurn = () => new Promise(resolve => setImmediate(resolve));

describe('PostgreSQL test pool disconnection fence', () => {
    test('waits for every client end even after the actual pool end promise has resolved', async () => {
        const { pool, close } = setup();
        const first = await pool.connect(), second = await pool.connect();
        first.release(); second.release();
        const dropDatabase = jest.fn();
        const closing = close().then(dropDatabase);
        await nextTurn();

        // Negative control: the locked dependency reports zero clients before
        // their end events. Replacing close() with pool.end() admits DROP here.
        expect(pool.ended).toBe(true);
        expect(pool.totalCount).toBe(0);
        expect(first.closed).toBe(false);
        expect(second.closed).toBe(false);
        expect(dropDatabase).not.toHaveBeenCalled();
        first.finishEnd();
        await nextTurn();
        expect(dropDatabase).not.toHaveBeenCalled();
        second.finishEnd();
        await closing;
        expect(dropDatabase).toHaveBeenCalledTimes(1);
    });

    test('retains a closing client already removed from the pool before shutdown', async () => {
        const { pool, close } = setup();
        const client = await pool.connect();
        client.release(true);
        expect(pool.totalCount).toBe(0);
        const afterClose = jest.fn(), closing = close().then(afterClose);
        await nextTurn();
        expect(pool.ended).toBe(true);
        expect(afterClose).not.toHaveBeenCalled();
        client.finishEnd();
        await closing;
        expect(afterClose).toHaveBeenCalledTimes(1);
    });

    test('tracks a connection that completes after shutdown has started', async () => {
        const { pool, close } = setup({ holdConnect: true });
        let connectingClient;
        const newClient = pool.Client;
        pool.Client = class extends newClient {
            constructor(options) { super(options); connectingClient = this; }
        };
        const connecting = pool.connect();
        const afterClose = jest.fn(), closing = close().then(afterClose);
        connectingClient.finishConnect();
        const client = await connecting;
        client.release();
        await nextTurn();
        expect(afterClose).not.toHaveBeenCalled();
        client.finishTransport();
        await nextTurn();
        expect(pool.ended).toBe(true);
        expect(afterClose).not.toHaveBeenCalled();
        client.finishEnd();
        await closing;
        expect(afterClose).toHaveBeenCalledTimes(1);
    });

    test('shares one shutdown operation for an empty pool and repeated callers', async () => {
        const { pool, close } = setup();
        const end = jest.spyOn(pool, 'end');
        const first = close(), second = close();
        expect(second).toBe(first);
        await first;
        expect(end).toHaveBeenCalledTimes(1);
        expect(close()).toBe(first);
        expect(pool.listenerCount('connect')).toBe(0);
    });

    test('propagates pool shutdown rejection and retains that failed close result', async () => {
        const { pool, close } = setup();
        await pool.end();
        const failure = close();
        await expect(failure).rejects.toThrow('Called end on pool more than once');
        expect(close()).toBe(failure);
        expect(pool.listenerCount('connect')).toBe(0);
    });

    test('does not install listeners that swallow client or pool errors', async () => {
        const { pool, close } = setup();
        const client = await pool.connect();
        const error = new Error('Synthetic client failure');
        expect(() => client.emit('error', error)).toThrow(/Synthetic client failure/);
        expect(pool.listenerCount('error')).toBe(0);
        client.release();
        const closing = close();
        client.finishEnd();
        await closing;
    });
});
