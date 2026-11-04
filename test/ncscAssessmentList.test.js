'use strict';

const { createNcscQuestionnaireMetadata } = require('../api/shared/ncscQuestionnaireMetadata');
const { createClient } = require('../api/shared/protectedAssets/ncscAssessmentClient');
const { projectNcscSummary } = require('../api/shared/ncscAssessmentService');
const { makeVersion, stableIntent } = require('../api/shared/assessmentLifecycle/postgresNcscAssessmentStore');
const { ncscFixture, createClock, createContext, createCommand } = require('./fixtures/ncscAssessmentFixture');

async function summary(description = 'Whole organisation') {
    const fixture = ncscFixture(), clock = createClock();
    const context = await createContext(fixture.scope, clock);
    const command = createCommand('assessment-a', 'create-a', description);
    return projectNcscSummary(makeVersion(stableIntent(context, command), command.idempotencyKey,
        null, fixture.state.tenantAggregate, clock.now()));
}

function clientFor(assessments) {
    return createClient({ metadata: createNcscQuestionnaireMetadata(), fetch: async () => new Response(
        JSON.stringify({ schemaVersion: 1, assessments, nextAfterAssessmentId: null }),
        { status: 200, headers: { 'content-type': 'application/json' } }) });
}

test('browser preserves scope labels and accepts older summaries during rollout', async () => {
    const row = await summary('Café and online ordering');
    expect((await clientFor([row]).list()).assessments[0].scopePopulation.description).toBe('Café and online ordering');
    const { scopePopulation, ...older } = row;
    expect((await clientFor([older]).list()).assessments[0]).toEqual(older);
});

test.each([null, { description: '' }, { description: 17 }, { description: 'Valid', private: 'unapproved' }])(
    'browser rejects malformed scope label %p', async scopePopulation => {
        const row = await summary();
        await expect(clientFor([{ ...row, scopePopulation }]).list()).rejects.toMatchObject({ code: 'ncsc_unavailable' });
    });

test('maximum list page with long Unicode scope labels fits the existing response budget', async () => {
    const row = await summary('🏢'.repeat(2000));
    const rows = Array.from({ length: 100 }, (_, index) => ({ ...row,
        assessmentId: 'assessment-' + String(index).padStart(3, '0') }));
    const result = await clientFor(rows).list({ limit: 100 });
    expect(result.assessments).toHaveLength(100);
    expect(result.assessments[99].scopePopulation.description).toBe('🏢'.repeat(160) + '…');
});
