const { getRequestIdentity } = require('../api/shared/identity');
const { resolveTenantAccess } = require('../api/shared/tenantAccess');

function staticWebAppsPrincipal(email) {
    return Buffer.from(JSON.stringify({
        identityProvider: 'aad',
        userId: `principal-${email}`,
        userDetails: email,
        claims: [
            { typ: 'http://schemas.microsoft.com/identity/claims/tenantid', val: 'tenant-one' }
        ]
    })).toString('base64');
}

function requestFor(email) {
    return {
        headers: {
            'x-ms-client-principal': staticWebAppsPrincipal(email)
        }
    };
}

function hostedEnvironment(value) {
    const env = {
        NODE_ENV: 'production',
        NOFRIES_ALLOWED_EMAILS: 'approved@example.com',
        NOFRIES_ADMIN_EMAILS: 'approved@example.com'
    };
    if (value !== undefined) {
        env.NOFRIES_REQUIRE_AUTH = value;
    }
    return env;
}

describe('tenant authentication mode', () => {
    test.each([
        ['missing', undefined],
        ['empty', ''],
        ['malformed', 'sometimes'],
        ['hosted', 'true']
    ])('%s authentication mode rejects an authenticated but unapproved SWA principal', (_label, value) => {
        const env = hostedEnvironment(value);
        const identity = getRequestIdentity(requestFor('outsider@example.invalid'), env);
        const access = resolveTenantAccess(identity, env);

        expect(identity).toMatchObject({
            email: 'outsider@example.invalid',
            isAuthenticated: true
        });
        expect(access).toMatchObject({
            allowed: false,
            reason: 'identity_not_approved',
            authentication: {
                required: true,
                authenticated: true
            }
        });
    });

    test('exact false preserves the explicit local-development identity path', () => {
        const env = {
            NODE_ENV: 'development',
            NOFRIES_REQUIRE_AUTH: 'false',
            NOFRIES_DEV_EMAIL: 'developer@example.test'
        };
        const identity = getRequestIdentity({ headers: {} }, env);
        const access = resolveTenantAccess(identity, env);

        expect(identity).toMatchObject({
            email: 'developer@example.test',
            isAuthenticated: false,
            emailSource: 'client'
        });
        expect(access).toMatchObject({
            allowed: true,
            authentication: {
                required: false,
                authenticated: false
            }
        });
    });
});
