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

test('the IT-provider summary leads with the on-screen top gaps on scoring v2 (#441)', () => {
    const { createNcscQuestionnaireMetadataV2 } = require('../api/shared/ncscQuestionnaireMetadata');
    const metadata = createNcscQuestionnaireMetadataV2();
    const ids = metadata.questions.map(question => question.id);
    const pick = code => ids.find(id => id.includes('-' + code + '-01-Q1'));
    const answers = new Map([[pick('RM'), 'no'], [pick('PA'), 'partly'], [pick('SU'), 'no'], [pick('PM'), 'ad_hoc']]);
    const assessment = { scopePopulation: { description: 'Synthetic scope' }, submission: { submittedAt: '2026-11-27T00:00:00.000Z' },
        responses: ids.map(itemId => ({ itemId, optionId: answers.get(itemId) || (itemId.includes('MF-01-Q2') ? 'mfa_key' : 'yes') })) };
    const control = id => metadata.controls.find(item => item.id === metadata.questions.find(q => q.id === id).controlId).title;
    const gaps = [{ itemId: pick('SU') }, { itemId: pick('PA') }];
    const order = questionnaire.providerSummary(assessment, metadata, gaps).items.map(item => item.title.slice(0, item.title.lastIndexOf(' — ')));
    expect(order.slice(0, 2)).toEqual([control(pick('SU')), control(pick('PA'))]);
    expect(order.slice(2)).toEqual([control(pick('RM')), control(pick('PM'))]);
});

// Owner direction, 28 Nov 2026: gap help points to No Fries, not away to "your IT provider".
test('follow-ups and the copied summary never send the customer to their IT provider', () => {
    const fs = require('fs'), path = require('path');
    const metadata = createNcscQuestionnaireMetadata();
    const ids = metadata.questions.map(question => question.id);
    const options = ['no', 'partial', 'unknown', 'not_applicable'];
    const assessment = { scopePopulation: { description: 'Synthetic scope' }, submission: { submittedAt: '2026-11-26T00:00:00.000Z' },
        responses: ids.map((itemId, index) => ({ itemId, optionId: options[index % options.length] })) };
    const summary = questionnaire.providerSummary(assessment, metadata);
    expect(summary.items.length).toBeGreaterThan(3);
    expect(summary.items.some(item => item.action === 'Not sure? No Fries can check what is in place with you.')).toBe(true);
    for (const item of summary.items) expect(['', 'You can start this with your team.']).toContain(item.owner);
    expect(summary.text).not.toMatch(/IT provider to (help|check)|with your IT provider/);
    expect(summary.text).not.toContain(':  ');
    for (const file of ['ncscQuestionnaire.js', 'organisationPicture.js']) {
        const source = fs.readFileSync(path.join(__dirname, '../api/shared/protectedAssets', file), 'utf8');
        expect(source).not.toMatch(/Ask your IT provider|with your IT provider|No IT provider\?/);
    }
    const shown = fs.readFileSync(path.join(__dirname, '../api/shared/protectedAssets/ncscQuestionnaire.js'), 'utf8');
    expect(shown.match(/No Fries can help you fix any of these\./g)).toHaveLength(1);
});
