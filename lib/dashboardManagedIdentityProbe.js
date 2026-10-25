'use strict';

// Operator-only entry point. Never import this module into an HTTP handler.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createPostgresPool } = require('../api/shared/database/postgres');

const TARGET = Object.freeze({ app: 'app-nofries-prod-nzn-001',
    host: 'psql-nofries-prod-nzn-001.postgres.database.azure.com',
    login: 'nofries_dashboard_app', identity: '861be6ad-c596-4250-ab27-687b1c8914dd',
    tenant: '947787df-88fd-4417-b6b2-99c13d8410ba' });
const DATABASES = Object.freeze(['nofries', 'postgres', 'template1', 'azure_sys', 'azure_maintenance']);
const AUDIENCE = 'https://ossrdbms-aad.database.windows.net';
const TOKEN_SCOPE = AUDIENCE + '/.default';
const MANIFEST = path.resolve(__dirname, '../api/shared/releaseManifest.json');
const IDENTITY_SQL = `SELECT current_database() AS database,current_user AS actor,session_user AS session,
    r.rolcanlogin,r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolbypassrls
    FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`;
const ROLE_KEYS = Object.freeze(['rolsuper', 'rolcreatedb', 'rolcreaterole', 'rolreplication', 'rolbypassrls']);
const ERROR_CODES = new Set(['request_invalid', 'context_invalid', 'manifest_invalid', 'token_binding_invalid',
    'identity_invalid', 'deadline', 'failed']);
