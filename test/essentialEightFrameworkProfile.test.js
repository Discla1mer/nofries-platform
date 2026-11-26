'use strict';

const { createEssentialEightFrameworkProfile } = require('../api/shared/assessmentEngine/essentialEightFrameworkProfile');
const { createFrameworkRegistry, publishFrameworkProfile, calculateFrameworkProfileSha256 } =
    require('../api/shared/assessmentEngine/frameworkProfileRegistry');
const { getDefaultFrameworkRegistry } = require('../api/shared/assessmentEngine/ncscFrameworkProfile');
const { createAssessment } = require('../api/shared/assessmentLifecycle/assessmentDomain');
const { act, creation, response, tenant } = require('./fixtures/assessmentLifecycle');

const profile = createEssentialEightFrameworkProfile();
const pin = '44bb97f76e24e96e55b462581a91f5ba052f26172ccade7964771e0b05fc962f';
const ids = ['yes', 'partial', 'no', 'unknown'];

test('publishes only when explicitly requested and refuses silent edits to the reviewed edition', () => {
    expect(profile.profile.id).toBe('nf-essential-eight-ml1');
    expect(profile.framework.version).toBe('2023-11');
    expect(profile.sourceCatalogueSha256).toBe('a8b86a91c812efe5b683a45b4d70124a6d5d905419c893f190ad602636195df4');
    expect(profile.catalogueSha256).toBe(pin);
    expect(calculateFrameworkProfileSha256(profile)).toBe(pin);
    expect(createEssentialEightFrameworkProfile()).toEqual(profile);
    expect(() => getDefaultFrameworkRegistry().getProfile(profile.profile.id, profile.profile.version)).toThrow();
    expect(Object.isFrozen(profile.questions[0].guidance)).toBe(true);
    const altered = JSON.parse(JSON.stringify(profile));
    altered.questions[0].prompt = 'A different question?';
    expect(() => publishFrameworkProfile(altered)).toThrow(expect.objectContaining({ code: 'catalogue_digest_mismatch' }));
});

test('carries source, licence and adaptation notice with the published content', () => {
    const [source] = profile.sources;
    expect(source).toMatchObject({ authority: 'Australian Signals Directorate', version: '2023-11',
        licence: 'CC BY 4.0', licenceUrl: 'https://creativecommons.org/licenses/by/4.0/' });
    expect(new URL(source.url).hostname).toBe('www.cyber.gov.au');
    expect(profile.statements.attribution).toMatch(/Commonwealth of Australia 2023.*No Fries adapted/);
    expect(profile.statements.claim).toMatch(/does not establish a maturity level/);
});

test.each([
    ['apps', 'Patch applications', 5], ['os', 'Patch operating systems', 5],
    ['mfa', 'Multi-factor authentication', 4], ['admin', 'Restrict administrative privileges', 4],
    ['app-control', 'Application control', 2], ['macros', 'Restrict Microsoft Office macros', 3],
    ['browser', 'User application hardening', 3], ['backup', 'Regular backups', 3]
])('%s has the expected questions, source and practical help', (id, title, count) => {
    expect(profile.domains).toHaveLength(8);
    expect(profile.domains.find(d => d.id === id).title).toBe(title);
    const control = profile.controls.find(c => c.domainId === id);
    expect(control.sourceReferences[0].sourceId).toBe(profile.sources[0].id);
    const items = profile.questions.filter(q => q.controlId === control.id);
    expect(items).toHaveLength(count);
    for (const item of items) {
        expect(item.prompt).toMatch(/\?$/);
        expect(item.guidance.evidenceExamples[0]).toBeTruthy();
        expect(item.guidance.startingActions[0]).toBeTruthy();
        expect(item.responseOptionIds).toEqual(ids);
    }
});

test('in a disposable registry all four answers survive submission and unknown stays distinct from no', () => {
    expect(profile.responseOptions.map(o => [o.id, o.applicable, o.implementationFactor])).toEqual([
        ['yes', true, 1], ['partial', true, 0.5], ['no', true, 0], ['unknown', true, null]
    ]);
    const ctx = { aggregate: tenant(), registry: createFrameworkRegistry([profile]) };
    const now = { now: '2026-11-26T12:00:00.000Z' };
    const start = creation(profile, now);
    start.payload.moduleId = 'cyber_security';
    const created = createAssessment(ctx.aggregate, start, ctx.registry);
    const answers = profile.questions.map((q, i) => response(q.id, ids[i % ids.length]));
    const saved = act(ctx, created, 'save', { responses: answers }, now);
    const result = act(ctx, saved, 'submit', {}, now);
    expect(result.status).toBe('submitted');
    expect(result.profileRef.catalogueSha256).toBe(pin);
    expect(result.responses).toHaveLength(29);
    expect(new Set(result.responses.map(r => r.optionId))).toEqual(new Set(ids));
});
