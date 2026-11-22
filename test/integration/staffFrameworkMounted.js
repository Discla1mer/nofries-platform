'use strict';

// Staff and customer HTTP sessions share the production app and a disposable native database.
module.exports = function register({ resourceSetup, NCSC_SUBJECT, identity, nextId, pools, runtimeRole }) {
    const request = require('supertest');
    const { assetPath } = require('../../scripts/tests/paid-renderer-browser.cjs');
    const { createProductionApplication } = require('../../lib/productionApplication');
    const { customerProductionHarness, uid } = require('../helpers/customerProductionHarness');
    const { ACCEPTED_PROFILE_REF } = require('../../api/shared/assessmentEngine/ncscAssessmentEvaluator');
    const { tuples } = require('../../api/shared/appLifecycle/paidFrameworkDecisions');
    const decisions = 'SELECT * FROM nofries.dashboard_paid_framework_access WHERE tenant_id=$1 AND organisation_id=$2 ORDER BY operation_id';
    const flags = 'SELECT revision, payload FROM nofries.dashboard_feature_flags WHERE tenant_id=$1 AND organisation_id=$2';
    // One customer and one staff HTTP session on the production app, for one paid tuple.
    // With a sibling, a second organisation is created in the same tenant first.
    async function mounted(tuple, { sibling = false } = {}) {
        const { controlPool, ownerPool } = pools();
        const [tenant, oid] = NCSC_SUBJECT.split(':');
        const principal = { ...identity(), identityTenantId: tenant, oid, issuer: 'https://login.microsoftonline.com/' + tenant + '/v2.0', audience: nextId() };
        const f = await resourceSetup({ productionIdentity: principal, initialTime: '2026-11-19T00:01:00.000Z',
            exampleOptions: { profileRefs: [ACCEPTED_PROFILE_REF] } });
        const staffOid = uid(99);
        const h = customerProductionHarness({ adminSubject: tenant + ':' + staffOid, pool: f.restrictedPool, identity: principal, instanceId: f.instanceId,
            restoreEpoch: f.state.restoreEpoch, now: Date.parse(f.state.now), applicationFactory: (env, deps) =>
                createProductionApplication({ ...env, NOFRIES_PAID_FRAMEWORKS_ENABLED: 'true', NOFRIES_DASHBOARD_NCSC_ENABLED: 'true',
                    NOFRIES_STAFF_CONSOLE: 'true', NOFRIES_DASHBOARD_ADMIN_ACCOUNT_LOOKUP: 'true',
                    NOFRIES_DASHBOARD_ADMIN_ACCOUNT_ACTIONS: 'true', NOFRIES_DASHBOARD_ADMIN_AUDIT_CONTAINER: 'account-action-audit',
                    NOFRIES_STARTER_AUTHORITY_CONTAINER: 'starter-authority', NOFRIES_EXTERNAL_CUSTOMER_AUTHORITY_CONTAINER: 'external-starter-authority',
                    NOFRIES_EXTERNAL_CUSTOMER_TENANT_ID: uid(101) }, deps) });
        // Same tenant record, different organisation: the same customer identity holds a membership binding for each.
        const second = sibling ? await f.addResource({ tenantId: f.scope.tenantId, organisationId: 'synthetic-sibling-organisation' }, {},
            f.example.state.tenantAggregate.tenant) : null;
        const user = h.addUser({ ...f.scope, bindingId: f.publication.binding.bindingId });
        user.authority.accountType = 'consultant'; user.save();
        const { cookie } = await h.login(user);
        await h.consent(cookie);
        await h.sameOrigin(request(h.app).post('/api/dashboard/session')).set('Cookie', cookie).send({ operationId: nextId() }).expect(200);
        const gen = async () => (await request(h.app).get('/api/dashboard/session').set('Cookie', cookie).expect(200)).body.generation;
        let generation = await gen();
        const get = path => request(h.app).get(path).set('Cookie', cookie).set('X-NoFries-Dashboard-Generation', generation);
        const post = (path, body) => h.sameOrigin(request(h.app).post(path)).set('Cookie', cookie).set('X-NoFries-Dashboard-Generation', generation).send(body);
        const base = '/api/dashboard/frameworks/' + tuple.profileId + '/' + tuple.version + '/assessments';
        const assets = () => ['collection', 'questionnaire', 'results'].map(name => assetPath(tuple, name, generation));
        h.state.oid = staffOid;
        const login = await request(h.app).get('/api/auth/login?returnTo=%2Fdashboard').expect(302);
        const callback = await request(h.app).post('/api/auth/callback').set('Cookie', login.headers['set-cookie'][0].split(';')[0])
            .type('form').send({ code: 'synthetic-code', state: new URL(login.headers.location).searchParams.get('state') }).expect(303);
        const staffCookie = callback.headers['set-cookie'].find(value => value.startsWith('__Host-nofries-auth=')).split(';')[0];
        const staffPost = path => h.sameOrigin(request(h.app).post(path)).set('Cookie', staffCookie);
        await staffPost('/api/dashboard/session').send({ operationId: nextId() }).expect(200);
        // Approve, then apply, through the mounted staff route; returns the raw apply response.
        async function attempt(action) {
            const command = { selector: { provider: 'legacy', subjectKey: user.authority.subjectKey, ...f.scope }, tuple, action,
                reason: 'Synthetic owner instruction', confirmationEmail: user.authority.email,
                expectedMembershipRevision: f.example.state.membershipState.revision };
            const submit = step => staffPost('/api/dashboard-admin/lookup').send({ frameworkAccess: { ...command, ...step } });
            const approval = await submit({ step: 'approve' }).expect(200);
            expect(approval.body).toMatchObject({ action, tuple, operationId: expect.any(String) });
            return { approval, applied: await submit({ step: 'apply', operationId: approval.body.operationId }) };
        }
        async function change(action) {
            const { approval, applied } = await attempt(action);
            expect(applied.status).toBe(200);
            expect(applied.body).toMatchObject({ operationId: approval.body.operationId, outcome: 'succeeded', granted: action === 'grant' });
        }
        async function snapshot(scope = f.scope, extra = []) {
            const tables = ['dashboard_entitlement_states','dashboard_usage','dashboard_ncsc_assessment_revisions','dashboard_ncsc_assessments', ...extra];
            return Promise.all(tables.map(async t => (await ownerPool.query('SELECT * FROM nofries.' + t + ' WHERE tenant_id=$1 AND organisation_id=$2',
                [scope.tenantId, scope.organisationId])).rows));
        }
        const picker = async () => (await get('/api/dashboard/modules/cyber_security').expect(200)).body;
        const select = async bindingId => {
            await post('/api/dashboard/selection', { operationId: nextId(), bindingId, expectedGeneration: generation }).expect(200);
            generation = await gen();
        };
        const grantRole = () => controlPool.query('GRANT nofries_framework_operator TO "' + runtimeRole + '" WITH SET TRUE, INHERIT FALSE, ADMIN FALSE');
        const revokeRole = () => controlPool.query('REVOKE nofries_framework_operator FROM "' + runtimeRole + '"');
        return { f, second, ownerPool, base, assets, get, post, select, attempt, change, snapshot, picker, grantRole, revokeRole };
    }

    test.each(tuples)('staff control protects saved assessments and actual assets for $profileId', async tuple => {
        const { f, base, assets, get, post, select, change, snapshot, picker, grantRole, revokeRole } = await mounted(tuple);
        const { createCommand, saveCommand } = require('../fixtures/ncscAssessmentFixture');
        const freeBase = '/api/dashboard/ncsc/assessments';
        const { action: createAction, ...createFree } = createCommand();
        await post(freeBase, createFree).expect(201);
        const { action: saveAction, assessmentId: freeId, ...saveFree } = saveCommand();
        await post(freeBase + '/' + freeId + '/save', saveFree).expect(200);
        const ncscRecord = (await get(freeBase + '/' + freeId).expect(200)).body;
        const before = await snapshot();
        const free = await picker();
        expect(free.paidFrameworks).toEqual([]);

        await grantRole();
        try {
            await get(base).expect(403);
            await change('grant');
            expect((await picker()).paidFrameworks).toContainEqual(tuple);
            const publication = (await get(base).expect(200)).body.publication;
            for (const path of assets()) await get(path).expect(200);
            const start = { assessmentId: 'saved-work', idempotencyKey: 'start', expectedRevision: null, payload: { scopePopulation: { description: 'Synthetic scope' } } };
            await post(base, start).expect(200);
            const question = publication.questions[0], save = { idempotencyKey: 'save', expectedRevision: 0,
                payload: { responses: [{ itemId: question.id, optionId: question.responseOptionIds[0], rationale: null }] } };
            const detail = base + '/saved-work', saved = (await post(detail + '/save', save).expect(200)).body;
            expect((await get(detail).expect(200)).body).toEqual(saved);
            await change('revoke');
            expect((await get(freeBase + '/' + freeId).expect(200)).body).toEqual(ncscRecord);
            expect((await picker()).paidFrameworks).toEqual([]);
            for (const path of [base, detail, ...assets()]) await get(path).expect(403);
            await post(base, start).expect(403); await post(detail + '/save', save).expect(403);
            await post(detail + '/submit', { idempotencyKey: 'submit', expectedRevision: 1, payload: {} }).expect(403);
            await change('grant');
            expect((await get(detail).expect(200)).body).toEqual(saved);
            const wrong = base.replace(tuple.version, 'other');
            await get(wrong).expect(404);
            const other = await f.addResource({ tenantId: f.scope.tenantId + '-other', organisationId: f.scope.organisationId });
            await select(other.publication.binding.bindingId);
            expect((await picker()).paidFrameworks).toEqual([]);
            for (const path of [base, detail, ...assets()]) await get(path).expect(403);
            expect(await snapshot()).toEqual(before);
        } finally { await revokeRole(); }
    });

    test.each(tuples)('the mounted grant route answers 503 and writes nothing before the operator role is bound, for $profileId', async tuple => {
        const { f, ownerPool, base, get, attempt, change, picker, grantRole, revokeRole } = await mounted(tuple);
        const scope = [f.scope.tenantId, f.scope.organisationId];
        const flagsBefore = (await ownerPool.query(flags, scope)).rows;
        expect(flagsBefore).toHaveLength(1);
        expect((await ownerPool.query(decisions, scope)).rows).toEqual([]);
        // The approval reads only; the apply is refused before any write while the role is unbound.
        const { applied } = await attempt('grant');
        expect(applied.status).toBe(503);
        expect(applied.body).toMatchObject({ code: 'dashboard_admin_unavailable' });
        expect((await ownerPool.query(decisions, scope)).rows).toEqual([]);
        expect((await ownerPool.query(flags, scope)).rows).toEqual(flagsBefore);
        expect((await picker()).paidFrameworks).toEqual([]);
        await get(base).expect(403);
        await grantRole();
        try {
            await change('grant');
            expect((await ownerPool.query(decisions, scope)).rows).toEqual([expect.objectContaining({ granted: true, revision: 1 })]);
            expect((await picker()).paidFrameworks).toContainEqual(tuple);
            await get(base).expect(200);
        } finally { await revokeRole(); }
    });

    test.each(tuples)('a grant on one organisation gives a same-tenant sibling organisation no paid access, for $profileId', async tuple => {
        const { f, second, base, assets, get, post, select, change, snapshot, picker, grantRole, revokeRole } = await mounted(tuple, { sibling: true });
        const sibling = second.example.scope;
        expect(sibling.tenantId).toBe(f.scope.tenantId);
        expect(sibling.organisationId).not.toBe(f.scope.organisationId);
        const tracked = ['dashboard_feature_flags', 'dashboard_paid_framework_access'];
        const siblingBefore = await snapshot(sibling, tracked);
        expect(siblingBefore.at(-1)).toEqual([]);
        await grantRole();
        try {
            await change('grant');
            expect((await picker()).paidFrameworks).toContainEqual(tuple);
            await get(base).expect(200);
            await select(second.publication.binding.bindingId);
            expect((await picker()).paidFrameworks).toEqual([]);
            for (const path of [base, base + '/saved-work', ...assets()]) await get(path).expect(403);
            await post(base, { assessmentId: 'saved-work', idempotencyKey: 'start', expectedRevision: null,
                payload: { scopePopulation: { description: 'Synthetic scope' } } }).expect(403);
            expect(await snapshot(sibling, tracked)).toEqual(siblingBefore);
            // The granted organisation keeps its access in the same session.
            await select(f.publication.binding.bindingId);
            expect((await picker()).paidFrameworks).toContainEqual(tuple);
        } finally { await revokeRole(); }
    });
};
