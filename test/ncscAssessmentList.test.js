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

test('display labels never alter the immutable scope record through save and submission', async () => {
    const { saveCommand, submitCommand } = require('./fixtures/ncscAssessmentFixture');
    const { projectNcscDetail, normaliseNcscCommand } = require('../api/shared/ncscAssessmentService');
    const fixture = ncscFixture(), clock = createClock(), context = await createContext(fixture.scope, clock);
    const description = '  Café scope\n' + '🏢'.repeat(170) + ' retained suffix  ';
    const create = createCommand('assessment-bound', 'create-bound', description);
    let version = makeVersion(stableIntent(context, create), create.idempotencyKey, null, fixture.state.tenantAggregate, clock.now());
    const record = JSON.stringify(version.envelope.scopePopulation), hash = version.envelope.state.scopePopulationSha256;
    for (const command of [saveCommand('assessment-bound', 0, 'save-bound'), submitCommand('assessment-bound', 1, 'submit-bound')]) {
        const hostile = { ...command, payload: { ...command.payload, scopePopulation: { description: 'replacement' } } };
        expect(() => normaliseNcscCommand(hostile)).toThrow(expect.objectContaining({ code: 'ncsc_input_invalid' }));
        const before = JSON.stringify(version);
        const label = projectNcscSummary(version).scopePopulation.description;
        expect(label).not.toContain('retained suffix');
        expect(JSON.stringify(version)).toBe(before);
        version = makeVersion(stableIntent(context, command), command.idempotencyKey, version, fixture.state.tenantAggregate, clock.now());
        expect(JSON.stringify(version.envelope.scopePopulation)).toBe(record);
        expect(version.envelope.state.scopePopulationSha256).toBe(hash);
        expect(projectNcscDetail(version).scopePopulation.description).toBe(description);
    }
});

test('onAccepted is reported only after the body is read and validated within the time limit', async () => {
    const metadata = createNcscQuestionnaireMetadata();
    const reply = text => new Response(text, { status: 200, headers: { 'content-type': 'application/json' } });
    const valid = JSON.stringify({ schemaVersion: 1, assessments: [], nextAfterAssessmentId: null });
    const accepted = jest.fn();
    expect(() => createClient({ metadata, fetch: async () => reply(valid), onAccepted: 'yes' })).toThrow();
    await createClient({ metadata, fetch: async () => reply(valid), onAccepted: accepted }).list();
    expect(accepted).toHaveBeenCalledTimes(1);
    expect(accepted).toHaveBeenCalledWith('list');
    for (const body of ['{', JSON.stringify({ schemaVersion: 2, assessments: [], nextAfterAssessmentId: null })]) {
        await expect(createClient({ metadata, fetch: async () => reply(body), onAccepted: accepted }).list())
            .rejects.toMatchObject({ code: 'ncsc_unavailable' });
    }
    expect(accepted).toHaveBeenCalledTimes(1);
    // Headers arrive but the body never completes: the 12-second limit fails
    // the read and nothing is reported, even if the body arrives later.
    jest.useFakeTimers();
    try {
        let release;
        const stalled = { status: 200, headers: new Headers({ 'content-type': 'application/json' }),
            text: () => new Promise(resolve => { release = () => resolve(valid); }) };
        const pending = createClient({ metadata, fetch: async () => stalled, onAccepted: accepted }).list();
        const outcome = expect(pending).rejects.toMatchObject({ code: 'ncsc_unavailable' });
        await jest.advanceTimersByTimeAsync(12000);
        await outcome;
        if (release) release();
        await jest.advanceTimersByTimeAsync(0);
        expect(accepted).toHaveBeenCalledTimes(1);
    } finally { jest.useRealTimers(); }
});
