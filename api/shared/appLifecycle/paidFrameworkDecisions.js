'use strict';

const { currentProductGrant } = require('./entitlementDomain');
const { freeze } = require('./dashboardRuntimeRecords');

const tuples = freeze([
    { moduleId: 'cyber_security', profileId: 'nf-nist-csf-2-0-core', version: '2026-09-08.1' },
    { moduleId: 'cyber_security', profileId: 'nf-iso-27001-2022-readiness', version: '2026-11-19.1' }
]);
const sameTuple = (a, b) => a.moduleId === b.moduleId && a.profileId === b.profileId && a.version === b.version;
const table = 'nofries.dashboard_paid_framework_access';

async function latestDecisions(tx, scope, grantId) {
    const result = await tx.query(`SELECT DISTINCT ON (module_id, profile_id, version)
        module_id AS "moduleId", profile_id AS "profileId", version, revision, granted
        FROM ${table} WHERE tenant_id=$1 AND organisation_id=$2 AND product_grant_id=$3
        ORDER BY module_id, profile_id, version, revision DESC`, [scope.tenantId, scope.organisationId, grantId]);
    return result.rows;
}

// Only paid operations and the Cyber Security picker use this request-local view.
// A decision is pinned to the active product. Never give its tuple to a successor.
async function paidSnapshot(tx, scope, snapshot, at) {
    const product = currentProductGrant(snapshot.entitlementState.grants, at);
    if (!product || !product.modules.includes('cyber_security')) return snapshot;
    const rows = await latestDecisions(tx, scope, product.grantId);
    if (!rows.length) return snapshot;
    const frameworks = [...product.frameworks];
    let activation = snapshot.flags.frameworks;
    for (const row of rows) {
        const tuple = tuples.find(item => sameTuple(item, row));
        if (!tuple) throw new Error('paid_framework_decision_invalid');
        if (row.granted) {
            if (!frameworks.some(item => sameTuple(item, tuple))) frameworks.push(tuple);
        } else {
            activation = activation.filter(item => !sameTuple(item, tuple));
        }
    }
    return freeze({ ...snapshot, flags: { ...snapshot.flags, frameworks: activation },
        entitlementState: { ...snapshot.entitlementState, grants: snapshot.entitlementState.grants.map(grant =>
            grant === product ? { ...grant, frameworks } : grant) } });
}
module.exports = { tuples, sameTuple, latestDecisions, paidSnapshot, table };
