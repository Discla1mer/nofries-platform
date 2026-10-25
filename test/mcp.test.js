const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLifecycleRepository } = require('../api/shared/lifecycle/lifecycleRepository');
const { createLifecycleService } = require('../api/shared/lifecycle/lifecycleService');
const { resetMcpAuthCaches, resolveMcpAccess, verifyBearerToken } = require('../api/shared/mcpAuth');
const {
    handleMcpAuthMetadataRequest,
    handleMcpRequest,
    runMcpFunction,
    toolDefinitions
} = require('../api/shared/mcpRuntime');
const { ROLE_CAPABILITIES, tenantStorageKey } = require('../api/shared/tenantAccess');

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-mcp-test-'));

describe('No Fries read-only agent connector', () => {
    beforeEach(() => {
        resetMcpAuthCaches();
    });

    afterAll(() => {
        fs.rmSync(testDataDir, { recursive: true, force: true });
    });

    test.each(['absent', 'throwing', 'working'])('keeps canary diagnostics closed with %s logging', async mode => {
        const privateValue = 'SYNTHETIC_PRIVATE_CANARY_BINDING';
        const logger = mode === 'absent' ? undefined : { error: jest.fn(() => {
            if (mode === 'throwing') throw new Error(privateValue);
        }) };
        const lifecycle = { searchAgentContext: jest.fn(async () => [{ id: privateValue }]) };
        const getReleaseIdentity = jest.fn(() => { throw new Error(privateValue); });
        const fetchImpl = jest.fn(() => { throw new Error('unexpected provider call'); });
        const context = { invocationId: 'synthetic-canary-incident', log: logger };
        await runMcpFunction(context, {
            method: 'POST', headers: {}, body: { jsonrpc: '2.0', id: 'authenticated_canary',
                method: 'tools/call', params: { name: 'search', arguments: { query: '__release_canary__' + 'a'.repeat(40) } } }
        }, {
            resolveAccess: async () => ({ allowed: true,
                user: { role: 'mcp_reader', capabilities: ['lifecycle:read'] },
                tenant: { key: 'b'.repeat(32) }, authentication: { provider: 'mcp-oauth-application' } }),
            lifecycle, getReleaseIdentity, fetchImpl
        });
        expect(context.res.status).toBe(200);
        expect(context.res.body.result).toEqual({ isError: true,
            content: [{ type: 'text', text: 'No Fries could not verify the connector release. Reference: response/canary_release_identity_invalid; incident synthetic-canary-incident.' }],
            _meta: { 'nofries/diagnostic': { incidentId: 'synthetic-canary-incident', stage: 'response', code: 'canary_release_identity_invalid' } } });
        expect(lifecycle.searchAgentContext).toHaveBeenCalledTimes(1);
        expect(getReleaseIdentity).toHaveBeenCalledTimes(1);
        expect(fetchImpl).not.toHaveBeenCalled();
        expect(JSON.stringify(context.res)).not.toContain(privateValue);
        if (logger) {
            expect(logger.error).toHaveBeenCalledTimes(1);
            expect(logger.error).toHaveBeenCalledWith({ event: 'mcp_incident', incidentId: 'synthetic-canary-incident',
                stage: 'response', code: 'canary_release_identity_invalid', statusCode: 500, tool: 'search' });
            expect(JSON.stringify(logger.error.mock.calls)).not.toContain(privateValue);
        }
    });

    test.each(['authentication', 'capability', 'storage'])('preserves the earlier %s failure for reserved queries', async failure => {
        const access = { allowed: true, user: { role: 'mcp_reader', capabilities: failure === 'capability' ? [] : ['lifecycle:read'] },
            tenant: { key: 'b'.repeat(32) }, authentication: { provider: 'mcp-oauth-application' } };
        const getReleaseIdentity = jest.fn();
        const lifecycle = { searchAgentContext: jest.fn(async () => { throw new Error('private store details'); }) };
        const result = await handleMcpRequest({ method: 'POST', body: { jsonrpc: '2.0', id: 'guard-order',
            method: 'tools/call', params: { name: 'search', arguments: { query: '__release_canary__invalid' } } }
        }, { lifecycle, getReleaseIdentity, resolveAccess: async () => {
            if (failure === 'authentication') throw Object.assign(new Error('Authentication required'), { statusCode: 401 });
            return access;
        } });
        expect(result.body.result.isError).toBe(true);
        expect(getReleaseIdentity).not.toHaveBeenCalled();
        expect(lifecycle.searchAgentContext).toHaveBeenCalledTimes(failure === 'storage' ? 1 : 0);
        if (failure === 'authentication') expect(result.body.result._meta).toHaveProperty('mcp/www_authenticate');
        else expect(result.body.result._meta['nofries/diagnostic']).toMatchObject({
            stage: failure === 'capability' ? 'capability' : 'storage_read',
            code: failure === 'capability' ? 'capability_required' : 'lifecycle_read_failed'
        });
    });

    test('advertises standard read-only search and fetch tools', async () => {
        expect(toolDefinitions('nofries.lifecycle.read')).toEqual([
            expect.objectContaining({
                name: 'search',
                securitySchemes: [{ type: 'oauth2', scopes: ['nofries.lifecycle.read'] }],
                annotations: expect.objectContaining({
                    readOnlyHint: true,
                    destructiveHint: false,
                    openWorldHint: false,
                    idempotentHint: true
                })
            }),
            expect.objectContaining({ name: 'fetch' })
        ]);

        const initialised = await handleMcpRequest({
            method: 'POST',
            body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }
        });
        expect(initialised.body.result).toMatchObject({
            protocolVersion: '2025-06-18',
            serverInfo: { name: 'nofries-lifecycle' },
            capabilities: { tools: { listChanged: false } }
        });

        const listed = await handleMcpRequest({
            method: 'POST',
            body: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }
        });
        expect(listed.body.result.tools.map((tool) => tool.name)).toEqual(['search', 'fetch']);

        const negotiated = await handleMcpRequest({
            method: 'POST',
            body: { jsonrpc: '2.0', id: 3, method: 'initialize', params: { protocolVersion: '2099-01-01' } }
        });
        expect(negotiated.body.result.protocolVersion).toBe('2025-06-18');
    });

    test('fails closed with an OAuth challenge when a tool call is unauthenticated', async () => {
        const response = await handleMcpRequest({
            method: 'POST',
            headers: {},
            body: {
                jsonrpc: '2.0',
                id: 3,
                method: 'tools/call',
                params: { name: 'search', arguments: { query: 'No Fries' } }
            }
        }, {
            env: {
                NOFRIES_REQUIRE_AUTH: 'true',
                NOFRIES_BROWSER_AUTH_MODE: 'entra_bff',
                NOFRIES_PUBLIC_URL: 'https://nofries.nz',
                NOFRIES_MCP_AUTHORIZATION_SERVER: 'https://login.example.test',
                NOFRIES_MCP_ISSUER: 'https://login.example.test',
                NOFRIES_MCP_AUDIENCE: 'api://nofries-mcp'
            }
        });

        expect(response.body.result).toMatchObject({
            isError: true,
            _meta: {
                'mcp/www_authenticate': [expect.stringContaining('https://nofries.nz/api/mcp-auth')]
            }
        });
        expect(response.body.result._meta['mcp/www_authenticate'][0]).toContain('nofries.lifecycle.read');
    });

    test('returns a non-challenge access denial for a valid but unapproved identity', async () => {
        const env = oauthTestEnv({
            NOFRIES_REQUIRE_AUTH: 'true',
            NOFRIES_ALLOWED_EMAILS: 'approved@nofries.nz'
        });
        const { privateKey, jwk } = testSigningKey('unapproved-key');
        const token = testToken(privateKey, 'unapproved-key', {
            email: 'unapproved@nofries.nz',
            tid: 'tenant-a'
        });
        const response = await handleMcpRequest(
            authenticatedMcpCall(33, 'search', { query: 'No Fries' }, token),
            {
                env,
                fetchImpl: jwksFetch(jwk),
                incidentId: 'access-incident-33'
            }
        );

        expect(response.body.result).toMatchObject({
            isError: true,
            content: [{
                type: 'text',
                text: 'This identity is authenticated but is not approved for No Fries. Reference: tenant_access/tenant_access_required; incident access-incident-33.'
            }],
            _meta: {
                'nofries/diagnostic': {
                    incidentId: 'access-incident-33',
                    stage: 'tenant_access',
                    code: 'tenant_access_required'
                }
            }
        });
        expect(response.body.result._meta['mcp/www_authenticate']).toBeUndefined();
    });

    test('uses a valid approved bearer token for a read-only lifecycle search', async () => {
        const env = oauthTestEnv({
            NOFRIES_REQUIRE_AUTH: 'true',
            NOFRIES_ALLOWED_EMAILS: 'approved@nofries.nz'
        });
        const { privateKey, jwk } = testSigningKey('approved-key');
        const token = testToken(privateKey, 'approved-key', {
            email: 'approved@nofries.nz',
            tid: 'tenant-a'
        });
        const lifecycle = {
            searchAgentContext: jest.fn(async (access, query) => [{
                id: 'organisation:test',
                title: query,
                tenant: access.tenant.id
            }])
        };
        const response = await handleMcpRequest(
            authenticatedMcpCall(34, 'search', { query: 'No Fries Headquarters' }, token),
            { env, fetchImpl: jwksFetch(jwk), lifecycle }
        );

        expect(response.body.error).toBeUndefined();
        expect(response.body.result.isError).toBeUndefined();
        expect(JSON.parse(response.body.result.content[0].text)).toEqual({
            results: [{
                id: 'organisation:test',
                title: 'No Fries Headquarters',
                tenant: 'founding-pilot'
            }]
        });
        expect(lifecycle.searchAgentContext).toHaveBeenCalledWith(
            expect.objectContaining({ allowed: true }),
            'No Fries Headquarters'
        );
    });

    test('keeps the OAuth challenge for a valid token with insufficient scope', async () => {
        const env = oauthTestEnv({
            NOFRIES_REQUIRE_AUTH: 'true',
            NOFRIES_ALLOWED_EMAILS: 'approved@nofries.nz'
        });
        const { privateKey, jwk } = testSigningKey('wrong-scope-key');
        const token = testToken(privateKey, 'wrong-scope-key', {
            email: 'approved@nofries.nz',
            tid: 'tenant-a',
            scp: 'profile.read'
        });
        const response = await handleMcpRequest(
            authenticatedMcpCall(35, 'search', { query: 'No Fries' }, token),
            { env, fetchImpl: jwksFetch(jwk) }
        );

        expect(response.body.result).toMatchObject({
            isError: true,
            _meta: {
                'mcp/www_authenticate': [expect.stringContaining('error="insufficient_scope"')]
            }
        });
        expect(response.body.result._meta['nofries/diagnostic']).toBeUndefined();
    });

    test('does not trust a caller-supplied platform identity on the public connector', async () => {
        const forgedPrincipal = Buffer.from(JSON.stringify({
            identityProvider: 'aad',
            userId: 'forged-user',
            userDetails: 'joel@nofries.nz',
            claims: [{ typ: 'tid', val: 'tenant-a' }]
        })).toString('base64');
        const response = await handleMcpRequest({
            method: 'POST',
            headers: { 'x-ms-client-principal': forgedPrincipal },
            body: {
                jsonrpc: '2.0',
                id: 31,
                method: 'tools/call',
                params: { name: 'search', arguments: { query: 'No Fries' } }
            }
        }, {
            env: {
                NOFRIES_REQUIRE_AUTH: 'true',
                NOFRIES_ALLOWED_EMAILS: 'joel@nofries.nz',
                NOFRIES_PUBLIC_URL: 'https://nofries.nz',
                NOFRIES_MCP_AUTHORIZATION_SERVER: 'https://login.example.test',
                NOFRIES_MCP_ISSUER: 'https://login.example.test',
                NOFRIES_MCP_AUDIENCE: 'api://nofries-mcp'
            }
        });

        expect(response.body.result).toMatchObject({
            isError: true,
            _meta: { 'mcp/www_authenticate': [expect.stringContaining('invalid_token')] }
        });
    });

    test('remains bearer-only in entra_bff mode even when platform identity is requested', async () => {
        const issuer = 'https://login.bearer-only.test';
        const audience = 'api://nofries-mcp-bearer-only';
        const tokenEmail = 'connector-reader@nofries.nz';
        const forgedEmail = 'forged-admin@nofries.nz';
        const env = {
            NOFRIES_REQUIRE_AUTH: 'true',
            NOFRIES_BROWSER_AUTH_MODE: 'entra_bff',
            NOFRIES_MCP_ALLOW_PLATFORM_IDENTITY: 'true',
            NOFRIES_ALLOWED_EMAILS: `${tokenEmail},${forgedEmail}`,
            NOFRIES_ADMIN_EMAILS: forgedEmail,
            NOFRIES_DEFAULT_TENANT_ID: 'tenant-a',
            NOFRIES_MCP_ISSUER: issuer,
            NOFRIES_MCP_AUTHORIZATION_SERVER: issuer,
            NOFRIES_MCP_AUDIENCE: audience,
            NOFRIES_MCP_TOKEN_SCOPE: 'nofries.lifecycle.read',
            NOFRIES_MCP_JWKS_URI: `${issuer}/keys`
        };
        const forgedPrincipal = Buffer.from(JSON.stringify({
            identityProvider: 'aad',
            userId: 'forged-object-id',
            userDetails: forgedEmail,
            claims: [
                { typ: 'tid', val: 'tenant-a' },
                { typ: 'name', val: 'Forged Administrator' }
            ]
        })).toString('base64');
        const forgedHeaders = { 'x-ms-client-principal': forgedPrincipal };

        await expect(resolveMcpAccess({
            method: 'POST',
            headers: forgedHeaders,
            body: { email: forgedEmail },
            query: { email: forgedEmail }
        }, { env })).rejects.toMatchObject({
            statusCode: 401,
            details: { code: 'authentication_required' }
        });

        const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
        const jwk = publicKey.export({ format: 'jwk' });
        jwk.kid = 'bearer-only-key';
        jwk.use = 'sig';
        const token = signToken(privateKey, {
            alg: 'RS256',
            kid: jwk.kid,
            typ: 'JWT'
        }, {
            iss: issuer,
            aud: audience,
            exp: Math.floor(Date.now() / 1000) + 600,
            nbf: Math.floor(Date.now() / 1000) - 5,
            scp: 'nofries.lifecycle.read',
            email: tokenEmail,
            tid: 'tenant-a',
            oid: 'connector-object-id'
        });
        const fetchImpl = jest.fn(async () => ({
            ok: true,
            json: async () => ({ keys: [jwk] })
        }));
        const access = await resolveMcpAccess({
            method: 'POST',
            headers: Object.assign({}, forgedHeaders, { authorization: `Bearer ${token}` }),
            body: { email: forgedEmail },
            query: { email: forgedEmail }
        }, { env, fetchImpl, now: () => Date.now() });

        expect(access.allowed).toBe(true);
        expect(access.user.email).toBe(tokenEmail);
        expect(access.user.role).toBe('consultant');
        expect(access.authentication.provider).toBe('mcp-oauth');
        expect(access.user.email).not.toBe(forgedEmail);
    });

    test('rejects oversized MCP request bodies before parsing or authentication', async () => {
        const response = await handleMcpRequest({
            method: 'POST',
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 32,
                method: 'initialize',
                padding: 'x'.repeat(70 * 1024)
            })
        });

        expect(response.status).toBe(413);
        expect(response.body.error).toMatchObject({ code: -32600 });
    });

    test('search and fetch read lifecycle records, provenance, tasks and audit without writes', async () => {
        const repository = createLifecycleRepository({
            provider: 'local',
            dataDir: path.join(testDataDir, 'read-tools')
        });
        let sequence = 0;
        const lifecycle = createLifecycleService({
            repository,
            env: { NOFRIES_PUBLIC_URL: 'https://nofries.nz' },
            createId(prefix) {
                sequence += 1;
                return `${prefix}_mcp_${sequence}`;
            }
        });
        const operator = operatorAccess();
        const publicAgent = publicAccess();
        const session = await lifecycle.ensureProspectSession(publicAgent, 'mcp-session', { channel: 'text' });
        await lifecycle.executeProspectTool(publicAgent, 'mcp-session', 'update_prospect_context', {
            facts: [
                { field: 'company.name', value: 'No Fries Limited', certainty: 'explicit' },
                { field: 'company.summary', value: 'Internal managed IT lifecycle pilot', certainty: 'explicit' },
                { field: 'contacts.primary.email', value: 'joel@nofries.nz', certainty: 'explicit' }
            ]
        });
        await lifecycle.executeProspectTool(publicAgent, 'mcp-session', 'advance_lifecycle', { targetState: 'discovery' });
        await lifecycle.executeProspectTool(publicAgent, 'mcp-session', 'suggest_next_action', {
            type: 'human_follow_up',
            detail: 'Verify discovery and prepare scoping'
        });

        const dependencies = {
            lifecycle,
            env: { NOFRIES_PUBLIC_URL: 'https://nofries.nz' },
            resolveAccess: async () => operator
        };
        const revisionBeforeAgentReads = (await repository.read(operator)).revision;
        const searched = await handleMcpRequest(mcpCall(4, 'search', { query: 'No Fries Limited' }), dependencies);
        expect(searched.body.result.content).toHaveLength(1);
        const searchPayload = JSON.parse(searched.body.result.content[0].text);
        expect(searchPayload.results).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: `organisation:${session.organisation.organisationId}`,
                title: expect.stringContaining('No Fries Limited'),
                url: expect.stringMatching(/^https:\/\/nofries\.nz\/operator#organisation-/)
            })
        ]));

        const fetched = await handleMcpRequest(mcpCall(5, 'fetch', {
            id: `organisation:${session.organisation.organisationId}`
        }), dependencies);
        expect(fetched.body.result.content).toHaveLength(1);
        const fetchPayload = JSON.parse(fetched.body.result.content[0].text);
        const record = JSON.parse(fetchPayload.text);
        expect(fetchPayload).toMatchObject({
            id: `organisation:${session.organisation.organisationId}`,
            metadata: { type: 'lifecycle_record', lifecycleState: 'discovery', openOperatorTasks: 1 }
        });
        expect(record.record.fieldStates['contacts.primary.email']).toMatchObject({
            status: 'known',
            source: 'website_conversation',
            certainty: 'explicit'
        });
        expect(record.operatorTasks).toEqual([
            expect.objectContaining({ type: 'discovery_scoping_review', status: 'open' })
        ]);
        expect(record.activity).toEqual(expect.arrayContaining([
            expect.objectContaining({ action: 'operator_task.created' })
        ]));
        expect((await repository.read(operator)).revision).toBe(revisionBeforeAgentReads);
    });

    test('publishes protected-resource metadata and verifies signed bearer tokens', async () => {
        const env = {
            NOFRIES_PUBLIC_URL: 'https://nofries.nz',
            NOFRIES_MCP_AUTHORIZATION_SERVER: 'https://login.example.test',
            NOFRIES_MCP_ISSUER: 'https://login.example.test',
            NOFRIES_MCP_AUDIENCE: 'api://nofries-mcp',
            NOFRIES_MCP_SCOPE: 'api://nofries-mcp/nofries.lifecycle.read',
            NOFRIES_MCP_TOKEN_SCOPE: 'nofries.lifecycle.read',
            NOFRIES_MCP_JWKS_URI: 'https://login.example.test/keys'
        };
        const metadata = handleMcpAuthMetadataRequest({ method: 'GET' }, { env });
        expect(metadata.body).toEqual({
            resource: 'https://nofries.nz/api/mcp',
            authorization_servers: ['https://login.example.test'],
            scopes_supported: ['api://nofries-mcp/nofries.lifecycle.read'],
            resource_documentation: 'https://nofries.nz/privacy.html'
        });

        const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
        const jwk = publicKey.export({ format: 'jwk' });
        jwk.kid = 'test-key';
        jwk.use = 'sig';
        let now = Date.now();
        const nowSeconds = Math.floor(now / 1000);
        const token = signToken(privateKey, {
            alg: 'RS256',
            kid: 'test-key',
            typ: 'JWT'
        }, {
            iss: 'https://login.example.test',
            aud: 'api://nofries-mcp',
            exp: nowSeconds + 600,
            nbf: nowSeconds - 5,
            scp: 'nofries.lifecycle.read',
            email: 'joel@nofries.nz',
            tid: 'tenant-a'
        });
        const fetchImpl = jest.fn(async () => ({ ok: true, json: async () => ({ keys: [jwk] }) }));
        const claims = await verifyBearerToken(token, { env, fetchImpl, now: () => now });
        expect(claims).toMatchObject({ email: 'joel@nofries.nz', tid: 'tenant-a' });
        expect(fetchImpl).toHaveBeenCalledWith('https://login.example.test/keys', expect.objectContaining({
            headers: { Accept: 'application/json' },
            redirect: 'error',
            signal: expect.any(AbortSignal)
        }));

        const rotatedKeys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
        const rotatedJwk = rotatedKeys.publicKey.export({ format: 'jwk' });
        rotatedJwk.kid = 'rotated-key';
        rotatedJwk.use = 'sig';
        fetchImpl.mockResolvedValue({ ok: true, json: async () => ({ keys: [rotatedJwk] }) });
        const rotatedToken = signToken(rotatedKeys.privateKey, {
            alg: 'RS256',
            kid: 'rotated-key',
            typ: 'JWT'
        }, {
            iss: 'https://login.example.test',
            aud: 'api://nofries-mcp',
            exp: nowSeconds + 600,
            nbf: nowSeconds - 5,
            scp: 'nofries.lifecycle.read',
            email: 'joel@nofries.nz',
            tid: 'tenant-a'
        });
        now += 60 * 1000;
        await expect(verifyBearerToken(rotatedToken, { env, fetchImpl, now: () => now })).resolves.toMatchObject({
            email: 'joel@nofries.nz'
        });
        expect(fetchImpl).toHaveBeenCalledTimes(2);

        const tokenParts = rotatedToken.split('.');
        tokenParts[2] = `${tokenParts[2][0] === 'a' ? 'b' : 'a'}${tokenParts[2].slice(1)}`;
        const tampered = tokenParts.join('.');
        await expect(verifyBearerToken(tampered, { env, fetchImpl, now: () => now })).rejects.toMatchObject({
            details: { code: 'invalid_token' }
        });
    });

    test('bounds JWKS fetches for concurrent and repeated unknown signing keys', async () => {
        const env = oauthTestEnv({ NOFRIES_MCP_JWKS_URI: 'https://login.example.test/bounded-keys' });
        const { jwk: trustedJwk } = testSigningKey('trusted-key');
        const fetchImpl = jest.fn(async () => ({ ok: true, json: async () => ({ keys: [trustedJwk] }) }));
        const now = Date.now();
        const unknownTokens = Array.from({ length: 12 }, (_, index) => {
            const { privateKey } = testSigningKey(`unknown-${index}`);
            return testToken(privateKey, `unknown-${index}`);
        });

        const results = await Promise.allSettled(unknownTokens.map((token) => (
            verifyBearerToken(token, { env, fetchImpl, now: () => now })
        )));
        expect(results).toEqual(Array.from({ length: 12 }, () => expect.objectContaining({
            status: 'rejected',
            reason: expect.objectContaining({ details: { code: 'invalid_token' } })
        })));
        expect(fetchImpl).toHaveBeenCalledTimes(1);

        const { privateKey } = testSigningKey('another-unknown-key');
        await expect(verifyBearerToken(testToken(privateKey, 'another-unknown-key'), {
            env,
            fetchImpl,
            now: () => now + 30 * 1000
        })).rejects.toMatchObject({ details: { code: 'invalid_token' } });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    test.each([
        ['null header', 'bnVsbA.e30.AA'],
        ['array header', 'W10.e30.AA'],
        ['null claims', 'eyJhbGciOiJSUzI1NiIsImtpZCI6InRlc3Qta2V5In0.bnVsbA.AA'],
        ['array claims', 'eyJhbGciOiJSUzI1NiIsImtpZCI6InRlc3Qta2V5In0.W10.AA'],
        ['non-string key identifier', 'eyJhbGciOiJSUzI1NiIsImtpZCI6MX0.e30.AA']
    ])('rejects a JWT with a %s before fetching OAuth metadata', async (_caseName, token) => {
        const env = oauthTestEnv({ NOFRIES_MCP_JWKS_URI: 'https://login.example.test/shape-keys' });
        const fetchImpl = jest.fn();

        await expect(verifyBearerToken(token, { env, fetchImpl, now: () => Date.now() })).rejects.toMatchObject({
            details: { code: 'invalid_token' },
            statusCode: 401
        });
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    test.each([
        ['network error', async () => { throw new Error('provider unavailable'); }, 'mcp_auth_unavailable'],
        ['non-2xx response', async () => ({ ok: false }), 'mcp_auth_unavailable'],
        ['malformed response', async () => ({ ok: true, text: async () => '{not-json' }), 'mcp_auth_invalid_discovery'],
        ['null response', async () => ({ ok: true, json: async () => null }), 'mcp_auth_invalid_jwks'],
        ['empty key set', async () => ({ ok: true, json: async () => ({ keys: [] }) }), 'mcp_auth_invalid_jwks'],
        ['unusable key set', async () => ({ ok: true, json: async () => ({ keys: [{}] }) }), 'mcp_auth_invalid_jwks'],
        ['non-string key identifier', async () => {
            const { jwk } = testSigningKey('numeric-key');
            jwk.kid = 1;
            return { ok: true, json: async () => ({ keys: [jwk] }) };
        }, 'mcp_auth_invalid_jwks'],
        ['encryption-only key set', async () => {
            const { jwk } = testSigningKey('encryption-key');
            jwk.use = 'enc';
            return { ok: true, json: async () => ({ keys: [jwk] }) };
        }, 'mcp_auth_invalid_jwks'],
        ['other-algorithm key set', async () => {
            const { jwk } = testSigningKey('other-algorithm-key');
            jwk.alg = 'RS512';
            return { ok: true, json: async () => ({ keys: [jwk] }) };
        }, 'mcp_auth_invalid_jwks'],
        ['non-verification key set', async () => {
            const { jwk } = testSigningKey('non-verification-key');
            jwk.key_ops = ['encrypt'];
            return { ok: true, json: async () => ({ keys: [jwk] }) };
        }, 'mcp_auth_invalid_jwks']
    ])('bounds failed JWKS refreshes after a %s while retaining cached keys', async (
        _failureType,
        failedRefresh,
        expectedFailureCode
    ) => {
        const env = oauthTestEnv({ NOFRIES_MCP_JWKS_URI: 'https://login.example.test/failing-keys' });
        const { privateKey: trustedPrivateKey, jwk: trustedJwk } = testSigningKey('trusted-key');
        const { privateKey: unknownPrivateKey } = testSigningKey('unknown-key');
        const trustedToken = testToken(trustedPrivateKey, 'trusted-key');
        const unknownToken = testToken(unknownPrivateKey, 'unknown-key');
        let now = Date.now();
        const fetchImpl = jest.fn()
            .mockResolvedValueOnce({ ok: true, json: async () => ({ keys: [trustedJwk] }) })
            .mockImplementation(failedRefresh);

        await expect(verifyBearerToken(trustedToken, { env, fetchImpl, now: () => now })).resolves.toBeDefined();
        expect(fetchImpl).toHaveBeenCalledTimes(1);

        now += 60 * 1000;
        await expect(verifyBearerToken(unknownToken, { env, fetchImpl, now: () => now })).rejects.toMatchObject({
            details: { code: expectedFailureCode }
        });
        expect(fetchImpl).toHaveBeenCalledTimes(2);

        await expect(verifyBearerToken(trustedToken, { env, fetchImpl, now: () => now })).resolves.toBeDefined();
        expect(fetchImpl).toHaveBeenCalledTimes(2);

        now += 30 * 1000;
        await expect(verifyBearerToken(unknownToken, { env, fetchImpl, now: () => now })).rejects.toMatchObject({
            details: { code: 'invalid_token' }
        });
        expect(fetchImpl).toHaveBeenCalledTimes(2);

        now += 30 * 1000;
        await expect(verifyBearerToken(unknownToken, { env, fetchImpl, now: () => now })).rejects.toMatchObject({
            details: { code: expectedFailureCode }
        });
        expect(fetchImpl).toHaveBeenCalledTimes(3);
    });

    test.each(['cold', 'warm'])('rejects malformed RSA parameters without replacing %s-cache keys', async (cacheState) => {
        const env = oauthTestEnv({ NOFRIES_MCP_JWKS_URI: 'https://login.example.test/malformed-rsa-keys' });
        const { privateKey, jwk } = testSigningKey('trusted-key');
        const trustedToken = testToken(privateKey, 'trusted-key');
        const unknownToken = testToken(privateKey, 'unknown-key');
        const undersized = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 })
            .publicKey.export({ format: 'jwk' });
        const leadingZero = (value) => Buffer.concat([Buffer.from([0]), Buffer.from(value, 'base64url')])
            .toString('base64url');
        const evenModulus = Buffer.from(jwk.n, 'base64url');
        evenModulus[evenModulus.length - 1] &= 0xfe;
        const badParameters = [
            { n: '', e: '' },
            { n: '!' },
            { n: 'AQ' },
            { n: 'BQ', e: 'Aw' },
            { n: undersized.n, e: undersized.e },
            { n: `${jwk.n}=` },
            { n: leadingZero(jwk.n) },
            { n: evenModulus.toString('base64url') },
            { e: '' },
            { e: '!' },
            { e: 'AA' },
            { e: 'AQ' },
            { e: 'Ag' },
            { e: `${jwk.e}=` },
            { e: leadingZero(jwk.e) },
            { e: jwk.n }
        ];

        for (const parameters of badParameters) {
            resetMcpAuthCaches();
            let now = Date.now();
            const malformedJwk = { ...jwk, kid: 'unknown-key', ...parameters };
            const fetchImpl = jest.fn();
            let priorFetches = 0;
            if (cacheState === 'warm') {
                fetchImpl.mockResolvedValueOnce({ ok: true, json: async () => ({ keys: [jwk] }) });
                await expect(verifyBearerToken(trustedToken, { env, fetchImpl, now: () => now }))
                    .resolves.toBeDefined();
                now += 60 * 1000;
                priorFetches = 1;
            }
            fetchImpl.mockResolvedValue({ ok: true, json: async () => ({ keys: [malformedJwk] }) });
            await expect(verifyBearerToken(unknownToken, { env, fetchImpl, now: () => now }))
                .rejects.toMatchObject({ statusCode: 401, details: { code: 'mcp_auth_invalid_jwks' } });
            expect(fetchImpl).toHaveBeenCalledTimes(priorFetches + 1);

            now += 59_999;
            await expect(verifyBearerToken(unknownToken, { env, fetchImpl, now: () => now }))
                .rejects.toMatchObject({ details: {
                    code: cacheState === 'warm' ? 'invalid_token' : 'mcp_auth_unavailable'
                } });
            expect(fetchImpl).toHaveBeenCalledTimes(priorFetches + 1);
            if (cacheState === 'warm') {
                await expect(verifyBearerToken(trustedToken, { env, fetchImpl, now: () => now }))
                    .resolves.toBeDefined();
                expect(fetchImpl).toHaveBeenCalledTimes(priorFetches + 1);
            }

            now += 1;
            fetchImpl.mockResolvedValue({ ok: true, json: async () => ({ keys: [jwk] }) });
            await expect(verifyBearerToken(unknownToken, { env, fetchImpl, now: () => now }))
                .rejects.toMatchObject({ details: { code: 'invalid_token' } });
            await expect(verifyBearerToken(trustedToken, { env, fetchImpl, now: () => now }))
                .resolves.toBeDefined();
            expect(fetchImpl).toHaveBeenCalledTimes(priorFetches + 2);
        }
    });

    test('bounds cold-cache JWKS failures and retries after the cooldown', async () => {
        const env = oauthTestEnv({ NOFRIES_MCP_JWKS_URI: 'https://login.example.test/cold-cache-keys' });
        const { privateKey, jwk } = testSigningKey('cold-cache-key');
        const token = testToken(privateKey, 'cold-cache-key');
        let now = Date.now();
        const fetchImpl = jest.fn()
            .mockResolvedValueOnce({ ok: false })
            .mockResolvedValueOnce({ ok: true, json: async () => ({ keys: [jwk] }) });

        await expect(verifyBearerToken(token, { env, fetchImpl, now: () => now })).rejects.toMatchObject({
            details: { code: 'mcp_auth_unavailable' }
        });
        expect(fetchImpl).toHaveBeenCalledTimes(1);

        now += 30 * 1000;
        await expect(verifyBearerToken(token, { env, fetchImpl, now: () => now })).rejects.toMatchObject({
            details: { code: 'mcp_auth_unavailable' }
        });
        expect(fetchImpl).toHaveBeenCalledTimes(1);

        now += 30 * 1000;
        await expect(verifyBearerToken(token, { env, fetchImpl, now: () => now })).resolves.toBeDefined();
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    test('coalesces OIDC discovery and JWKS fetches when no explicit JWKS URI is configured', async () => {
        const env = oauthTestEnv({ NOFRIES_MCP_JWKS_URI: '' });
        const discoveryUrl = 'https://login.example.test/.well-known/openid-configuration';
        const jwksUrl = 'https://login.example.test/discovered-keys';
        const { privateKey, jwk } = testSigningKey('discovered-key');
        const token = testToken(privateKey, 'discovered-key');
        const fetchImpl = jest.fn(async (url) => {
            if (url === discoveryUrl) {
                return { ok: true, json: async () => ({ jwks_uri: jwksUrl }) };
            }
            return { ok: true, json: async () => ({ keys: [jwk] }) };
        });

        const claims = await Promise.all(Array.from({ length: 12 }, () => (
            verifyBearerToken(token, { env, fetchImpl, now: () => Date.now() })
        )));

        expect(claims).toHaveLength(12);
        expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([discoveryUrl, jwksUrl]);
    });

    test.each([
        ['network error', async () => { throw new Error('provider unavailable'); }, 'mcp_auth_unavailable'],
        ['non-2xx response', async () => ({ ok: false }), 'mcp_auth_unavailable'],
        ['malformed response', async () => ({ ok: true, text: async () => '{not-json' }), 'mcp_auth_invalid_discovery'],
        ['null metadata', async () => ({ ok: true, json: async () => null }), 'mcp_auth_invalid_discovery'],
        ['untrusted key URL', async () => ({
            ok: true,
            json: async () => ({ jwks_uri: 'https://untrusted.example.test/keys' })
        }), 'mcp_auth_invalid_discovery']
    ])('bounds failed OIDC discovery after a %s when no explicit JWKS URI is configured', async (
        _failureType,
        failedDiscovery,
        expectedFailureCode
    ) => {
        const env = oauthTestEnv({ NOFRIES_MCP_JWKS_URI: '' });
        const discoveryUrl = 'https://login.example.test/.well-known/openid-configuration';
        const jwksUrl = 'https://login.example.test/recovered-keys';
        const { privateKey, jwk } = testSigningKey('recovered-key');
        const token = testToken(privateKey, 'recovered-key');
        let now = Date.now();
        const fetchImpl = jest.fn(failedDiscovery);

        await expect(verifyBearerToken(token, { env, fetchImpl, now: () => now })).rejects.toMatchObject({
            details: { code: expectedFailureCode }
        });
        expect(fetchImpl).toHaveBeenCalledTimes(1);

        now += 30 * 1000;
        await expect(verifyBearerToken(token, { env, fetchImpl, now: () => now })).rejects.toMatchObject({
            details: { code: 'mcp_auth_unavailable' }
        });
        expect(fetchImpl).toHaveBeenCalledTimes(1);

        now += 30 * 1000;
        fetchImpl.mockImplementation(async (url) => {
            if (url === discoveryUrl) {
                return { ok: true, json: async () => ({ jwks_uri: jwksUrl }) };
            }
            return { ok: true, json: async () => ({ keys: [jwk] }) };
        });
        await expect(verifyBearerToken(token, { env, fetchImpl, now: () => now })).resolves.toBeDefined();
        expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([discoveryUrl, discoveryUrl, jwksUrl]);
    });

    test('returns and logs only safe diagnostics for an unexpected connector failure', async () => {
        const error = new Error('Bearer secret-token for joel@nofries.nz query No Fries Headquarters');
        error.code = 'unsafe secret-token';
        error.details = { code: 'secret-token' };
        const context = {
            invocationId: 'safe-invocation-36',
            log: { error: jest.fn() }
        };
        const handleRequest = jest.fn(async () => {
            throw error;
        });

        await runMcpFunction(context, { method: 'POST', headers: {} }, {
            env: { SAFE_SETTING: 'present' },
            handleRequest
        });

        expect(context.res.body.error).toEqual({
            code: -32603,
            message: 'Internal error. Reference: handler/request_handling_failed; incident safe-invocation-36.',
            data: {
                incidentId: 'safe-invocation-36',
                stage: 'handler',
                code: 'request_handling_failed'
            }
        });
        expect(context.log.error).toHaveBeenCalledWith({
            event: 'mcp_incident',
            incidentId: 'safe-invocation-36',
            stage: 'handler',
            code: 'request_handling_failed',
            statusCode: 500,
            tool: 'request'
        });
        expect(JSON.stringify(context.res)).not.toMatch(/secret-token|joel@nofries\.nz|No Fries Headquarters/);
        expect(JSON.stringify(context.log.error.mock.calls)).not.toMatch(/secret-token|joel@nofries\.nz|No Fries Headquarters/);
        expect(handleRequest).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
            env: { SAFE_SETTING: 'present' },
            incidentId: 'safe-invocation-36',
            logger: context.log
        }));
        expect(handleRequest.mock.calls[0][1].handleRequest).toBeUndefined();
    });
});

