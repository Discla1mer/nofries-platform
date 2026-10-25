'use strict';

const {
    McpAuthError,
    mcpIdentityFromClaims
} = require('../api/shared/mcpAuth');
const {
    ROLES,
    ROLE_CAPABILITIES,
    parseMcpApplicationSubjectTenants,
    resolveTenantAccess
} = require('../api/shared/tenantAccess');

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const PRINCIPAL_ID = '22222222-2222-4222-8222-222222222222';
const CLIENT_ID = '33333333-3333-4333-8333-333333333333';
const BROWSER_SUBJECT = `${TENANT_ID}:${PRINCIPAL_ID}`;
const SUBJECT = `${BROWSER_SUBJECT}:${CLIENT_ID}`;

function applicationClaims(overrides = {}) {
    return Object.assign({
        tid: TENANT_ID,
        oid: PRINCIPAL_ID,
        azp: CLIENT_ID,
        roles: ['nofries.lifecycle.read.application']
    }, overrides);
}

describe('MCP application identity classification', () => {
    test('canonicalises the immutable service-principal identity and ignores mutable user claims', () => {
        const identity = mcpIdentityFromClaims(applicationClaims({
            tid: TENANT_ID.toUpperCase(),
            oid: PRINCIPAL_ID.toUpperCase(),
            azp: CLIENT_ID.toUpperCase(),
            email: 'admin@example.invalid',
            preferred_username: 'owner@example.invalid',
            upn: 'operator@example.invalid',
            name: 'Mutable display name'
        }));

        expect(identity).toEqual({
            email: '',
            name: '',
            provider: 'mcp-oauth-application',
            principalId: PRINCIPAL_ID,
            tenantId: TENANT_ID,
            clientId: CLIENT_ID,
            subjectKey: SUBJECT,
            isAuthenticated: true
        });
    });

    test.each([
        ['missing tenant', { tid: undefined }],
        ['malformed tenant', { tid: 'not-a-guid' }],
        ['missing object', { oid: undefined }],
        ['malformed object', { oid: 'not-a-guid' }],
        ['missing client', { azp: undefined }],
        ['malformed client', { azp: 'not-a-guid' }],
        ['null azp with valid appid', { azp: null, appid: CLIENT_ID }],
        ['malformed azp with valid appid', { azp: 'not-a-guid', appid: CLIENT_ID }],
        ['valid azp with malformed appid', { appid: 'not-a-guid' }],
        ['conflicting client claims', {
            appid: '44444444-4444-4444-8444-444444444444'
        }]
    ])('rejects an app-classified token with %s', (_label, override) => {
        expect(() => mcpIdentityFromClaims(applicationClaims(override)))
            .toThrow(McpAuthError);
        try {
            mcpIdentityFromClaims(applicationClaims(override));
        } catch (error) {
            expect(error.details.code).toBe('invalid_token');
        }
    });

    test('accepts a matching appid fallback and matching dual client claims', () => {
        expect(mcpIdentityFromClaims(applicationClaims({ azp: undefined, appid: CLIENT_ID })).clientId)
            .toBe(CLIENT_ID);
        expect(mcpIdentityFromClaims(applicationClaims({ appid: CLIENT_ID })).clientId)
            .toBe(CLIENT_ID);
    });

    test.each([
        ['legacy role', ['nofries.lifecycle.read']],
        ['extra role', ['nofries.lifecycle.read.application', 'extra.role']],
        ['duplicate role', ['nofries.lifecycle.read.application', 'nofries.lifecycle.read.application']],
        ['padded role', [' nofries.lifecycle.read.application ']]
    ])('rejects a non-canonical application %s', (_label, roles) => {
        expect(() => mcpIdentityFromClaims(applicationClaims({ roles })))
            .toThrow(McpAuthError);
    });

    test.each(['', '   ', null])('rejects a roles token with a present empty delegated scope: %p', (scp) => {
        expect(() => mcpIdentityFromClaims(applicationClaims({ scp })))
            .toThrow(McpAuthError);
    });

    test('preserves the delegated-user path when scp is present', () => {
        const identity = mcpIdentityFromClaims(applicationClaims({
            scp: 'nofries.lifecycle.read',
            email: 'delegated@example.test',
            appid: '44444444-4444-4444-8444-444444444444'
        }));
        expect(identity.provider).toBe('mcp-oauth');
        expect(identity.email).toBe('delegated@example.test');
        expect(identity.clientId).toBeUndefined();
    });
});

