'use strict';

// Scoring v2 (#399): a retained assessment is validated and scored with the
// profile and evaluator named by its own stored reference. New assessments
// still use the accepted profile.
const { createTenantAggregate } = require('../api/shared/appLifecycle/tenantDomain');
const { createAssessment, applyAssessmentCommand } = require('../api/shared/assessmentLifecycle/assessmentDomain');
const { acceptedProfile, hashNcscRecord, validateNcscSupportingRecords,
    buildNcscSubmission } = require('../api/shared/assessmentLifecycle/ncscAssessmentSubmission');
const { MODULE_ID, ACCEPTED_PROFILE_REF } = require('../api/shared/assessmentEngine/ncscAssessmentEvaluator');
const { ACCEPTED_NCSC_CONTEXT, NCSC_V2_CONTEXT, ncscProfileContext } = require('../api/shared/assessmentEngine/ncscProfileSet');
const { ASSESSMENT_EVALUATOR_SOURCE_SHA256 } = require('../api/shared/assessmentEngine/assessmentEvaluatorVersion');
const { ASSESSMENT_EVALUATOR_V2_SOURCE_SHA256 } = require('../api/shared/assessmentEngine/assessmentEvaluatorV2Version');

const ACTOR = '10000000-0000-4000-8000-000000000000:10000000-0000-4000-8000-000000000001';
const AT = ['2026-11-18T08:00:00.000Z', '2026-11-18T09:00:00.000Z', '2026-11-18T10:00:00.000Z'];
const OWNER = { tenantId: 'synthetic-tenant', organisationId: 'synthetic-org', assessmentId: 'synthetic-assessment' };
// The worked example in #399, in profile order.
const EXAMPLE = ['no', 'ad_hoc', 'partly', 'partly', 'partly', 'mfa_text_code', 'unknown', 'partly', 'partly', 'no', 'no',
    'no', 'ad_hoc', 'partly', 'no', 'unknown'];
const copy = value => JSON.parse(JSON.stringify(value));
function record(kind, fields) {
    const core = { schemaVersion: 1, ...OWNER, recordedRevision: 0, recordedAt: AT[0], ...fields };
    return { ...core, sha256: hashNcscRecord(kind, core) };
}
function fixture(context, answers) {
    const aggregate = createTenantAggregate({ tenant: { tenantId: OWNER.tenantId, displayName: 'Synthetic tenant' },
        organisations: [{ tenantId: OWNER.tenantId, organisationId: OWNER.organisationId, displayName: 'Synthetic organisation' }] });
    const ids = context.questionIds;
    const scopePopulation = record('scope', { actorSubjectKey: ACTOR, body: { description: 'Synthetic office and cloud systems.' } });
    const evidence = record('evidence', { profileRef: copy(context.profileRef), scopePopulationSha256: scopePopulation.sha256,
        entries: ids.map(itemId => ({ itemId, evidenceState: 'not_provided' })) });
    const risk = record('risk', { profileRef: copy(context.profileRef), scopePopulationSha256: scopePopulation.sha256,
        entries: ids.map(itemId => ({ itemId, statedImpact: 'unspecified', priorityOverlay: 'none' })) });
    let state = createAssessment(aggregate, { ...OWNER, action: 'create',
        payload: { moduleId: MODULE_ID, profileRef: context.profileRef, scopePopulationSha256: scopePopulation.sha256 },
        expectedRevision: null, actorSubjectKey: ACTOR, now: AT[0], idempotencyKey: 'create-a' }, context.registry);
    state = applyAssessmentCommand(state, aggregate, { ...OWNER, action: 'save', expectedRevision: 0,
        actorSubjectKey: ACTOR, now: AT[1], idempotencyKey: 'save-a', payload: {
            responses: ids.map((itemId, index) => ({ itemId, optionId: answers[index], applicabilityRationaleSha256: null })) } }, context.registry);
    state = applyAssessmentCommand(state, aggregate, { ...OWNER, action: 'submit', expectedRevision: 1,
        actorSubjectKey: ACTOR, now: AT[2], idempotencyKey: 'submit-a', payload: {} }, context.registry);
    return { schemaVersion: 1, ...OWNER, revision: state.revision, state: copy(state),
        scopePopulation, rationales: [], evidence, risk, submission: null };
}
function invalid(fn) {
    expect(fn).toThrow(expect.objectContaining({ code: 'ncsc_record_invalid', statusCode: 503 }));
}