function mcpCall(id, name, args) {
    return {
        method: 'POST',
        body: { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }
    };
}

function authenticatedMcpCall(id, name, args, token) {
    const request = mcpCall(id, name, args);
    request.headers = { authorization: `Bearer ${token}` };
    return request;
}

function oauthTestEnv(overrides = {}) {
    return Object.assign({
        NOFRIES_PUBLIC_URL: 'https://nofries.nz',
        NOFRIES_MCP_AUTHORIZATION_SERVER: 'https://login.example.test',
        NOFRIES_MCP_ISSUER: 'https://login.example.test',
        NOFRIES_MCP_AUDIENCE: 'api://nofries-mcp',
        NOFRIES_MCP_TOKEN_SCOPE: 'nofries.lifecycle.read',
        NOFRIES_MCP_JWKS_URI: 'https://login.example.test/keys'
    }, overrides);
}

function testSigningKey(kid) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = publicKey.export({ format: 'jwk' });
    jwk.kid = kid;
    jwk.use = 'sig';
    return { privateKey, jwk };
}

function testToken(privateKey, kid, claims = {}) {
    const nowSeconds = Math.floor(Date.now() / 1000);
    return signToken(privateKey, {
        alg: 'RS256',
        kid,
        typ: 'JWT'
    }, Object.assign({
        iss: 'https://login.example.test',
        aud: 'api://nofries-mcp',
        exp: nowSeconds + 600,
        nbf: nowSeconds - 5,
        scp: 'nofries.lifecycle.read'
    }, claims));
}

