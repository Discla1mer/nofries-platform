'use strict';
const { execFileSync } = require('node:child_process');

// Run the real installed adapter outside Jest's ESM loader. All fixtures and
// HTTP requests stay local; no application data or provider is accessed.
function installedProbe(source) {
    return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', source], {
        cwd: require('node:path').resolve(__dirname, '..'), encoding: 'utf8',
        timeout: 15000, maxBuffer: 32768
    }));
}

let files;
beforeAll(() => {
    files = installedProbe(String.raw`
        import { Hono } from 'hono';
        import { serveStatic } from '@hono/node-server/serve-static';
        import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
        import { tmpdir } from 'node:os';
        import { join } from 'node:path';
        const root = mkdtempSync(join(tmpdir(), 'nofries-hono-static-'));
        try {
            for (const [name, body] of Object.entries({ 'package.json': 'PRIVATE_FIXTURE',
                'README.txt': 'public fixture', 'hello world.txt': 'space fixture',
                'café.txt': 'unicode fixture' })) writeFileSync(join(root, name), body);
            const app = new Hono();
            app.use('*', async (c, next) => {
                // Hono exposes a single-decoded path to the guard. The static
                // adapter must never decode a residual percent into another path.
                if (c.req.path === '/package.json') return c.text('denied', 401);
                await next();
            });
            app.use('*', serveStatic({ root }));
            app.get('/fallback', c => c.text('fallback handler'));
            const result = {};
            for (const path of ['/package.json', '/%70ackage.json', '/%%37%30ackage.json',
                '/%%37%30ackage%2Ejson', '/README.txt', '/hello%20world.txt', '/caf%C3%A9.txt',
                '/missing.txt', '/fallback']) {
                const response = await app.request('http://localhost' + path);
                result[path] = { status: response.status, body: await response.text() };
            }
            const head = await app.request('http://localhost/README.txt', { method: 'HEAD' });
            result.head = { status: head.status, body: await head.text(), length: head.headers.get('content-length') };
            process.stdout.write(JSON.stringify(result));
        } finally { rmSync(root, { recursive: true, force: true }); }
    `);
});

test.each(['/package.json', '/%70ackage.json'])('explicit guard denies %s', path => {
    expect(files[path]).toEqual({ status: 401, body: 'denied' });
});
test.each(['/%%37%30ackage.json', '/%%37%30ackage%2Ejson'])('residual encoding cannot serve the protected file: %s', path => {
    expect(files[path].status).toBe(404);
    expect(files[path].body).not.toContain('PRIVATE_FIXTURE');
});
test.each([
    ['/README.txt', 'public fixture'], ['/hello%20world.txt', 'space fixture'],
    ['/caf%C3%A9.txt', 'unicode fixture'], ['/fallback', 'fallback handler']
])('ordinary static/fallback response %s remains usable', (path, body) => {
    expect(files[path]).toEqual({ status: 200, body });
});
test('HEAD and missing static files retain their HTTP behavior', () => {
    expect(files.head).toEqual({ status: 200, body: '', length: '14' });
    expect(files['/missing.txt'].status).toBe(404);
});

