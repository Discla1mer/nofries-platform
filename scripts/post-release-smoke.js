'use strict';

// Post-release smoke check for the customer journey wiring.
//
// The default run is read-only: every probe is an unauthenticated GET with no
// cookies, redirects are not followed and nothing is posted. The probed routes
// were verified against the production application composition to make no
// durable write (see test/postReleaseSmoke.test.js). The process-local API rate
// limiter still counts each request in memory.
//
// Starting sign-in is NOT read-only: the login routes store a short-lived
// authentication transaction record. That probe only runs with
// --include-sign-in-redirect.
//
// It proves the released build serves the signup, assessment and dashboard
// routes. It does not sign anyone in; the signed-in journey is a manual check
// (docs/post-release-journey-check.md).
//
// Usage: node scripts/post-release-smoke.js --base-url https://example.com
//        [--expect-sha <40-hex>] [--include-sign-in-redirect]

const SHA = /^[0-9a-f]{40}$/;
const LOGIN_HOSTS = /(?:^|\.)(?:login\.microsoftonline\.com|ciamlogin\.com)$/;
const TIMEOUT_MS = 15000;

function json(response) {
    try { return JSON.parse(response.text); } catch (_) { return null; }
}

// Each check receives the probe results and returns null on success or a
// short reason. Reasons contain only fixed labels, numeric status codes and validated SHAs.
const READ_ONLY_CHECKS = [
    { name: 'health reports ok with a release SHA', paths: ['/api/health'], check([r], expectSha) {
        const body = json(r);
        if (r.status !== 200 || body?.status !== 'ok') return `expected healthy HTTP 200, got ${r.status}`;
        if (!SHA.test(String(body.releaseSha || ''))) return 'release SHA missing';
        if (expectSha && body.releaseSha !== expectSha) return `serving ${body.releaseSha}, expected ${expectSha}`;
        return null;
    } },
    { name: 'release.json matches health', paths: ['/release.json', '/api/health'], check([manifest, health]) {
        const a = json(manifest)?.releaseSha, b = json(health)?.releaseSha;
        if (manifest.status !== 200) return `status ${manifest.status}`;
        return SHA.test(String(a || '')) && a === b ? null : 'release.json and health disagree';
    } },
    ...['/signup', '/login', '/dashboard'].map(path => ({ name: `${path} page loads`, paths: [path], check([r]) {
        return r.status === 200 && /text\/html/.test(r.type) ? null : `status ${r.status}`;
    } })),
    { name: 'signup starts at create_account', paths: ['/signup', '/api/customer-signup/state', '/api/external-customer-signup/state'], check([page, legacy, external]) {
        // Inspect the served client configuration; never execute page JavaScript.
        const usesExternal = /customerTransport:\s*'external'/.test(page.text);
        const r = usesExternal ? external : legacy;
        return r.status === 200 && json(r)?.state?.status === 'create_account' ? null
            : `${usesExternal ? '/api/external-customer-signup/state' : '/api/customer-signup/state'}: expected create_account, got HTTP ${r.status}`;
    } },
    { name: 'organisation setup is available', paths: ['/api/organisation-setup/state', '/api/external-organisation-setup/state'], check(results) {
        // A fresh visitor sees 'start' (setup enabled) or 'sign_in' (sign-in entry only).
        return results.some(r => r.status === 200 && ['start', 'sign_in'].includes(json(r)?.state)) ? null
            : 'status ' + results.map(r => r.status).join('/');
    } },
    { name: 'dashboard login sends visitors to /login', paths: ['/api/dashboard/login'], check([r]) {
        return [302, 303].includes(r.status) && r.location === '/login' ? null : `status ${r.status}`;
    } },
    ...[['signed-out session is refused', '/api/auth/session'],
        ['dashboard session requires sign-in', '/api/dashboard/session'],
        ['assessment API is wired and requires sign-in', '/api/dashboard/ncsc/assessments']]
        .map(([name, path]) => ({ name, paths: [path], check([r]) {
            return r.status === 401 ? null : `expected HTTP 401, got ${r.status}`;
        } }))
];

// Writes one short-lived authentication transaction per login route probed.
const SIGN_IN_CHECK = { name: 'customer sign-in redirects to Microsoft (writes a sign-in transaction)',
    paths: ['/api/customer-auth/login', '/api/external-customer-auth/login'], check(results) {
        const ok = results.some(r => {
            if (![302, 303].includes(r.status)) return false;
            try { const url = new URL(r.location); return url.protocol === 'https:' && LOGIN_HOSTS.test(url.hostname); }
            catch (_) { return false; }
        });
        return ok ? null : 'status ' + results.map(r => r.status).join('/');
    } };

