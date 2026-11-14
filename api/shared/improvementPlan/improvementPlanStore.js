'use strict';

// Private fixed SQL mechanics. Call only inside the repository's locked tenant
// transaction. The proposal schema is deliberately outside automatic migrations.
const crypto = require('node:crypto');
const { serialiseAssessmentEvaluation } = require('../assessmentEngine/assessmentEvaluator');
const { copy, fields, freeze, instant } = require('../appLifecycle/dashboardRuntimeRecords');
const ncscStore = require('../assessmentLifecycle/postgresNcscAssessmentStore');
const { acceptedRegistry } = require('../assessmentLifecycle/ncscAssessmentSubmission');
const { createImprovementPlan, getImprovementPlanView } = require('./improvementPlanDomain');
const { ImprovementPlanServiceError, normaliseImprovementCommand } = require('./improvementPlanService');
const TABLE = 'nofries.dashboard_improvement_revisions';
const HEAD = 'nofries.dashboard_improvement_heads';
const values = scope => [scope.tenantId, scope.organisationId, scope.planId];
const fail = () => { throw new ImprovementPlanServiceError(); };
const digest = value => crypto.createHash('sha256').update('nofries:improvement-service:v1\n')
    .update(serialiseAssessmentEvaluation(value)).digest('hex');