describe('MCP application tenant access', () => {
    const applicationIdentity = mcpIdentityFromClaims(applicationClaims());

    test('maps one exact service principal to one internal tenant with read-only capability', () => {
        const access = resolveTenantAccess(applicationIdentity, {
            NOFRIES_REQUIRE_AUTH: 'true',
            NOFRIES_MCP_APPLICATION_SUBJECT_TENANTS: `${SUBJECT}=no-fries-hq`,
            NOFRIES_ALLOWED_EMAILS: 'admin@example.invalid',
            NOFRIES_ADMIN_EMAILS: 'admin@example.invalid',
            NOFRIES_ALLOWED_TENANT_IDS: TENANT_ID,
            NOFRIES_ALLOW_TENANT_WIDE: 'true',
            NOFRIES_DEFAULT_TENANT_ID: 'wrong-default'
        });

        expect(access.allowed).toBe(true);
        expect(access.tenant.id).toBe('no-fries-hq');
        expect(access.user).toMatchObject({
            email: '',
            principalId: PRINCIPAL_ID,
            identityTenantId: TENANT_ID,
            subjectKey: SUBJECT,
            clientId: CLIENT_ID,
            actorId: SUBJECT,
            role: ROLES.MCP_READER,
            capabilities: ['lifecycle:read']
        });
        expect(access.authentication).toMatchObject({
            provider: 'mcp-oauth-application',
            tenantWideAccess: false,
            immutableSubject: true
        });
        expect(ROLE_CAPABILITIES[ROLES.MCP_READER]).toEqual(['lifecycle:read']);
    });

    test('does not enter email, tenant-wide, default-tenant or email-role branches', () => {
        const hostile = Object.assign({}, applicationIdentity, {
            email: 'admin@example.invalid',
            name: 'Ignored',
            subjectKey: `${TENANT_ID}:44444444-4444-4444-8444-444444444444:${CLIENT_ID}`
        });
        const access = resolveTenantAccess(hostile, {
            NOFRIES_REQUIRE_AUTH: 'true',
            NOFRIES_ALLOWED_EMAILS: 'admin@example.invalid',
            NOFRIES_ADMIN_EMAILS: 'admin@example.invalid',
            NOFRIES_ALLOWED_TENANT_IDS: TENANT_ID,
            NOFRIES_ALLOW_TENANT_WIDE: 'true',
            NOFRIES_DEFAULT_TENANT_ID: 'wrong-default'
        });

        expect(access.allowed).toBe(false);
        expect(access.reason).toBe('identity_missing');
        expect(access.user).toBeNull();
        expect(access.tenant.id).toBe('unassigned');
        expect(access.authentication.tenantWideAccess).toBe(false);
    });

    test('denies an authenticated but unmapped negative service principal', () => {
        const negative = mcpIdentityFromClaims(applicationClaims({
            oid: '55555555-5555-4555-8555-555555555555',
            azp: '66666666-6666-4666-8666-666666666666'
        }));
        const access = resolveTenantAccess(negative, {
            NOFRIES_REQUIRE_AUTH: 'true',
            NOFRIES_MCP_APPLICATION_SUBJECT_TENANTS: `${SUBJECT}=no-fries-hq`
        });
        expect(access.allowed).toBe(false);
        expect(access.reason).toBe('identity_not_approved');
        expect(access.user.role).toBe(ROLES.MCP_READER);
        expect(access.user.capabilities).toEqual(['lifecycle:read']);
        expect(access.tenant.id).toBe('unassigned');
    });

    test('denies a different client at the same tenant and object', () => {
        const alternateClient = '77777777-7777-4777-8777-777777777777';
        const negative = mcpIdentityFromClaims(applicationClaims({ azp: alternateClient }));
        const access = resolveTenantAccess(negative, {
            NOFRIES_REQUIRE_AUTH: 'true',
            NOFRIES_MCP_APPLICATION_SUBJECT_TENANTS: `${SUBJECT}=no-fries-hq`
        });
        expect(access.allowed).toBe(false);
        expect(access.reason).toBe('identity_not_approved');
    });

    test.each([
        ['missing', undefined],
        ['malformed', 'not-a-guid']
    ])('fails closed when a constructed application identity has a %s client ID', (_label, clientId) => {
        const access = resolveTenantAccess(Object.assign({}, applicationIdentity, { clientId }), {
            NOFRIES_REQUIRE_AUTH: 'true',
            NOFRIES_MCP_APPLICATION_SUBJECT_TENANTS: `${SUBJECT}=no-fries-hq`
        });

        expect(access.allowed).toBe(false);
        expect(access.reason).toBe('identity_missing');
        expect(access.authentication.tenantWideAccess).toBe(false);
    });

    test('preserves browser-subject and delegated-email access behavior', () => {
        const browser = resolveTenantAccess({
            provider: 'entra-bff',
            subjectKey: BROWSER_SUBJECT,
            tenantId: TENANT_ID,
            principalId: PRINCIPAL_ID,
            isAuthenticated: true
        }, {
            NOFRIES_REQUIRE_AUTH: 'true',
            NOFRIES_ALLOWED_SUBJECTS: BROWSER_SUBJECT,
            NOFRIES_ADMIN_SUBJECTS: BROWSER_SUBJECT
        });
        expect(browser.allowed).toBe(true);
        expect(browser.user.role).toBe(ROLES.ADMIN);
        expect(browser.user).not.toHaveProperty('clientId');

        const delegated = resolveTenantAccess({
            provider: 'mcp-oauth',
            email: 'delegated@example.test',
            tenantId: TENANT_ID,
            principalId: PRINCIPAL_ID,
            isAuthenticated: true
        }, {
            NOFRIES_REQUIRE_AUTH: 'true',
            NOFRIES_ALLOWED_EMAILS: 'delegated@example.test',
            NOFRIES_SERVICE_OWNER_EMAILS: 'delegated@example.test'
        });
        expect(delegated.allowed).toBe(true);
        expect(delegated.user.role).toBe(ROLES.SERVICE_OWNER);
        expect(delegated.user).not.toHaveProperty('clientId');
    });

    test.each([
        'not-a-subject=no-fries-hq',
        `${SUBJECT}=`,
        `${SUBJECT}=not valid`,
        `${SUBJECT}=tenant-one,${SUBJECT}=tenant-two`,
        `${SUBJECT}=tenant=two`
    ])('fails closed for malformed or duplicate mapping %s', (mapping) => {
        expect(() => parseMcpApplicationSubjectTenants(mapping))
            .toThrow(/application tenant mapping is invalid/);
    });
});
