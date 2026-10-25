'use strict';

const crypto = require('crypto');
const { mcpIdentityFromClaims, resolveMcpAccess } = require('../api/shared/mcpAuth');
const { handleMcpAuthMetadataRequest, handleMcpRequest, resolveMcpSettings } = require('../api/shared/mcpRuntime');

const ISSUER = 'https://login.application-auth.test';
const AUDIENCE = 'api://77777777-7777-4777-8777-777777777777';
const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const POSITIVE_OBJECT_ID = '22222222-2222-4222-8222-222222222222';
const POSITIVE_CLIENT_ID = '33333333-3333-4333-8333-333333333333';
const NEGATIVE_OBJECT_ID = '44444444-4444-4444-8444-444444444444';
const NEGATIVE_CLIENT_ID = '55555555-5555-4555-8555-555555555555';
const DELEGATED_SCOPE = 'nofries.lifecycle.read';
const APPLICATION_ROLE = 'nofries.lifecycle.read.application';
const NOW_MS = 1_800_000_000_000;
const KID = 'mcp-application-test-key';
const RELEASE_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER_RELEASE_SHA = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const HQ_TENANT_KEY = crypto.createHash('sha256').update('no-fries-hq').digest('hex').slice(0, 32);

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = publicKey.export({ format: 'jwk' });
jwk.kid = KID;
jwk.use = 'sig';

function environment(overrides = {}) {
    return Object.assign({
        NOFRIES_REQUIRE_AUTH: 'true',
        NOFRIES_MCP_AUTHORIZATION_SERVER: ISSUER,
        NOFRIES_MCP_ISSUER: ISSUER,
        NOFRIES_MCP_AUDIENCE: AUDIENCE,
        NOFRIES_MCP_TOKEN_SCOPE: 'nofries.lifecycle.read',
        NOFRIES_MCP_JWKS_URI: `${ISSUER}/keys`,
        NOFRIES_MCP_APPLICATION_SUBJECT_TENANTS:
            `${TENANT_ID}:${POSITIVE_OBJECT_ID}:${POSITIVE_CLIENT_ID}=no-fries-hq`
    }, overrides);
}

function applicationToken(overrides = {}) {
    return signToken(applicationClaims(overrides));
}

function applicationClaims(overrides = {}) {
    const nowSeconds = Math.floor(NOW_MS / 1000);
    return Object.assign({
        iss: ISSUER,
        aud: AUDIENCE,
        exp: nowSeconds + 3600,
        nbf: nowSeconds - 5,
        tid: TENANT_ID,
        oid: POSITIVE_OBJECT_ID,
        azp: POSITIVE_CLIENT_ID,
        roles: [APPLICATION_ROLE]
    }, overrides);
}

function request(token, id = 'application-canary', query = '__release_canary__') {
    return {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: {
            jsonrpc: '2.0',
            id,
            method: 'tools/call',
            params: { name: 'search', arguments: { query } }
        }
    };
}

function fetchKeys() {
    return jest.fn(async () => ({
        ok: true,
        text: async () => JSON.stringify({ keys: [jwk] })
    }));
}

