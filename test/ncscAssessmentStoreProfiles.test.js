'use strict';

// Scoring v2 (#399): the store keeps every version of an assessment on the
// profile its first version stored. The v2 profile is readable and writable
// only while NOFRIES_NCSC_PROFILE_V2 is exactly "true"; new assessments still
// start on the accepted profile.
const { createTenantAggregate } = require('../api/shared/appLifecycle/tenantDomain');
const store = require('../api/shared/assessmentLifecycle/postgresNcscAssessmentStore');
const { normaliseNcscCommand, projectNcscSummary } = require('../api/shared/ncscAssessmentService');
const { ACCEPTED_NCSC_CONTEXT, NCSC_V2_CONTEXT, knownNcscQuestionOptions, maximumNcscResponses, ncscProfileV2Enabled,
    readableNcscProfileContext } = require('../api/shared/assessmentEngine/ncscProfileSet');

const ACTOR = '10000000-0000-4000-8000-000000000000:10000000-0000-4000-8000-000000000001';
const SCOPE = { tenantId: 'synthetic-tenant', organisationId: 'synthetic-org', assessmentId: 'synthetic-assessment' };
const AT = ['2026-11-18T08:00:00.000Z', '2026-11-18T09:00:00.000Z', '2026-11-18T10:00:00.000Z'];
const EXAMPLE = ['no', 'ad_hoc', 'partly', 'partly', 'partly', 'mfa_text_code', 'unknown', 'partly', 'partly', 'no', 'no',
    'no', 'ad_hoc', 'partly', 'no', 'unknown'];
const aggregate = createTenantAggregate({ tenant: { tenantId: SCOPE.tenantId, displayName: 'Synthetic tenant' },
    organisations: [{ tenantId: SCOPE.tenantId, organisationId: SCOPE.organisationId, displayName: 'Synthetic organisation' }] });
const intent = (action, expectedRevision, payload) => ({ ...SCOPE, actorSubjectKey: ACTOR, action, expectedRevision, payload });
const answers = (context, values) => ({ responses: context.questionIds.map((itemId, index) =>
    ({ itemId, optionId: values[index], rationale: null })).sort((a, b) => (a.itemId < b.itemId ? -1 : 1)) });
function lineage(context, values) {
    const created = store.makeVersion(intent('create', null, { scopePopulation: { description: 'Synthetic office systems.' } }),
        'create-a', null, aggregate, AT[0], context);
    const saved = store.makeVersion(intent('save', 0, answers(context, values)), 'save-a', created, aggregate, AT[1]);
    const submitted = store.makeVersion(intent('submit', 1, {}), 'submit-a', saved, aggregate, AT[2]);
    return { created, saved, submitted };
}
const failure = (fn, code, statusCode) => expect(fn).toThrow(expect.objectContaining({ code, statusCode }));

