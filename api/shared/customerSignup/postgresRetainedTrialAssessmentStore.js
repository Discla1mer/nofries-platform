'use strict';

// Private exact-result mechanics. The explicit production caller supplies the
// paired audit; its only writes are that fixed session/audit, never assessments.
// Scope and callbacks come from trusted composition, never a bearer object.
const { hash, normaliseInstanceRow, normaliseSessionRow, normaliseBindingRow,
    normaliseAdmissionRows } = require('../appLifecycle/dashboardRuntimeRecords');
const { dataStorage } = require('../appLifecycle/postgresDashboardBootstrap');
const assessmentStore = require('../assessmentLifecycle/postgresNcscAssessmentStore');

function createPostgresRetainedTrialAssessmentStore(database) {
    if (typeof database?.withTenantTransaction !== 'function') throw new Error('retained_read_configuration_invalid');
    return Object.freeze({ async read({ capture, account, slot, assessmentId }, inspect, checkTime, audit = null) {
        const own = account.organisations[0];
        return database.withTenantTransaction(own.tenantId, async raw => {
            const tx = Object.freeze({ async query(sql, params) {
                checkTime(); const result = await raw.query(sql, params); checkTime(); return result;
            } });
            async function one(sql, params, optional = false) {
                const result = await tx.query(sql, params);
                if (!Array.isArray(result?.rows) || result.rows.length > 1 || !optional && result.rows.length !== 1)
                    throw new Error('retained_read_record_invalid');
                return result.rows[0] ?? null;
            }
            async function context(selected) {
                await tx.query(`SELECT set_config('nofries.tenant_id',$1,true),set_config('nofries.organisation_id',$2,true),
                    set_config('nofries.subject_key',$3,true),set_config('nofries.identity_sha256',$4,true),
                    set_config('nofries.binding_id',$5,true),set_config('nofries.authority_id',$6,true),
                    set_config('nofries.runtime_instance_id',$7,true),set_config('nofries.session_sha256',$8,true),
                    set_config('nofries.session_kind','customer',true),set_config('nofries.request_id',$9,true)`, [selected.tenantId, selected.organisationId,
                    account.activation.subjectKey, hash(capture.identityPayload), selected.bindingId, selected.authorityId,
                    capture.instanceId, capture.sessionSha256, capture.requestId]);
            }
            await context(own);
            // Reuse the runtime writer's existing shared/exclusive fence keys.
            // SELECT-only admission/instance privileges cannot take row locks.
            // Audited reads may create the purpose's fixed SQL gate. Use the
            // existing exclusive session fence from the start, never upgrade
            // shared locks or race logout / another first read.
            await tx.query(audit ? 'SELECT pg_advisory_xact_lock($1::integer,hashtext($2))' :
                'SELECT pg_advisory_xact_lock_shared($1::integer,hashtext($2))', [71001, capture.sessionSha256]);
            await tx.query('SELECT pg_advisory_xact_lock_shared($1::integer,hashtext($2))', [71002, capture.instanceId]);
            const instance = normaliseInstanceRow(await one('SELECT * FROM nofries.dashboard_runtime_instance WHERE instance_id=$1', [capture.instanceId])).record;
            const gateRow = await one('SELECT * FROM nofries.dashboard_session_gates WHERE session_sha256=$1', [capture.sessionSha256], true);
            const gate = gateRow === null ? null : normaliseSessionRow(gateRow);
            const accountRow = await one(`SELECT account_id,email_sha256,subject_key,account_type,activated_at
                FROM nofries.dashboard_starter_accounts WHERE account_id=$1 FOR SHARE`, [account.accountId]);
            async function scope(selected) {
                await context(selected);
                const params = [selected.tenantId, selected.organisationId];
                const retained = await one(`SELECT preparation,activation FROM nofries.dashboard_starter_scopes
                    WHERE tenant_id=$1 AND organisation_id=$2 AND account_id=$3 AND subject_key=$4`,
                [...params, account.accountId, account.activation.subjectKey]);
                // Committed preparations/activations are immutable. Row-locking
                // SELECT would invoke activation-only UPDATE RLS and hide them.
                await tx.query('SELECT pg_advisory_xact_lock_shared($1::integer,hashtext($2))', [71003, selected.authorityId]);
                const binding = normaliseBindingRow(await one(`SELECT * FROM nofries.dashboard_identity_bindings
                    WHERE binding_id=$1 AND tenant_id=$2 AND organisation_id=$3 FOR SHARE`, [selected.bindingId, ...params]));
                const head = await one(`SELECT * FROM nofries.dashboard_admission_authorities
                    WHERE authority_id=$1 AND tenant_id=$2 AND organisation_id=$3`, [selected.authorityId, ...params]);
                const decision = await one(`SELECT * FROM nofries.dashboard_admission_decisions
                    WHERE authority_id=$1 AND revision=$2 AND tenant_id=$3 AND organisation_id=$4`,
                [selected.authorityId, head.head_revision, ...params]);
                const admission = normaliseAdmissionRows({ head, decision });
                // Hold every current revocation/disablement input until COMMIT,
                // including both owned scopes for a consultant client. No second
                // connection or arbitrary cross-tenant callback is borrowed.
                await one('SELECT tenant_id FROM nofries.dashboard_tenants WHERE tenant_id=$1 FOR SHARE', [selected.tenantId]);
                for (const table of ['dashboard_organisations', 'dashboard_membership_states', 'dashboard_entitlement_states', 'dashboard_feature_flags']) {
                    await one(`SELECT tenant_id FROM nofries.${table} WHERE tenant_id=$1 AND organisation_id=$2 FOR SHARE`, params);
                }
                const snapshot = await dataStorage.loadSnapshotForShare(tx, { tenantId: selected.tenantId, organisationId: selected.organisationId });
                return { retained, binding, admission, snapshot };
            }
            const original = await scope(own), selected = slot.bindingId === own.bindingId ? original : await scope(slot);
            const facts = { instance, gate, accountRow, original, selected };
            await inspect(facts, null, false);
            const scopeInput = { tenantId: slot.tenantId, organisationId: slot.organisationId, assessmentId };
            await one(`SELECT assessment_id FROM nofries.dashboard_ncsc_assessments
                WHERE tenant_id=$1 AND organisation_id=$2 AND assessment_id=$3 FOR SHARE`,
            [slot.tenantId, slot.organisationId, assessmentId], true);
            const head = await assessmentStore.readHead(tx, scopeInput);
            const history = await assessmentStore.readHistory(tx, scopeInput, head, [], selected.snapshot.tenantAggregate);
            const result = await inspect(facts, head ? history.get(head.revision) : null, true);
            if (audit) await audit.persist(tx, gate, checkTime);
            return result;
        });
    } });
}

module.exports = { createPostgresRetainedTrialAssessmentStore };
