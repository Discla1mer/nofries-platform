// Appended to the shared questionnaire in the pinned ISO asset only.
(function (root) {
    'use strict';

    const terms = new Map([
        ['C4.1-Q1', [
            ['Information risk', 'Something that could go wrong with information you rely on. For example, losing access to your order records could stop you making deliveries.']
        ]],
        ['C4.3-Q1', [
            ['Scope', 'The boundary you draw around the work you are assessing. Name the teams, sites and services inside it, and the outside services they rely on.'],
            ['ISMS', 'An information security management system is the way your organisation looks after information. It includes who makes decisions, how you handle risks and how you check that the work gets done.']
        ]],
        ['C5.3-Q1', [
            ['Risk owner', 'The person with authority to decide what to do about a risk. For example, a service owner might accept a short outage and fund changes to prevent a longer one.']
        ]],
        ['C6.1.2-Q1', [
            ['Likelihood', 'Your judgement of how likely something is to happen. Use the same scale across the business so two teams can compare their risks.']
        ]],
        ['C6.1.3-Q1', [
            ['Annex A', 'The part of ISO 27001 that lists safeguards to consider. Compare the list with your own risks to see whether you have missed a useful safeguard.'],
            ['Risk treatment', 'What you decide to do about a risk. For example, you might practise restoring a backup to shorten an outage, then decide whether you can live with the remaining downtime.'],
            ['Statement of Applicability', 'Your record of the safeguards you need, why you chose them and which are in place. It also explains why any Annex A safeguards were left out.']
        ]],
        ['C9.2-Q1', [
            ['Internal audit', 'A planned check by someone who can judge the work fairly. They compare what your organisation agreed to do with what actually happens and report what they find.']
        ]],
        ['C9.3-Q1', [
            ['Management review', 'When leaders look at results, changes and problems together and decide what needs attention. Record the decisions, who owns each action and when to follow up.']
        ]],
        ['C10.2-Q1', [
            ['Corrective action', 'A change that addresses why a problem happened. For example, after closing a former employee’s account, fix the leaving process and check it works for the next person.']
        ]]
    ]);

    function appendQuestionHelp(question, id) {
        for (const [term, definition] of terms.get(id) || []) {
            const doc = question.ownerDocument;
            const details = doc.createElement('details');
            details.className = 'ncsc-question-help';
            const summary = doc.createElement('summary');
            summary.textContent = term + ' explained';
            const meaning = doc.createElement('p');
            meaning.textContent = definition;
            details.append(summary, meaning);
            details.onkeydown = event => {
                if (event.key === 'Escape' && details.open) {
                    event.preventDefault();
                    event.stopPropagation();
                    details.open = false;
                    summary.focus();
                }
            };
            question.append(details);
        }
    }

    const shared = root.NoFriesPaidQuestionnaire;
    root.NoFriesPaidQuestionnaire = {
        mount(container, options) {
            const { framework, profile } = options.publication;
            const iso = framework.id === 'iso-iec-27001' && framework.version === '2022' &&
                profile.id === 'nf-iso-27001-2022-readiness' && profile.version === '2026-11-19.1';
            return shared.mount(container, options, iso ? appendQuestionHelp : undefined);
        }
    };
}(globalThis));
