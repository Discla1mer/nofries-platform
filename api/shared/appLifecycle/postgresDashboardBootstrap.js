'use strict';

const { createHash } = require('node:crypto');
const { resolveOrganisation } = require('./tenantDomain');
const { normaliseMembershipState } = require('./membershipDomain');
const { normaliseEntitlementState, resolveEntitlements, TIERS } = require('./entitlementDomain');
const { normaliseAdvisorAssignment } = require('./portalPermissions');

// Private shared DATA mechanics. This module does not own a pool, transaction,
// runtime registration or authorization policy. Typed callers supply the active tx.
const LIMIT_PERMISSIONS = Object.freeze({ assessment_runs: 'assessment.write', report_exports: 'report.read_issued',
    evidence_bytes: 'evidence.link', memberships: 'membership.manage' });
const AI_PERMISSIONS = Object.freeze({ cyber_security: 'assessment.write', ai_governance: 'assessment.write',
    it_optimisation: 'assessment.write', evidence: 'evidence.link', board_reports: 'report.draft', improvement_plan: 'improvement.write' });
const LIMIT_MODULES = Object.freeze({ assessment_runs: ['cyber_security', 'ai_governance', 'it_optimisation'],
    report_exports: ['board_reports'], evidence_bytes: ['evidence'], memberships: ['overview'], ai_requests: Object.keys(AI_PERMISSIONS) });
const TABLES = Object.freeze({ tenant: 'dashboard_tenants', organisation: 'dashboard_organisations',
    membershipState: 'dashboard_membership_states', entitlementState: 'dashboard_entitlement_states',
    flags: 'dashboard_feature_flags', advisor: 'dashboard_advisor_assignments', usage: 'dashboard_usage' });
const TYPES = Object.freeze(['organisation.initialise', 'tenant.transition', 'organisation.transition',
    'membership.command', 'entitlement.update', 'flags.update', 'advisor.put', 'usage.reserve']);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

class DashboardPersistenceError extends Error {
    constructor(code, statusCode = 400) {
        super(`Dashboard persistence refused: ${code}`);
        this.name = 'DashboardPersistenceError'; this.code = `dashboard_${code}`; this.statusCode = statusCode;
    }
}
const fail = (code, status) => { throw new DashboardPersistenceError(code, status); };

function administer(authoriseAdministration, command, snapshot) {
    let result;
    try { result = authoriseAdministration(command, freeze(detach(snapshot))); } catch { fail('administration_denied', 403); }
    // Promise/thenable results are denied; consume a genuine rejected Promise to
    // avoid an unhandled rejection from a mistakenly asynchronous host adapter.
    if (result instanceof Promise) result.catch(() => {});
    if (result !== true) fail('administration_denied', 403);
}

async function load(tx, scope, lock) {
    const tenants = await tx.query(`SELECT * FROM nofries.dashboard_tenants WHERE tenant_id = $1 FOR ${lock}`, [scope.tenantId]);
    if (tenants.rows.length !== 1) fail('not_found', 404);
    return loadAfterTenant(tx, scope, tenants.rows[0]);
}

