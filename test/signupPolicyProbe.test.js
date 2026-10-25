'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const requestHttp = require('supertest');
const probe = require('../lib/signupPolicyProbe');
const { CUSTOMER_MFA_POLICY } = require('../api/shared/customerSignup/customerMfaPolicy');
const NOW = 1790748000000;
const request = () => ({ schemaVersion: 1, ...probe.TARGET, releaseSha: 'a'.repeat(40), releaseRunId: '123',
    policyId: CUSTOMER_MFA_POLICY.id, context: 'c1', nonce: 'b'.repeat(64), issuedAt: NOW });
const args = value => ['--request', Buffer.from(JSON.stringify(value)).toString('base64url')];
const manifest = () => ({ schemaVersion: 2, releaseSha: 'a'.repeat(40), runId: '123', runAttempt: '1' });
const env = () => ({ WEBSITE_SITE_NAME: probe.TARGET.app, WEBSITE_SLOT_NAME: 'Production',
    NOFRIES_ENTRA_TENANT_ID: probe.TARGET.tenant, NOFRIES_CUSTOMER_MFA_POLICY_ID: CUSTOMER_MFA_POLICY.id,
    NOFRIES_CUSTOMER_MFA_CONTEXT: 'c1', IDENTITY_ENDPOINT: 'http://127.0.0.1:8081/msi/token', IDENTITY_HEADER: 'synthetic-private-header' });
const token = changes => ({ token: ['synthetic', Buffer.from(JSON.stringify({ tid: probe.TARGET.tenant,
    oid: probe.TARGET.identity, aud: '00000003-0000-0000-c000-000000000000', roles: ['Policy.Read.All'],
    exp: NOW / 1000 + 3600, nbf: NOW / 1000 - 10, ...changes })).toString('base64url'), 'signature'].join('.'),
    expiresOnTimestamp: NOW + 3600000 });
const policy = () => ({ id: CUSTOMER_MFA_POLICY.id, displayName: CUSTOMER_MFA_POLICY.name, state: 'enabled',
    conditions: { users: { includeUsers: ['All'], excludeUsers: [], excludeGroups: [], excludeRoles: [] },
        applications: { includeApplications: [], excludeApplications: [], includeUserActions: [],
            includeAuthenticationContextClassReferences: ['c1'] }, clientAppTypes: ['all'],
        signInRiskLevels: [], userRiskLevels: [], servicePrincipalRiskLevels: [] },
    grantControls: { operator: 'OR', builtInControls: ['mfa'] } });
function harness() {
    const getToken = jest.fn(async () => token());
    const ManagedIdentityCredential = jest.fn(function () { this.getToken = getToken; });
    const fetch = jest.fn(async () => new Response(JSON.stringify(policy())));
    const dependencies = { now: () => NOW, env: env(), readManifest: jest.fn(manifest), ManagedIdentityCredential, fetch };
    return { getToken, ManagedIdentityCredential, fetch, dependencies,
        run: (input = request()) => probe.run(args(input), dependencies) };
}
const rejected = promise => expect(promise).rejects.toMatchObject({ code: probe.ERROR,
    message: 'Signup policy verification did not complete.' });

test('uses managed identity and unchanged Graph validator; returns only bounded request-bound evidence', async () => {
    const h = harness();
    const result = await h.run();
    expect(result).toEqual({ ...request(), observedAt: NOW, verified: true });
    expect(h.ManagedIdentityCredential.mock.calls).toEqual([[]]);
    expect(h.getToken.mock.calls[0][0]).toBe(probe.SCOPE);
    expect(h.getToken.mock.calls[0][1].abortSignal.aborted).toBe(true);
    expect(h.fetch.mock.calls[0][0]).toBe('https://graph.microsoft.com/v1.0/identity/conditionalAccess/policies/' + CUSTOMER_MFA_POLICY.id);
    expect(h.fetch.mock.calls[0][1]).toMatchObject({ method: 'GET', redirect: 'error' });
    expect(h.dependencies.readManifest).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result).length).toBeLessThan(probe.MAX_BYTES);
    expect(JSON.stringify(result)).not.toContain(token().token);
    expect(JSON.stringify(result)).not.toContain('synthetic-private-header');
    expect(result).not.toHaveProperty('accessGranted');
});
test('fixed target matches the existing operator diagnostic', () => {
    const existing = require('../lib/dashboardManagedIdentityProbe').TARGET;
    for (const key of Object.keys(probe.TARGET)) expect(probe.TARGET[key]).toBe(existing[key]);
});
test.each([
    ['schemaVersion', 2], ['app', 'another'], ['tenant', 'another'], ['identity', 'another'],
    ['releaseSha', 'A'.repeat(40)], ['releaseSha', 'a'.repeat(39)], ['releaseRunId', '0123'],
    ['releaseRunId', 123], ['policyId', 'c'.repeat(36)], ['context', 'c2'], ['nonce', 'b'.repeat(63)],
    ['nonce', 'B'.repeat(64)], ['issuedAt', NOW + 1], ['issuedAt', NOW - probe.MAX_AGE_MS],
    ['issuedAt', 1.5], ['extra', true]
])('rejects invalid request %s before obtaining credentials', async (key, value) => {
    const h = harness(); await rejected(h.run({ ...request(), [key]: value }));
    expect(h.ManagedIdentityCredential).not.toHaveBeenCalled(); expect(h.fetch).not.toHaveBeenCalled();
});
test.each([[], ['--sha', 'a'.repeat(40)], ['--request', '%'], ['--request', 'e30='],
    ['--request', 'a'.repeat(2049)], ['--request', Buffer.from('{"x":1,"x":2}').toString('base64url')],
    ['--request', Buffer.from('null').toString('base64url')], ['--request', 'e30', '--extra']].map(value => [value]))