describe('profile set', () => {
    test('resolves only an exact, complete stored reference', () => {
        expect(ncscProfileContext(copy(ACCEPTED_PROFILE_REF))).toBe(ACCEPTED_NCSC_CONTEXT);
        expect(ncscProfileContext(copy(NCSC_V2_CONTEXT.profileRef))).toBe(NCSC_V2_CONTEXT);
        expect(ACCEPTED_NCSC_CONTEXT.profile).toEqual(acceptedProfile);
        expect(ACCEPTED_NCSC_CONTEXT.profileRef).toEqual(ACCEPTED_PROFILE_REF);
        expect(ACCEPTED_NCSC_CONTEXT.evaluatorSourceSha256).toBe(ASSESSMENT_EVALUATOR_SOURCE_SHA256);
        expect(NCSC_V2_CONTEXT.evaluatorSourceSha256).toBe(ASSESSMENT_EVALUATOR_V2_SOURCE_SHA256);
        const mixed = { ...NCSC_V2_CONTEXT.profileRef, catalogueSha256: ACCEPTED_PROFILE_REF.catalogueSha256 };
        const { sourceCatalogueSha256, ...short } = NCSC_V2_CONTEXT.profileRef;
        [null, undefined, 'x', [], {}, mixed, short, { ...NCSC_V2_CONTEXT.profileRef, extra: 'x' },
            { ...NCSC_V2_CONTEXT.profileRef, profileVersion: '2026-11-18.2' },
            Object.create(NCSC_V2_CONTEXT.profileRef)].forEach(ref => expect(ncscProfileContext(ref)).toBeNull());
    });
});

describe('retained submissions by stored profile', () => {
    test('a v2 assessment is scored by the graded evaluator: the worked example is 25.3%', () => {
        const envelope = fixture(NCSC_V2_CONTEXT, EXAMPLE);
        const { input, evaluation } = buildNcscSubmission(envelope);
        expect(input.profileRef).toEqual(NCSC_V2_CONTEXT.profileRef);
        expect(input.scoreContractVersion).toBe('PROD-003-R2');
        expect(input.atomInputs.map(atom => atom.itemId)).toEqual(NCSC_V2_CONTEXT.questionIds);
        expect(evaluation.attainment).toMatchObject({ lowerCreditUnits: 785, denominatorWeight: 31, lowerDisplay: '25.3%' });
        expect(evaluation.provenance).toMatchObject({ evaluatorVersion: '2026-11-17.1',
            evaluatorSourceSha256: ASSESSMENT_EVALUATOR_V2_SOURCE_SHA256, scoreContractVersion: 'PROD-003-R2' });
        // The retained result validates again, and a changed result does not.
        const retained = { ...envelope, submission: copy({ input, evaluation }) };
        expect(validateNcscSupportingRecords(retained).submission).toEqual({ input, evaluation });
        const changed = copy(retained); changed.submission.evaluation.attainment.lowerCreditUnits = 3100;
        invalid(() => validateNcscSupportingRecords(changed));
    });

    test('an accepted-profile assessment keeps the original evaluator and contract', () => {
        const answers = ACCEPTED_NCSC_CONTEXT.questionIds.map((id, index) => ['yes', 'partial', 'no', 'unknown'][index % 4]);
        const { input, evaluation } = buildNcscSubmission(fixture(ACCEPTED_NCSC_CONTEXT, answers));
        expect(input.profileRef).toEqual(ACCEPTED_PROFILE_REF);
        expect(input.scoreContractVersion).toBe('PROD-003-R1');
        expect(evaluation.provenance).toMatchObject({ evaluatorVersion: '2026-09-02.1',
            evaluatorSourceSha256: ASSESSMENT_EVALUATOR_SOURCE_SHA256, scoreContractVersion: 'PROD-003-R1' });
        expect(evaluation.attainment.creditUnitScale).toBe(2);
    });

    test('a record cannot name one profile and carry the other profile\'s answers, records or reference', () => {
        const v2 = fixture(NCSC_V2_CONTEXT, EXAMPLE);
        const relabelled = copy(v2); relabelled.state.profileRef = copy(ACCEPTED_PROFILE_REF);
        invalid(() => validateNcscSupportingRecords(relabelled));
        const unknown = copy(v2); unknown.state.profileRef.profileVersion = '2026-11-18.2';
        invalid(() => validateNcscSupportingRecords(unknown));
        const partial = copy(v2); delete partial.state.profileRef.sourceCatalogueSha256;
        invalid(() => validateNcscSupportingRecords(partial));
        const crossed = copy(v2); crossed.evidence.profileRef = copy(ACCEPTED_PROFILE_REF);
        const { sha256, ...core } = crossed.evidence; crossed.evidence.sha256 = hashNcscRecord('evidence', core);
        invalid(() => validateNcscSupportingRecords(crossed));
        // A v1 result cannot be attached to a v2 assessment.
        const answers = ACCEPTED_NCSC_CONTEXT.questionIds.map(() => 'yes');
        const foreign = { ...v2, submission: copy(buildNcscSubmission(fixture(ACCEPTED_NCSC_CONTEXT, answers))) };
        invalid(() => validateNcscSupportingRecords(foreign));
    });
});