async function loadAfterTenant(tx, scope, tenantRow) {
    scope = normaliseScope(scope, false);
    const tenant = readRow('tenant', tenantRow, scope);
    const organisationRow = await selectOne(tx, 'organisation', scope);
    if (!organisationRow) fail('not_found', 404);
    const organisation = readRow('organisation', organisationRow, scope);
    const tenantAggregate = { schemaVersion: 1, tenant, organisations: [organisation] };
    resolveOrganisation(tenantAggregate, scope);
    const membershipState = normaliseMembershipState(readRow('membershipState', await required(tx, 'membershipState', scope), scope));
    const entitlementState = normaliseEntitlementState(readRow('entitlementState', await required(tx, 'entitlementState', scope), scope), tenantAggregate);
    const flags = readRow('flags', await required(tx, 'flags', scope), scope);
    // Validate explicit flags without manufacturing defaults or requiring live access.
    resolveEntitlements(entitlementState, tenantAggregate, scope, '2000-01-01T00:00:00.000Z', flags);
    const advisorRows = await tx.query('SELECT * FROM nofries.dashboard_advisor_assignments WHERE tenant_id = $1 AND organisation_id = $2 ORDER BY assignment_id', values(scope));
    const advisorAssignments = advisorRows.rows.map(row => normaliseAdvisorAssignment(readRow('advisor', row, scope)));
    const usageRows = await tx.query('SELECT * FROM nofries.dashboard_usage WHERE tenant_id = $1 AND organisation_id = $2 ORDER BY grant_id', values(scope));
    const usage = usageRows.rows.map(row => validateUsage(readRow('usage', row, scope), entitlementState));
    const products = entitlementState.grants.filter(grant => own(TIERS, grant.code));
    if (usage.length !== products.length || products.some(grant => !usage.some(item => item.grantId === grant.grantId))) fail('usage_missing', 409);
    for (const assignment of advisorAssignments) {
        if (!membershipState.memberships.some(member => member.membershipId === assignment.membershipId &&
            member.subjectKey === assignment.subjectKey)) fail('assignment_owner_invalid', 409);
    }
    return freeze({ tenantAggregate, membershipState, entitlementState, flags, advisorAssignments, usage });
}

async function receipt(tx, command, digest, snapshot, initial = null) {
    const rows = await tx.query('SELECT * FROM nofries.dashboard_operation_receipts WHERE tenant_id = $1 AND organisation_id = $2 AND operation_id = $3',
        [...values(command), command.operationId]);
    if (!rows.rows.length) return null;
    if (rows.rows.length !== 1) fail('receipt_invalid', 409);
    const row = rows.rows[0], value = fields(detach(row.payload), ['schemaVersion', 'tenantId', 'organisationId', 'operationId',
        'actorSubjectKey', 'operationType', 'intentSha256', 'resultSha256', 'occurredAt', 'expectedRevisions', 'resultRevisions', 'result', 'event']);
    if (row.schema_version !== 1 || value.schemaVersion !== 1 || value.tenantId !== command.tenantId ||
        value.organisationId !== command.organisationId || value.operationId !== command.operationId ||
        row.tenant_id !== value.tenantId || row.organisation_id !== value.organisationId || row.operation_id !== value.operationId ||
        row.intent_sha256 !== value.intentSha256 || row.result_sha256 !== value.resultSha256 ||
        hash(value.result) !== value.resultSha256) fail('receipt_invalid', 409);
    if (value.intentSha256 !== digest || value.actorSubjectKey !== command.actorSubjectKey || value.operationType !== command.type) fail('operation_conflict', 409);
    instant(value.occurredAt); revisions(value.expectedRevisions); revisions(value.resultRevisions);
    const result = fields(value.result, ['operationId', 'type', 'reserved', 'resultRevisions', 'usage']);
    if (result.operationId !== command.operationId || result.type !== command.type ||
        result.reserved !== (command.type === 'usage.reserve')) fail('receipt_invalid', 409);
    if (result.reserved) {
        const usage = validateUsage(result.usage, snapshot.entitlementState);
        equalScope(usage, command); integer(usage.revision);
        const previous = command.expectedRevisions.usage.find(item => item.grantId === command.payload.grantId);
        if (usage.grantId !== command.payload.grantId || !previous || usage.revision !== previous.revision + 1 ||
            !own(usage.counters, command.payload.limit) ||
            usage.counters[command.payload.limit] < command.payload.amount) fail('receipt_invalid', 409);
    } else if (result.usage !== null) fail('receipt_invalid', 409);
    if (hash(value.expectedRevisions) !== hash(command.expectedRevisions) ||
        hash(value.resultRevisions) !== hash(value.result.resultRevisions) ||
        hash(result.resultRevisions) !== hash(expectedResultRevisions(command, initial))) fail('receipt_invalid', 409);
    assertReceiptIncluded(snapshot, result);
    const event = fields(value.event, ['schemaVersion', 'category', 'outcome', 'action', 'actorSubjectKey',
        'tenantId', 'organisationId', 'operationId', 'effect']);
    if (event.schemaVersion !== 1 || event.category !== 'dashboard_transaction' || event.outcome !== 'committed' ||
        event.action !== command.type || event.actorSubjectKey !== command.actorSubjectKey ||
        event.tenantId !== command.tenantId || event.organisationId !== command.organisationId ||
        event.operationId !== command.operationId || event.effect !== (command.type === 'usage.reserve' ? 'quota_reserved' : 'authority_changed')) fail('receipt_invalid', 409);
    return freeze(value.result);
}

