'use strict';

const https = require('node:https');
const ORIGIN = 'https://nofries.nz';
// Reuse PR #17's audited GET routes and selected-provider state contract. Its
// optional sign-in probes write auth transactions and are deliberately excluded.
const PAGES = ['/', '/signup', '/login', '/dashboard', '/terms.html', '/privacy.html'];
const PATHS = Object.freeze([...PAGES, '/api/health', '/api/customer-signup/state', '/api/external-customer-signup/state']);
const TIMEOUT_MS = 10000, MAX_BYTES = 1024 * 1024, EXPIRY_DAYS = 30;

// Native HTTPS validates the chain and hostname. Never follow redirects, store
// cookies, retry, or expose remote bodies/headers/errors in logs or alerts.
function request(url, { payload, timeoutMs = TIMEOUT_MS, requestImpl = https.request } = {}) {
    return new Promise(resolve => {
        let req, response, timer, settled = false;
        const finish = value => {
            if (settled) return;
            settled = true; clearTimeout(timer);
            response?.destroy(); req?.destroy(); resolve(value);
        };
        timer = setTimeout(() => finish({ status: 0 }), timeoutMs);
        try {
            const data = payload === undefined ? undefined : JSON.stringify(payload);
            req = requestImpl(url, { method: data === undefined ? 'GET' : 'POST', rejectUnauthorized: true,
                agent: false, headers: data === undefined ? { Accept: 'application/json, text/html',
                    'Accept-Encoding': 'identity', 'Cache-Control': 'no-cache' } :
                    { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, res => {
                response = res;
                const validTo = res.socket?.getPeerCertificate()?.valid_to;
                let size = 0;
                const chunks = [];
                res.on('error', () => finish({ status: 0 }));
                res.on('aborted', () => finish({ status: 0 }));
                res.on('data', chunk => {
                    size += chunk.length;
                    if (size > MAX_BYTES) finish({ status: 0 });
                    else if (data === undefined) chunks.push(chunk);
                });
                res.on('end', () => finish({ status: res.statusCode, type: res.headers['content-type'] || '',
                    text: Buffer.concat(chunks).toString('utf8'), validTo }));
            });
            req.on('error', () => finish({ status: 0 }));
            req.end(data);
        } catch (_) { finish({ status: 0 }); }
    });
}

function parseJson(response) {
    try { return JSON.parse(response.text); } catch (_) { return null; }
}

async function checkHealth({ requestImpl = request, now = Date.now() } = {}) {
    const responses = new Map();
    // Sequential bounded requests avoid a burst against the public API limiter.
    for (const path of PATHS) {
        try { responses.set(path, await requestImpl(new URL(path, ORIGIN))); }
        catch (_) { responses.set(path, { status: 0 }); }
    }
    const results = [];
    const add = (check, ok, status) => results.push({ check, ok, ...(status === undefined ? {} : { status }) });
    for (const path of PAGES) {
        const r = responses.get(path);
        add(path, r.status === 200 && /^text\/html\b/i.test(r.type), r.status);
    }
    const health = responses.get('/api/health');
    add('/api/health', health.status === 200 && parseJson(health)?.status === 'ok', health.status);
    const external = /customerTransport:\s*'external'/.test(responses.get('/signup').text || '');
    const selected = external ? '/api/external-customer-signup/state' : '/api/customer-signup/state';
    const signup = responses.get(selected);
    add(selected, signup.status === 200 && parseJson(signup)?.state?.status === 'create_account', signup.status);
    // Inspect certificates on every required response; the inactive signup
    // provider may legitimately return 410 but cannot mask the selected provider.
    const required = [...PAGES, '/api/health', selected];
    const expiry = required.map(path => Date.parse(responses.get(path).validTo));
    const days = Math.floor((Math.min(...expiry) - now) / 86400000);
    add('HTTPS certificate valid with at least 30 days remaining', Number.isFinite(days) && days >= EXPIRY_DAYS);
    return { ok: results.every(r => r.ok), results, certificateDaysRemaining: Number.isFinite(days) ? days : null };
}

function formatReport(report) {
    return ['No Fries read-only health monitor', ...report.results.map(r =>
        `${r.ok ? 'PASS' : 'FAIL'} ${r.check}${r.status === undefined ? '' : ` (HTTP ${r.status}; 0 = transport/timeout failure)`}`),
    `Certificate days remaining: ${report.certificateDaysRemaining ?? 'unavailable'}`].join('\n');
}

function destination(value) {
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && !url.username && !url.password && !url.hash ? url : null;
    } catch (_) { return null; }
}

async function run({ env = process.env, probe = checkHealth, deliver = request, log = console.log } = {}) {
    if (env.NOFRIES_MONITOR_ENABLED !== 'true') { log('DISABLED: production monitoring is not enabled.'); return 0; }
    const webhook = destination(env.NOFRIES_MONITOR_ALERT_WEBHOOK);
    if (!webhook) { log('DISABLED: configure a valid HTTPS alert destination before monitoring.'); return 2; }
    let report;
    try { report = await probe(); }
    catch (_) { report = { ok: false, results: [{ check: 'monitor execution', ok: false }], certificateDaysRemaining: null }; }
    const text = formatReport(report);
    log(text);
    if (report.ok) return 0;
    // Slack-compatible JSON {text}; an owner-managed relay can route to email or
    // another channel. The destination itself is never included in the payload.
    let sent;
    try { sent = await deliver(webhook, { payload: { text } }); } catch (_) { sent = { status: 0 }; }
    if (!(sent.status >= 200 && sent.status < 300)) { log('FAIL: alert delivery failed; inspect the workflow and channel configuration.'); return 2; }
    log('Alert delivered.');
    return 1;
}

if (require.main === module) run().then(code => { process.exitCode = code; }).catch(() => {
    console.error('FAIL: monitor execution failed.'); process.exitCode = 2;
});
module.exports = { PATHS, checkHealth, request, run, formatReport };
