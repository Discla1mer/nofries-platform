'use strict';

// Offline contract only: never imported by the runtime, no provider or tools.
// A future caller must authorise the read before calling this projector. Matching
// record identifiers is integrity checking, not proof of access or user consent.
const { resultModel } = require('../api/shared/protectedAssets/ncscQuestionnaire');
const { createNcscQuestionnaireMetadata } = require('../api/shared/ncscQuestionnaireMetadata');
const { randomUUID } = require('node:crypto');
const INTENTS = new Set(['explain', 'first_step', 'diy_or_help']);
const contracts = new WeakSet();
const freeze = value => {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
    return value;
};
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const unavailable = () => freeze({ status: 'unavailable' });

function projectSavedGap(assessment, options = {}) {
    // Explicit per-call test gates; neither env vars nor key presence enable it.
    if (!options || options.enabled !== true || options.consent !== true) return freeze({ status: 'disabled' });
    try {
        const selected = options.selected;
        if (!exactKeys(selected, ['organisationId', 'assessmentId', 'revision', 'revisionSha256']) ||
            typeof selected.organisationId !== 'string' || !selected.organisationId ||
            typeof selected.assessmentId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(selected.assessmentId) ||
            !Number.isSafeInteger(selected.revision) || selected.revision < 2 || selected.revision > 128 ||
            typeof selected.revisionSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(selected.revisionSha256) ||
            !assessment || assessment.status !== 'submitted' ||
            assessment.assessmentId !== selected.assessmentId || assessment.revision !== selected.revision ||
            assessment.revisionSha256 !== selected.revisionSha256 || !INTENTS.has(options.intent)) return unavailable();
        const metadata = createNcscQuestionnaireMetadata();
        const result = resultModel(assessment, metadata, selected.organisationId);
        if (!result) return unavailable();
        const question = metadata.questions.find(row => row.id === options.questionId);
        const answer = result.domains.flatMap(domain => domain.controls.flatMap(control => control.questions))
            .find(row => row.itemId === options.questionId);
        if (!question || !answer || answer.responseOptionId === 'yes') return unavailable();
        // Only accepted catalogue text and enum answers cross this boundary.
        // Exclude rationales, free text, scope descriptions, identities and scores.
        const sourceMap = {
            answer: { kind: 'saved', field: 'responses.optionId', questionId: question.id },
            question: { kind: 'catalogue', field: 'prompt', questionId: question.id },
            guidance: { kind: 'catalogue', field: 'guidance.startingActions', questionId: question.id }
        };
        const contract = freeze({
            status: 'ready',
            binding: { ...selected, questionId: question.id, profileRef: { ...metadata.profileRef } },
            sourceMap,
            context: {
                version: 1, contextId: randomUUID(), intent: options.intent,
                sources: [
                    { id: 'answer', text: answer.responseOptionId },
                    { id: 'question', text: question.prompt },
                    { id: 'guidance', text: question.guidance.startingActions.join('\n') }
                ],
                constraints: ['Suggestions only; no changes made.', 'Unknown and claimed N/A remain unresolved.',
                    'Do not infer verified controls, compliance, risk priority, pricing or a new score.']
            }
        });
        contracts.add(contract);
        return contract;
    } catch (_) { return unavailable(); }
}

// Shape/source validation cannot establish that generated prose is true. A later
// provider pilot needs semantic evals. Never render returned text as HTML.
function validateGapReply(reply, contract) {
    if (!contracts.has(contract) || !exactKeys(reply, ['contextId', 'explanation', 'steps', 'unknowns']) ||
        reply.contextId !== contract.context.contextId) return unavailable();
    const allowed = new Set(contract.context.sources.map(source => source.id));
    const section = row => exactKeys(row, ['text', 'sources']) && typeof row.text === 'string' &&
        row.text.trim().length > 0 && row.text.length <= 600 &&
        !/[<>]|https?:|www\./i.test(row.text) && Array.isArray(row.sources) && row.sources.length > 0 &&
        row.sources.length <= allowed.size && new Set(row.sources).size === row.sources.length &&
        row.sources.every(source => allowed.has(source));
    if (!section(reply.explanation) || !Array.isArray(reply.steps) || reply.steps.length > 3 ||
        !reply.steps.every(section) || !Array.isArray(reply.unknowns) || reply.unknowns.length > 3 ||
        !reply.unknowns.every(section)) return unavailable();
    return freeze({ status: 'ready', binding: contract.binding, reply: JSON.parse(JSON.stringify(reply)) });
}

module.exports = { projectSavedGap, validateGapReply };
