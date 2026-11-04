'use strict';
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');

async function bounded(promise, ms, phase) {
    let timer;
    try {
        return await Promise.race([promise, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Fixture deadline: ${phase}`)), ms);
        })]);
    } finally { clearTimeout(timer); }
}

function createHarness() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enquiry-quota-'));
    const file = path.join(dir, 'state.json');
    fs.writeFileSync(file, JSON.stringify({ revision: 1, body: { version: 1, lastObserved: 0, expires: [] } }));
    const sockets = new Set(), workers = [];
    let server, barrier = [], readers = 0, conflicts = 0, disposed = false;
    let at = Date.parse('2026-11-04T00:00:00Z');
    const state = () => JSON.parse(fs.readFileSync(file, 'utf8'));
    async function start(firstReaders = 0) {
        if (disposed) throw new Error('Fixture disposed');
        readers = firstReaders;
        server = http.createServer((req, res) => {
            (async () => {
                res.setHeader('Date', new Date(at).toUTCString());
                res.setHeader('x-ms-request-id', 'synthetic-request');
                res.setHeader('x-ms-version', '2025-11-05');
                if (req.method === 'GET') {
                    const snapshot = state(), data = JSON.stringify(snapshot.body);
                    const reply = () => {
                        res.writeHead(200, { ETag: `"${snapshot.revision}"`, 'Content-Length': Buffer.byteLength(data),
                            'Content-Type': 'application/json', 'x-ms-blob-type': 'BlockBlob' });
                        res.end(data);
                    };
                    // Force every first read to observe one revision, without sleeps.
                    if (readers) {
                        barrier.push(reply);
                        if (barrier.length === readers) {
                            readers = 0;
                            for (const release of barrier.splice(0)) release();
                        }
                    } else reply();
                    return;
                }
                let data = '';
                for await (const chunk of req) data += chunk;
                const current = state();
                if (req.method !== 'PUT' || req.headers['if-match'] !== `"${current.revision}"`) {
                    conflicts++;
                    res.writeHead(412, { 'x-ms-error-code': 'ConditionNotMet', 'Content-Type': 'application/xml' });
                    res.end('<Error><Code>ConditionNotMet</Code><Message>Condition failed</Message></Error>');
                    return;
                }
                current.body = JSON.parse(data); current.revision++;
                fs.writeFileSync(file, JSON.stringify(current));
                res.writeHead(201, { ETag: `"${current.revision}"`, 'Content-Length': 0 });
                res.end();
            })().catch(() => { res.statusCode = 500; res.end(); });
        });
        server.on('connection', socket => {
            sockets.add(socket);
            socket.once('close', () => sockets.delete(socket));
        });
        await bounded(new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', resolve);
        }), 2000, 'store listen');
    }
    async function stop() {
        barrier = []; readers = 0;
        if (!server) return;
        const closing = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        server.closeAllConnections();
        for (const socket of sockets) socket.destroy();
        await bounded(closing, 2000, 'store close');
        server = undefined;
    }
    async function run(counts, { stall = false, deadlineMs = 10000 } = {}) {
        if (disposed) throw new Error('Fixture disposed');
        const batch = counts.map(count => {
            const child = fork(path.join(__dirname, 'enquiryQuotaWorker.cjs'), [], {
                cwd: path.resolve(__dirname, '../..'), silent: true
            });
            const entry = { child, closed: false, result: undefined, error: undefined };
            workers.push(entry);
            child.stdout.resume(); child.stderr.resume();
            let ready;
            entry.ready = new Promise(resolve => { ready = resolve; });
            child.on('message', message => {
                if (message.ready) ready();
                else entry.result = message;
            });
            child.once('error', error => { entry.error = error; });
            entry.close = new Promise(resolve => child.once('close', (code, signal) => {
                entry.closed = true; entry.code = code; entry.signal = signal; resolve();
            }));
            entry.ready = Promise.race([entry.ready, entry.close.then(() => { throw new Error('Worker exited before ready'); })]);
            entry.count = count;
            return entry;
        });
        await bounded(Promise.all(batch.map(x => x.ready)), 10000, 'worker ready');
        if (disposed) throw new Error('Fixture disposed');
        for (const entry of batch) entry.child.send({ url: `http://127.0.0.1:${server.address().port}/account/enquiry-rate-limit/public-enquiry-v1.json`, count: entry.count, stall });
        await bounded(Promise.all(batch.map(x => x.close)), deadlineMs, 'worker completion');
        return batch.map(entry => {
            if (entry.error || entry.code !== 0 || !entry.result) throw new Error('Synthetic worker failed');
            return entry.result;
        });
    }
    async function cleanup() {
        disposed = true;
        for (const entry of workers) if (!entry.closed) entry.child.kill('SIGKILL');
        try {
            await Promise.all([stop(), bounded(Promise.all(workers.map(x => x.close)), 2000, 'worker cleanup')]);
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }
    return { start, stop, run, cleanup, state, dir, workers, sockets,
        advance: ms => { at += ms; }, conflicts: () => conflicts,
        port: () => server.address().port };
}
module.exports = { createHarness, bounded };
