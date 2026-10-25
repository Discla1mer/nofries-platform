'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isUtf8 } = require('node:buffer');
const { BrowserAuthError, assertExactSameOriginRequest } = require('../browserAuth');
const { apiSecurityHeaders } = require('../securityHeaders');
const { resolveTenantAccess } = require('../tenantAccess');
const { normaliseSelector } = require('./service');
const { signupListInput } = require('./signupService');
const { buildDashboardAdminDocument, dashboardAdminCss, contentSecurityPolicy } = require('../../../lib/dashboardAdminDocument');
const { buildDashboardAdminEntryDocument } = require('../../../lib/dashboardAdminEntryDocument');

const MAX_BODY_BYTES = 2048;
const SUBJECT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const fail = (statusCode, code) => { throw Object.assign(new Error(code), { statusCode, code }); };

function response(status, body, headers = {}, isRaw = false) {
    return { status, body, headers: apiSecurityHeaders({ 'Content-Type': 'application/json; charset=utf-8', ...headers }), isRaw };
}
function failure(error) {
    const allowed = new Set(['dashboard_admin_authentication_required', 'dashboard_admin_access_denied',
        'dashboard_admin_input_invalid', 'dashboard_admin_request_too_large', 'dashboard_admin_unsupported_media_type',
        'dashboard_admin_method_not_allowed', 'dashboard_admin_not_found', 'dashboard_admin_unavailable']);
    if (allowed.has(error?.code) && [400, 401, 403, 404, 405, 413, 415, 503].includes(error.statusCode)) {
        return response(error.statusCode, { code: error.code });
    }
    // Service errors are deliberately bounded. Never emit provider messages,
    // audit details, stack traces or unrecognised diagnostic codes.
    if (error?.statusCode === 403) return response(403, { code: 'dashboard_admin_access_denied' });
    if (error?.statusCode === 400) return response(400, { code: 'dashboard_admin_input_invalid' });
    if (error?.statusCode === 404) return response(404, { code: 'dashboard_admin_not_found' });
    return response(503, { code: 'dashboard_admin_unavailable' });
}

async function readJson(request, signal) {
    if (signal.aborted) fail(503, 'dashboard_admin_unavailable');
    const headers = request.headers || {};
    if (headers['content-encoding'] && headers['content-encoding'] !== 'identity') fail(415, 'dashboard_admin_unsupported_media_type');
    if (typeof headers['content-type'] !== 'string' || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(headers['content-type'])) {
        fail(415, 'dashboard_admin_unsupported_media_type');
    }
    if (headers['content-length'] && (!/^\d+$/.test(headers['content-length']) || Number(headers['content-length']) > MAX_BODY_BYTES)) {
        fail(413, 'dashboard_admin_request_too_large');
    }
    // The server mounts this handler before its shared body parser. Parsed
    // request objects cannot substitute a caller-controlled principal or body.
    if (request.body !== undefined) fail(400, 'dashboard_admin_input_invalid');
    const bytes = await new Promise((resolve, reject) => {
        let length = 0, settled = false;
        const chunks = [];
        const finish = (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            request.removeListener('data', data);
            request.removeListener('end', end);
            request.removeListener('error', broken);
            request.removeListener('aborted', broken);
            signal.removeEventListener('abort', timedOut);
            if (error) { request.resume(); reject(error); }
            else resolve(Buffer.concat(chunks));
        };
        const broken = () => finish(Object.assign(new Error(), { statusCode: 400, code: 'dashboard_admin_input_invalid' }));
        const timedOut = () => finish(Object.assign(new Error(), { statusCode: 503, code: 'dashboard_admin_unavailable' }));
        const data = chunk => {
            if (!Buffer.isBuffer(chunk)) return broken();
            length += chunk.length;
            if (length > MAX_BODY_BYTES) return finish(Object.assign(new Error(), { statusCode: 413, code: 'dashboard_admin_request_too_large' }));
            chunks.push(chunk);
        };
        const end = () => finish();
        // Bound partial bodies independently of the source service's I/O budget.
        const timer = setTimeout(timedOut, 5000);
        request.on('data', data);
        request.once('end', end);
        request.once('error', broken);
        request.once('aborted', broken);
        signal.addEventListener('abort', timedOut, { once: true });
    });
    if (!bytes.length || !isUtf8(bytes)) fail(400, 'dashboard_admin_input_invalid');
    try { return JSON.parse(bytes.toString('utf8')); }
    catch (_) { fail(400, 'dashboard_admin_input_invalid'); }
}

