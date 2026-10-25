'use strict';

const { PERMISSIONS } = require('./portalPermissions');
const { requireTenantRequestContext } = require('./tenantRequestContext');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

class DashboardAuditError extends Error {
    constructor() {
        super('dashboard_audit_unavailable');
        this.name = 'DashboardAuditError';
        this.code = 'dashboard_audit_unavailable';
        this.statusCode = 503;
        this.details = Object.freeze({ code: this.code });
    }
}
function unavailable() { throw new DashboardAuditError(); }

// Uninstalled event interface. Creating or delivering an event proves neither
// permission nor mutation commit. DATA-001 must persist a successful mutation
// and its event atomically, after current tenant/action/revision checks.
function createDashboardAudit(adapters) {
    const dependencies = record(adapters, ['writeEvent', 'clock', 'createEventId']);
    if (Object.values(dependencies).some(value => typeof value !== 'function')) unavailable();
    const events = new WeakSet();
    function createEvent(contextInput, operationInput) {
        try {
            const context = requireTenantRequestContext(contextInput);
            const operation = record(operationInput, ['action', 'module', 'result']);
            if (typeof operation.action !== 'string' || !own(PERMISSIONS, operation.action) ||
                !PERMISSIONS[operation.action].includes(operation.module) ||
                !['succeeded', 'denied', 'failed'].includes(operation.result)) unavailable();
            const eventId = dependencies.createEventId(), occurredAt = instant(dependencies.clock());
            if (typeof eventId !== 'string' || !UUID.test(eventId) || occurredAt < context.resolvedAt) unavailable();
            const event = Object.freeze({ schemaVersion: 1, eventType: 'dashboard.operation', eventId,
                requestId: context.requestId, actorSubjectKey: context.identity.subjectKey,
                tenantId: context.scope.tenantId, organisationId: context.scope.organisationId,
                action: operation.action, module: operation.module, result: operation.result, occurredAt });
            events.add(event);
            return event;
        } catch (error) { unavailable(); }
    }
    async function writeEvent(event) {
        try {
            if (!event || typeof event !== 'object' || !events.has(event)) unavailable();
            // Retry this same immutable envelope/id after uncertain sink delivery.
            // Never retry an application mutation because telemetry delivery failed.
            await dependencies.writeEvent(event);
            return Object.freeze({ eventId: event.eventId, delivery: 'acknowledged' });
        } catch (error) { unavailable(); }
    }
    return Object.freeze({ createEvent, writeEvent });
}
function record(value, fields) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value))) unavailable();
    const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(value);
    if (keys.length !== fields.length || keys.some(key => !fields.includes(key)) ||
        fields.some(key => !own(descriptors, key) || !own(descriptors[key], 'value'))) unavailable();
    return Object.fromEntries(fields.map(key => [key, descriptors[key].value]));
}
function instant(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
        !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) unavailable();
    return value;
}
module.exports = { DashboardAuditError, createDashboardAudit };
