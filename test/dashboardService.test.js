'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = global.test || require('node:test');
const { createDashboardService } = require('../api/shared/dashboardService');
const { resolveCustomerPortalAccess } = require('../api/shared/customerPortalAccess');
const { admissionFixture, SUBJECT } = require('./fixtures/dashboardAdmissionFixture');
const { createDom } = require('./fixtures/dashboardDom');
const request = { method: 'GET' };

test('authenticated source service bootstrap mounts the real renderer with provider-free synthetic data', async () => {
    const { adapters } = admissionFixture();
    const service = createDashboardService(adapters);
    const bootstrap = await service.handleRequest(request, 'bootstrap');
    const application = await service.handleRequest(request, 'app.js');
    const css = await service.handleRequest(request, 'dashboard.css');
    assert.equal(bootstrap.status, 200); assert.equal(application.status, 200); assert.equal(css.status, 200);
    assert.equal(application.headers['Content-Type'], 'application/javascript; charset=utf-8');
    assert.equal(css.headers['Content-Type'], 'text/css; charset=utf-8');
    assert.equal(application.isRaw, true); assert.match(css.body, /\.nofries-dashboard/);
    const browser = {}; vm.runInNewContext(application.body, browser);
    assert.equal(typeof browser.NoFriesNcscAssessmentClient.createClient, 'function');
    assert.equal(typeof browser.NoFriesNcscQuestionnaire.mount, 'function');
    const dom = createDom();
    browser.NoFriesDashboard.mount(dom.root, bootstrap.body, { window: dom.window });
    assert.match(dom.root.textContent, /Harbour Workshop/);
    assert.match(dom.root.textContent, /Overview/);
    assert.match(dom.root.textContent, /64%/);
    for (const result of [bootstrap, application, css]) {
        assert.equal(result.headers['Cache-Control'], 'private, no-store, max-age=0');
        assert.equal(result.headers['Cross-Origin-Resource-Policy'], 'same-origin');
        assert.equal(result.headers['X-Content-Type-Options'], 'nosniff');
        assert.equal(result.headers['Access-Control-Allow-Origin'], undefined);
    }
});

test('viewer receives only the permitted module display and no assessment/evidence records', async () => {
    const { adapters } = admissionFixture({ role: 'viewer' });
    const service = createDashboardService(adapters);
    const overview = await service.handleRequest(request, 'modules/overview');
    assert.equal(overview.status, 200);
    assert.deepEqual(overview.body.summary.attention, []);
    assert.deepEqual(overview.body.summary.metrics, []);
    assert.deepEqual(overview.body.services, []);
    for (const route of ['modules/cyber_security', 'modules/evidence']) {
        const result = await service.handleRequest(request, route);
        assert.equal(result.status, 403);
        assert.deepEqual(result.body, { code: 'dashboard_access_denied' });
    }
});

test('module response does not include neighbouring module displays, summary or service scope', async () => {
    const { adapters } = admissionFixture({ service: 'managed_endpoint' });
    const service = createDashboardService(adapters);
    const cyber = await service.handleRequest(request, 'modules/cyber_security');
    assert.equal(cyber.status, 200); assert.equal(cyber.body.module.key, 'cyber_security');
    assert.equal(cyber.body.module.state, 'planned');
    assert.equal(cyber.body.modules, undefined); assert.deepEqual(cyber.body.services, []);
    assert.deepEqual(cyber.body.summary, { state: 'empty', attention: [], metrics: [] });
    const services = await service.handleRequest(request, 'modules/services');
    assert.equal(services.status, 200);
    assert.equal(services.body.services.find(item => item.key === 'managed_endpoint').state, 'setup_required');
    assert.ok(services.body.services.every(item => item.operational === false));
    assert.equal(services.body.providerAccessGranted, false);
});

for (const route of ['bootstrap', 'modules/overview', 'app.js', 'dashboard.css']) {
    test(`${route} authenticates and reloads current membership for every protected response`, async () => {
        const { adapters, state } = admissionFixture();
        const service = createDashboardService(adapters);
        assert.equal((await service.handleRequest(request, route)).status, 200);
        state.input.membershipState.memberships[0].status = 'removed';
        const revoked = await service.handleRequest(request, route);
        assert.equal(revoked.status, 403);
        assert.deepEqual(revoked.body, { code: 'dashboard_access_denied' });
        assert.equal(revoked.headers['Cache-Control'], 'private, no-store, max-age=0');
        assert.equal(state.calls.filter(call => call === 'loadSnapshot').length, 2);
        state.authenticated = false;
        state.calls.length = 0;
        assert.equal((await service.handleRequest(request, route)).status, 403);
        assert.deepEqual(state.calls, ['authenticate']);
    });
}

