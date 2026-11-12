'use strict';

const assert = require('node:assert/strict');
const test = global.test || require('node:test');
const picture = require('../api/shared/protectedAssets/organisationPicture');
const { createClient } = require('../api/shared/protectedAssets/ncscAssessmentClient');
const { buildFixtures, createSyntheticTransport } = require('../scripts/build-ncsc-questionnaire-preview');
const { createDom } = require('./fixtures/dashboardDom');
const { ncscFixture, allResponses, createCommand, saveCommand, submitCommand, SUBJECT, NOW } = require('./fixtures/ncscAssessmentFixture');
const { makeVersion } = require('../api/shared/assessmentLifecycle/postgresNcscAssessmentStore');
const { projectNcscDetail } = require('../api/shared/ncscAssessmentService');
const clone = value => JSON.parse(JSON.stringify(value));
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };

function mixed() {
    const tenant = ncscFixture({ tenantId: 'synthetic-preview-a', organisationId: 'shared-preview-organisation' });
    const responses = allResponses().map((row, index) => ({ ...row,
        optionId: index < 3 ? 'yes' : index < 10 ? 'partial' : index < 12 ? 'no' : index === 12 ? 'unknown' : 'not_applicable',
        rationale: index === 13 ? { text: 'Synthetic pending exclusion.' } : null }));
    let version = null;
    for (const command of [createCommand('assessment-mixed', 'create-mixed', 'Synthetic office and cloud scope.'),
        saveCommand('assessment-mixed', 0, 'save-mixed', responses), submitCommand('assessment-mixed', 1, 'submit-mixed')]) {
        version = makeVersion({ ...tenant.scope, actorSubjectKey: SUBJECT, assessmentId: command.assessmentId,
            action: command.action, expectedRevision: command.expectedRevision, payload: command.payload },
        command.idempotencyKey, version, tenant.state.tenantAggregate, NOW);
    }
    return projectNcscDetail(version);
}
function setup(settings = {}) {
    const fixtures = buildFixtures(), seed = clone(fixtures.tenants[0]);
    seed.assessments = settings.records || [mixed()];
    const transport = createSyntheticTransport(seed, fixtures.metadata, fixtures);
    const client = settings.client || createClient({ metadata: fixtures.metadata, fetch: transport.fetch });
    const dom = createDom();
    const options = { metadata: fixtures.metadata, client, organisationId: seed.model.context.organisationId,
        displayName: 'Synthetic organisation A', ...settings.options };
    const controller = picture.mount(dom.root, options);
    return { ...dom, fixtures, seed, controller, options };
}
function click(dom, label) { const button = dom.root.querySelectorAll('button').find(b => b.textContent === label); assert.ok(button, label); button.click(); }
function change(control, value) { control.value = value; for (const callback of control.events.change || []) callback(); }
function followUp(dom) {
    const follow = dom.root.querySelector('.picture-follow-up');
    return { follow, filter: follow.querySelector('select'), categories: follow.children.filter(node => node.tagName === 'DETAILS') };
}
function metricReviews(dom) { return dom.root.querySelector('.picture-metrics').querySelectorAll('button'); }

test('an explanation that cannot start leaves the saved results in place', async () => {
    let isolated;
    jest.isolateModules(() => {
        jest.doMock('../api/shared/protectedAssets/assessmentExplanation', () => ({
            explain() { return { status: 'unavailable' }; },
            mount() { throw new Error('synthetic_mount_failure'); }
        }));
        isolated = require('../api/shared/protectedAssets/organisationPicture');
    });
    const fixtures = buildFixtures(), seed = clone(fixtures.tenants[0]); seed.assessments = [mixed()];
    const transport = createSyntheticTransport(seed, fixtures.metadata, fixtures), dom = createDom();
    isolated.mount(dom.root, { metadata: fixtures.metadata, organisationId: seed.model.context.organisationId,
        client: createClient({ metadata: fixtures.metadata, fetch: transport.fetch }), displayName: 'Synthetic organisation A' });
    await flush();
    assert.match(dom.root.textContent, /46\.4%–60\.7%/);
    assert.match(dom.root.querySelector('.picture-explanation').textContent, /The explanation is unavailable right now\. Your results above are unchanged\./);
    jest.dontMock('../api/shared/protectedAssets/assessmentExplanation');
});

test('connected view preserves golden server range, uncertainty and completion without an always-empty evidence measure', async () => {
    const dom = setup(); await flush();
    assert.match(dom.root.textContent, /46\.4%–60\.7%/);
    assert.match(dom.root.textContent, /85\.7%/);
    assert.match(dom.root.textContent, /12 of 14/);
    assert.match(dom.root.textContent, /7 partial and 2 absent/);
    assert.match(dom.root.textContent, /2 unknown or unresolved/);
    assert.match(dom.root.textContent, /1 answer marked not applicable, to confirm/);
    assert.match(dom.root.textContent, /not a performance score/);
    assert.doesNotMatch(dom.root.textContent, /Supporting evidence|Tested or observed coverage|evidence upload/i);
    assert.equal(dom.root.querySelectorAll('meter').length, dom.fixtures.metadata.domains.length);
    assert.match(dom.root.textContent, /Risk priority: not calculated/);
    assert.equal(dom.root.querySelectorAll('.picture-metric').length, 2);
    assert.match(dom.root.textContent, /All 14 responses are saved/);
    assert.match(dom.root.textContent, /6.5–8.5 reported or possible credits ÷ 14/);
    assert.match(dom.root.textContent, /overall result weights questions, not the five function percentages/);
    assert.match(dom.root.textContent, /Reviews are coming soon/);
    assert.equal(dom.root.querySelectorAll('.picture-domain-detail').length, 5);
});

test('saved Overview identifies source, scope, framework and revision without internal calculation digests', async () => {
    const record = mixed(), dom = setup({ records: [record] }); await flush();
    for (const value of ['Cyber baseline', 'Synthetic organisation A', record.scopePopulation.description,
        dom.fixtures.metadata.title, dom.fixtures.metadata.profileRef.profileVersion,
        'Saved revision', record.assessmentId, 'What to do next',
        'CC BY 4.0']) assert.ok(dom.root.textContent.includes(value), value);
    for (const hidden of [record.submission.evaluation.outputSha256, record.submission.responseSetSha256,
        'SHA-256', 'evaluatorSourceSha256', 'Evaluator', 'Score contract']) assert.ok(!dom.root.textContent.includes(hidden), hidden);
    assert.equal(dom.root.querySelectorAll('input').length, 0);
    assert.doesNotMatch(dom.root.textContent, /board snapshot|draft presentation|PDF export|management review/i);
    assert.ok(!dom.root.querySelectorAll('button').some(b => /board|download|export|issue/i.test(b.textContent)));
});

test('freshness copy distinguishes the saved baseline from a live organisation check', async () => {
    const record = mixed(), dom = setup({ records: [record] }); await flush();
    assert.match(dom.root.textContent, /saved assessment of the selected scope, not a live check of connected systems/);
    assert.match(dom.root.textContent, /Refresh reloads saved assessments/);
    assert.match(dom.root.textContent, /does not check whether answers still reflect the organisation today/);
    assert.doesNotMatch(dom.root.textContent, /Current substantiated coverage/);
    assert.match(dom.root.querySelector('.picture-source').textContent, /Submitted .*NZ time/);
    assert.doesNotMatch(dom.root.querySelector('.picture-source').textContent, /revision|T\d\d:/);
    assert.match(dom.root.textContent, /46\.4%–60\.7%/);
    dom.controller.destroy();
});

test('the primary saved summary is concise and exact source details remain accessible', async () => {
    const record = mixed(), dom = setup({ records: [record] }); await flush();
    const header = dom.root.querySelector('.picture-heading');
    assert.equal(header.querySelector('h2').textContent, 'Cyber baseline');
    assert.equal(header.querySelector('.dashboard-eyebrow'), null);
    assert.equal(header.textContent.includes('Synthetic organisation A'), false);
    assert.equal(dom.root.querySelector('.picture-source').textContent,
        'Submitted ' + new Intl.DateTimeFormat('en-NZ', { dateStyle: 'medium', timeStyle: 'short',
            timeZone: 'Pacific/Auckland' }).format(new Date(record.updatedAt)) + ' NZ time');
    const provenance = dom.root.querySelector('.ncsc-result-provenance');
    assert.equal(provenance.querySelector('summary').textContent, 'Source and calculation details');
    assert.equal(provenance.getAttribute('open'), null);
    for (const value of [record.assessmentId, record.updatedAt, 'Synthetic organisation A',
        dom.fixtures.metadata.title, dom.fixtures.metadata.profileRef.profileVersion]) {
        assert.ok(provenance.textContent.includes(value), value);
    }
    for (const hidden of [record.submission.evaluation.outputSha256, record.submission.responseSetSha256, 'SHA-256']) {
        assert.ok(!provenance.textContent.includes(hidden), hidden);
    }
    assert.match(provenance.textContent, /does not check whether answers still reflect the organisation today/);
    assert.match(provenance.textContent, /Scores from different scopes are not combined/);
    dom.controller.destroy();
});

