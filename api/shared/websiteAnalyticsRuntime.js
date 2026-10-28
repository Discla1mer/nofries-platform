'use strict';
const { productionStore, validEvent } = require('./websiteAnalytics');
const { apiSecurityHeaders } = require('./securityHeaders');
const { getProductRequestIdentity } = require('./identity');
const { resolveTenantAccess } = require('./tenantAccess');
const response = (status, body = { status: 'unavailable' }) => ({ status, headers: apiSecurityHeaders({ 'Content-Type': 'application/json; charset=utf-8' }), body });
const header = (req, key) => String(req.headers?.[key] || '').trim();
// Shared by every runtime instance in this process; timed-out checks retain a slot
// until their underlying, non-cancellable session-store request settles.
let identityInFlight = 0;
const identityUnavailable = Symbol('identity unavailable');
const list = (env, name) => String(env[name] || '').split(/[,;\n]/).map(x => x.trim().toLowerCase()).filter(Boolean);
function sameOrigin(req, env) {
    if (header(req, 'sec-fetch-site').toLowerCase() === 'cross-site') return false;
    try {
        const origin = new URL(header(req, 'origin'));
        const expected = new URL(env.NOFRIES_PUBLIC_URL);
        return origin.origin === expected.origin && origin.href === `${origin.origin}/` && ['https:', 'http:'].includes(origin.protocol);
    } catch (_) { return false; }
}
function createRuntime({ env = process.env, store, identityStore, getIdentity = getProductRequestIdentity, clock = Date.now } = {}) {
    let storage = store;
    if (storage === undefined) { try { storage = productionStore(env); } catch (_) { storage = null; } }
    let windowStart = 0, requests = 0;
    return async function handle(req, path) {
        const now = clock();
        if (now - windowStart >= 60000 || now < windowStart) { windowStart = now; requests = 0; }
        if (++requests > 300) return response(429);
        if (!storage) return response(503);
        if (path === '/counter' && req.method === 'GET') {
            try { const doc = await storage.read(); return response(200, { status: 'available', total: doc ? doc.home : null, since: doc ? doc.start : null }); }
            catch (_) { return response(503); }
        }
        if (path === '/events' && req.method === 'POST') {
            if (header(req, 'dnt') === '1' || header(req, 'sec-gpc') === '1') return response(204);
            if (!sameOrigin(req, env) || !/^application\/json(?:\s*;|$)/i.test(header(req, 'content-type'))) return response(400, { status: 'invalid' });
            const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.isBuffer(req.rawBody) ? req.rawBody : typeof req.rawBody === 'string' ? Buffer.from(req.rawBody) : null;
            if (!raw || raw.length > 512) return response(400, { status: 'invalid' });
            let event; try { event = JSON.parse(raw.toString('utf8')); } catch (_) { return response(400, { status: 'invalid' }); }
            if (!validEvent(event)) return response(400, { status: 'invalid' });
            try { await storage.record(event); return response(204); } catch (_) { return response(503); }
        }
        if (path === '/summary' && req.method === 'GET') {
            try {
                if (env.NOFRIES_BROWSER_AUTH_MODE !== 'entra_bff' || String(env.NOFRIES_REQUIRE_AUTH).toLowerCase() === 'false' || !env.NOFRIES_DEFAULT_TENANT_ID) throw Error();
                if (identityInFlight >= 4) return response(503);
                identityInFlight++;
                const checking = Promise.resolve().then(() => getIdentity(req, env, { store: identityStore }));
                checking.then(() => { identityInFlight--; }, () => { identityInFlight--; });
                let timer;
                let identity;
                try {
                    identity = await Promise.race([checking, new Promise(resolve => { timer = setTimeout(() => resolve(identityUnavailable), 2000); })]);
                } finally { clearTimeout(timer); }
                if (identity === identityUnavailable) return response(503);
                const access = resolveTenantAccess(identity, env);
                const subject = String(identity.subjectKey || '').toLowerCase();
                if (identity.provider !== 'entra-bff' || !identity.isAuthenticated || !env.NOFRIES_ENTRA_TENANT_ID || String(identity.tenantId || '').toLowerCase() !== String(env.NOFRIES_ENTRA_TENANT_ID).toLowerCase() || !subject || !list(env, 'NOFRIES_ALLOWED_SUBJECTS').includes(subject) || !list(env, 'NOFRIES_ADMIN_SUBJECTS').includes(subject) || !access.allowed || !access.authentication.authenticated || !access.user.capabilities.includes('tenant:admin') || access.tenant.id !== env.NOFRIES_DEFAULT_TENANT_ID) throw Error();
                try { const doc = await storage.read(); return doc ? response(200, doc) : response(503); } catch (_) { return response(503); }
            } catch (_) { return response(403); }
        }
        return response(404);
    };
}
module.exports = { createRuntime, sameOrigin };
