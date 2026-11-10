'use strict';

// A-002: Ask Fry must answer basic assessment questions directly (answer
// definitions, scoring formula), state its private-data limit for questions
// about a saved assessment, and lead compliance questions with the fixed
// limit. It stays deterministic public help with no private assessment data.
const fs = require('fs');
const path = require('path');
const {
    ASSESSMENT_ANSWER_HELP,
    NOFRIES_PUBLIC_KNOWLEDGE,
    publicHelpReply
} = require('../api/shared/agents/nofriesPublicKnowledge');
const { CREDIT_UNIT_SCALE } = require('../api/shared/assessmentEngine/assessmentEvaluator');

const COMPLIANCE_LEAD = "This assessment can't establish compliance or certification.";
const FORMULA = /Yes = 1, Partial = 0\.5, No = 0\..*Unknown, unanswered and pending N\/A answers are unresolved and widen the score range: the lower end counts them as 0 and the upper end counts them as 1\./;

function reply(message) {
    const answer = publicHelpReply(message);
    expect({ message, answer }).toEqual({ message, answer: expect.objectContaining({
        topic: expect.any(String),
        text: expect.any(String),
        knowledgeVersion: NOFRIES_PUBLIC_KNOWLEDGE.knowledgeVersion
    }) });
    expect(Object.isFrozen(answer)).toBe(true);
    expect(answer.text.length).toBeLessThanOrEqual(1800);
    expect(answer.text).not.toMatch(/I (?:checked|read|saw|reviewed|changed|saved|submitted) your|NZ\$|you are compliant|you are certified/i);
    const urls = answer.text.match(/https:\/\/[^\s]+/g) || [];
    for (const url of urls) expect(Object.values(NOFRIES_PUBLIC_KNOWLEDGE.links)).toContain(url);
    return answer;
}

describe('Ask Fry answer-option definitions and scoring formula', () => {
    test('answers "What does Partial mean for MFA?" directly, with the formula and a pointer to question guidance', () => {
        const answer = reply('What does Partial mean for MFA?');
        expect(answer.topic).toBe('answer_definitions');
        expect(answer.text.startsWith('Partial means: Some parts are in place, or only part of your scope is covered. Plans alone do not count.')).toBe(true);
        expect(answer.text).toMatch(FORMULA);
        expect(answer.text).toContain('"Guidance and evidence examples" under that question');
        expect(answer.text).not.toMatch(/No Fries Dashboard is a standalone platform/);
    });

    test.each([
        ['What does Partial mean?', ['partial']],
        ['what does partial mean', ['partial']],
        ['What does Unknown mean?', ['unknown']],
        ['What does N/A mean?', ['not_applicable']],
        ['What does not applicable mean in the assessment?', ['not_applicable']],
        ['What does No mean?', ['no']],
        ['What does the Yes answer mean?', ['yes']],
        ['What do Yes / No / Unknown / N/A mean?', ['yes', 'no', 'unknown', 'not_applicable']],
        ['Should I answer Partial or No?', ['partial', 'no']],
        ["What's the difference between Partial and Unknown?", ['partial', 'unknown']]
    ])('defines the asked answer options: %s', (message, asked) => {
        const answer = reply(message);
        expect(answer.topic).toBe('answer_definitions');
        for (const id of asked) {
            const { label, meaning } = ASSESSMENT_ANSWER_HELP.options[id];
            expect(answer.text).toContain(`${label} means: ${meaning}`);
        }
        // Every option and the formula are always stated.
        for (const { meaning } of Object.values(ASSESSMENT_ANSWER_HELP.options)) expect(answer.text).toContain(meaning);
        expect(answer.text).toMatch(FORMULA);
    });

    test.each([
        'How is my score calculated?',
        'Why is my score a range?',
        'How does scoring work?',
        'How is my assessment scored?',
        'How are results calculated?'
    ])('explains the scoring formula and the private-data limit: %s', message => {
        const answer = reply(message);
        expect(answer.topic).toBe('scoring_formula');
        expect(answer.text).toMatch(FORMULA);
        expect(answer.text).toContain("Ask Fry can't see your saved assessment");
    });

    test('does not treat the brand name or ordinary yes/no wording as an answer option', () => {
        expect(publicHelpReply('What does No Fries mean?').topic).toBe('platform_overview');
        expect(publicHelpReply('Is there no way to save my assessment?')?.topic).not.toBe('answer_definitions');
    });

    test('definitions are the in-question answer guidance shown in the assessment', () => {
        const source = fs.readFileSync(path.join(__dirname, '../api/shared/protectedAssets/ncscQuestionnaire.js'), 'utf8');
        const block = source.slice(source.indexOf('const ANSWER_GUIDANCE = {'), source.indexOf('};', source.indexOf('const ANSWER_GUIDANCE = {')));
        for (const [id, { meaning }] of Object.entries(ASSESSMENT_ANSWER_HELP.options)) {
            expect(block).toContain(`${id}: '${meaning.replace(/'/g, "\\'")}'`);
        }
        // The results page states the same weights and range bounds.
        expect(source).toContain('Yes earns 1, Partial 0.5 and No 0. The lower end gives unresolved answers 0; the upper end gives them 1.');
    });

    test('the formula matches the deterministic evaluator credit rules', () => {
        const evaluator = fs.readFileSync(path.join(__dirname, '../api/shared/assessmentEngine/assessmentEvaluator.js'), 'utf8');
        expect(CREDIT_UNIT_SCALE).toBe(2);
        // yes: full weight both bounds; partial: half (weight of a scale-2 unit); no: 0;
        // unknown, missing and claimed N/A: 0 lower, full weight upper.
        expect(evaluator).toMatch(/semantic === 'yes'\) \{\s*return \{ lowerCreditUnits: weight \* CREDIT_UNIT_SCALE, upperCreditUnits: weight \* CREDIT_UNIT_SCALE \}/);
        expect(evaluator).toMatch(/semantic === 'partial'\) \{\s*return \{ lowerCreditUnits: weight, upperCreditUnits: weight \}/);
        expect(evaluator).toMatch(/semantic === 'no'\) \{\s*return \{ lowerCreditUnits: 0, upperCreditUnits: 0 \}/);
        expect(evaluator).toMatch(/return \{ lowerCreditUnits: 0, upperCreditUnits: weight \* CREDIT_UNIT_SCALE \};\s*\}/);
    });
});

