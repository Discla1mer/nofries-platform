'use strict';

// Scoring v2 (#399): Improvement Plans for an assessment scored with the
// 16-question profile 2026-11-18.1. A plan is made with the profile and
// evaluator its source assessment stored, only while NOFRIES_NCSC_PROFILE_V2 is
// exactly "true". Plans made from accepted-profile (v1) results are unchanged.
const crypto = require('node:crypto');
const { createTenantAggregate } = require('../api/shared/appLifecycle/tenantDomain');
const ncscStore = require('../api/shared/assessmentLifecycle/postgresNcscAssessmentStore');
const store = require('../api/shared/improvementPlan/improvementPlanStore');
const { createImprovementPlan, getImprovementPlanView, applyImprovementActionCommand } =
    require('../api/shared/improvementPlan/improvementPlanDomain');
const { planCarryForward, canCarryFrom } = require('../api/shared/improvementPlan/improvementPlanCarryForward');
const { projectImprovementActionList } = require('../api/shared/improvementPlan/improvementActionListProjection');
const { projectImprovementActionPlanPresentation } = require('../api/shared/improvementPlan/improvementActionPlanPresentation');
const { serialiseAssessmentEvaluation } = require('../api/shared/assessmentEngine/assessmentEvaluator');
const { acceptedProfile, acceptedRegistry } = require('../api/shared/assessmentLifecycle/ncscAssessmentSubmission');
const { ACCEPTED_NCSC_CONTEXT, NCSC_V2_CONTEXT } = require('../api/shared/assessmentEngine/ncscProfileSet');

const ACTOR = '10000000-0000-4000-8000-000000000000:10000000-0000-4000-8000-000000000001';
const OWNER = '10000000-0000-4000-8000-000000000000:10000000-0000-4000-8000-000000000002';
const SCOPE = { tenantId: 'synthetic-tenant', organisationId: 'synthetic-org' };
const aggregate = createTenantAggregate({ tenant: { tenantId: SCOPE.tenantId, displayName: 'Synthetic tenant' },
    organisations: [{ tenantId: SCOPE.tenantId, organisationId: SCOPE.organisationId, displayName: 'Synthetic organisation' }] });
const clone = value => JSON.parse(JSON.stringify(value));
const sha = value => crypto.createHash('sha256').update(serialiseAssessmentEvaluation(value)).digest('hex');
const V2_AT = ['2026-11-19T08:00:00.000Z', '2026-11-19T09:00:00.000Z', '2026-11-19T10:00:00.000Z', '2026-11-19T11:00:00.000Z'];
const V1_AT = ['2026-09-07T08:00:00.000Z', '2026-09-07T09:00:00.000Z', '2026-09-07T10:00:00.000Z', '2026-09-07T11:00:00.000Z'];

// One answer per v2 question, in profile order (RM, SA, AI, PA, MF-Q1, MF-Q2,
// DU, LP, DR-Q1, DR-Q2, RP, PM, SV, NS, SU, EM), covering every rung.
const MIXED = ['yes', 'ad_hoc', 'partly', 'no', 'unknown', 'mfa_number_matching', 'yes', 'partly', 'no', 'ad_hoc',
    'unknown', 'yes', 'partly', 'not_applicable', 'no', 'unknown'];
const V1_OPTIONS = ['yes', 'partial', 'no', 'unknown', 'not_applicable'];