for (const route of ['bootstrap', 'modules/cyber_security', 'app.js', 'dashboard.css']) {
    test(`${route} observes advisory purchase revocation on the next protected request`, async () => {
        const { adapters, state } = admissionFixture({ role: 'fractional_advisor', service: 'fractional_advisory' });
        const service = createDashboardService(adapters);
        const previous = await service.handleRequest(request, route);
        assert.equal(previous.status, 200);
        state.input.entitlementState.grants[1].status = 'revoked';
        const result = await service.handleRequest({ ...request, body: previous.body }, route);
        assert.equal(result.status, 403);
        assert.deepEqual(result.body, { code: 'dashboard_access_denied' });
        assert.equal(result.headers['Cache-Control'], 'private, no-store, max-age=0');
        assert.equal(state.calls.filter(call => call === 'loadSnapshot').length, 2);
        assert.ok(!JSON.stringify(result.body).includes('synthetic'));
    });
}

test('unrecognised routes, traversal, provider endpoints and writes never dispatch a data loader', async () => {
    const { adapters, state } = admissionFixture();
    const service = createDashboardService(adapters);
    for (const route of ['../app.js', 'modules/../overview', 'modules/overview/foreign', 'modules/evidence/foreign',
        'modules/board_reports/draft', 'tickets', 'proof/current', 'bootstrap?tenantId=foreign', '%62ootstrap', '/bootstrap', {}, null]) {
        assert.equal((await service.handleRequest(request, route)).status, 404);
    }
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', undefined]) {
        const result = await service.handleRequest({ method }, 'bootstrap');
        assert.equal(result.status, 405); assert.equal(result.headers.Allow, 'GET');
    }
    assert.deepEqual(state.calls, []);
});

test('legacy managed-service membership still requires provider identifiers and never accepts dashboard roles', async () => {
    const [tenantId, principalId] = SUBJECT.split(':');
    const identity = { provider: 'entra-bff', isAuthenticated: true, tenantId, principalId, subjectKey: SUBJECT,
        email: 'synthetic@example.test', name: 'Synthetic member' };
    const member = { subjectKey: SUBJECT, workspaceTenantId: 'synthetic-tenant', customerId: 'synthetic-workshop',
        companyId: '10', contactId: '20', providerScopeId: 'synthetic-provider', role: 'customer_admin' };
    const env = { NOFRIES_ENTRA_TENANT_ID: tenantId, NOFRIES_DEFAULT_TENANT_ID: 'synthetic-tenant',
        NOFRIES_AUTOTASK_PROVIDER_SCOPE_ID: 'synthetic-provider', NOFRIES_CUSTOMER_PORTAL_MEMBERSHIPS: JSON.stringify([member]) };
    assert.equal(resolveCustomerPortalAccess(identity, env).allowed, true);
    for (const field of ['companyId', 'contactId', 'providerScopeId']) {
        const incomplete = { ...member }; delete incomplete[field];
        assert.equal(resolveCustomerPortalAccess(identity, { ...env,
            NOFRIES_CUSTOMER_PORTAL_MEMBERSHIPS: JSON.stringify([incomplete]) }).allowed, false);
    }
    assert.equal(resolveCustomerPortalAccess(identity, { ...env,
        NOFRIES_CUSTOMER_PORTAL_MEMBERSHIPS: JSON.stringify([{ ...member, role: 'admin' }]) }).allowed, false);
    const { adapters } = admissionFixture();
    assert.equal((await createDashboardService(adapters).handleRequest(request, 'bootstrap')).status, 200);
});

