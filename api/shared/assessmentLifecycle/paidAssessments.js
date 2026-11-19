'use strict';

const { createFrameworkRegistry } = require('../assessmentEngine/frameworkProfileRegistry');
const { createNistFrameworkProfile } = require('../assessmentEngine/nistFrameworkProfile');
const { createAssessment, applyAssessmentCommand, normaliseAssessmentState, AssessmentDomainError } = require('./assessmentDomain');
const { normaliseAssessmentWrite, NcscAssessmentError } = require('../ncscAssessmentService');
const { resolveAssessmentAccess } = require('../appLifecycle/dashboardResourceAuthority');
const { consumeEntitlementLimit } = require('../appLifecycle/entitlementDomain');
const { dataStorage } = require('../appLifecycle/postgresDashboardBootstrap');
const { hash, fields } = require('../appLifecycle/dashboardRuntimeRecords');

const MODULE = 'cyber_security';
const WHERE = 'tenant_id=$1 AND organisation_id=$2 AND profile_id=$3 AND profile_version=$4';
const TABLE = 'nofries.dashboard_framework_revisions';
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const statuses = { input_invalid: 400, access_denied: 403, not_found: 404, too_large: 413, conflict: 409, quota_exceeded: 409, unavailable: 503 };
class PaidAssessmentError extends Error {
    constructor(reason = 'unavailable') {
        super('framework_' + reason);
        this.code = this.message;
        this.statusCode = statuses[reason];
    }
}
function fail(reason) { throw new PaidAssessmentError(reason); }

let registry;
function publication(id, version) {
    registry ??= createFrameworkRegistry([createNistFrameworkProfile()]);
    try { return registry.getProfile(id, version); }
    catch { fail('not_found'); }
}
function parsePaidRoute(path) {
    const match = /^frameworks\/([\w.-]+)\/([\w.-]+)\/assessments(?:\/([\w.:%-]+)(?:\/(save|submit))?)?$/.exec(path);
    if (!match) return null;
    const [, profileId, version, rawId, mutation] = match;
    let assessmentId = null;
    if (rawId) {
        try { assessmentId = decodeURIComponent(rawId); } catch { return null; }
        if (!ID.test(assessmentId) || encodeURIComponent(assessmentId) !== rawId) return null;
    }
    return { profileId, version, assessmentId, mutation: mutation || null };
}
function prepareRequest(route, body, cursor) {
    const profile = publication(route.profileId, route.version);
    const profileRef = { frameworkId: profile.framework.id, frameworkVersion: profile.framework.version,
        profileId: profile.profile.id, profileVersion: profile.profile.version,
        catalogueSha256: profile.catalogueSha256, sourceCatalogueSha256: profile.sourceCatalogueSha256 };
    if (body === undefined) return { profile, profileRef, assessmentId: route.assessmentId, cursor, command: null };
    try {
        const create = !route.assessmentId;
        fields(body, [...(create ? ['assessmentId'] : []), 'expectedRevision', 'idempotencyKey', 'payload']);
        const options = new Map(profile.responseOptions.map(option => [option.id, option]));
        const questionOptions = id => {
            const question = profile.questions.find(item => item.id === id);
            return question && new Map(question.responseOptionIds.map(key => [key, options.get(key)]));
        };
        const command = normaliseAssessmentWrite({ ...body, assessmentId: create ? body.assessmentId : route.assessmentId,
            action: create ? 'create' : route.mutation }, () => profile.questions.length, questionOptions);
        return { profile, profileRef, assessmentId: command.assessmentId, command };
    } catch (error) {
        if (error instanceof NcscAssessmentError && error.statusCode === 413) fail('too_large');
        fail('input_invalid');
    }
}

