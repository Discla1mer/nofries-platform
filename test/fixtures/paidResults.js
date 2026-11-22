'use strict';
const { createNistFrameworkProfile } = require('../../api/shared/assessmentEngine/nistFrameworkProfile');

// Synthetic titles and counts by domain exercise a full-length statement before ISO-2 lands.
function isoFixture() {
    const domains = [], controls = [], questions = [];
    for (const [id, count] of Object.entries({ C4: 3, C5: 3, C6: 3, C7: 3, C8: 3, C9: 3, C10: 2,
        'A.5': 37, 'A.6': 8, 'A.7': 14, 'A.8': 34 })) {
        domains.push({ id, title: 'Practice group ' + id, order: domains.length + 1 });
        for (let i = 1; i <= count; i++) {
            const controlId = id + '.' + i;
            controls.push({ id: controlId, title: 'Review the team’s method for ' + controlId, order: controls.length + 1, domainId: id });
            questions.push({ id: controlId + '-Q1', controlId, order: 1, weight: 1, guidance: { startingActions: ['Review the next step together.'] },
                responseOptionIds: ['not_started', 'partly_in_place', 'in_place', 'in_place_with_evidence', ...(id.startsWith('A.') ? ['not_applicable'] : [])] });
        }
    }
    return { framework: { id: 'iso-iec-27001', version: '2022' }, profile: { id: 'nf-iso-27001-2022-readiness', version: '2026-11-19.1' },
        catalogueSha256: 'a'.repeat(64), sourceCatalogueSha256: 'b'.repeat(64), domains, questions, controls,
        responseOptions: [['not_started', 'Not started', 0], ['partly_in_place', 'Partly in place', .5], ['in_place', 'In place', 1],
            ['in_place_with_evidence', 'In place with evidence', 1], ['not_applicable', 'Not applicable', null]]
            .map(([id, label, implementationFactor]) => ({ id, label, implementationFactor, applicable: id !== 'not_applicable' })) };
}

const reason = 'This scope excludes <em>external devices</em> & equipment hired for events.';
function fixture(iso, publication = iso ? isoFixture() : createNistFrameworkProfile()) {
    const ref = { frameworkId: publication.framework.id, frameworkVersion: publication.framework.version, profileId: publication.profile.id,
        profileVersion: publication.profile.version, catalogueSha256: publication.catalogueSha256, sourceCatalogueSha256: publication.sourceCatalogueSha256 };
    const responses = publication.questions.map((q, i) => {
        const optionId = iso ? q.controlId.startsWith('A.6.') ? 'not_applicable' : ['partly_in_place', 'in_place_with_evidence', 'not_started'][i % 3]
            : ['yes', 'partial', 'unknown', 'no', 'not_applicable'][i % 5];
        return { itemId: q.id, optionId, rationale: optionId === 'not_applicable' ? { text: reason } : null };
    });
    return { publication, record: { schemaVersion: 1, assessment: { moduleId: 'cyber_security', assessmentId: 'synthetic-board',
        profileRef: ref, status: 'submitted', revision: 3, responses, submission: { revision: 3,
            submittedAt: '2026-11-19T08:00:00.000Z', responseSetSha256: 'e'.repeat(64) } } } };
}
module.exports = { fixture, reason };
