'use strict';

const { paidStartingSuggestions } = require('../api/shared/assessmentEngine/paidStartingSuggestions');
const { createNistNcscCrosswalk } = require('../api/shared/assessmentEngine/nistNcscCrosswalk');
const { makeVersion } = require('../api/shared/assessmentLifecycle/postgresNcscAssessmentStore');
const { ncscFixture, allResponses, createCommand, saveCommand, submitCommand, SUBJECT, NOW } = require('./fixtures/ncscAssessmentFixture');

const flag = { NOFRIES_PAID_FRAMEWORKS_ENABLED: 'true' };
const nist = createNistNcscCrosswalk().toProfileRef;
const tuple = { moduleId: 'cyber_security', profileId: nist.profileId, version: nist.profileVersion };
function history(organisationId, option = 'yes', tenantId = 'synthetic-tenant') {
    const fixture = ncscFixture({ organisationId, tenantId });
    const versions = [];
    for (const command of [createCommand(), saveCommand('assessment-a', 0, 'save-a', allResponses(option)), submitCommand()]) {
        versions.push(makeVersion({ ...fixture.scope, ...command, actorSubjectKey: SUBJECT }, command.idempotencyKey,
            versions.at(-1) || null, fixture.state.tenantAggregate, NOW));
    }
    return versions;
}

function inputs(retained) {
    const { envelope, revisionSha256 } = retained;
    const owner = { tenantId: envelope.tenantId, organisationId: envelope.organisationId };
    return {
        access: { ...owner, entitledFrameworks: [tuple], frameworkFlags: [tuple] },
        target: { ...owner, moduleId: 'cyber_security', profileRef: nist, status: 'created', responses: [],
            sourceScopePopulationSha256: envelope.scopePopulation.sha256 },
        selectedSource: { assessmentId: envelope.assessmentId, revision: envelope.revision, revisionSha256,
            scopePopulationSha256: envelope.scopePopulation.sha256 },
        retained
    };
}

const [created, draft, submitted] = history('synthetic-it-manager');
const read = (input, env = flag) => paidStartingSuggestions(input, env);
test('IT manager sees what the backup answer leaves to check, with the exact saved source', () => {
    const input = inputs(submitted), before = JSON.stringify(input);
    const hints = read(input);
    expect(hints).toHaveLength(3);
    expect(hints.find(h => h.targetQuestionId === 'PR.DS-11-Q1')).toEqual({
        label: 'Needs confirmation', suggestedOptionId: 'partial', sourceOptionId: 'yes',
        sourceQuestionId: 'NF-NCSC-MCSS-DR-01-Q1', targetQuestionId: 'PR.DS-11-Q1',
        furtherCheck: 'The wider data population and the full maintenance of backups are not expressly covered.',
        source: { ...input.selectedSource, submittedAt: NOW }
    });
    expect(JSON.stringify(input)).toBe(before);
    expect(input.target.responses).toEqual([]);
    input.target.responses = [{ itemId: 'PR.DS-11-Q1', optionId: 'no', rationale: null }];
    expect(read(input).map(h => h.targetQuestionId)).not.toContain('PR.DS-11-Q1');
});

test.each([undefined, false, true, 'TRUE', '1', 'false', ' true'])('flag %p prevents access before source inspection', value => {
    const input = inputs(submitted);
    input.retained = { get envelope() { throw new Error('source inspected'); } };
    expect(read(input, { NOFRIES_PAID_FRAMEWORKS_ENABLED: value })).toEqual([]);
});
test.each(['entitledFrameworks', 'frameworkFlags'])('requires the exact live %s tuple', field => {
    for (const change of [{ moduleId: 'overview' }, { version: 'latest' }, { profileId: 'free' }]) {
        const input = inputs(submitted);
        input.access[field] = [{ ...tuple, ...change }];
        input.retained = { get envelope() { throw new Error('source inspected'); } };
        expect(read(input)).toEqual([]);
    }
});

