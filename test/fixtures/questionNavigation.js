'use strict';

function questionIndex(root, questions) {
    const name = root.querySelector('fieldset').querySelector('input').name;
    return questions.findIndex(question => name === 'ncsc-answer-' + question.id);
}

function goToQuestion(root, questions, target) {
    const start = questionIndex(root, questions);
    if (start < 0 || !questions[target]) throw new Error('Unknown questionnaire position');
    const label = target < start ? 'Previous question' : 'Next question';
    for (let step = 0; step < Math.abs(target - start); step++) {
        root.querySelectorAll('button').find(button => button.textContent === label).click();
    }
}

module.exports = { goToQuestion, questionIndex };
