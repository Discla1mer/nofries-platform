'use strict';

const { createIso27001FrameworkProfile } = require('../api/shared/assessmentEngine/iso27001FrameworkProfile');
const { publishFrameworkProfile, createFrameworkRegistry, calculateFrameworkProfileSha256 } =
    require('../api/shared/assessmentEngine/frameworkProfileRegistry');
const { getDefaultFrameworkRegistry } = require('../api/shared/assessmentEngine/ncscFrameworkProfile');
const { createAssessment } = require('../api/shared/assessmentLifecycle/assessmentDomain');
const { act, creation, reference, response, tenant } = require('./fixtures/assessmentLifecycle');

const profile = createIso27001FrameworkProfile();
const profilePin = '1971ad65405f1c20d8e13a65a26a7b40e9ff48b63505db4f0336d32d64fae73d';
const sourcePin = '66ce68bdf0d8ea2d271c52f68d6505b7a50f69f8d8d5ce40bcf833320caef1fd';
const clauseIds = '4.1 4.2 4.3 4.4 5.1 5.2 5.3 6.1.2 6.1.3 6.2 6.3 7.1 7.2 7.4 7.5 8.1 8.2 8.3 9.1 9.2 9.3 10.1 10.2'
    .split(' ').map(id => `C${id}`);
const themes = [['A.5', 37], ['A.6', 8], ['A.7', 14], ['A.8', 34]];
const annexIds = themes.flatMap(([theme, count]) => Array.from({ length: count }, (_, i) => `${theme}.${i + 1}`));
const ids = [...clauseIds, ...annexIds];
const optionIds = ['not_started', 'partly_in_place', 'in_place', 'in_place_with_evidence', 'not_applicable'];

test('pins the edition, source and complete publication without registering it for free assessments', () => {
    expect(reference(profile)).toEqual({
        frameworkId: 'iso-iec-27001', frameworkVersion: '2022',
        profileId: 'nf-iso-27001-2022-readiness', profileVersion: '2026-11-19.1',
        catalogueSha256: profilePin, sourceCatalogueSha256: sourcePin
    });
    expect(calculateFrameworkProfileSha256(profile)).toBe(profilePin);
    expect(() => getDefaultFrameworkRegistry().getProfile(profile.profile.id, profile.profile.version)).toThrow();
    expect(createIso27001FrameworkProfile()).toEqual(profile);
    expect(() => profile.questions[0].guidance.startingActions.push('new action')).toThrow(TypeError);
    const changed = JSON.parse(JSON.stringify(profile));
    changed.questions[0].weight = 2;
    expect(() => publishFrameworkProfile(changed)).toThrow(expect.objectContaining({ code: 'catalogue_digest_mismatch' }));
});

test('covers seven clause groups and exactly the four 2022 themes, with each item in sequence', () => {
    expect(profile.domains.map(d => d.id)).toEqual(['C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'C10', ...themes.map(t => t[0])]);
    expect(profile.controls.map(c => c.id)).toEqual(ids);
    expect(new Set(annexIds).size).toBe(93);
    expect(profile.questions.map(q => q.id)).toEqual(ids.map(id => `${id}-Q1`));
    expect(profile.questions.map(q => q.controlId)).toEqual(ids);
    for (const c of profile.controls) {
        const annex = annexIds.includes(c.id);
        expect(c.domainId).toBe(annex ? c.id.slice(0, 3) : c.id.split('.')[0]);
        expect(c.sourceReferences[0].referenceId).toBe(annex ? c.id : c.id.slice(1));
    }
});

test('gives every item its own prompt, explanation, example and action', () => {
    expect(profile.profile.title).toBe('ISO 27001 readiness self-assessment');
    expect(JSON.stringify(profile)).not.toMatch(/\b(?:certified|compliant|audit\w*)\b/i);
    for (const field of [
        profile.controls.map(c => c.title), profile.questions.map(q => q.prompt),
        profile.questions.map(q => q.guidance.summary), profile.questions.map(q => q.guidance.evidenceExamples[0]),
        profile.questions.map(q => q.guidance.startingActions[0])
    ]) {
        expect(field.every(text => typeof text === 'string' && text.trim().length > 0)).toBe(true);
        expect(new Set(field).size).toBe(ids.length);
    }
    expect(profile.questions.every(q => q.prompt.endsWith('?'))).toBe(true);
});

test('publishes equal item weights and a separate evidence status for each group', () => {
    expect(profile.responseOptions.map(o => o.id)).toEqual(optionIds);
    expect(profile.responseOptions.map(o => o.label)).toEqual([
        'Not started', 'Partly in place', 'In place', 'In place with evidence', 'Not applicable with a reason'
    ]);
    expect(profile.responseOptions.map(o => o.implementationFactor)).toEqual([0, 0.5, 1, 1, null]);
    expect(profile.responseOptions.map(o => o.applicable)).toEqual([true, true, true, true, false]);
    for (const q of profile.questions) {
        expect(q.weight).toBe(1);
        expect(q.responseOptionIds).toEqual(annexIds.includes(q.controlId) ? optionIds : optionIds.slice(0, 4));
    }
});

test('enforces Annex-only reason digests and seals the complete response set through the existing lifecycle', () => {
    const registry = createFrameworkRegistry([profile]);
    const context = { aggregate: tenant(), registry };
    const now = { now: '2026-11-19T12:00:00.000Z' };
    const start = creation(profile, now);
    start.payload.moduleId = 'cyber_security';
    const created = createAssessment(context.aggregate, start, registry);
    const reasonDigest = 'b'.repeat(64);
    const save = responses => act(context, created, 'save', { responses }, now);
    const excluded = 'A.8.30-Q1';
    expect(() => save([response('C4.1-Q1', 'not_applicable', reasonDigest)])).toThrow(
        expect.objectContaining({ code: 'assessment_response_option_invalid' }));
    expect(() => save([response(excluded, 'not_applicable')])).toThrow(
        expect.objectContaining({ code: 'assessment_not_applicable_rationale_required' }));
    expect(() => save([response(excluded, 'in_place', reasonDigest)])).toThrow(
        expect.objectContaining({ code: 'assessment_rationale_invalid' }));
    const responses = profile.questions.map((q, i) => response(q.id, optionIds[i % 4]));
    responses[responses.findIndex(r => r.itemId === excluded)] = response(excluded, 'not_applicable', reasonDigest);
    expect(() => act(context, save(responses.slice(1)), 'submit', {}, now)).toThrow(
        expect.objectContaining({ code: 'assessment_responses_incomplete' }));
    const submitted = act(context, save(responses), 'submit', {}, now);
    expect(submitted.status).toBe('submitted');
    expect(submitted.responses.find(r => r.itemId === excluded).applicabilityRationaleSha256).toBe(reasonDigest);
    expect(submitted.profileRef.catalogueSha256).toBe(profilePin);
});
