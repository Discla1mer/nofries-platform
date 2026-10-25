'use strict';

const crypto = require('crypto');
const runtime = require('../api/shared/mcpRuntime');
const { API_SECURITY_HEADERS } = require('../api/shared/securityHeaders');

const REQUESTED = 'a'.repeat(40);
const RESOLVED = 'b'.repeat(40);
const TENANT = 'c'.repeat(32);
const NONCE = 'd'.repeat(32);
const PRIVATE = 'SYNTHETIC_PRIVATE_MISMATCH_SENTINEL';
const HEADER = 'X-NoFries-Canary-Evidence';
const BASE_KEYS = ['v', 'nonce', 'loadedFunctionsSha256', 'queryClass', 'normalizedRequestSha256', 'beforeMeta'];
let requestNumber = 0;

function access(overrides = {}) {
    return Object.assign({ allowed: true, tenant: { key: TENANT },
        user: { role: 'mcp_reader', capabilities: ['lifecycle:read'] },
        authentication: { provider: 'mcp-oauth-application' } }, overrides);
}

function request(options = {}) {
    const headers = { 'x-client-ip': `mismatch-identity-${++requestNumber}` };
    if (options.capture !== false) headers['X-NoFries-Canary-Probe'] = options.nonce || NONCE;
    const body = { jsonrpc: '2.0', id: 'authenticated_canary', method: 'tools/call',
        params: { name: 'search', arguments: { query: options.query ?? `__release_canary__${options.sha || REQUESTED}` } } };
    return { method: 'POST', headers, body: options.form === 'string' ? JSON.stringify(body)
        : options.form === 'Buffer' ? Buffer.from(JSON.stringify(body)) : body };
}

function dependencies(overrides = {}) {
    return Object.assign({ env: {}, resolveAccess: jest.fn(async () => access()),
        lifecycle: { searchAgentContext: jest.fn(async () => [{ id: PRIVATE }]),
            fetchAgentContext: jest.fn(async () => ({ id: PRIVATE })) },
        getReleaseIdentity: jest.fn(() => ({ releaseSha: RESOLVED, runId: PRIVATE, private: PRIVATE })),
        fetchImpl: jest.fn(() => { throw new Error(PRIVATE); }) }, overrides);
}

async function invoke(req = request(), deps = dependencies(), logger = jest.fn()) {
    const context = { invocationId: 'synthetic-mismatch-incident', log: { error: logger } };
    await runtime.runMcpFunction(context, req, deps);
    const encoded = context.res.headers[HEADER];
    const decoded = encoded === undefined ? undefined : Buffer.from(encoded, 'base64url').toString('ascii');
    return { context, deps, encoded, decoded, evidence: decoded === undefined ? undefined : JSON.parse(decoded) };
}

function digest(nonce, requestedSha) {
    return crypto.createHash('sha256').update(JSON.stringify([
        'nofries-mcp-canary-request/v1', nonce, '2.0', 'authenticated_canary',
        'tools/call', 'search', `__release_canary__${requestedSha}`
    ]), 'utf8').digest('hex');
}

function expectBoundedProof(result, pair) {
    const { encoded, decoded, evidence } = result;
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(decoded, 'ascii').toString('base64url')).toBe(encoded);
    expect(JSON.stringify(evidence)).toBe(decoded);
    expect(decoded).toMatch(/^[\x20-\x7e]+$/);
    expect(Buffer.byteLength(decoded, 'ascii')).toBeLessThanOrEqual(1152);
    expect(Buffer.byteLength(encoded, 'ascii')).toBeLessThanOrEqual(1536);
    expect(decoded).not.toContain(PRIVATE);
    expect(Object.keys(evidence)).toEqual(pair ? [...BASE_KEYS, 'releaseMismatch'] : BASE_KEYS);
    if (pair) {
        expect(Object.keys(evidence.releaseMismatch)).toEqual(['requestedSha', 'resolvedSha']);
        expect(evidence.releaseMismatch).toEqual(pair);
        expect(pair.requestedSha).toMatch(/^[0-9a-f]{40}$/);
        expect(pair.resolvedSha).toMatch(/^[0-9a-f]{40}$/);
        expect(pair.requestedSha).not.toBe(pair.resolvedSha);
    } else {
        expect(evidence).not.toHaveProperty('releaseMismatch');
    }
}