describe('assessment store by profile', () => {
    const original = process.env.NOFRIES_NCSC_PROFILE_V2;
    afterEach(() => {
        if (original === undefined) delete process.env.NOFRIES_NCSC_PROFILE_V2;
        else process.env.NOFRIES_NCSC_PROFILE_V2 = original;
    });

    test('the flag is off unless it is exactly "true"', () => {
        [undefined, '', 'TRUE', '1', 'yes', ' true'].forEach(value => expect(ncscProfileV2Enabled({ NOFRIES_NCSC_PROFILE_V2: value })).toBe(false));
        expect(ncscProfileV2Enabled({ NOFRIES_NCSC_PROFILE_V2: 'true' })).toBe(true);
        expect(ncscProfileV2Enabled(null)).toBe(false);
        expect(readableNcscProfileContext(NCSC_V2_CONTEXT.profileRef, {})).toBeNull();
        expect(readableNcscProfileContext(NCSC_V2_CONTEXT.profileRef, { NOFRIES_NCSC_PROFILE_V2: 'true' })).toBe(NCSC_V2_CONTEXT);
        expect(readableNcscProfileContext(ACCEPTED_NCSC_CONTEXT.profileRef, {})).toBe(ACCEPTED_NCSC_CONTEXT);
    });

    test('a new assessment starts on the accepted profile and stays there', () => {
        delete process.env.NOFRIES_NCSC_PROFILE_V2;
        const created = store.makeVersion(intent('create', null, { scopePopulation: { description: 'Synthetic office systems.' } }),
            'create-a', null, aggregate, AT[0]);
        expect(created.envelope.state.profileRef).toEqual(ACCEPTED_NCSC_CONTEXT.profileRef);
        expect(created.envelope.evidence.entries).toHaveLength(14);
        // A v2-only answer or question is refused for this assessment.
        failure(() => store.makeVersion(intent('save', 0, { responses: [{ itemId: 'NF-NCSC-MCSS-RM-01-Q1', optionId: 'partly', rationale: null }] }),
            'save-a', created, aggregate, AT[1]), 'ncsc_input_invalid', 400);
        failure(() => store.makeVersion(intent('save', 0, { responses: [{ itemId: 'NF-NCSC-CC-SU-01-Q1', optionId: 'yes', rationale: null }] }),
            'save-a', created, aggregate, AT[1]), 'ncsc_input_invalid', 400);
        const saved = store.makeVersion(intent('save', 0, { responses: [{ itemId: 'NF-NCSC-MCSS-RM-01-Q1', optionId: 'partial', rationale: null }] }),
            'save-a', created, aggregate, AT[1]);
        expect(saved.envelope.state.profileRef).toEqual(ACCEPTED_NCSC_CONTEXT.profileRef);
    });

    test('with the flag on, a v2 assessment is saved, submitted and summarised on its own profile', () => {
        process.env.NOFRIES_NCSC_PROFILE_V2 = 'true';
        const { created, saved, submitted } = lineage(NCSC_V2_CONTEXT, EXAMPLE);
        expect(created.envelope.evidence.entries).toHaveLength(16);
        expect(saved.envelope.state.profileRef).toEqual(NCSC_V2_CONTEXT.profileRef);
        expect(submitted.envelope.submission.evaluation.attainment.lowerDisplay).toBe('25.3%');
        expect(submitted.envelope.submission.input.scoreContractVersion).toBe('PROD-003-R2');
        expect(projectNcscSummary(saved).progress).toMatchObject({ total: 16, answered: 16, missing: 0, unknown: 2 });
        // An accepted-profile answer is refused for a v2 assessment.
        failure(() => store.makeVersion(intent('save', 0, { responses: [{ itemId: 'NF-NCSC-MCSS-RM-01-Q1', optionId: 'partial', rationale: null }] }),
            'save-b', created, aggregate, AT[1]), 'ncsc_input_invalid', 400);
    });

    test('with the flag off, a stored v2 assessment cannot be continued or summarised', () => {
        process.env.NOFRIES_NCSC_PROFILE_V2 = 'true';
        const { created, saved } = lineage(NCSC_V2_CONTEXT, EXAMPLE);
        delete process.env.NOFRIES_NCSC_PROFILE_V2;
        failure(() => store.makeVersion(intent('save', 0, answers(NCSC_V2_CONTEXT, EXAMPLE)), 'save-a', created, aggregate, AT[1]),
            'ncsc_unavailable', 503);
        failure(() => store.makeVersion(intent('submit', 1, {}), 'submit-a', saved, aggregate, AT[2]), 'ncsc_unavailable', 503);
        failure(() => projectNcscSummary(saved), 'ncsc_unavailable', 503);
        const create = intent('create', null, { scopePopulation: { description: 'Synthetic office systems.' } });
        failure(() => store.makeVersion(create, 'create-a', null, aggregate, AT[0], NCSC_V2_CONTEXT), 'ncsc_unavailable', 503);
        failure(() => store.makeVersion(create, 'create-a', null, aggregate, AT[0], null), 'ncsc_unavailable', 503);
        failure(() => store.makeVersion(create, 'create-a', null, aggregate, AT[0], { profileRef: { ...NCSC_V2_CONTEXT.profileRef } }),
            'ncsc_unavailable', 503);
    });

    test('command checks accept only the accepted shape while the flag is off, and either shape while it is on', () => {
        const command = responses => normaliseNcscCommand({ assessmentId: 'synthetic-assessment', action: 'save',
            idempotencyKey: 'save-a', expectedRevision: 0, payload: { responses } });
        const v2Only = [{ itemId: 'NF-NCSC-MCSS-MF-01-Q2', optionId: 'mfa_key', rationale: null }];
        const v2Answer = [{ itemId: 'NF-NCSC-MCSS-RM-01-Q1', optionId: 'partly', rationale: null }];
        const fifteen = NCSC_V2_CONTEXT.questionIds.slice(0, 15).map(itemId => ({ itemId, optionId: null, rationale: null }));
        delete process.env.NOFRIES_NCSC_PROFILE_V2;
        [v2Only, v2Answer, fifteen].forEach(responses => failure(() => command(responses), 'ncsc_input_invalid', 400));
        expect(command([{ itemId: 'NF-NCSC-MCSS-SC-01-Q1', optionId: 'partial', rationale: null }]).payload.responses).toHaveLength(1);
        expect(knownNcscQuestionOptions('NF-NCSC-MCSS-RM-01-Q1').has('partly')).toBe(false);
        expect(knownNcscQuestionOptions('NF-NCSC-CC-SU-01-Q1')).toBeNull();
        expect(maximumNcscResponses()).toBe(14);

        process.env.NOFRIES_NCSC_PROFILE_V2 = 'true';
        expect(command(v2Only).payload.responses).toHaveLength(1);
        expect(command(v2Answer).payload.responses).toHaveLength(1);
        expect(command([{ itemId: 'NF-NCSC-MCSS-SC-01-Q1', optionId: 'partial', rationale: null }]).payload.responses).toHaveLength(1);
        failure(() => command([{ itemId: 'NF-NCSC-MCSS-MF-01-Q2', optionId: 'yes', rationale: null }]), 'ncsc_input_invalid', 400);
        failure(() => command([{ itemId: 'NF-NCSC-MCSS-MF-01-Q9', optionId: 'yes', rationale: null }]), 'ncsc_input_invalid', 400);
        failure(() => command([{ itemId: 'NF-NCSC-CC-NS-01-Q1', optionId: 'not_applicable', rationale: null }]), 'ncsc_input_invalid', 400);
        failure(() => command(NCSC_V2_CONTEXT.questionIds.concat('NF-NCSC-MCSS-SC-01-Q1').map(itemId =>
            ({ itemId, optionId: null, rationale: null }))), 'ncsc_input_invalid', 400);
        expect(knownNcscQuestionOptions('NF-NCSC-MCSS-RM-01-Q1').has('partial')).toBe(true);
        expect(knownNcscQuestionOptions('NF-NCSC-MCSS-RM-01-Q1').has('partly')).toBe(true);
        expect(knownNcscQuestionOptions('unknown-question')).toBeNull();
        expect(maximumNcscResponses()).toBe(16);
    });
});
