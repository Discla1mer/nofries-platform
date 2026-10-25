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

test('connected view preserves golden server range, uncertainty and distinct evidence/completion', async () => {
    const dom = setup(); await flush();
    assert.match(dom.root.textContent, /46\.4%–60\.7%/);
    assert.match(dom.root.textContent, /85\.7%/);
    assert.match(dom.root.textContent, /12 of 14/);
    assert.match(dom.root.textContent, /7 partial and 2 absent/);
    assert.match(dom.root.textContent, /2 unknown or unresolved/);
    assert.match(dom.root.textContent, /1 pending N\/A/);
    assert.match(dom.root.textContent, /not achieved performance/);
    assert.match(dom.root.textContent, /Tested or observed coverage: 0\.0%/);
    assert.equal(dom.root.querySelectorAll('meter').length, dom.fixtures.metadata.domains.length);
    assert.match(dom.root.textContent, /Risk priority: not calculated/);
    assert.equal(dom.root.querySelectorAll('.picture-metric').length, 3);
    assert.match(dom.root.textContent, /All 14 responses are saved/);
    assert.match(dom.root.textContent, /6.5–8.5 reported or possible credits ÷ 14/);
    assert.match(dom.root.textContent, /overall result weights questions, not the five function percentages/);
    assert.match(dom.root.textContent, /0.*evidence|evidence has not been supplied/);
    assert.match(dom.root.textContent, /approval is not available in this journey/);
    assert.equal(dom.root.querySelectorAll('.picture-domain-detail').length, 5);
});

test('saved Overview identifies source, scope, framework, revision and output digest', async () => {
    const record = mixed(), dom = setup({ records: [record] }); await flush();
    for (const value of ['Cyber baseline', 'Synthetic organisation A', record.scopePopulation.description,
        dom.fixtures.metadata.title, dom.fixtures.metadata.profileRef.profileVersion,
        'revision 2', record.assessmentId, record.submission.evaluation.outputSha256, 'What to do next',
        'CC BY 4.0']) assert.ok(dom.root.textContent.includes(value), value);
    assert.equal(dom.root.querySelectorAll('input').length, 0);
    assert.doesNotMatch(dom.root.textContent, /board snapshot|draft presentation|PDF export|management review/i);
    assert.ok(!dom.root.querySelectorAll('button').some(b => /board|download|export|issue/i.test(b.textContent)));
});

test('freshness copy distinguishes the saved baseline from a live organisation check', async () => {
    const record = mixed(), dom = setup({ records: [record] }); await flush();
    assert.match(dom.root.textContent, /saved assessment of the selected scope, not a live check of connected systems/);
    assert.match(dom.root.textContent, /Refresh reloads saved assessments/);
    assert.match(dom.root.textContent, /does not check whether answers still reflect the organisation today/);
    assert.match(dom.root.textContent, /Coverage recorded in this saved assessment/);
    assert.doesNotMatch(dom.root.textContent, /Current substantiated coverage/);
    assert.match(dom.root.querySelector('.picture-source').textContent, /Saved .*revision 2/);
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
        'Saved ' + record.updatedAt.slice(0, 10) + ' · submitted · revision 2');
    const provenance = dom.root.querySelector('.ncsc-result-provenance');
    assert.equal(provenance.querySelector('summary').textContent, 'Source and calculation details');
    assert.equal(provenance.getAttribute('open'), null);
    for (const value of [record.assessmentId, record.updatedAt, 'Synthetic organisation A',
        dom.fixtures.metadata.title, dom.fixtures.metadata.profileRef.profileVersion,
        record.submission.evaluation.outputSha256, record.submission.responseSetSha256]) {
        assert.ok(provenance.textContent.includes(value), value);
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
    assert.equal(option.textContent, record.updatedAt.slice(0, 10) + ' · ' + record.status + ' · revision ' + record.revision);
    assert.equal(dom.root.querySelector('.picture-source').textContent.includes(record.assessmentId), false);
    const provenance = dom.root.querySelector('.ncsc-result-provenance');
    for (const value of [record.assessmentId, record.updatedAt, dom.fixtures.metadata.title,
        dom.fixtures.metadata.profileRef.profileVersion, 'Synthetic organisation A']) {
        assert.ok(provenance.textContent.includes(value), value);
    }
    assert.match(dom.root.textContent, /Baseline in progress/);
    assert.match(dom.root.textContent, /Saved progress is not a score/);
    assert.equal(dom.root.querySelector('.picture-metrics'), null);
    dom.controller.destroy();
});

