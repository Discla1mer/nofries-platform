'use strict';
// Actual installed SDK execution. All HTTP is synthetic; no live authentication.
const path = require('node:path');
const { createRequire } = require('node:module');
const { denyOutbound, response } = require('./helpers/offlineCustomerSigner');
const tenant = '11111111-1111-4111-8111-111111111111';
const client = '22222222-2222-4222-8222-222222222222';
const authority = `https://login.microsoftonline.com/${tenant}`;
const endpoint = authority + '/oauth2/v2.0/token';
const metadata = { authorization_endpoint: authority + '/oauth2/v2.0/authorize', token_endpoint: endpoint,
    issuer: authority + '/v2.0', jwks_uri: authority + '/discovery/v2.0/keys',
    end_session_endpoint: authority + '/oauth2/v2.0/logout' };
const scopes = ['https://vault.azure.net/.default'];
// Public CI installs root dependencies with --omit=optional. The supplemental
// runner requires full root/API installs and executes every optional SDK copy.
const fullClosure = process.env.NOFRIES_FULL_MSAL_CLOSURE === 'true';
function consumer(label, anchor, msalDirectory, identityDirectory) {
    const req = createRequire(path.resolve(anchor));
    // Bind labels to physical installs; Node ancestor fallback must never turn
    // a missing API/optional SDK into a falsely passing root SDK scenario.
    for (const [name, directory] of [['@azure/msal-node', msalDirectory], ['@azure/identity', identityDirectory]]) {
        if (!directory) continue;
        const actual = req.resolve(name + '/package.json');
        expect(require('node:fs').realpathSync(actual)).toBe(
            require('node:fs').realpathSync(path.resolve(directory, 'package.json')));
    }
    return [label, req];
}
const rootConsumer = () => consumer('root', 'package.json',
    'node_modules/@azure/msal-node', 'node_modules/@azure/identity');
const consumers = [rootConsumer()];
if (fullClosure) consumers.push(
    consumer('api', 'api/package.json', 'api/node_modules/@azure/msal-node', 'api/node_modules/@azure/identity'),
    consumer('promptfoo', 'node_modules/promptfoo/package.json',
        'node_modules/promptfoo/node_modules/@azure/msal-node', 'node_modules/promptfoo/node_modules/@azure/identity'),
    consumer('promptfoo Identity', 'node_modules/promptfoo/node_modules/@azure/identity/package.json',
        'node_modules/promptfoo/node_modules/@azure/identity/node_modules/@azure/msal-node',
        'node_modules/promptfoo/node_modules/@azure/identity')
);
let escapes;
beforeEach(() => { escapes = denyOutbound(); });
afterEach(() => { try { expect(escapes).toEqual([]); } finally { jest.restoreAllMocks(); } });
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
function tokenBody(nonce = 'trusted-nonce') {
    return { access_token: 'OFFLINE_ACCESS_TOKEN', token_type: 'Bearer', expires_in: 3600,
        scope: 'openid profile', client_info: encode({ uid: client, utid: tenant }),
        id_token: encode({ alg: 'none' }) + '.' + encode({ aud: client, iss: metadata.issuer,
            oid: client, tid: tenant, sub: 'offline-user', preferred_username: 'offline@example.test',
            iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, nonce }) + '.' };
}

test.each(consumers)('%s confidential client discards hostile routing/cache metadata and preserves trusted PKCE/nonce/cache', async (_name, req) => {
    const msal = req('@azure/msal-node');
    expect(req('@azure/msal-node/package.json').version).toBe('7.1.1');
    const posts = [], gets = [];
    const app = new msal.ConfidentialClientApplication({ auth: { clientId: client,
        clientSecret: 'OFFLINE_SECRET', authority, knownAuthorities: ['login.microsoftonline.com'],
        authorityMetadata: JSON.stringify(metadata) }, system: { networkClient: {
        sendGetRequestAsync: async url => { gets.push(url); throw new Error('unexpected discovery'); },
        sendPostRequestAsync: async (url, options) => {
            posts.push({ url, form: new URLSearchParams(options.body) });
            return { status: 200, headers: {}, body: tokenBody() };
        }
    } } });
    const request = { code: 'TRUSTED_CODE', scopes: ['openid', 'profile'], nonce: 'trusted-nonce',
        codeVerifier: 'v'.repeat(64), redirectUri: 'https://nofries.example.test/callback' };
    const authUrl = new URL(await app.getAuthCodeUrl({ ...request, state: 'trusted-state',
        responseMode: 'form_post', codeChallenge: 'C'.repeat(43), codeChallengeMethod: 'S256' }));
    expect(authUrl.searchParams.get('response_mode')).toBe('form_post');
    expect(authUrl.searchParams.get('nonce')).toBe(request.nonce);
    const result = await app.acquireTokenByCode(request, { code: 'HOSTILE_CODE', nonce: 'hostile-nonce',
        cloud_instance_host_name: 'attacker.example.test', cloud_graph_host_name: 'graph.attacker.example.test',
        msgraph_host: 'msgraph.attacker.example.test' });
    expect(result.accessToken).toBe('OFFLINE_ACCESS_TOKEN');
    expect(posts).toHaveLength(1); expect(gets).toEqual([]);
    expect(posts[0].url.split('?')[0]).toBe(endpoint);
    expect(posts[0].form.get('code')).toBe(request.code);
    expect(posts[0].form.get('code_verifier')).toBe(request.codeVerifier);
    expect(posts[0].form.get('client_secret')).toBe('OFFLINE_SECRET');
    expect(app.getTokenCache().serialize()).not.toContain('attacker.example.test');
    expect(await app.getTokenCache().getAllAccounts()).toHaveLength(1);
    // Ordinary one-argument manually hosted confidential exchange still works.
    expect((await app.acquireTokenByCode(request)).accessToken).toBe('OFFLINE_ACCESS_TOKEN');
    await expect(app.acquireTokenByCode({ ...request, nonce: 'wrong-trusted-nonce' },
        { nonce: 'trusted-nonce' })).rejects.toMatchObject({ errorCode: 'nonce_mismatch' });
    await expect(app.getAuthCodeUrl({ scopes, extraQueryParameters: { instance_aware: 'true' } }))
        .rejects.toMatchObject({ errorCode: 'unsupported_cca_instance_aware' });
});

