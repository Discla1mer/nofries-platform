'use strict';

// Qualify the installed runner client using loopback only. These are transport
// observations, not an assertion that repeated HTTP fields are unique or that
// the 1536-byte evidence schema limit bounds curl's earlier allocation.
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn, execFileSync } = require('child_process');

const SELECTED_WRITE_OUT = '%{http_code}\\n%header{x-nofries-canary-evidence}\\n';
const BODY = Buffer.from('{"synthetic":"body remains unchanged"}\n');
const REQUEST = JSON.stringify({ jsonrpc: '2.0', id: 'authenticated_canary', method: 'tools/call',
    params: { name: 'search', arguments: { query: '__release_canary__' + 'a'.repeat(40) } } });
const SINGLE_FIELD_LIMIT = 100 * 1024;
const COMPLETE_HEADERS_LIMIT = 300 * 1024;
const CLIENT_IDENTITY = execFileSync('curl', ['--disable', '--version'], { encoding: 'utf8' }).split('\n')[0];
const CLIENT_VERSION = /^curl (\d+\.\d+\.\d+)/.exec(CLIENT_IDENTITY)?.[1];
const LIBRARY_VERSION = /\blibcurl\/(\d+\.\d+\.\d+)/.exec(CLIENT_IDENTITY)?.[1];

function response(headers = [], options = {}) {
    return Buffer.concat([
        Buffer.from(`HTTP/1.1 ${options.status || 200} Synthetic\r\n` + headers.join('\r\n') +
            (headers.length ? '\r\n' : '') +
            `Content-Length: ${options.contentLength ?? BODY.length}\r\nConnection: close\r\n\r\n`),
        options.body ?? BODY
    ]);
}

