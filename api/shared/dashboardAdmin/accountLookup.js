'use strict';

const { randomUUID, createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { apiSecurityHeaders } = require('../securityHeaders');
const { assertExactSameOriginRequest } = require('../browserAuth');
const fail = statusCode => { throw Object.assign(new Error(), { statusCode }); };

function createAccountLookup({ read, readJson, env, audit = line => console.info(line), now = Date.now }) {
    let windowStart = 0, requests = 0;
    return async (request, route, authorise, signal) => {
        let status = 503, body, actorHash = null;
        const headers = apiSecurityHeaders({ 'Content-Type': 'application/json; charset=utf-8' });
        try {
            const method = route === 'accounts/app.js' ? 'GET' : 'POST';
            if (request.method !== method) { headers.Allow = method; fail(405); }
            if (String(request.originalUrl || request.url).includes('?') || Object.keys(request.query || {}).length) fail(400);
            const actor = await authorise();
            actorHash = createHash('sha256').update(actor.subjectKey).digest('hex');
            if (route === 'accounts/app.js') {
                headers['Content-Type'] = 'application/javascript; charset=utf-8';
                body = fs.readFileSync(path.join(__dirname, 'accountLookupClient.js'), 'utf8');
            } else {
                try { assertExactSameOriginRequest(request, env); } catch (_) { fail(403); }
                // Process-wide budget, so changing email or staff identity cannot
                // bypass the cap. The host also applies its per-client API limit.
                if (now() - windowStart >= 60000) { windowStart = now(); requests = 0; }
                if (++requests > 10) { headers['Retry-After'] = '60'; fail(429); }
                const input = await readJson(request, signal);
                if (!input || typeof input.email !== 'string' || Object.keys(input).length !== 1) fail(400);
                const email = input.email.trim().toLowerCase();
                if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || /[\x00-\x1f\x7f]/.test(email)) fail(400);
                if ((await authorise()).subjectKey !== actor.subjectKey) fail(403);
                const selectors = [], checkScope = async selector => {
                    if ((await authorise(selector)).subjectKey !== actor.subjectKey) fail(403);
                };
                body = { rows: await read(email, signal, async selector => { await checkScope(selector); selectors.push(selector); }, env.NOFRIES_DASHBOARD_ADMIN_ACCOUNT_ACTIONS === 'true') };
                for (const selector of selectors) await checkScope(selector);
            }
            const current = await authorise();
            if (current.subjectKey !== actor.subjectKey) fail(403);
            signal.throwIfAborted();
            status = 200;
        } catch (error) {
            status = [400, 401, 403, 405, 413, 415, 429].includes(error.statusCode) ? error.statusCode : 503;
            body = { code: `dashboard_admin_account_lookup_${status}` };
        }
        if (route === 'accounts/lookup') {
            try { await audit(JSON.stringify({ category: 'dashboard_admin_account_lookup', requestId: randomUUID(),
                actorHash, status, count: status === 200 ? body.rows.length : 0, occurredAt: new Date(now()).toISOString() })); }
            catch (_) { status = 503; body = { code: 'dashboard_admin_account_lookup_503' }; }
        }
        return { status, body, headers, isRaw: status === 200 && route === 'accounts/app.js' };
    };
}
module.exports = { createAccountLookup };
