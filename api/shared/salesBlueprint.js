const ASSESSMENT_VERSION = '2026.08.1';

const sections = [
    { id: 'business', title: 'What needs to improve', minutes: 4 },
    { id: 'estate', title: 'Users and environment', minutes: 5 },
    { id: 'support', title: 'Current IT support', minutes: 5 },
    { id: 'security', title: 'Security and backup', minutes: 5 },
    { id: 'operations', title: 'Suppliers and getting started', minutes: 3 },
    { id: 'priorities', title: 'Timing and next step', minutes: 3 }
];

const questions = [
    question('business.priorities', 'business', 'What should a better managed IT service achieve?', 'multi', [
        option('reliable_support', 'Faster, more reliable user support'),
        option('ownership', 'One accountable owner for day-to-day IT'),
        option('security', 'Improve security and reduce risk'),
        option('resilience', 'Improve backup and recoverability'),
        option('cost', 'Control IT cost and complexity'),
        option('growth', 'Support growth or organisational change')
    ]),
    question('business.concerns', 'business', 'What is causing the most difficulty today?', 'multi', [
        option('slow_support', 'Slow support or response'),
        option('recurring_issues', 'The same problems keep returning'),
        option('no_ownership', 'Issues bounce between people or suppliers'),
        option('provider_cost', 'Current provider cost or value'),
        option('cyber_risk', 'Security or cyber concerns'),
        option('backup_risk', 'Backup or recovery concerns'),
        option('capacity', 'Not enough internal IT capacity'),
        option('none', 'No major issue; reviewing options')
    ]),
    question('business.constraints', 'business', 'What could make a change difficult?', 'multi', [
        option('budget', 'Budget'),
        option('time', 'Time'),
        option('incumbent', 'Incumbent provider transition'),
        option('internal_capacity', 'Internal capacity'),
        option('legacy', 'Legacy or specialist systems'),
        option('none', 'Nothing identified')
    ]),

    question('estate.users', 'estate', 'Approximately how many people need IT support?', 'single', [
        option('under_10', 'Under 10'),
        option('10_24', '10–24'),
        option('25_49', '25–49'),
        option('50_99', '50–99'),
        option('100_249', '100–249'),
        option('250_plus', '250+'),
        option('unknown', 'Not yet confirmed')
    ]),
    question('estate.endpoints', 'estate', 'Approximately how many company computers and supported servers would be managed?', 'single', [
        option('under_10', 'Under 10'),
        option('10_24', '10–24'),
        option('25_49', '25–49'),
        option('50_99', '50–99'),
        option('100_249', '100–249'),
        option('250_plus', '250+'),
        option('unknown', 'Not yet confirmed')
    ]),
    question('estate.locations', 'estate', 'How many business locations need support?', 'single', [
        option('one', 'One'),
        option('two_three', '2–3'),
        option('four_five', '4–5'),
        option('six_plus', '6+'),
        option('remote_only', 'Fully remote / no fixed office'),
        option('unknown', 'Not yet confirmed')
    ]),
    question('productivity.platform', 'estate', 'Which productivity platform is used day to day?', 'single', [
        option('microsoft_365', 'Microsoft 365'),
        option('google_workspace', 'Google Workspace'),
        option('mixed', 'Mixed Microsoft 365 and Google Workspace'),
        option('other', 'Other'),
        option('unknown', 'Not yet confirmed')
    ]),
    question('applications.critical', 'estate', 'Which business applications are most important for us to understand?', 'text'),

    question('support.model', 'support', 'How is IT support provided today?', 'single', [
        option('managed_provider', 'External managed IT provider'),
        option('internal', 'Internal IT person or team'),
        option('hybrid', 'Internal IT plus an external provider'),
        option('none', 'No consistent IT provider'),
        option('unknown', 'Not yet confirmed')
    ]),
    question('support.frustrations', 'support', 'Which support problems should the new service fix?', 'multi', [
        option('slow_response', 'Slow response'),
        option('poor_follow_through', 'Poor follow-through or ticket ownership'),
        option('recurring', 'Recurring issues'),
        option('supplier_bounce', 'Problems bounce between suppliers'),
        option('visibility', 'Little visibility of work completed'),
        option('cost', 'Cost or unclear billing'),
        option('none', 'No specific support problem identified')
    ]),
    question('support.hours', 'support', 'What user-support coverage is actually required?', 'single', [
        option('business_hours', 'New Zealand business hours'),
        option('extended', 'Extended hours on agreed days'),
        option('24x7', '24/7 user helpdesk required'),
        option('unknown', 'Not yet confirmed')
    ]),
    question('support.delivery', 'support', 'How well does a remote-first support model fit the business?', 'single', [
        option('remote_first', 'Remote-first is suitable'),
        option('mixed', 'Mostly remote with planned onsite work'),
        option('onsite_heavy', 'Frequent onsite support is required'),
        option('unknown', 'Not yet confirmed')
    ]),

    question('security.endpoint', 'security', 'How consistent is protection across company computers?', 'single', [
        option('absent', 'No consistent protection'),
        option('partial', 'Partial or mixed coverage'),
        option('standardised', 'Standardised but internally operated'),
        option('managed', 'Standardised and managed'),
        option('unknown', 'Not yet confirmed')
    ]),
    question('security.monitoring', 'security', 'What happens when a serious computer security alert occurs?', 'single', [
        option('absent', 'No formal monitoring or response'),
        option('business_hours', 'Business-hours response only'),
        option('24x7_managed', 'Managed 24/7 security monitoring'),
        option('unknown', 'Not yet confirmed')
    ]),
    question('security.tools', 'security', 'Which computer security or monitoring services are already in use?', 'text'),
    question('resilience.backups', 'security', 'How are important work files on company computers backed up and restored?', 'single', [
        option('absent', 'No consistent computer backup'),
        option('untested', 'Backups exist but restores are not tested'),
        option('partial', 'Some devices or data are protected'),
        option('tested', 'Regularly protected and restore-tested internally'),
        option('managed', 'Managed backup and restore process'),
        option('unknown', 'Not yet confirmed')
    ]),

    question('operations.suppliers', 'operations', 'How many important technology suppliers need to be coordinated?', 'single', [
        option('none', 'None beyond the IT provider'),
        option('one_two', '1–2'),
        option('three_plus', '3+'),
        option('unknown', 'Not yet confirmed')
    ]),
    question('operations.ownership', 'operations', 'When an issue crosses suppliers, is ownership clear?', 'single', [
        option('clear', 'Yes, one party owns the issue'),
        option('mixed', 'Sometimes'),
        option('fragmented', 'No, the customer often coordinates it'),
        option('unknown', 'Not yet confirmed')
    ]),
    question('operations.incumbent_handover', 'operations', 'Will an incumbent IT provider need to hand over access, documentation or services?', 'single', [
        option('yes', 'Yes'),
        option('no', 'No'),
        option('unknown', 'Not yet confirmed')
    ]),

    question('priorities.timeframe', 'priorities', 'When would the customer like the managed service in place?', 'single', [
        option('now', 'Within 90 days'),
        option('quarter', 'Within two quarters'),
        option('year', 'Within 12 months'),
        option('unsure', 'No timeframe agreed')
    ]),
    question('priorities.procurement', 'priorities', 'What is the current commercial position?', 'single', [
        option('exploring', 'Exploring options'),
        option('budgeted', 'Budget or mandate exists'),
        option('active', 'Proposal or agreement requested'),
        option('no_budget', 'No budget or mandate yet')
    ]),
    question('priorities.next_step', 'priorities', 'What should happen after this service review?', 'single', [
        option('continue_discovery', 'Continue the review'),
        option('technical_validation', 'Check the current set-up and changeover needs'),
        option('proposal', 'Prepare the managed IT proposal / agreement'),
        option('human_call', 'Arrange a human discussion'),
        option('none', 'No next step agreed')
    ])
];