test('installed request listener preserves JSON, lengths, headers, streams and error recovery', () => {
    const result = installedProbe(String.raw`
        import { createServer, request } from 'node:http';
        import { once } from 'node:events';
        import { getRequestListener } from '@hono/node-server';
        const listener = getRequestListener(async request => {
            const path = new URL(request.url).pathname;
            if (path === '/echo') return Response.json(await request.json(), { headers: { 'x-fixture': 'echo' } });
            if (path === '/empty') return new Response(null, { status: 204, headers: { 'x-fixture': 'empty' } });
            if (path === '/stream') return new Response(new ReadableStream({ start(c) {
                c.enqueue(new TextEncoder().encode('café ')); c.enqueue(new TextEncoder().encode('世界')); c.close();
            } }), { headers: { 'content-type': 'text/plain; charset=utf-8' } });
            if (path === '/error') throw new Error('synthetic listener failure');
            return new Response('ready', { headers: { 'content-length': '5' } });
        }, { overrideGlobalObjects: false, errorHandler: () => new Response('controlled error', { status: 500 }) });
        const server = createServer(listener);
        try {
            server.listen(0, '127.0.0.1'); await once(server, 'listening');
            const port = server.address().port;
            async function send(path, method = 'GET', body) {
                return await new Promise((resolve, reject) => {
                    const req = request({ host: '127.0.0.1', port, path, method,
                        headers: body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {} }, res => {
                        const chunks = []; res.on('data', c => chunks.push(c));
                        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
                        res.on('error', reject);
                    }); req.on('error', reject); req.end(body);
                });
            }
            const result = { echo: await send('/echo', 'POST', JSON.stringify({ text: 'café 世界' })),
                empty: await send('/empty'), stream: await send('/stream'), error: await send('/error'),
                recovery: await send('/'), head: await send('/', 'HEAD') };
            process.stdout.write(JSON.stringify(result));
        } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    `);
    expect(JSON.parse(result.echo.body)).toEqual({ text: 'café 世界' });
    expect(result.echo.status).toBe(200);
    expect(result.echo.headers['x-fixture']).toBe('echo');
    expect(Number(result.echo.headers['content-length'])).toBe(Buffer.byteLength(result.echo.body));
    expect(result.empty).toMatchObject({ status: 204, body: '', headers: { 'x-fixture': 'empty' } });
    expect(result.empty.headers['content-length']).toBeUndefined();
    expect(result.stream).toMatchObject({ status: 200, body: 'café 世界' });
    expect(result.error).toMatchObject({ status: 500, body: 'controlled error' });
    expect(result.recovery).toMatchObject({ status: 200, body: 'ready', headers: { 'content-length': '5' } });
    expect(result.head).toMatchObject({ status: 200, body: '', headers: { 'content-length': '5' } });
});

// Standard CI omits optional dependencies. Skip only this SDK integration when
// its installed directory is absent; present but broken SDK imports still fail.
const hasMcpSdk = require('node:fs').existsSync(require('node:path').resolve(
    __dirname, '../node_modules/@modelcontextprotocol/sdk'));
(hasMcpSdk ? test : test.skip)('Promptfoo-style Express/MCP bridge accepts a parsed initialize request (optional SDK)', () => {
    const result = installedProbe(String.raw`
        import express from 'express';
        import { once } from 'node:events';
        import { getRequestListener } from '@hono/node-server';
        import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
        import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
        const mcp = new McpServer({ name: 'offline-fixture', version: '1.0.0' });
        const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => 'offline-session' });
        await mcp.connect(transport);
        const app = express(); app.use(express.json());
        const listener = getRequestListener((request, { incoming }) =>
            transport.handleRequest(request, { parsedBody: incoming.body }), { overrideGlobalObjects: false });
        app.post('/mcp', (req, res) => listener(req, res));
        const server = app.listen(0, '127.0.0.1');
        try {
            await once(server, 'listening');
            const response = await fetch('http://127.0.0.1:' + server.address().port + '/mcp', {
                method: 'POST', signal: AbortSignal.timeout(5000),
                headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
                    protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'offline-client', version: '1' }
                } })
            });
            const text = await response.text();
            const data = text.split('\n').find(line => line.startsWith('data: '));
            process.stdout.write(JSON.stringify({ status: response.status,
                session: response.headers.get('mcp-session-id'), message: JSON.parse(data.slice(6)) }));
        } finally {
            await mcp.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
        }
    `);
    expect(result).toMatchObject({ status: 200, session: 'offline-session', message: {
        jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26', serverInfo: { name: 'offline-fixture' } }
    } });
    expect(result.message.error).toBeUndefined();
});
