'use strict';

// D-013: content-versioned dashboard assets are sent with a one-year immutable Cache-Control, but the API
// middleware's default `Pragma: no-cache` stayed on the response, so browsers revalidated them on every
// page view (measured in production on 18 Nov 2026: a 1.2–1.5 s conditional request per asset per visit).
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const { API_SECURITY_HEADERS, clearDefaultPragmaForImmutable } = require('../api/shared/securityHeaders');

const IMMUTABLE = 'private, max-age=31536000, immutable';
function fake() {
    const removed = [];
    return { removed, removeHeader: name => removed.push(name) };
}

test('an immutable result with no Pragma of its own drops the default Pragma', () => {
    const res = fake();
    expect(clearDefaultPragmaForImmutable(res, { 'Cache-Control': IMMUTABLE, 'Content-Type': 'text/javascript' })).toBe(true);
    expect(res.removed).toEqual(['Pragma']);
    const lower = fake();
    expect(clearDefaultPragmaForImmutable(lower, { 'cache-control': 'PRIVATE, MAX-AGE=60, IMMUTABLE' })).toBe(true);
});

test.each([
    ['the API default', { ...API_SECURITY_HEADERS }],
    ['no-store', { 'Cache-Control': 'private, no-store, max-age=0' }],
    ['no headers', undefined],
    ['no Cache-Control', { 'Content-Type': 'application/json' }],
    ['a long max-age without immutable', { 'Cache-Control': 'private, max-age=31536000' }],
    ['immutable together with no-store', { 'Cache-Control': 'no-store, immutable' }],
    ['immutable together with no-cache', { 'Cache-Control': 'no-cache, immutable' }],
    ['a handler that sets Pragma itself', { 'Cache-Control': IMMUTABLE, Pragma: 'no-cache' }],
    ['a handler that sets pragma in lower case', { 'Cache-Control': IMMUTABLE, pragma: 'no-cache' }],
    ['a value that only contains the word', { 'Cache-Control': 'private, max-age=0, x-immutable-ish' }]
])('%s keeps the default Pragma', (_name, headers) => {
    const res = fake();
    expect(clearDefaultPragmaForImmutable(res, headers)).toBe(false);
    expect(res.removed).toEqual([]);
});

test('the server applies it to every handler result, after the result headers', () => {
    const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
    const body = source.slice(source.indexOf('function sendResult(res, result) {'), source.indexOf('async function sendFunctionResponse'));
    expect(body.indexOf('res.setHeader(name, value)')).toBeGreaterThan(-1);
    expect(body.indexOf('clearDefaultPragmaForImmutable(res, result.headers);')).toBeGreaterThan(body.indexOf('res.setHeader(name, value)'));
    expect(body.indexOf('clearDefaultPragmaForImmutable(res, result.headers);')).toBeLessThan(body.indexOf('res.status('));
});

describe('on the wire, behind the API default headers', () => {
    let server, base;
    beforeAll(done => {
        const app = express();
        app.use((_req, res, next) => { Object.entries(API_SECURITY_HEADERS).forEach(([name, value]) => res.setHeader(name, value)); next(); });
        const send = headers => (_req, res) => {
            Object.entries(headers).forEach(([name, value]) => res.setHeader(name, value));
            clearDefaultPragmaForImmutable(res, headers);
            res.status(200).send('ok');
        };
        app.get('/asset', send({ 'Cache-Control': IMMUTABLE }));
        app.get('/json', send({ 'Content-Type': 'application/json' }));
        server = http.createServer(app);
        server.listen(0, '127.0.0.1', () => { base = 'http://127.0.0.1:' + server.address().port; done(); });
    });
    afterAll(done => { server.close(() => done()); });
    const head = route => new Promise((resolve, reject) => http.get(base + route, res => { res.resume(); res.on('end', () => resolve(res.headers)); }).on('error', reject));

    test('a versioned asset is cacheable without revalidation', async () => {
        const headers = await head('/asset');
        expect(headers['cache-control']).toBe(IMMUTABLE);
        expect(headers.pragma).toBeUndefined();
        expect(headers['x-content-type-options']).toBe('nosniff');
        expect(headers['cross-origin-resource-policy']).toBe('same-origin');
    });
    test('every other API response keeps no-store and Pragma: no-cache', async () => {
        const headers = await head('/json');
        expect(headers['cache-control']).toBe('private, no-store, max-age=0');
        expect(headers.pragma).toBe('no-cache');
    });
});
