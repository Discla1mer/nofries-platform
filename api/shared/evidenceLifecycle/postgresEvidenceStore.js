'use strict';

// Dormant trusted persistence only. This module authenticates no actor and
// grants no membership, entitlement, object, upload or download authority.
const crypto = require('node:crypto');
const { createTenantAggregate, resolveOrganisation } = require('../appLifecycle/tenantDomain');
const { EVIDENCE_LIMITS, normaliseEvidenceSelector, normaliseEvidenceCommand,
    normaliseEvidenceState, createEvidence, applyEvidenceCommand,
    evidenceCommandFingerprint } = require('./evidenceDomain');

const TABLES = Object.freeze(['dashboard_tenants', 'dashboard_organisations',
    'dashboard_evidence_revisions', 'dashboard_evidence_heads', 'dashboard_evidence_receipts']);
const LIMIT = EVIDENCE_LIMITS.versions;
const FENCE_SQL = `/* evidence:role */
    SELECT r.rolsuper, r.rolbypassrls,
        pg_has_role(current_user, 'nofries_runtime', 'MEMBER') AS runtime_member,
        current_setting('nofries.tenant_id', true) AS tenant_context,
        (SELECT count(*)::integer FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'nofries' AND c.relname = ANY($1::text[])
         AND c.relrowsecurity AND c.relforcerowsecurity
         AND NOT pg_has_role(current_user, c.relowner, 'USAGE')
         AND NOT pg_has_role(current_user, n.nspowner, 'USAGE')) AS safe_tables,
        has_table_privilege(current_user, 'nofries.dashboard_evidence_revisions', 'UPDATE')
        OR has_table_privilege(current_user, 'nofries.dashboard_evidence_revisions', 'DELETE')
        OR has_table_privilege(current_user, 'nofries.dashboard_evidence_receipts', 'UPDATE')
        OR has_table_privilege(current_user, 'nofries.dashboard_evidence_receipts', 'DELETE')
        OR has_any_column_privilege(current_user, 'nofries.dashboard_evidence_revisions', 'UPDATE')
        OR has_any_column_privilege(current_user, 'nofries.dashboard_evidence_receipts', 'UPDATE')
        OR has_table_privilege(current_user, 'nofries.dashboard_evidence_heads', 'DELETE')
        OR has_table_privilege(current_user, 'nofries.dashboard_evidence_revisions', 'TRUNCATE')
        OR has_table_privilege(current_user, 'nofries.dashboard_evidence_receipts', 'TRUNCATE')
        OR has_table_privilege(current_user, 'nofries.dashboard_evidence_heads', 'TRUNCATE') AS mutable_history
    FROM pg_roles r WHERE r.rolname = current_user`;

class EvidenceStoreError extends Error {
    constructor(code = 'evidence_store_invalid', statusCode = 409) {
        super(code); this.name = 'EvidenceStoreError'; this.code = code; this.statusCode = statusCode;
        delete this.stack; Object.freeze(this);
    }
}
function fail(code, status) { throw new EvidenceStoreError(code, status); }
function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value !== null && typeof value === 'object') {
        return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}
function same(a, b) { return canonical(a) === canonical(b); }
function hash(state) { return crypto.createHash('sha256').update('nofries:evidence-state:v1\n')
    .update(canonical(state), 'utf8').digest('hex'); }
function values(scope) { return [scope.tenantId, scope.organisationId, scope.artefactId]; }
function scopeOf(command) { return normaliseEvidenceSelector({ tenantId: command.tenantId,
    organisationId: command.organisationId, artefactId: command.artefactId }); }
function owned(row, scope) { return row.tenant_id === scope.tenantId &&
    row.organisation_id === scope.organisationId && row.artefact_id === scope.artefactId; }
function rows(result) { if (!result || !Array.isArray(result.rows)) fail(); return result.rows; }
function event(command, state, digest) {
    const binding = parts => crypto.createHash('sha256').update(canonical(parts), 'utf8').digest('hex');
    return { type: 'evidence.metadata-recorded', tenantId: state.tenantId,
        organisationId: state.organisationId, artefactId: state.artefactId,
        operationId: command.idempotencyKey, actorSubjectKey: command.actorSubjectKey,
        recordedAt: command.now, revision: state.revision, versionSha256: digest,
        correlationId: binding(['nofries:evidence-correlation:v1', ...values(state)]),
        causationId: binding(['nofries:evidence-causation:v1', ...values(state), command.idempotencyKey]) };
}