test('rejects different catalogue, target state, scope, saved ID, revision and digest', () => {
    for (const [part, changes] of [
        ['target', { profileRef: { ...nist, catalogueSha256: '0'.repeat(64) } }],
        ['target', { status: 'submitted' }], ['target', { sourceScopePopulationSha256: null }],
        ['target', { sourceScopePopulationSha256: '0'.repeat(64) }],
        ['selectedSource', { assessmentId: 'another' }], ['selectedSource', { revision: 1 }],
        ['selectedSource', { revisionSha256: '0'.repeat(64) }], ['retained', { revisionSha256: '0'.repeat(64) }]
    ]) {
        const input = inputs(submitted);
        input[part] = { ...input[part], ...changes };
        expect(read(input)).toEqual([]);
    }
    const input = inputs(submitted);
    input.selectedSource = null;
    expect(read(input)).toEqual([]);
});
test('requires a sealed and intact submission', () => {
    for (const version of [created, draft]) expect(read(inputs(version))).toEqual([]);
    const input = inputs(submitted);
    const envelope = JSON.parse(JSON.stringify(submitted.envelope));
    envelope.submission.evaluation.outputSha256 = '0'.repeat(64);
    input.retained = { ...submitted, envelope };
    expect(() => read(input)).toThrow('ncsc_record_invalid');
});
test.each(['partial', 'no', 'unknown', 'not_applicable'])('does not infer a target option from NCSC %s', option => {
    expect(read(inputs(history('synthetic-owner', option)[2]))).toEqual([]);
});
test('consultant switching clients cannot reuse the previous source, even with the same assessment ID and scope text', () => {
    const a = inputs(submitted);
    for (const b of [inputs(history('synthetic-client-b')[2]), inputs(history(a.access.organisationId, 'yes', 'other-tenant')[2])]) {
        expect(b.selectedSource.assessmentId).toBe(a.selectedSource.assessmentId);
        expect(b.retained.envelope.scopePopulation.body).toEqual(a.retained.envelope.scopePopulation.body);
        expect(read({ ...a, access: b.access })).toEqual([]);
        expect(read({ ...a, target: b.target })).toEqual([]);
        expect(read({ ...b, retained: a.retained, selectedSource: a.selectedSource })).toEqual([]);
        expect(read(b)).toHaveLength(3);
    }
});

test('owner responding to a customer sees only three partly-in-place ISO starting points and the evidence still to check', () => {
    const iso = require('./fixtures/paidIsoSuggestionPublication.json');
    const input = inputs(history('synthetic-owner')[2]);
    input.target.profileRef = iso;
    expect(read(input)).toEqual([]); // NIST access is not transferable.
    const isoTuple = { moduleId: 'cyber_security', profileId: iso.profileId, version: iso.profileVersion };
    input.access.entitledFrameworks = [isoTuple];
    expect(read(input)).toEqual([]);
    input.access.frameworkFlags = [isoTuple];
    const hints = read(input);
    expect(hints.map(h => h.targetQuestionId)).toEqual(['A.5.9-Q1', 'A.8.8-Q1', 'A.8.13-Q1']);
    for (const hint of hints) {
        expect(hint).toMatchObject({ label: 'Needs confirmation', suggestedOptionId: 'partly_in_place',
            source: input.selectedSource, sourceOptionId: 'yes' });
        expect(hint.furtherCheck).toMatch(/^Check /);
    }
    expect(input.target.responses).toEqual([]);
    const retired = [
        { catalogueSha256: '1971ad65405f1c20d8e13a65a26a7b40e9ff48b63505db4f0336d32d64fae73d',
            sourceCatalogueSha256: '66ce68bdf0d8ea2d271c52f68d6505b7a50f69f8d8d5ce40bcf833320caef1fd' },
        { catalogueSha256: '58e37797ea4bf926ab0477522857cb9dd0ac2a84d3e1815829dee9b2390bd107',
            sourceCatalogueSha256: '0221ff4667e5471a50711bd4e64ae56b5f253889cdcc9817ce3bfdfda4dc5654' }
    ];
    for (const pair of retired) {
        for (const stale of [pair, { catalogueSha256: pair.catalogueSha256 }, { sourceCatalogueSha256: pair.sourceCatalogueSha256 }]) {
            input.target.profileRef = { ...iso, ...stale };
            expect(read(input)).toEqual([]);
        }
    }
    for (const field of Object.keys(iso)) {
        input.target.profileRef = { ...iso, [field]: 'different' };
        expect(read(input)).toEqual([]);
    }
});