// Trusted source-only composition: the host binds its genuine staff session
// reader. No request header/body identity, environment grant or default reader.
function createDashboardAdminHandlers({ service = null, signupListService = null, readOperatorSession = null, env = {}, requestBudgetMs = 10000 } = {}) {
    if (service !== null && (!service || ['authorise', 'capabilities', 'lookup'].some(key => typeof service[key] !== 'function')) ||
        signupListService !== null && (!signupListService || ['authorise', 'capabilities', 'list', 'authoriseDisclosure'].some(key => typeof signupListService[key] !== 'function')) ||
        readOperatorSession !== null && typeof readOperatorSession !== 'function' ||
        !Number.isSafeInteger(requestBudgetMs) || requestBudgetMs <= 0 || requestBudgetMs > 60000) throw new Error('dashboard_admin_configuration_invalid');

    async function principal(request, expected = null) {
        if ((!service && !signupListService) || !readOperatorSession) fail(503, 'dashboard_admin_unavailable');
        let details;
        try { details = await readOperatorSession(String(request.headers?.cookie || '')); }
        catch (error) {
            if (error instanceof BrowserAuthError && error.statusCode < 500) fail(401, 'dashboard_admin_authentication_required');
            fail(503, 'dashboard_admin_unavailable');
        }
        const identity = details?.identity;
        if (!identity) fail(401, 'dashboard_admin_authentication_required');
        if (identity.provider !== 'entra-bff' || identity.isAuthenticated !== true || !SUBJECT.test(identity.subjectKey) ||
            identity.subjectKey !== identity.tenantId + ':' + identity.principalId ||
            expected && expected.subjectKey !== identity.subjectKey) fail(403, 'dashboard_admin_access_denied');
        if (String(env.NOFRIES_REQUIRE_AUTH || '').trim().toLowerCase() === 'false') fail(403, 'dashboard_admin_access_denied');
        const access = resolveTenantAccess(identity, env);
        if (!access.allowed || access.user?.role !== 'admin') fail(403, 'dashboard_admin_access_denied');
        return Object.freeze({ provider: identity.provider, isAuthenticated: true, subjectKey: identity.subjectKey,
            tenantId: identity.tenantId, principalId: identity.principalId });
    }

    async function permission(actor, route, selector, checked) {
        if (route === 'signups') {
            if (!signupListService) fail(503, 'dashboard_admin_unavailable');
            return signupListService.authorise(actor);
        }
        if (route === 'lookup' || !signupListService) {
            if (!service) fail(503, 'dashboard_admin_unavailable');
            return service.authorise(actor, selector);
        }
        // Shell/assets may be used by either independently authorised capability.
        // A lookup grant never reaches or substitutes for signupList authority.
        let error;
        for (const candidate of [service, signupListService]) {
            if (!candidate) continue;
            try { return await checked(() => candidate.authorise(actor)); } catch (caught) { error = caught; }
        }
        throw error;
    }
    async function capabilities(actor, checked) {
        if (!signupListService) return service.capabilities(actor);
        let lookup = false, signupList = false;
        if (service) {
            try { lookup = (await checked(() => service.capabilities(actor))).lookup === true; } catch (_) { /* independent capability absent */ }
        }
        try { signupList = (await checked(() => signupListService.capabilities(actor))).signupList === true; } catch (_) { /* independent capability absent */ }
        return { lookup, recovery: [], signupList };
    }

    async function execute(request, route, checked, signal) {
        try {
            const methods = { document: 'GET', 'app.js': 'GET', 'app.css': 'GET', capabilities: 'GET', lookup: 'POST', signups: 'POST',
                entry: 'GET', 'entry.js': 'GET', 'entry-capabilities': 'GET' };
            if (!Object.hasOwn(methods, route)) fail(404, 'dashboard_admin_not_found');
            if (request.method !== methods[route]) return response(405, { code: 'dashboard_admin_method_not_allowed' }, { Allow: methods[route] });
            if (String(request.originalUrl || request.url || '').includes('?') || Object.keys(request.query || {}).length) fail(400, 'dashboard_admin_input_invalid');
            if (!['lookup', 'signups'].includes(route) && (request.headers?.['transfer-encoding'] || Number(request.headers?.['content-length'] || 0) > 0)) fail(400, 'dashboard_admin_input_invalid');
            const actor = await checked(() => principal(request));
            // These routes contain no account data or native authority. A
            // genuine staff administrator can explicitly initialise the existing
            // session gate before the unchanged data permissions are checked.
            const isEntry = ['entry', 'entry.js', 'entry-capabilities'].includes(route);
            if (!isEntry) await checked(() => permission(actor, route, null, checked));
            let body, selector = null, contentType = null;
            if (route === 'lookup' || route === 'signups') {
                try { assertExactSameOriginRequest(request, env); }
                catch (_) { fail(403, 'dashboard_admin_access_denied'); }
                const input = await checked(() => readJson(request, signal));
                selector = route === 'lookup' ? normaliseSelector(input) : signupListInput(input);
                const currentActor = await checked(() => principal(request, actor));
                body = await checked(() => route === 'lookup' ? service.lookup(currentActor, selector) : signupListService.list(currentActor, selector));
            } else if (route === 'entry-capabilities') body = { entry: true };
            else if (route === 'entry') { body = buildDashboardAdminEntryDocument(); contentType = 'text/html; charset=utf-8'; }
            else if (route === 'entry.js') { body = fs.readFileSync(path.join(__dirname, '../protectedAssets/dashboardAdminEntry.js'), 'utf8'); contentType = 'application/javascript; charset=utf-8'; }
            else if (route === 'capabilities') body = await checked(() => capabilities(actor, checked));
            else if (route === 'document') { body = buildDashboardAdminDocument(); contentType = 'text/html; charset=utf-8'; }
            else if (route === 'app.css') { body = dashboardAdminCss; contentType = 'text/css; charset=utf-8'; }
            else { body = ['dashboardAdmin.js', 'signupQueue.js'].map(file => fs.readFileSync(path.join(__dirname, '../protectedAssets', file), 'utf8')).join('\n'); contentType = 'application/javascript; charset=utf-8'; }
            // A parent session or role may have been revoked during source I/O.
            // Re-read it before releasing even already-buffered results/assets.
            const current = await checked(() => principal(request, actor));
            if (!isEntry) await checked(() => route === 'signups' ? signupListService.authoriseDisclosure(current, body) : permission(current, route, selector, checked));
            return response(200, body, contentType ? { 'Content-Type': contentType,
                ...(['document', 'entry'].includes(route) ? { 'Content-Security-Policy': contentSecurityPolicy } : {}) } : {}, contentType !== null);
        } catch (error) { return failure(error); }
    }
    async function handle(request, route) {
        let stopped = false, timer;
        const controller = new AbortController();
        const deadline = Date.now() + requestBudgetMs;
        const check = () => { if (stopped || Date.now() >= deadline) fail(503, 'dashboard_admin_unavailable'); };
        const checked = async work => { check(); const result = await work(); check(); return result; };
        try {
            return await Promise.race([execute(request, route, checked, controller.signal), new Promise(resolve => {
                timer = setTimeout(() => { stopped = true; controller.abort(); resolve(response(503, { code: 'dashboard_admin_unavailable' })); }, requestBudgetMs);
            })]);
        } finally { clearTimeout(timer); }
    }
    return Object.freeze({ handle });
}

module.exports = { createDashboardAdminHandlers };
