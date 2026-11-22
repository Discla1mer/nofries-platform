'use strict';

const request = require('supertest');
const { createProductionApplication } = require('../../lib/productionApplication');
const { customerProductionHarness } = require('../helpers/customerProductionHarness');

module.exports = ({ resourceSetup, NCSC_SUBJECT, nextId, identity, owner, atJsonResponse }) => {
    const nist = { id: 'nf-nist-csf-2-0-core', version: '2026-09-08.1', answer: 'yes', count: 106 };
    const iso = { id: 'nf-iso-27001-2022-readiness', version: '2026-11-19.1', answer: 'in_place', count: 116 };
    async function setup({ id, version }) {
        const ref = { profileId: id, profileVersion: version };
        const base = '/api/dashboard/frameworks/' + id + '/' + version + '/assessments';
        const tenant = NCSC_SUBJECT.split(':')[0], principal = { ...identity(), identityTenantId: tenant,
            oid: NCSC_SUBJECT.split(':')[1], issuer: `https://login.microsoftonline.com/${tenant}/v2.0`, audience: nextId() };
        const f = await resourceSetup({ productionIdentity: principal, exampleOptions: { profileRefs: [ref] }, initialTime: '2026-11-19T00:01:00.000Z' });
        const h = customerProductionHarness({ pool: f.restrictedPool, identity: principal, instanceId: f.instanceId,
            restoreEpoch: f.state.restoreEpoch, now: Date.parse(f.state.now),
            applicationFactory: (env, deps) => createProductionApplication({ ...env, NOFRIES_PAID_FRAMEWORKS_ENABLED: 'true' }, deps) });
        const user = h.addUser({ ...f.scope, bindingId: f.publication.binding.bindingId });
        const login = await h.login(user);
        expect((await h.consent(login.cookie)).response.status).toBe(200);
        const startSession = await h.sameOrigin(request(h.app).post('/api/dashboard/session')).set('Cookie', login.cookie).send({ operationId: nextId() });
        expect(startSession.status).toBe(200);
        const session = await request(h.app).get('/api/dashboard/session').set('Cookie', login.cookie);
        const header = 'X-NoFries-Dashboard-Generation', gen = session.body.generation;
        const get = path => request(h.app).get(path).set('Cookie', login.cookie).set(header, gen);
        const post = (path, body) => h.sameOrigin(request(h.app).post(path)).set('Cookie', login.cookie).set(header, gen).send(body);
        return { f, h, login, base, header, get, post, expiresAt: Date.parse(session.body.expiresAt) };
    }
    test.each([nist, iso])('paid assessment HTTP lifecycle and isolation for $id', async profile => {
        const { id, version, answer, count } = profile;
        const { f, h, login, base, header, get, post } = await setup(profile);
        // The source-only ISO-2 PR is independently deployable in either order.
        if (id === iso.id && !require('node:fs').existsSync(require('node:path').join(__dirname,
            '../../api/shared/assessmentEngine/iso27001FrameworkProfile.js'))) {
            await get(base).expect(404);
            await post(base, { assessmentId: 'missing', expectedRevision: null, idempotencyKey: 'start',
                payload: { scopePopulation: { description: 'Synthetic office' } } }).expect(404);
            expect((await owner().query('SELECT 1 FROM nofries.dashboard_framework_revisions WHERE tenant_id=$1', [f.scope.tenantId])).rows).toEqual([]);
            return;
        }
        const collection = await get(base).expect(200);
        expect(collection.body.assessments).toEqual([]);
        const publication = collection.body.publication;
        expect(publication.profile.id).toBe(id);
        expect(publication.questions).toHaveLength(count);
        const start = { assessmentId: 'example', expectedRevision: null, idempotencyKey: 'start', payload: { scopePopulation: { description: 'Synthetic office' } } };
        expect((await post(base, start).expect(200)).body.assessment).toMatchObject({ status: 'created', revision: 0 });
        await post(base + '/example/submit', { expectedRevision: 0, idempotencyKey: 'early', payload: {} }).expect(409);
        const excluded = publication.questions.find(q => q.responseOptionIds.includes('not_applicable')).id;
        const responses = publication.questions.map(({ id: itemId }) => ({ itemId, optionId: itemId === excluded ? 'not_applicable' : answer,
            rationale: itemId === excluded ? { text: 'Outside this synthetic scope' } : null }));
        const save = { expectedRevision: 0, idempotencyKey: 'save', payload: { responses } };
        const saved = (await post(base + '/example/save', save).expect(200)).body;
        expect(saved.assessment.responses).toEqual(expect.arrayContaining(responses.filter(row => row.rationale)));
        expect((await post(base + '/example/save', save).expect(200)).body).toEqual(saved);
        await post(base + '/example/save', { ...save, payload: { responses: responses.slice(1) } }).expect(409);
        await f.mutateFlags({ cyber_security: false });
        await get(base + '/example').expect(403);
        await post(base + '/example/save', save).expect(403);
        await f.mutateFlags({ cyber_security: true });
        expect((await get(base + '/example').expect(200)).body).toEqual(saved);
        const submit = { expectedRevision: 1, idempotencyKey: 'submit', payload: {} };
        const sealed = (await post(base + '/example/submit', submit).expect(200)).body;
        expect(sealed.assessment.submission).toEqual({ revision: 2, submittedAt: expect.any(String), responseSetSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
        expect((await get(base + '/example').expect(200)).body).toEqual(sealed);
        expect((await post(base + '/example/submit', submit).expect(200)).body).toEqual(sealed);
        await post(base + '/example/save', { ...save, expectedRevision: 2, idempotencyKey: 'sealed' }).expect(409);
        const listed = (await get(base).expect(200)).body;
        expect(listed.assessments).toEqual([{ assessmentId: 'example', status: 'submitted', revision: 2, updatedAt: f.state.now }]);
        await get(base.replace(version, 'unknown')).expect(404);
        await request(h.app).get(base).set('Cookie', login.cookie).set(header, 'a'.repeat(64)).expect(403);
        const usage = await owner().query("SELECT payload#>>'{counters,assessment_runs}' AS count FROM nofries.dashboard_usage WHERE tenant_id=$1", [f.scope.tenantId]);
        expect(usage.rows).toEqual([{ count: '1' }]);
        const operations = await owner().query("SELECT payload->>'action' AS action FROM nofries.dashboard_runtime_audit WHERE tenant_id=$1 AND event_type='dashboard.operation'", [f.scope.tenantId]);
        expect(operations.rows.filter(e => e.action === 'assessment.write')).toHaveLength(3);
        const other = await f.addResource({ tenantId: f.scope.tenantId + '-other', organisationId: f.scope.organisationId });
        const switched = await f.repository.selectBinding(f.request(f.seed), { operationId: nextId(),
            bindingId: other.publication.binding.bindingId, expectedGeneration: f.selected.record.generationToken });
        const { facade } = await f.bindResource({ generation: switched.record.generationToken, overrides: { paidFrameworksEnabled: true } });
        const route = { profileId: id, version, assessmentId: null };
        expect((await facade.paid(route, undefined, null)).assessments).toEqual([]);
        const next = await f.bindResource({ generation: switched.record.generationToken, overrides: { paidFrameworksEnabled: true } });
        await expect(next.facade.paid({ ...route, assessmentId: 'example' }, undefined, null)).rejects.toMatchObject({ code: 'framework_not_found' });
    });
    test.each(['collection', 'detail', 'save', 'save replay'])('paid %s withholds the JSON body at session expiry', async mode => {
        const { f, h, base, get, post, expiresAt } = await setup(nist);
        const publication = (await get(base).expect(200)).body.publication;
        const detail = base + '/private-example';
        const start = { assessmentId: 'private-example', expectedRevision: null, idempotencyKey: 'start',
            payload: { scopePopulation: { description: 'Synthetic private scope' } } };
        await post(base, start).expect(200);
        const save = { expectedRevision: 0, idempotencyKey: 'save', payload: {
            responses: [{ itemId: publication.questions[0].id, optionId: 'yes', rationale: null }] } };
        if (mode === 'save replay') await post(detail + '/save', save).expect(200);
        // Begin inside the actual selected session, then expire it within the request budget.
        h.state.now = expiresAt - 100;
        let sampled = false;
        atJsonResponse(() => { sampled = true; h.state.now = expiresAt; });
        try {
            const response = await (mode === 'collection' ? get(base) : mode === 'detail' ? get(detail) : post(detail + '/save', save));
            expect(sampled).toBe(true);
            expect(response.status).toBe(403);
            expect(response.body).toEqual({ code: 'framework_access_denied' });
        } finally { atJsonResponse(null); }
        const revisions = await owner().query('SELECT revision FROM nofries.dashboard_framework_revisions WHERE tenant_id=$1 AND organisation_id=$2 ORDER BY revision',
            [f.scope.tenantId, f.scope.organisationId]);
        expect(revisions.rows.map(row => row.revision)).toEqual(mode.startsWith('save') ? [0, 1] : [0]);
    });
    test.each([{ grants: undefined }, { grants: [{ profileId: nist.id, profileVersion: 'other' }] }])('paid assessment refuses an absent exact active grant (%j)', async ({ grants }) => {
        const f = await resourceSetup({ exampleOptions: { profileRefs: grants } });
        const { facade } = await f.bindResource({ overrides: { paidFrameworksEnabled: true } });
        await expect(facade.paid({ profileId: nist.id, version: nist.version, assessmentId: null }, undefined, null)).rejects.toMatchObject({ code: 'framework_access_denied' });
    });
};
