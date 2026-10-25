const {
    calculateMonthlyTotal,
    normaliseCommercialSummary,
    validateProposalDraft
} = require('../api/shared/proposalQuality');
const { createProposalReviewAgent } = require('../api/shared/agents/proposalReviewAgent');

function screenshotInput() {
    return {
        customer: { name: 'No Fries HQ', industry: 'Managed services', region: 'Auckland' },
        assessment: {
            answers: {
                'estate.users': { value: 'under_10', notes: '' },
                'estate.endpoints': { value: 'under_10', notes: '' },
                'estate.locations': { value: 'one', notes: '' }
            }
        },
        evidence: [{
            questionId: 'support.channels',
            question: 'Which support channels are preferred?',
            answer: 'Chat and email',
            notes: 'No need for telephone support. Is there a chat support bot on No Fries?',
            confidence: 'high'
        }],
        proposal: {
            id: 'proposal_1',
            title: 'No Fries Limited — managed IT proposal',
            executiveSummary: 'This proposal is based on the information No Fries Limited provided.',
            objectives: ['Control IT cost and complexity'],
            observations: [
                'Which support problems should the new service fix? — Slow response, Cost or unclear billing',
                'What is causing the most difficulty today? — Issues bounce between people or suppliers'
            ],
            recommendations: [
                {
                    recommendationId: 'rec_support',
                    serviceKey: 'ai-service-desk',
                    serviceName: 'Phone, chat and email support',
                    outcome: 'Requests are recorded, handled and checked before closure.',
                    why: 'no need for telephone support chat and email is fine. is there a chat support bot on nofries?',
                    confirm: '',
                    roadmap: 'now'
                },
                {
                    recommendationId: 'rec_proof',
                    serviceKey: 'monthly-proof',
                    serviceName: 'Proof every month',
                    outcome: 'A clear monthly record of coverage, device health, protection, backup, support activity and next actions.',
                    why: 'looking for value every month.',
                    confirm: '',
                    roadmap: 'next'
                }
            ],
            pricing: {
                perUserMonthly: 119,
                onboardingFrom: 750,
                additionalEndpointMonthly: 20,
                additionalLocationMonthly: 125
            },
            commercial: {
                userCount: null,
                managedEndpointCount: null,
                locationCount: 1,
                onboardingFeeExGst: 750,
                termMonths: null,
                plannedStart: '',
                confirmed: false,
                monthlyTotalExGst: null
            },
            assumptions: [
                'We will check the current set-up and confirm the price before work starts.',
                'No passwords, access tokens or recovery codes were needed for this review.'
            ],
            nextStep: 'Prepare the managed IT proposal / agreement'
        }
    };
}