test('three follow-up categories preserve unknown/N/A, overlapping evidence gaps and profile-ordered saved detail', async () => {
    const record = mixed(), dom = setup({ records: [record] }); await flush();
    const follow = dom.root.querySelector('.picture-follow-up');
    const categories = follow.children.filter(node => node.tagName === 'DETAILS');
    assert.deepEqual(categories.map(node => node.querySelector('summary').textContent),
        ['Unresolved answers · 2', 'Reported implementation gaps · 9', 'Supporting-evidence gaps · 14']);
    const expected = options => dom.fixtures.metadata.questions.filter(question => {
        const response = record.responses.find(response => response.itemId === question.id);
        return options.includes(response.optionId);
    }).map(question => question.id);
    const ids = category => category.querySelectorAll('article').map(node => node.getAttribute('data-question-id'));
    assert.deepEqual(ids(categories[0]), expected(['unknown', 'not_applicable']));
    assert.deepEqual(ids(categories[1]), expected(['partial', 'no']));
    assert.deepEqual(ids(categories[2]), dom.fixtures.metadata.questions.map(question => question.id));
    assert.ok(ids(categories[0]).every(id => ids(categories[2]).includes(id)));
    assert.match(categories[0].textContent, /N\/A claims remain unresolved/);
    assert.match(categories[2].textContent, /Evidence upload and review are not available/);
    assert.match(follow.textContent, /not a combined total or a risk ranking/);
    assert.ok(categories[0].querySelectorAll('article').every(article => /Saved answer:|Supporting evidence:/.test(article.textContent)));
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
        ['Unresolved answers · 0', 'Reported implementation gaps · 0', 'Supporting-evidence gaps · 14']);
    assert.match(categories[1].textContent, /does not establish control effectiveness/);
    assert.match(categories[2].textContent, /confidence is not assessed/);
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
    assert.match(follow.textContent, /no action is assigned or evidence uploaded here/);
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
        ['Refresh', 'Review supporting-evidence gaps', 'Saved range', 'Unresolved answers', 'Framework starting actions', 'Explain this saved result', 'Clear saved explanation']);
    assert.equal(opened, 0);
});