describe('Ask Fry private assessment priorities', () => {
    test.each([
        'What should I fix first?',
        'What are my gaps?',
        "What's my score?",
        'What is my score?',
        'What are my results?',
        'Which gaps should I prioritise?',
        'How did we score?'
    ])('states the access limit and points to "Fix these first" on the results page: %s', message => {
        const answer = reply(message);
        expect(answer.topic).toBe('private_priorities');
        expect(answer.text.startsWith("Ask Fry can't see your saved assessment, answers, score or gaps.")).toBe(true);
        expect(answer.text).toContain('View results');
        expect(answer.text).toContain('"Fix these first"');
        expect(answer.text).toContain(NOFRIES_PUBLIC_KNOWLEDGE.links.dashboard);
    });

    test('the referenced results-page labels exist in the assessment UI', () => {
        const source = fs.readFileSync(path.join(__dirname, '../api/shared/protectedAssets/ncscQuestionnaire.js'), 'utf8');
        expect(source).toContain("node('h3', '', 'Fix these first')");
        expect(source).toContain("'View results'");
        // "Fix these first" lists No, Partial, Unknown and Not applicable answers, in that order.
        expect(source).toContain("const NEXT_STEP_ORDER = ['no', 'partial', 'unknown', 'not_applicable'];");
        expect(source).toContain("'summary', '', 'Guidance and evidence examples'");
    });
});

describe('Ask Fry compliance and certification limits', () => {
    test.each([
        'Does this make us compliant?',
        'Is this certification?',
        'Does this meet ISO / Cyber Essentials / NCSC requirements?',
        'Does this meet ISO 27001?',
        'Will this get us Cyber Essentials certified?',
        'Is this an NCSC compliance check?',
        'Can I use my results as a certificate?'
    ])('leads with the fixed limit sentence: %s', message => {
        const answer = reply(message);
        expect(answer.topic).toBe('compliance_limits');
        expect(answer.text.startsWith(COMPLIANCE_LEAD)).toBe(true);
        expect(answer.text).toContain('not an audit, independent assurance, certification, compliance finding or proof of effective controls');
    });
});

describe('cost questions stay on the server pricing-policy path', () => {
    test.each([
        'What does it cost?',
        'How much is pricing?',
        'How much does certification cost?',
        'What does the assessment cost?',
        'How much does it cost to fix my gaps?'
    ])('returns null: %s', message => {
        expect(publicHelpReply(message)).toBeNull();
    });
});
