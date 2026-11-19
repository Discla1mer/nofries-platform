'use strict';

const { makeVersion, appendVersion, moveHead, readHead, readHistory } =
    require('../../api/shared/assessmentLifecycle/postgresNcscAssessmentStore');
const { createAssessment, applyAssessmentCommand } = require('../../api/shared/assessmentLifecycle/assessmentDomain');
const { hash } = require('../../api/shared/appLifecycle/dashboardRuntimeRecords');
const { createNistFrameworkProfile } = require('../../api/shared/assessmentEngine/nistFrameworkProfile');
const { createFrameworkRegistry } = require('../../api/shared/assessmentEngine/frameworkProfileRegistry');
const { createNistNcscCrosswalk } = require('../../api/shared/assessmentEngine/nistNcscCrosswalk');
const { ncscFixture, createCommand, saveCommand, submitCommand } = require('./ncscAssessmentFixture');

const profileRef = createNistNcscCrosswalk().toProfileRef;
const registry = createFrameworkRegistry([createNistFrameworkProfile()]);
const now = '2026-11-19T00:00:00.000Z';

// Persist the real creation, answers and submission with the same local IDs
// and scope text in each account. Read the resulting sealed history back.
async function seedSource(db, scope, actor) {
    const aggregate = ncscFixture({ ...scope, now }).state.tenantAggregate;
    let previous = null;
    for (const command of [createCommand(), saveCommand(), submitCommand()]) {
        const version = makeVersion({ ...scope, ...command, actorSubjectKey: actor }, command.idempotencyKey, previous, aggregate, now);
        await appendVersion(db, version);
        await moveHead(db, version);
        previous = version;
    }
    const source = { ...scope, assessmentId: previous.envelope.assessmentId };
    const head = await readHead(db, source);
    return readHistory(db, source, head, [1, 2], aggregate);
}

function selectedSource(version) {
    return [version.envelope.assessmentId, version.envelope.revision, version.revisionSha256, version.envelope.scopePopulation.sha256];
}

async function insertStart(db, scope, actor, scopePopulation, selection, options = {}) {
    const { assessmentId = 'source-bound-start', revision = 0, responses = [] } = options;
    const command = { ...scope, assessmentId, now, actorSubjectKey: actor, action: 'create', expectedRevision: null,
        idempotencyKey: 'start', payload: { moduleId: 'cyber_security', profileRef, scopePopulationSha256: hash(scopePopulation) } };
    const created = createAssessment(ncscFixture({ ...scope, now }).state.tenantAggregate, command, registry);
    const record = { scopePopulation, state: { ...created, revision, responses }, rationales: [] };
    return db.query(`INSERT INTO nofries.dashboard_framework_revisions
        (tenant_id, organisation_id, profile_id, profile_version, assessment_id, revision, idempotency_key,
         intent_sha256, record_sha256, record, ncsc_assessment_id, ncsc_revision, ncsc_revision_sha256, ncsc_scope_sha256)
        VALUES ($1,$2,$3,$4,$5,$6,'start',$7,$8,$9,$10,$11,$12,$13)`,
    [scope.tenantId, scope.organisationId, profileRef.profileId, profileRef.profileVersion, assessmentId, revision,
        hash({ command, selection }), hash(record), record, ...selection]);
}

async function saveUnbound(db, scope, actor, assessmentId) {
    const keys = [scope.tenantId, scope.organisationId, profileRef.profileId, profileRef.profileVersion, assessmentId];
    const { rows } = await db.query(`SELECT record FROM nofries.dashboard_framework_revisions
        WHERE tenant_id=$1 AND organisation_id=$2 AND profile_id=$3 AND profile_version=$4 AND assessment_id=$5 AND revision=0`, keys);
    const command = { ...scope, assessmentId, now, actorSubjectKey: actor, action: 'save', expectedRevision: 0,
        idempotencyKey: 'save-one', payload: { responses: [{ itemId: 'PR.DS-11-Q1', optionId: 'partial', applicabilityRationaleSha256: null }] } };
    const state = applyAssessmentCommand(rows[0].record.state, ncscFixture({ ...scope, now }).state.tenantAggregate, command, registry);
    const record = { ...rows[0].record, state };
    return db.query(`INSERT INTO nofries.dashboard_framework_revisions
        (tenant_id,organisation_id,profile_id,profile_version,assessment_id,revision,idempotency_key,intent_sha256,record_sha256,record)
        VALUES ($1,$2,$3,$4,$5,1,'save-one',$6,$7,$8)`, [...keys, hash(command), hash(record), record]);
}

module.exports = { seedSource, selectedSource, insertStart, saveUnbound };
