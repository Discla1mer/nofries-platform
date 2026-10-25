const request = require('supertest');

const app = require('../connector-server');

describe('standalone No Fries agent connector', () => {
    const previous = {};
    const keys = [
        'NOFRIES_PUBLIC_URL',
        'NOFRIES_MCP_RESOURCE_URL',
        'NOFRIES_MCP_METADATA_URL',
        'NOFRIES_MCP_AUTHORIZATION_SERVER',
        'NOFRIES_MCP_AUDIENCE',
        'NOFRIES_MCP_SCOPE'
    ];

    beforeEach(() => {
        keys.forEach((key) => {
            previous[key] = process.env[key];
        });
        process.env.NOFRIES_PUBLIC_URL = 'https://nofries.nz';
        process.env.NOFRIES_MCP_RESOURCE_URL = 'https://nofries-agent-connector.azurewebsites.net/api/mcp';
        process.env.NOFRIES_MCP_METADATA_URL = 'https://nofries-agent-connector.azurewebsites.net/api/mcp-auth';
        process.env.NOFRIES_MCP_AUTHORIZATION_SERVER = 'https://nofries.nz';
        process.env.NOFRIES_MCP_AUDIENCE = 'api://connector-id';
        process.env.NOFRIES_MCP_SCOPE = 'api://connector-id/nofries.lifecycle.read';
    });

    afterEach(() => {
        keys.forEach((key) => {
            if (previous[key] == null) delete process.env[key];
            else process.env[key] = previous[key];
        });
    });

    test.each([
        '/api/mcp-auth',
        '/.well-known/oauth-protected-resource',
        '/.well-known/oauth-protected-resource/api/mcp'
    ])('publishes protected-resource metadata at %s', async (path) => {
        const response = await request(app).get(path).expect(200);

        expect(response.body).toEqual({
            resource: 'https://nofries-agent-connector.azurewebsites.net/api/mcp',
            authorization_servers: ['https://nofries.nz'],
            scopes_supported: ['api://connector-id/nofries.lifecycle.read'],
            resource_documentation: 'https://nofries.nz/privacy.html'
        });
        expect(response.headers['cache-control']).toContain('no-store');
    });

    test('serves MCP initialization without exposing the main application', async () => {
        const response = await request(app)
            .post('/api/mcp')
            .send({
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: {
                    protocolVersion: '2025-06-18',
                    capabilities: {},
                    clientInfo: { name: 'connector-test', version: '1.0.0' }
                }
            })
            .expect(200);

        expect(response.body.result).toMatchObject({
            protocolVersion: '2025-06-18',
            serverInfo: { name: 'nofries-lifecycle', version: '1.0.0' }
        });
        await request(app).get('/operator').expect(404);
    });
});
