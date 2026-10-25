'use strict';
// All bytes are synthetic. Never delegates to a socket, environment or service.
const { EventEmitter } = require('node:events');
const { RESOURCE, SCOPE } = require('../../api/shared/customerSignup/appServiceCredential');
const { id, FAKE_TOKEN, IDENTITY_ENDPOINT, IDENTITY_HEADER } = require('./offlineCustomerSigner');
const validBody = () => ({ access_token: FAKE_TOKEN, expires_on: String(Math.floor(Date.now() / 1000) + 3600),
    resource: RESOURCE, token_type: 'Bearer', client_id: id(7) });
const options = () => ({ enabled: true, env: { IDENTITY_ENDPOINT, IDENTITY_HEADER },
    identity: { kind: 'system-assigned', clientId: id(7) }, tenantId: id(1) });
const settle = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };

function transport(config = {}) {
    const calls = [];
    const request = jest.fn((url, settings) => {
        if (config.throw) throw Object.assign(new Error('OFFLINE_TRANSPORT_PRIVATE'), { cause: 'OFFLINE_CAUSE_PRIVATE' });
        const req = new EventEmitter(), res = new EventEmitter();
        let closed = false;
        const close = () => { if (!closed) { closed = true; req.emit('close'); } };
        req.destroy = jest.fn(() => { if (!config.ignoreDestroy) queueMicrotask(close); return req; });
        res.destroy = jest.fn(() => { if (!config.ignoreDestroy) queueMicrotask(() => res.emit('close')); return res; });
        const bytes = () => config.bytes || Buffer.from(config.raw ?? JSON.stringify(config.body || validBody()));
        res.statusCode = config.status ?? 200;
        res.headers = { 'content-type': 'application/json', ...config.headers };
        const headers = () => req.emit('response', res);
        const complete = () => {
            const raw = bytes();
            for (let i = 0; i < raw.length; i += config.chunkSize || raw.length) res.emit('data', raw.subarray(i, i + (config.chunkSize || raw.length)));
            res.emit('end'); res.emit('close'); close();
        };
        req.end = jest.fn(() => queueMicrotask(() => {
            if (config.phase === 'headers') return;
            headers();
            if (config.phase === 'body') return;
            complete();
        }));
        const call = { url, settings, req, res, headers, complete, close };
        calls.push(call);
        return req;
    });
    return { request, calls, config };
}

module.exports = { validBody, options, transport, settle, SCOPE };
