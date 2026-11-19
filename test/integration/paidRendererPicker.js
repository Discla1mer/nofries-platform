'use strict';

const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const request = require('supertest');
const { createProductionApplication } = require('../../lib/productionApplication');
const { customerProductionHarness } = require('../helpers/customerProductionHarness');
const { paidFrameworks } = require('../../api/shared/protectedAssets/dashboardRegistry');
const { ACCEPTED_PROFILE_REF } = require('../../api/shared/assessmentEngine/ncscAssessmentEvaluator');
const { assetPath, checkPicker } = require('../../scripts/tests/paid-renderer-browser.cjs');

async function withLoopbackBrowser(work) {
    const directory = mkdtempSync(join(tmpdir(), 'paid-renderer-'));
    let server, browser;
    try {
        const key = join(directory, 'tls.key'), cert = join(directory, 'tls.crt');
        require('node:child_process').execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
            '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
        server = require('node:https').createServer({ key: readFileSync(key), cert: readFileSync(cert) });
        await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
        browser = await require('playwright').chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
        await work(server, 'https://127.0.0.1:' + server.address().port, browser);
    } finally {
        try { if (browser) await browser.close(); }
        finally {
            if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
            rmSync(directory, { recursive: true, force: true });
        }
    }
}

module.exports = ({ resourceSetup, NCSC_SUBJECT, nextId, identity }) => {
    async function fixture(ref, origin, enabled) {
        const [tenant, oid] = NCSC_SUBJECT.split(':');
        const principal = { ...identity(), identityTenantId: tenant, oid,
            issuer: 'https://login.microsoftonline.com/' + tenant + '/v2.0', audience: nextId() };
        const f = await resourceSetup({ productionIdentity: principal, initialTime: '2026-11-19T00:01:00.000Z',
            exampleOptions: { profileRefs: [ACCEPTED_PROFILE_REF, { profileId: ref.profileId, profileVersion: ref.version }] } });
        const h = customerProductionHarness({ pool: f.restrictedPool, identity: principal, instanceId: f.instanceId,
            restoreEpoch: f.state.restoreEpoch, now: Date.parse(f.state.now), applicationFactory: (env, deps) =>
                createProductionApplication({ ...env, NOFRIES_PUBLIC_URL: origin, NOFRIES_PAID_FRAMEWORKS_ENABLED: enabled,
                    NOFRIES_DASHBOARD_NCSC_ENABLED: 'true' }, deps) });
        h.env.NOFRIES_PUBLIC_URL = origin;
        const user = h.addUser({ ...f.scope, bindingId: f.publication.binding.bindingId });
        user.authority.accountType = 'consultant'; user.save();
        const { cookie } = await h.login(user);
        await h.consent(cookie);
        const session = await h.sameOrigin(request(h.app).post('/api/dashboard/session')).set('Cookie', cookie)
            .send({ operationId: nextId() }).expect(200);
        async function select(bindingId) {
            const current = await request(h.app).get('/api/dashboard/session').set('Cookie', cookie).expect(200);
            await h.sameOrigin(request(h.app).post('/api/dashboard/selection')).set('Cookie', cookie)
                .send({ operationId: nextId(), bindingId, expectedGeneration: current.body.generation }).expect(200);
        }
        return { f, h, cookie, select, generation: session.body.generation };
    }
    async function revokeFixtureProduct(f, ref) {
        const { createPostgresDatabase } = require('../../api/shared/database/postgres');
        const { createPostgresDashboardRepository } = require('../../api/shared/appLifecycle/postgresDashboardRepository');
        const operationId = nextId();
        const repository = createPostgresDashboardRepository({ database: createPostgresDatabase({ pool: f.seedPool }),
            clock: () => f.state.now, authoriseAdministration: cmd => cmd.tenantId === f.scope.tenantId &&
                cmd.organisationId === f.scope.organisationId && cmd.actorSubjectKey === NCSC_SUBJECT &&
                (cmd.type === 'authority.read' || (cmd.type === 'entitlement.update' && cmd.operationId === operationId)) });
        const { revisions, snapshot } = await repository.readAuthoritySnapshot(f.scope, { authenticated: true, subjectKey: NCSC_SUBJECT });
        const state = snapshot.entitlementState;
        const grants = state.grants.map(grant => grant.frameworks.some(row => row.moduleId === ref.moduleId &&
            row.profileId === ref.profileId && row.version === ref.version) ? { ...grant, status: 'revoked' } : grant);
        await repository.executeAuthorityCommand({ ...f.scope, operationId, actorSubjectKey: NCSC_SUBJECT, type: 'entitlement.update',
            expectedRevisions: revisions, payload: { ...state, grants, revision: state.revision + 1 } });
    }
    test.each(paidFrameworks)('paid renderer flag off denies a signed-in $label asset', async ref => {
        const { h, cookie, generation } = await fixture(ref, 'https://nofries.example.test', 'TRUE');
        await request(h.app).get(assetPath(ref, 'questionnaire', generation)).set('Cookie', cookie).expect(404);
    });
    // Explicit because the standalone picker base does not package the renderer/publication/runtime stack.
    if (process.env.NOFRIES_TEST_RENDERER_BROWSER === 'true') {
        test.each(paidFrameworks)('mounted paid picker: $label', async ref => {
            await withLoopbackBrowser(async (server, origin, browser) => {
                const { f, h, cookie, select } = await fixture(ref, origin, 'true');
                server.on('request', h.app);
                await checkPicker({ browser, app: h.app, origin, cookie, now: f.state.now, ref,
                    directory: process.env.NOFRIES_TEST_RENDERER_SCREENSHOTS,
                    revoke: () => revokeFixtureProduct(f, ref),
                    returnToOrganisation: () => select(f.publication.binding.bindingId),
                    switchOrganisation: async () => {
                        const other = await f.addResource({ tenantId: f.scope.tenantId + '-other', organisationId: f.scope.organisationId });
                        await select(other.publication.binding.bindingId);
                    } });
            });
        }, 120000);
    }
};