function paidAccess(authority, context, write, ref, at) {
    try {
        return resolveAssessmentAccess(authority, context, write ? 'assessment.write' : 'assessment.read', at,
            rows => rows.some(row => row.moduleId === MODULE && row.profileId === ref.profileId && row.version === ref.profileVersion));
    } catch { fail('access_denied'); }
}
function checkRecord(row, scope, ref) {
    if (hash(row.record) !== row.record_sha256) fail();
    fields(row.record, ['state', 'scopePopulation', 'rationales']);
    const { state, scopePopulation, rationales } = row.record;
    fields(scopePopulation, ['description']);
    const validText = value => typeof value === 'string' && value.length <= 4000 && value.trim().length > 0;
    if (!validText(scopePopulation.description) || !Array.isArray(rationales)) fail();
    for (const reason of rationales) {
        fields(reason, ['itemId', 'rationale']);
        fields(reason.rationale, ['text']);
        if (!validText(reason.rationale.text)) fail();
    }
    if (state.tenantId !== scope.tenantId || state.organisationId !== scope.organisationId ||
        state.assessmentId !== scope.assessmentId || state.moduleId !== MODULE || hash(state.profileRef) !== hash(ref) ||
        state.revision !== row.revision || hash(scopePopulation) !== state.scopePopulationSha256) fail();
    if (!['created', 'in-progress', 'submitted'].includes(state.status)) fail();
    normaliseAssessmentState(state, registry);
    const reasons = new Map(rationales.map(r => [r.itemId, r.rationale]));
    if (reasons.size !== rationales.length || reasons.size !== state.responses.filter(r => r.applicabilityRationaleSha256).length) fail();
    for (const answer of state.responses) {
        if (answer.applicabilityRationaleSha256 && (!reasons.has(answer.itemId) ||
            hash(reasons.get(answer.itemId)) !== answer.applicabilityRationaleSha256)) fail();
    }
    return row.record;
}
function project({ state, rationales, scopePopulation }) {
    const { assessmentId, moduleId, profileRef, status, revision, submission } = state;
    const reasons = new Map(rationales.map(r => [r.itemId, r.rationale]));
    return { schemaVersion: 1, assessment: { assessmentId, moduleId, profileRef, status, revision, scopePopulation,
        responses: state.responses.map(({ itemId, optionId }) => ({ itemId, optionId, rationale: reasons.get(itemId) || null })),
        submission: submission && { revision: submission.revision, submittedAt: submission.submittedAt,
            responseSetSha256: submission.responseSetSha256 } } };
}
function advance(previous, scope, context, authority, ref, command, now) {
    const base = { ...scope, action: command.action, idempotencyKey: command.idempotencyKey,
        expectedRevision: command.expectedRevision, actorSubjectKey: context.identity.subjectKey, now };
    if (command.action === 'create') {
        if (previous) fail('conflict');
        const scopePopulation = command.payload.scopePopulation;
        const payload = { moduleId: MODULE, profileRef: ref, scopePopulationSha256: hash(scopePopulation) };
        return { state: createAssessment(authority.tenantAggregate, { ...base, payload }, registry), scopePopulation, rationales: [] };
    }
    if (!previous) fail('not_found');
    if (previous.state.revision >= (command.action === 'submit' ? 512 : 511)) fail('conflict');
    const reasons = new Map(previous.rationales.map(r => [r.itemId, r.rationale]));
    const payload = command.action === 'submit' ? {} : { responses: command.payload.responses.map(({ itemId, optionId, rationale }) => {
        if (rationale) reasons.set(itemId, rationale);
        else reasons.delete(itemId);
        return { itemId, optionId, applicabilityRationaleSha256: rationale && hash(rationale) };
    }) };
    try {
        return { ...previous, state: applyAssessmentCommand(previous.state, authority.tenantAggregate, { ...base, payload }, registry),
            rationales: Array.from(reasons, ([itemId, rationale]) => ({ itemId, rationale })) };
    } catch (error) {
        if (error instanceof AssessmentDomainError) fail(error.statusCode === 409 ? 'conflict' : 'input_invalid');
        throw error;
    }
}
async function chargeSubmission(tx, context, authority, decision, ref, at) {
    const grantId = decision.product.grantId;
    const usage = authority.usage.find(row => row.grantId === grantId);
    if (!usage) fail('access_denied');
    let after;
    try {
        after = consumeEntitlementLimit(authority.entitlementState, authority.tenantAggregate, usage, { ...context.scope,
            grantId, expectedUsageRevision: usage.revision, expectedEntitlementRevision: authority.entitlementState.revision,
            expectedFlagRevision: authority.flags.revision, moduleId: MODULE, limit: 'assessment_runs', amount: 1,
            framework: { profileId: ref.profileId, version: ref.profileVersion } }, at, authority.flags);
    } catch (error) { fail(error.code === 'entitlement_limit_exceeded' ? 'quota_exceeded' : 'access_denied'); }
    await dataStorage.updateUsage(tx, after);
}
async function paidRequest(pair, context, { profile, profileRef, assessmentId, cursor, command }) {
    const scope = { ...context.scope, assessmentId };
    const keys = [scope.tenantId, scope.organisationId, profileRef.profileId, profileRef.profileVersion];
    return pair.database.withTenantTransaction(scope.tenantId, async (tx, authority) => {
        const now = pair.clock();
        const decision = paidAccess(authority, context, Boolean(command), profileRef, now);
        let result;
        if (!assessmentId) {
            const { rows } = await tx.query(`SELECT DISTINCT ON (assessment_id COLLATE "C") assessment_id,revision,
                record#>>'{state,status}' AS status, record#>>'{state,updatedAt}' AS updated_at FROM ${TABLE}
                WHERE ${WHERE} AND ($5::text IS NULL OR assessment_id COLLATE "C" > $5 COLLATE "C")
                ORDER BY assessment_id COLLATE "C", revision DESC LIMIT 26`, [...keys, cursor]);
            result = { schemaVersion: 1, publication: profile, assessments: rows.slice(0, 25).map(row => ({
                assessmentId: row.assessment_id, status: row.status, revision: row.revision, updatedAt: row.updated_at })),
                nextAfterAssessmentId: rows.length > 25 ? rows[24].assessment_id : null };
        } else {
            keys.push(assessmentId);
            const select = `SELECT revision,record,record_sha256,intent_sha256 FROM ${TABLE} WHERE ${WHERE} AND assessment_id=$5`;
            const intent = command && hash({ ...scope, actor: context.identity.subjectKey, profileRef, command });
            const replay = command && (await tx.query(select + ' AND idempotency_key=$6', [...keys, command.idempotencyKey])).rows[0];
            if (replay && replay.intent_sha256 !== intent) fail('conflict');
            const head = replay || (await tx.query(select + ' ORDER BY revision DESC LIMIT 1', keys)).rows[0];
            let record = head && checkRecord(head, scope, profileRef);
            if (command && !replay) {
                record = advance(record, scope, context, authority, profileRef, command, now);
                const encoded = JSON.stringify(record);
                const measured = await tx.query('SELECT octet_length($1::jsonb::text) AS bytes', [encoded]);
                if (measured.rows.length !== 1 || !Number.isSafeInteger(measured.rows[0].bytes) || measured.rows[0].bytes <= 0) fail();
                if (measured.rows[0].bytes > 1048576) fail('too_large');
                if (command.action === 'submit') await chargeSubmission(tx, context, authority, decision, profileRef, now);
                await tx.query(`INSERT INTO ${TABLE} (tenant_id,organisation_id,profile_id,profile_version,assessment_id,
                    revision,idempotency_key,intent_sha256,record_sha256,record) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
                [...keys, record.state.revision, command.idempotencyKey, intent, hash(record), encoded]);
            }
            if (!record) fail('not_found');
            result = project(record);
            if (replay) return result;
        }
        await pair.audit.writeEvent(pair.audit.createEvent(context, { action: command ? 'assessment.write' : 'assessment.read',
            module: MODULE, result: 'succeeded' }));
        return result;
    });
}
module.exports = { PaidAssessmentError, parsePaidRoute, prepareRequest, paidAccess, paidRequest };
