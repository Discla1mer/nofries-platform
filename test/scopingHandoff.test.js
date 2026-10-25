const {
    applyContextFacts,
    buildContextSnapshot,
    createOrganisation,
    transitionLifecycle
} = require('../api/shared/lifecycle/lifecycleModel');
const {
    answerHasKnownValue,
    buildLifecycleScopingPreview,
    createAssessmentPrefill,
    mergePrefillAnswers
} = require('../api/shared/scoping/lifecycleScopingMapper');

describe('lifecycle to MSP scoping mapping', () => {
    test('maps only defensible known facts and keeps related context as explicit gaps', () => {
        const organisation = createOrganisation({
            id: 'organisation_mapping',
            displayName: 'Mapping Limited',
            now: '2026-08-15T00:00:00.000Z'
        });
        applyContextFacts(organisation, [
            { field: 'company.name', value: 'Mapping Limited', certainty: 'explicit' },
            { field: 'company.summary', value: 'Support is unreliable', certainty: 'explicit' },
            { field: 'endpoints.estimatedCount', value: '612', certainty: 'explicit' },
            { field: 'security.tools', value: 'Microsoft Defender; Huntress', certainty: 'explicit' },
            { field: 'applications.important', value: 'Xero; Line-of-business ERP', certainty: 'explicit' },
            { field: 'network.summary', value: 'Two offices with mixed firewalls', certainty: 'explicit' },
            { field: 'commercial.preferredTiming', value: 'within 90 days', certainty: 'explicit' }
        ], {
            source: 'website_conversation',
            actorId: 'prospect_agent',
            at: '2026-08-15T00:01:00.000Z'
        });
        transitionLifecycle(organisation, 'discovery', { actorId: 'operator' });
        transitionLifecycle(organisation, 'scoping', { actorId: 'operator' });

        const preview = buildLifecycleScopingPreview(buildContextSnapshot(organisation), {
            customers: [],
            assessments: []
        });

        expect(preview.answers['estate.endpoints'].value).toBe('250_plus');
        expect(preview.answers['priorities.timeframe'].value).toBe('now');
        expect(preview.answers['applications.critical'].value).toContain('Xero');
        expect(preview.answers['security.tools'].value).toContain('Microsoft Defender');
        expect(preview.answers['security.endpoint'].value).toBe('');
        expect(preview.answers['security.endpoint'].notes).toContain('Confirm whether coverage is complete and managed');
        expect(preview.questionGaps).toEqual(expect.arrayContaining([
            expect.objectContaining({ questionId: 'productivity.platform', status: 'unknown' }),
            expect.objectContaining({ questionId: 'security.endpoint', status: 'unknown' }),
            expect.objectContaining({ questionId: 'security.monitoring', status: 'unknown' })
        ]));
        expect(preview.mappedQuestions.find((item) => item.questionId === 'security.endpoint')).toMatchObject({
            hasKnownValue: false,
            sourceFields: ['security.tools']
        });
        expect(preview.knownFacts.find((item) => item.field === 'network.summary').displayValue).toContain('mixed firewalls');
    });

    test('does not fabricate endpoint or productivity answers when lifecycle values are unknown', () => {
        const organisation = createOrganisation({
            id: 'organisation_unknown',
            displayName: 'Unknown Limited'
        });
        transitionLifecycle(organisation, 'discovery', { actorId: 'operator' });
        transitionLifecycle(organisation, 'scoping', { actorId: 'operator' });
        const preview = buildLifecycleScopingPreview(buildContextSnapshot(organisation));

        expect(preview.answers['estate.endpoints']).toBeUndefined();
        expect(preview.answers['productivity.platform']).toBeUndefined();
        expect(preview.questionGaps).toEqual(expect.arrayContaining([
            expect.objectContaining({ questionId: 'estate.endpoints', status: 'unknown' }),
            expect.objectContaining({ questionId: 'productivity.platform', status: 'unknown' })
        ]));
    });

    test('prefill merge never replaces an operator-confirmed answer', () => {
        const merged = mergePrefillAnswers({
            'estate.endpoints': answer('100_249', 'Confirmed in workshop')
        }, {
            'estate.endpoints': answer('50_99', 'Earlier website estimate'),
            'productivity.platform': answer('microsoft_365', 'Earlier website discovery')
        });

        expect(merged['estate.endpoints'].value).toBe('100_249');
        expect(merged['estate.endpoints'].notes).toContain('Confirmed in workshop');
        expect(merged['estate.endpoints'].notes).toContain('Earlier website estimate');
        expect(merged['productivity.platform'].value).toBe('microsoft_365');
        expect(answerHasKnownValue({ value: 'unknown' })).toBe(false);
        expect(answerHasKnownValue({ value: 'microsoft_365' })).toBe(true);

        const prefill = createAssessmentPrefill({
            organisationId: 'organisation_prefill',
            knownFacts: [{ field: 'company.name' }],
            mappedQuestions: [{ questionId: 'productivity.platform', hasKnownValue: true }],
            questionGaps: [{ questionId: 'security.endpoint' }],
            missingContextFields: [{ field: 'endpoints.estimatedCount' }]
        }, {
            at: '2026-08-15T01:00:00.000Z',
            actorEmail: 'joel@example.com'
        });
        expect(prefill).toMatchObject({
            source: 'lifecycle_discovery',
            organisationId: 'organisation_prefill',
            mappedQuestionIds: ['productivity.platform'],
            gapQuestionIds: ['security.endpoint'],
            unknownContextFields: ['endpoints.estimatedCount']
        });
    });
});

function answer(value, notes) {
    return {
        value,
        notes,
        evidence: '',
        importance: 'medium',
        confidence: 'high',
        internalNotes: ''
    };
}