async function withServer(bytes, run, options = {}) {
    const sockets = new Set();
    const requests = [];
    const server = net.createServer(socket => {
        sockets.add(socket);
        socket.on('error', () => {}); // Oversized headers deliberately make curl close early.
        socket.on('close', () => sockets.delete(socket));
        let incoming = Buffer.alloc(0), replied = false;
        socket.on('data', chunk => {
            incoming = Buffer.concat([incoming, chunk]);
            const separator = incoming.indexOf('\r\n\r\n');
            if (replied || separator < 0) return;
            const headerText = incoming.subarray(0, separator).toString('ascii');
            const length = Number(/\r\nContent-Length: (\d+)/i.exec(headerText)?.[1] || 0);
            if (incoming.length < separator + 4 + length) return;
            replied = true;
            requests.push({ headers: headerText,
                body: incoming.subarray(separator + 4, separator + 4 + length).toString('utf8') });
            if (options.holdOpen) socket.write(bytes);
            else socket.end(bytes);
        });
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    try {
        return await run(`http://127.0.0.1:${server.address().port}/api/mcp`, requests);
    } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise(resolve => server.close(resolve));
    }
}

async function curl(url, capture, options = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'connector-canary-curl-'));
    const output = path.join(directory, 'existing-response.json');
    const args = ['--disable', '--silent', '--show-error', '--max-time', options.timeout || '2',
        '--write-out', capture ? SELECTED_WRITE_OUT : '%{http_code}',
        '--output', output, '--request', 'POST', '--header', 'Content-Type: application/json'];
    if (capture) args.push('--header', 'X-NoFries-Canary-Probe: ' + 'b'.repeat(32));
    args.push('--data', REQUEST, url);
    try {
        const child = spawn('curl', args, { env: { PATH: process.env.PATH, LC_ALL: 'C', NO_PROXY: '*' } });
        const stdout = [], stderr = [];
        child.stdout.on('data', chunk => stdout.push(chunk));
        child.stderr.on('data', chunk => stderr.push(chunk));
        const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
        const result = await new Promise((resolve, reject) => {
            child.once('error', reject);
            child.once('close', (code, signal) => resolve({ code, signal }));
        }).finally(() => clearTimeout(timer));
        const writeout = Buffer.concat(stdout).toString('utf8');
        const firstLine = writeout.split('\n', 1)[0];
        return { ...result, status: firstLine, writeout, stderr: Buffer.concat(stderr).toString('utf8'),
            body: fs.existsSync(output) ? fs.readFileSync(output) : Buffer.alloc(0) };
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

async function compare(bytes, inspect, options = {}) {
    return withServer(bytes, async (url, requests) => {
        const original = await curl(url, false, options);
        const selected = await curl(url, true, options);
        expect(original.signal).toBeNull();
        expect(selected.signal).toBeNull();
        expect(selected.code).toBe(original.code);
        expect(selected.status).toBe(original.status);
        expect(selected.body.equals(original.body)).toBe(true);
        expect(requests).toHaveLength(2); // One invocation each; no retry.
        expect(requests.map(value => value.body)).toEqual([REQUEST, REQUEST]);
        expect(requests[0].headers).not.toContain('X-NoFries-Canary-Probe');
        expect(requests[1].headers).toContain('X-NoFries-Canary-Probe: ' + 'b'.repeat(32));
        await inspect({ original, selected });
    }, options);
}

function expectSingleFieldRejection({ original, selected }) {
    // curl8.5.0's headerb uses CURL_MAX_HTTP_HEADER; dyn_nappend returns27
    // before allocating past that cap. Do not accept arbitrary OOM behavior.
    // https://github.com/curl/curl/blob/curl-8_5_0/lib/dynbuf.c#L62-L103
    expect([27, 56, 100]).toContain(selected.code);
    if (selected.code === 27) {
        expect(CLIENT_VERSION).toBe('8.5.0');
        expect(LIBRARY_VERSION).toBe('8.5.0');
        expect(selected.stderr).toBe('curl: (27) Out of memory\n');
    }
    expect(selected.status).toBe('200');
    expect(selected.stderr).toBe(original.stderr);
    expect(selected.stderr).toMatch(new RegExp('^curl: \\(' + selected.code + '\\)'));
    expect(selected.body.length).toBe(0);
    expect(selected.writeout).toBe('200\n\n');
}

describe('installed curl selected-header transport for optional canary binding', () => {
    test('the observed GitHub runner image matches the existing release runner family', () => {
        if (process.env.GITHUB_ACTIONS === 'true') {
            expect(process.env.ImageOS).toBe('ubuntu24');
            expect(process.env.RUNNER_OS).toBe('Linux');
        } else {
            expect(process.platform).toBe('linux');
        }
    });

    test('existing client supports the required named-header write-out version', () => {
        // Version metadata only, through the existing test output; no HTTP data.
        process.stdout.write('Synthetic connector transport client: ' + CLIENT_IDENTITY + '\n');
        const version = /^curl (\d+)\.(\d+)\.(\d+)/.exec(CLIENT_IDENTITY);
        expect(version).not.toBeNull();
        expect(Number(version[1]) > 7 || Number(version[1]) === 7 && Number(version[2]) >= 84).toBe(true);
    });

    test.each([
        ['present', ['X-NoFries-Canary-Evidence: c3ludGhldGlj'], 'c3ludGhldGlj'],
        ['missing', [], ''],
        ['malformed evidence', ['X-NoFries-Canary-Evidence: %%% invalid payload %%%'], '%%% invalid payload %%%'],
        ['oversized schema value', ['X-NoFries-Canary-Evidence: ' + 'x'.repeat(1537)], 'x'.repeat(1537)],
        ['repeated', ['X-NoFries-Canary-Evidence: first', 'X-NoFries-Canary-Evidence: second'], 'first'],
        ['folded multiline', ['X-NoFries-Canary-Evidence: first', ' second'], 'first second']
    ])('preserves status, body, exit and stderr for %s header', async (_, headers, value) => {
        await compare(response(headers), ({ original, selected }) => {
            expect(selected.code).toBe(0);
            expect(selected.status).toBe('200');
            expect(selected.body.equals(BODY)).toBe(true);
            expect(selected.stderr).toBe(original.stderr);
            expect(selected.stderr).toBe('');
            expect(selected.writeout === '200\n' + value + '\n').toBe(true);
        });
    });

    test('keeps either known empty-header representation finite and inconclusive', async () => {
        await compare(response(['X-NoFries-Canary-Evidence:']), ({ original, selected }) => {
            expect(selected.code).toBe(0);
            expect(selected.status).toBe('200');
            expect(selected.body.equals(BODY)).toBe(true);
            expect(selected.stderr).toBe(original.stderr);
            expect(selected.stderr).toBe('');
            // curl8.5.0 keeps CR in an empty value;8.14.1 excludes it. The
            // workflow must leave CR invalid, never turn it into valid proof.
            // https://github.com/curl/curl/blob/curl-8_5_0/lib/headers.c#L176-L207
            expect(['200\n\n', '200\n\r\n']).toContain(selected.writeout);
        });
    });

    test('does not convert an HTTP rejection into success or change its response', async () => {
        await compare(response(['X-NoFries-Canary-Evidence: ignored'], { status: 503 }), ({ selected }) => {
            expect(selected.code).toBe(0); // Existing curl has no --fail; the strict status check owns rejection.
            expect(selected.status).toBe('503');
            expect(selected.body.equals(BODY)).toBe(true);
        });
    });

    test('preserves original HTTP status and curl exit on an interrupted body', async () => {
        await compare(response(['X-NoFries-Canary-Evidence: partial'], {
            contentLength: BODY.length + 20
        }), ({ original, selected }) => {
            expect(selected.code).toBe(18);
            expect(selected.status).toBe('200');
            expect(selected.body.equals(BODY)).toBe(true);
            expect(selected.stderr).toBe(original.stderr);
            expect(selected.stderr).toMatch(/^curl: \(18\)/);
        });
    });

    test('preserves a transport timeout without retrying the interrupted request', async () => {
        await compare(response(['X-NoFries-Canary-Evidence: partial'], {
            contentLength: BODY.length + 20
        }), ({ original, selected }) => {
            expect(selected.code).toBe(28);
            expect(selected.status).toBe('200');
            expect(selected.body.equals(BODY)).toBe(true);
            // curl's elapsed-time number can differ by a millisecond; both native
            // stderr streams remain unmodified and retain the original error.
            expect(original.stderr).toMatch(/^curl: \(28\) Operation timed out/);
            expect(selected.stderr).toMatch(/^curl: \(28\) Operation timed out/);
        }, { holdOpen: true, timeout: '0.2' });
    });

    test('qualifies a successful large field and a finite single-field rejection', async () => {
        await compare(response(['X-NoFries-Canary-Evidence: ' + 'x'.repeat(90 * 1024)]), ({ selected }) => {
            expect(selected.code).toBe(0);
            expect(Buffer.byteLength(selected.writeout)).toBe(90 * 1024 + 5);
        });
        await compare(response(['X-NoFries-Canary-Evidence: ' + 'x'.repeat(SINGLE_FIELD_LIMIT)]),
            expectSingleFieldRejection);
        await compare(response(['X-NoFries-Canary-Evidence: ' + 'x'.repeat(90 * 1024)]), ({ selected }) => {
            expect(selected.code).toBe(0);
            expect(Buffer.byteLength(selected.writeout)).toBe(90 * 1024 + 5);
        });
    });

    test('rejects an unterminated field at the finite cap without waiting for more bytes', async () => {
        // There is no field terminator or body. A client that kept growing or
        // waited for more input would time out28 instead of rejecting the cap.
        const prefix = Buffer.from('HTTP/1.1 200 Synthetic\r\nX-NoFries-Canary-Evidence: ' +
            'x'.repeat(SINGLE_FIELD_LIMIT));
        await compare(prefix, expectSingleFieldRejection, { holdOpen: true, timeout: '1' });
    });

    test.each(['repeated', 'folded selected value']) (
        'qualifies a finite aggregate-header bound for %s input', async kind => {
            const lines = kind === 'repeated'
                ? Array.from({ length: 2048 }, () => 'X-NoFries-Canary-Evidence: ' + 'x'.repeat(999))
                : ['X-NoFries-Canary-Evidence: first', ...Array.from({ length: 2048 }, () => ' ' + 'x'.repeat(999))];
            await compare(response(lines), ({ original, selected }) => {
                expect(selected.code).not.toBe(0);
                expect(selected.status).toBe('200');
                expect(selected.stderr).toBe(original.stderr);
                expect(selected.stderr).toMatch(/^curl: \((100|56)\)/);
                expect(Buffer.byteLength(selected.writeout)).toBeLessThanOrEqual(COMPLETE_HEADERS_LIMIT + 5);
            });
        });
});
