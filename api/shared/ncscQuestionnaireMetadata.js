'use strict';

const { createAcceptedNcscFrameworkProfile } = require('./assessmentEngine/ncscAcceptedFrameworkProfile');

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const SOURCE_DISCLOSURE = 'These questions are No Fries adaptations, not official NCSC questions. Source verification dates come from the accepted catalogue; linked pages may have changed since those dates.';

/** Display data only. The accepted factory owns source verification and catalogue
 * pins; this projection grants no access and exposes no scoring implementation.
 */
function createNcscQuestionnaireMetadata() {
    const accepted = createAcceptedNcscFrameworkProfile();
    identifiers(accepted.sources);
    const sourceById = new Map(accepted.sources.map(source => [source.id, source]));
    const licenceSource = accepted.sources.find(source => source.id === 'ncsc-framework');
    if (!licenceSource || licenceSource.rightsStatus !== 'verified' ||
        typeof licenceSource.licence !== 'string' || typeof licenceSource.licenceUrl !== 'string' ||
        !licenceSource.licenceUrl.startsWith('https://')) invalid();

    const domains = ordered(accepted.domains).map(domain => ({ id: domain.id, order: domain.order,
        title: displayText(domain.title), guidance: guidance(domain.guidance) }));
    const controls = ordered(accepted.controls).map(control => ({ id: control.id, domainId: control.domainId,
        order: control.order, title: displayText(control.title), guidance: guidance(control.guidance) }));
    const questions = ordered(accepted.questions).map(question => ({ id: question.id, controlId: question.controlId,
        order: question.order, prompt: displayText(question.prompt), guidance: guidance(question.guidance),
        responseOptionIds: [...question.responseOptionIds], sources: questionSources(question, sourceById) }));
    const responseOptions = accepted.responseOptions.map(option => {
        if (typeof option.applicable !== 'boolean') invalid();
        return { id: option.id, label: displayText(option.label), applicable: option.applicable };
    });
    const domainIds = identifiers(domains), controlIds = identifiers(controls), questionIds = identifiers(questions),
        optionIds = identifiers(responseOptions);
    if (!domainIds.size || !controlIds.size || !questionIds.size || !optionIds.size ||
        controls.some(control => !domainIds.has(control.domainId)) ||
        domains.some(domain => !controls.some(control => control.domainId === domain.id)) ||
        controls.some(control => !questions.some(question => question.controlId === control.id)) ||
        questions.some(question => !controlIds.has(question.controlId) || !question.responseOptionIds.length ||
            new Set(question.responseOptionIds).size !== question.responseOptionIds.length ||
            question.responseOptionIds.some(optionId => !optionIds.has(optionId)))) invalid();

    return freeze({ schemaVersion: 1, moduleId: 'cyber_security', profileRef: {
        frameworkId: accepted.framework.id, frameworkVersion: accepted.framework.version,
        profileId: accepted.profile.id, profileVersion: accepted.profile.version,
        catalogueSha256: accepted.catalogueSha256, sourceCatalogueSha256: accepted.sourceCatalogueSha256
    }, title: displayText(accepted.profile.title), description: displayText(accepted.profile.description),
    attribution: displayText(accepted.statements.attribution), claim: displayText(accepted.statements.claim),
    sourceDisclosure: SOURCE_DISCLOSURE,
    licence: { label: displayText(licenceSource.licence), url: licenceSource.licenceUrl },
    limitations: accepted.statements.limitations.map(displayText), domains, controls, questions, responseOptions });
}

function ordered(values) {
    if (!Array.isArray(values) || values.some(value => !Number.isSafeInteger(value.order) || value.order < 0)) invalid();
    return [...values].sort((left, right) => left.order - right.order || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}
function identifiers(values) {
    const ids = new Set();
    for (const value of values) {
        if (typeof value.id !== 'string' || !ID.test(value.id) || ids.has(value.id)) invalid();
        ids.add(value.id);
    }
    return ids;
}
function guidance(value) {
    return { summary: displayText(value.summary), evidenceExamples: value.evidenceExamples.map(displayText),
        startingActions: value.startingActions.map(displayText) };
}
function questionSources(question, sourceById) {
    if (!Array.isArray(question.sourceIds) || !question.sourceIds.length || question.sourceIds.length > 16 ||
        new Set(question.sourceIds).size !== question.sourceIds.length) invalid();
    return question.sourceIds.map(id => {
        const source = sourceById.get(id);
        if (!source) invalid();
        let url;
        try { url = new URL(source.url); } catch (_) { invalid(); }
        if (typeof source.url !== 'string' || url.href !== source.url || url.origin !== 'https://www.ncsc.govt.nz' ||
            url.username || url.password || url.search || url.hash) invalid();
        if (typeof source.lastVerifiedAt !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(source.lastVerifiedAt) ||
            !Number.isFinite(Date.parse(source.lastVerifiedAt)) ||
            new Date(source.lastVerifiedAt).toISOString().slice(0, 10) !== source.lastVerifiedAt) invalid();
        return { id, title: displayText(source.title), url: source.url, lastVerifiedAt: source.lastVerifiedAt };
    });
}
function displayText(value) {
    if (typeof value !== 'string' || !value.trim()) invalid();
    return value;
}
function freeze(value) {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
    return value;
}
function invalid() { throw new Error('ncsc_metadata_invalid'); }

module.exports = { createNcscQuestionnaireMetadata };
