'use strict';

const { EntraB2bIdentityProofError, createEntraB2bIdentityVerifier } =
    require('../api/shared/customerSignup/entraB2bIdentityProof');

const TENANT = '11111111-1111-4111-8111-111111111111';
const PRINCIPAL = '22222222-2222-4222-8222-222222222222';
const DIGEST = 'a'.repeat(64);
const baseIdentity = (overrides = {}) => ({
    provider: 'entra-bff', isAuthenticated: true, tenantId: TENANT, principalId: PRINCIPAL,
    subjectKey: `${TENANT}:${PRINCIPAL}`, email: 'matty@example.nz', emailVerified: true,
    mfaSatisfied: true, verifiedAt: 1000, expiresAt: 2000, ...overrides
});
const setup = (identity = baseIdentity()) => {
    const reads = [];
    const verifier = createEntraB2bIdentityVerifier({ expectedTenantId: TENANT,
        identityPolicyId: 'pilot-entra-b2b-mfa-v1', readIdentity: async value => { reads.push(value); return identity; } });
    return { reads, verifier };
};

describe('Entra B2B identity proof boundary', () => {
    test('projects only verified BFF identity facts for invitation acceptance', async () => {
        const { reads, verifier } = setup();
        await expect(verifier.verifyIdentity({ handle: 'opaque-session-handle', invitationDigest: DIGEST }))
            .resolves.toEqual({ subjectKey: `${TENANT}:${PRINCIPAL}`, email: 'matty@example.nz', emailVerified: true,
                identityPolicyId: 'pilot-entra-b2b-mfa-v1', mfaSatisfied: true, invitationDigest: DIGEST,
                verifiedAt: 1000, expiresAt: 2000 });
        expect(reads).toEqual([{ handle: 'opaque-session-handle' }]);
    });

    test.each([
        { tenantId: '33333333-3333-4333-8333-333333333333' },
        { subjectKey: `${TENANT}:33333333-3333-4333-8333-333333333333` },
        { provider: 'other' },
        { isAuthenticated: false }
    ])('rejects an identity fact that is not bound to the invited BFF subject %#', async override => {
        const { verifier } = setup(baseIdentity(override));
        await expect(verifier.verifyIdentity({ handle: 'opaque', invitationDigest: DIGEST }))
            .rejects.toBeInstanceOf(EntraB2bIdentityProofError);
    });

    test('collapses provider lookup failures and never exposes provider details', async () => {
        const verifier = createEntraB2bIdentityVerifier({ expectedTenantId: TENANT,
            identityPolicyId: 'pilot-entra-b2b-mfa-v1', readIdentity: async () => { throw new Error('secret'); } });
        await expect(verifier.verifyIdentity({ handle: 'opaque', invitationDigest: DIGEST }))
            .rejects.toEqual(new EntraB2bIdentityProofError('signup_identity_required'));
    });

    test('does not accept browser-supplied identity fields', async () => {
        const { verifier } = setup();
        await expect(verifier.verifyIdentity({ handle: 'opaque', invitationDigest: DIGEST, subjectKey: `${TENANT}:${PRINCIPAL}` }))
            .rejects.toBeInstanceOf(EntraB2bIdentityProofError);
    });
});
