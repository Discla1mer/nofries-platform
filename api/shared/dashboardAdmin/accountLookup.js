'use strict';

const { randomUUID, createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { apiSecurityHeaders } = require('../securityHeaders');
const fail = statusCode => { throw Object.assign(new Error(), { statusCode }); };

function createAccountLookup({ read, audit = line => console.info(line), now = Date.now }) {
    let windowStart = 0, requests = 0;
    return async (request, route, authorise, signal) => {
        let status = 503, body, actorHash = null;
        const headers = apiSecurityHeaders({ 'Content-Type': 'application/json; charset=utf-8' });
        try {
            if (request.method !== 'GET') { headers.Allow = 'GET'; fail(405); }
            const actor = await authorise();
            actorHash = createHash('sha256').update(actor.subjectKey).digest('hex');
            if (route === 'accounts/app.js') {
                if (String(request.originalUrl || request.url).includes('?')) fail(400);
                headers['Content-Type'] = 'application/javascript; charset=utf-8';
                body = fs.readFileSync(path.join(__dirname, 'accountLookupClient.js'), 'utf8');
            } else {
                // Process-wide budget, so changing email or staff identity cannot
                // bypass the cap. The host also applies its per-client API limit.
                if (now() - windowStart >= 60000) { windowStart = now(); requests = 0; }
                if (++requests > 10) { headers['Retry-After'] = '60'; fail(429); }
                const query = new URL(request.originalUrl || request.url, 'https://lookup.invalid').searchParams;
                if (query.size !== 1 || !query.has('email')) fail(400);
                const email = query.get('email').trim().toLowerCase();
                if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || /[\x00-\x1f\x7f]/.test(email)) fail(400);
                body = { rows: await read(email, signal) };
            }
            const current = await authorise();
            if (current.subjectKey !== actor.subjectKey) fail(403);
            signal.throwIfAborted();
            status = 200;
        } catch (error) {
            status = [400, 401, 403, 405, 429].includes(error.statusCode) ? error.statusCode : 503;
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