const READ_ONLY_PATHS = Object.freeze([...new Set(READ_ONLY_CHECKS.flatMap(c => c.paths))]);

function parseArgs(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i++) {
        const key = argv[i];
        if (key === '--allow-http') args.allowHttp = true;
        else if (key === '--include-sign-in-redirect') args.includeSignInRedirect = true;
        else if (key === '--base-url' || key === '--expect-sha') {
            const value = argv[++i];
            if (value === undefined || value === '' || value.startsWith('--')) throw new Error(`${key} requires a value`);
            args[key === '--base-url' ? 'baseUrl' : 'expectSha'] = value;
        } else throw new Error('Unknown argument; use --base-url, --expect-sha, --allow-http or --include-sign-in-redirect.');
    }
    return args;
}

async function runSmoke({ baseUrl, expectSha = null, allowHttp = false, includeSignInRedirect = false, fetchImpl = globalThis.fetch }) {
    let base;
    try { base = new URL(baseUrl); } catch (_) { throw new Error('Base URL must be a valid origin.'); }
    if (base.protocol !== 'https:' && !(allowHttp && base.protocol === 'http:')) throw new Error('Base URL must use https.');
    if (base.pathname !== '/' || base.search || base.hash || base.username || base.password) throw new Error('Base URL must be an origin only.');
    if (expectSha !== null && !SHA.test(expectSha)) throw new Error('Expected SHA must be a full 40-character lowercase commit SHA.');
    const checks = includeSignInRedirect ? [...READ_ONLY_CHECKS, SIGN_IN_CHECK] : READ_ONLY_CHECKS;
    const allowed = new Set(checks.flatMap(c => c.paths));
    const cache = new Map();
    const probe = path => {
        if (!allowed.has(path)) throw new Error(`Probe ${path} is not enabled for this run.`);
        if (!cache.has(path)) cache.set(path, (async () => {
            try {
                const response = await fetchImpl(new URL(path, base), { method: 'GET', redirect: 'manual',
                    credentials: 'omit', headers: { Accept: 'application/json, text/html' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
                return { status: response.status, location: response.headers.get('location') || '',
                    type: response.headers.get('content-type') || '', text: await response.text() };
            } catch (_) { return { status: 0, location: '', type: '', text: '' }; }
        })());
        return cache.get(path);
    };
    const results = [];
    for (const item of checks) {
        const responses = await Promise.all(item.paths.map(probe));
        const reason = item.check(responses, expectSha);
        results.push({ step: results.length + 1, name: item.name, ok: reason === null, reason,
            probes: item.paths.map((path, i) => ({ url: new URL(path, base).href, status: responses[i].status })) });
    }
    return { ok: results.every(r => r.ok), readOnly: !includeSignInRedirect, results };
}

// Only fixed labels, validated origins/SHAs and numeric statuses reach output.
// Never print response bodies, Location/Set-Cookie headers or fetch errors.
function formatReport({ ok, readOnly, results }) {
    const lines = [readOnly ? 'Mode: READ-ONLY (unauthenticated GET; no redirects).' :
        'Mode: OPT-IN SIGN-IN PROBE (writes authentication transactions; not a full journey).'];
    for (const r of results) {
        lines.push(`${r.ok ? 'PASS' : 'FAIL'} step ${r.step}: ${r.name}${r.ok ? '' : ` (${r.reason})`}`);
        for (const p of r.probes) lines.push(`  GET ${p.url} -> ${p.status === 0 ? 'NETWORK/TIMEOUT failure' : `HTTP ${p.status}`}`);
    }
    lines.push(`${ok ? 'PASS' : 'FAIL'} post-release smoke: ${results.filter(r => r.ok).length}/${results.length} checks passed.`);
    if (!ok) lines.push('Hold the release; ask the release owner for the rollback decision.');
    return lines.join('\n') + '\n';
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!args.baseUrl) throw new Error('Usage: node scripts/post-release-smoke.js --base-url https://... [--expect-sha <sha>] [--include-sign-in-redirect]');
    const report = await runSmoke(args);
    process.stdout.write(formatReport(report));
    process.exitCode = report.ok ? 0 : 1;
}

if (require.main === module) main().catch(error => { process.stderr.write(`FAIL arguments: ${error.message}\n`); process.exitCode = 2; });

module.exports = { runSmoke, parseArgs, formatReport, READ_ONLY_CHECKS, READ_ONLY_PATHS, SIGN_IN_CHECK };
