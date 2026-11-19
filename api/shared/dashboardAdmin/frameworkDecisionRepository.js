'use strict';

const { dataStorage } = require('../appLifecycle/postgresDashboardBootstrap');
const { currentProductGrant } = require('../appLifecycle/entitlementDomain');
const { table, latestDecisions, sameTuple, tuples } = require('../appLifecycle/paidFrameworkDecisions');
const { equal, hash } = require('../appLifecycle/dashboardRuntimeRecords');
const { DashboardAdminError } = require('./service');
const refuse = () => { throw new DashboardAdminError(409, 'dashboard_admin_conflict'); };

// The guarded repository holds the native operator-session fences for this entire
// transaction, and rechecks staff authority immediately before INSERT and COMMIT.
async function frameworkDecision(tx, command, approved, clock) {
    const { selector, tuple, actorSubjectKey, operationId, reason, action } = command;
    if (!tuples.some(row => sameTuple(row, tuple))) refuse();
    const scope = { tenantId: selector.tenantId, organisationId: selector.organisationId };
    const snapshot = await dataStorage.loadSnapshotForUpdate(tx, scope);
    const product = currentProductGrant(snapshot.entitlementState.grants, clock());
    if (!product || !product.modules.includes(tuple.moduleId) || snapshot.tenantAggregate.tenant.recordStatus !== 'active' ||
        snapshot.tenantAggregate.organisations[0].recordStatus !== 'active' ||
        !snapshot.membershipState.memberships.some(row => row.subjectKey === selector.subjectKey && row.status === 'active') ||
        snapshot.membershipState.revision !== command.expectedMembershipRevision) refuse();
    await tx.query("SELECT set_config('nofries.organisation_id',$1,true),set_config('nofries.subject_key',$2,true)",
        [scope.organisationId, actorSubjectKey]);
    const previous = (await latestDecisions(tx, scope, product.grantId)).find(row => sameTuple(row, tuple));
    const granted = previous ? previous.granted : product.frameworks.some(row => sameTuple(row, tuple));
    const frameworkEnabled = snapshot.flags.frameworks.some(row => sameTuple(row, tuple));
    const witness = { productGrantId: product.grantId, agreementRef: product.agreementRef,
        entitlementRevision: snapshot.entitlementState.revision, flagRevision: snapshot.flags.revision,
        revision: previous?.revision ?? 0, frameworkEnabled, granted };
    if ((action === 'grant' ? granted && frameworkEnabled : !granted) || approved && !equal(approved, witness)) refuse();
    if (!approved) return witness;
    const capability = await tx.query("SELECT pg_has_role(session_user,'nofries_framework_operator','SET') AND NOT pg_has_role(session_user,'nofries_framework_operator','USAGE') AS available");
    if (capability.rows[0]?.available !== true) throw new DashboardAdminError(503, 'dashboard_admin_unavailable');
    // Apply only the selected profile switch. Its independent withdrawal still
    // blocks a retained grant. Dashboard and module settings are never enabled here.
    if (action === 'grant' && !frameworkEnabled) {
        const revision = snapshot.flags.revision + 1;
        if (!Number.isSafeInteger(revision)) refuse();
        await dataStorage.updateFlags(tx, { ...snapshot.flags, revision, frameworks: [...snapshot.flags.frameworks, tuple] });
    }
    await tx.query('SET LOCAL ROLE nofries_framework_operator');
    await tx.query(`INSERT INTO ${table}
        (tenant_id,organisation_id,product_grant_id,module_id,profile_id,version,revision,granted,operation_id,operator_subject,reason_sha256)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [scope.tenantId, scope.organisationId, product.grantId,
        tuple.moduleId, tuple.profileId, tuple.version, witness.revision + 1, action === 'grant', operationId, actorSubjectKey, hash(reason)]);
    return { revision: witness.revision + 1, granted: action === 'grant' };
}
module.exports = { frameworkDecision };