async function ownership(tx, scope) {
    const roleRows = rows(await tx.query(FENCE_SQL, [TABLES]));
    const role = roleRows[0];
    if (roleRows.length !== 1 || role.rolsuper !== false || role.rolbypassrls !== false ||
        role.runtime_member !== true || role.tenant_context !== scope.tenantId ||
        role.safe_tables !== TABLES.length || role.mutable_history !== false) {
        fail('evidence_store_role_unsafe', 403);
    }
    // Match dashboard lock ordering. The existing parent exists even when the
    // evidence head does not: this serializes concurrent first creations.
    const tenants = rows(await tx.query(`/* evidence:tenant */ SELECT * FROM nofries.dashboard_tenants
        WHERE tenant_id = $1 FOR UPDATE`, [scope.tenantId]));
    const organisations = rows(await tx.query(`/* evidence:organisation */ SELECT * FROM nofries.dashboard_organisations
        WHERE tenant_id = $1 AND organisation_id = $2 FOR UPDATE`, values(scope).slice(0, 2)));
    if (tenants.length !== 1 || organisations.length !== 1) fail('evidence_store_not_found', 404);
    const tenant = tenants[0], organisation = organisations[0];
    if (tenant.tenant_id !== scope.tenantId || organisation.tenant_id !== scope.tenantId ||
        organisation.organisation_id !== scope.organisationId || tenant.schema_version !== 1 ||
        organisation.schema_version !== 1 || String(tenant.revision) !== String(tenant.payload?.revision) ||
        String(organisation.revision) !== String(organisation.payload?.revision)) fail();
    let aggregate;
    try {
        const input = { schemaVersion: 1, tenant: tenant.payload, organisations: [organisation.payload] };
        resolveOrganisation(input, { tenantId: scope.tenantId, organisationId: scope.organisationId });
        aggregate = createTenantAggregate(input);
    } catch { fail(); }
    if (!same(aggregate.tenant, tenant.payload) || !same(aggregate.organisations[0], organisation.payload) ||
        aggregate.tenant.tenantId !== scope.tenantId ||
        aggregate.organisations[0].organisationId !== scope.organisationId) fail();
    if (aggregate.tenant.recordStatus !== 'active' || aggregate.organisations[0].recordStatus !== 'active') {
        fail('evidence_store_owner_inactive', 403);
    }
    return aggregate;
}

async function history(tx, scope, aggregate) {
    const heads = rows(await tx.query(`/* evidence:head */ SELECT * FROM nofries.dashboard_evidence_heads
        WHERE tenant_id = $1 AND organisation_id = $2 AND artefact_id = $3 FOR UPDATE`, values(scope)));
    // One bounded query per collection; never accept a truncated history.
    const versions = rows(await tx.query(`/* evidence:versions */ SELECT * FROM nofries.dashboard_evidence_revisions
        WHERE tenant_id = $1 AND organisation_id = $2 AND artefact_id = $3
        ORDER BY revision LIMIT ${LIMIT + 1}`, values(scope)));
    const receipts = rows(await tx.query(`/* evidence:receipts */ SELECT * FROM nofries.dashboard_evidence_receipts
        WHERE tenant_id = $1 AND organisation_id = $2 AND artefact_id = $3
        ORDER BY result_revision LIMIT ${LIMIT + 1}`, values(scope)));
    if (heads.length > 1 || versions.length > LIMIT || receipts.length > LIMIT) fail();
    if (!heads.length) {
        if (versions.length || receipts.length) fail(); // orphaned partial restore
        return { states: [], receipts: [], head: null };
    }
    const head = heads[0];
    if (!owned(head, scope) || !versions.length || receipts.length !== versions.length ||
        head.revision !== versions.length - 1) fail();
    const states = [], keys = new Set();
    for (let i = 0; i < versions.length; i += 1) {
        const row = versions[i], receipt = receipts[i];
        if (!owned(row, scope) || row.revision !== i || row.parent_revision !== (i ? i - 1 : null) ||
            row.parent_sha256 !== (i ? versions[i - 1].payload_sha256 : null) ||
            !owned(receipt, scope) || receipt.result_revision !== i ||
            receipt.version_sha256 !== row.payload_sha256 || keys.has(receipt.operation_id)) fail();
        let state, command;
        try { state = normaliseEvidenceState(row.payload); command = normaliseEvidenceCommand(receipt.payload?.command); }
        catch { fail(); }
        if (!same(scopeOf(command), scope) || !same(scopeOf(state), scope) || state.revision !== i ||
            hash(state) !== row.payload_sha256 || command.idempotencyKey !== receipt.operation_id ||
            evidenceCommandFingerprint(command) !== receipt.intent_sha256 ||
            command.action !== (i ? 'append-version' : 'create') ||
            command.expectedRevision !== (i ? i - 1 : null) ||
            !same(receipt.payload, { schemaVersion: 1, command,
                event: event(command, state, row.payload_sha256) })) fail();
        let expected;
        try { expected = i ? applyEvidenceCommand(states[i - 1], aggregate, command) : createEvidence(aggregate, command); }
        catch { fail(); }
        if (!same(expected, state)) fail();
        keys.add(receipt.operation_id); states.push(state);
    }
    if (head.payload_sha256 !== versions.at(-1).payload_sha256) fail();
    return { states, receipts, head };
}