function jwksFetch(jwk) {
    return jest.fn(async () => ({ ok: true, json: async () => ({ keys: [jwk] }) }));
}

function signToken(privateKey, header, claims) {
    const encodedHeader = base64Url(JSON.stringify(header));
    const encodedClaims = base64Url(JSON.stringify(claims));
    const input = `${encodedHeader}.${encodedClaims}`;
    const signature = crypto.sign('RSA-SHA256', Buffer.from(input, 'utf8'), privateKey);
    return `${input}.${base64Url(signature)}`;
}

function base64Url(value) {
    return Buffer.from(value).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function operatorAccess() {
    return {
        allowed: true,
        reason: 'test',
        user: {
            email: 'joel@nofries.nz',
            name: 'Joel Harvey',
            role: 'admin',
            capabilities: ROLE_CAPABILITIES.admin.slice()
        },
        tenant: {
            id: 'tenant-a',
            key: tenantStorageKey('tenant-a'),
            name: 'No Fries',
            slug: 'no-fries'
        },
        authentication: { required: true, authenticated: true, provider: 'test' }
    };
}

function publicAccess() {
    const access = operatorAccess();
    access.user = {
        email: 'prospect-agent@nofries.invalid',
        name: 'Prospect Agent',
        role: 'public_agent',
        capabilities: ['prospect:write']
    };
    return access;
}
