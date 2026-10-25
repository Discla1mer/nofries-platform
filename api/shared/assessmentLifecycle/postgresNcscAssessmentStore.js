'use strict';

// Private fixed storage mechanics. Only the DATA facade holds the transaction
// and performs current authorization; no request can choose SQL or a callback.
const { createAssessment, applyAssessmentCommand } = require('./assessmentDomain');
const { MODULE_ID, ACCEPTED_PROFILE_REF } = require('../assessmentEngine/ncscAssessmentEvaluator');
const { acceptedRegistry, acceptedProfile, hashNcscRecord, validateNcscSupportingRecords,
    buildNcscSubmission, assertNcscCandidateSize, NcscCandidateSizeError } = require('./ncscAssessmentSubmission');
const { NcscAssessmentError, normaliseNcscCommand, projectNcscDetail, projectNcscSummary } = require('../ncscAssessmentService');

const MAX_REVISION = 128, MAX_SAVE_REVISION = 127, HISTORY_BATCH = 16, PAGE_VERSION_BUDGET = 256;
const VERSION_TABLE = 'nofries.dashboard_ncsc_assessment_revisions';
const HEAD_TABLE = 'nofries.dashboard_ncsc_assessments';
const RECEIPT_TABLE = 'nofries.dashboard_ncsc_assessment_receipts';
const digest = (kind, value) => hashNcscRecord(kind, value);
const fail = (code = 'ncsc_unavailable', status = 503) => { throw new NcscAssessmentError(code, status); };
const same = (a, b) => digest('receipt', a) === digest('receipt', b);
const scopeOf = row => ({ tenantId: row.tenantId, organisationId: row.organisationId, assessmentId: row.assessmentId });
const values = scope => [scope.tenantId, scope.organisationId, scope.assessmentId];
const exact = (row, keys) => {
    if (!row || typeof row !== 'object' || Array.isArray(row) ||
        Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))) fail();
    return row;
};
function integer(value, maximum = Number.MAX_SAFE_INTEGER) {
    if (!Number.isSafeInteger(value) || value < 0 || value > maximum || Object.is(value, -0)) fail();
    return value;
}
function instant(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
        !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail();
    return value;
}
function owner(a, b) {
    if (a.tenantId !== b.tenantId || a.organisationId !== b.organisationId || a.assessmentId !== b.assessmentId) fail();
}
function record(kind, core) { return { ...core, sha256: digest(kind, core) }; }
function assertCandidateSize(envelope) {
    try { assertNcscCandidateSize(envelope); }
    catch (error) {
        if (error instanceof NcscCandidateSizeError) fail('ncsc_request_too_large', 413);
        throw error;
    }
}
function stableIntent(context, input) {
    const command = normaliseNcscCommand(input);
    return Object.freeze({ ...context.scope, actorSubjectKey: context.identity.subjectKey,
        assessmentId: command.assessmentId, action: command.action,
        expectedRevision: command.expectedRevision, payload: command.payload });
}

