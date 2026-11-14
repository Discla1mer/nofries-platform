'use strict';

const { randomUUID, createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { apiSecurityHeaders } = require('../securityHeaders');
const { assertExactSameOriginRequest } = require('../browserAuth');
const fail = statusCode => { throw Object.assign(new Error(), { statusCode }); };

// The durable audit writer is mandatory: a lookup whose record cannot be
// written is refused. The event carries the actor digest and a keyed (HMAC)
// target digest supplied by the host, never the email. Only a request from an
// authorised staff admin is recorded durably; anonymous, non-staff and
// wrong-method requests cannot create audit objects.
// The optional signup list is the same route with an exact empty body {}. It
// shares the staff authority, budget and durable audit; its record has no
// target digest. One route keeps the Static Web Apps route table within budget.
function createAccountLookup({ read, list = null, audit, targetDigest, readJson, env, now = Date.now }) {
    if ([read, audit, targetDigest].some(value => typeof value !== 'function') || list !== null && typeof list !== 'function') throw new Error('dashboard_admin_configuration_invalid');
    let windowStart = 0, requests = 0;
    return async (request, route, authorise, signal) => {
        let status = 503, body, actor = null, actorHash = null, targetSha256 = null, listing = false;
        const headers = apiSecurityHeaders({ 'Content-Type': 'application/json; charset=utf-8' });
        try {
            const method = route === 'accounts/app.js' ? 'GET' : 'POST';
            if (request.method !== method) { headers.Allow = method; fail(405); }
            if (String(request.originalUrl || request.url).includes('?') || Object.keys(request.query || {}).length) fail(400);
            actor = await authorise();
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
                if (input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).length === 0) {
                    if (!list) fail(400);
                    listing = true;
                    if ((await authorise()).subjectKey !== actor.subjectKey) fail(403);
                    body = await list(signal, env.NOFRIES_DASHBOARD_ADMIN_ACCOUNT_ACTIONS === 'true');
                    if (!body || !Array.isArray(body.rows) || typeof body.truncated !== 'boolean') fail(503);
                } else {
                if (!input || typeof input.email !== 'string' || Object.keys(input).length !== 1) fail(400);
                const email = input.email.trim().toLowerCase();
                if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || /[\x00-\x1f\x7f]/.test(email)) fail(400);
                targetSha256 = targetDigest(email);
                if (typeof targetSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(targetSha256)) fail(503);
                if ((await authorise()).subjectKey !== actor.subjectKey) fail(403);
                // Staff authority covers every customer store; selectors are
                // returned only when the write actions are composed.
                body = await read(email, signal, env.NOFRIES_DASHBOARD_ADMIN_ACCOUNT_ACTIONS === 'true');
                if (!body || !Array.isArray(body.rows) || typeof body.truncated !== 'boolean') fail(503);
                }
            }
            const current = await authorise();
            if (current.subjectKey !== actor.subjectKey) fail(403);
            signal.throwIfAborted();
            status = 200;
        } catch (error) {
            status = [400, 401, 403, 405, 413, 415, 429].includes(error.statusCode) ? error.statusCode : 503;
            body = { code: `dashboard_admin_account_lookup_${status}` };
        }
        if (route === 'accounts/lookup' && actor !== null) {
            try { await audit(Object.freeze({ category: listing ? 'dashboard_admin_account_list' : 'dashboard_admin_account_lookup', requestId: randomUUID(), actorSha256: actorHash, targetSha256,
                status, count: status === 200 ? body.rows.length : 0, truncated: status === 200 && body.truncated, occurredAt: new Date(now()).toISOString() })); }
            catch (_) { status = 503; body = { code: 'dashboard_admin_account_lookup_503' }; }
            // The durable write takes time. A session or role revoked meanwhile
            // must not receive already-buffered rows; the record keeps the
            // lookup outcome, this response does not disclose it.
            if (status === 200) {
                try {
                    const current = await authorise();
                    if (current.subjectKey !== actor.subjectKey) fail(403);
                    signal.throwIfAborted();
                } catch (error) {
                    status = [401, 403].includes(error.statusCode) ? error.statusCode : 503;
                    body = { code: `dashboard_admin_account_lookup_${status}` };
                }
            }
        }
        return { status, body, headers, isRaw: status === 200 && route === 'accounts/app.js' };
    };
}
module.exports = { createAccountLookup };