function replay(loaded, command, absentIsAmbiguous) {
    const index = loaded.receipts.findIndex(r => r.operation_id === command.idempotencyKey);
    if (index === -1) {
        if (absentIsAmbiguous) fail('evidence_store_commit_ambiguous');
        return null;
    }
    if (loaded.receipts[index].intent_sha256 !== evidenceCommandFingerprint(command)) {
        fail('evidence_store_intent_conflict');
    }
    return loaded.states[index];
}

function createPostgresEvidenceStore({ database } = {}) {
    if (!database || typeof database.withTenantTransaction !== 'function') fail('evidence_store_configuration_invalid', 500);
    async function reconcileNormalised(command) {
        return database.withTenantTransaction(command.tenantId, async tx => {
            const scope = scopeOf(command), aggregate = await ownership(tx, scope);
            return replay(await history(tx, scope, aggregate), command, true);
        });
    }
    return Object.freeze({
        async read(input) {
            const scope = normaliseEvidenceSelector(input);
            return database.withTenantTransaction(scope.tenantId, async tx => {
                const aggregate = await ownership(tx, scope);
                return (await history(tx, scope, aggregate)).states.at(-1) || null;
            });
        },
        async reconcile(input) { return reconcileNormalised(normaliseEvidenceCommand(input)); },
        async execute(input) {
            const command = normaliseEvidenceCommand(input), scope = scopeOf(command);
            try {
                return await database.withTenantTransaction(scope.tenantId, async tx => {
                    const aggregate = await ownership(tx, scope), loaded = await history(tx, scope, aggregate);
                    const original = replay(loaded, command, false);
                    if (original) return original;
                    const previous = loaded.states.at(-1);
                    if ((command.action === 'create') !== !previous) fail('evidence_store_revision_conflict');
                    const state = previous ? applyEvidenceCommand(previous, aggregate, command) : createEvidence(aggregate, command);
                    const digest = hash(state);
                    await tx.query(`/* evidence:insert-version */ INSERT INTO nofries.dashboard_evidence_revisions
                        (tenant_id, organisation_id, artefact_id, revision, payload_sha256, parent_revision, parent_sha256, payload)
                        VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`, [...values(scope), state.revision, digest,
                        previous?.revision ?? null, loaded.head?.payload_sha256 ?? null, JSON.stringify(state)]);
                    if (previous) {
                        const result = await tx.query(`/* evidence:update-head */ UPDATE nofries.dashboard_evidence_heads
                            SET revision = $4, payload_sha256 = $5 WHERE tenant_id = $1 AND organisation_id = $2
                            AND artefact_id = $3 AND revision = $6 AND payload_sha256 = $7`,
                        [...values(scope), state.revision, digest, previous.revision, loaded.head.payload_sha256]);
                        if (result.rowCount !== 1) fail();
                    } else {
                        await tx.query(`/* evidence:insert-head */ INSERT INTO nofries.dashboard_evidence_heads
                            (tenant_id, organisation_id, artefact_id, revision, payload_sha256) VALUES ($1,$2,$3,$4,$5)`,
                        [...values(scope), state.revision, digest]);
                    }
                    await tx.query(`/* evidence:insert-receipt */ INSERT INTO nofries.dashboard_evidence_receipts
                        (tenant_id, organisation_id, artefact_id, operation_id, intent_sha256, result_revision, version_sha256, payload)
                        VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`, [...values(scope), command.idempotencyKey,
                        evidenceCommandFingerprint(command), state.revision, digest,
                        JSON.stringify({ schemaVersion: 1, command, event: event(command, state, digest) })]);
                    return state;
                });
            } catch (error) {
                if (!['postgres_commit_failed', 'postgres_rollback_failed'].includes(error.code)) throw error;
                // No write or expectation refresh on uncertain commit. A missing
                // receipt remains ambiguous even if the prior callback had failed.
                try { return await reconcileNormalised(command); }
                catch { fail('evidence_store_commit_ambiguous'); }
            }
        }
    });
}
module.exports = Object.freeze({ createPostgresEvidenceStore, EvidenceStoreError });