async function saveReceipt(tx, command, digest, snapshot, at, usage = null) {
    const result = makeResult(command, revisionVector(snapshot), usage);
    const resultRevisions = result.resultRevisions;
    const resultSha256 = hash(result);
    const event = { schemaVersion: 1, category: 'dashboard_transaction', outcome: 'committed',
        action: command.type, actorSubjectKey: command.actorSubjectKey, tenantId: command.tenantId,
        organisationId: command.organisationId, operationId: command.operationId,
        effect: command.type === 'usage.reserve' ? 'quota_reserved' : 'authority_changed' };
    const payload = { schemaVersion: 1, tenantId: command.tenantId, organisationId: command.organisationId,
        operationId: command.operationId, actorSubjectKey: command.actorSubjectKey, operationType: command.type,
        intentSha256: digest, resultSha256, occurredAt: at, expectedRevisions: command.expectedRevisions,
        resultRevisions, result, event };
    await tx.query('INSERT INTO nofries.dashboard_operation_receipts (tenant_id, organisation_id, operation_id, schema_version, intent_sha256, result_sha256, payload) VALUES ($1, $2, $3, 1, $4, $5, $6::jsonb)',
        [...values(command), command.operationId, digest, resultSha256, JSON.stringify(payload)]);
    return result;
}

function makeResult(command, resultRevisions, usage = null) {
    return freeze({ operationId: command.operationId, type: command.type,
        reserved: command.type === 'usage.reserve', resultRevisions, usage });
}
function initialisationReference(command, digest, result) {
    return freeze({ schemaVersion: 1, operationType: 'organisation.initialise',
        tenantId: command.tenantId, organisationId: command.organisationId,
        operationId: command.operationId, intentSha256: digest, resultSha256: hash(result) });
}

