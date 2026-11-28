'use strict';

const { randomUUID, createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { apiSecurityHeaders } = require('../securityHeaders');
const { assertExactSameOriginRequest } = require('../browserAuth');
const LOOKUP_BUDGET = 10, WIPE_BUDGET = 60;
// Bodies read a minute, of any shape: room for both budgets plus as many
// refused calls again, so refused reads cannot hold up a bulk run.
const BODY_CEILING = 2 * (LOOKUP_BUDGET + WIPE_BUDGET);
const fail = statusCode => { throw Object.assign(new Error(), { statusCode }); };

// The durable audit writer is mandatory: a lookup whose record cannot be
// written is refused. The event carries the actor digest and a keyed (HMAC)
// target digest supplied by the host, never the email. Only a request from an
// authorised staff admin is recorded durably; anonymous, non-staff and
// wrong-method requests cannot create audit objects.
// The optional signup list is the same route with an exact empty body {}. It
// shares the staff authority, budget and durable audit; its record has no
// target digest. One route keeps the Static Web Apps route table within budget.
// The optional staff reset/delete (accountWipeRoute) is the same route with a
// body whose only key is "wipe"; it writes its own approval, attempt and
// outcome records, so no lookup record is written for it. Without it composed
// (flag off) such a body is answered 404.
// The optional staff contact request list (contactRequestList, behind
// NOFRIES_OPERATOR_CONTACT_REQUESTS_ENABLED) is the exact body
// {"contactRequests":true}: read only, same checks, one durable record with
// category dashboard_admin_contact_request_list. Off: 404, and its client
// script is not served.
function createAccountLookup({ read, list = null, wipe = null, contactRequests = null, audit, targetDigest, readJson, env, now = Date.now }) {
    if ([read, audit, targetDigest].some(value => typeof value !== 'function') || [list, wipe, contactRequests].some(value => value !== null && typeof value !== 'function')) throw new Error('dashboard_admin_configuration_invalid');
    let windowStart = 0, requests = 0, wipeRequests = 0, bodies = 0;
    return async (request, route, authorise, signal) => {
        let status = 503, body, actor = null, actorHash = null, targetSha256 = null, category = 'dashboard_admin_account_lookup';
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
                if (contactRequests) body += '\n' + fs.readFileSync(path.join(__dirname, 'contactRequestsClient.js'), 'utf8');
            } else {
                try { assertExactSameOriginRequest(request, env); } catch (_) { fail(403); }
                // Process-wide budgets, so changing email or staff identity cannot
                // bypass a cap. The host also applies its per-client API limit.
                // Reads (lookup, list, contact requests) get 10 a minute; reset and
                // delete calls (a body whose only key is "wipe") get their own 60,
                // so a bulk run of 25 accounts (approve + apply each) fits and does
                // not use up the reads. Telling the two apart needs the body, so
                // before any body is read a request is refused when both budgets
                // are used up or BODY_CEILING bodies were read this minute; the
                // body is read under readJson's size limits.
                if (now() - windowStart >= 60000) { windowStart = now(); requests = 0; wipeRequests = 0; bodies = 0; }
                const limited = () => { headers['Retry-After'] = '60'; fail(429); };
                if (++bodies > BODY_CEILING || requests >= LOOKUP_BUDGET && wipeRequests >= WIPE_BUDGET) limited();
                let input;
                try { input = await readJson(request, signal); }
                catch (error) { if (++requests > LOOKUP_BUDGET) limited(); throw error; }
                const isWipe = input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).length === 1 && Object.hasOwn(input, 'wipe');
                if (isWipe ? ++wipeRequests > WIPE_BUDGET : ++requests > LOOKUP_BUDGET) limited();
                if (isWipe) {
                    if (!wipe) fail(404);
                    if ((await authorise()).subjectKey !== actor.subjectKey) fail(403);
                    // Once a wipe has started its outcome is reported as it is; a
                    // later revocation must not hide a committed change.
                    const result = await wipe(input.wipe, actor, request, signal);
                    return { status: result.status, body: result.body, headers, isRaw: false };
                }
                if (input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).length === 1 && Object.hasOwn(input, 'contactRequests')) {
                    if (!contactRequests) fail(404);
                    if (input.contactRequests !== true) fail(400);
                    category = 'dashboard_admin_contact_request_list';
                    if ((await authorise()).subjectKey !== actor.subjectKey) fail(403);
                    body = await contactRequests(signal);
                    if (!body || !Array.isArray(body.rows) || typeof body.truncated !== 'boolean') fail(503);
                } else if (input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).length === 0) {
                    if (!list) fail(400);
                    category = 'dashboard_admin_account_list';
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
            status = [400, 401, 403, 404, 405, 413, 415, 429].includes(error.statusCode) ? error.statusCode : 503;
            body = { code: `dashboard_admin_account_lookup_${status}` };
        }
        if (route === 'accounts/lookup' && actor !== null) {
            try { await audit(Object.freeze({ category, requestId: randomUUID(), actorSha256: actorHash, targetSha256,
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
module.exports = { createAccountLookup, LOOKUP_BUDGET, WIPE_BUDGET };
