'use strict';

const { decideServiceIntake } = require('../api/shared/appLifecycle/serviceIntakeDecision');

const oneMatch = {
    source: 'dashboard',
    contactRequested: true,
    verifiedSignInEmail: true,
    workspaceKind: 'own_organisation',
    lookupComplete: true,
    exactMatchCount: 1
};

describe('customer-initiated service intake decision', () => {
    test.each([null, {}, { ...oneMatch, contactRequested: false },
        { ...oneMatch, contactRequested: 'true' }])('requires an explicit request', facts => {
        expect(decideServiceIntake(facts)).toBe('no_action');
    });

    test.each([[0, 'create_prospect'], [1, 'use_existing'], [2, 'operator_review'],
        [null, 'operator_review'], ['1', 'operator_review'], [-1, 'operator_review']])(
        'routes a complete count of %p to %s', (exactMatchCount, outcome) => {
            expect(decideServiceIntake({ ...oneMatch, exactMatchCount })).toBe(outcome);
        });

    test.each([
        { source: 'public_enquiry' }, { verifiedSignInEmail: false },
        { workspaceKind: 'consultant_client' }, { workspaceKind: undefined },
        { lookupComplete: false }, { lookupComplete: undefined }
    ])('requires manual review for uncertain origin or scope (%j)', overrides => {
        for (const exactMatchCount of [0, 1]) {
            expect(decideServiceIntake({ ...oneMatch, exactMatchCount, ...overrides })).toBe('operator_review');
        }
    });
});