function createBootstrapOperations(options) {
    const { clock, authoriseAdministration } = fields(options, ['clock', 'authoriseAdministration']);
    if (typeof clock !== 'function' || typeof authoriseAdministration !== 'function') fail('dependencies_invalid');
    const preparations = new WeakMap();
    function now() { return instant(clock()); }
    function prepareInitialisation(commandInput, initialInput) {
        const command = normaliseCommand(commandInput, 'organisation.initialise');
        fields(command.payload, []);
        const initialState = validateInitial(detach(initialInput), command);
        const digest = hash({ command, initialState });
        // This reference predicts bytes only. The receipt timestamp is sampled
        // at the original write point; preparation never proves a commit.
        const expectedReference = initialisationReference(command, digest,
            makeResult(command, expectedResultRevisions(command, initialState)));
        const prepared = freeze({ tenantId: command.tenantId, expectedReference });
        preparations.set(prepared, { command, initialState, digest, expectedReference });
        return prepared;
    }
    async function execute(tx, prepared, reconcile) {
        const captured = preparations.get(prepared);
        if (!captured) fail('preparation_invalid');
        const { command, initialState, digest, expectedReference } = captured;
        const result = await initialise(tx, command, initialState, digest, reconcile);
        // Read-back validation or the successful insert supplies the actual
        // result. Never return the preparation's expected reference as evidence.
        const reference = initialisationReference(command, digest, result);
        if (hash(reference) !== hash(expectedReference)) fail('receipt_invalid', 409);
        return freeze({ result, reference });
    }

    async function initialise(tx, command, initial, digest, reconcile) {
        let rows = await tx.query('SELECT * FROM nofries.dashboard_tenants WHERE tenant_id = $1 FOR UPDATE', [command.tenantId]);
        let created = false;
        if (!rows.rows.length) {
            if (reconcile) fail('commit_ambiguous', 503);
            const inserted = await tx.query('INSERT INTO nofries.dashboard_tenants (tenant_id, schema_version, revision, payload) VALUES ($1, 1, $2, $3::jsonb) ON CONFLICT (tenant_id) DO NOTHING RETURNING tenant_id',
                [command.tenantId, initial.tenantAggregate.tenant.revision, JSON.stringify(initial.tenantAggregate.tenant)]);
            created = inserted.rows.length === 1;
            rows = await tx.query('SELECT * FROM nofries.dashboard_tenants WHERE tenant_id = $1 FOR UPDATE', [command.tenantId]);
        }
        if (rows.rows.length !== 1) fail('not_found', 404);
        const tenant = readRow('tenant', rows.rows[0], command);
        const existingOrg = await selectOne(tx, 'organisation', command);
        if (existingOrg) {
            const snapshot = await loadAfterTenant(tx, command, rows.rows[0]);
            administer(authoriseAdministration, command, snapshot);
            const original = await receipt(tx, command, digest, snapshot, initial);
            if (original) return original;
            fail(reconcile ? 'commit_ambiguous' : 'already_exists', reconcile ? 503 : 409);
        }
        // An existing canonical tenant does not prove that this organisation's
        // bootstrap committed. Recovery only reads evidence; it never creates it.
        if (reconcile) fail('commit_ambiguous', 503);
        administer(authoriseAdministration, command, { tenant: created ? null : tenant, organisation: null, proposed: initial });
        const expected = { tenant: created ? null : tenant.revision, organisation: null, membership: null,
            entitlement: null, flags: null, advisorAssignments: [], usage: [] };
        if (hash(expected) !== hash(command.expectedRevisions) || hash(tenant) !== hash(initial.tenantAggregate.tenant)) fail('revision_conflict', 409);
        const snapshot = { ...initial, usage: initial.entitlementState.grants.filter(grant => own(TIERS, grant.code)).map(grant => newUsage(grant)) };
        await put(tx, 'organisation', initial.tenantAggregate.organisations[0], true);
        for (const key of ['membershipState', 'entitlementState', 'flags']) await put(tx, key, snapshot[key], true);
        for (const assignment of snapshot.advisorAssignments) await put(tx, 'advisor', assignment, true);
        for (const usage of snapshot.usage) await put(tx, 'usage', usage, true);
        return saveReceipt(tx, command, digest, snapshot, now());
    }

    return Object.freeze({
        prepareInitialisation,
        executeInTransaction(tx, prepared) { return execute(tx, prepared, false); },
        reconcileInTransaction(tx, prepared) { return execute(tx, prepared, true); }
    });
}