('rejects malformed command %j', async input => {
    const h = harness(); await rejected(probe.run(input, h.dependencies));
    expect(h.ManagedIdentityCredential).not.toHaveBeenCalled();
});
test.each([
    ['WEBSITE_SITE_NAME', 'other'], ['WEBSITE_SLOT_NAME', 'staging'], ['NOFRIES_ENTRA_TENANT_ID', 'other'],
    ['NOFRIES_CUSTOMER_MFA_POLICY_ID', 'other'], ['NOFRIES_CUSTOMER_MFA_CONTEXT', 'c2'],
    ['IDENTITY_HEADER', ''], ['IDENTITY_HEADER', 'bad\nheader'], ['IDENTITY_ENDPOINT', 'https://example.test/token'],
    ['IDENTITY_ENDPOINT', 'http://localhost.evil/token'], ['IDENTITY_ENDPOINT', 'http://user@127.0.0.1/token'],
    ['AZURE_CLIENT_ID', 'override'], ['AZURE_CLIENT_SECRET', 'synthetic-secret'],
    ['NOFRIES_MANAGED_IDENTITY_CLIENT_ID', 'override'], ['AZURE_FEDERATED_TOKEN_FILE', '/private'],
    ['AZURE_LOG_LEVEL', 'verbose'], ['NODE_OPTIONS', '--require=other'], ['DEBUG', '*'],
    ['IDENTITY_SERVER_THUMBPRINT', 'alternate-managed-identity-source']
])('rejects context override %s before obtaining credentials', async (key, value) => {
    const h = harness(); h.dependencies.env[key] = value;
    await rejected(h.run()); expect(h.ManagedIdentityCredential).not.toHaveBeenCalled();
});
test.each([{ releaseSha: null }, { runId: null }, { releaseSha: 'c'.repeat(40) }, { runId: '124' },
    { runAttempt: '2' }, { schemaVersion: 1 }, { extra: true }])('rejects manifest %j before token request', async changes => {
    const h = harness(); h.dependencies.readManifest.mockReturnValue({ ...manifest(), ...changes });
    await rejected(h.run()); expect(h.getToken).not.toHaveBeenCalled();
});
test.each([{ oid: 'other' }, { tid: 'other' }, { aud: 'https://management.azure.com/' }, { roles: [] },
    { roles: 'Policy.Read.All' }, { scp: 'Policy.Read.All' }, { exp: NOW / 1000 }, { nbf: NOW / 1000 + 1 }])
