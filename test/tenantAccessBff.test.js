const { resolveTenantAccess } = require('../api/shared/tenantAccess');

const TENANT_ID = '947787df-88fd-4417-b6b2-99c13d8410ba';
const SUBJECT_ID = 'acada13b-5614-49d6-a356-88d816aa0a3c';
const OTHER_SUBJECT_ID = '888f6a8c-928e-4a91-b214-7f7597797e1b';
const SUBJECT_KEY = `${TENANT_ID}:${SUBJECT_ID}`;

function environment(overrides = {}) {
    return Object.assign({
        NOFRIES_REQUIRE_AUTH: 'true',
        NOFRIES_ALLOWED_SUBJECTS: SUBJECT_KEY,
        NOFRIES_ADMIN_SUBJECTS: SUBJECT_KEY,
        NOFRIES_ALLOWED_EMAILS: 'joel@nofries.nz,forged-admin@nofries.nz',
        NOFRIES_ADMIN_EMAILS: 'forged-admin@nofries.nz',
        NOFRIES_DEFAULT_TENANT_ID: 'nofries-workspace',
        NOFRIES_TENANT_NAME: 'No Fries workspace'
    }, overrides);
}

function identity(overrides = {}) {
    return Object.assign({
        email: 'joel@nofries.nz',
        name: 'Joel Harvey',
        provider: 'entra-bff',
        principalId: SUBJECT_ID,
        tenantId: TENANT_ID,
        subjectKey: SUBJECT_KEY,
        isAuthenticated: true
    }, overrides);
}

describe('immutable BFF tenant authorization', () => {
    test('authorizes and assigns roles only through exact tid:oid membership', () => {
        const access = resolveTenantAccess(identity({
            email: 'forged-admin@nofries.nz'
        }), environment());

        expect(access).toMatchObject({
            allowed: true,
            reason: 'approved',
            user: {
                email: 'forged-admin@nofries.nz',
                principalId: SUBJECT_ID,
                subjectKey: SUBJECT_KEY,
                actorId: SUBJECT_KEY,
                role: 'admin'
            },
            authentication: {
                provider: 'entra-bff',
                immutableSubject: true,
                tenantWideAccess: false
            }
        });
        expect(access.user.capabilities).toEqual(expect.arrayContaining([
            'onboarding:approve',
            'onboarding:execute',
            'customer-controls:run',
            'tenant:admin'
        ]));
    });

    test('does not let an approved or administrator email substitute for another subject', () => {
        const otherSubjectKey = `${TENANT_ID}:${OTHER_SUBJECT_ID}`;
        const access = resolveTenantAccess(identity({
            email: 'forged-admin@nofries.nz',
            principalId: OTHER_SUBJECT_ID,
            subjectKey: otherSubjectKey
        }), environment());

        expect(access.allowed).toBe(false);
        expect(access.reason).toBe('identity_not_approved');
        expect(access.user.role).toBe('consultant');
        expect(access.user.capabilities).not.toContain('tenant:admin');
    });

    test('rejects a mismatched subject key even when its tenant and object fields are approved', () => {
        const access = resolveTenantAccess(identity({
            subjectKey: `${TENANT_ID}:${OTHER_SUBJECT_ID}`
        }), environment());

        expect(access.allowed).toBe(false);
        expect(access.reason).toBe('identity_missing');
        expect(access.user).toBeNull();
    });

    test('keeps email optional and never uses it as the BFF authorization key', () => {
        const access = resolveTenantAccess(identity({ email: '' }), environment());

        expect(access.allowed).toBe(true);
        expect(access.user.email).toBe('');
        expect(access.user.actorId).toBe(SUBJECT_KEY);
        expect(access.user.role).toBe('admin');
    });

    test('maps a missing hosted session identity to authentication_required', () => {
        const access = resolveTenantAccess({
            provider: 'entra-bff',
            isAuthenticated: false
        }, environment());

        expect(access.allowed).toBe(false);
        expect(access.reason).toBe('authentication_required');
    });

    test('ignores legacy email roles when no immutable role mapping exists', () => {
        const access = resolveTenantAccess(identity({
            email: 'forged-admin@nofries.nz'
        }), environment({
            NOFRIES_ADMIN_SUBJECTS: '',
            NOFRIES_SERVICE_OWNER_SUBJECTS: ''
        }));

        expect(access.allowed).toBe(true);
        expect(access.user.role).toBe('consultant');
        expect(access.user.capabilities).not.toContain('tenant:admin');
    });
});