describe('proposal review agent', () => {
    test('polishes the observed proposal defects and preserves commercial boundaries', async () => {
        const agent = createProposalReviewAgent({
            env: { NOFRIES_PROPOSAL_REVIEW_RUNTIME: 'mock' }
        });
        const result = await agent.review(screenshotInput());

        expect(result.suggestedProposal.title).toBe('No Fries HQ — Managed IT service proposal');
        expect(result.suggestedProposal.recommendations[0].serviceName).toBe('Chat and email support');
        expect(result.suggestedProposal.recommendations[1].serviceName).toBe('Monthly service reporting and review');
        expect(result.suggestedProposal.observations.join(' ')).not.toMatch(/\?\s*—/);
        expect(result.suggestedProposal.nextStep).toMatch(/Confirm the final service scope/i);
        expect(result.suggestedProposal.assumptions).toHaveLength(1);
        expect(result.warnings).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'exact_user_count_required', blocking: true }),
            expect.objectContaining({ code: 'commercial_confirmation_required', blocking: true })
        ]));
    });

    test('calculates the monthly total in deterministic code', () => {
        const pricing = {
            perUserMonthly: 119,
            onboardingFrom: 750,
            additionalEndpointMonthly: 20,
            additionalLocationMonthly: 125
        };
        expect(calculateMonthlyTotal({ userCount: 10, managedEndpointCount: 12, locationCount: 2 }, pricing)).toBe(1355);
        expect(normaliseCommercialSummary({
            userCount: 10,
            managedEndpointCount: 12,
            locationCount: 2,
            monthlyTotalExGst: 1,
            onboardingFeeExGst: 900,
            confirmed: true
        }, pricing)).toMatchObject({ monthlyTotalExGst: 1355, onboardingFeeExGst: 900 });
    });

    test('returns no approval blockers after exact commercial and wording fixes', () => {
        const input = screenshotInput();
        Object.assign(input.proposal, {
            title: 'No Fries HQ — Managed IT service proposal',
            observations: ['Support response and supplier ownership need improvement.'],
            assumptions: ['Final service boundaries will be recorded in the customer schedule.'],
            nextStep: 'Issue the proposal for customer acceptance.',
            commercial: {
                userCount: 10,
                managedEndpointCount: 12,
                locationCount: 2,
                onboardingFeeExGst: 750,
                termMonths: 12,
                plannedStart: '2026-09-15',
                confirmed: true
            }
        });
        Object.assign(input.proposal.recommendations[0], {
            serviceName: 'Chat and email support',
            why: 'Chat and email are the preferred channels for routine support requests.'
        });
        expect(validateProposalDraft(input).filter((item) => item.blocking)).toHaveLength(0);
    });

    test('uses an explicit stable cache prefix and reports versioned cache usage', async () => {
        const deterministic = await createProposalReviewAgent({
            env: { NOFRIES_PROPOSAL_REVIEW_RUNTIME: 'mock' }
        }).review(screenshotInput());
        const output = Object.assign({}, deterministic.suggestedProposal, {
            warnings: [],
            qualitySummary: 'Reviewed.'
        });
        const create = jest.fn(async () => ({
            requestId: 'proposal-request-1',
            body: {
                id: 'proposal-response-1',
                model: 'gpt-5.6-terra-2026-08-01',
                output: [{
                    type: 'message',
                    content: [{ type: 'output_text', text: JSON.stringify(output) }]
                }],
                usage: {
                    input_tokens: 1000,
                    input_tokens_details: { cached_tokens: 400, cache_write_tokens: 300 },
                    output_tokens: 100,
                    output_tokens_details: { reasoning_tokens: 30 },
                    total_tokens: 1100
                }
            }
        }));
        const agent = createProposalReviewAgent({
            env: {
                NOFRIES_PROPOSAL_REVIEW_RUNTIME: 'openai',
                OPENAI_API_KEY: 'server-only-test-key'
            },
            openaiClient: { create },
            releaseIdentity: { releaseSha: 'b'.repeat(40), runId: '67890' }
        });

        const result = await agent.review(screenshotInput());
        const payload = create.mock.calls[0][0];
        expect(payload).not.toHaveProperty('instructions');
        expect(payload).toMatchObject({
            model: 'gpt-5.6-terra',
            store: false,
            prompt_cache_key: expect.stringContaining('nofries:proposal-review:proposal-review-v2'),
            prompt_cache_options: { mode: 'explicit', ttl: '30m' },
            input: [{
                type: 'message',
                role: 'developer',
                content: [expect.objectContaining({
                    prompt_cache_breakpoint: { mode: 'explicit' }
                })]
            }, expect.objectContaining({ role: 'user' })]
        });
        expect(result.runtime.mode).toBe('openai');
        expect(result.providerModel).toBe('gpt-5.6-terra-2026-08-01');
        expect(result.usage).toMatchObject({
            cachedInputTokens: 400,
            cacheWriteTokens: 300,
            reasoningTokens: 30
        });
        expect(result.approximateCostUsd).toBe(0.00263);
        expect(result.identities).toMatchObject({
            promptVersion: 'proposal-review-v2',
            outputSchemaVersion: 'proposal-review-schema-v1',
            policyId: 'managed_it_2026_08_4',
            releaseSha: 'b'.repeat(40)
        });
    });
});