('rejects token binding %j before Graph', async changes => {
    const h = harness(); h.getToken.mockResolvedValue(token(changes));
    await rejected(h.run()); expect(h.fetch).not.toHaveBeenCalled();
});
test.each([null, { token: 'not-jwt' }, { ...token(), expiresOnTimestamp: NOW }])('rejects malformed token', async value => {
    const h = harness(); h.getToken.mockResolvedValue(value); await rejected(h.run()); expect(h.fetch).not.toHaveBeenCalled();
});
test('sanitizes credential construction, acquisition and manifest failures', async () => {
    for (const phase of ['construct', 'token', 'manifest']) {
        const h = harness();
        const failure = () => { throw Error('synthetic-private-provider-diagnostic'); };
        if (phase === 'construct') h.ManagedIdentityCredential.mockImplementation(failure);
        if (phase === 'token') h.getToken.mockImplementation(failure);
        if (phase === 'manifest') h.dependencies.readManifest.mockImplementation(failure);
        await rejected(h.run()); expect(h.fetch).not.toHaveBeenCalled();
    }
});
test.each(['denied', 'unavailable', 'malformed', 'oversized', 'report-only', 'exclusion', 'no-mfa', 'wrong-context'])
('fails closed for Graph %s without exposing provider diagnostics', async state => {
    const h = harness(), p = policy();
    if (state === 'report-only') p.state = 'enabledForReportingButNotEnforced';
    if (state === 'exclusion') p.conditions.users.excludeUsers = ['someone'];
    if (state === 'no-mfa') p.grantControls.builtInControls = [];
    if (state === 'wrong-context') p.conditions.applications.includeAuthenticationContextClassReferences = ['c2'];
    h.fetch.mockImplementation(async () => {
        if (state === 'unavailable') throw Error('synthetic-provider-secret');
        return new Response(state === 'malformed' ? 'invalid' : state === 'oversized' ? 'x'.repeat(65537) : JSON.stringify(p),
            { status: state === 'denied' ? 403 : 200 });
    });
    await rejected(h.run());
});
test('rejects context and release drift after Graph read', async () => {
    for (const mutate of [h => { h.dependencies.env.NOFRIES_CUSTOMER_MFA_CONTEXT = 'c2'; },
        h => { h.dependencies.readManifest.mockReturnValue({ ...manifest(), runId: '124' }); },
        h => { h.dependencies.now = () => NOW + probe.MAX_AGE_MS; }]) {
        const h = harness();
        // now is intentionally a stable function closing over a mutable clock.
        let clock = NOW; h.dependencies.now = () => clock;
        h.fetch.mockImplementation(async () => { mutate(h); if (h.dependencies.now() !== NOW) clock += probe.MAX_AGE_MS;
            return new Response(JSON.stringify(policy())); });
        await rejected(h.run());
    }
});
test('nonce is echoed exactly; caller must generate and match a new challenge for each execution', async () => {
    const h = harness();
    expect((await h.run()).nonce).toBe('b'.repeat(64));
    expect((await h.run({ ...request(), nonce: 'c'.repeat(64) })).nonce).toBe('c'.repeat(64));
    expect(h.getToken).toHaveBeenCalledTimes(2); expect(h.fetch).toHaveBeenCalledTimes(2);
});
test('bounds unresponsive credential and never dispatches Graph after a late token', async () => {
    jest.useFakeTimers();
    try {
        const h = harness(); let resolve;
        h.getToken.mockReturnValue(new Promise(done => { resolve = done; }));
        const result = rejected(h.run());
        await jest.advanceTimersByTimeAsync(probe.DEADLINE_MS); await result;
        resolve(token()); await Promise.resolve(); await Promise.resolve();
        expect(h.fetch).not.toHaveBeenCalled(); expect(h.getToken.mock.calls[0][1].abortSignal.aborted).toBe(true);
    } finally { jest.useRealTimers(); }
});
test('bounds unresponsive Graph and aborts its request', async () => {
    jest.useFakeTimers();
    try {
        const h = harness(); h.fetch.mockReturnValue(new Promise(() => {}));
        const result = rejected(h.run()); await jest.advanceTimersByTimeAsync(probe.DEADLINE_MS); await result;
        expect(h.fetch.mock.calls[0][1].signal.aborted).toBe(true);
    } finally { jest.useRealTimers(); }
});
test('real CLI refuses unstamped source with bounded sanitized output', () => {
    const child = spawnSync(process.execPath, ['lib/signupPolicyProbe.js', ...args({ ...request(), issuedAt: Date.now() })],
        { cwd: path.resolve(__dirname, '..'), env: { PATH: process.env.PATH, ...env() }, encoding: 'utf8', timeout: 3000 });
    expect(child.status).toBe(1); expect(child.stdout).toBe('');
    expect(JSON.parse(child.stderr)).toEqual({ code: probe.ERROR });
});
test('helper is packaged and not served over HTTP', async () => {
    const root = path.resolve(__dirname, '..');
    const build = spawnSync(process.execPath, ['scripts/build-app-service.js'], { cwd: root, encoding: 'utf8' });
    expect(build.status).toBe(0);
    expect(fs.readFileSync(path.join(root, 'app-service-dist/lib/signupPolicyProbe.js'), 'utf8'))
        .toBe(fs.readFileSync(path.join(root, 'lib/signupPolicyProbe.js'), 'utf8'));
    const app = require('../server');
    for (const [url, status] of [['/lib/signupPolicyProbe.js', 404], ['/api/signupPolicyProbe', 410]]) {
        const response = await requestHttp(app).get(url); expect(response.status).toBe(status);
        expect(response.text).not.toContain('ManagedIdentityCredential');
        expect(response.text).not.toContain('verified');
    }
}, 15000);
