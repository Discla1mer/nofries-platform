'use strict';

// Combined review run for #505/#506/#507/#509 and the held grant migration.
module.exports = function register({ resourceSetup, harness, NCSC_SUBJECT, identity, nextId, pools, runtimeRole }) {
    const request = require('supertest');
    const { assetPath } = require('../../scripts/tests/paid-renderer-browser.cjs');
    const { createProductionApplication } = require('../../lib/productionApplication');
    const { customerProductionHarness } = require('../helpers/customerProductionHarness');
    const { ACCEPTED_PROFILE_REF } = require('../../api/shared/assessmentEngine/ncscAssessmentEvaluator');
    const { tuples } = require('../../api/shared/appLifecycle/paidFrameworkDecisions');
    const { createFrameworkAction } = require('../../api/shared/dashboardAdmin/frameworkActions');
    const { createAccountActionsRepository } = require('../../api/shared/dashboardAdmin/accountActionsRepository');
    const { accountActionsPool } = require('../../api/shared/dashboardAdmin/accountActionsPool');
    const { createPostgresDashboardAdministrationRepository } = require('../../api/shared/appLifecycle/postgresDashboardRuntimeRepository');
    const { hash } = require('../../api/shared/appLifecycle/dashboardRuntimeRecords');
    const { fixture: staffFixture } = require('../fixtures/dashboardAdminMembershipActions');

    test.each(tuples)('staff control protects saved assessments and actual assets for $profileId', async tuple => {
        const { controlPool, ownerPool } = pools();
        const [tenant, oid] = NCSC_SUBJECT.split(':');
        const principal = { ...identity(), identityTenantId: tenant, oid, issuer: 'https://login.microsoftonline.com/' + tenant + '/v2.0', audience: nextId() };
        const f = await resourceSetup({ productionIdentity: principal, initialTime: '2026-11-19T00:01:00.000Z',
            exampleOptions: { profileRefs: [ACCEPTED_PROFILE_REF] } });
        const h = customerProductionHarness({ pool: f.restrictedPool, identity: principal, instanceId: f.instanceId,
            restoreEpoch: f.state.restoreEpoch, now: Date.parse(f.state.now), applicationFactory: (env, deps) =>
                createProductionApplication({ ...env, NOFRIES_PAID_FRAMEWORKS_ENABLED: 'true', NOFRIES_DASHBOARD_NCSC_ENABLED: 'true' }, deps) });
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
        const external = staffFixture(), sf = harness();
        sf.state.now = f.state.now; await sf.initialize();
        const selected = { ...external.selector, ...f.scope }, nativeRequest = sf.operator();
        const actor = { provider: 'entra-bff', isAuthenticated: true, subjectKey: sf.operatorIdentity.identityTenantId + ':' + sf.operatorIdentity.oid };
        expect(actor.subjectKey).not.toBe(selected.subjectKey);
        Object.assign(external.record, f.scope, { expiresAt: Date.parse(f.state.now) + 86400000 });
        const pool = accountActionsPool(sf.restrictedPool);
        const native = createPostgresDashboardAdministrationRepository({ pool, ...Object.fromEntries(
            ['clock','instanceId','historyBudget','captureRequest','readExternalRuntimeEpoch','newId'].map(k => [k, sf.options[k]])),
            authoriseAdministration: async ({ capture, selector }) => capture.identityPayload.oid === sf.operatorIdentity.oid && selector.tenantId === f.scope.tenantId });
        const { readApprovedAction, ...config } = external.config;
        const action = createFrameworkAction({ ...config, clock: () => sf.state.now, async readContext() {
            const { capture } = await pool.run(() => native.validateSession(nativeRequest, selected));
            return { operatorSubjectKey: actor.subjectKey, sessionSha256: capture.sessionSha256, instanceId: capture.instanceId,
                restoreEpoch: capture.restoreEpoch, identityPolicySha256: hash(config.identityPolicy) };
        }, createRepository: (guard, allowed, context) => createAccountActionsRepository(pool, () => sf.state.now, guard, allowed, context) });
        const invocation = { request: nativeRequest, signal: new AbortController().signal };
        async function change(direction) {
            const cmd = { selector: selected, tuple, action: direction, reason: 'Synthetic owner instruction',
                confirmationEmail: external.record.email, expectedMembershipRevision: f.example.state.membershipState.revision };
            const approval = await action(actor, { ...cmd, step: 'approve' }, invocation);
            expect((await action(actor, { ...cmd, step: 'apply', operationId: approval.operationId }, invocation)).outcome).toBe('succeeded');
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
