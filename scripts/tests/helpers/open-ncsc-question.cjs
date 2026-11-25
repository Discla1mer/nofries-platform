'use strict';
const { createNcscQuestionnaireMetadata } = require('../../../api/shared/ncscQuestionnaireMetadata');
const { questions, controls } = createNcscQuestionnaireMetadata();

module.exports = async function openQuestion(page, index) {
    const domain = question => controls.find(control => control.id === question.controlId).domainId;
    const target = questions[index];
    await page.locator('#ncsc-step-' + domain(target)).press('Enter');
    const first = questions.findIndex(question => domain(question) === domain(target));
    for (let i = first; i < index; i++) await page.getByRole('button', { name: 'Next question', exact: true }).press('Enter');
    await page.locator('input[name="ncsc-answer-' + target.id + '"]').first().waitFor();
};
