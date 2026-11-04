'use strict';

// Real SDK + separate Node workers against a file-backed HTTP implementation of
// Azure's documented ETag/If-Match contract. No cloud credentials or email calls.
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { LIMIT, WINDOW_MS, TIMEOUT_MS } = require('../api/shared/enquiryRateLimit');

test('shared quota survives worker and store restarts across real SDK clients', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enquiry-quota-'));
    const file = path.join(dir, 'state.json');
    let at = Date.parse('2026-11-04T00:00:00Z');
    fs.writeFileSync(file, JSON.stringify({ revision: 1, body: { version: 1, lastObserved: 0, expires: [] } }));
    function start() {
        const server = http.createServer(async (req, res) => {
            res.setHeader('Date', new Date(at).toUTCString());
            res.setHeader('x-ms-request-id', 'synthetic-request');
            res.setHeader('x-ms-version', '2025-11-05');
            if (req.method === 'GET') {
                const state = JSON.parse(fs.readFileSync(file, 'utf8'));
                const data = JSON.stringify(state.body);
                res.setHeader('ETag', `"${state.revision}"`);
                res.setHeader('Content-Length', Buffer.byteLength(data));
                res.setHeader('Content-Type', 'application/json');
                res.setHeader('x-ms-blob-type', 'BlockBlob');
                res.end(data);
                return;
            }
            let data = '';
            for await (const chunk of req) data += chunk;
            const state = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (req.method !== 'PUT' || req.headers['if-match'] !== `"${state.revision}"`) {
                res.statusCode = 412;
                res.setHeader('x-ms-error-code', 'ConditionNotMet');
                res.setHeader('Content-Type', 'application/xml');
                res.end('<Error><Code>ConditionNotMet</Code><Message>Condition failed</Message></Error>');
                return;
            }
            state.body = JSON.parse(data); state.revision += 1;
            fs.writeFileSync(file, JSON.stringify(state));
            res.statusCode = 201;
            res.setHeader('ETag', `"${state.revision}"`);
            res.end();
        });
        return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
    }
    const stop = server => new Promise(resolve => server.close(resolve));
    function worker(server, count) {
        const program = `
            const { BlockBlobClient, AnonymousCredential } = require('@azure/storage-blob');
            const { createEnquiryRateLimiter } = require('./api/shared/enquiryRateLimit');
            const { createEnquiryService } = require('./api/shared/enquiry');
            const client = new BlockBlobClient(process.argv[1], new AnonymousCredential(), { allowInsecureConnection: true, retryOptions: { maxTries: 1 } });
            let sent = 0, limited = 0, unavailable = 0;
            const service = createEnquiryService({
                env: { RESEND_API_KEY: 'synthetic', NOFRIES_ENQUIRY_EMAIL_FROM: 'web@example.invalid' },
                rateLimiter: createEnquiryRateLimiter({ client }),
                fetchImpl: async () => { sent += 1; return { ok: true }; }
            });
            (async () => {
                for (let i = 0; i < Number(process.argv[2]); i += 1) {
                    try { await service.submitEnquiry({ name: 'Test', email: 'test@example.invalid', message: 'Synthetic test enquiry' }); }
                    catch (e) { if (e.status === 429) limited += 1; else if (e.status === 503) unavailable += 1; else throw e; }
                }
                process.stdout.write(JSON.stringify({ sent, limited, unavailable }));
            })().catch(() => process.exit(1));
        `;
        return new Promise((resolve, reject) => {
            const child = spawn(process.execPath, ['-e', program, `http://127.0.0.1:${server.address().port}/account/enquiry-rate-limit/public-enquiry-v1.json`, String(count)], {
                cwd: path.resolve(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe']
            });
            let output = '', errors = '';
            child.stdout.on('data', data => { output += data; });
            child.stderr.on('data', data => { errors += data; });
            child.on('error', reject);
            child.on('exit', code => code ? reject(new Error(`Synthetic worker failed: ${errors}`)) : resolve(JSON.parse(output)));
        });
    }
    let server;
    try {
        server = await start();
        const results = await Promise.all(Array.from({ length: 4 }, () => worker(server, 12)));
        const drain = await worker(server, LIMIT);
        expect(results.reduce((sum, x) => sum + x.sent, drain.sent)).toBe(LIMIT);
        expect(JSON.parse(fs.readFileSync(file, 'utf8')).body.expires).toHaveLength(LIMIT);
        await stop(server);
        server = await start();
        expect(await worker(server, 3)).toEqual({ sent: 0, limited: 3, unavailable: 0 });
        at += WINDOW_MS + TIMEOUT_MS + 1000;
        expect(await worker(server, 1)).toEqual({ sent: 1, limited: 0, unavailable: 0 });
    } finally {
        if (server && server.listening) await stop(server);
        fs.rmSync(dir, { recursive: true, force: true });
    }
}, 30000);
