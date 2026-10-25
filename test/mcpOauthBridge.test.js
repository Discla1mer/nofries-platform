const {
    handleMcpOauthAuthorizeRequest,
    handleMcpOauthMetadataRequest,
    handleMcpOauthTokenRequest,
    resolveMcpOauthBridgeSettings
} = require('../api/shared/mcpOauthBridge');

const CLIENT_ID = '574b39b8-0972-46ce-915e-875b8bf709a4';
const TENANT_ID = '947787df-88fd-4417-b6b2-99c13d8410ba';
const SCOPE = `api://${CLIENT_ID}/nofries.lifecycle.read`;
const CALLBACK = 'https://chatgpt.com/connector/oauth/VF0912mYATSO';
const CHALLENGE = 'A'.repeat(43);
const VERIFIER = 'v'.repeat(43);

function env() {
    return {
        NOFRIES_PUBLIC_URL: 'https://nofries.nz',
        NOFRIES_MCP_ISSUER: `https://login.microsoftonline.com/${TENANT_ID}/v2.0`,
        NOFRIES_MCP_CLIENT_ID: CLIENT_ID,
        NOFRIES_MCP_SCOPE: SCOPE
    };
}

describe('No Fries OAuth bridge for Microsoft Entra', () => {
    test('publishes OAuth metadata with S256 PKCE support', () => {
        const response = handleMcpOauthMetadataRequest({ method: 'GET' }, { env: env() });

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({
            issuer: 'https://nofries.nz',
            authorization_endpoint: 'https://nofries.nz/api/mcp-oauth-authorize',
            token_endpoint: 'https://nofries.nz/api/mcp-oauth-token',
            token_endpoint_auth_methods_supported: ['none'],
            code_challenge_methods_supported: ['S256'],
            scopes_supported: [SCOPE, 'offline_access']
        });
    });

    test('forwards a validated authorization request to Entra without the MCP resource parameter', () => {
        const response = handleMcpOauthAuthorizeRequest({
            method: 'GET',
            query: {
                client_id: CLIENT_ID,
                response_type: 'code',
                redirect_uri: CALLBACK,
                scope: `${SCOPE} offline_access`,
                state: 'signed-state',
                code_challenge: CHALLENGE,
                code_challenge_method: 'S256',
                resource: 'https://nofries.nz/api/mcp'
            }
        }, { env: env() });

        expect(response.status).toBe(302);
        const location = new URL(response.headers.Location);
        expect(location.origin).toBe('https://login.microsoftonline.com');
        expect(location.pathname).toBe(`/${TENANT_ID}/oauth2/v2.0/authorize`);
        expect(location.searchParams.get('client_id')).toBe(CLIENT_ID);
        expect(location.searchParams.get('code_challenge_method')).toBe('S256');
        expect(location.searchParams.get('resource')).toBeNull();
    });

    test('rejects callbacks outside ChatGPT and PKCE methods weaker than S256', () => {
        const base = {
            client_id: CLIENT_ID,
            response_type: 'code',
            redirect_uri: CALLBACK,
            scope: SCOPE,
            state: 'signed-state',
            code_challenge: CHALLENGE,
            code_challenge_method: 'S256'
        };

        const callback = handleMcpOauthAuthorizeRequest({
            method: 'GET',
            query: Object.assign({}, base, { redirect_uri: 'https://attacker.example/callback' })
        }, { env: env() });
        expect(callback.status).toBe(400);
        expect(callback.body.error).toBe('invalid_request');

        const pkce = handleMcpOauthAuthorizeRequest({
            method: 'GET',
            query: Object.assign({}, base, { code_challenge_method: 'plain' })
        }, { env: env() });
        expect(pkce.status).toBe(400);
        expect(pkce.body.error_description).toContain('S256');
    });

    test('exchanges a public-client authorization code without forwarding resource or a secret', async () => {
        const fetchImpl = jest.fn(async (url, options) => ({
            status: 200,
            headers: { get: () => 'application/json' },
            text: async () => JSON.stringify({ access_token: 'redacted', token_type: 'Bearer' })
        }));
        const response = await handleMcpOauthTokenRequest({
            method: 'POST',
            body: {
                client_id: CLIENT_ID,
                grant_type: 'authorization_code',
                code: 'one-time-code',
                redirect_uri: CALLBACK,
                code_verifier: VERIFIER,
                scope: SCOPE,
                resource: 'https://nofries.nz/api/mcp'
            }
        }, { env: env(), fetchImpl });

        expect(response.status).toBe(200);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        const [url, options] = fetchImpl.mock.calls[0];
        expect(url).toBe(`https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`);
        const forwarded = new URLSearchParams(options.body);
        expect(forwarded.get('code_verifier')).toBe(VERIFIER);
        expect(forwarded.get('resource')).toBeNull();
        expect(forwarded.get('client_secret')).toBeNull();
        expect(options.redirect).toBe('error');
        expect(options.signal).toBeInstanceOf(AbortSignal);
    });

    test('rejects oversized token requests without contacting Entra', async () => {
        const fetchImpl = jest.fn();
        const response = await handleMcpOauthTokenRequest({
            method: 'POST',
            body: {
                client_id: CLIENT_ID,
                grant_type: 'authorization_code',
                code: 'x'.repeat(33 * 1024),
                redirect_uri: CALLBACK,
                code_verifier: VERIFIER,
                scope: SCOPE
            }
        }, { env: env(), fetchImpl });

        expect(response.status).toBe(413);
        expect(response.body.error).toBe('invalid_request');
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    test('fails closed when the issuer is not a tenant-specific Entra v2 issuer', () => {
        const settings = resolveMcpOauthBridgeSettings(Object.assign(env(), {
            NOFRIES_MCP_ISSUER: 'https://login.example.test/tenant/v2.0'
        }));
        expect(settings.configured).toBe(false);
    });
});
