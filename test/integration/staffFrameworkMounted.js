'use strict';

// Staff and customer HTTP sessions share the production app and a disposable native database.
module.exports = function register({ resourceSetup, NCSC_SUBJECT, identity, nextId, pools, runtimeRole }) {
    const request = require('supertest');
    const { assetPath } = require('../../scripts/tests/paid-renderer-browser.cjs');
    const { createProductionApplication } = require('../../lib/productionApplication');
    const { customerProductionHarness, uid } = require('../helpers/customerProductionHarness');
    const { ACCEPTED_PROFILE_REF } = require('../../api/shared/assessmentEngine/ncscAssessmentEvaluator');
    const { tuples } = require('../../api/shared/appLifecycle/paidFrameworkDecisions');
    test.each(tuples)('staff control protects saved assessments and actual assets for $profileId', async tuple => {
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
        async function change(action) {
            const command = { selector: { provider: 'legacy', subjectKey: user.authority.subjectKey, ...f.scope }, tuple, action,
                reason: 'Synthetic owner instruction', confirmationEmail: user.authority.email,
                expectedMembershipRevision: f.example.state.membershipState.revision };
            const submit = step => staffPost('/api/dashboard-admin/lookup').send({ frameworkAccess: { ...command, ...step } });
            const approval = await submit({ step: 'approve' }).expect(200);
            expect(approval.body).toMatchObject({ action, tuple, operationId: expect.any(String) });
            const applied = await submit({ step: 'apply', operationId: approval.body.operationId }).expect(200);
            expect(applied.body).toMatchObject({ operationId: approval.body.operationId, outcome: 'succeeded', granted: action === 'grant' });
        }
        async function snapshot() {
            const tables = ['dashboard_entitlement_states','dashboard_usage','dashboard_ncsc_assessment_revisions','dashboard_ncsc_assessments'];
            return Promise.all(tables.map(async t => (await ownerPool.query('SELECT * FROM nofries.' + t + ' WHERE tenant_id=$1 AND organisation_id=$2',
                [f.scope.tenantId, f.scope.organisationId])).rows));
        }
        const picker = async () => (await get('/api/dashboard/modules/cyber_security').expect(200)).body;
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

        await controlPool.query('GRANT nofries_framework_operator TO "' + runtimeRole + '" WITH SET TRUE, INHERIT FALSE, ADMIN FALSE');
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
            await post('/api/dashboard/selection', { operationId: nextId(), bindingId: other.publication.binding.bindingId, expectedGeneration: generation }).expect(200);
            generation = await gen();
            expect((await picker()).paidFrameworks).toEqual([]);
            for (const path of [base, detail, ...assets()]) await get(path).expect(403);
            expect(await snapshot()).toEqual(before);
        } finally { await controlPool.query('REVOKE nofries_framework_operator FROM "' + runtimeRole + '"'); }
    });
};
