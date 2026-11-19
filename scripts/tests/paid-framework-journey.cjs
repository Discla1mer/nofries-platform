'use strict';

// A disposable in-process application is required. The caller supplies a fresh
// signed-in fixture session and its current generation after any client switch.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const request = require('supertest');

const profiles = [
    { profileId: 'nf-nist-csf-2-0-core', version: '2026-09-08.1' },
    { profileId: 'nf-iso-27001-2022-readiness', version: '2026-11-19.1' }
];

function fixtureTransport(harness, session) {
    assert.equal(typeof harness.app, 'function', 'Supply a local application fixture');
    return async (method, path, body) => {
        let call = request(harness.app)[method](path);
        if (session) call = call.set('Cookie', session.cookie).set('X-NoFries-Dashboard-Generation', session.generation);
        if (method === 'post') call = harness.sameOrigin(call).send(body);
        return call;
    };
}

function paths(profile, id) {
    const collection = '/api/dashboard/frameworks/' + profile.profileId + '/' + profile.version + '/assessments';
    const detail = collection + '/' + id;
    return { collection, detail, save: detail + '/save', submit: detail + '/submit' };
}
function command(expectedRevision, payload) {
    return { idempotencyKey: randomUUID(), expectedRevision, payload };
}

async function checkDenied(call, profile, id, expectedStatuses) {
    const p = paths(profile, id);
    const requests = [
        ['get', p.collection], ['post', p.collection, { assessmentId: id, ...command(null, { scopePopulation: { description: 'Synthetic office' } }) }],
        ['get', p.detail], ['post', p.save, command(0, { responses: [] })], ['post', p.submit, command(0, {})]
    ];
    for (const [method, path, body] of requests) {
        const result = await call(method, path, body);
        assert.ok(expectedStatuses.includes(result.status), method + ' ' + path + ' returned ' + result.status);
        for (const key of ['publication', 'assessment', 'assessments', 'responses', 'submission']) assert.ok(!Object.hasOwn(result.body, key));
    }
}

// Use one disposable synthetic account per persona. Save a single answer,
// resume, then finish from the question IDs in the actual admitted publication.
async function checkLifecycle(call, profile) {
    const id = 'synthetic-' + randomUUID(), p = paths(profile, id);
    const collection = await call('get', p.collection);
    assert.equal(collection.status, 200, 'The mounted, entitled collection must exist');
    const publication = collection.body.publication;
    assert.equal(publication.profile.id, profile.profileId);
    assert.equal(publication.profile.version, profile.version);
    assert.ok(publication.questions.length > 1);
    const applicable = new Set(publication.responseOptions.filter(option => option.applicable).map(option => option.id));
    const answers = publication.questions.map(q => {
        const optionId = q.responseOptionIds.find(id => applicable.has(id));
        assert.ok(optionId);
        return { itemId: q.id, optionId, rationale: null };
    });
    const start = await call('post', p.collection, { assessmentId: id, ...command(null, {
        scopePopulation: { description: 'Synthetic office and cloud services.' }
    }) });
    assert.ok([200, 201].includes(start.status));
    let record = start.body.assessment;
    assert.equal(record.assessmentId, id);
    assert.equal(record.moduleId, 'cyber_security');
    assert.equal(record.status, 'created');
    assert.deepEqual(record.profileRef, {
        frameworkId: publication.framework.id, frameworkVersion: publication.framework.version,
        profileId: profile.profileId, profileVersion: profile.version,
        catalogueSha256: publication.catalogueSha256, sourceCatalogueSha256: publication.sourceCatalogueSha256
    });
    assert.deepEqual(record.responses, []);
    const saved = await call('post', p.save, command(record.revision, { responses: answers.slice(0, 1) }));
    assert.equal(saved.status, 200);
    record = saved.body.assessment;
    assert.equal(record.status, 'in-progress');
    const premature = await call('post', p.submit, command(record.revision, {}));
    assert.ok(premature.status >= 400 && premature.status < 500);
    const resume = await call('get', p.detail);
    assert.equal(resume.status, 200);
    assert.deepEqual(resume.body.assessment, record);
    assert.deepEqual(record.responses, answers.slice(0, 1));
    const complete = await call('post', p.save, command(record.revision, { responses: answers.slice(1) }));
    assert.equal(complete.status, 200);
    const submit = await call('post', p.submit, command(complete.body.assessment.revision, {}));
    assert.equal(submit.status, 200);
    record = submit.body.assessment;
    assert.equal(record.status, 'submitted');
    assert.match(record.submission.responseSetSha256, /^[0-9a-f]{64}$/);
    assert.equal(record.submission.revision, record.revision);
    assert.equal(record.responses.length, answers.length);
    const results = await call('get', p.detail);
    assert.equal(results.status, 200);
    assert.deepEqual(results.body.assessment, record);
    return id;
}

module.exports = { profiles, fixtureTransport, checkDenied, checkLifecycle };

if (require.main === module) {
    const { customerProductionHarness } = require('../../test/helpers/customerProductionHarness');
    (async () => {
        const harness = customerProductionHarness();
        const call = fixtureTransport(harness);
        for (const profile of profiles) await checkDenied(call, profile, 'synthetic-absent', [404]);
        console.log('10/10 default-off collection, start, read, save and submit requests returned 404. No signed-in or enabled journey was exercised.');
    })().catch(error => { console.error(error.message); process.exitCode = 1; });
}