function validateInitial(input, scope) {
    const initial = fields(input, ['tenantAggregate', 'membershipState', 'entitlementState', 'flags', 'advisorAssignments']);
    resolveOrganisation(initial.tenantAggregate, normaliseScope(scope, false));
    if (initial.tenantAggregate.organisations.length !== 1) fail('initial_scope_invalid');
    const membershipState = normaliseMembershipState(initial.membershipState); equalScope(membershipState, scope);
    const entitlementState = normaliseEntitlementState(initial.entitlementState, initial.tenantAggregate); equalScope(entitlementState, scope);
    if (!initial.flags) fail('flags_missing');
    resolveEntitlements(entitlementState, initial.tenantAggregate, normaliseScope(scope, false), '2000-01-01T00:00:00.000Z', initial.flags);
    if (!Array.isArray(initial.advisorAssignments)) fail('shape_invalid');
    const assignments = initial.advisorAssignments.map(normaliseAdvisorAssignment);
    if (new Set(assignments.map(item => item.assignmentId)).size !== assignments.length) fail('assignment_ambiguous');
    for (const assignment of assignments) {
        equalScope(assignment, scope);
        if (!membershipState.memberships.some(member => member.membershipId === assignment.membershipId && member.subjectKey === assignment.subjectKey)) fail('assignment_owner_invalid');
    }
    return freeze({ ...initial, membershipState, entitlementState, advisorAssignments: assignments });
}
function validateUsage(input, entitlement) {
    const usage = fields(input, ['schemaVersion', 'tenantId', 'organisationId', 'grantId', 'revision', 'counters']);
    if (usage.schemaVersion !== 1) fail('stored_record_invalid', 409);
    const grant = entitlement.grants.find(item => item.grantId === usage.grantId && own(TIERS, item.code));
    if (!grant) fail('stored_record_invalid', 409);
    const counters = fields(usage.counters, Object.keys(LIMIT_MODULES), false);
    for (const [key, value] of Object.entries(counters)) {
        integer(value);
        if (!own(grant.limits, key) || grant.limits[key] !== null && value > grant.limits[key]) fail('stored_record_invalid', 409);
    }
    return freeze(usage);
}
function newUsage(grant) {
    return { schemaVersion: 1, tenantId: grant.tenantId, organisationId: grant.organisationId,
        grantId: grant.grantId, revision: 0, counters: Object.fromEntries(Object.keys(grant.limits).map(key => [key, 0])) };
}
function revisionVector(snapshot) {
    const sort = (a, b) => a < b ? -1 : a > b ? 1 : 0;
    return freeze({ tenant: snapshot.tenantAggregate.tenant.revision, organisation: snapshot.tenantAggregate.organisations[0].revision,
        membership: snapshot.membershipState.revision, entitlement: snapshot.entitlementState.revision, flags: snapshot.flags.revision,
        advisorAssignments: snapshot.advisorAssignments.map(item => ({ assignmentId: item.assignmentId, revision: item.revision })).sort((a, b) => sort(a.assignmentId, b.assignmentId)),
        usage: snapshot.usage.map(item => ({ grantId: item.grantId, revision: item.revision })).sort((a, b) => sort(a.grantId, b.grantId)) });
}
function expectedResultRevisions(command, initial) {
    if (command.type === 'organisation.initialise') {
        return revisionVector({ ...initial, usage: initial.entitlementState.grants.filter(grant => own(TIERS, grant.code)).map(newUsage) });
    }
    const expected = detach(command.expectedRevisions);
    const scalar = { 'tenant.transition': 'tenant', 'organisation.transition': 'organisation',
        'membership.command': 'membership', 'entitlement.update': 'entitlement', 'flags.update': 'flags' }[command.type];
    if (scalar) expected[scalar]++;
    if (command.type === 'usage.reserve') {
        expected.usage = expected.usage.map(item => item.grantId === command.payload.grantId ? { ...item, revision: item.revision + 1 } : item);
    } else if (command.type === 'advisor.put') {
        const assignmentId = command.payload.assignmentId;
        const old = expected.advisorAssignments.find(item => item.assignmentId === assignmentId);
        expected.advisorAssignments = [...expected.advisorAssignments.filter(item => item.assignmentId !== assignmentId),
            { assignmentId, revision: old ? old.revision + 1 : 0 }];
        expected.advisorAssignments.sort((a, b) => a.assignmentId < b.assignmentId ? -1 : a.assignmentId > b.assignmentId ? 1 : 0);
    } else if (command.type === 'entitlement.update') {
        for (const grant of command.payload.grants) {
            if (own(TIERS, grant.code) && !expected.usage.some(item => item.grantId === grant.grantId)) expected.usage.push({ grantId: grant.grantId, revision: 0 });
        }
        expected.usage.sort((a, b) => a.grantId < b.grantId ? -1 : a.grantId > b.grantId ? 1 : 0);
    }
    return expected;
}
function assertReceiptIncluded(snapshot, result) {
    // A receipt restored from a later backup point cannot prove a mutation is
    // present. Monotonic live state must include its result; later writes and
    // newly retained records are valid and do not change the original reply.
    const current = revisionVector(snapshot), committed = result.resultRevisions;
    for (const key of ['tenant', 'organisation', 'membership', 'entitlement', 'flags']) {
        if (committed[key] === null || current[key] < committed[key]) fail('receipt_invalid', 409);
    }
    for (const [key, id] of [['advisorAssignments', 'assignmentId'], ['usage', 'grantId']]) {
        const present = new Map(current[key].map(item => [item[id], item.revision]));
        for (const item of committed[key]) {
            if (!present.has(item[id]) || present.get(item[id]) < item.revision) fail('receipt_invalid', 409);
        }
    }
    if (result.reserved) {
        const usage = snapshot.usage.find(item => item.grantId === result.usage.grantId);
        if (!usage || Object.entries(result.usage.counters).some(([key, amount]) =>
            !own(usage.counters, key) || usage.counters[key] < amount)) fail('receipt_invalid', 409);
    }
}
function normaliseCommand(input, expectedType) {
    const command = fields(detach(input), ['tenantId', 'organisationId', 'operationId', 'actorSubjectKey', 'type', 'expectedRevisions', 'payload']);
    normaliseScope(command, false); identifier(command.operationId); subject(command.actorSubjectKey);
    if (!TYPES.includes(command.type) || (expectedType && command.type !== expectedType)) fail('command_invalid');
    revisions(command.expectedRevisions);
    if (!command.payload || Array.isArray(command.payload) || typeof command.payload !== 'object') fail('command_invalid');
    return freeze(command);
}
function revisions(input) {
    const vector = fields(input, ['tenant', 'organisation', 'membership', 'entitlement', 'flags', 'advisorAssignments', 'usage']);
    for (const key of ['tenant', 'organisation', 'membership', 'entitlement', 'flags']) if (vector[key] !== null) integer(vector[key]);
    for (const [key, id] of [['advisorAssignments', 'assignmentId'], ['usage', 'grantId']]) {
        if (!Array.isArray(vector[key])) fail('revision_invalid');
        let previous = null;
        for (const item of vector[key]) {
            fields(item, [id, 'revision']); identifier(item[id]); integer(item.revision);
            if (previous !== null && item[id] <= previous) fail('revision_invalid');
            previous = item[id];
        }
    }
    return vector;
}
function assertNext(proposed, old, scope) {
    equalScope(proposed, scope); integer(proposed.revision);
    if (!Number.isSafeInteger(old.revision + 1) || proposed.revision !== old.revision + 1) fail('revision_conflict', 409);
}
async function selectOne(tx, key, scope) {
    const rows = await tx.query(`SELECT * FROM nofries.${TABLES[key]} WHERE tenant_id = $1 AND organisation_id = $2`, values(scope));
    if (rows.rows.length > 1) fail('stored_record_invalid', 409);
    return rows.rows[0] || null;
}
async function required(tx, key, scope) { const row = await selectOne(tx, key, scope); if (!row) fail('not_found', 404); return row; }
function readRow(key, row, scope) {
    if (!row || row.schema_version !== 1) fail('stored_record_invalid', 409);
    const value = detach(row.payload);
    if (!value || value.tenantId !== scope.tenantId || row.tenant_id !== scope.tenantId ||
        (key !== 'tenant' && (value.organisationId !== scope.organisationId || row.organisation_id !== scope.organisationId)) ||
        (key !== 'flags' && value.schemaVersion !== 1) || String(integer(value.revision)) !== String(row.revision)) fail('stored_record_invalid', 409);
    if (key === 'advisor' && (row.assignment_id !== value.assignmentId || row.subject_key !== value.subjectKey ||
        row.membership_id !== value.membershipId || row.status !== value.status)) fail('stored_record_invalid', 409);
    if (key === 'usage' && row.grant_id !== value.grantId) fail('stored_record_invalid', 409);
    return value;
}
async function put(tx, key, payload, insert) {
    const columns = ['tenant_id'], args = [payload.tenantId];
    if (key !== 'tenant') { columns.push('organisation_id'); args.push(payload.organisationId); }
    if (key === 'advisor') { columns.push('assignment_id'); args.push(payload.assignmentId); }
    if (key === 'usage') { columns.push('grant_id'); args.push(payload.grantId); }
    const where = columns.map((column, index) => `${column} = $${index + 1}`).join(' AND ');
    const setters = [];
    for (const [column, value] of [['schema_version', 1], ['revision', payload.revision], ['payload', JSON.stringify(payload)],
        ...(key === 'advisor' ? [['subject_key', payload.subjectKey], ['membership_id', payload.membershipId], ['status', payload.status]] : [])]) {
        columns.push(column); args.push(value); setters.push(`${column} = $${args.length}${column === 'payload' ? '::jsonb' : ''}`);
    }
    const result = await tx.query(insert
        ? `INSERT INTO nofries.${TABLES[key]} (${columns.join(', ')}) VALUES (${columns.map((column, index) => `$${index + 1}${column === 'payload' ? '::jsonb' : ''}`).join(', ')})`
        : `UPDATE nofries.${TABLES[key]} SET ${setters.join(', ')} WHERE ${where}`, args);
    if (result.rowCount !== 1) fail('write_conflict', 409);
}
function values(scope) { return [scope.tenantId, scope.organisationId]; }
function normaliseScope(input, exact = true) {
    if (exact) fields(input, ['tenantId', 'organisationId']);
    return { tenantId: identifier(input.tenantId), organisationId: identifier(input.organisationId) };
}
function equalScope(a, b) { if (a.tenantId !== b.tenantId || a.organisationId !== b.organisationId) fail('scope_invalid', 409); }
function identifier(value) {
    if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 180 || /[\u0000-\u001f\u007f*]/.test(value)) fail('identifier_invalid');
    return value;
}
function subject(value) {
    if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) fail('subject_invalid');
    return value;
}
function integer(value) { if (!Number.isSafeInteger(value) || value < 0) fail('revision_invalid'); return value; }
function instant(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
        !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail('clock_invalid');
    return value;
}
function fields(value, allowed, required = true) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('shape_invalid');
    const keys = Reflect.ownKeys(value), descriptors = Object.getOwnPropertyDescriptors(value);
    if (keys.some(key => typeof key !== 'string' || !allowed.includes(key) || !own(descriptors[key], 'value')) ||
        (required && allowed.some(key => !own(descriptors, key)))) fail('shape_invalid');
    return Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
}
// Reject accessors, prototypes, sparse arrays, cycles and non-JSON values before
// any asynchronous boundary; never invoke a caller-controlled toJSON/getter.
function detach(value, ancestors = new Set()) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (!value || typeof value !== 'object' || ancestors.has(value)) fail('shape_invalid');
    ancestors.add(value);
    let result;
    if (Array.isArray(value)) {
        if (Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) fail('shape_invalid');
        result = Array.from({ length: value.length }, (_, index) => {
            const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
            if (!descriptor || !own(descriptor, 'value')) fail('shape_invalid');
            return detach(descriptor.value, ancestors);
        });
    } else {
        const input = fields(value, Reflect.ownKeys(value));
        result = Object.fromEntries(Object.keys(input).map(key => [key, detach(input[key], ancestors)]));
    }
    ancestors.delete(value); return result;
}
function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
}
function hash(value) { return createHash('sha256').update(canonical(value)).digest('hex'); }
function freeze(value) { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }

const dataStorage = Object.freeze({
    loadSnapshotForShare(tx, scope) { return load(tx, scope, 'SHARE'); },
    loadSnapshotForUpdate(tx, scope) { return load(tx, scope, 'UPDATE'); },
    updateTenant(tx, row) { return put(tx, 'tenant', row, false); },
    updateOrganisation(tx, row) { return put(tx, 'organisation', row, false); },
    updateMembershipState(tx, row) { return put(tx, 'membershipState', row, false); },
    updateEntitlementState(tx, row) { return put(tx, 'entitlementState', row, false); },
    updateFlags(tx, row) { return put(tx, 'flags', row, false); },
    insertAdvisorAssignment(tx, row) { return put(tx, 'advisor', row, true); },
    updateAdvisorAssignment(tx, row) { return put(tx, 'advisor', row, false); },
    insertUsage(tx, row) { return put(tx, 'usage', row, true); },
    updateUsage(tx, row) { return put(tx, 'usage', row, false); },
    readOperationReceipt: receipt,
    saveOperationReceipt: saveReceipt
});
const dataCodec = Object.freeze({ LIMIT_PERMISSIONS, AI_PERMISSIONS, LIMIT_MODULES,
    fail, own, fields, detach, freeze, hash, normaliseScope, subject, identifier,
    integer, instant, normaliseCommand, revisionVector, assertNext, equalScope,
    newUsage, validateUsage, assertReceiptIncluded, administer });

module.exports = { DashboardPersistenceError, createBootstrapOperations, dataStorage, dataCodec };
