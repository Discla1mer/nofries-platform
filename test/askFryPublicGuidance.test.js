'use strict';

const { renderSharedAssistant } = require('../lib/sharedAssistantDocument');
const { publicHelpReply } = require('../api/shared/agents/nofriesPublicKnowledge');

function unescapeAttribute(value) {
    return value.replace(/&(amp|lt|gt|quot|#39);/g, (_, entity) => ({
        amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'"
    })[entity]);
}

test.each(['home', 'dashboard', 'roadmap'])('visible %s public-help questions have a specific grounded answer', page => {
    const html = renderSharedAssistant({ fryAssetPath: '/images/fry-chat.png', page, helpOnly: true });
    const visibleQuestions = [...html.matchAll(/<button\b[^>]*data-message="([^"]+)"[^>]*>/g)]
        .filter(match => !/\bhidden\b/.test(match[0]))
        .map(match => unescapeAttribute(match[1]));

    expect(visibleQuestions.length).toBeGreaterThanOrEqual(2);
    for (const question of visibleQuestions) {
        const answer = publicHelpReply(question);
        expect({ question, answer }).toEqual({ question, answer: expect.objectContaining({
            topic: expect.any(String), text: expect.any(String)
        }) });
        expect(answer.topic).not.toBe('public_help');
        expect(answer.text.length).toBeGreaterThan(50);
        expect(answer.text).not.toMatch(/I (?:have |can |will )(?:read|checked|change|save|submit) your/i);
    }
});