describe('signed MCP application-token authorization', () => {
    test('ignores a forged platform principal even when production settings drift to request it', async () => {
        const forgedEmail = 'forged-admin@example.invalid';
        const forgedPrincipal = Buffer.from(JSON.stringify({
            identityProvider: 'aad',
            userId: 'forged-object-id',
            userDetails: forgedEmail,
            claims: [{ typ: 'tid', val: TENANT_ID }]
        })).toString('base64');

        await expect(resolveMcpAccess({
            method: 'POST',
            headers: { 'x-ms-client-principal': forgedPrincipal }
        }, {
            env: environment({
                NODE_ENV: 'production',
                NOFRIES_REQUIRE_AUTH: 'true',
                NOFRIES_BROWSER_AUTH_MODE: 'swa',
                NOFRIES_MCP_ALLOW_PLATFORM_IDENTITY: 'true',
                NOFRIES_ALLOWED_EMAILS: forgedEmail,
                NOFRIES_ADMIN_EMAILS: forgedEmail,
                NOFRIES_DEFAULT_TENANT_ID: 'no-fries-hq'
            })
        })).rejects.toMatchObject({
            statusCode: 401,
            details: { code: 'authentication_required' }
        });
    });

    test('retains the explicit local-development identity fallback behind all three opt-ins', async () => {
        const access = await resolveMcpAccess({
            method: 'POST',
            headers: {},
            body: { email: 'local-developer@example.invalid' }
        }, {
            env: environment({
                NODE_ENV: 'development',
                NOFRIES_REQUIRE_AUTH: 'false',
                NOFRIES_BROWSER_AUTH_MODE: 'swa',
                NOFRIES_MCP_ALLOW_DEVELOPMENT_IDENTITY: 'true',
                NOFRIES_DEFAULT_TENANT_ID: 'local-development'
            })
        });

        expect(access).toMatchObject({
            allowed: true,
            tenant: { id: 'local-development' },
            user: { email: 'local-developer@example.invalid' }
        });
    });

    test.each([
        ['missing runtime mode', undefined, 'false', 'true'],
        ['test runtime mode', 'test', 'false', 'true'],
        ['hosted authentication', 'development', 'true', 'true'],
        ['missing development opt-in', 'development', 'false', undefined],
        ['padded development opt-in', 'development', 'false', ' true ']
    ])('keeps the development fallback closed for %s', async (
        _label, nodeEnv, requireAuth, developmentIdentity
    ) => {
        await expect(resolveMcpAccess({
            method: 'POST',
            headers: {},
            body: { email: 'local-developer@example.invalid' }
        }, {
            env: environment({
                NODE_ENV: nodeEnv,
                NOFRIES_REQUIRE_AUTH: requireAuth,
                NOFRIES_BROWSER_AUTH_MODE: 'swa',
                NOFRIES_MCP_ALLOW_DEVELOPMENT_IDENTITY: developmentIdentity,
                NOFRIES_DEFAULT_TENANT_ID: 'local-development'
            })
        })).rejects.toMatchObject({
            statusCode: 401,
            details: { code: 'authentication_required' }
        });
    });

    test('binds the exact app subject to one tenant with only lifecycle read', async () => {
        const token = applicationToken({
            email: 'forged-admin@example.invalid',
            preferred_username: 'forged-owner@example.invalid',
            upn: 'forged-operator@example.invalid',
            name: 'Mutable administrator display name'
        });
        const access = await resolveMcpAccess(request(token), {
            env: environment({
                NOFRIES_ALLOWED_EMAILS: 'forged-admin@example.invalid',
                NOFRIES_ADMIN_EMAILS: 'forged-admin@example.invalid',
                NOFRIES_ALLOWED_TENANT_IDS: TENANT_ID,
                NOFRIES_ALLOW_TENANT_WIDE: 'true',
                NOFRIES_DEFAULT_TENANT_ID: 'wrong-default'
            }),
            fetchImpl: fetchKeys(),
            now: () => NOW_MS
        });

        expect(access).toMatchObject({
            allowed: true,
            tenant: { id: 'no-fries-hq' },
            user: {
                email: '',
                principalId: POSITIVE_OBJECT_ID,
                clientId: POSITIVE_CLIENT_ID,
                role: 'mcp_reader',
                capabilities: ['lifecycle:read']
            },
            authentication: {
                provider: 'mcp-oauth-application',
                immutableSubject: true,
                tenantWideAccess: false
            }
        });
        expect(access.user.capabilities.some((capability) => capability.includes('write'))).toBe(false);
        expect(access.user.capabilities).not.toContain('tenant:admin');
    });

    test('passes the mapped internal tenant into the read-only lifecycle search', async () => {
        const lifecycle = {
            searchAgentContext: jest.fn(async (access, query) => [{
                id: 'canary:no-fries-hq',
                tenant: access.tenant.id,
                query
            }])
        };
        const response = await handleMcpRequest(request(applicationToken(), 'mapped-tenant-canary', 'tenant lookup'), {
            env: environment(),
            fetchImpl: fetchKeys(),
            now: () => NOW_MS,
            lifecycle
        });

        expect(response.status).toBe(200);
        expect(JSON.parse(response.body.result.content[0].text)).toEqual({
            results: [{
                id: 'canary:no-fries-hq',
                tenant: 'no-fries-hq',
                query: 'tenant lookup'
            }]
        });
        expect(lifecycle.searchAgentContext).toHaveBeenCalledWith(
            expect.objectContaining({
                allowed: true,
                tenant: expect.objectContaining({ id: 'no-fries-hq' }),
                user: expect.objectContaining({
                    role: 'mcp_reader',
                    capabilities: ['lifecycle:read']
                })
            }),
            'tenant lookup'
        );
    });

    test('returns only opaque tenant binding for the exact stamped application canary', async () => {
        const lifecycle = { searchAgentContext: jest.fn(async () => []) };
        const response = await handleMcpRequest(
            request(applicationToken(), 'opaque-release-canary', `__release_canary__${RELEASE_SHA}`),
            {
                env: environment(),
                fetchImpl: fetchKeys(),
                now: () => NOW_MS,
                lifecycle,
                getReleaseIdentity: () => ({ releaseSha: RELEASE_SHA, runId: '1234' })
            }
        );

        expect(response.body.result).toEqual({
            content: [{ type: 'text', text: JSON.stringify({ results: [] }) }],
            _meta: {
                'nofries/release-canary': {
                    releaseSha: RELEASE_SHA,
                    tenantKey: HQ_TENANT_KEY
                }
            }
        });
        expect(Object.keys(response.body.result._meta['nofries/release-canary']).sort())
            .toEqual(['releaseSha', 'tenantKey']);
        expect(JSON.stringify(response.body.result._meta)).not.toContain('no-fries-hq');
        expect(JSON.stringify(response.body.result._meta)).not.toContain(POSITIVE_OBJECT_ID);
        expect(JSON.stringify(response.body.result._meta)).not.toContain(POSITIVE_CLIENT_ID);
    });

    test.each([
        ['ordinary application query', 'customer', () => ({ releaseSha: RELEASE_SHA }), null, null],
        ['unstamped application query', '__release_canary__', () => ({ releaseSha: RELEASE_SHA }), null, 'canary_request_stamp_invalid'],
        ['different stamped SHA', `__release_canary__${OTHER_RELEASE_SHA}`, () => ({ releaseSha: RELEASE_SHA }), null, 'canary_release_sha_mismatch'],
        ['missing release identity', `__release_canary__${RELEASE_SHA}`, () => null, null, 'canary_release_identity_invalid'],
        ['invalid release identity', `__release_canary__${RELEASE_SHA}`, () => ({ releaseSha: 'not-a-sha' }), null, 'canary_release_identity_invalid'],
        ['noncanonical release identity', `__release_canary__${RELEASE_SHA}`, () => ({ releaseSha: RELEASE_SHA.toUpperCase() }), null, 'canary_release_identity_invalid'],
        ['throwing release identity', `__release_canary__${RELEASE_SHA}`, () => { throw new Error('SYNTHETIC_PRIVATE_SENTINEL'); }, null, 'canary_release_identity_invalid'],
        ['invalid opaque tenant key', `__release_canary__${RELEASE_SHA}`, () => ({ releaseSha: RELEASE_SHA }), 'raw-tenant', 'canary_tenant_binding_invalid'],
        ['noncanonical opaque tenant key', `__release_canary__${RELEASE_SHA}`, () => ({ releaseSha: RELEASE_SHA }), HQ_TENANT_KEY.toUpperCase(), 'canary_tenant_binding_invalid'],
        ['stamp before identity', '__release_canary__invalid', () => { throw new Error('SYNTHETIC_PRIVATE_SENTINEL'); }, 'raw-tenant', 'canary_request_stamp_invalid'],
        ['identity before tenant', `__release_canary__${RELEASE_SHA}`, () => null, 'raw-tenant', 'canary_release_identity_invalid'],
        ['SHA before tenant', `__release_canary__${OTHER_RELEASE_SHA}`, () => ({ releaseSha: RELEASE_SHA }), 'raw-tenant', 'canary_release_sha_mismatch']
    ])('returns the bounded outcome for %s', async (_label, query, releaseIdentity, tenantKey, code) => {
        const lifecycle = { searchAgentContext: jest.fn(async () => []) };
        const dependencies = {
            env: environment(),
            fetchImpl: fetchKeys(),
            now: () => NOW_MS,
            lifecycle,
            getReleaseIdentity: jest.fn(releaseIdentity),
            incidentId: 'synthetic-canary-guard'
        };
        if (tenantKey) {
            dependencies.resolveAccess = async () => ({
                allowed: true,
                tenant: { key: tenantKey },
                user: { role: 'mcp_reader', capabilities: ['lifecycle:read'] },
                authentication: { provider: 'mcp-oauth-application' }
            });
        }
        const response = await handleMcpRequest(
            request(applicationToken(), `non-match-${_label}`, query),
            dependencies
        );

        expect(lifecycle.searchAgentContext).toHaveBeenCalledTimes(1);
        expect(dependencies.getReleaseIdentity).toHaveBeenCalledTimes(
            !code || code === 'canary_request_stamp_invalid' ? 0 : 1);
        if (!code) {
            expect(response.body.result).toEqual({ content: [{ type: 'text', text: '{"results":[]}' }] });
        } else {
            expect(response.body.result).toEqual({
                isError: true,
                content: [{ type: 'text', text: `No Fries could not verify the connector release. Reference: response/${code}; incident synthetic-canary-guard.` }],
                _meta: { 'nofries/diagnostic': { incidentId: 'synthetic-canary-guard', stage: 'response', code } }
            });
        }
        expect(JSON.stringify(response)).not.toContain('SYNTHETIC_PRIVATE_SENTINEL');
        expect(JSON.stringify(response.body.result._meta || {})).not.toMatch(/raw-tenant|no-fries-hq/);
    });

    test.each([
        ['delegated provider', {
            allowed: true,
            tenant: { key: HQ_TENANT_KEY },
            user: { role: 'service_owner', capabilities: ['lifecycle:read'] },
            authentication: { provider: 'mcp-oauth' }
        }],
        ['non-reader application role', {
            allowed: true,
            tenant: { key: HQ_TENANT_KEY },
            user: { role: 'consultant', capabilities: ['lifecycle:read'] },
            authentication: { provider: 'mcp-oauth-application' }
        }]
    ])('classifies only reserved searches for an admitted %s', async (_label, access) => {
        const getReleaseIdentity = jest.fn(() => ({ releaseSha: RELEASE_SHA }));
        const lifecycle = { searchAgentContext: jest.fn(async () => []) };
        const response = await handleMcpRequest(
            request(applicationToken(), `identity-non-match-${_label}`, `__release_canary__${RELEASE_SHA}`),
            {
                resolveAccess: async () => access,
                lifecycle,
                getReleaseIdentity
            }
        );

        expect(response.body.result).toMatchObject({ isError: true,
            _meta: { 'nofries/diagnostic': { stage: 'response', code: 'canary_application_guard_failed' } } });
        expect(getReleaseIdentity).not.toHaveBeenCalled();
        const ordinary = await handleMcpRequest(request('', 'ordinary', 'ordinary search'), {
            resolveAccess: async () => access, lifecycle, getReleaseIdentity
        });
        expect(ordinary.body.result).toEqual({ content: [{ type: 'text', text: '{"results":[]}' }] });
        expect(getReleaseIdentity).not.toHaveBeenCalled();
    });

    test('returns protocol HTTP 200 tenant denial for a valid unlisted service principal', async () => {
        const token = applicationToken({
            oid: NEGATIVE_OBJECT_ID,
            azp: NEGATIVE_CLIENT_ID
        });
        const response = await handleMcpRequest(request(token, 'unapproved-application'), {
            env: environment(),
            fetchImpl: fetchKeys(),
            now: () => NOW_MS,
            incidentId: 'unapproved-application-incident'
        });

        expect(response.status).toBe(200);
        expect(response.body.result).toMatchObject({
            isError: true,
            _meta: {
                'nofries/diagnostic': {
                    incidentId: 'unapproved-application-incident',
                    stage: 'tenant_access',
                    code: 'tenant_access_required'
                }
            }
        });
        expect(response.body.result._meta['mcp/www_authenticate']).toBeUndefined();
    });

    test('never lets mutable email or tenant-wide settings substitute for an app mapping', async () => {
        const token = applicationToken({ email: 'forged-admin@example.invalid' });
        await expect(resolveMcpAccess(request(token), {
            env: environment({
                NOFRIES_MCP_APPLICATION_SUBJECT_TENANTS: '',
                NOFRIES_ALLOWED_EMAILS: 'forged-admin@example.invalid',
                NOFRIES_ADMIN_EMAILS: 'forged-admin@example.invalid',
                NOFRIES_ALLOWED_TENANT_IDS: TENANT_ID,
                NOFRIES_ALLOW_TENANT_WIDE: 'true'
            }),
            fetchImpl: fetchKeys(),
            now: () => NOW_MS
        })).rejects.toMatchObject({
            statusCode: 403,
            details: { code: 'tenant_access_required', reason: 'access_not_configured' }
        });
    });

    test('keeps the delegated scope setting absent or exact while admitting the distinct application role', async () => {
        const absent = environment();
        delete absent.NOFRIES_MCP_TOKEN_SCOPE;
        await expect(resolveMcpAccess(request(applicationToken()), {
            env: absent,
            fetchImpl: fetchKeys(),
            now: () => NOW_MS
        })).resolves.toMatchObject({ allowed: true, user: { role: 'mcp_reader' } });

        for (const configured of ['', '   ', ' nofries.lifecycle.read ', null, 'another.scope', APPLICATION_ROLE]) {
            await expect(resolveMcpAccess(request(applicationToken()), {
                env: environment({ NOFRIES_MCP_TOKEN_SCOPE: configured }),
                fetchImpl: fetchKeys(),
                now: () => NOW_MS
            })).rejects.toMatchObject({
                statusCode: 401,
                details: { code: 'mcp_auth_not_configured' }
            });
        }
    });

    test.each([
        ['extra role', [APPLICATION_ROLE, 'extra.role']],
        ['legacy companion role', [APPLICATION_ROLE, DELEGATED_SCOPE]],
        ['duplicate role', [APPLICATION_ROLE, APPLICATION_ROLE]],
        ['padded role', [` ${APPLICATION_ROLE} `]],
        ['malformed companion role', [APPLICATION_ROLE, null]]
    ])('rejects an application token with %s', async (_label, roles) => {
        await expect(resolveMcpAccess(request(applicationToken({ roles })), {
            env: environment(),
            fetchImpl: fetchKeys(),
            now: () => NOW_MS
        })).rejects.toMatchObject({
            statusCode: 401,
            details: { code: 'invalid_token' }
        });
    });

    test.each([
        ['unrelated role', ['unrelated.role']],
        ['legacy delegated permission as a role', [DELEGATED_SCOPE]],
        ['audience-qualified application role', [`${AUDIENCE}/${APPLICATION_ROLE}`]],
        ['duplicate role', [APPLICATION_ROLE, APPLICATION_ROLE]],
        ['malformed companion role', [APPLICATION_ROLE, null]],
        ['padded role', [` ${APPLICATION_ROLE} `]],
        ['non-array role claim', APPLICATION_ROLE]
    ])('keeps the exported identity boundary closed for %s', (_label, roles) => {
        expect(() => mcpIdentityFromClaims(applicationClaims({ roles })))
            .toThrow(/identity is invalid/);
    });

    test.each(['', '   ', null, 'other.scope', ' nofries.lifecycle.read '])(
        'rejects advertised MCP scope drift: %p', (scope) => {
            expect(() => resolveMcpSettings(environment({ NOFRIES_MCP_SCOPE: scope })))
                .toThrow(/resource server is not configured/);
        }
    );

    test.each([
        [AUDIENCE, `${AUDIENCE}/nofries.lifecycle.read`],
        ['77777777-7777-4777-8777-777777777777', `${AUDIENCE}/nofries.lifecycle.read`],
        ['https://api.example.test/lifecycle', 'https://api.example.test/lifecycle/nofries.lifecycle.read']
    ])('advertises the resource-bound read scope for audience %s without changing token authority', async (audience, scope) => {
        const env = environment({ NOFRIES_MCP_AUDIENCE: audience, NOFRIES_MCP_SCOPE: scope });
        const metadata = handleMcpAuthMetadataRequest({ method: 'GET' }, { env });
        expect(metadata.status).toBe(200);
        expect(metadata.body.scopes_supported).toEqual([scope]);
        const listed = await handleMcpRequest({
            method: 'POST',
            body: { jsonrpc: '2.0', id: 1, method: 'tools/list' }
        }, { env });
        for (const tool of listed.body.result.tools) {
            expect(tool.securitySchemes).toEqual([{ type: 'oauth2', scopes: [scope] }]);
            expect(tool._meta.securitySchemes).toEqual(tool.securitySchemes);
        }
        await expect(resolveMcpAccess(request(applicationToken({ aud: audience })), {
            env, fetchImpl: fetchKeys(), now: () => NOW_MS
        })).resolves.toMatchObject({ allowed: true, user: { role: 'mcp_reader', capabilities: ['lifecycle:read'] } });
        await expect(resolveMcpAccess(request(applicationToken({ aud: audience, roles: [scope] })), {
            env, fetchImpl: fetchKeys(), now: () => NOW_MS
        })).rejects.toMatchObject({ statusCode: 401, details: { code: 'insufficient_scope' } });
    });

    test.each([
        [AUDIENCE, 'api://foreign/nofries.lifecycle.read'],
        [AUDIENCE, `${AUDIENCE}/nofries.lifecycle.write`],
        [AUDIENCE, `${AUDIENCE}/nofries.lifecycle.read offline_access`],
        [AUDIENCE, ` ${AUDIENCE}/nofries.lifecycle.read`],
        [AUDIENCE, `${AUDIENCE}/nofries.lifecycle.read `],
        [AUDIENCE, `${AUDIENCE}//nofries.lifecycle.read`],
        [AUDIENCE, `${AUDIENCE}/nofries.lifecycle.read/extra`],
        [undefined, `${AUDIENCE}/nofries.lifecycle.read`],
        ['not-a-resource', 'not-a-resource/nofries.lifecycle.read'],
        ['https://api.example.test?foreign=1', 'https://api.example.test?foreign=1/nofries.lifecycle.read'],
        ['https://api.example.test#foreign', 'https://api.example.test#foreign/nofries.lifecycle.read'],
        ['https://api.example.test?', 'https://api.example.test?/nofries.lifecycle.read'],
        ['https://api.example.test#', 'https://api.example.test#/nofries.lifecycle.read'],
        ['https://user:password@api.example.test', 'https://user:password@api.example.test/nofries.lifecycle.read'],
        ['http://api.example.test', 'http://api.example.test/nofries.lifecycle.read'],
        ['https://api.example.test/', 'https://api.example.test//nofries.lifecycle.read']
    ])('rejects an unbound advertised scope for audience %p and scope %p', (audience, scope) => {
        expect(() => resolveMcpSettings(environment({
            NOFRIES_MCP_AUDIENCE: audience, NOFRIES_MCP_SCOPE: scope
        }))).toThrow(/resource server is not configured/);
    });

    test.each([
        ['tenant', { tid: '66666666-6666-4666-8666-666666666666' }],
        ['object', { oid: NEGATIVE_OBJECT_ID }],
        ['client', { azp: NEGATIVE_CLIENT_ID }]
    ])('binds the application mapping to the exact immutable %s identity', async (_label, claims) => {
        await expect(resolveMcpAccess(request(applicationToken(claims)), {
            env: environment(),
            fetchImpl: fetchKeys(),
            now: () => NOW_MS
        })).rejects.toMatchObject({
            statusCode: 403,
            details: { code: 'tenant_access_required', reason: 'identity_not_approved' }
        });
    });

    test.each([
        ['missing tenant', { tid: undefined }],
        ['malformed tenant', { tid: 'not-a-tenant-id' }],
        ['sub alias instead of object', { oid: undefined, sub: POSITIVE_OBJECT_ID }],
        ['malformed object', { oid: 'not-an-object-id' }],
        ['missing client', { azp: undefined }],
        ['malformed client', { azp: 'not-a-client-id' }],
        ['conflicting client identifiers', { appid: NEGATIVE_CLIENT_ID }]
    ])('rejects an application token with %s as an invalid token', async (_label, claims) => {
        await expect(resolveMcpAccess(request(applicationToken(claims)), {
            env: environment(),
            fetchImpl: fetchKeys(),
            now: () => NOW_MS
        })).rejects.toMatchObject({
            statusCode: 401,
            details: { code: 'invalid_token' }
        });
    });

    test.each([
        ['unrelated role', ['profile.read']],
        ['legacy delegated permission as a role', [DELEGATED_SCOPE]],
        ['audience-qualified delegated permission', [`${AUDIENCE}/${DELEGATED_SCOPE}`]],
        ['audience-qualified application role', [`${AUDIENCE}/${APPLICATION_ROLE}`]],
        ['empty roles', []],
        ['missing roles', undefined],
        ['non-array application role', APPLICATION_ROLE]
    ])('keeps %s on the application permission challenge path', async (_label, roles) => {
        const token = applicationToken({ roles });
        await expect(resolveMcpAccess(request(token), {
            env: environment(),
            fetchImpl: fetchKeys(),
            now: () => NOW_MS
        })).rejects.toMatchObject({
            statusCode: 401,
            details: { code: 'insufficient_scope', requiredScope: APPLICATION_ROLE }
        });
        const response = await handleMcpRequest(request(token), {
            env: environment(),
            fetchImpl: fetchKeys(),
            now: () => NOW_MS
        });
        expect(response.status).toBe(200);
        expect(response.body.result).toMatchObject({
            isError: true,
            _meta: { 'mcp/www_authenticate': [expect.stringContaining('insufficient_scope')] }
        });
        expect(response.body.result._meta['nofries/diagnostic']).toBeUndefined();
    });

    test.each([
        'profile.read', APPLICATION_ROLE, `${AUDIENCE}/${DELEGATED_SCOPE}`, '', null, 1, [DELEGATED_SCOPE]
    ])('does not let the application role satisfy a delegated scp claim of %p', async (scp) => {
        const token = applicationToken({
            scp,
            email: 'delegated-owner@example.test',
            roles: [APPLICATION_ROLE]
        });
        await expect(resolveMcpAccess(request(token), {
            env: environment({
                NOFRIES_ALLOWED_EMAILS: 'delegated-owner@example.test',
                NOFRIES_SERVICE_OWNER_EMAILS: 'delegated-owner@example.test'
            }),
            fetchImpl: fetchKeys(),
            now: () => NOW_MS
        })).rejects.toMatchObject({
            statusCode: 401,
            details: { code: 'insufficient_scope', requiredScope: 'nofries.lifecycle.read' }
        });
    });

    test.each([
        ['the new application role', [APPLICATION_ROLE]],
        ['the legacy role value', [DELEGATED_SCOPE]],
        ['an unrelated application role', ['unrelated.application.role']],
        ['no roles', undefined]
    ])('keeps a legitimate delegated token on the user role path with %s', async (_label, roles) => {
        const token = applicationToken({
            scp: 'openid nofries.lifecycle.read profile',
            email: 'delegated-owner@example.test',
            roles
        });
        const access = await resolveMcpAccess(request(token), {
            env: environment({
                NOFRIES_ALLOWED_EMAILS: 'delegated-owner@example.test',
                NOFRIES_SERVICE_OWNER_EMAILS: 'delegated-owner@example.test'
            }),
            fetchImpl: fetchKeys(),
            now: () => NOW_MS
        });

        expect(access).toMatchObject({
            allowed: true,
            user: { email: 'delegated-owner@example.test', role: 'service_owner' },
            authentication: { provider: 'mcp-oauth' }
        });
    });

    test.each([
        ['issuer', { iss: 'https://foreign-issuer.application-auth.test' }],
        ['audience', { aud: 'api://foreign-resource' }],
        ['expired lifetime', { exp: Math.floor(NOW_MS / 1000) - 61 }],
        ['future activation', { nbf: Math.floor(NOW_MS / 1000) + 61 }]
    ])('rejects a signed new-role token with an invalid %s', async (_label, claims) => {
        await expect(resolveMcpAccess(request(applicationToken(claims)), {
            env: environment(),
            fetchImpl: fetchKeys(),
            now: () => NOW_MS
        })).rejects.toMatchObject({ statusCode: 401, details: { code: 'invalid_token' } });
    });

    test.each([APPLICATION_ROLE, DELEGATED_SCOPE])(
        'verifies the signature before evaluating the application role %s', async (role) => {
            const parts = applicationToken({ roles: [role] }).split('.');
            const signature = Buffer.from(parts[2], 'base64url');
            signature[0] ^= 1;
            parts[2] = signature.toString('base64url');
            await expect(resolveMcpAccess(request(parts.join('.')), {
                env: environment(),
                fetchImpl: fetchKeys(),
                now: () => NOW_MS
            })).rejects.toMatchObject({ statusCode: 401, details: { code: 'invalid_token' } });
        }
    );

    test.each([
        ['null header', null, applicationClaims()],
        ['array header', [], applicationClaims()],
        ['string header', 'header', applicationClaims()],
        ['null claims', { alg: 'RS256', kid: KID, typ: 'JWT' }, null],
        ['array claims', { alg: 'RS256', kid: KID, typ: 'JWT' }, []],
        ['string claims', { alg: 'RS256', kid: KID, typ: 'JWT' }, 'claims']
    ])('rejects a %s as a controlled invalid token', async (_label, header, claims) => {
        const token = signJwt(header, claims);
        await expect(resolveMcpAccess(request(token), {
            env: environment(),
            fetchImpl: fetchKeys(),
            now: () => NOW_MS
        })).rejects.toMatchObject({
            statusCode: 401,
            details: { code: 'invalid_token' }
        });
    });
});

function signToken(claims) {
    return signJwt({ alg: 'RS256', kid: KID, typ: 'JWT' }, claims);
}

function signJwt(header, claims) {
    const encodedHeader = base64Url(JSON.stringify(header));
    const encodedClaims = base64Url(JSON.stringify(claims));
    const input = `${encodedHeader}.${encodedClaims}`;
    const signature = crypto.sign('RSA-SHA256', Buffer.from(input, 'utf8'), privateKey);
    return `${input}.${base64Url(signature)}`;
}

function base64Url(value) {
    return Buffer.from(value).toString('base64url');
}