const identityConsumers = consumers.filter(([name]) => name !== 'promptfoo Identity');
test.each(identityConsumers)('%s actual Identity secret, assertion and default environment paths retain token/cache contracts', async (_name, req) => {
    const sdk = req('@azure/identity');
    const requests = [];
    const options = { disableInstanceDiscovery: true, retryOptions: { maxRetries: 0 },
        httpClient: { sendRequest: async request => {
            requests.push(request);
            const url = new URL(request.url);
            expect(url.origin).toBe('https://login.microsoftonline.com');
            if (request.method === 'GET') {
                expect(url.pathname).toContain('.well-known/openid-configuration');
                return response(request, 200, metadata);
            }
            expect(url.origin + url.pathname).toBe(endpoint);
            return response(request, 200, { access_token: 'OFFLINE_IDENTITY_TOKEN', expires_in: 3600,
                token_type: 'Bearer' });
        } } };
    for (const kind of ['secret', 'assertion', 'default']) {
        requests.length = 0;
        jest.replaceProperty(process, 'env', { NODE_ENV: 'test', AZURE_TENANT_ID: tenant,
            AZURE_CLIENT_ID: client, AZURE_CLIENT_SECRET: 'OFFLINE_SECRET',
            AZURE_TOKEN_CREDENTIALS: 'EnvironmentCredential' });
        const getAssertion = jest.fn(async () => 'OFFLINE_ASSERTION');
        const credential = kind === 'secret' ? new sdk.ClientSecretCredential(tenant, client, 'OFFLINE_SECRET', options) :
            kind === 'assertion' ? new sdk.ClientAssertionCredential(tenant, client, getAssertion, options) :
                new sdk.DefaultAzureCredential(options);
        const token = await credential.getToken(scopes);
        expect(token.token).toBe('OFFLINE_IDENTITY_TOKEN');
        expect(token.expiresOnTimestamp).toBeGreaterThan(Date.now());
        const posts = requests.filter(r => r.method === 'POST');
        expect(posts).toHaveLength(1);
        const form = new URLSearchParams(posts[0].body);
        expect(form.get('grant_type')).toBe('client_credentials');
        expect(form.get('scope')).toBe(scopes[0]);
        expect(form.get('client_id')).toBe(client);
        expect(form.get(kind === 'assertion' ? 'client_assertion' : 'client_secret'))
            .toBe(kind === 'assertion' ? 'OFFLINE_ASSERTION' : 'OFFLINE_SECRET');
        if (kind === 'assertion') expect(getAssertion).toHaveBeenCalled();
        expect((await credential.getToken(scopes)).token).toBe('OFFLINE_IDENTITY_TOKEN');
        expect(requests.filter(r => r.method === 'POST')).toHaveLength(1);
    }
});

test.each(identityConsumers)('%s real ManagedIdentityCredential retains synthetic App Service token acquisition', async (_name, req) => {
    jest.replaceProperty(process, 'env', { NODE_ENV: 'test',
        IDENTITY_ENDPOINT: 'http://127.0.0.1:47111/offline-identity', IDENTITY_HEADER: 'OFFLINE_HEADER' });
    const calls = [];
    const credential = new (req('@azure/identity').ManagedIdentityCredential)({ clientId: client,
        retryOptions: { maxRetries: 0 }, httpClient: { sendRequest: async request => {
            calls.push(request);
            const url = new URL(request.url);
            expect(url.origin + url.pathname).toBe(process.env.IDENTITY_ENDPOINT);
            expect(url.searchParams.get('resource')).toBe('https://vault.azure.net');
            expect(url.searchParams.get('client_id')).toBe(client);
            expect(request.headers.get('x-identity-header')).toBe('OFFLINE_HEADER');
            return response(request, 200, { access_token: 'OFFLINE_MANAGED_TOKEN', token_type: 'Bearer',
                expires_on: String(Math.floor(Date.now() / 1000) + 3600), resource: 'https://vault.azure.net' });
        } } });
    const token = await credential.getToken(scopes);
    expect(token.token).toBe('OFFLINE_MANAGED_TOKEN');
    expect(token.expiresOnTimestamp).toBeGreaterThan(Date.now());
    expect(calls).toHaveLength(1);
});

test('every governed locked MSAL copy is fixed; full-closure mode requires every declared physical install', () => {
    const fs = require('node:fs');
    for (const directory of ['.', 'api']) {
        const lock = JSON.parse(fs.readFileSync(path.resolve(directory, 'package-lock.json')));
        const nodes = Object.entries(lock.packages).filter(([node]) => node.endsWith('/@azure/msal-node'));
        expect(nodes.length).toBe(directory === '.' ? 3 : 1);
        for (const [node, entry] of nodes) {
            expect(entry.version).toBe('7.1.1');
            if (fullClosure || (directory === '.' && node === 'node_modules/@azure/msal-node')) {
                expect(JSON.parse(fs.readFileSync(path.resolve(directory, node, 'package.json'))).version).toBe(entry.version);
            }
        }
    }
});