function question(id, section, prompt, type, options = [], showWhen = null) {
    return {
        id,
        section,
        prompt,
        type,
        options,
        showWhen,
        capture: {
            notes: true,
            evidence: true,
            importance: true,
            confidence: true,
            internalNotes: true
        }
    };
}

function option(value, label) {
    return { value, label };
}

function condition(questionId, operator, values) {
    return { questionId, operator, values };
}

function getAssessmentBlueprint() {
    return {
        version: ASSESSMENT_VERSION,
        title: 'Managed IT customer review',
        estimatedMinutes: sections.reduce((total, section) => total + section.minutes, 0),
        sections: sections.map((section) => Object.assign({}, section)),
        questions: questions.map((item) => JSON.parse(JSON.stringify(item)))
    };
}

function getQuestionMap() {
    return new Map(questions.map((item) => [item.id, item]));
}

function isQuestionVisible(questionItem, answers) {
    if (!questionItem || !questionItem.showWhen) {
        return true;
    }
    const dependency = answers && answers[questionItem.showWhen.questionId];
    const value = dependency && dependency.value;
    const values = Array.isArray(value) ? value : [value];
    const expected = questionItem.showWhen.values || [];
    const matched = values.some((candidate) => expected.includes(candidate));
    return questionItem.showWhen.operator === 'not_in' ? !matched : matched;
}

function answerLabel(questionItem, value) {
    if (Array.isArray(value)) {
        return value.map((item) => answerLabel(questionItem, item)).join(', ');
    }
    const matched = questionItem && (questionItem.options || []).find((item) => item.value === value);
    return matched ? matched.label : String(value == null ? '' : value);
}

module.exports = {
    ASSESSMENT_VERSION,
    answerLabel,
    getAssessmentBlueprint,
    getQuestionMap,
    isQuestionVisible
};