function makeVersion(intent, idempotencyKey, previous, tenantAggregate, at) {
    instant(at);
    const scope = scopeOf(intent), action = intent.action;
    if (action === 'create' ? previous !== null : previous === null) fail('ncsc_state_conflict', 409);
    if (previous && intent.expectedRevision !== previous.envelope.revision) fail('ncsc_revision_conflict', 409);
    if (previous && (previous.envelope.revision >= MAX_REVISION ||
        (action === 'save' && previous.envelope.revision >= MAX_SAVE_REVISION))) fail('ncsc_state_conflict', 409);
    let scopePopulation, rationales, evidence, risk, payload;
    if (action === 'create') {
        scopePopulation = record('scope', { schemaVersion: 1, ...scope, recordedRevision: 0,
            actorSubjectKey: intent.actorSubjectKey, recordedAt: at, body: intent.payload.scopePopulation });
        rationales = [];
        const common = { schemaVersion: 1, ...scope, recordedRevision: 0, profileRef: ACCEPTED_PROFILE_REF,
            scopePopulationSha256: scopePopulation.sha256, recordedAt: at };
        const ids = acceptedProfile.questions.map(item => item.id).sort();
        evidence = record('evidence', { ...common, entries: ids.map(itemId => ({ itemId, evidenceState: 'not_provided' })) });
        risk = record('risk', { ...common, entries: ids.map(itemId => ({ itemId, statedImpact: 'unspecified', priorityOverlay: 'none' })) });
        payload = { moduleId: MODULE_ID, profileRef: ACCEPTED_PROFILE_REF, scopePopulationSha256: scopePopulation.sha256 };
    } else {
        ({ scopePopulation, rationales, evidence, risk } = previous.envelope);
        rationales = [...rationales];
        payload = {};
        if (action === 'save') {
            const retained = new Map(rationales.map(row => [row.itemId, row]));
            const responses = intent.payload.responses.map(response => {
                let rationale = null;
                if (response.rationale !== null) {
                    rationale = record('rationale', { schemaVersion: 1, ...scope,
                        itemId: response.itemId, recordedRevision: intent.expectedRevision + 1,
                        actorSubjectKey: intent.actorSubjectKey, recordedAt: at, body: response.rationale });
                    retained.set(response.itemId, rationale);
                } else retained.delete(response.itemId);
                return { itemId: response.itemId, optionId: response.optionId,
                    applicabilityRationaleSha256: rationale?.sha256 ?? null };
            });
            rationales = [...retained.values()].sort((a, b) => a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0);
            payload = { responses };
        }
    }
    const command = { ...scope, action, payload, expectedRevision: intent.expectedRevision,
        actorSubjectKey: intent.actorSubjectKey, now: at, idempotencyKey };
    let state;
    try { state = action === 'create' ? createAssessment(tenantAggregate, command, acceptedRegistry)
        : applyAssessmentCommand(previous.envelope.state, tenantAggregate, command, acceptedRegistry); }
    catch (error) {
        if (error.code === 'assessment_revision_conflict') fail('ncsc_revision_conflict', 409);
        fail('ncsc_state_conflict', 409);
    }
    let envelope = { schemaVersion: 1, ...scope, revision: state.revision, state,
        scopePopulation, rationales, evidence, risk, submission: null };
    assertCandidateSize(envelope);
    if (action === 'submit') {
        envelope.submission = buildNcscSubmission(envelope);
        assertCandidateSize(envelope);
    }
    envelope = validateNcscSupportingRecords(envelope);
    const revisionSha256 = digest('version', envelope);
    return { envelope, revisionSha256, parentRevision: previous?.envelope.revision ?? null,
        parentSha256: previous?.revisionSha256 ?? null, command };
}

// Measure the exact JSONB text representation used by the existing SQL CHECK.
// Only a new, already validated candidate reaches this preflight.
async function assertPersistableCandidate(tx, version) {
    const result = await tx.query('SELECT octet_length($1::jsonb::text) AS payload_bytes',
        [JSON.stringify(version.envelope)]);
    if (!result || !Array.isArray(result.rows) || result.rows.length !== 1) fail();
    const bytes = exact(result.rows[0], ['payload_bytes']).payload_bytes;
    if (!Number.isSafeInteger(bytes) || bytes <= 0) fail();
    if (bytes > 256 * 1024) fail('ncsc_request_too_large', 413);
}

