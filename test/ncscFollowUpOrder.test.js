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
