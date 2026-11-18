'use strict';

// A signed-in customer asks No Fries to contact their organisation (#409,
// stage 1b). Closed inputs only: the topic, the consent wording version the
// customer saw, and the caller's operation id. No message text, no email
// address and no assessment content is accepted or stored. Migration 0026
// binds each row to the transaction's tenant, organisation and sign-in subject.
const registry = require('./protectedAssets/dashboardRegistry');
const { fields, uuid } = require('./appLifecycle/dashboardRuntimeRecords');
const { requireTenantRequestContext } = require('./appLifecycle/tenantRequestContext');
const { resolvePortalPermission } = require('./appLifecycle/portalPermissions');

const CONTACT_TOPICS = Object.freeze(['results', ...registry.services.map(service => service.key)]);
const CONSENT_VERSIONS = Object.freeze(['contact-request-v1']);
const CONTACT_AUDIT = Object.freeze({ action: 'contact.request', module: 'overview' });

class ContactRequestError extends Error {
    constructor(code = 'contact_request_unavailable', statusCode = 503) {
        super(code); this.name = 'ContactRequestError';
        this.code = code; this.statusCode = statusCode;
        delete this.stack; Object.freeze(this);
    }
}

function normaliseContactRequest(input) {
    try {
        const value = fields(input, ['operationId', 'topic', 'consentVersion']);
        uuid(value.operationId);
        if (!CONTACT_TOPICS.includes(value.topic) || !CONSENT_VERSIONS.includes(value.consentVersion)) throw new Error();
        return Object.freeze({ operationId: value.operationId, topic: value.topic, consentVersion: value.consentVersion });
    } catch (_) { throw new ContactRequestError('contact_request_input_invalid', 400); }
}

// Evaluated on the locked current authority snapshot. Admin, editor and viewer
// members may ask; an advisor-only member may not (no assignment is offered).
function resolveContactAccess(snapshot, contextInput, at) {
    const context = requireTenantRequestContext(contextInput);
    if (at < context.resolvedAt) throw new ContactRequestError('contact_request_access_denied', 403);
    return resolvePortalPermission(snapshot.membershipState, snapshot.tenantAggregate,
        { ...context.scope, subjectKey: context.identity.subjectKey, permission: 'contact.request', module: 'overview' }, null, at);
}

// One transaction: a new request row and its audit event commit together. A
// retry or a same-day repeat writes nothing, so replays cannot grow the audit
// table. A repeat that stored no row leaves no claim on its operation id: a
// later call with it is judged afresh (a new NZ day may then store it).
// The NZ day is derived in SQL from the same timestamp the table CHECK uses.
async function writeContactRequest({ database, clock, audit, context: contextInput }, commandInput) {
    const context = requireTenantRequestContext(contextInput), command = normaliseContactRequest(commandInput);
    const { scope, identity } = context;
    return database.withTenantTransaction(scope.tenantId, async client => {
        const existing = async () => (await client.query(`SELECT organisation_id, subject_key, topic, consent_version
            FROM nofries.dashboard_contact_requests WHERE tenant_id = $1 AND request_id = $2`, [scope.tenantId, command.operationId])).rows;
        let found = await existing(), status = null, inserted = false;
        if (!found.length) {
            const at = clock();
            const insert = await client.query(`INSERT INTO nofries.dashboard_contact_requests
                (tenant_id, organisation_id, request_id, subject_key, topic, consent_version, requested_day, requested_at)
                VALUES ($1, $2, $3, $4, $5, $6, ($7::timestamptz AT TIME ZONE 'Pacific/Auckland')::date, $7::timestamptz)
                ON CONFLICT DO NOTHING`, [scope.tenantId, scope.organisationId, command.operationId, identity.subjectKey,
                command.topic, command.consentVersion, at]);
            inserted = insert.rowCount === 1;
            if (inserted) status = 'requested';
            else {
                // Either this organisation already asked about this topic today,
                // or a concurrent retry of this same operation id committed first.
                found = await existing();
                if (!found.length) status = 'already_requested';
            }
        }
        if (status === null) {
            const row = found[0];
            if (found.length !== 1 || row.organisation_id !== scope.organisationId || row.subject_key !== identity.subjectKey ||
                row.topic !== command.topic || row.consent_version !== command.consentVersion) {
                throw new ContactRequestError('contact_request_operation_conflict', 409);
            }
            status = 'requested';
        }
        if (inserted) await audit.writeEvent(audit.createEvent(context, { ...CONTACT_AUDIT, result: 'succeeded' }));
        return Object.freeze({ schemaVersion: 1, status });
    });
}

module.exports = { CONTACT_TOPICS, CONSENT_VERSIONS, CONTACT_AUDIT, ContactRequestError,
    normaliseContactRequest, resolveContactAccess, writeContactRequest };
