'use strict';

const { createNcscQuestionnaireMetadata } = require('../api/shared/ncscQuestionnaireMetadata');
const { createAcceptedNcscFrameworkProfile, EXPECTED_ACCEPTED_NCSC_FRAMEWORK_PROFILE_SHA256,
    EXPECTED_ACCEPTED_NCSC_SOURCE_SHA256 } = require('../api/shared/assessmentEngine/ncscAcceptedFrameworkProfile');
const { createClient } = require('../api/shared/protectedAssets/ncscAssessmentClient');

const clone = value => JSON.parse(JSON.stringify(value));
const client = metadata => createClient({ metadata, fetch: jest.fn() });

function projectChangedCatalogue(change) {
    const catalogue = clone(createAcceptedNcscFrameworkProfile());
    change(catalogue);
    let project;
    try {
        jest.isolateModules(() => {
            jest.doMock('../api/shared/assessmentEngine/ncscAcceptedFrameworkProfile', () => ({
                createAcceptedNcscFrameworkProfile: () => catalogue
            }));
            project = require('../api/shared/ncscQuestionnaireMetadata').createNcscQuestionnaireMetadata;
        });
        return project();
    } finally {
        jest.dontMock('../api/shared/assessmentEngine/ncscAcceptedFrameworkProfile');
    }
}

describe('questionnaire source display metadata', () => {
    test('each question links exactly to its accepted sources with the recorded verification date', () => {
        const accepted = createAcceptedNcscFrameworkProfile(), metadata = createNcscQuestionnaireMetadata();
        expect(metadata.questions).toHaveLength(14);
        metadata.questions.forEach(question => {
            const original = accepted.questions.find(value => value.id === question.id);
            expect(question.prompt).toBe(original.prompt);
            expect(question.sources).toEqual(original.sourceIds.map(id => {
                const source = accepted.sources.find(value => value.id === id);
                return { id, title: source.title, url: source.url, lastVerifiedAt: source.lastVerifiedAt };
            }));
            expect(Object.isFrozen(question.sources)).toBe(true);
            question.sources.forEach(source => expect(Object.isFrozen(source)).toBe(true));
        });
        expect(metadata.sourceDisclosure).toContain('No Fries adaptations, not official NCSC questions');
        expect(metadata.sourceDisclosure).toContain('linked pages may have changed');
        expect(metadata.questions.flatMap(question => question.sources).map(source => source.lastVerifiedAt))
            .toEqual(expect.arrayContaining(['2026-09-02', '2026-08-31']));
        expect(metadata.profileRef.catalogueSha256).toBe(EXPECTED_ACCEPTED_NCSC_FRAMEWORK_PROFILE_SHA256);
        expect(metadata.profileRef.sourceCatalogueSha256).toBe(EXPECTED_ACCEPTED_NCSC_SOURCE_SHA256);
        expect(JSON.stringify(metadata)).not.toMatch(/implementationFactor|"weight"|"sourceIds"|sourceReferences|specificationDocument/);
    });

    test.each([
        ['missing source', profile => { profile.questions[0].sourceIds[0] = 'missing'; }],
        ['duplicate source', profile => { profile.questions[0].sourceIds.push(profile.questions[0].sourceIds[0]); }],
        ['no sources', profile => { profile.questions[0].sourceIds = []; }],
        ['outside official site', profile => { profile.sources.find(source => source.id === profile.questions[0].sourceIds[0]).url = 'https://example.com/'; }],
        ['invalid date', profile => { profile.sources.find(source => source.id === profile.questions[0].sourceIds[0]).lastVerifiedAt = '2026-02-30'; }]
    ])('projection rejects %s instead of emitting untraceable source links', (_label, change) => {
        expect(() => projectChangedCatalogue(change)).toThrow('ncsc_metadata_invalid');
    });
});

describe('closed browser client source metadata contract', () => {
    test('accepts current display metadata and the established shape without optional source fields', () => {
        const metadata = createNcscQuestionnaireMetadata();
        expect(() => client(metadata)).not.toThrow();
        const previous = clone(metadata);
        delete previous.sourceDisclosure;
        previous.questions.forEach(question => { delete question.sources; });
        expect(() => client(previous)).not.toThrow();
    });

    test.each([
        'javascript:alert(1)',
        'http://www.ncsc.govt.nz/protect-your-organisation/risk-management/',
        'https://www.ncsc.govt.nz.example.com/protect-your-organisation/risk-management/',
        'https://www.ncsc.govt.nz@evil.example/',
        'https://user@www.ncsc.govt.nz/protect-your-organisation/risk-management/',
        'https://www.ncsc.govt.nz:444/protect-your-organisation/risk-management/',
        'https://www.ncsc.govt.nz/protect-your-organisation/risk-management/?next=https://evil.example',
        'https://www.ncsc.govt.nz/protect-your-organisation/risk-management/#arbitrary',
        '//www.ncsc.govt.nz/protect-your-organisation/risk-management/'
    ])('rejects an unsafe or unbounded source URL %s', url => {
        const metadata = clone(createNcscQuestionnaireMetadata());
        metadata.questions[0].sources[0].url = url;
        expect(() => client(metadata)).toThrow(expect.objectContaining({ code: 'ncsc_input_invalid' }));
    });

    test.each([
        ['missing title', metadata => { delete metadata.questions[0].sources[0].title; }],
        ['extra field', metadata => { metadata.questions[0].sources[0].html = '<script>'; }],
        ['invalid id', metadata => { metadata.questions[0].sources[0].id = 'invalid id'; }],
        ['empty title', metadata => { metadata.questions[0].sources[0].title = ''; }],
        ['invalid date', metadata => { metadata.questions[0].sources[0].lastVerifiedAt = '2026-02-30'; }],
        ['timestamp instead of date', metadata => { metadata.questions[0].sources[0].lastVerifiedAt = '2026-09-02T00:00:00.000Z'; }],
        ['empty sources', metadata => { metadata.questions[0].sources = []; }],
        ['duplicate source', metadata => { metadata.questions[0].sources.push(clone(metadata.questions[0].sources[0])); }],
        ['too many sources', metadata => { metadata.questions[0].sources = Array.from({ length: 17 }, (_, index) => ({ ...metadata.questions[0].sources[0], id: `source-${index}` })); }],
        ['empty disclosure', metadata => { metadata.sourceDisclosure = ''; }]
    ])('rejects malformed supplied display fields: %s', (_label, change) => {
        const metadata = clone(createNcscQuestionnaireMetadata());
        change(metadata);
        expect(() => client(metadata)).toThrow(expect.objectContaining({ code: 'ncsc_input_invalid' }));
    });
});
