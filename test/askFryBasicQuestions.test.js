'use strict';

// Ask Fry must answer the basic questions a first-time visitor actually asks:
// every launcher starter question, plus the common phrasings and synonyms for
// the same intents. Out-of-scope, discovery and contact input must still fall
// through to the fixed public fallback (publicHelpReply returns null).
const { renderSharedAssistant, PUBLIC_PAGES } = require('../lib/sharedAssistantDocument');
const { NOFRIES_PUBLIC_KNOWLEDGE, publicHelpReply } = require('../api/shared/agents/nofriesPublicKnowledge');

function unescapeAttribute(value) {
    return value.replace(/&(amp|lt|gt|quot|#39);/g, (_, entity) => ({
        amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'"
    })[entity]);
}

function allStarterQuestions() {
    const questions = new Set();
    for (const page of PUBLIC_PAGES) {
        const html = renderSharedAssistant({ fryAssetPath: '/images/fry-chat.png', page });
        for (const match of html.matchAll(/<button\b[^>]*data-message="([^"]+)"[^>]*>/g)) {
            questions.add(unescapeAttribute(match[1]));
        }
    }
    return [...questions];
}

function expectRealAnswer(message) {
    const answer = publicHelpReply(message);
    expect({ message, answer }).toEqual({ message, answer: expect.objectContaining({
        topic: expect.any(String),
        text: expect.any(String),
        knowledgeVersion: NOFRIES_PUBLIC_KNOWLEDGE.knowledgeVersion
    }) });
    // Never the generic fallback topic, and a substantive grounded answer.
    expect(answer.topic).not.toBe('public_help');
    expect(answer.text.length).toBeGreaterThan(50);
    expect(answer.text.length).toBeLessThanOrEqual(1800);
    // No fabricated action, price or live-everything claim.
    expect(answer.text).not.toMatch(/I (?:reset|activated|opened|saved|submitted|changed) your|NZ\$|all (?:accounts|features) are live/i);
    const urls = answer.text.match(/https:\/\/[^\s]+/g) || [];
    for (const url of urls) expect(Object.values(NOFRIES_PUBLIC_KNOWLEDGE.links)).toContain(url);
    return answer;
}

describe('Ask Fry answers basic first-time-visitor questions deterministically', () => {
    const starters = allStarterQuestions();

    test('every launcher starter question has a grounded answer, not the fallback', () => {
        expect(starters.length).toBeGreaterThanOrEqual(10);
        for (const question of starters) expectRealAnswer(question);
    });

    test.each([
        ['What is No Fries?', 'platform_overview'],
        ['What does No Fries do?', 'platform_overview'],
        ['Tell me about No Fries', 'platform_overview'],
        ['what is the no fries dashboard', 'platform_overview'],
        ['What is an assessment?', 'platform_overview'],
        ['How does scoring work?', 'saved_results'],
        ['How is my assessment scored?', 'saved_results'],
        ['How do I sign up?', 'account_entry'],
        ['How do I get started?', 'account_entry'],
        ['How do I register for No Fries?', 'account_entry'],
        ['How do I choose between Company and Consultant?', 'account_choice'],
        ['How do I contact support?', 'enquiry_options'],
        ['What is Ask Fry?', 'assistance_limits'],
        ['Who are you?', 'assistance_limits'],
        ['What can you do?', 'assistance_limits'],
        ['Is my data safe?', 'data_security'],
        ['How secure is my data?', 'data_security'],
        ['Is my information private?', 'data_security'],
        ['What does it cost?', 'feature_availability'],
        ['How much is pricing?', 'feature_availability'],
        ['pricing', 'feature_availability'],
        ['How do I export a report?', 'feature_availability'],
        ['How do I download a board report?', 'feature_availability']
    ])('answers a basic question regardless of exact phrasing: %s', (message, topic) => {
        const answer = expectRealAnswer(message);
        expect(answer.topic).toBe(topic);
    });

    test('matching is forgiving about case and punctuation', () => {
        for (const variant of ['WHAT IS NO FRIES???', '   what   does   no fries   do  ', 'What is No Fries!']) {
            expect(publicHelpReply(variant)).toMatchObject({ topic: 'platform_overview' });
        }
    });

    test.each([
        'What is the weather?',
        'Tell me a joke',
        'What time is it in Wellington?',
        'We need more reliable IT support.',
        'What does managed IT cost each month?',
        'Can you quote for password recovery services?',
        'Please contact me about a service review.',
        'How do assessments work? My email is synthetic@example.test.',
        'What is the dashboard? We have 20 staff and 25 laptops.',
        ''
    ])('still routes clearly out-of-scope, discovery or contact input to the fallback: %s', message => {
        expect(publicHelpReply(message)).toBeNull();
    });
});