function answers(context, values) {
    return { responses: context.questionIds.map((itemId, index) => ({ itemId, optionId: values[index],
        rationale: values[index] === 'not_applicable' ? { text: 'Synthetic: no office network.' } : null }))
        .sort((a, b) => (a.itemId < b.itemId ? -1 : 1)) };
}
function submitted(context, values, assessmentId = 'assessment-a', at = V2_AT) {
    const intent = (action, expectedRevision, payload) => ({ ...SCOPE, assessmentId, actorSubjectKey: ACTOR, action, expectedRevision, payload });
    const created = ncscStore.makeVersion(intent('create', null, { scopePopulation: { description: 'Synthetic office systems.' } }),
        'create-' + assessmentId, null, aggregate, at[0], context);
    const saved = ncscStore.makeVersion(intent('save', 0, answers(context, values)), 'save-' + assessmentId, created, aggregate, at[1]);
    return ncscStore.makeVersion(intent('submit', 1, {}), 'submit-' + assessmentId, saved, aggregate, at[2]);
}
function planIntent(planId = 'plan-a') {
    return { ...SCOPE, actorSubjectKey: ACTOR, command: { planId, type: 'generate', operationId: 'generate-' + planId } };
}
function seedFor(version, planId = 'plan-a', at = V2_AT[3]) {
    return store.seed(planIntent(planId), at, version.envelope.submission.input);
}
const v1Values = () => acceptedProfile.questions.map((question, index) => V1_OPTIONS[index % 5]);
const byItem = state => new Map((state.proposals || state.actions).map(proposal => [proposal.itemId, proposal]));
const failure = (fn, code) => expect(fn).toThrow(expect.objectContaining({ code }));
// Pinned from main (442202d) before #491, for the same synthetic accepted-profile result.
const GOLDEN_STATE = '15845fd665a815e6a54de10ce71ef3c617d611b00c0d9dfdb4f5629981b7a158';
const GOLDEN_RESULT = 'be7573fc64de79e72f5963164091a44b0ecadfc5836b95b21be75144be4ed24a';

