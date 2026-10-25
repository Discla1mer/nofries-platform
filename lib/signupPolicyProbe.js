'use strict';

// Operator-only packaged entry point. Never register this as an HTTP handler.
const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { createEntraCustomerGraph } = require('../api/shared/customerSignup/entraCustomerGraph');
const { CUSTOMER_MFA_POLICY } = require('../api/shared/customerSignup/customerMfaPolicy');

const TARGET = Object.freeze({ app: 'app-nofries-prod-nzn-001',
    tenant: '947787df-88fd-4417-b6b2-99c13d8410ba', identity: '861be6ad-c596-4250-ab27-687b1c8914dd' });
const SCOPE = 'https://graph.microsoft.com/.default';
const MAX_AGE_MS = 30000, DEADLINE_MS = 10000, MAX_BYTES = 2048;
const MANIFEST = path.resolve(__dirname, '../api/shared/releaseManifest.json');
const KEYS = ['schemaVersion', 'app', 'tenant', 'identity', 'releaseSha', 'releaseRunId',
    'policyId', 'context', 'nonce', 'issuedAt'];
const ERROR = 'signup_policy_probe_unverified';
function fail() { const error = new Error('Signup policy verification did not complete.'); error.code = ERROR; throw error; }
function exact(value, keys) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) &&
        isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());
}
function validateRequest(request, now) {
    if (!exact(request, KEYS) || request.schemaVersion !== 1 ||
        Object.entries(TARGET).some(([key, value]) => request[key] !== value) ||
        typeof request.releaseSha !== 'string' || !/^[a-f0-9]{40}$/.test(request.releaseSha) ||
        typeof request.releaseRunId !== 'string' || !/^[1-9][0-9]{0,19}$/.test(request.releaseRunId) ||
        request.policyId !== CUSTOMER_MFA_POLICY.id || request.context !== CUSTOMER_MFA_POLICY.context ||
        typeof request.nonce !== 'string' || !/^[a-f0-9]{64}$/.test(request.nonce) ||
        !Number.isSafeInteger(now) || !Number.isSafeInteger(request.issuedAt) ||
        request.issuedAt <= 0 || now < request.issuedAt || now - request.issuedAt >= MAX_AGE_MS) fail();
    return Object.freeze({ ...request });
}
function parse(args, now) {
    try {
        if (!Array.isArray(args) || args.length !== 2 || args[0] !== '--request' ||
            typeof args[1] !== 'string' || args[1].length > MAX_BYTES || !/^[A-Za-z0-9_-]+$/.test(args[1])) fail();
        const bytes = Buffer.from(args[1], 'base64url');
        if (bytes.toString('base64url') !== args[1]) fail();
        const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        // A canonical representation also rejects duplicate JSON keys.
        if (Buffer.from(JSON.stringify(value)).toString('base64url') !== args[1]) fail();
        return validateRequest(value, now);
    } catch { fail(); }
}
function readManifest() {
    let fd;
    try {
        fd = fs.openSync(MANIFEST, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size > 16384) fail();
        const bytes = fs.readFileSync(fd);
        if (bytes.length > 16384) fail();
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch { fail(); }
    finally { if (fd !== undefined) fs.closeSync(fd); }
}
function validateContext(env, manifest, request) {
    if (!env || env.WEBSITE_SITE_NAME !== request.app ||
        ![undefined, 'Production'].includes(env.WEBSITE_SLOT_NAME) ||
        env.NOFRIES_ENTRA_TENANT_ID !== request.tenant ||
        env.NOFRIES_CUSTOMER_MFA_POLICY_ID !== request.policyId ||
        env.NOFRIES_CUSTOMER_MFA_CONTEXT !== request.context ||
        typeof env.IDENTITY_HEADER !== 'string' || !env.IDENTITY_HEADER || /[\r\n]/.test(env.IDENTITY_HEADER) ||
        Object.entries(env).some(([key, value]) => value &&
            /^(NOFRIES_MANAGED_IDENTITY_CLIENT_ID|IDENTITY_SERVER_THUMBPRINT|AZURE_CLIENT_ID|AZURE_CLIENT_SECRET|AZURE_CLIENT_CERTIFICATE_PATH|AZURE_CLIENT_CERTIFICATE_PASSWORD|AZURE_FEDERATED_TOKEN_FILE|AZURE_USERNAME|AZURE_PASSWORD|AZURE_LOG_LEVEL|NODE_DEBUG|NODE_OPTIONS|DEBUG)$/.test(key))) fail();
    try {
        const endpoint = new URL(env.IDENTITY_ENDPOINT);
        if (endpoint.protocol !== 'http:' || endpoint.username || endpoint.password || endpoint.hash ||
            !(endpoint.hostname === '127.0.0.1' || /^169\.254\.\d{1,3}\.\d{1,3}$/.test(endpoint.hostname))) fail();
    } catch { fail(); }
    if (!manifest || ![3, 4].includes(Object.keys(manifest).length) ||
        Object.keys(manifest).some(key => !['schemaVersion', 'releaseSha', 'runId', 'runAttempt'].includes(key)) ||
        manifest.schemaVersion !== 2 || manifest.releaseSha !== request.releaseSha ||
        manifest.runId !== request.releaseRunId ||
        manifest.runAttempt !== undefined && manifest.runAttempt !== '1') fail();
}
function validateToken(token, now) {
    try {
        if (!token || typeof token.token !== 'string' || token.token.length > 16384 ||
            !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token.token) ||
            !Number.isFinite(token.expiresOnTimestamp) || token.expiresOnTimestamp <= now + DEADLINE_MS) fail();
        const claims = JSON.parse(Buffer.from(token.token.split('.')[1], 'base64url').toString('utf8'));
        if (claims.oid !== TARGET.identity || claims.tid !== TARGET.tenant ||
            !['https://graph.microsoft.com', 'https://graph.microsoft.com/', '00000003-0000-0000-c000-000000000000'].includes(claims.aud) ||
            !Array.isArray(claims.roles) || !claims.roles.includes('Policy.Read.All') || claims.scp !== undefined ||
            !Number.isFinite(claims.exp) || claims.exp * 1000 <= now + DEADLINE_MS ||
            claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf * 1000 > now)) fail();
        // Binding checks only: the fixed TLS Graph endpoint authenticates the JWT.
        // Never return claims or authentication material as diagnostic evidence.
    } catch { fail(); }
}
async function run(args, dependencies = {}) {
    const now = dependencies.now || Date.now;
    let timer;
    const controller = new AbortController();
    try {
        const request = parse(args, now());
        const env = dependencies.env || process.env, manifest = dependencies.readManifest || readManifest;
        validateContext(env, manifest(), request);
        const assertCurrent = () => { if (controller.signal.aborted) fail(); validateRequest(request, now()); };
        const work = async () => {
            const ManagedIdentityCredential = dependencies.ManagedIdentityCredential || require('@azure/identity').ManagedIdentityCredential;
            const identity = new ManagedIdentityCredential();
            const credential = { async getToken(scope) {
                assertCurrent();
                if (scope !== SCOPE) fail();
                const token = await identity.getToken(scope, { abortSignal: controller.signal });
                assertCurrent(); validateToken(token, now());
                return token;
            } };
            const fetch = dependencies.fetch || globalThis.fetch;
            const graph = createEntraCustomerGraph({ credential, policyId: request.policyId,
                fetch: (url, options) => {
                    assertCurrent();
                    return fetch(url, { ...options, signal: AbortSignal.any([options.signal, controller.signal]) });
                } });
            if (await graph.verifyMfaPolicy(request.context) !== true) fail();
            assertCurrent(); validateContext(env, manifest(), request);
            return Object.freeze({ ...request, observedAt: now(), verified: true });
        };
        return await Promise.race([work(), new Promise((_, reject) => {
            timer = setTimeout(() => { controller.abort(); const error = new Error(); reject(error); }, DEADLINE_MS);
        })]);
    } catch { fail(); }
    finally { clearTimeout(timer); controller.abort(); }
}
if (require.main === module) {
    // A remote session may disappear or an SDK may ignore cancellation. Bound
    // the actual process as well as the asynchronous result, with safe output.
    const watchdog = setTimeout(() => { process.stderr.write(JSON.stringify({ code: ERROR }) + '\n'); process.exit(1); }, DEADLINE_MS + 1000);
    run(process.argv.slice(2)).then(result => {
        process.stdout.write(JSON.stringify(result) + '\n', () => process.exit(0));
    }).catch(() => {
        process.stderr.write(JSON.stringify({ code: ERROR }) + '\n', () => process.exit(1));
    });
    watchdog.unref();
}
module.exports = { TARGET, SCOPE, MAX_AGE_MS, DEADLINE_MS, MAX_BYTES, ERROR, parse, validateRequest, validateContext, validateToken, run };
