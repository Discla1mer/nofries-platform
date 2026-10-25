'use strict';

const contexts = new WeakSet();
const SUBJECT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

class TenantRequestContextError extends Error {
    constructor() {
        super('tenant_request_context_denied');
        this.name = 'TenantRequestContextError';
        this.code = 'tenant_request_context_denied';
        this.statusCode = 403;
        this.details = Object.freeze({ code: this.code });
    }
}
function deny() { throw new TenantRequestContextError(); }

// Server-only identity and selection, never permission or bearer authority.
// The host must supply a fresh request object for each HTTP request. No input
// property, header, correlation ID or previous browser projection is trusted.
function createTenantRequestContext(adapters) {
    const dependencies = record(adapters, ['authenticate', 'resolveScope', 'clock', 'createRequestId']);
    if (Object.values(dependencies).some(value => typeof value !== 'function')) deny();
    const requests = new WeakMap();

    function resolve(request) {
        if (!request || typeof request !== 'object') return Promise.reject(new TenantRequestContextError());
        if (!requests.has(request)) {
            // Defer adapter execution until the promise is installed. Re-entrant
            // and parallel consumers must not start a second authentication.
            const pending = Promise.resolve().then(async () => {
                try {
                    const principal = record(await dependencies.authenticate(request), ['authenticated', 'subjectKey']);
                    if (principal.authenticated !== true || typeof principal.subjectKey !== 'string' || !SUBJECT.test(principal.subjectKey)) deny();
                    const identity = Object.freeze({ authenticated: true, subjectKey: principal.subjectKey });
                    const selected = record(await dependencies.resolveScope(request, identity), ['tenantId', 'organisationId']);
                    const scope = Object.freeze({ tenantId: identifier(selected.tenantId), organisationId: identifier(selected.organisationId) });
                    const requestId = dependencies.createRequestId();
                    if (typeof requestId !== 'string' || !UUID.test(requestId)) deny();
                    const context = Object.freeze({ schemaVersion: 1, requestId, identity, scope,
                        resolvedAt: instant(dependencies.clock()) });
                    contexts.add(context);
                    return context;
                } catch (error) { deny(); }
            });
            requests.set(request, pending);
        }
        return requests.get(request);
    }
    return Object.freeze({ resolve,
        authenticate: async request => (await resolve(request)).identity,
        resolveScope: async (request, identityInput) => {
            const context = await resolve(request);
            const identity = record(identityInput, ['authenticated', 'subjectKey']);
            if (identity.authenticated !== true || identity.subjectKey !== context.identity.subjectKey) deny();
            return context.scope;
        }
    });
}

// Brand check is only provenance within this process, never authorisation.
function requireTenantRequestContext(value) {
    if (!value || typeof value !== 'object' || !contexts.has(value)) deny();
    return value;
}
function record(value, fields) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value))) deny();
    const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(value);
    if (keys.length !== fields.length || keys.some(key => !fields.includes(key)) ||
        fields.some(key => !own(descriptors, key) || !own(descriptors[key], 'value'))) deny();
    return Object.fromEntries(fields.map(key => [key, descriptors[key].value]));
}
function identifier(value) {
    if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 180 ||
        /[\u0000-\u001f\u007f*]/.test(value)) deny();
    return value;
}
function instant(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
        !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) deny();
    return value;
}
module.exports = { TenantRequestContextError, createTenantRequestContext, requireTenantRequestContext };