test('source adapter is not installed by any production host and contains no provider runtime', () => {
    const root = path.join(__dirname, '..');
    for (const file of ['server.js', 'app-service.js', 'api/shared/customerPortalRuntime.js', 'api/shared/appLifecycleRuntime.js']) {
        assert.doesNotMatch(fs.readFileSync(path.join(root, file), 'utf8'), /require\([^\n]*(dashboardService|dashboardAdmission)/);
    }
    for (const file of ['dashboardService.js', 'dashboardAdmission.js']) {
        const source = fs.readFileSync(path.join(root, 'api/shared', file), 'utf8');
        assert.doesNotMatch(source, /require\([^\n]*(autotask|customerPortalService|RuntimeFactory|dashboardFixture)/i);
        assert.doesNotMatch(source, /process\.env/);
    }
});


// G: fixed buffered-resource decisions; no SQL/HTTP composition is simulated.
const { createDashboardBufferedService } = require('../api/shared/dashboardService');
const { DashboardAdmissionUnavailableError } = require('../api/shared/dashboardAdmission');
const SERVICE_CUTOFF = '2026-09-06T09:00:01.000Z';
function assertFrozenResource(value) {
    if (value && typeof value === 'object') {
        assert.ok(Object.isFrozen(value)); Object.values(value).forEach(assertFrozenResource);
    }
}
function bufferedUnavailable(operation) {
    return assert.rejects(operation, error => {
        assert.ok(error instanceof DashboardAdmissionUnavailableError);
        assert.equal(error.name, 'DashboardAdmissionUnavailableError');
        assert.equal(error.message, 'dashboard_unavailable'); assert.equal(error.code, 'dashboard_unavailable');
        assert.equal(error.statusCode, 503); assert.deepEqual(error.details, { code: 'dashboard_unavailable' });
        assert.ok(Object.isFrozen(error.details)); assert.equal(error.cause, undefined);
        assert.ok(!JSON.stringify(error).includes('private')); return true;
    });
}

test('HN-S01 all eleven fixed resources preserve actual legacy bytes and closed frozen responses', async () => {
    const f = admissionFixture({ service: 'managed_endpoint' });
    const legacy = createDashboardService(f.adapters), buffered = createDashboardBufferedService(f.adapters);
    assert.deepEqual(Object.keys(buffered), ['handleResource']); assert.ok(Object.isFrozen(buffered));
    const routes = ['bootstrap', 'modules/overview', 'modules/ai_governance', 'modules/cyber_security',
        'modules/it_optimisation', 'modules/improvement_plan', 'modules/evidence', 'modules/board_reports',
        'modules/services', 'app.js', 'dashboard.css'];
    for (const route of routes) {
        const result = await buffered.handleResource(request, route);
        assert.deepEqual(Object.keys(result).sort(), ['outcome', 'response']);
        assert.deepEqual(Object.keys(result.response).sort(), ['body', 'headers', 'isRaw', 'status']);
        assert.equal(result.outcome, 'succeeded'); assert.equal(result.response.status, 200);
        assert.deepEqual(result.response, await legacy.handleRequest(request, route)); assertFrozenResource(result);
        assert.equal(result.response.headers['Cache-Control'], 'private, no-store, max-age=0');
        assert.equal(result.response.isRaw, ['app.js', 'dashboard.css'].includes(route));
        if (route === 'app.js') {
            const assets = path.join(__dirname, '../api/shared/protectedAssets');
            assert.equal(result.response.body, ['dashboardRegistry.js', 'dashboardShell.js', 'ncscAssessmentClient.js', 'ncscQuestionnaire.js', 'assessmentExplanation.js', 'organisationPicture.js', 'improvementActionPlanView.js', 'improvementActionPlanClient.js']
                .map(file => fs.readFileSync(path.join(assets, file), 'utf8')).join('\n'));
            assert.equal(result.response.headers['Content-Type'], 'application/javascript; charset=utf-8');
        } else if (route === 'dashboard.css') {
            assert.equal(result.response.body, fs.readFileSync(path.join(__dirname, '../app/dashboard.css'), 'utf8'));
            assert.equal(result.response.headers['Content-Type'], 'text/css; charset=utf-8');
        } else assert.equal(result.response.headers['Content-Type'], 'application/json; charset=utf-8');
    }
});

test('HN-S02 stable module refusal is a buffer while an operational failure is unavailable', async () => {
    const f = admissionFixture({ role: 'viewer' });
    const denied = await createDashboardBufferedService(f.adapters).handleResource(request, 'modules/cyber_security');
    assert.equal(denied.outcome, 'denied'); assertFrozenResource(denied);
    assert.deepEqual(denied.response, await createDashboardService(f.adapters).handleRequest(request, 'modules/cyber_security'));
    assert.equal(denied.response.status, 403); assert.deepEqual(denied.response.body, { code: 'dashboard_access_denied' });
    const failed = admissionFixture();
    failed.adapters.loadSnapshot = () => { throw new Error('private loader detail'); };
    await bufferedUnavailable(() => createDashboardBufferedService(failed.adapters).handleResource(request, 'bootstrap'));
    assert.equal((await createDashboardService(failed.adapters).handleRequest(request, 'bootstrap')).status, 403);
});

test('HN-S03 actual asset failure after admission is unavailable and denied assets are never read', async () => {
    const f = admissionFixture(), actualRead = fs.readFileSync;
    const target = path.join(__dirname, '../api/shared/protectedAssets/dashboardShell.js');
    let selectedReads = 0;
    const spy = jest.spyOn(fs, 'readFileSync').mockImplementation(function (file, ...args) {
        if (file === target) { selectedReads += 1; throw new Error('private asset detail'); }
        return actualRead.call(this, file, ...args);
    });
    try {
        await bufferedUnavailable(() => createDashboardBufferedService(f.adapters).handleResource(request, 'app.js'));
        assert.deepEqual(f.state.calls, ['authenticate', 'resolveScope', 'loadSnapshot', 'clock']);
        assert.equal(selectedReads, 1);
        const legacy = await createDashboardService(f.adapters).handleRequest(request, 'app.js');
        assert.equal(legacy.status, 503); assert.deepEqual(legacy.body, { code: 'dashboard_unavailable' });
        assert.equal(selectedReads, 2);
        const denied = admissionFixture(); denied.state.input.entitlementState.grants = [];
        const result = await createDashboardBufferedService(denied.adapters).handleResource(request, 'app.js');
        assert.equal(result.outcome, 'denied'); assert.equal(result.response.status, 403);
        assert.equal(selectedReads, 2); assertFrozenResource(result);
    } finally { spy.mockRestore(); }
});

test('HN-S04 invalid internal routes and methods reject before adapters while legacy precedence is unchanged', async () => {
    const f = admissionFixture(), buffered = createDashboardBufferedService(f.adapters), legacy = createDashboardService(f.adapters);
    for (const [method, route, status, code] of [
        ['POST', 'bootstrap', 405, 'dashboard_method_not_allowed'],
        ['GET', 'unknown', 404, 'dashboard_route_not_found'],
        ['GET', '../app.js', 404, 'dashboard_route_not_found'],
        ['GET', 'readiness', 404, 'dashboard_route_not_found']
    ]) {
        await bufferedUnavailable(() => buffered.handleResource({ method }, route));
        const response = await legacy.handleRequest({ method }, route);
        assert.equal(response.status, status); assert.deepEqual(response.body, { code });
        assert.equal(response.headers.Allow, status === 405 ? 'GET' : undefined);
    }
    assert.deepEqual(f.state.calls, []);
});

test('HS01 actual non-null summary filters a newly expired advisor while overview remains permitted', async () => {
    const f = admissionFixture({ role: 'fractional_advisor', service: 'fractional_advisory' });
    for (const row of [...f.state.input.membershipState.memberships, ...f.state.input.membershipState.invitations]) row.roles = ['viewer', 'fractional_advisor'];
    f.state.input.advisorAssignments.cyber_security.validUntil = SERVICE_CUTOFF;
    const summary = f.state.input.summary;
    summary.attention.push({ ...summary.attention[0], module: 'overview', title: 'Retained overview attention' });
    summary.metrics.push({ ...summary.metrics[0], module: 'overview', value: 'Overview display' });
    const buffered = createDashboardBufferedService(f.adapters), legacy = createDashboardService(f.adapters);
    const before = await buffered.handleResource(request, 'bootstrap');
    assert.deepEqual(before.response, await legacy.handleRequest(request, 'bootstrap'));
    assert.equal(before.outcome, 'succeeded');
    assert.deepEqual([...new Set(before.response.body.summary.metrics.map(row => row.module))].sort(), ['cyber_security', 'overview']);
    assert.ok(before.response.body.summary.attention.some(row => row.module === 'cyber_security'));
    f.state.now = SERVICE_CUTOFF;
    const after = await buffered.handleResource(request, 'bootstrap');
    assert.deepEqual(after.response, await legacy.handleRequest(request, 'bootstrap'));
    assert.equal(after.outcome, 'succeeded'); assert.equal(after.response.status, 200); assertFrozenResource(after);
    assert.deepEqual(after.response.body.summary.metrics.map(row => row.module), ['overview']);
    assert.deepEqual(after.response.body.summary.attention.map(row => row.module), ['overview']);
    assert.equal(after.response.body.summary.metrics[0].value, 'Overview display');
    assert.ok(after.response.body.modules.some(row => row.key === 'overview'));
    assert.ok(!after.response.body.modules.some(row => row.key === 'cyber_security'));
});