function expectMismatchResponse(result) {
    expect(result.context.res.status).toBe(200);
    expect(result.context.res.body).toMatchObject({ jsonrpc: '2.0', id: 'authenticated_canary', result: {
        isError: true, _meta: { 'nofries/diagnostic': { stage: 'response', code: 'canary_release_sha_mismatch' } }
    } });
    expect(result.context.res.body).not.toHaveProperty('error');
    expect(Object.keys(result.context.res.body.result)).toEqual(['content', 'isError', '_meta']);
    expect(result.context.res.body.result._meta).not.toHaveProperty('mcp/www_authenticate');
    expect(result.context.res.body.result._meta).not.toHaveProperty('nofries/release-canary');
    expect(JSON.stringify(result.context.res.body)).not.toContain(PRIVATE);
    expect(JSON.stringify(result.context.res.body)).not.toContain(REQUESTED);
    expect(JSON.stringify(result.context.res.body)).not.toContain(RESOLVED);
    expect(result.context.res.headers).toMatchObject(API_SECURITY_HEADERS);
}

describe('failure-only connector release mismatch identity', () => {
    test.each(['object', 'string', 'Buffer'])('binds the actual normalized %s request and one resolved identity', async form => {
        const result = await invoke(request({ form, query: ` \n__release_canary__${REQUESTED}\t ` }));
        expectMismatchResponse(result);
        expectBoundedProof(result, { requestedSha: REQUESTED, resolvedSha: RESOLVED });
        expect(result.evidence).toMatchObject({ v: 1, nonce: NONCE,
            loadedFunctionsSha256: runtime.canaryFunctionsSha256(), queryClass: 'release_canary',
            normalizedRequestSha256: digest(NONCE, REQUESTED),
            beforeMeta: { atExpectedLocation: false, valid: false } });
        expect(result.deps.getReleaseIdentity).toHaveBeenCalledTimes(1);
        expect(result.deps.lifecycle.searchAgentContext).toHaveBeenCalledTimes(1);
        expect(result.deps.lifecycle.searchAgentContext).toHaveBeenCalledWith(access(), `__release_canary__${REQUESTED}`);
        expect(result.deps.fetchImpl).not.toHaveBeenCalled();
        expect(JSON.stringify(result.context.log.error.mock.calls)).not.toContain(REQUESTED);
        expect(JSON.stringify(result.context.log.error.mock.calls)).not.toContain(RESOLVED);
    });

    test('capture off preserves the closed failure response without a proof or additional resolver call', async () => {
        const captured = await invoke();
        const disabled = await invoke(request({ capture: false }));
        expect(disabled.context.res.body).toEqual(captured.context.res.body);
        expect(disabled.context.res.status).toBe(captured.context.res.status);
        expect(disabled.encoded).toBeUndefined();
        expect(disabled.deps.getReleaseIdentity).toHaveBeenCalledTimes(1);
        expect(disabled.deps.lifecycle.searchAgentContext).toHaveBeenCalledTimes(1);
        expect(disabled.deps.fetchImpl).not.toHaveBeenCalled();
    });

    test('successful release proof keeps exactly the existing six fields and no resolved identity', async () => {
        const deps = dependencies({ getReleaseIdentity: jest.fn(() => ({ releaseSha: REQUESTED, runId: PRIVATE })) });
        const result = await invoke(request(), deps);
        expectBoundedProof(result);
        expect(result.decoded).not.toContain(REQUESTED);
        expect(result.evidence.beforeMeta).toEqual({ atExpectedLocation: true, valid: true });
        expect(result.context.res.body.result._meta['nofries/release-canary'])
            .toEqual({ releaseSha: REQUESTED, tenantKey: TENANT });
        expect(result.context.res.body.result).not.toHaveProperty('isError');
        expect(deps.getReleaseIdentity).toHaveBeenCalledTimes(1);
        expect(result.context.log.error).not.toHaveBeenCalled();
    });

    test.each([
        ['null', () => null], ['undefined', () => undefined], ['missing SHA', () => ({ private: PRIVATE })],
        ['nonstring SHA', () => ({ releaseSha: 123 })], ['malformed SHA', () => ({ releaseSha: PRIVATE })],
        ['uppercase SHA', () => ({ releaseSha: RESOLVED.toUpperCase() })],
        ['padded SHA', () => ({ releaseSha: ` ${RESOLVED}` })],
        ['oversized identity value', () => ({ releaseSha: PRIVATE.repeat(10000) })],
        ['throwing resolver', () => { throw new Error(PRIVATE); }],
        ['throwing SHA getter', () => Object.defineProperty({}, 'releaseSha', { get() { throw new Error(PRIVATE); } })]
    ])('withholds identifiers for %s identity', async (_label, identity) => {
        const deps = dependencies({ getReleaseIdentity: jest.fn(identity) });
        const result = await invoke(request(), deps);
        expectBoundedProof(result);
        expect(result.context.res.body.result._meta['nofries/diagnostic'])
            .toMatchObject({ stage: 'response', code: 'canary_release_identity_invalid' });
        expect(result.decoded).not.toContain(REQUESTED);
        expect(result.decoded).not.toContain(RESOLVED);
        expect(JSON.stringify(result.context.res.body)).not.toContain(PRIVATE);
        expect(deps.getReleaseIdentity).toHaveBeenCalledTimes(1);
    });

    test.each([
        ['empty stamp', '__release_canary__'], ['malformed stamp', `__release_canary__${PRIVATE}`],
        ['uppercase stamp', `__release_canary__${REQUESTED.toUpperCase()}`],
        ['oversized stamp', '__release_canary__' + 'e'.repeat(501)], ['ordinary query', PRIVATE]
    ])('withholds identifiers for %s', async (_label, query) => {
        const result = await invoke(request({ query }));
        expectBoundedProof(result);
        expect(result.decoded).not.toContain(PRIVATE);
        expect(result.decoded).not.toContain(RESOLVED);
        expect(result.deps.getReleaseIdentity).not.toHaveBeenCalled();
    });

    test('a different guard failure does not disclose the resolved matching identity', async () => {
        const deps = dependencies({ getReleaseIdentity: jest.fn(() => ({ releaseSha: REQUESTED })),
            resolveAccess: jest.fn(async () => access({ tenant: { key: PRIVATE } })) });
        const result = await invoke(request(), deps);
        expectBoundedProof(result);
        expect(result.context.res.body.result._meta['nofries/diagnostic'].code).toBe('canary_tenant_binding_invalid');
        expect(result.decoded).not.toContain(REQUESTED);
        expect(result.decoded).not.toContain(PRIVATE);
    });

    test.each(['authentication', 'unapproved', 'capability', 'delegated', 'role', 'ordinary-id',
        'override', 'same-handler-override', 'inherited-override'])('does not expose a pair through %s path', async kind => {
        const req = request();
        const deps = dependencies();
        if (kind === 'authentication') deps.resolveAccess = jest.fn(async () => {
            throw Object.assign(new Error(PRIVATE), { statusCode: 401 });
        });
        if (kind === 'unapproved') deps.resolveAccess = jest.fn(async () => access({ allowed: false }));
        if (kind === 'capability') deps.resolveAccess = jest.fn(async () => access({
            user: { role: 'mcp_reader', capabilities: [] } }));
        if (kind === 'delegated') deps.resolveAccess = jest.fn(async () => access({
            authentication: { provider: 'mcp-oauth' } }));
        if (kind === 'role') deps.resolveAccess = jest.fn(async () => access({
            user: { role: 'service_owner', capabilities: ['lifecycle:read'] } }));
        if (kind === 'ordinary-id') req.body.id = 'ordinary-search';
        if (kind === 'override') deps.handleRequest = jest.fn(async () => ({ status: 200, headers: {}, body: {} }));
        if (kind === 'same-handler-override') deps.handleRequest = runtime.handleMcpRequest;
        if (kind === 'inherited-override') Object.setPrototypeOf(deps, {
            handleRequest: (value, handlerDependencies) => runtime.handleMcpRequest(value, handlerDependencies)
        });
        const result = await invoke(req, deps);
        expect(result.encoded).toBeUndefined();
    });

    test.each(['', 'bad', 'D'.repeat(32), 'e'.repeat(31), 'e'.repeat(33), ['e'.repeat(32)]])(
        'ignores an invalid capture marker %p without changing the mismatch', async nonce => {
            const req = request(); req.headers['X-NoFries-Canary-Probe'] = nonce;
            const result = await invoke(req);
            expectMismatchResponse(result);
            expect(result.encoded).toBeUndefined();
            expect(result.deps.getReleaseIdentity).toHaveBeenCalledTimes(1);
        });

    test('logger failure cannot replace the same mismatch pair or failure response', async () => {
        const result = await invoke(request(), dependencies(), jest.fn(() => { throw new Error(PRIVATE); }));
        expectMismatchResponse(result);
        expectBoundedProof(result, { requestedSha: REQUESTED, resolvedSha: RESOLVED });
    });

    test('uses the comparison values even if the resolved object changes before header emission', async () => {
        const identity = { releaseSha: RESOLVED, private: PRIVATE };
        const deps = dependencies({ getReleaseIdentity: jest.fn(() => identity) });
        const logger = jest.fn(() => { identity.releaseSha = 'e'.repeat(40); });
        const result = await invoke(request(), deps, logger);
        expectBoundedProof(result, { requestedSha: REQUESTED, resolvedSha: RESOLVED });
        expect(identity.releaseSha).toBe('e'.repeat(40));
        expect(deps.getReleaseIdentity).toHaveBeenCalledTimes(1);
    });

    test('uses the normalized request captured before the asynchronous lifecycle read', async () => {
        let releaseRead;
        const deps = dependencies({ lifecycle: {
            searchAgentContext: jest.fn(() => new Promise(resolve => { releaseRead = resolve; })) } });
        const req = request();
        const pending = invoke(req, deps);
        await new Promise(resolve => setImmediate(resolve));
        req.body.params.arguments.query = `__release_canary__${'e'.repeat(40)}`;
        releaseRead([]);
        const result = await pending;
        expectBoundedProof(result, { requestedSha: REQUESTED, resolvedSha: RESOLVED });
        expect(result.evidence.normalizedRequestSha256).toBe(digest(NONCE, REQUESTED));
        expect(deps.getReleaseIdentity).toHaveBeenCalledTimes(1);
    });

    test('concurrent reverse completion isolates both compared identities, nonce and request digest', async () => {
        const pending = [];
        const firstDeps = dependencies({ lifecycle: { searchAgentContext: jest.fn(() => new Promise(resolve => pending.push(resolve))) } });
        const secondRequested = 'e'.repeat(40), secondResolved = 'f'.repeat(40), secondNonce = '1'.repeat(32);
        const secondDeps = dependencies({ getReleaseIdentity: jest.fn(() => ({ releaseSha: secondResolved })),
            lifecycle: { searchAgentContext: jest.fn(() => new Promise(resolve => pending.push(resolve))) } });
        const first = invoke(request(), firstDeps);
        const second = invoke(request({ sha: secondRequested, nonce: secondNonce }), secondDeps);
        await new Promise(resolve => setImmediate(resolve));
        expect(pending).toHaveLength(2);
        pending[1]([]);
        const secondResult = await second;
        pending[0]([]);
        const firstResult = await first;
        expectBoundedProof(firstResult, { requestedSha: REQUESTED, resolvedSha: RESOLVED });
        expect(firstResult.evidence.nonce).toBe(NONCE);
        expect(firstResult.evidence.normalizedRequestSha256).toBe(digest(NONCE, REQUESTED));
        expectBoundedProof(secondResult, { requestedSha: secondRequested, resolvedSha: secondResolved });
        expect(secondResult.evidence.nonce).toBe(secondNonce);
        expect(secondResult.evidence.normalizedRequestSha256).toBe(digest(secondNonce, secondRequested));
        expect(firstDeps.getReleaseIdentity).toHaveBeenCalledTimes(1);
        expect(secondDeps.getReleaseIdentity).toHaveBeenCalledTimes(1);
    });

    test('interrupted search and the next success cannot inherit a previous mismatch pair', async () => {
        const mismatched = await invoke();
        expectBoundedProof(mismatched, { requestedSha: REQUESTED, resolvedSha: RESOLVED });
        const interruptedDeps = dependencies({ lifecycle: { searchAgentContext: jest.fn(async () => { throw new Error(PRIVATE); }) } });
        const interrupted = await invoke(request(), interruptedDeps);
        expectBoundedProof(interrupted);
        expect(interrupted.context.res.body.result._meta['nofries/diagnostic'].code).toBe('lifecycle_read_failed');
        expect(interruptedDeps.getReleaseIdentity).not.toHaveBeenCalled();
        const successful = await invoke(request(), dependencies({ getReleaseIdentity: jest.fn(() => ({ releaseSha: REQUESTED })) }));
        expectBoundedProof(successful);
        expect(successful.evidence.beforeMeta).toEqual({ atExpectedLocation: true, valid: true });
    });
});
