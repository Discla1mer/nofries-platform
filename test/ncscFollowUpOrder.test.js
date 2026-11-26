'use strict';
// #441 M1-12, M1-13: "Suggested follow-ups" and the copied provider summary
// list gaps in the same order as "Your top three gaps".
const { createNcscQuestionnaireMetadata } = require('../api/shared/ncscQuestionnaireMetadata');
const questionnaire = require('../api/shared/protectedAssets/ncscQuestionnaire');

test('provider follow-ups put tier-1 gaps first, No before Partial within a tier, then answers to check', () => {
    const metadata = createNcscQuestionnaireMetadata();
    const ids = metadata.questions.map(question => question.id);
    const byCode = code => ids.find(id => new RegExp('-' + code + '-01-Q').test(id));
    const answers = new Map([[byCode('PM'), 'no'], [byCode('RP'), 'no'], [byCode('PA'), 'partial'],
        [byCode('DR'), 'partial'], [byCode('MF'), 'no'], [byCode('AI'), 'unknown'], [byCode('SA'), 'not_applicable']]);
    expect([...answers.keys()].every(Boolean)).toBe(true);
    const assessment = { scopePopulation: { description: 'Synthetic scope' }, submission: { submittedAt: '2026-11-26T00:00:00.000Z' },
        responses: ids.map(itemId => ({ itemId, optionId: answers.get(itemId) || 'yes' })) };
    const control = id => metadata.controls.find(item => item.id === metadata.questions.find(q => q.id === id).controlId).title;
    const order = questionnaire.providerSummary(assessment, metadata).items.map(item => item.title.slice(0, item.title.lastIndexOf(' — ')));
    expect(order).toEqual([byCode('MF'), byCode('PA'), byCode('DR'), byCode('PM'), byCode('RP'), byCode('AI'), byCode('SA')].map(control));
});

test('scoring v2 follow-ups keep No before Partial and do not apply the accepted-profile tiers', () => {
    const { createNcscQuestionnaireMetadataV2 } = require('../api/shared/ncscQuestionnaireMetadata');
    const metadata = createNcscQuestionnaireMetadataV2();
    const ids = metadata.questions.map(question => question.id);
    const pa = ids.find(id => id.includes('-PA-01-')), pm = ids.find(id => id.includes('-PM-01-'));
    const assessment = { scopePopulation: { description: 'Synthetic scope' }, submission: { submittedAt: '2026-11-26T00:00:00.000Z' },
        responses: ids.map(itemId => ({ itemId, optionId: itemId === pa ? 'partly' : itemId === pm ? 'no' : itemId.includes('-MF-01-Q2') ? 'mfa_key' : 'yes' })) };
    const items = questionnaire.providerSummary(assessment, metadata).items;
    expect(items).toHaveLength(2);
    expect(items[0].title).toContain('password manager');
});

test('the board summary opens with the top gaps, in order, before the status groups (#441 M1-13)', () => {
    const metadata = createNcscQuestionnaireMetadata();
    const ids = metadata.questions.map(question => question.id);
    const assessment = { scopePopulation: { description: 'Synthetic scope' }, submission: { submittedAt: '2026-11-26T00:00:00.000Z' },
        responses: ids.map(itemId => ({ itemId, optionId: 'yes' })) };
    const gaps = [{ title: 'Data Recovery', answer: 'Partly' }, { title: 'Least Privilege', answer: 'No' }];
    const text = questionnaire.boardSummary(assessment, metadata, gaps).text;
    const first = text.indexOf('What needs attention first:');
    expect(first).toBeGreaterThan(-1);
    expect(text.indexOf('1. Data Recovery (your answer: Partly)')).toBeGreaterThan(first);
    expect(text.indexOf('2. Least Privilege (your answer: No)')).toBeGreaterThan(text.indexOf('1. Data Recovery'));
    expect(text.indexOf('In place:')).toBeGreaterThan(text.indexOf('2. Least Privilege'));
    expect(questionnaire.boardSummary(assessment, metadata).text).not.toContain('What needs attention first');
});
