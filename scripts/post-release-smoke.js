'use strict';
// Explicit, credential-free GET smoke; no scheduler, redirects or auth-start routes.
// See docs/post-release-journey-check.md for usage and limits.
const SHA = /^[0-9a-f]{40}$/;
const TIMEOUT_MS = 15000;
function json(response) {
    try { return JSON.parse(response.text); } catch (_) { return null; }
}
// Inspect known bootstraps without execution: hosted /signup defaults to legacy.
function signupProvider(html = '') {
    const configs = [...html.matchAll(/const transportClient = transport\.createSignupClient\(\{ fetch: window\.fetch\.bind\(window\),\s*(customerTransport: 'external',\s*)?createAccount:/g)];
    const dispatcher = html.indexOf("const providers = new URLSearchParams(window.location.search || '').getAll('provider');");
    const branch = html.indexOf("if (providers[0] === 'external') {\n");
    if (dispatcher < 0 && branch < 0 && configs.length === 1) return configs[0][1] ? 'external' : 'legacy';
    if (configs.length === 2 && configs[0][1] && !configs[1][1] && dispatcher >= 0 && branch > dispatcher &&
        branch < configs[0].index && html.slice(configs[0].index, configs[1].index).includes("\n} else {\n'use strict';\n(() => {\n")) return 'legacy';
    return null; // Unknown/changed bootstrap must not guess a healthy provider.
}
// Checks return null or a fixed label, numeric status or validated SHA.
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
        const provider = signupProvider(page.text);
        if (provider === null) return 'signup provider selection unavailable';
        const usesExternal = provider === 'external';
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
const READ_ONLY_PATHS = Object.freeze([...new Set(READ_ONLY_CHECKS.flatMap(c => c.paths))]);
function parseArgs(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i++) {
        const key = argv[i];
        if (key === '--allow-http') args.allowHttp = true;
        else if (key === '--base-url' || key === '--expect-sha') {
            const value = argv[++i];
            if (value === undefined || value === '' || value.startsWith('--')) throw new Error(`${key} requires a value`);
            args[key === '--base-url' ? 'baseUrl' : 'expectSha'] = value;
        } else throw new Error('Unknown argument; use --base-url, --expect-sha, --allow-http.');
    }
    return args;
}
async function runSmoke({ baseUrl, expectSha = null, allowHttp = false, fetchImpl = globalThis.fetch }) {
    let base;
    try { base = new URL(baseUrl); } catch (_) { throw new Error('Base URL must be a valid origin.'); }
    if (base.protocol !== 'https:' && !(allowHttp && base.protocol === 'http:')) throw new Error('Base URL must use https.');
    if (base.pathname !== '/' || base.search || base.hash || base.username || base.password) throw new Error('Base URL must be an origin only.');
    if (expectSha !== null && !SHA.test(expectSha)) throw new Error('Expected SHA must be a full 40-character lowercase commit SHA.');
    const allowed = new Set(READ_ONLY_PATHS);
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
    for (const item of READ_ONLY_CHECKS) {
        const responses = await Promise.all(item.paths.map(probe));
        const reason = item.check(responses, expectSha);
        results.push({ step: results.length + 1, name: item.name, ok: reason === null, reason,
            probes: item.paths.map((path, i) => ({ url: new URL(path, base).href, status: responses[i].status })) });
    }
    return { ok: results.every(r => r.ok), readOnly: true, results };
}
// Only fixed labels, validated origins/SHAs and numeric statuses reach output.
// Never print response bodies, Location/Set-Cookie headers or fetch errors.
function formatReport({ ok, results }) {
    const lines = ['Mode: READ-ONLY (unauthenticated GET; no redirects).'];
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
    if (!args.baseUrl) throw new Error('Usage: node scripts/post-release-smoke.js --base-url https://... [--expect-sha <sha>]');
    const report = await runSmoke(args);
    process.stdout.write(formatReport(report));
    process.exitCode = report.ok ? 0 : 1;
}

if (require.main === module) main().catch(error => { process.stderr.write(`FAIL arguments: ${error.message}\n`); process.exitCode = 2; });

module.exports = { runSmoke, parseArgs, formatReport, READ_ONLY_CHECKS, READ_ONLY_PATHS };
