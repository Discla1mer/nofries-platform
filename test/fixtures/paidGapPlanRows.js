'use strict';

// Schema fixtures for held 0032. Only the disposable owner creates paid plan rows.
const { hash } = require('../../api/shared/appLifecycle/dashboardRuntimeRecords');
const profiles = {
    nist: { profileId: 'nf-nist-csf-2-0-core', profileVersion: '2026-09-08.1', itemId: 'GV.OC-01-Q1', optionId: 'partial' },
    iso: { profileId: 'nf-iso-27001-2022-readiness', profileVersion: '2026-11-19.1', itemId: 'A.5.1-Q1', optionId: 'partly_in_place' }
};
async function insertSource(db, scope, actor, profile, changes = {}) {
    const { profileId, profileVersion, itemId, optionId } = profile;
    const { assessmentId = 'paid-1', revision = 129, status = 'submitted',
        responses = [{ itemId, optionId }], submittedRevision = revision } = changes;
    const record = { state: { ...scope, assessmentId, moduleId: 'cyber_security', revision, status,
        profileRef: { profileId, profileVersion }, updatedBy: actor, responses,
        submission: { revision: submittedRevision, responseSetSha256: hash(responses) } } };
    const digest = hash(record);
    await db.query(`INSERT INTO nofries.dashboard_framework_revisions
        (tenant_id,organisation_id,profile_id,profile_version,assessment_id,revision,idempotency_key,intent_sha256,record_sha256,record)
        VALUES ($1,$2,$3,$4,$5,$6,'submit',$7,$8,$9)`,
    [scope.tenantId, scope.organisationId, profileId, profileVersion, assessmentId, revision, hash('intent'), digest, record]);
    return { ...scope, actor, profileId, profileVersion, itemId, assessmentId, assessmentRevision: revision, digest };
}
async function insertPlan(db, source, planId, parent = null) {
    const { tenantId, organisationId, assessmentId, assessmentRevision, digest, profileId, profileVersion, itemId, actor } = source;
    const revision = parent ? 1 : 0;
    const at = '2026-11-19T00:00:00.000Z', assignment = { ownerLabel: 'Operations lead', dueDate: '2027-01-31' };
    const command = { planId, type: parent ? 'assign' : 'generate', operationId: parent ? 'assign-1' : 'generate-1',
        expectedRevision: parent ? 0 : null, actionId: parent ? 'action:' + hash(itemId) : null,
        payload: parent ? assignment : { assessmentId, assessmentRevision, assessmentRevisionSha256: digest,
            paidGap: { profileId, profileVersion, itemId } } };
    const intent = { tenantId, organisationId, actorSubjectKey: actor, command };
    const payload = { schemaVersion: 1, intent, at, source: { assessmentId, revision: assessmentRevision, revisionSha256: digest },
        command: parent ? { tenantId, organisationId, actorSubjectKey: actor, at, ...command } : null, resultSha256: hash(command) };
    const planDigest = hash(payload);
    await db.query(`INSERT INTO nofries.dashboard_improvement_revisions
        (tenant_id,organisation_id,plan_id,revision,operation_id,payload_sha256,parent_revision,parent_sha256,
         assessment_id,assessment_revision,assessment_sha256,payload,paid_profile_id,paid_profile_version,paid_item_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [tenantId, organisationId, planId, revision, command.operationId, planDigest, command.expectedRevision, parent,
        assessmentId, assessmentRevision, digest, payload, profileId, profileVersion, itemId]);
    return planDigest;
}
async function insertHead(db, source, planId, revision, digest) {
    return db.query('INSERT INTO nofries.dashboard_improvement_heads (tenant_id,organisation_id,plan_id,revision,payload_sha256) VALUES ($1,$2,$3,$4,$5)',
        [source.tenantId, source.organisationId, planId, revision, digest]);
}
module.exports = { profiles, insertSource, insertPlan, insertHead };