function validateHead(row, scope) {
    if (row.schema_version !== 1 || row.tenant_id !== scope.tenantId || row.organisation_id !== scope.organisationId ||
        row.assessment_id !== scope.assessmentId || !/^[a-f0-9]{64}$/.test(row.payload_sha256)) fail();
    integer(row.revision, MAX_REVISION);
    return row;
}
function validateVersion(row, scope) {
    if (row.schema_version !== 1 || row.tenant_id !== scope.tenantId || row.organisation_id !== scope.organisationId ||
        row.assessment_id !== scope.assessmentId || !/^[a-f0-9]{64}$/.test(row.payload_sha256)) fail();
    const revision = integer(row.revision, MAX_REVISION);
    const envelope = validateNcscSupportingRecords(row.payload);
    owner(envelope, scope);
    if (envelope.revision !== revision || envelope.state.revision !== revision ||
        !['created', 'in-progress', 'submitted'].includes(envelope.state.status) ||
        (envelope.state.status === 'submitted') !== (envelope.submission !== null) ||
        digest('version', envelope) !== row.payload_sha256) fail();
    if (revision === 0 ? row.parent_revision !== null || row.parent_sha256 !== null
        : row.parent_revision !== revision - 1 || !/^[a-f0-9]{64}$/.test(row.parent_sha256)) fail();
    if (envelope.state.status === 'in-progress' && revision > MAX_SAVE_REVISION) fail();
    return { envelope, revisionSha256: row.payload_sha256,
        parentRevision: row.parent_revision, parentSha256: row.parent_sha256 };
}
async function readHead(tx, scope) {
    const result = await tx.query(`SELECT * FROM ${HEAD_TABLE} WHERE tenant_id = $1 AND organisation_id = $2 AND assessment_id = $3`, values(scope));
    if (result.rows.length > 1) fail();
    return result.rows.length ? validateHead(result.rows[0], scope) : null;
}
async function readReceipt(tx, scope, key) {
    const result = await tx.query(`SELECT * FROM ${RECEIPT_TABLE} WHERE tenant_id = $1 AND organisation_id = $2 AND assessment_id = $3 AND idempotency_key = $4`, [...values(scope), key]);
    if (result.rows.length > 1) fail();
    return result.rows[0] || null;
}
// Every retained version participates. Fixed batches bound memory; the technical
// ceiling bounds total work without evicting or silently truncating history.
function validateTransition(previous, current, aggregate) {
    const state = current.envelope.state;
    let action, payload;
    if (!previous) {
        action = 'create';
        payload = { scopePopulation: current.envelope.scopePopulation.body };
    } else {
        if (previous.envelope.state.status === 'submitted') fail();
        action = state.status === 'submitted' ? 'submit' : 'save';
        payload = {};
        if (action === 'save') {
            const before = new Map(previous.envelope.state.responses.map(row => [row.itemId, row]));
            const after = new Map(state.responses.map(row => [row.itemId, row]));
            const rationales = new Map(current.envelope.rationales.map(row => [row.itemId, row]));
            const responses = [];
            for (const itemId of [...new Set([...before.keys(), ...after.keys()])].sort()) {
                const old = before.get(itemId), next = after.get(itemId);
                if (old && next && same(old, next)) continue;
                responses.push({ itemId, optionId: next?.optionId ?? null,
                    rationale: rationales.get(itemId)?.body ?? null });
            }
            // Removing an already absent answer is a valid nonempty save. When
            // all answers exist, every valid patch leaves a current stamp.
            if (!responses.length) {
                const absent = acceptedProfile.questions.find(row => !after.has(row.id));
                if (!absent) fail();
                responses.push({ itemId: absent.id, optionId: null, rationale: null });
            }
            payload = { responses };
        }
    }
    const intent = { ...scopeOf(current.envelope), actorSubjectKey: state.updatedBy,
        action, expectedRevision: previous?.envelope.revision ?? null, payload };
    let reconstructed;
    try { reconstructed = makeVersion(intent, 'lineage-validation', previous, aggregate, state.updatedAt); }
    catch { fail(); }
    if (!same(reconstructed.envelope, current.envelope) || reconstructed.revisionSha256 !== current.revisionSha256) fail();
}
async function readHistory(tx, scope, head, requested = [], aggregate) {
    const wanted = new Set([head?.revision, ...requested]), kept = new Map();
    let next = 0, previous = null;
    while (next <= MAX_REVISION + 1) {
        const result = await tx.query(`SELECT * FROM ${VERSION_TABLE} WHERE tenant_id = $1 AND organisation_id = $2 AND assessment_id = $3 AND revision >= $4 ORDER BY revision ASC LIMIT ${HISTORY_BATCH}`,
            [...values(scope), next]);
        if (result.rows.length > HISTORY_BATCH) fail();
        for (const row of result.rows) {
            if (!head || row.revision !== next || row.revision > head.revision) fail();
            const current = validateVersion(row, scope);
            if (current.parentSha256 !== (previous?.revisionSha256 ?? null)) fail();
            if (previous && (current.envelope.state.createdAt !== previous.envelope.state.createdAt ||
                current.envelope.state.updatedAt < previous.envelope.state.updatedAt ||
                !same(current.envelope.scopePopulation, previous.envelope.scopePopulation) ||
                !same(current.envelope.evidence, previous.envelope.evidence) ||
                !same(current.envelope.risk, previous.envelope.risk))) fail();
            validateTransition(previous, current, aggregate);
            if (wanted.has(next)) kept.set(next, current);
            previous = current; next += 1;
        }
        if (result.rows.length < HISTORY_BATCH) break;
    }
    if (head ? next !== head.revision + 1 || previous?.revisionSha256 !== head.payload_sha256 : next !== 0) fail();
    return kept;
}
async function listHeads(tx, scope, page) {
    const result = await tx.query(`SELECT * FROM ${HEAD_TABLE} WHERE tenant_id = $1 AND organisation_id = $2 AND ($3::text IS NULL OR assessment_id COLLATE "C" > $3 COLLATE "C") ORDER BY assessment_id COLLATE "C" ASC LIMIT $4`,
        [scope.tenantId, scope.organisationId, page.afterAssessmentId, page.limit + 1]);
    if (result.rows.length > page.limit + 1) fail();
    let previous = page.afterAssessmentId;
    for (const row of result.rows) {
        validateHead(row, { ...scope, assessmentId: row.assessment_id });
        if (previous !== null && row.assessment_id <= previous) fail();
        previous = row.assessment_id;
    }
    return result.rows;
}
async function appendVersion(tx, version) {
    const e = version.envelope;
    const result = await tx.query(`INSERT INTO ${VERSION_TABLE} (tenant_id, organisation_id, assessment_id, revision, schema_version, payload_sha256, parent_revision, parent_sha256, payload) VALUES ($1, $2, $3, $4, 1, $5, $6, $7, $8::jsonb)`,
        [...values(e), e.revision, version.revisionSha256, version.parentRevision, version.parentSha256, JSON.stringify(e)]);
    if (result.rowCount !== 1) fail();
}
async function moveHead(tx, version) {
    const e = version.envelope;
    const result = version.parentRevision === null
        ? await tx.query(`INSERT INTO ${HEAD_TABLE} (tenant_id, organisation_id, assessment_id, schema_version, revision, payload_sha256) VALUES ($1, $2, $3, 1, $4, $5)`, [...values(e), e.revision, version.revisionSha256])
        : await tx.query(`UPDATE ${HEAD_TABLE} SET revision = $4, payload_sha256 = $5 WHERE tenant_id = $1 AND organisation_id = $2 AND assessment_id = $3 AND revision = $6 AND payload_sha256 = $7`,
            [...values(e), e.revision, version.revisionSha256, version.parentRevision, version.parentSha256]);
    if (result.rowCount !== 1) fail('ncsc_revision_conflict', 409);
}
function publicResult(action, version) {
    return Object.freeze({ schemaVersion: 1, action, assessment: projectNcscDetail(version) });
}
function validateEvent(event, intent, at) {
    exact(event, ['schemaVersion', 'eventType', 'eventId', 'requestId', 'actorSubjectKey',
        'tenantId', 'organisationId', 'action', 'module', 'result', 'occurredAt']);
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    if (event.schemaVersion !== 1 || event.eventType !== 'dashboard.operation' || !uuid.test(event.eventId) ||
        !uuid.test(event.requestId) || event.actorSubjectKey !== intent.actorSubjectKey ||
        event.tenantId !== intent.tenantId || event.organisationId !== intent.organisationId ||
        event.action !== 'assessment.write' || event.module !== MODULE_ID || event.result !== 'succeeded' ||
        instant(event.occurredAt) < at) fail();
}
function revisionVector(value) {
    exact(value, ['tenant', 'organisation', 'membership', 'entitlement', 'flags', 'advisorAssignments', 'usage']);
    for (const key of ['tenant', 'organisation', 'membership', 'entitlement', 'flags']) integer(value[key]);
    for (const [key, id] of [['advisorAssignments', 'assignmentId'], ['usage', 'grantId']]) {
        if (!Array.isArray(value[key])) fail();
        let previous = null;
        for (const row of value[key]) {
            exact(row, [id, 'revision']); integer(row.revision);
            if (typeof row[id] !== 'string' || !row[id] || row[id].length > 180 || (previous !== null && row[id] <= previous)) fail();
            previous = row[id];
        }
    }
    return value;
}
function makeReceipt(intent, key, version, expectedAuthority, resultAuthority, quota, event) {
    validateEvent(event, intent, version.command.now);
    const result = publicResult(intent.action, version);
    return { schemaVersion: 1, ...scopeOf(intent), idempotencyKey: key,
        actorSubjectKey: intent.actorSubjectKey, action: intent.action, intent,
        intentSha256: digest('intent', intent), command: version.command,
        executionAt: version.command.now, resultRevision: version.envelope.revision,
        versionSha256: version.revisionSha256, predecessorSha256: version.parentSha256,
        expectedAuthority, resultAuthority, quota, event, result, resultSha256: digest('result', result) };
}
async function insertReceipt(tx, receipt) {
    digest('receipt', receipt);
    const result = await tx.query(`INSERT INTO ${RECEIPT_TABLE} (tenant_id, organisation_id, assessment_id, idempotency_key, schema_version, intent_sha256, result_sha256, result_revision, version_sha256, payload) VALUES ($1, $2, $3, $4, 1, $5, $6, $7, $8, $9::jsonb)`,
        [...values(receipt), receipt.idempotencyKey, receipt.intentSha256, receipt.resultSha256,
            receipt.resultRevision, receipt.versionSha256, JSON.stringify(receipt)]);
    if (result.rowCount !== 1) fail();
}
function validateReceipt(row, intent, key, history, aggregate) {
    // Hash traversal rejects non-JSON values/accessors before properties are read.
    digest('receipt', row.payload);
    const receipt = exact(row.payload, ['schemaVersion', 'tenantId', 'organisationId', 'assessmentId',
        'idempotencyKey', 'actorSubjectKey', 'action', 'intent', 'intentSha256', 'command', 'executionAt',
        'resultRevision', 'versionSha256', 'predecessorSha256', 'expectedAuthority', 'resultAuthority',
        'quota', 'event', 'result', 'resultSha256']);
    owner(receipt, intent);
    if (row.schema_version !== 1 || receipt.schemaVersion !== 1 || row.tenant_id !== intent.tenantId ||
        row.organisation_id !== intent.organisationId || row.assessment_id !== intent.assessmentId ||
        row.idempotency_key !== key || receipt.idempotencyKey !== key || row.intent_sha256 !== receipt.intentSha256 ||
        row.result_sha256 !== receipt.resultSha256 || row.result_revision !== receipt.resultRevision ||
        row.version_sha256 !== receipt.versionSha256 || digest('intent', receipt.intent) !== receipt.intentSha256 ||
        digest('result', receipt.result) !== receipt.resultSha256) fail();
    if (receipt.intentSha256 !== digest('intent', intent)) fail('ncsc_idempotency_conflict', 409);
    if (receipt.actorSubjectKey !== intent.actorSubjectKey || receipt.action !== intent.action) fail();
    integer(receipt.resultRevision, MAX_REVISION); instant(receipt.executionAt);
    const resultVersion = history.get(receipt.resultRevision);
    if (!resultVersion || resultVersion.revisionSha256 !== receipt.versionSha256 ||
        resultVersion.parentSha256 !== receipt.predecessorSha256) fail();
    const predecessor = intent.action === 'create' ? null : history.get(intent.expectedRevision);
    if (intent.action !== 'create' && !predecessor) fail();
    let reconstructed;
    try { reconstructed = makeVersion(intent, key, predecessor, aggregate, receipt.executionAt); } catch { fail(); }
    if (reconstructed.revisionSha256 !== receipt.versionSha256 ||
        !same(reconstructed.envelope, resultVersion.envelope) || !same(reconstructed.command, receipt.command) ||
        !same(publicResult(intent.action, reconstructed), receipt.result)) fail();
    validateEvent(receipt.event, intent, receipt.executionAt);
    revisionVector(receipt.expectedAuthority); revisionVector(receipt.resultAuthority);
    if (intent.action !== 'submit') {
        if (receipt.quota !== null || !same(receipt.expectedAuthority, receipt.resultAuthority)) fail();
    } else if (!receipt.quota) fail();
    return receipt;
}

module.exports = { MAX_REVISION, MAX_SAVE_REVISION, HISTORY_BATCH, PAGE_VERSION_BUDGET, stableIntent, makeVersion,
    assertPersistableCandidate,
    readHead, readReceipt, readHistory, listHeads, appendVersion, moveHead, publicResult,
    makeReceipt, insertReceipt, validateReceipt, validateEvent, revisionVector,
    projectNcscSummary, projectNcscDetail, scopeOf, digest, same, instant, integer, exact };