class ProbeError extends Error {
    constructor(code) { super('Managed identity diagnostic did not complete.'); this.code = 'mi_probe_' + code; }
}
const fail = code => { throw new ProbeError(code); };
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function parse(args) {
    if (!Array.isArray(args) || args.length !== 2 || args[0] !== '--sha' ||
        typeof args[1] !== 'string' || !/^[a-f0-9]{40}$/.test(args[1])) fail('request_invalid');
    return args[1];
}
function validateContext(env, manifest, sha) {
    if (!env || env.WEBSITE_SITE_NAME !== TARGET.app ||
        ![undefined, 'Production'].includes(env.WEBSITE_SLOT_NAME) ||
        ![undefined, '', 'false'].includes(env.NOFRIES_DASHBOARD_RUNTIME_ENABLED) ||
        typeof env.IDENTITY_ENDPOINT !== 'string' || !env.IDENTITY_ENDPOINT ||
        typeof env.IDENTITY_HEADER !== 'string' || !env.IDENTITY_HEADER ||
        Object.entries(env).some(([key, value]) => value && (/^PG/.test(key) ||
            /^(DATABASE_URL|NOFRIES_DATABASE_URL|NOFRIES_MANAGED_IDENTITY_CLIENT_ID|AZURE_CLIENT_SECRET|AZURE_CLIENT_CERTIFICATE_PATH|AZURE_CLIENT_CERTIFICATE_PASSWORD|AZURE_FEDERATED_TOKEN_FILE|AZURE_USERNAME|AZURE_PASSWORD|AZURE_LOG_LEVEL|NODE_DEBUG|DEBUG)$/.test(key))) ||
        [['NOFRIES_POSTGRES_HOST', TARGET.host], ['NOFRIES_POSTGRES_DATABASE', 'nofries'],
            ['NOFRIES_POSTGRES_USER', TARGET.login]].some(([key, expected]) => env[key] && env[key] !== expected))
        fail('context_invalid');
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) ||
        Object.keys(manifest).some(key => !['schemaVersion', 'releaseSha', 'runId', 'runAttempt'].includes(key)) ||
        manifest.schemaVersion !== 2 || manifest.releaseSha !== sha ||
        typeof manifest.runId !== 'string' || !/^[1-9][0-9]*$/.test(manifest.runId) ||
        manifest.runAttempt !== undefined && manifest.runAttempt !== '1') fail('manifest_invalid');
    return { releaseSha: sha, releaseRunId: manifest.runId };
}
function readManifest() {
    try {
        const stat = fs.lstatSync(MANIFEST);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) fail('manifest_invalid');
        return JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    } catch (_) { fail('manifest_invalid'); }
}
function validateToken(token, now = Date.now()) {
    try {
        if (!token || typeof token.token !== 'string' || token.token.length > 16384 ||
            !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token.token) ||
            !Number.isFinite(token.expiresOnTimestamp) || token.expiresOnTimestamp <= now + 10000) fail('token_binding_invalid');
        const claims = JSON.parse(Buffer.from(token.token.split('.')[1], 'base64url').toString('utf8'));
        if (!claims || claims.oid !== TARGET.identity || claims.tid !== TARGET.tenant || claims.aud !== AUDIENCE ||
            !Number.isFinite(claims.exp) || claims.exp * 1000 <= now + 10000 ||
            claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf * 1000 > now + 30000))
            fail('token_binding_invalid');
        // These are binding checks, not local JWT signature verification. The
        // fixed TLS-authenticated PostgreSQL server validates the actual token.
        return token;
    } catch (_) { fail('token_binding_invalid'); }
}
function validateIdentity(rows, database) {
    if (!Array.isArray(rows) || rows.length !== 1) fail('identity_invalid');
    const row = rows[0];
    if (!row || row.database !== database || row.actor !== TARGET.login || row.session !== TARGET.login ||
        row.rolcanlogin !== true || ROLE_KEYS.some(key => row[key] !== false)) fail('identity_invalid');
    return { database, actor: TARGET.login, session: TARGET.login, rolcanlogin: true,
        ...Object.fromEntries(ROLE_KEYS.map(key => [key, false])) };
}
function bounded(work, milliseconds, abort = () => {}) {
    let timer;
    return Promise.race([work, new Promise((_, reject) => {
        timer = setTimeout(() => { abort(); reject(new ProbeError('deadline')); }, milliseconds);
    })]).finally(() => clearTimeout(timer));
}
function failureCode(error) {
    const code = typeof error?.code === 'string' ? error.code : '';
    return code.startsWith('mi_probe_') && ERROR_CODES.has(code.slice(9)) ? code : 'mi_probe_failed';
}
async function observe(database, credential, dependencies = {}) {
    if (!DATABASES.includes(database)) fail('request_invalid');
    const controller = new AbortController();
    let tokenChecked = false, tokenFailed = false, accepting = true, connectionSettled = false, connectionError = false;
    let client, clientEnded, begun = false, phase = 'connect';
    const now = dependencies.now || Date.now;
    const deadline = now() + 8000;
    const wait = dependencies.bounded || bounded;
    const step = work => wait(work, Math.max(1, deadline - now()), () => controller.abort());
    const verifiedCredential = { async getToken(scope) {
        if (scope !== TOKEN_SCOPE) fail('token_binding_invalid');
        // Credential availability is unknown, not a database permission denial.
        const supplied = await credential.getToken(scope, { abortSignal: controller.signal });
        try {
            const token = validateToken(supplied, now());
            tokenChecked = true;
            return token;
        } catch (_) { tokenFailed = true; fail('token_binding_invalid'); }
    } };
    const pool = createPostgresPool({ env: { NODE_ENV: 'production' },
        host: TARGET.host, database, user: TARGET.login, port: 5432, credential: verifiedCredential,
        poolMax: 1, statementTimeoutMs: 3000, connectionTimeoutMs: 5000, idleTimeoutMs: 1000,
        applicationName: 'nofries-managed-identity-probe', ...(dependencies.Pool ? { Pool: dependencies.Pool } : {}) });
    const result = { database, connection: 'unknown', metadata: 'not-run', identityVerified: false,
        cleanupVerified: false };
    let fatal;
    try {
        const pending = pool.connect().then(value => {
            connectionSettled = true;
            // pg-pool removes its idle error listener while a client is borrowed.
            // Keep this handler through discard, including a late acquisition,
            // so an asynchronous transport error cannot expose driver details.
            if (typeof value.on !== 'function' || typeof value.once !== 'function') fail('failed');
            value.on('error', () => { connectionError = true; controller.abort(); });
            const ended = new Promise(resolve => value.once('end', resolve));
            if (!accepting) { value.release(true); return null; }
            client = value; clientEnded = ended; return value;
        }, error => { connectionSettled = true; throw error; });
        client = await step(pending);
        if (!client || !tokenChecked || tokenFailed) fail('token_binding_invalid');
        result.connection = 'authenticated';
        phase = 'metadata'; result.metadata = 'unknown';
        await step(client.query('BEGIN READ ONLY')); begun = true;
        const rows = (await step(client.query(IDENTITY_SQL))).rows;
        const metadata = validateIdentity(rows, database);
        result.metadata = 'verified'; result.identityVerified = true; result.metadataSha256 = digest(metadata);
    } catch (error) {
        if (tokenFailed || error instanceof ProbeError && ['mi_probe_identity_invalid', 'mi_probe_token_binding_invalid'].includes(error.code))
            fatal = new ProbeError(tokenFailed ? 'token_binding_invalid' : error.code.slice(9));
        else if (error?.code === '42501') {
            result[phase === 'connect' ? 'connection' : 'metadata'] = 'permission-denied';
            result.sqlstate = '42501';
        }
        // All other SQLSTATEs, authentication, SDK, TLS and transport failures
        // remain unknown; never retain their raw messages or provider details.
    } finally {
        accepting = false; controller.abort();
        let cleaned = true;
        if (client) {
            if (begun) try { await wait(client.query('ROLLBACK'), 1000); } catch (_) { cleaned = false; }
            try { client.release(true); } catch (_) { cleaned = false; }
            // pg-pool removes discarded clients before their asynchronous end
            // completes. pool.end() alone does not prove transport closure.
            try { await wait(clientEnded, 1000); } catch (_) { cleaned = false; }
        }
        try { await wait(pool.end(), 1000); } catch (_) { cleaned = false; }
        result.cleanupVerified = cleaned && connectionSettled && !connectionError;
    }
    if (connectionError) {
        result.connection = 'unknown'; result.metadata = 'unknown'; result.identityVerified = false;
        delete result.sqlstate; delete result.metadataSha256;
    }
    if (fatal) throw fatal;
    return result;
}
async function run(args, dependencies = {}) {
    const sha = parse(args), env = dependencies.env || process.env;
    const release = validateContext(env, (dependencies.readManifest || readManifest)(), sha);
    const ManagedIdentityCredential = dependencies.ManagedIdentityCredential || require('@azure/identity').ManagedIdentityCredential;
    const credential = new ManagedIdentityCredential();
    const observations = [];
    for (const database of DATABASES) {
        const value = await observe(database, credential, dependencies);
        observations.push(value);
        if (database === 'nofries' && (!value.identityVerified || !value.cleanupVerified)) break;
    }
    const authenticationVerified = observations[0]?.identityVerified === true;
    const diagnosticComplete = observations.length === DATABASES.length && observations.every(value =>
        value.cleanupVerified && (value.identityVerified || value.connection === 'permission-denied'));
    // A connection to a managed database does not prove monitoring-data privacy.
    return { schemaVersion: 1, kind: 'nofries-actual-managed-identity-observation', ...release,
        observedAt: new Date((dependencies.now || Date.now)()).toISOString(), authenticationVerified,
        diagnosticComplete, managedIsolationVerified: false, runtimeAdmissionVerified: false,
        observations, metadataSha256: digest(observations) };
}
if (require.main === module) {
    // Dedicated CLI hard ceiling also closes OS sockets if an SDK/driver ignores
    // its bounded cancellation. It is never installed in the application host.
    const hardStop = setTimeout(() => {
        process.stderr.write('{"code":"mi_probe_deadline"}\n'); process.exit(1);
    }, 55000);
    hardStop.unref();
    run(process.argv.slice(2)).then(result => {
        process.stdout.write(JSON.stringify(result) + '\n');
        if (!result.diagnosticComplete) process.exitCode = 1;
    }).catch(error => {
        process.stderr.write(JSON.stringify({ code: failureCode(error) }) + '\n'); process.exitCode = 1;
    });
}
module.exports = { TARGET, DATABASES, IDENTITY_SQL, ProbeError, parse, validateContext, validateToken,
    validateIdentity, bounded, failureCode, observe, run };
