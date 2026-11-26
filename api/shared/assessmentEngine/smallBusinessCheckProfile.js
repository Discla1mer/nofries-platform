'use strict';

const { createHash } = require('node:crypto');
const { publishFrameworkProfile } = require('./frameworkProfileRegistry');

const version = '1.0.0';
const date = '2026-11-26';
const authority = 'No Fries Limited';
const responseOptions = [
    ['yes', 'Yes', 1], ['partial', 'Partly', 0.5], ['no', 'No', 0], ['unknown', 'Unknown', null]
].map(([id, label, implementationFactor]) => ({ id, label, applicable: true, implementationFactor }));

// A row describes one check, one piece of evidence and one achievable next step.
function createSmallBusinessCheck({ id, title, description, file, groups }, catalogueSha256) {
    const sourceId = id + '_source';
    const sourceIds = [sourceId];
    const domains = [], controls = [], questions = [];
    for (const [groupId, groupTitle, rows] of groups) {
        const evidenceExamples = [], startingActions = [];
        for (const [key, name, prompt, why, evidence, action] of rows) {
            const guidance = { summary: why, evidenceExamples: [evidence], startingActions: [action] };
            const controlId = id + '_' + key;
            controls.push({ id: controlId, domainId: groupId, title: name, order: controls.length + 1,
                guidance, sourceIds, sourceReferences: [{ sourceId, referenceId: key, order: 1 }] });
            questions.push({ id: controlId + '_q', controlId, order: 1, prompt, weight: 1,
                responseOptionIds: responseOptions.map(o => o.id), guidance, sourceIds });
            evidenceExamples.push(evidence);
            startingActions.push(action);
        }
        domains.push({ id: groupId, title: groupTitle, order: domains.length + 1, sourceIds,
            guidance: { summary: groupTitle, evidenceExamples, startingActions } });
    }
    const repo = 'https://github.com/Discla1mer/nofries-platform/blob/main/';
    return publishFrameworkProfile({
        schemaVersion: 1, status: 'published', publishedAt: date, catalogueSha256,
        sourceCatalogueSha256: createHash('sha256').update(JSON.stringify(groups)).digest('hex'),
        framework: { id, title, version, authority, description, sourceIds },
        profile: { id: id + '_small_business', title, version, effectiveFrom: date, description, sourceIds },
        statements: { attribution: 'Questions and guidance written by No Fries Limited.',
            basis: description, claim: 'A self-check based on your answers.',
            limitations: ['The check does not independently verify your answers.'] },
        sources: [{ id: sourceId, title, authority, version, lastVerifiedAt: date,
            url: repo + 'api/shared/assessmentEngine/' + file, rightsStatus: 'verified',
            licence: 'No Fries original content; see repository rights notice.', licenceUrl: repo + 'LICENSE.md' }],
        domains, controls, questions, responseOptions
    });
}

module.exports = { createSmallBusinessCheck };