test('a saved draft shows progress with no submitted score', async () => {
    const record = buildFixtures().tenants[0].assessments[0];
    const dom = setup({ records: [record] }); await flush();
    assert.match(dom.root.textContent, /Baseline in progress/);
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
    click(dom, 'Open Cyber Security'); assert.equal(opened, 1);
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

test('follow-up domain filtering preserves saved scores, profile order, category overlap and keyboard focus without reads or writes', async () => {
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
    originals[2][0].querySelector('details').open = true;
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
        const ids = category => category.querySelectorAll('article').filter(article => !article.hidden).map(article => article.getAttribute('data-question-id'));
        assert.ok(ids(categories[0]).every(id => ids(categories[2]).includes(id)));
        assert.ok(status.textContent.includes(domain.title));
        assert.equal(dom.root.querySelector('.picture-metrics'), metrics); assert.equal(metrics.textContent, metricText);
        assert.deepEqual(dom.root.querySelectorAll('meter').map(meter => [meter.value, meter.getAttribute('aria-valuetext')]), meters);
    }
    change(filter, '');
    assert.deepEqual(categories.map(category => category.querySelector('summary').textContent), originalSummaries);
    assert.ok(follow.querySelectorAll('article').every(article => !article.hidden));
    assert.equal(originals[2][0].querySelector('details').open, true);
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
    assert.equal(categories[2].querySelector('summary').textContent, 'Supporting-evidence gaps · 2 of 14 shown');
    for (const category of categories.slice(0, 2)) {
        const empty = category.querySelector('.picture-follow-up-empty');
        assert.equal(empty.hidden, false); assert.match(empty.textContent, /No follow-up items in this function for this category/);
    }
    assert.equal(categories[2].querySelector('.picture-follow-up-empty').hidden, true);
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

test('supporting-evidence review is a native keyboard action that opens and focuses the existing filtered category', async () => {
    const record = mixed(); let reads = 0, lists = 0, writes = 0;
    const client = { list: async () => { lists++; return { assessments: [record], nextAfterAssessmentId: null }; },
        read: async () => { reads++; return { assessment: record }; },
        create: () => writes++, save: () => writes++, submit: () => writes++ };
    const dom = setup({ client }); await flush();
    const { filter, categories } = followUp(dom), category = categories[2], summary = category.querySelector('summary');
    change(filter, dom.fixtures.metadata.domains[0].id);
    const metricText = dom.root.querySelector('.picture-metrics').textContent;
    const questionIds = category.querySelectorAll('article').filter(article => !article.hidden)
        .map(article => article.getAttribute('data-question-id'));
    const control = dom.root.querySelectorAll('button').find(button => button.textContent === 'Review supporting-evidence gaps');
    assert.ok(control); assert.equal(control.tagName, 'BUTTON'); assert.equal(control.type, 'button');
    assert.equal(control.getAttribute('aria-controls'), category.id);
    control.focus(); assert.equal(dom.document.activeElement, control);
    control.click();
    assert.equal(category.open, true); assert.equal(dom.document.activeElement, summary);
    assert.equal(filter.value, dom.fixtures.metadata.domains[0].id);
    assert.deepEqual(category.querySelectorAll('article').filter(article => !article.hidden)
        .map(article => article.getAttribute('data-question-id')), questionIds);
    assert.equal(dom.root.querySelector('.picture-metrics').textContent, metricText);
    assert.equal(lists, 1); assert.equal(reads, 1); assert.equal(writes, 0); dom.controller.destroy();
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
    assert.ok(dom.root.querySelectorAll('button').some(button => button.textContent === 'Review supporting-evidence gaps'));
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

test('refresh and destruction retire both saved-result actions before any late response can restore them', async () => {
    const record = mixed(), opened = []; let release;
    const client = { list: async () => ({ assessments: [record], nextAfterAssessmentId: null }),
        read: async () => ({ assessment: record }) };
    const dom = setup({ client, options: { openImprovement: value => opened.push(value) } }); await flush();
    const oldPlan = planButton(dom), oldReview = dom.root.querySelectorAll('button')
        .find(button => button.textContent === 'Review supporting-evidence gaps');
    const oldCategory = followUp(dom).categories[2];
    client.list = () => new Promise(done => { release = done; });
    click(dom, 'Refresh'); oldPlan.click(); oldReview.click();
    assert.deepEqual(opened, []); assert.notEqual(oldCategory.open, true);
    dom.controller.destroy(); oldPlan.click(); oldReview.click();
    release({ assessments: [record], nextAfterAssessmentId: null }); await flush();
    assert.deepEqual(opened, []); assert.equal(dom.root.textContent, ''); assert.notEqual(oldCategory.open, true);
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

test('denial and detached result controls cannot open a plan or change the evidence category', async () => {
    for (const stop of ['denial', 'detached']) {
        const record = mixed(), opened = []; let denied = false;
        const client = { list: async () => ({ assessments: [record], nextAfterAssessmentId: null }),
            read: async () => { if (denied) throw { statusCode: 403 }; return { assessment: record }; } };
        const dom = setup({ client, options: { openImprovement: value => opened.push(value) } }); await flush();
        const oldPlan = planButton(dom), oldReview = dom.root.querySelectorAll('button')
            .find(button => button.textContent === 'Review supporting-evidence gaps'), category = followUp(dom).categories[2];
        if (stop === 'denial') { denied = true; click(dom, 'Refresh'); await flush(); }
        else { oldPlan.remove(); oldReview.remove(); }
        oldPlan.click(); oldReview.click(); assert.deepEqual(opened, []); assert.notEqual(category.open, true);
        if (stop === 'denial') assert.match(dom.root.textContent, /unavailable/);
        dom.controller.destroy();
    }
});