describe('Improvement Plans by stored profile', () => {
    const original = process.env.NOFRIES_NCSC_PROFILE_V2;
    const setFlag = value => { if (value === undefined) delete process.env.NOFRIES_NCSC_PROFILE_V2; else process.env.NOFRIES_NCSC_PROFILE_V2 = value; };
    afterEach(() => setFlag(original));

    test('a plan from an accepted-profile result is byte-identical with the flag off, mistyped or on', () => {
        for (const value of [undefined, '', 'TRUE', '1', ' true', 'true']) {
            setFlag(value);
            const version = submitted(ACCEPTED_NCSC_CONTEXT, v1Values(), 'synthetic-assessment', V1_AT);
            const state = seedFor(version, 'plan-a', V1_AT[3]);
            expect(sha(state)).toBe(GOLDEN_STATE);
            expect(sha(store.result(state))).toBe(GOLDEN_RESULT);
            // The same as the domain called directly with the accepted registry and no contract argument.
            expect(state).toEqual(createImprovementPlan({ ...SCOPE, planId: 'plan-a', actorSubjectKey: ACTOR, createdAt: V1_AT[3] },
                version.envelope.submission.input, { registry: acceptedRegistry }));
            expect(new Set(state.proposals.map(row => row.suggestedAction)).size).toBeLessThanOrEqual(4);
        }
    });

    test('flag off or mistyped: a stored v2 result cannot seed a plan', () => {
        setFlag('true');
        const version = submitted(NCSC_V2_CONTEXT, MIXED);
        for (const value of [undefined, '', 'TRUE', 'yes']) {
            setFlag(value);
            expect(() => seedFor(version)).toThrow();
        }
    });

    test('flag on: a v2 result seeds actions from gaps, unknowns, claims and Yes answers, worded for v2', () => {
        setFlag('true');
        const version = submitted(NCSC_V2_CONTEXT, MIXED);
        const state = seedFor(version);
        expect(state.source.provenance).toMatchObject({ scoreContractVersion: 'PROD-003-R2', profileRef: NCSC_V2_CONTEXT.profileRef,
            assessmentId: 'assessment-a' });
        // Every question gets exactly one action here: none has current evidence, and no N/A is approved.
        expect(state.proposals.map(row => row.itemId).sort()).toEqual([...NCSC_V2_CONTEXT.questionIds].sort());
        const rows = byItem(state);
        const kinds = Object.fromEntries([...rows].map(([itemId, row]) => [itemId, [row.kind, row.response, row.responseOrigin]]));
        expect(kinds).toEqual({
            'NF-NCSC-MCSS-RM-01-Q1': ['evidence', 'yes', 'direct'],
            'NF-NCSC-MCSS-SA-01-Q1': ['implementation', 'partial', 'direct'],
            'NF-NCSC-MCSS-AI-01-Q1': ['implementation', 'partial', 'direct'],
            'NF-NCSC-MCSS-PA-01-Q1': ['implementation', 'no', 'direct'],
            'NF-NCSC-MCSS-MF-01-Q1': ['assessment', 'unknown', 'direct_unknown'],
            'NF-NCSC-MCSS-MF-01-Q2': ['implementation', 'partial', 'direct'],
            'NF-NCSC-MCSS-DU-01-Q1': ['evidence', 'yes', 'direct'],
            'NF-NCSC-MCSS-LP-01-Q1': ['implementation', 'partial', 'direct'],
            'NF-NCSC-MCSS-DR-01-Q1': ['implementation', 'no', 'direct'],
            'NF-NCSC-MCSS-DR-01-Q2': ['implementation', 'partial', 'direct'],
            'NF-NCSC-MCSS-RP-01-Q1': ['assessment', 'unknown', 'direct_unknown'],
            'NF-NCSC-CC-PM-01-Q1': ['evidence', 'yes', 'direct'],
            'NF-NCSC-CC-SV-01-Q1': ['implementation', 'partial', 'direct'],
            'NF-NCSC-CC-NS-01-Q1': ['applicability', 'unknown', 'claimed_not_applicable'],
            'NF-NCSC-CC-SU-01-Q1': ['implementation', 'no', 'direct'],
            'NF-NCSC-CC-EM-01-Q1': ['assessment', 'unknown', 'direct_unknown']
        });
        // New v2 controls keep their own control ids and the profile's first step.
        expect(rows.get('NF-NCSC-CC-SU-01-Q1')).toMatchObject({ controlId: 'NF-NCSC-CC-SU-01', domainId: 'prevent-protect',
            suggestedAction: 'List who has access, turn on the extra login step, and add a breach-notice clause.' });
        expect(rows.get('NF-NCSC-CC-EM-01-Q1')).toMatchObject({ controlId: 'NF-NCSC-CC-EM-01',
            suggestedAction: 'Find out whether this is in place, for example by asking your IT provider, then update your answer.' });
        expect(rows.get('NF-NCSC-MCSS-PA-01-Q1').suggestedAction)
            .toBe('Turn on automatic updates. If you have a website, ask your host or developer to confirm it is patched.');
        expect(rows.get('NF-NCSC-MCSS-MF-01-Q2').suggestedAction)
            .toBe('Where the service allows it, move those accounts to a passkey or security key, starting with email and admin logins.');
        expect(rows.get('NF-NCSC-MCSS-RM-01-Q1').suggestedAction)
            .toBe('Keep a current record that shows this is in place, such as a screenshot of the setting or a note from your IT provider.');
        expect(rows.get('NF-NCSC-CC-NS-01-Q1').suggestedAction)
            .toBe('Check that this really does not apply to your business and record why, or change your answer.');
        // Dropped v1 controls never appear in a v2 plan.
        expect(state.proposals.some(row => /-(?:AC|SC)-01-/.test(row.itemId))).toBe(false);
        // The retained view replays the same state.
        expect(getImprovementPlanView(state).actions).toHaveLength(16);
    });

    test('flag on: the login-method question words its step by the method recorded', () => {
        setFlag('true');
        const wording = {
            mfa_none: 'Turn on an extra login step for those accounts, using an app, passkey or security key rather than text or email codes.',
            mfa_text_code: 'Move those accounts off text or email codes to an app, passkey or security key.',
            mfa_mixed: 'Move those accounts off text or email codes to an app, passkey or security key.',
            mfa_authenticator: 'Where the service allows it, move those accounts to a passkey or security key, starting with email and admin logins.',
            mfa_push: 'Where the service allows it, move those accounts to a passkey or security key, starting with email and admin logins.',
            mfa_number_matching: 'Where the service allows it, move those accounts to a passkey or security key, starting with email and admin logins.'
        };
        for (const [optionId, expected] of Object.entries(wording)) {
            const values = [...MIXED]; values[5] = optionId;
            const row = byItem(seedFor(submitted(NCSC_V2_CONTEXT, values))).get('NF-NCSC-MCSS-MF-01-Q2');
            expect([optionId, row.kind, row.suggestedAction]).toEqual([optionId, 'implementation', expected]);
        }
        // Passkey or security key is full credit: only an evidence action, like any Yes.
        const values = [...MIXED]; values[5] = 'mfa_key';
        expect(byItem(seedFor(submitted(NCSC_V2_CONTEXT, values))).get('NF-NCSC-MCSS-MF-01-Q2'))
            .toMatchObject({ kind: 'evidence', response: 'yes' });
        // "I don't know" on the method question asks for the answer, not a method change.
        values[5] = 'unknown';
        expect(byItem(seedFor(submitted(NCSC_V2_CONTEXT, values))).get('NF-NCSC-MCSS-MF-01-Q2'))
            .toMatchObject({ kind: 'assessment', response: 'unknown' });
    });

    test('flag on: every implementation gap on a v2 plan uses that question\'s first step from the profile', () => {
        setFlag('true');
        const state = seedFor(submitted(NCSC_V2_CONTEXT, NCSC_V2_CONTEXT.questionIds.map((itemId, index) => index === 5 ? 'mfa_text_code' : 'no')));
        const steps = new Map(NCSC_V2_CONTEXT.profile.questions.map(question => [question.id, question.guidance.startingActions[0]]));
        state.proposals.forEach(row => {
            expect(row.kind).toBe('implementation');
            expect(row.suggestedAction).toBe(steps.get(row.itemId));
        });
    });

    test('v2 replay accepts its own wording and rejects altered wording, profile or contract', () => {
        setFlag('true');
        const state = clone(seedFor(submitted(NCSC_V2_CONTEXT, MIXED)));
        const view = getImprovementPlanView(state);
        expect(view.actions).toHaveLength(16);
        const tamper = change => { const copy = clone(state); change(copy); return () => getImprovementPlanView(copy); };
        // The v1 wording is not valid on a v2 plan, and v2 wording is not valid on another question.
        failure(tamper(copy => { copy.proposals[1].suggestedAction = 'Define and implement the missing parts of this control, then record supporting evidence.'; }),
            'improvement_proposal_invalid');
        failure(tamper(copy => { copy.proposals[1].suggestedAction = copy.proposals[3].suggestedAction; }), 'improvement_proposal_invalid');
        // The part-credit login-method wording may be either of its two forms, never the "no" form.
        expect(() => tamper(copy => { copy.proposals[5].suggestedAction = 'Move those accounts off text or email codes to an app, passkey or security key.'; })()).not.toThrow();
        failure(tamper(copy => { copy.proposals[5].suggestedAction =
            'Turn on an extra login step for those accounts, using an app, passkey or security key rather than text or email codes.'; }), 'improvement_proposal_invalid');
        // The source must name the exact v2 profile under the v2 contract.
        failure(tamper(copy => { copy.source.provenance.profileRef = clone(ACCEPTED_NCSC_CONTEXT.profileRef); }), 'improvement_source_invalid');
        failure(tamper(copy => { copy.source.provenance.profileRef.catalogueSha256 = '0'.repeat(64); }), 'improvement_source_invalid');
        // Under the v1 contract, v2 wording is refused.
        failure(tamper(copy => { copy.source.provenance.scoreContractVersion = 'PROD-003-R1'; }), 'improvement_proposal_invalid');
    });

    test('the domain refuses an unknown contract and a result scored under another contract', () => {
        setFlag('true');
        const version = submitted(NCSC_V2_CONTEXT, MIXED), input = version.envelope.submission.input;
        const scope = { ...SCOPE, planId: 'plan-a', actorSubjectKey: ACTOR, createdAt: V2_AT[3] };
        failure(() => createImprovementPlan(scope, input, { registry: NCSC_V2_CONTEXT.registry }, 'PROD-003-R9'), 'improvement_source_invalid');
        // The accepted evaluator cannot score the v2 ladder.
        expect(() => createImprovementPlan(scope, input, { registry: NCSC_V2_CONTEXT.registry })).toThrow();
        expect(createImprovementPlan(scope, input, { registry: NCSC_V2_CONTEXT.registry }, 'PROD-003-R2').proposals).toHaveLength(16);
    });

    test('a v2 plan is tracked, listed and presented like any other plan', () => {
        setFlag('true');
        let state = seedFor(submitted(NCSC_V2_CONTEXT, MIXED));
        const supplier = byItem(state).get('NF-NCSC-CC-SU-01-Q1');
        const apply = (type, payload, at) => {
            state = applyImprovementActionCommand(state, { ...SCOPE, planId: state.planId,
                evaluationOutputSha256: state.source.evaluationOutputSha256, actionId: supplier.actionId,
                operationId: `${type}-${state.commands.length}`, expectedRevision: state.commands.length, actorSubjectKey: ACTOR,
                at, type, payload }, { ...SCOPE, actorSubjectKey: ACTOR, eligibleOwnerSubjectKeys: [OWNER] });
        };
        apply('assign', { ownerSubjectKey: OWNER, dueDate: '2026-12-01' }, '2026-11-19T12:00:00.000Z');
        apply('start', {}, '2026-11-19T12:01:00.000Z');
        const list = projectImprovementActionList(state, { scope: { ...SCOPE, planId: state.planId },
            asOf: '2026-11-20T00:00:00.000Z', filters: { status: 'all', owner: 'all', overdueOnly: false } });
        expect(list.counts.all.total).toBe(16);
        expect(list.actions[0]).toMatchObject({ itemId: 'NF-NCSC-CC-SU-01-Q1', controlId: 'NF-NCSC-CC-SU-01', status: 'in_progress',
            rationale: { kind: 'implementation', response: 'no',
                suggestedAction: 'List who has access, turn on the extra login step, and add a breach-notice clause.' } });
        const presented = projectImprovementActionPlanPresentation(list);
        expect(presented.actions.find(row => row.itemId === 'NF-NCSC-CC-EM-01-Q1').labels)
            .toMatchObject({ kind: 'Assessment needed', response: 'Unknown' });
        expect(presented.actions.find(row => row.itemId === 'NF-NCSC-MCSS-SA-01-Q1').labels.response).toBe('Partly implemented');
    });

    test('carry-forward runs between plans on the same profile only; v1 to v2 is left for the carry-forward step', () => {
        setFlag('true');
        const earlierV2 = submitted(NCSC_V2_CONTEXT, MIXED, 'assessment-a');
        const laterV2 = submitted(NCSC_V2_CONTEXT, MIXED, 'assessment-b',
            ['2026-11-20T08:00:00.000Z', '2026-11-20T09:00:00.000Z', '2026-11-20T10:00:00.000Z']);
        const earlierV1 = submitted(ACCEPTED_NCSC_CONTEXT, v1Values(), 'assessment-c', V1_AT);
        let previous = seedFor(earlierV2, 'plan-a');
        const target = byItem(previous).get('NF-NCSC-CC-SU-01-Q1');
        previous = applyImprovementActionCommand(previous, { ...SCOPE, planId: 'plan-a',
            evaluationOutputSha256: previous.source.evaluationOutputSha256, actionId: target.actionId, operationId: 'assign-a',
            expectedRevision: 0, actorSubjectKey: ACTOR, at: '2026-11-19T12:00:00.000Z', type: 'assign',
            payload: { ownerLabel: 'Office manager', dueDate: '2026-12-01' } }, { ...SCOPE, actorSubjectKey: ACTOR, eligibleOwnerSubjectKeys: [] });
        const next = getImprovementPlanView(seedFor(laterV2, 'plan-b', '2026-11-20T11:00:00.000Z'));
        const fromV2 = getImprovementPlanView(previous);
        expect(canCarryFrom(fromV2, next)).toBe(true);
        expect(planCarryForward(fromV2, next)).toEqual([{ actionId: byItem(next).get('NF-NCSC-CC-SU-01-Q1').actionId,
            itemId: 'NF-NCSC-CC-SU-01-Q1', ownerSubjectKey: null,
            steps: [{ type: 'assign', payload: { ownerLabel: 'Office manager', dueDate: '2026-12-01' } }] }]);
        // A v1 plan with work on shared question ids carries nothing into a v2 plan, and the reverse.
        let v1 = seedFor(earlierV1, 'plan-c', V1_AT[3]);
        const shared = v1.proposals.find(row => NCSC_V2_CONTEXT.questionIds.includes(row.itemId));
        v1 = applyImprovementActionCommand(v1, { ...SCOPE, planId: 'plan-c', evaluationOutputSha256: v1.source.evaluationOutputSha256,
            actionId: shared.actionId, operationId: 'assign-c', expectedRevision: 0, actorSubjectKey: ACTOR,
            at: '2026-09-07T12:00:00.000Z', type: 'assign', payload: { ownerLabel: 'Office manager', dueDate: '2026-12-01' } },
        { ...SCOPE, actorSubjectKey: ACTOR, eligibleOwnerSubjectKeys: [] });
        const fromV1 = getImprovementPlanView(v1);
        expect(next.actions.some(row => row.itemId === shared.itemId)).toBe(true);
        expect(canCarryFrom(fromV1, next)).toBe(false);
        expect(planCarryForward(fromV1, next)).toEqual([]);
        const v1Later = clone(fromV1); v1Later.source.provenance.assessmentId = 'assessment-z';
        v1Later.source.provenance.scoreAsOf = '2027-01-01T00:00:00.000Z';
        expect(canCarryFrom(fromV2, v1Later)).toBe(false);
        // Between two accepted-profile plans the rule is unchanged.
        const v1Previous = clone(fromV1); v1Previous.source.provenance.assessmentId = 'assessment-y';
        expect(canCarryFrom(v1Previous, v1Later)).toBe(true);
        expect(planCarryForward(v1Previous, v1Later)).toHaveLength(1);
    });

    // Replaces #491's check that this SQL was byte-identical to main with the flag
    // off. The lookup is now profile-scoped whatever the flag (a v1 plan never
    // carries from a v2 plan after a rollback). Equivalence on v1-only data is
    // proven by behaviour: every v1 assessment stores the full accepted
    // profileRef, so the extra condition holds for every v1 pair; v1 plans keep
    // their GOLDEN digests; and improvementPlanPostgres.test.js runs this lookup
    // beside main's flag-off SQL on real v1 data and gets the same plan each time.
    test('previous-plan lookup is profile-scoped whatever the flag, and v1 plans are unchanged', async () => {
        const source = { assessmentId: 'assessment-b', revision: '2', revisionSha256: 'a'.repeat(64) };
        const run = async value => {
            setFlag(value);
            const queries = [];
            const tx = { query: async (sql, params) => { queries.push({ sql, params }); return { rows: [] }; } };
            expect(await store.previousPlanId(tx, { ...SCOPE, planId: 'plan-b' }, source)).toBeNull();
            expect(queries).toHaveLength(1);
            return queries[0];
        };
        const off = await run(undefined);
        for (const value of ['', 'TRUE', 'yes', 'true']) expect(await run(value)).toEqual(off);
        expect(off.sql).toContain("AND a.payload#>'{submission,input,profileRef}' = n.payload#>'{submission,input,profileRef}'");
        // Fixed, parameterised SQL: only the request's scope and source are bound.
        expect(off.params).toEqual([SCOPE.tenantId, SCOPE.organisationId, 'plan-b', 'assessment-b', '2', 'a'.repeat(64)]);
        for (const value of [undefined, 'true']) {
            setFlag(value);
            const version = submitted(ACCEPTED_NCSC_CONTEXT, v1Values(), 'synthetic-assessment', V1_AT);
            // The full accepted reference, with all six fields, is stored on every v1 submission.
            expect(version.envelope.submission.input.profileRef).toEqual({ ...ACCEPTED_NCSC_CONTEXT.profileRef });
            expect(Object.keys(version.envelope.submission.input.profileRef).sort()).toEqual(['catalogueSha256', 'frameworkId',
                'frameworkVersion', 'profileId', 'profileVersion', 'sourceCatalogueSha256']);
            const state = seedFor(version, 'plan-a', V1_AT[3]);
            expect(sha(state)).toBe(GOLDEN_STATE);
            expect(sha(store.result(state))).toBe(GOLDEN_RESULT);
        }
    });

    test('the stored source profile of a plan is read with fixed SQL and only returned as an object', async () => {
        const ref = clone(NCSC_V2_CONTEXT.profileRef);
        for (const [rows, expected] of [[[{ profile_ref: ref }], ref], [[], null], [[{ profile_ref: null }], null],
            [[{ profile_ref: 'x' }], null], [[{ profile_ref: [ref] }], null], [[{ profile_ref: ref }, { profile_ref: ref }], null]]) {
            const queries = [];
            const tx = { query: async (sql, params) => { queries.push({ sql, params }); return { rows }; } };
            expect(await store.sourceProfileRef(tx, { ...SCOPE, planId: 'plan-a' })).toEqual(expected);
            expect(queries[0].params).toEqual([SCOPE.tenantId, SCOPE.organisationId, 'plan-a']);
        }
    });
});