test('same-day choices remain unambiguous without changing exact selected IDs or issuing writes', async () => {
    const template = buildFixtures().tenants[0].assessments[0];
    const ids = ['11111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111112',
        '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];
    const records = ids.map(assessmentId => ({ ...clone(template), assessmentId }));
    const reads = []; let writes = 0;
    const client = { list: async () => ({ assessments: records, nextAfterAssessmentId: null }),
        read: async id => { reads.push(id); return { assessment: clone(records.find(row => row.assessmentId === id)) }; },
        create: () => writes++, save: () => writes++, submit: () => writes++ };
    const dom = setup({ client }); await flush();
    const picker = dom.root.querySelector('.picture-toolbar').querySelector('select');
    const options = picker.querySelectorAll('option');
    assert.deepEqual(options.map(option => option.value), ids);
    assert.equal(new Set(options.map(option => option.textContent)).size, ids.length);
    assert.ok(options[0].textContent.endsWith(ids[0]));
    assert.ok(options[1].textContent.endsWith(ids[1]));
    assert.ok(options[2].textContent.endsWith('22222222…'));
    assert.ok(options[3].textContent.endsWith('33333333…'));
    change(picker, ids[2]); await flush();
    assert.equal(dom.root.querySelector('select').value, ids[2]);
    assert.deepEqual(reads, [ids[0], ids[2]]); assert.equal(writes, 0);
    const provenance = dom.root.querySelector('.ncsc-result-provenance');
    assert.ok(provenance.textContent.includes(ids[2]));
    assert.ok(provenance.textContent.includes(template.updatedAt));
    assert.equal(dom.root.querySelector('.picture-source').textContent.includes(ids[2]), false);
    dom.controller.destroy();
});

test('a single saved choice omits its technical ID while the draft source disclosure preserves it', async () => {
    const record = buildFixtures().tenants[0].assessments[0];
    const dom = setup({ records: [record] }); await flush();
    const option = dom.root.querySelector('.picture-toolbar').querySelector('option');
    assert.equal(option.value, record.assessmentId);
    assert.ok(option.textContent.startsWith(record.scopePopulation.description + ' · In progress · '));
    assert.ok(option.textContent.endsWith(' NZ time'));
    assert.doesNotMatch(option.textContent, /revision|T\d\d:/);
    assert.equal(dom.root.querySelector('.picture-source').textContent.includes(record.assessmentId), false);
    const provenance = dom.root.querySelector('.ncsc-result-provenance');
    for (const value of [record.assessmentId, record.updatedAt, dom.fixtures.metadata.title,
        dom.fixtures.metadata.profileRef.profileVersion, 'Synthetic organisation A']) {
        assert.ok(provenance.textContent.includes(value), value);
    }
    assert.match(dom.root.textContent, /In progress/);
    assert.match(dom.root.textContent, /Saved progress is not a score/);
    assert.equal(dom.root.querySelector('.picture-metrics'), null);
    dom.controller.destroy();
});

test('same-time assessments with different scopes have recognisable picker labels', async () => {
    const first = clone(buildFixtures().tenants[0].assessments[0]);
    first.scopePopulation.description = 'Café premises';
    const second = { ...clone(first), assessmentId: 'assessment-online',
        scopePopulation: { description: 'Online shop' } };
    const dom = setup({ records: [first, second] }); await flush();
    const choices = dom.root.querySelector('.picture-toolbar').querySelectorAll('option');
    assert.equal(choices.length, 2);
    assert.ok(choices.some(choice => choice.textContent.startsWith('Café premises · ')));
    assert.ok(choices.some(choice => choice.textContent.startsWith('Online shop · ')));
    for (const choice of choices) assert.equal(choice.textContent.includes(choice.value), false);
    dom.controller.destroy();
});

test('two follow-up categories preserve unknown/N/A and profile-ordered saved detail without an always-full evidence list', async () => {
    const record = mixed(), dom = setup({ records: [record] }); await flush();
    const follow = dom.root.querySelector('.picture-follow-up');
    const categories = follow.children.filter(node => node.tagName === 'DETAILS');
    assert.deepEqual(categories.map(node => node.querySelector('summary').textContent),
        ['Unresolved answers · 2', 'Reported implementation gaps · 9']);
    const expected = options => dom.fixtures.metadata.questions.filter(question => {
        const response = record.responses.find(response => response.itemId === question.id);
        return options.includes(response.optionId);
    }).map(question => question.id);
    const ids = category => category.querySelectorAll('article').map(node => node.getAttribute('data-question-id'));
    assert.deepEqual(ids(categories[0]), expected(['unknown', 'not_applicable']));
    assert.deepEqual(ids(categories[1]), expected(['partial', 'no']));
    assert.match(categories[0].textContent, /Not applicable answers count as not yet met until a reviewer confirms them/);
    assert.doesNotMatch(follow.textContent, /Supporting-evidence gaps|Supporting evidence:|upload/);
    assert.match(follow.textContent, /not a combined total or a risk ranking/);
    assert.ok(categories[0].querySelectorAll('article').every(article => /Saved answer:/.test(article.textContent)));
    assert.equal(follow.querySelectorAll('input').length, 0);
    assert.equal(follow.querySelectorAll('button').length, 0);
    dom.controller.destroy();
});

test('zero reported gaps are explicit and do not imply substantiated evidence or control effectiveness', async () => {
    const record = buildFixtures().tenants[0].assessments.find(record => record.status === 'submitted');
    const dom = setup({ records: [record] }); await flush();
    const follow = dom.root.querySelector('.picture-follow-up');
    const categories = follow.children.filter(node => node.tagName === 'DETAILS');
    assert.deepEqual(categories.map(node => node.querySelector('summary').textContent),
        ['Unresolved answers · 0', 'Reported implementation gaps · 0']);
    assert.match(categories[1].textContent, /does not establish control effectiveness/);
    const metrics = dom.root.querySelector('.picture-metrics').children;
    assert.equal(metrics[0].querySelector('button'), null);
    assert.equal(metrics[1].querySelector('button'), null);
    assert.match(metrics[0].textContent, /No reported implementation gaps in this saved assessment/);
    assert.match(metrics[1].textContent, /No unresolved answers in this saved assessment/);
    assert.deepEqual(metricReviews(dom).map(button => button.textContent), []);
    dom.controller.destroy();
});

test('follow-up guidance separates next actions from evidence without changing content or order', async () => {
    const record = mixed(), dom = setup({ records: [record] }); await flush();
    const follow = dom.root.querySelector('.picture-follow-up');
    const result = require('../api/shared/protectedAssets/ncscQuestionnaire')
        .resultModel(record, dom.fixtures.metadata, dom.options.organisationId);
    const questions = new Map(result.domains.flatMap(domain => domain.controls.flatMap(control =>
        control.questions.map(question => [question.itemId, question]))));
    for (const article of follow.querySelectorAll('article')) {
        const question = questions.get(article.getAttribute('data-question-id'));
        const guidance = article.querySelector('details');
        assert.equal(guidance.querySelector('summary').textContent, 'Suggested next actions and useful evidence');
        assert.deepEqual(guidance.querySelectorAll('h5').map(heading => heading.textContent),
            ['Suggested next actions', 'Useful evidence']);
        const lists = guidance.querySelectorAll('ul');
        assert.equal(lists.length, 2);
        assert.deepEqual(lists[0].querySelectorAll('li').map(item => item.textContent), question.actions);
        assert.deepEqual(lists[1].querySelectorAll('li').map(item => item.textContent), question.examples);
    }
    assert.equal(follow.querySelectorAll('button').length, 0);
    assert.equal(follow.querySelectorAll('input').length, 0);
    assert.match(follow.textContent, /Questions follow the profile order\./);
    assert.doesNotMatch(follow.textContent, /uploaded here/);
    dom.controller.destroy();
});

test('legacy Board options cannot expose another presentation mode or navigation action', async () => {
    let opened = 0;
    const dom = setup({ options: { mode: 'board', openBoard: () => opened++ } }); await flush();
    assert.match(dom.root.textContent, /Cyber baseline/);
    assert.match(dom.root.textContent, /What to do next/);
    assert.doesNotMatch(dom.root.textContent, /board snapshot|draft presentation|PDF export|management review/i);
    assert.equal(dom.root.querySelectorAll('select').length, 2);
    assert.equal(dom.root.querySelector('.picture-toolbar').querySelectorAll('select').length, 1);
    assert.equal(dom.root.querySelector('.picture-follow-up-filter').querySelectorAll('select').length, 1);
    assert.equal(dom.root.querySelector('label').textContent, 'Saved assessment');
    assert.deepEqual(dom.root.querySelectorAll('button').map(button => button.textContent),
        ['Refresh', 'Copy summary', 'Review 9 implementation gaps', 'Review 2 unresolved answers', 'Saved range', 'Unresolved answers', 'Framework starting actions', 'Explain this saved result', 'Clear saved explanation']);
    assert.equal(opened, 0);
});

test('a blank saved assessment is Not started, while a newer unfinished record does not hide the latest submission', async () => {
    const draft = clone(buildFixtures().tenants[0].assessments[0]);
    draft.assessmentId = 'assessment-newer-draft';
    draft.updatedAt = '2099-01-01T00:00:00.000Z';
    draft.status = 'created'; draft.revision = 0; draft.responses = []; draft.submission = null;
    draft.createdAt = draft.updatedAt;
    draft.progress = { total: draft.progress.total, answered: 0, missing: draft.progress.total, unknown: 0, notApplicableClaims: 0 };
    const submitted = mixed();
    const summary = row => { const copy = clone(row); delete copy.responses; delete copy.submission; return copy; };
    const submittedSummary = summary(submitted); submittedSummary.updatedAt = '2020-01-01T00:00:00.000Z';
    let source;
    const client = {
        list: async () => ({ assessments: [summary(draft), submittedSummary], nextAfterAssessmentId: null }),
        read: async id => ({ assessment: clone(id === submitted.assessmentId ? submitted : draft) })
    };
    const dom = setup({ client, options: { onSelection: (_id, kind) => { source = kind; } } });
    await flush();
    assert.equal(dom.root.querySelector('select').value, submitted.assessmentId);
    assert.equal(source, undefined);
    const blank = setup({ client: {
        list: async () => ({ assessments: [summary(draft)], nextAfterAssessmentId: null }),
        read: async () => ({ assessment: clone(draft) })
    } });
    await flush();
    assert.match(blank.root.querySelector('.picture-resume').textContent, /Not started/);
    assert.equal(blank.root.querySelector('option').textContent.includes('Not started'), true);
    const picker = dom.root.querySelector('select');
    change(picker, draft.assessmentId); await flush();
    assert.equal(source, 'user');
    assert.equal(dom.root.querySelector('select').value, draft.assessmentId);
    dom.controller.destroy(); blank.controller.destroy();
});

test('a saved draft shows progress with no submitted score', async () => {
    const record = buildFixtures().tenants[0].assessments[0];
    const dom = setup({ records: [record] }); await flush();
    assert.match(dom.root.textContent, /In progress/);
    assert.match(dom.root.textContent, /Saved progress is not a score/);
    assert.equal(dom.root.querySelectorAll('meter').length, 0);
    assert.doesNotMatch(dom.root.textContent, /Reported implementation|100\.0%/);
});

for (const [kind, record, label] of [
    ['draft', buildFixtures().tenants[0].assessments[0], 'Continue saved assessment'],
    ['submission', mixed(), 'View saved assessment']
]) test(`the selected ${kind} action carries its exact saved record, without a mutation`, async () => {
    const opened = [];
    const dom = setup({ records: [record], options: { openCyber: id => opened.push(id) } }); await flush();
    assert.deepEqual(opened, []);
    if (kind === 'draft') {
        const resume = dom.root.querySelector('.picture-resume');
        assert.ok(dom.root.children.indexOf(resume) < dom.root.children.indexOf(dom.root.querySelector('.picture-toolbar')));
        assert.equal(resume.querySelector('progress').value, record.progress.answered);
        assert.equal(resume.querySelector('progress').max, record.progress.total);
        assert.ok(resume.textContent.includes(record.scopePopulation.description));
    }
    click(dom, label);
    assert.deepEqual(opened, [record.assessmentId]);
    assert.equal(dom.root.querySelectorAll('input').length, 0);
    assert.doesNotMatch(dom.root.textContent, /Choose this assessment from/);
    dom.controller.destroy();
});

test('an old saved-record action cannot open after a refresh or destruction', async () => {
    const opened = [], record = mixed(); let release;
    const client = { list: async () => ({ assessments: [record], nextAfterAssessmentId: null }),
        read: async () => ({ assessment: record }) };
    const dom = setup({ client, options: { openCyber: id => opened.push(id) } }); await flush();
    const old = dom.root.querySelectorAll('button').find(button => button.textContent === 'View saved assessment');
    client.list = () => new Promise(done => { release = done; });
    click(dom, 'Refresh'); await flush(); old.click();
    assert.deepEqual(opened, []);
    dom.controller.destroy(); old.click();
    release({ assessments: [record], nextAfterAssessmentId: null }); await flush();
    assert.deepEqual(opened, []); assert.equal(dom.root.textContent, '');
});

test('empty organisation has an actionable baseline state and no invented zero score', async () => {
    let opened = 0; const dom = setup({ records: [], options: { openCyber: () => opened++ } }); await flush();
    assert.match(dom.root.textContent, /No saved assessments yet/); assert.doesNotMatch(dom.root.textContent, /0\.0%/);
    assert.match(dom.root.textContent, /Build your first baseline/);
    assert.equal(dom.root.querySelectorAll('.picture-first-use-step').length, 3);
    const action = dom.root.querySelector('.picture-first-use-action');
    click(dom, 'Open assessment'); assert.equal(opened, 1);
    dom.root.replaceChildren(); action.click(); assert.equal(opened, 1);
    dom.controller.destroy(); action.click(); assert.equal(opened, 1);
});

test('first-use journey waits for a successful empty list and never masks a carried selection', async () => {
    let releaseList, releaseRead;
    const list = new Promise(resolve => { releaseList = resolve; });
    const read = new Promise(resolve => { releaseRead = resolve; });
    const record = mixed();
    const dom = setup({ client: { list: () => list, read: () => read },
        options: { initialAssessmentId: record.assessmentId, openCyber: () => {} } });
    assert.equal(dom.root.querySelector('.picture-first-use'), null);
    releaseList({ assessments: [], nextAfterAssessmentId: null }); await flush();
    assert.equal(dom.root.querySelector('.picture-first-use'), null);
    releaseRead({ assessment: record }); await flush();
    assert.equal(dom.root.querySelector('.picture-first-use'), null);
    assert.ok(dom.root.querySelector('.picture-metrics'));
});

test('first-use journey is not shown when the assessment read fails or action is unavailable', async () => {
    const failed = setup({ client: { list: async () => { throw new Error('offline'); }, read: async () => {} },
        options: { openCyber: () => {} } });
    await flush();
    assert.equal(failed.root.querySelector('.picture-first-use'), null);
    assert.match(failed.root.textContent, /could not be confirmed/);
    const noAction = setup({ records: [] }); await flush();
    assert.ok(noAction.root.querySelector('.picture-first-use'));
    assert.equal(noAction.root.querySelectorAll('button').length, 0);
});

for (const mutation of [record => { record.submission.evaluation.provenance.organisationId = 'foreign'; },
    record => { record.submission.evaluation.attainment.lowerDisplay = '99.9%'; },
    record => { const coverage = record.submission.evaluation.evidence.substantiatedCoverage;
        coverage.denominator = 0; coverage.percentTenths = null; coverage.display = null; },
    record => { record.submission.evaluation.provenance.evaluatorVersion = 'unsupported'; }]) {
    test('foreign, altered or unsupported result never becomes an organisation score', async () => {
        const record = clone(mixed()); mutation(record); const dom = setup({ records: [record] }); await flush();
        assert.equal(dom.root.querySelectorAll('meter').length, 0);
        assert.doesNotMatch(dom.root.textContent, /46\.4%|99\.9%/);
        assert.match(dom.root.textContent, /unavailable|could not be confirmed/);
        assert.equal(dom.root.querySelector('.picture-follow-up'), null);
    });
}

test('pagination is explicit and does not label the loaded subset as the latest organisation result', async () => {
    const fixtures = buildFixtures(); const dom = setup({ records: fixtures.tenants[0].assessments }); await flush();
    assert.match(dom.root.textContent, /not a complete organisation history/);
    assert.equal(dom.root.querySelector('.picture-toolbar').querySelectorAll('option').length, 2);
    click(dom, 'Load more'); await flush();
    assert.equal(dom.root.querySelector('.picture-toolbar').querySelectorAll('option').length, 3);
    assert.doesNotMatch(dom.root.textContent, /not a complete organisation history/);
});

test('Overview reloads the chosen baseline even when it is outside the first list page', async () => {
    const fixtures = buildFixtures(); let selected;
    const dom = setup({ records: fixtures.tenants[0].assessments,
        options: { initialAssessmentId: 'assessment-submitted', onSelection: id => { selected = id; } } });
    await flush();
    assert.match(dom.root.textContent, /Reported implementation/);
    assert.match(dom.root.textContent, /100\.0%/);
    assert.equal(selected, 'assessment-submitted');
    assert.equal(dom.root.querySelector('select').value, 'assessment-submitted');
    assert.match(dom.root.textContent, /not a complete organisation history/);
});

test('a carried selection is not authority and cannot restore a revoked assessment', async () => {
    const record = mixed(); let reads = 0;
    const client = { list: async () => ({ assessments: [], nextAfterAssessmentId: null }),
        read: async id => { reads++; assert.equal(id, record.assessmentId); throw { statusCode: 403 }; } };
    const dom = setup({ client, options: { initialAssessmentId: record.assessmentId } }); await flush();
    assert.equal(reads, 1); assert.match(dom.root.textContent, /unavailable/);
    assert.doesNotMatch(dom.root.textContent, /46\.4%|assessment-mixed/);
});

test('destroy aborts both list and detail reads and ignores late results', async () => {
    for (const phase of ['list', 'read']) {
        const record = mixed(); let resolve, signal;
        const summary = clone(record); delete summary.responses; delete summary.submission; delete summary.scopePopulation;
        const client = {
            list(input) { if (phase === 'list') { signal = input.signal; return new Promise(done => { resolve = done; }); }
                return Promise.resolve({ assessments: [summary], nextAfterAssessmentId: null }); },
            read(_id, settings) { signal = settings.signal; return new Promise(done => { resolve = done; }); }
        };
        const dom = setup({ client }); await flush(); dom.controller.destroy();
        assert.equal(signal.aborted, true);
        resolve(phase === 'list' ? { assessments: [summary], nextAfterAssessmentId: null } : { assessment: record }); await flush();
        assert.equal(dom.root.textContent, '');
    }
});

test('revoked access clears results and record names; retry does not disclose cached figures', async () => {
    const record = mixed(); let denied = false;
    const client = { list: async () => ({ assessments: [record], nextAfterAssessmentId: null }),
        read: async () => { if (denied) throw { statusCode: 403 }; return { assessment: record }; } };
    const dom = setup({ client }); await flush(); assert.match(dom.root.textContent, /46\.4%/);
    denied = true; click(dom, 'Refresh'); await flush();
    assert.doesNotMatch(dom.root.textContent, /46\.4%|assessment-mixed|Synthetic office/);
    assert.match(dom.root.textContent, /unavailable/);
    assert.equal(dom.root.querySelectorAll('button').length, 0);
});

test('scope text is rendered as text and leaving a destroyed picture is inert', async () => {
    const record = clone(buildFixtures().tenants[0].assessments[0]);
    record.scopePopulation.description = '<img src=x onerror=alert(1)> Synthetic scope';
    const dom = setup({ records: [record] }); await flush();
    assert.ok(dom.root.textContent.includes(record.scopePopulation.description));
    assert.equal(dom.root.querySelectorAll('img').length, 0);
    let left = 0; assert.equal(await dom.controller.requestLeave(() => left++), true); assert.equal(left, 1);
    dom.controller.destroy(); assert.equal(await dom.controller.requestLeave(() => left++), false); assert.equal(left, 1);
});


test('changing saved assessment by keyboard restores selection focus after the fresh read', async () => {
    const fixtures = buildFixtures(), dom = setup({ records: fixtures.tenants[0].assessments }); await flush();
    const picker = dom.root.querySelector('select'); picker.focus(); picker.value = 'assessment-b';
    for (const callback of picker.events.change || []) callback();
    await flush();
    assert.equal(dom.document.activeElement, dom.root.querySelector('select'));
    assert.equal(dom.document.activeElement.value, 'assessment-b');
    assert.match(dom.root.textContent, /responses saved/);
});


test('refresh preserves a selected assessment outside the refreshed first page', async () => {
    const fixtures = buildFixtures(), dom = setup({ records: fixtures.tenants[0].assessments }); await flush();
    click(dom, 'Load more'); await flush();
    const picker = dom.root.querySelector('select'); picker.value = 'assessment-submitted';
    for (const callback of picker.events.change || []) callback();
    await flush(); assert.match(dom.root.textContent, /100\.0%/);
    click(dom, 'Refresh'); await flush();
    assert.equal(dom.root.querySelector('select').value, 'assessment-submitted');
    assert.match(dom.root.textContent, /100\.0%/);
    assert.match(dom.root.textContent, /not a complete organisation history/);
});


test('refresh and exhausted pagination preserve a useful keyboard focus target', async () => {
    const fixtures = buildFixtures(), dom = setup({ records: fixtures.tenants[0].assessments }); await flush();
    let control = dom.root.querySelectorAll('button').find(value => value.textContent === 'Refresh');
    control.focus(); control.click(); await flush();
    assert.equal(dom.document.activeElement.textContent, 'Refresh');
    control = dom.root.querySelectorAll('button').find(value => value.textContent === 'Load more');
    control.focus(); control.click(); await flush();
    assert.equal(dom.document.activeElement, dom.root.querySelector('select'));
});

test('retry restores focus to a surviving control after successful recovery', async () => {
    const record = mixed(); let failed = true;
    const client = { list: async () => ({ assessments: [record], nextAfterAssessmentId: null }),
        read: async () => { if (failed) throw { statusCode: 503 }; return { assessment: record }; } };
    const dom = setup({ client }); await flush();
    const retry = dom.root.querySelectorAll('button').find(value => value.textContent === 'Retry');
    retry.focus(); failed = false; retry.click(); await flush();
    assert.equal(dom.document.activeElement, dom.root.querySelector('select'));
    assert.match(dom.root.textContent, /46\.4%/);
});

for (const append of [false, true]) test(`Retry repeats a failed ${append ? 'next page' : 'refresh'} request before showing results`, async () => {
    const record = mixed(), next = clone(record); next.assessmentId = 'assessment-next';
    const requests = []; let fail = false, recovered = false, reads = 0;
    const client = {
        list: async input => {
            requests.push(input.afterAssessmentId);
            if (fail) throw { statusCode: 503 };
            return { assessments: recovered ? (append ? [next] : [record, next]) : [record],
                nextAfterAssessmentId: recovered ? null : record.assessmentId };
        },
        read: async () => { reads++; return { assessment: record }; }
    };
    const dom = setup({ client }); await flush();
    fail = true; click(dom, append ? 'Load more' : 'Refresh'); await flush();
    assert.equal(dom.root.querySelector('.picture-metrics'), null);
    assert.equal(reads, 1);
    const retry = dom.root.querySelectorAll('button').find(button => button.textContent === 'Retry');
    retry.focus(); fail = false; recovered = true; retry.click(); await flush();
    assert.deepEqual(requests, [null, append ? record.assessmentId : null, append ? record.assessmentId : null]);
    assert.equal(reads, 2);
    assert.equal(dom.root.querySelector('.picture-toolbar').querySelectorAll('option').length, 2);
    assert.equal(dom.root.querySelector('select').value, record.assessmentId);
    assert.equal(dom.document.activeElement, dom.root.querySelector('select'));
    assert.ok(!dom.root.querySelectorAll('button').some(button => ['Retry', 'Load more'].includes(button.textContent)));
    assert.match(dom.root.textContent, /46\.4%–60\.7%/);
    dom.controller.destroy();
});

test('Retry repeats an initial list failure even with a carried assessment selection', async () => {
    const record = mixed(); let fail = true, lists = 0, reads = 0;
    const client = {
        list: async () => { lists++; if (fail) throw { statusCode: 503 };
            return { assessments: [record], nextAfterAssessmentId: null }; },
        read: async () => { reads++; return { assessment: record }; }
    };
    const dom = setup({ client, options: { initialAssessmentId: record.assessmentId } }); await flush();
    assert.equal(reads, 0); fail = false; click(dom, 'Retry'); await flush();
    assert.equal(lists, 2); assert.equal(reads, 1);
    assert.match(dom.root.textContent, /46\.4%–60\.7%/);
    dom.controller.destroy();
});

test('a denied list retry clears saved results and remains inert after destruction', async () => {
    const record = mixed(); let fail = false, denied = false, lists = 0, reads = 0;
    const client = {
        list: async () => { lists++; if (fail) throw { statusCode: denied ? 403 : 503 };
            return { assessments: [record], nextAfterAssessmentId: null }; },
        read: async () => { reads++; return { assessment: record }; }
    };
    const dom = setup({ client }); await flush();
    fail = true; click(dom, 'Refresh'); await flush();
    const retry = dom.root.querySelectorAll('button').find(button => button.textContent === 'Retry');
    denied = true; retry.click(); await flush();
    assert.equal(lists, 3); assert.equal(reads, 1);
    assert.doesNotMatch(dom.root.textContent, /46\.4%|assessment-mixed|Synthetic office/);
    assert.equal(dom.root.querySelectorAll('button').length, 0);
    dom.controller.destroy(); retry.click(); await flush();
    assert.equal(lists, 3); assert.equal(reads, 1); assert.equal(dom.root.textContent, '');
});

test('follow-up domain filtering preserves saved scores, profile order and keyboard focus without reads or writes', async () => {
    const record = mixed(), saved = clone(record); let lists = 0, reads = 0, writes = 0;
    const client = { list: async () => { lists++; return { assessments: [record], nextAfterAssessmentId: null }; },
        read: async () => { reads++; return { assessment: record }; },
        save: async () => { writes++; }, submit: async () => { writes++; }, create: async () => { writes++; } };
    const dom = setup({ client }); await flush();
    const { follow, filter, categories } = followUp(dom);
    const label = follow.querySelector('label');
    assert.equal(label.textContent, 'Filter follow-up by NCSC function'); assert.equal(label.htmlFor, filter.id);
    assert.ok(filter.getAttribute('aria-describedby'));
    assert.equal(filter.value, '');
    assert.deepEqual(filter.querySelectorAll('option').map(option => [option.value, option.textContent]),
        [['', 'All functions'], ...dom.fixtures.metadata.domains.map(domain => [domain.id, domain.title])]);
    assert.match(follow.textContent, /Assessment scores and totals stay unchanged/);
    const status = follow.querySelector('.picture-follow-up-status');
    assert.equal(status.getAttribute('role'), 'status'); assert.equal(status.getAttribute('aria-live'), 'polite');
    const metrics = dom.root.querySelector('.picture-metrics'), metricText = metrics.textContent;
    const meters = dom.root.querySelectorAll('meter').map(meter => [meter.value, meter.getAttribute('aria-valuetext')]);
    const originalSummaries = categories.map(category => category.querySelector('summary').textContent);
    const originals = categories.map(category => category.querySelectorAll('article'));
    const controls = new Map(dom.fixtures.metadata.controls.map(control => [control.id, control.domainId]));
    const questionDomains = new Map(dom.fixtures.metadata.questions.map(question => [question.id, controls.get(question.controlId)]));
    categories.forEach(category => { category.open = true; });
    originals[1][0].querySelector('details').open = true;
    filter.focus();
    for (const domain of dom.fixtures.metadata.domains) {
        change(filter, domain.id);
        assert.equal(dom.document.activeElement, filter); assert.equal(follow.querySelector('select'), filter);
        categories.forEach((category, index) => {
            const articles = category.querySelectorAll('article');
            assert.deepEqual(articles, originals[index]); assert.equal(category.open, true);
            const ids = articles.filter(article => !article.hidden).map(article => article.getAttribute('data-question-id'));
            assert.deepEqual(ids, originals[index].map(article => article.getAttribute('data-question-id')).filter(id => questionDomains.get(id) === domain.id));
            assert.equal(category.querySelector('summary').textContent, originalSummaries[index].split(' · ')[0] + ' · ' + ids.length + ' of ' + articles.length + ' shown');
        });
        assert.ok(status.textContent.includes(domain.title));
        assert.equal(dom.root.querySelector('.picture-metrics'), metrics); assert.equal(metrics.textContent, metricText);
        assert.deepEqual(dom.root.querySelectorAll('meter').map(meter => [meter.value, meter.getAttribute('aria-valuetext')]), meters);
    }
    change(filter, '');
    assert.deepEqual(categories.map(category => category.querySelector('summary').textContent), originalSummaries);
    assert.ok(follow.querySelectorAll('article').every(article => !article.hidden));
    assert.equal(originals[1][0].querySelector('details').open, true);
    assert.equal(status.textContent, 'Showing all functions.');
    assert.equal(lists, 1); assert.equal(reads, 1); assert.equal(writes, 0); assert.deepEqual(record, saved);
    dom.controller.destroy();
});

test('domain categories explicitly show no matches without presenting empty lists as no assessment gaps', async () => {
    const dom = setup(); await flush();
    const { follow, filter, categories } = followUp(dom);
    change(filter, 'guide-govern');
    assert.equal(categories[0].querySelector('summary').textContent, 'Unresolved answers · 0 of 2 shown');
    assert.equal(categories[1].querySelector('summary').textContent, 'Reported implementation gaps · 0 of 9 shown');
    assert.equal(categories.length, 2);
    for (const category of categories) {
        const empty = category.querySelector('.picture-follow-up-empty');
        assert.equal(empty.hidden, false); assert.match(empty.textContent, /No follow-up items in this function for this category/);
    }
    assert.match(dom.root.querySelector('.picture-metrics').textContent, /2 unknown or unresolved/);
    const before = follow.textContent, visibility = follow.querySelectorAll('article').map(article => article.hidden);
    change(filter, 'unrecognised-domain');
    assert.equal(follow.textContent, before); assert.deepEqual(follow.querySelectorAll('article').map(article => article.hidden), visibility);
    change(filter, '');
    assert.ok(categories.every(category => category.querySelector('.picture-follow-up-empty').hidden));
    dom.controller.destroy();
});

test('a filter resets after refresh and its replaced callbacks cannot change old or current lists', async () => {
    const record = mixed(); let release;
    const client = { list: async () => ({ assessments: [record], nextAfterAssessmentId: null }), read: async () => ({ assessment: record }) };
    const dom = setup({ client }); await flush();
    const { follow, filter } = followUp(dom); change(filter, 'guide-govern');
    const before = follow.textContent, visibility = follow.querySelectorAll('article').map(article => article.hidden);
    client.list = () => new Promise(done => { release = done; });
    click(dom, 'Refresh');
    change(filter, 'prevent-protect');
    assert.equal(dom.root.querySelector('.picture-follow-up'), null);
    assert.equal(follow.textContent, before); assert.deepEqual(follow.querySelectorAll('article').map(article => article.hidden), visibility);
    release({ assessments: [record], nextAfterAssessmentId: null }); await flush();
    const current = followUp(dom); assert.notEqual(current.filter, filter); assert.equal(current.filter.value, '');
    assert.ok(current.follow.querySelectorAll('article').every(article => !article.hidden));
    const currentText = current.follow.textContent;
    change(filter, 'respond-recover');
    assert.equal(follow.textContent, before); assert.equal(current.follow.textContent, currentText);
    dom.controller.destroy();
});

test('switching saved assessments discards the domain filter and ignores old filter events', async () => {
    const record = mixed(), other = buildFixtures().tenants[0].assessments.find(item => item.status === 'submitted');
    let reads = 0;
    const client = { list: async () => ({ assessments: [record, other], nextAfterAssessmentId: null }),
        read: async id => { reads++; return { assessment: id === record.assessmentId ? record : other }; } };
    const dom = setup({ client, options: { initialAssessmentId: record.assessmentId } }); await flush();
    const old = followUp(dom); change(old.filter, 'guide-govern'); const oldText = old.follow.textContent;
    change(dom.root.querySelector('.picture-toolbar').querySelector('select'), other.assessmentId); await flush();
    const current = followUp(dom); assert.equal(current.filter.value, '');
    assert.match(dom.root.querySelector('.picture-metrics').textContent, /100\.0%/);
    const currentText = current.follow.textContent;
    change(old.filter, 'prevent-protect');
    assert.equal(old.follow.textContent, oldText); assert.equal(current.follow.textContent, currentText); assert.equal(reads, 2);
    dom.controller.destroy();
});

for (const stop of ['denial', 'destroy']) test(`old domain-filter callbacks cannot restore saved data after ${stop}`, async () => {
    const record = mixed(); let denied = false, reads = 0;
    const client = { list: async () => ({ assessments: [record], nextAfterAssessmentId: null }),
        read: async () => { reads++; if (denied) throw { statusCode: 403 }; return { assessment: record }; } };
    const dom = setup({ client }); await flush();
    const old = followUp(dom); change(old.filter, 'guide-govern'); const oldText = old.follow.textContent;
    if (stop === 'denial') { denied = true; click(dom, 'Refresh'); await flush(); } else dom.controller.destroy();
    const currentText = dom.root.textContent, count = reads;
    change(old.filter, 'prevent-protect');
    assert.equal(old.follow.textContent, oldText); assert.equal(dom.root.textContent, currentText); assert.equal(reads, count);
    assert.equal(dom.root.querySelector('.picture-follow-up'), null);
    assert.doesNotMatch(dom.root.textContent, /assessment-mixed|Synthetic office|46\.4%/);
    dom.controller.destroy();
});

for (const target of ['control', 'toolbar', 'follow-up']) test(`a detached ${target} cannot apply domain changes to remaining lists`, async () => {
    const dom = setup(); await flush(); const { follow, filter } = followUp(dom);
    change(filter, 'guide-govern');
    const summaries = follow.querySelectorAll('.ncsc-result-domain').map(category => category.querySelector('summary').textContent);
    const visibility = follow.querySelectorAll('article').map(article => article.hidden);
    if (target === 'control') filter.remove(); else if (target === 'toolbar') filter.parentElement.remove(); else follow.remove();
    change(filter, 'prevent-protect');
    assert.deepEqual(follow.querySelectorAll('.ncsc-result-domain').map(category => category.querySelector('summary').textContent), summaries);
    assert.deepEqual(follow.querySelectorAll('article').map(article => article.hidden), visibility);
    dom.controller.destroy();
});

test('metric review actions reveal all matching items and focus the correct native category without changing saved totals', async () => {
    const record = mixed(); let reads = 0, lists = 0, writes = 0;
    const client = { list: async () => { lists++; return { assessments: [record], nextAfterAssessmentId: null }; },
        read: async () => { reads++; return { assessment: record }; },
        create: () => writes++, save: () => writes++, submit: () => writes++ };
    const dom = setup({ client }); await flush();
    const { follow, filter, categories } = followUp(dom);
    const metricText = dom.root.querySelector('.picture-metrics').textContent;
    const questionIds = categories.map(category => category.querySelectorAll('article').map(article => article.getAttribute('data-question-id')));
    const actions = metricReviews(dom);
    assert.deepEqual(actions.map(control => control.textContent),
        ['Review 9 implementation gaps', 'Review 2 unresolved answers']);
    let changeEvents = 0; filter.addEventListener('change', () => changeEvents++);
    for (const [index, categoryIndex] of [[0, 1], [1, 0]]) {
        const control = actions[index], category = categories[categoryIndex];
        assert.equal(control.parentElement.querySelector('h3').textContent,
            ['Reported implementation', 'Answers confirmed'][index]);
        assert.equal(control.tagName, 'BUTTON'); assert.equal(control.type, 'button');
        assert.equal(control.classList.contains('dashboard-button-secondary'), true);
        assert.equal(control.getAttribute('aria-controls'), category.id);
        change(filter, 'guide-govern'); categories.forEach(item => { item.open = false; });
        const eventsBefore = changeEvents;
        assert.ok(follow.querySelectorAll('article').some(article => article.hidden));
        control.focus(); control.click();
        assert.deepEqual(categories.map(item => item.open), categories.map((_, i) => i === categoryIndex));
        assert.equal(dom.document.activeElement, category.querySelector('summary'));
        assert.equal(filter.value, ''); assert.equal(changeEvents, eventsBefore);
        assert.equal(follow.querySelector('.picture-follow-up-status').textContent, 'Showing all functions.');
        assert.deepEqual(categories.map(item => item.querySelectorAll('article').filter(article => !article.hidden)
            .map(article => article.getAttribute('data-question-id'))), questionIds);
        assert.ok(categories.every(item => item.querySelector('.picture-follow-up-empty').hidden));
        assert.deepEqual(categories.map(item => item.querySelector('summary').textContent),
            ['Unresolved answers · 2', 'Reported implementation gaps · 9']);
        assert.equal(dom.root.querySelector('.picture-metrics').textContent, metricText);
    }
    assert.equal(lists, 1); assert.equal(reads, 1); assert.equal(writes, 0); dom.controller.destroy();
});

for (const target of ['control', 'category', 'filter', 'toolbar', 'follow-up']) test(`detached metric-review ${target} cannot reset filters or move focus`, async () => {
    const dom = setup(); await flush(); const { follow, filter, categories } = followUp(dom);
    const reviews = metricReviews(dom); change(filter, 'guide-govern');
    const text = follow.textContent, visibility = follow.querySelectorAll('article').map(article => article.hidden);
    const elsewhere = dom.document.createElement('button'); elsewhere.focus();
    if (target === 'control') reviews.forEach(control => control.remove());
    else if (target === 'category') categories.forEach(category => category.remove());
    else if (target === 'filter') filter.remove();
    else if (target === 'toolbar') filter.parentElement.remove();
    else follow.remove();
    reviews.forEach(control => control.click());
    assert.equal(filter.value, 'guide-govern'); assert.equal(dom.document.activeElement, elsewhere);
    assert.ok(categories.every(category => !category.open));
    if (target !== 'category' && target !== 'toolbar' && target !== 'filter') assert.equal(follow.textContent, text);
    assert.deepEqual(categories.flatMap(category => category.querySelectorAll('article').map(article => article.hidden)), visibility);
    dom.controller.destroy();
});

for (const transition of ['refresh', 'selection', 'remount']) test(`old metric-review controls rebound after ${transition} cannot act on either saved result`, async () => {
    const first = mixed(), second = buildFixtures().tenants[0].assessments.find(record => record.status === 'submitted');
    let reads = 0, lists = 0;
    const client = { list: async () => { lists++; return { assessments: [first, second], nextAfterAssessmentId: null }; },
        read: async assessmentId => { reads++; return { assessment: assessmentId === first.assessmentId ? first : second }; } };
    const dom = setup({ client, options: { initialAssessmentId: first.assessmentId } }); await flush();
    const old = followUp(dom), oldMetrics = dom.root.querySelector('.picture-metrics'), reviews = metricReviews(dom);
    change(old.filter, 'guide-govern'); const oldText = old.follow.textContent;
    if (transition === 'refresh') click(dom, 'Refresh');
    else if (transition === 'selection') change(dom.root.querySelector('.picture-toolbar').querySelector('select'), second.assessmentId);
    else dom.controller = picture.mount(dom.root, { ...dom.options, initialAssessmentId: second.assessmentId });
    await flush();
    const current = followUp(dom), currentText = current.follow.textContent;
    // Reattaching old controls and their targets must not defeat epoch/source binding.
    dom.root.append(oldMetrics, old.follow);
    const elsewhere = dom.document.createElement('button'); elsewhere.focus();
    const requests = [lists, reads]; reviews.forEach(control => control.click());
    assert.equal(old.filter.value, 'guide-govern'); assert.equal(old.follow.textContent, oldText);
    assert.equal(current.filter.value, ''); assert.equal(current.follow.textContent, currentText);
    assert.ok([...old.categories, ...current.categories].every(category => !category.open));
    assert.equal(dom.document.activeElement, elsewhere); assert.deepEqual([lists, reads], requests);
    dom.controller.destroy();
});

function expectedImprovementSelection(record) {
    return { assessmentId: record.assessmentId, revision: record.revision, revisionSha256: record.revisionSha256,
        profileRef: clone(record.profileRef), outputSha256: record.submission.evaluation.outputSha256 };
}
function planButton(dom) {
    return dom.root.querySelectorAll('button').find(button => button.textContent === 'Plan improvements for this assessment');
}

test('the optional planning action carries only the exact freshly validated selected submission binding', async () => {
    const first = mixed(), second = buildFixtures().tenants[0].assessments.find(record => record.status === 'submitted');
    const opened = []; let reads = 0;
    const client = { list: async () => ({ assessments: [first, second], nextAfterAssessmentId: null }),
        read: async id => { reads++; return { assessment: id === first.assessmentId ? first : second }; } };
    const dom = setup({ client, options: { initialAssessmentId: first.assessmentId, openImprovement: value => opened.push(value) } });
    await flush(); assert.deepEqual(opened, []);
    const old = planButton(dom); assert.ok(old); assert.equal(old.type, 'button'); old.focus(); old.click();
    assert.deepEqual(opened, [expectedImprovementSelection(first)]);
    assert.deepEqual(Object.keys(opened[0]).sort(), ['assessmentId', 'outputSha256', 'profileRef', 'revision', 'revisionSha256']);
    assert.equal(Object.isFrozen(opened[0]), true); assert.equal(Object.isFrozen(opened[0].profileRef), true);
    assert.notEqual(opened[0].profileRef, first.profileRef);
    change(dom.root.querySelector('.picture-toolbar').querySelector('select'), second.assessmentId); await flush();
    old.click(); assert.equal(opened.length, 1);
    planButton(dom).click(); assert.deepEqual(opened[1], expectedImprovementSelection(second));
    assert.equal(reads, 2); dom.controller.destroy();
});

test('planning stays absent without the host callback and cannot be enabled by later option mutation', async () => {
    const dom = setup(); await flush(); assert.equal(planButton(dom), undefined);
    let opened = 0; dom.options.openImprovement = () => opened++;
    click(dom, 'Refresh'); await flush(); assert.equal(planButton(dom), undefined); assert.equal(opened, 0);
    assert.ok(dom.root.querySelectorAll('button').some(button => button.textContent === 'Review 2 unresolved answers'));
    dom.controller.destroy();
});

test('draft, unavailable results and incomplete revision bindings do not expose a planning callback', async () => {
    const draft = buildFixtures().tenants[0].assessments[0];
    const altered = clone(mixed()); altered.submission.evaluation.provenance.organisationId = 'foreign';
    const incomplete = clone(mixed()); delete incomplete.revisionSha256;
    for (const record of [draft, altered, incomplete]) {
        const opened = [], client = { list: async () => ({ assessments: [record], nextAfterAssessmentId: null }),
            read: async () => ({ assessment: record }) };
        const dom = setup({ client, options: { openImprovement: value => opened.push(value) } }); await flush();
        assert.equal(planButton(dom), undefined); assert.deepEqual(opened, []); dom.controller.destroy();
    }
});

test('refresh and destruction retire saved-result actions before any late response can restore them', async () => {
    const record = mixed(), opened = []; let release;
    const client = { list: async () => ({ assessments: [record], nextAfterAssessmentId: null }),
        read: async () => ({ assessment: record }) };
    const dom = setup({ client, options: { openImprovement: value => opened.push(value) } }); await flush();
    const oldPlan = planButton(dom), oldReviews = metricReviews(dom), oldCategories = followUp(dom).categories;
    client.list = () => new Promise(done => { release = done; });
    click(dom, 'Refresh'); oldPlan.click(); oldReviews.forEach(control => control.click());
    assert.deepEqual(opened, []); assert.ok(oldCategories.every(category => !category.open));
    dom.controller.destroy(); oldPlan.click(); oldReviews.forEach(control => control.click());
    release({ assessments: [record], nextAfterAssessmentId: null }); await flush();
    assert.deepEqual(opened, []); assert.equal(dom.root.textContent, ''); assert.ok(oldCategories.every(category => !category.open));
});

test('a late unselected submission cannot replace the current planning source or revive its old controls', async () => {
    const first = mixed(), second = buildFixtures().tenants[0].assessments.find(record => record.status === 'submitted');
    const opened = []; let release;
    const client = { list: async () => ({ assessments: [first, second], nextAfterAssessmentId: null }),
        read: id => id === first.assessmentId ? new Promise(done => { release = done; }) : Promise.resolve({ assessment: second }) };
    const dom = setup({ client, options: { initialAssessmentId: first.assessmentId, openImprovement: value => opened.push(value) } });
    await flush(); assert.equal(planButton(dom), undefined);
    change(dom.root.querySelector('.picture-toolbar').querySelector('select'), second.assessmentId); await flush();
    const current = planButton(dom); assert.ok(current);
    release({ assessment: first }); await flush();
    assert.equal(planButton(dom), current); assert.deepEqual(opened, []);
    current.click(); assert.deepEqual(opened, [expectedImprovementSelection(second)]); dom.controller.destroy();
});

test('denial and detached result controls cannot open a plan or change follow-up categories', async () => {
    for (const stop of ['denial', 'detached']) {
        const record = mixed(), opened = []; let denied = false;
        const client = { list: async () => ({ assessments: [record], nextAfterAssessmentId: null }),
            read: async () => { if (denied) throw { statusCode: 403 }; return { assessment: record }; } };
        const dom = setup({ client, options: { openImprovement: value => opened.push(value) } }); await flush();
        const oldPlan = planButton(dom), oldReviews = metricReviews(dom), categories = followUp(dom).categories;
        if (stop === 'denial') { denied = true; click(dom, 'Refresh'); await flush(); }
        else { oldPlan.remove(); oldReviews.forEach(control => control.remove()); }
        oldPlan.click(); oldReviews.forEach(control => control.click());
        assert.deepEqual(opened, []); assert.ok(categories.every(category => !category.open));
        if (stop === 'denial') assert.match(dom.root.textContent, /unavailable/);
        dom.controller.destroy();
    }
});

// Change over time: submitted results of the same profile, compared on request.
function submittedAt(assessmentId, at, responses, scope = 'Synthetic office and cloud scope.') {
    const tenant = ncscFixture({ tenantId: 'synthetic-preview-a', organisationId: 'shared-preview-organisation' });
    let version = null;
    for (const command of [createCommand(assessmentId, 'create-' + assessmentId, scope),
        saveCommand(assessmentId, 0, 'save-' + assessmentId, responses), submitCommand(assessmentId, 1, 'submit-' + assessmentId)]) {
        version = makeVersion({ ...tenant.scope, actorSubjectKey: SUBJECT, assessmentId, action: command.action,
            expectedRevision: command.expectedRevision, payload: command.payload },
        command.idempotencyKey, version, tenant.state.tenantAggregate, at);
    }
    return projectNcscDetail(version);
}
function mixedResponses() {
    return allResponses().map((row, index) => ({ ...row,
        optionId: index < 3 ? 'yes' : index < 10 ? 'partial' : index < 12 ? 'no' : index === 12 ? 'unknown' : 'not_applicable',
        rationale: index === 13 ? { text: 'Synthetic pending exclusion.' } : null }));
}
function trendClient(records, settings = {}) {
    const reads = []; let writes = 0;
    const summary = row => { const value = clone(row); delete value.responses; delete value.submission; return value; };
    const client = { list: async () => ({ assessments: records.map(summary), nextAfterAssessmentId: settings.after || null }),
        read: async id => { reads.push(id); if (settings.fail && settings.fail(id)) throw settings.fail(id);
            return { assessment: clone(records.find(row => row.assessmentId === id)) }; },
        create: () => writes++, save: () => writes++, submit: () => writes++ };
    return { client, reads, writes: () => writes };
}
const trendSection = dom => dom.root.querySelector('.picture-trend');
const trendRows = dom => trendSection(dom).querySelector('tbody').querySelectorAll('tr')
    .map(row => row.children.map(cell => cell.textContent));

test('a single submitted assessment explains that there is nothing to compare yet and makes no extra reads', async () => {
    const only = submittedAt('assessment-only', '2026-09-10T00:00:00.000Z', mixedResponses());
    const draft = clone(buildFixtures().tenants[0].assessments[0]);
    const { client, reads } = trendClient([only, draft]);
    const dom = setup({ client, options: { initialAssessmentId: only.assessmentId } }); await flush();
    const section = trendSection(dom);
    assert.equal(section.querySelector('h3').textContent, 'Change over time');
    assert.match(section.textContent, /This is the only submitted assessment so far\. Submit another assessment later/);
    assert.equal(section.querySelectorAll('button').length, 0);
    assert.equal(section.querySelector('table'), null);
    assert.deepEqual(reads, [only.assessmentId]);
    assert.match(dom.root.textContent, /Change over time compares submitted answers only; it is not a risk trend/);
    dom.controller.destroy();
});

test('comparing with the previous submitted assessment shows overall and per-function change without writes', async () => {
    const earlier = submittedAt('assessment-earlier', '2026-09-10T00:00:00.000Z', mixedResponses());
    const later = submittedAt('assessment-later', '2026-10-10T00:00:00.000Z', allResponses('yes'));
    const draft = clone(buildFixtures().tenants[0].assessments[0]);
    const before = clone([earlier, later]);
    const { client, reads, writes } = trendClient([earlier, later, draft]);
    const dom = setup({ client, options: { initialAssessmentId: later.assessmentId } }); await flush();
    let section = trendSection(dom);
    assert.match(section.textContent, /There is 1 other submitted assessment\. Compare results to see what has changed\./);
    assert.deepEqual(reads, [later.assessmentId]);
    const compare = section.querySelectorAll('button').find(button => button.textContent === 'Compare with previous assessment');
    compare.focus(); compare.click(); await flush();
    assert.deepEqual(reads, [later.assessmentId, earlier.assessmentId]);
    section = trendSection(dom);
    assert.match(section.textContent, /Compared with the previous assessment, submitted 10 Sept 2026/);
    assert.equal(section.querySelector('.ncsc-warning'), null);
    const rows = trendRows(dom);
    assert.deepEqual(rows[0], ['Overall', '46.4%–60.7%', '100.0%', 'Up 53.6 points']);
    assert.equal(rows.length, 1 + dom.fixtures.metadata.domains.length);
    assert.deepEqual(rows.slice(1).map(row => row[0]), dom.fixtures.metadata.domains.map(domain => domain.title));
    assert.ok(rows.slice(1).every(row => row[2] === '100.0%' && /^(Up \d+\.\d points?|No change)$/.test(row[3])));
    assert.match(section.textContent, /compares the lower figure in each range: what was reported as in place/);
    const history = section.querySelector('.picture-trend-history').querySelectorAll('li');
    assert.equal(history.length, 2);
    assert.match(history[0].textContent, /100\.0% reported implementation .*\(shown above\)/);
    assert.equal(history[0].getAttribute('aria-current'), 'true');
    assert.match(history[1].textContent, /46\.4%–60\.7% reported implementation/);
    // The replaced Compare button hands focus to the section heading.
    assert.ok(dom.document.activeElement === section.querySelector('h3'));
    // The main saved result is unchanged by the comparison.
    assert.match(dom.root.querySelector('.picture-metrics').textContent, /100\.0%/);
    assert.equal(writes(), 0); assert.deepEqual([earlier, later], before);
    dom.controller.destroy();
});

function pendingTrend() {
    const earlier = submittedAt('assessment-earlier', '2026-09-10T00:00:00.000Z', mixedResponses());
    const later = submittedAt('assessment-later', '2026-10-10T00:00:00.000Z', allResponses('yes'));
    const { client } = trendClient([earlier, later]);
    const base = client.read; let release;
    client.read = (id, settings) => id === earlier.assessmentId
        ? new Promise(done => { release = () => done(base(id, settings)); }) : base(id, settings);
    const dom = setup({ client, options: { initialAssessmentId: later.assessmentId } });
    return { dom, release: () => release() };
}

test('completing a comparison does not pull focus back after the user moved to another dashboard control', async () => {
    const { dom, release } = pendingTrend(); await flush();
    const compare = trendSection(dom).querySelectorAll('button').find(button => button.textContent === 'Compare with previous assessment');
    compare.focus(); compare.click(); await flush();
    const elsewhere = dom.document.createElement('button'); elsewhere.focus();
    release(); await flush();
    assert.ok(trendSection(dom).querySelector('table'));
    assert.ok(dom.document.activeElement === elsewhere);
    dom.controller.destroy();
});

test('completing a comparison moves focus from the removed Compare button to the trend heading', async () => {
    const { dom, release } = pendingTrend(); await flush();
    const compare = trendSection(dom).querySelectorAll('button').find(button => button.textContent === 'Compare with previous assessment');
    compare.focus(); compare.click(); await flush();
    release(); await flush();
    assert.ok(trendSection(dom).querySelector('table'));
    assert.ok(dom.document.activeElement === trendSection(dom).querySelector('h3'));
    dom.controller.destroy();
});

test('a decline is shown as down, the earliest record has no previous result and a changed scope is flagged', async () => {
    const earlier = submittedAt('assessment-earlier', '2026-09-10T00:00:00.000Z', allResponses('yes'), 'Head office only.');
    const later = submittedAt('assessment-later', '2026-10-10T00:00:00.000Z', mixedResponses());
    const { client, reads } = trendClient([earlier, later]);
    const dom = setup({ client, options: { initialAssessmentId: later.assessmentId } }); await flush();
    click(dom, 'Compare with previous assessment'); await flush();
    assert.deepEqual(trendRows(dom)[0], ['Overall', '100.0%', '46.4%–60.7%', 'Down 53.6 points']);
    assert.match(trendSection(dom).querySelector('.ncsc-warning').textContent, /describe their scope differently/);
    change(dom.root.querySelector('.picture-toolbar').querySelector('select'), earlier.assessmentId); await flush();
    assert.equal(reads.length, 3);
    assert.equal(trendSection(dom).querySelectorAll('button').map(button => button.textContent).join(), 'Compare with later assessments');
    click(dom, 'Compare with later assessments'); await flush();
    assert.equal(reads.length, 4);
    assert.match(trendSection(dom).textContent, /earliest submitted assessment shown, so there is nothing earlier to compare/);
    assert.equal(trendSection(dom).querySelector('table'), null);
    assert.equal(trendSection(dom).querySelectorAll('li').length, 2);
    dom.controller.destroy();
});

test('identical results show no change and the history is bounded to five submitted assessments', async () => {
    const records = Array.from({ length: 7 }, (_, index) => submittedAt('assessment-' + index,
        new Date(Date.parse(NOW) + (index + 1) * 86400000).toISOString(), allResponses('yes')));
    const { client, reads } = trendClient(records);
    const dom = setup({ client, options: { initialAssessmentId: 'assessment-6' } }); await flush();
    assert.match(trendSection(dom).textContent, /There are 4 other submitted assessments/);
    click(dom, 'Compare with previous assessment'); await flush();
    assert.equal(reads.length, 5);
    assert.ok(trendRows(dom).every(row => row[3] === 'No change'));
    assert.equal(trendSection(dom).querySelector('.picture-trend-history').querySelectorAll('li').length, 5);
    assert.match(trendSection(dom).textContent, /Showing 5 of 7 loaded submitted assessments, newest first\./);
    dom.controller.destroy();
});

test('a failed earlier read leaves the selected result intact, and a denied read clears the picture', async () => {
    const earlier = submittedAt('assessment-earlier', '2026-09-10T00:00:00.000Z', mixedResponses());
    const later = submittedAt('assessment-later', '2026-10-10T00:00:00.000Z', allResponses('yes'));
    let status = 503;
    const { client } = trendClient([earlier, later], { fail: id => id === earlier.assessmentId ? { statusCode: status } : null });
    const dom = setup({ client, options: { initialAssessmentId: later.assessmentId } }); await flush();
    click(dom, 'Compare with previous assessment'); await flush();
    assert.match(trendSection(dom).textContent, /Earlier results could not be loaded, so no change is shown/);
    assert.match(dom.root.querySelector('.picture-metrics').textContent, /100\.0%/);
    status = 403; click(dom, 'Refresh'); await flush();
    click(dom, 'Compare with previous assessment'); await flush();
    assert.match(dom.root.textContent, /This organisation picture is unavailable/);
    assert.equal(dom.root.querySelector('.picture-trend'), null);
    assert.doesNotMatch(dom.root.textContent, /100\.0%|46\.4%/);
    dom.controller.destroy();
});

test('a denied earlier read clears the picture even when another read fails first', async () => {
    const oldest = submittedAt('assessment-oldest', '2026-09-08T00:00:00.000Z', allResponses('yes'));
    const earlier = submittedAt('assessment-earlier', '2026-09-10T00:00:00.000Z', mixedResponses());
    const later = submittedAt('assessment-later', '2026-10-10T00:00:00.000Z', allResponses('yes'));
    let releaseDenial;
    const denial = new Promise(resolve => { releaseDenial = resolve; });
    const { client, reads } = trendClient([oldest, earlier, later]);
    const base = client.read;
    client.read = async (id, options) => {
        if (id === earlier.assessmentId) { reads.push(id); throw { statusCode: 503 }; }
        if (id === oldest.assessmentId) { reads.push(id); await denial; throw { statusCode: 403 }; }
        return base(id, options);
    };
    const dom = setup({ client, options: { initialAssessmentId: later.assessmentId } }); await flush();
    click(dom, 'Compare with previous assessment'); await flush();
    assert.deepEqual(reads.slice().sort(), [earlier.assessmentId, later.assessmentId, oldest.assessmentId].sort());
    releaseDenial(); await flush();
    assert.match(dom.root.textContent, /This organisation picture is unavailable/);
    assert.equal(dom.root.querySelector('.picture-trend'), null);
    assert.equal(dom.root.querySelector('.picture-metrics'), null);
    assert.doesNotMatch(dom.root.textContent, /100\.0%|46\.4%|Earlier results could not be loaded/);
    dom.controller.destroy();
});

test('a stale Compare button cannot start reads after the selection changes', async () => {
    const earlier = submittedAt('assessment-earlier', '2026-09-10T00:00:00.000Z', mixedResponses());
    const later = submittedAt('assessment-later', '2026-10-10T00:00:00.000Z', allResponses('yes'));
    const { client, reads } = trendClient([earlier, later]);
    const dom = setup({ client, options: { initialAssessmentId: later.assessmentId } }); await flush();
    const stale = dom.root.querySelectorAll('button').find(button => button.textContent === 'Compare with previous assessment');
    change(dom.root.querySelector('.picture-toolbar').querySelector('select'), earlier.assessmentId); await flush();
    const count = reads.length; stale.click(); await flush();
    assert.equal(reads.length, count);
    assert.equal(trendSection(dom).querySelector('table'), null);
    dom.controller.destroy();
    const late = dom.root.textContent; stale.click(); await flush();
    assert.equal(reads.length, count); assert.equal(dom.root.textContent, late);
});

test('with assessments still unloaded, the comparison is labelled as against the most recent earlier loaded assessment', async () => {
    // The list pages by assessment ID, not by submission time. The first page
    // holds November and September; October sits on an unloaded later page.
    const november = submittedAt('assessment-a', '2026-11-10T00:00:00.000Z', mixedResponses());
    const september = submittedAt('assessment-b', '2026-09-10T00:00:00.000Z', allResponses('no'));
    const october = submittedAt('assessment-c', '2026-10-10T00:00:00.000Z', allResponses('yes'));
    const all = [november, september, october], reads = [];
    const summary = row => { const value = clone(row); delete value.responses; delete value.submission; return value; };
    const client = {
        list: async input => input.afterAssessmentId === null
            ? { assessments: [november, september].map(summary), nextAfterAssessmentId: september.assessmentId }
            : { assessments: [october].map(summary), nextAfterAssessmentId: null },
        read: async id => { reads.push(id); return { assessment: clone(all.find(row => row.assessmentId === id)) }; }
    };
    const dom = setup({ client, options: { initialAssessmentId: november.assessmentId } }); await flush();
    assert.deepEqual(trendSection(dom).querySelectorAll('button').map(button => button.textContent), ['Compare with an earlier assessment']);
    click(dom, 'Compare with an earlier assessment'); await flush();
    let section = trendSection(dom);
    // Chronological among loaded rows: September is the nearest earlier loaded result.
    assert.deepEqual(trendRows(dom)[0], ['Overall', '0.0%', '46.4%–60.7%', 'Up 46.4 points']);
    assert.match(section.textContent, /Compared with the most recent earlier assessment loaded so far, submitted 10 Sept 2026, [^.]+\. Other saved assessments are not loaded yet, so there may be one in between\. Load more to check\./);
    assert.doesNotMatch(section.textContent, /the previous assessment|Previous/);
    assert.equal(section.querySelector('caption').textContent, 'Reported implementation, earlier and now');
    assert.doesNotMatch(section.textContent, /older ones/);
    assert.match(section.textContent, /Other saved assessments are not loaded yet and may be from any date\. Load more to include them\./);
    // Once every page is loaded, October is the true previous submission.
    click(dom, 'Load more'); await flush();
    click(dom, 'Compare with previous assessment'); await flush();
    section = trendSection(dom);
    assert.deepEqual(trendRows(dom)[0], ['Overall', '100.0%', '46.4%–60.7%', 'Down 53.6 points']);
    assert.match(section.textContent, /Compared with the previous assessment, submitted 10 Oct 2026, [^.]+\./);
    assert.deepEqual(section.querySelector('.picture-trend-history').querySelectorAll('li')
        .map(item => item.textContent.slice(0, 11)), ['10 Nov 2026', '10 Oct 2026', '10 Sept 202']);
    dom.controller.destroy();
});

test('the Overview states plan submission usage in plain English, and a contact path once it is used up', async () => {
    const record = mixed(), summary = clone(record);
    delete summary.responses; delete summary.submission;
    for (const [allowance, expected, exhausted] of [[{ used: 3, limit: 5 }, '3 of 5 assessment submissions used on your plan.', false],
        [{ used: 5, limit: 5 }, '5 of 5 assessment submissions used on your plan.', true]]) {
        const client = { list: async () => ({ assessments: [summary], nextAfterAssessmentId: null, submissionAllowance: allowance }),
            read: async () => ({ assessment: clone(record) }) };
        const dom = setup({ client }); await flush();
        const usage = dom.root.querySelector('.picture-allowance');
        assert.ok(usage); assert.ok(usage.textContent.startsWith(expected));
        const link = usage.querySelector('a');
        assert.equal(!!link, exhausted);
        if (exhausted) { assert.equal(link.href, '/contact.html'); assert.match(usage.textContent, /cannot submit another assessment/); }
        assert.doesNotMatch(usage.textContent, /\$|NZD|price|upgrade/i);
        dom.controller.destroy();
    }
    const dom = setup(); await flush();
    assert.equal(dom.root.querySelector('.picture-allowance'), null);
});

test('the Overview loads through the real client when the plan includes no assessment submissions', async () => {
    const fixtures = buildFixtures(), seed = clone(fixtures.tenants[0]);
    seed.assessments = [mixed()];
    const transport = createSyntheticTransport(seed, fixtures.metadata, fixtures);
    // The server reports a zero-capacity product grant as { used: 0, limit: 0 } on the list.
    const fetch = async (url, init) => {
        const response = await transport.fetch(url, init), text = await response.text(), body = JSON.parse(text);
        const patched = Object.hasOwn(body, 'nextAfterAssessmentId') ? JSON.stringify({ ...body, submissionAllowance: { used: 0, limit: 0 } }) : text;
        return { ...response, text: async () => patched };
    };
    const dom = setup({ client: createClient({ metadata: fixtures.metadata, fetch }) }); await flush();
    assert.doesNotMatch(dom.root.textContent, /unavailable/i);
    assert.ok(dom.root.querySelector('select'));
    const usage = dom.root.querySelector('.picture-allowance');
    assert.ok(usage);
    assert.equal(usage.textContent, 'Your plan does not include assessment submissions. ' +
        'You can still read your saved assessments. Contact No Fries about more submissions');
    assert.equal(usage.querySelector('a').href, '/contact.html');
    dom.controller.destroy();
});

function submittedWith(optionFor) {
    const tenant = ncscFixture({ tenantId: 'synthetic-preview-a', organisationId: 'shared-preview-organisation' });
    const responses = allResponses().map((row, index) => {
        const optionId = optionFor(index);
        return { ...row, optionId, rationale: optionId === 'not_applicable' ? { text: 'Synthetic exclusion.' } : null };
    });
    let version = null;
    for (const command of [createCommand('assessment-gaps', 'create-gaps', 'Synthetic office scope.'),
        saveCommand('assessment-gaps', 0, 'save-gaps', responses), submitCommand('assessment-gaps', 1, 'submit-gaps')]) {
        version = makeVersion({ ...tenant.scope, actorSubjectKey: SUBJECT, assessmentId: command.assessmentId,
            action: command.action, expectedRevision: command.expectedRevision, payload: command.payload },
        command.idempotencyKey, version, tenant.state.tenantAggregate, NOW);
    }
    return projectNcscDetail(version);
}
function gapView(dom) {
    const section = dom.root.querySelector('.picture-top-gaps');
    return { section, heading: section.querySelector('h3').textContent,
        items: section.querySelectorAll('li').map(item => ({ id: item.dataset.gapItem, title: item.querySelector('h4').textContent, text: item.textContent })) };
}

test('top three gaps put not-in-place answers first, then partial, in profile order, above the metrics', async () => {
    const dom = setup(); await flush();
    const { section, heading, items } = gapView(dom), questions = dom.fixtures.metadata.questions;
    assert.equal(heading, 'Your top three gaps');
    assert.deepEqual(items.map(item => item.id), [questions[10].id, questions[11].id, questions[3].id]);
    assert.deepEqual(items.map(item => item.title), ['Provide and use a password manager', 'Sensitive-request verification check', 'Secure Configuration of Software']);
    items.forEach((item, index) => {
        const question = questions[[10, 11, 3][index]];
        assert.ok(item.text.includes('Why it matters:') && item.text.includes(question.guidance.summary));
        assert.ok(item.text.includes('What to do next:') && item.text.includes(question.smallBusiness.meaning));
        assert.match(item.text, /You can start this with your team\.|Ask your IT provider to help with this\./);
    });
    assert.match(items[0].text, /Your answer: No/);
    assert.match(items[2].text, /Your answer: Partial/);
    const panel = dom.root.querySelector('.organisation-picture') || dom.root;
    const order = panel.querySelectorAll('section').map(node => node.className);
    assert.ok(order.indexOf('picture-top-gaps') < order.indexOf('picture-metric picture-primary'));
    assert.equal(section.getAttribute('aria-labelledby'), section.querySelector('h3').id);
    // The print-only copy of the shared provider summary carries the results
    // view's own disclaimer ("not a risk ranking or certification"), so check
    // that text exactly and the rest of the section for any such claim.
    const printed = section.querySelector('.picture-summary-print');
    assert.match(printed.textContent, /\nSelf-reported gaps; not a risk ranking or certification\.\n/);
    assert.equal(printed.textContent.match(/certif|complian/gi).length, 1);
    assert.doesNotMatch(section.textContent.replace(printed.textContent, ''), /certif|complian/i);
});

test('top gaps show fewer than three when that is all there is', async () => {
    const dom = setup({ records: [submittedWith(index => index === 5 ? 'partial' : index === 8 ? 'no' : 'yes')] }); await flush();
    const { heading, items } = gapView(dom), questions = dom.fixtures.metadata.questions;
    assert.equal(heading, 'Your top gaps');
    assert.deepEqual(items.map(item => item.id), [questions[8].id, questions[5].id]);
});

test('top gaps say so plainly when there are none, and point to unknown answers', async () => {
    const dom = setup({ records: [submittedWith(index => index === 2 ? 'unknown' : index === 4 ? 'not_applicable' : 'yes')] }); await flush();
    const { section, heading, items } = gapView(dom);
    assert.equal(heading, 'Your top gaps'); assert.equal(items.length, 0);
    assert.match(section.textContent, /You did not report any controls as not in place or partly in place\./);
    assert.match(section.textContent, /2 answers are still unknown or to confirm\. Confirm them to check for gaps\./);
});

test('top gap selection uses existing weights before answer and profile order, with careful fallbacks', () => {
    const metadata = { controls: [{ id: 'c1', title: 'First' }, { id: 'c2', title: 'Second' }],
        questions: [{ id: 'q1', controlId: 'c1', guidance: {} }, { id: 'q2', controlId: 'c2', guidance: { startingActions: ['Start here.'] } },
            { id: 'q3', controlId: 'c2', prompt: 'Third prompt', guidance: {} }] };
    const row = (itemId, responseOptionId, weight) => ({ itemId, responseOptionId, weight, answer: responseOptionId });
    const result = { domains: [{ controls: [{ questions: [row('q1', 'no', 1), row('q2', 'partial', 2), row('q3', 'yes', 3)] }] }] };
    const gaps = picture.topGaps(result, metadata);
    assert.deepEqual(gaps.map(gap => gap.itemId), ['q2', 'q1']);
    assert.equal(gaps[0].next, 'Start here.');
    assert.equal(gaps[1].why, 'This control helps lower the chance or impact of a cyber incident for your business.');
    assert.equal(gaps[1].next, 'Agree who will look at this control and when you will check it again.');
    assert.deepEqual(picture.topGaps(null, metadata), []);
    assert.deepEqual(picture.topGaps(result, metadata, 1).map(gap => gap.itemId), ['q2']);
});

function summarySource() {
    const fixtures = buildFixtures();
    return { questionnaire: require('../api/shared/protectedAssets/ncscQuestionnaire'), record: mixed(), metadata: fixtures.metadata };
}
describe('next step under the top gaps', () => {
    const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    async function withEnquiry(fetch) {
        const fixtures = buildFixtures(), seed = clone(fixtures.tenants[0]); seed.assessments = [mixed()];
        const transport = createSyntheticTransport(seed, fixtures.metadata, fixtures), dom = createDom();
        if (fetch !== undefined) { dom.window.fetch = fetch; dom.window.AbortController = AbortController; }
        const controller = picture.mount(dom.root, { metadata: fixtures.metadata, organisationId: seed.model.context.organisationId,
            client: createClient({ metadata: fixtures.metadata, fetch: transport.fetch }), displayName: 'Synthetic organisation A' });
        await flush();
        const panel = dom.root.querySelector('.picture-top-gaps').querySelector('.picture-next-steps');
        return { dom, controller, panel, help: panel.querySelector('.picture-next-steps-help'), link: panel.querySelector('a') };
    }
    test('shows a fixed contact link when enquiries are available', async () => {
        const fetch = jest.fn(async () => reply(200, { available: true, promote: false }));
        const { panel, help, link, controller } = await withEnquiry(fetch);
        assert.equal(panel.hidden, false); assert.equal(help.hidden, false);
        assert.equal(link.textContent, 'Get help closing these gaps');
        assert.equal(link.href, '/contact.html');
        assert.doesNotMatch(panel.textContent, /Synthetic organisation A|46\.4%|assessment-mixed/);
        controller.destroy();
    });
    test('reads availability with a bare same-origin GET and sends nothing about the assessment', async () => {
        const fetch = jest.fn(async () => reply(200, { available: true }));
        const { controller } = await withEnquiry(fetch);
        assert.equal(fetch.mock.calls.length, 1);
        const [url, init] = fetch.mock.calls[0];
        assert.equal(url, '/api/enquiry');
        assert.equal(init.method, 'GET'); assert.equal(init.body, undefined);
        assert.equal(init.credentials, 'same-origin'); assert.equal(init.cache, 'no-store');
        assert.equal(JSON.stringify(init.headers), JSON.stringify({ Accept: 'application/json' }));
        assert.ok(init.signal);
        controller.destroy();
    });
    test.each([
        ['unavailable', async () => reply(200, { available: false, promote: false })],
        ['not OK', async () => reply(503, { available: true })],
        ['an error', async () => { throw new Error('synthetic'); }],
        ['missing', undefined]
    ])('hides the help link when the enquiry status is %s', async (_name, fetch) => {
        const { panel, help, controller } = await withEnquiry(fetch);
        assert.equal(help.hidden, true);
        assert.equal(panel.hidden, false);
        assert.equal(panel.querySelector('summary').textContent, 'Copy or print this summary');
        controller.destroy();
    });
    test('hides the help link and aborts when the status read takes longer than 5 seconds', async () => {
        let signal;
        const fetch = jest.fn((_url, init) => { signal = init.signal; return new Promise(() => {}); });
        jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
        try {
            const { help, controller } = await withEnquiry(fetch);
            await jest.advanceTimersByTimeAsync(4999);
            assert.equal(signal.aborted, false);
            await jest.advanceTimersByTimeAsync(1); await flush();
            assert.equal(signal.aborted, true); assert.equal(help.hidden, true);
            controller.destroy();
        } finally { jest.useRealTimers(); }
    });
    test('offers Copy or print this summary with the same text as the results view', async () => {
        const fetch = jest.fn(async () => reply(200, { available: false }));
        const { dom, panel, controller } = await withEnquiry(fetch);
        const handoff = panel.querySelector('details');
        assert.equal(handoff.className, 'picture-summary');
        assert.equal(handoff.querySelector('summary').textContent, 'Copy or print this summary');
        const input = handoff.querySelector('textarea'), label = handoff.querySelector('label');
        assert.equal(label.htmlFor, input.id); assert.equal(input.readOnly, true);
        const { questionnaire, record, metadata } = summarySource();
        assert.equal(input.value, questionnaire.providerSummary(record, metadata).text);
        assert.match(input.value, /^Cyber security assessment\nScope: Synthetic office and cloud scope\./);
        assert.doesNotMatch(input.value, /Synthetic organisation A|shared-preview-organisation|46\.4%/);
        assert.equal(handoff.querySelectorAll('a').length, 0);
        // The scrolling field is swapped for the full text on paper, so every follow-up prints.
        const printed = handoff.querySelector('pre');
        assert.equal(printed.className, 'picture-summary-print'); assert.equal(printed.textContent, input.value);
        assert.equal(printed.getAttribute('aria-hidden'), 'true');
        const css = require('node:fs').readFileSync(require('node:path').join(__dirname, '../app/dashboard.css'), 'utf8');
        assert.match(css, /\.picture-summary-print \{ display: none;[^}]*white-space: pre-wrap;/);
        assert.match(css, /@media print \{ \.picture-summary textarea \{ display: none; \} \.picture-summary-print \{ display: block; \} \}/);
        assert.equal(dom.window.print, undefined);
        assert.deepEqual(handoff.querySelectorAll('button').map(button => button.textContent), ['Copy summary']);
        controller.destroy();
    });
    test('copies with the shared clipboard behaviour, falls back to selecting, prints, and calls no new endpoint', async () => {
        const writeText = jest.fn(async () => undefined), print = jest.fn();
        const fixtures = buildFixtures(), seed = clone(fixtures.tenants[0]); seed.assessments = [mixed()];
        const transport = createSyntheticTransport(seed, fixtures.metadata, fixtures), dom = createDom();
        const fetch = jest.fn(async () => reply(200, { available: true }));
        Object.assign(dom.window, { fetch, AbortController, print, navigator: { clipboard: { writeText } } });
        const controller = picture.mount(dom.root, { metadata: fixtures.metadata, organisationId: seed.model.context.organisationId,
            client: createClient({ metadata: fixtures.metadata, fetch: transport.fetch }), displayName: 'Synthetic organisation A' });
        await flush();
        const handoff = dom.root.querySelector('.picture-next-steps').querySelector('details');
        const input = handoff.querySelector('textarea'), status = handoff.querySelector('[role="status"]');
        const press = label => handoff.querySelectorAll('button').find(button => button.textContent === label).click();
        assert.deepEqual(handoff.querySelectorAll('button').map(button => button.textContent), ['Copy summary', 'Print these results']);
        press('Copy summary'); await flush();
        expect(writeText).toHaveBeenCalledWith(input.value); assert.equal(status.textContent, 'Summary copied.');
        writeText.mockRejectedValueOnce(new Error('denied'));
        press('Copy summary'); await flush();
        assert.equal(status.textContent, 'Summary selected. Press Ctrl+C or Cmd+C to copy it.');
        assert.equal(dom.document.activeElement, input);
        press('Print these results'); assert.equal(print.mock.calls.length, 1);
        expect(fetch.mock.calls.map(call => call[0])).toEqual(['/api/enquiry']);
        controller.destroy();
    });
    test('a late availability answer after teardown changes nothing', async () => {
        let resolve; const fetch = () => new Promise(done => { resolve = done; });
        const { help, controller } = await withEnquiry(fetch);
        controller.destroy(); resolve(reply(200, { available: true })); await flush();
        assert.equal(help.hidden, true);
    });
});