const same = (a, b) => digest(a) === digest(b);
const result = state => freeze({ schemaVersion: 1, plan: getImprovementPlanView(state) });
function stableIntent(context, command) {
    return freeze({ ...context.scope, actorSubjectKey: context.identity.subjectKey, command });
}
function domainCommand(intent, at, evaluationOutputSha256) {
    const { command } = intent;
    return { tenantId: intent.tenantId, organisationId: intent.organisationId,
        planId: command.planId, evaluationOutputSha256, actionId: command.actionId,
        operationId: command.operationId, expectedRevision: command.expectedRevision,
        actorSubjectKey: intent.actorSubjectKey, at, type: command.type, payload: command.payload };
}
async function readSource(tx, scope, source, aggregate, retained = false) {
    const selection = { tenantId: scope.tenantId, organisationId: scope.organisationId, assessmentId: source.assessmentId };
    const head = await ncscStore.readHead(tx, selection);
    const history = await ncscStore.readHistory(tx, selection, head, [source.revision], aggregate);
    const version = history.get(source.revision);
    if (!version || version.revisionSha256 !== source.revisionSha256 ||
        version.envelope.state.status !== 'submitted' || !version.envelope.submission) {
        if (retained) fail();
        throw new ImprovementPlanServiceError('improvement_source_conflict', 409);
    }
    return version.envelope.submission.input;
}
function seed(intent, at, evaluatorInput) {
    return createImprovementPlan({ tenantId: intent.tenantId, organisationId: intent.organisationId,
        planId: intent.command.planId, actorSubjectKey: intent.actorSubjectKey, createdAt: at }, evaluatorInput, { registry: acceptedRegistry });
}
function sourceOf(command) {
    return { assessmentId: command.payload.assessmentId, revision: command.payload.assessmentRevision,
        revisionSha256: command.payload.assessmentRevisionSha256 };
}
function makeRecord(intent, at, source, parentSha256, state, command) {
    const output = result(state);
    const payload = copy({ schemaVersion: 1, intent, at, source, command, resultSha256: digest(output) }, 32768);
    return { payload, payloadSha256: digest(payload), parentSha256,
        revision: output.plan.revision, result: output };
}
async function loadHistory(tx, scope, aggregate, operationId = null) {
    const headRows = (await tx.query(`SELECT * FROM ${HEAD} WHERE tenant_id=$1 AND organisation_id=$2 AND plan_id=$3`, values(scope))).rows;
    const rows = (await tx.query(`SELECT * FROM ${TABLE} WHERE tenant_id=$1 AND organisation_id=$2 AND plan_id=$3 ORDER BY revision LIMIT 1026`, values(scope))).rows;
    if (headRows.length > 1 || rows.length > 1025 || (!!headRows.length !== !!rows.length)) fail();
    if (!rows.length) return null;
    let state, source, sourceInput, parentSha256 = null, output, replay = null;
    const history = [], operations = new Set();
    for (const [index, row] of rows.entries()) {
        const payload = fields(copy(row.payload, 32768), ['schemaVersion', 'intent', 'at', 'source', 'command', 'resultSha256']);
        const intent = fields(payload.intent, ['tenantId', 'organisationId', 'actorSubjectKey', 'command']);
        const command = normaliseImprovementCommand(intent.command);
        instant(payload.at);
        if (payload.schemaVersion !== 1 || intent.tenantId !== scope.tenantId || intent.organisationId !== scope.organisationId ||
            command.planId !== scope.planId || operations.has(command.operationId) ||
            row.tenant_id !== scope.tenantId || row.organisation_id !== scope.organisationId || row.plan_id !== scope.planId ||
            row.revision !== index || row.operation_id !== command.operationId ||
            row.parent_revision !== (index ? index - 1 : null) || row.parent_sha256 !== parentSha256 ||
            row.payload_sha256 !== digest(payload)) fail();
        operations.add(command.operationId);
        if (index === 0) {
            if (command.type !== 'generate' || payload.command !== null) fail();
            source = sourceOf(command);
            if (!same(payload.source, source)) fail();
            sourceInput = await readSource(tx, scope, source, aggregate, true);
            state = seed(intent, payload.at, sourceInput);
        } else {
            if (command.type === 'generate' || !same(payload.source, source) ||
                !same(payload.command, domainCommand(intent, payload.at, state.source.evaluationOutputSha256))) fail();
            // Domain replay validates historical transitions without re-granting
            // historical memberships. Current authority is checked by repository.
            state = { ...state, commands: [...state.commands, payload.command] };
        }
        if (row.assessment_id !== source.assessmentId || row.assessment_revision !== source.revision ||
            row.assessment_sha256 !== source.revisionSha256) fail();
        output = result(state);
        if (payload.resultSha256 !== digest(output)) fail();
        history.push({ revision: index, operationId: command.operationId, type: command.type,
            actorSubjectKey: intent.actorSubjectKey, at: payload.at, actionId: command.actionId, payload: command.payload });
        if (command.operationId === operationId) replay = { intent, result: output };
        parentSha256 = row.payload_sha256;
    }
    const head = headRows[0];
    if (head.tenant_id !== scope.tenantId || head.organisation_id !== scope.organisationId || head.plan_id !== scope.planId ||
        head.revision !== rows.length - 1 || head.payload_sha256 !== parentSha256) fail();
    return { state, source, history, result: output, revision: rows.length - 1, payloadSha256: parentSha256, replay };
}
// Owner decision: carry only from the latest earlier plan whose assessment
// declared the same scope body (jsonb equality ignores key order), for the same
// module, submitted no later than the new source. Scope record digests include
// the assessment ID and time, so bodies are compared, not digests.
const VERSIONS = 'nofries.dashboard_ncsc_assessment_revisions';
const INPUT = column => `(${column}.payload#>>'{submission,input,scoreAsOf}') COLLATE "C"`;
async function previousPlanId(tx, scope, source) {
    const found = (await tx.query(`SELECT p.plan_id FROM ${TABLE} p
        JOIN ${VERSIONS} a ON a.tenant_id=p.tenant_id AND a.organisation_id=p.organisation_id AND a.assessment_id=p.assessment_id AND a.revision=p.assessment_revision AND a.payload_sha256=p.assessment_sha256
        JOIN ${VERSIONS} n ON n.tenant_id=p.tenant_id AND n.organisation_id=p.organisation_id AND n.assessment_id=$4 AND n.revision=$5 AND n.payload_sha256=$6
        WHERE p.tenant_id=$1 AND p.organisation_id=$2 AND p.plan_id<>$3 AND p.revision=0 AND p.assessment_id<>$4
        AND a.payload->'scopePopulation'->'body' = n.payload->'scopePopulation'->'body'
        AND a.payload#>>'{submission,input,moduleId}' = n.payload#>>'{submission,input,moduleId}'
        AND ${INPUT('a')} <= ${INPUT('n')}
        ORDER BY ${INPUT('a')} DESC, (p.payload->>'at') COLLATE "C" DESC, p.plan_id COLLATE "C" DESC LIMIT 1`,
    [...values(scope), source.assessmentId, source.revision, source.revisionSha256])).rows;
    if (found.length > 1 || (found.length && typeof found[0].plan_id !== 'string')) fail();
    return found.length ? found[0].plan_id : null;
}
async function append(tx, scope, record) {
    const { payload, revision, payloadSha256, parentSha256 } = record, source = payload.source;
    const inserted = await tx.query(`INSERT INTO ${TABLE} (tenant_id, organisation_id, plan_id, revision, operation_id, payload_sha256, parent_revision, parent_sha256, assessment_id, assessment_revision, assessment_sha256, payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
        [...values(scope), revision, payload.intent.command.operationId, payloadSha256, revision ? revision - 1 : null,
            parentSha256, source.assessmentId, source.revision, source.revisionSha256, JSON.stringify(payload)]);
    if (inserted.rowCount !== 1) fail();
    const moved = revision === 0
        ? await tx.query(`INSERT INTO ${HEAD} (tenant_id, organisation_id, plan_id, revision, payload_sha256) VALUES ($1,$2,$3,$4,$5)`, [...values(scope), revision, payloadSha256])
        : await tx.query(`UPDATE ${HEAD} SET revision=$4,payload_sha256=$5 WHERE tenant_id=$1 AND organisation_id=$2 AND plan_id=$3 AND revision=$6 AND payload_sha256=$7`,
            [...values(scope), revision, payloadSha256, revision - 1, parentSha256]);
    if (moved.rowCount !== 1) fail();
}
module.exports = Object.freeze({ stableIntent, domainCommand, readSource, seed, sourceOf,
    makeRecord, loadHistory, previousPlanId, append, same, digest, result });
