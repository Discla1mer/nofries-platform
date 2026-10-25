const fs = require('fs');
const path = require('path');

const runMcp = require('../connector-functions/mcp');
const runMetadata = require('../connector-functions/mcpAuth');
const runProtectedRoot = require('../connector-functions/mcpProtectedResource');
const runProtectedPath = require('../connector-functions/mcpProtectedResourcePath');
const runHealth = require('../connector-functions/health');

describe('serverless No Fries agent connector', () => {
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
        keys.forEach((key) => { previous[key] = process.env[key]; });
        process.env.NOFRIES_PUBLIC_URL = 'https://nofries.nz';
        process.env.NOFRIES_MCP_RESOURCE_URL = 'https://nofries-agent-connector-flex.azurewebsites.net/api/mcp';
        process.env.NOFRIES_MCP_METADATA_URL = 'https://nofries-agent-connector-flex.azurewebsites.net/api/mcp-auth';
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

    test.each([runMetadata, runProtectedRoot, runProtectedPath])('publishes the same protected-resource metadata on every discovery route', async (handler) => {
        const context = {};
        await handler(context, { method: 'GET' });
        expect(context.res.status).toBe(200);
        expect(context.res.body).toMatchObject({
            resource: 'https://nofries-agent-connector-flex.azurewebsites.net/api/mcp',
            authorization_servers: ['https://nofries.nz'],
            scopes_supported: ['api://connector-id/nofries.lifecycle.read']
        });
    });

    test('uses exact connector-only routes with no global API prefix', () => {
        const host = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'connector-functions', 'host.json'), 'utf8'));
        const route = (name) => require(`../connector-functions/${name}/function.json`).bindings[0].route;
        expect(host.extensions.http.routePrefix).toBe('');
        expect([
            route('mcp'),
            route('mcpAuth'),
            route('mcpProtectedResource'),
            route('mcpProtectedResourcePath'),
            route('health')
        ]).toEqual([
            'api/mcp',
            'api/mcp-auth',
            '.well-known/oauth-protected-resource',
            '.well-known/oauth-protected-resource/api/mcp',
            'health'
        ]);
    });

    test('initializes MCP and refuses to report an unstamped build as ready', async () => {
        const mcpContext = {};
        await runMcp(mcpContext, {
            method: 'POST',
            headers: {},
            body: {
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } }
            }
        });
        expect(mcpContext.res.status).toBe(200);
        expect(mcpContext.res.body.result.serverInfo.name).toBe('nofries-lifecycle');

        const healthContext = {};
        await runHealth(healthContext);
        expect(healthContext.res).toMatchObject({
            status: 503,
            body: {
                service: 'nofries-agent-connector',
                status: 'unavailable',
                code: 'release_identity_unavailable'
            }
        });
    });
});
