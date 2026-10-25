'use strict';

// Deterministic source/controller tests with synthetic server records. The small
// DOM fixture does not establish browser layout, deployed access or SQL behavior.
const explanation = require('../api/shared/protectedAssets/assessmentExplanation');
const { resultModel } = require('../api/shared/protectedAssets/ncscQuestionnaire');
const { createNcscQuestionnaireMetadata } = require('../api/shared/ncscQuestionnaireMetadata');
const { makeVersion, stableIntent } = require('../api/shared/assessmentLifecycle/postgresNcscAssessmentStore');
const { projectNcscDetail, projectNcscSummary } = require('../api/shared/ncscAssessmentService');
const { ncscFixture, allResponses, createCommand, saveCommand, submitCommand, clone, NOW } = require('./fixtures/ncscAssessmentFixture');
const { createDom } = require('./fixtures/dashboardDom');
const golden = require('./fixtures/ncscAcceptedEvaluation.json');

const metadata = createNcscQuestionnaireMetadata();
const pause = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function saved(option = 'yes', assessmentId = 'assessment-a') {
    const fixture = ncscFixture(), context = { scope: fixture.scope, identity: { subjectKey: fixture.subjectKey } };
    let version = null;
    function execute(command) {
        version = makeVersion(stableIntent(context, command), command.idempotencyKey, version, fixture.state.tenantAggregate, NOW);
        return projectNcscDetail(version);
    }
    const draft = execute(createCommand(assessmentId));
    const responses = option === 'mixed' ? golden.input.atomInputs.map(atom => ({ itemId: atom.itemId, optionId: atom.response.optionId,
        rationale: atom.response.optionId === 'not_applicable' ? { text: '<img src=x onerror=alert(1)> Synthetic pending claim' } : null })) : allResponses(option);
    execute(saveCommand(assessmentId, 0, 'save-a', responses));
    const assessment = execute(submitCommand(assessmentId));
    return { assessment: clone(assessment), draft, summary: projectNcscSummary(version), organisationId: fixture.scope.organisationId };
}
function project(source, topic = 'range', assessment = source.assessment) {
    return explanation.explain(assessment, { metadata, organisationId: source.organisationId, resultModel, topic });
}
function ui(source, options = {}) {
    const dom = createDom(), client = { read: jest.fn(async () => ({ schemaVersion: 1, assessment: clone(source.assessment) })),
        list: jest.fn(), create: jest.fn(), save: jest.fn(), submit: jest.fn() };
    const settings = { metadata, organisationId: source.organisationId, resultModel, assessment: source.summary, client, ...options };
    return { ...dom, client: settings.client, controller: explanation.mount(dom.root, settings) };
}
function control(view, label) { return view.root.querySelectorAll('button').find(button => button.textContent === label); }
const content = projection => projection.blocks.map(block => block.text).join('\n');
const citations = projection => projection.blocks.flatMap(block => block.citations);

describe('saved assessment explanation projection', () => {
    test.each([['yes', '100.0%'], ['partial', '50.0%'], ['no', '0.0%'], ['unknown', '0.0%–100.0%'],
        ['not_applicable', '0.0%–100.0%'], ['mixed', '46.4%–60.7%']])('uses validated server %s range without changing input', (option, range) => {
        const source = saved(option), before = clone(source.assessment), result = project(source);
        expect(result.status).toBe('ready'); expect(content(result)).toContain(range);
        expect(result.outputSha256).toBe(source.assessment.submission.evaluation.outputSha256);
        expect(source.assessment).toEqual(before);
        expect(content(result)).toContain('Risk priority is not calculated');
        expect(content(result)).toContain('The saved calculation has no trend');
        expect(content(result)).toContain('this explanation verifies no evidence');
        expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.blocks[0].citations)).toBe(true);
    });
    test('citations name exact saved revision, result fields and accepted profile', () => {
        const source = saved('mixed'), refs = citations(project(source));
        for (const citation of refs.filter(row => row.kind === 'saved')) {
            expect(citation).toMatchObject({ assessmentId: source.assessment.assessmentId, revision: source.assessment.revision,
                revisionSha256: source.assessment.revisionSha256 });
        }
        expect(refs.map(row => row.field)).toEqual(expect.arrayContaining(['submission.revision', 'submission.responseSetSha256',
            'submission.evaluation.outputSha256', 'submission.evaluation.attainment.lowerDisplay',
            'submission.evaluation.attainment.upperDisplay', 'submission.evaluation.countsCompletion.unknown', 'profileRef']));
        refs.filter(row => row.kind === 'catalogue').forEach(row => expect(row.profileRef).toEqual(metadata.profileRef));
    });
    test('unresolved includes pending N/A once and cites its saved rationale as untrusted text', () => {
        const source = saved('mixed'), result = project(source, 'unresolved');
        expect(content(result)).toContain('2 unresolved answers, including 1 pending N/A claims');
        const unresolved = source.assessment.responses.filter(row => ['unknown', 'not_applicable'].includes(row.optionId));
        const questionRefs = citations(result).filter(row => row.kind === 'saved' && row.questionId);
        expect(new Set(questionRefs.map(row => row.questionId))).toEqual(new Set(unresolved.map(row => row.itemId)));
        const na = unresolved.find(row => row.optionId === 'not_applicable');
        expect(content(result)).toContain(na.rationale.text);
        expect(questionRefs).toContainEqual(expect.objectContaining({ questionId: na.itemId, field: 'responses[itemId="' + na.itemId + '"].rationale.text' }));
        expect(citations(result)).toContainEqual(expect.objectContaining({ kind: 'catalogue', questionId: na.itemId,
            field: 'questions[id="' + na.itemId + '"].sources' }));
        expect(JSON.stringify(result)).not.toMatch(/https?:\/\//);
    });
    test('actions follow accepted question order regardless of saved payload order and are not persisted tasks', () => {
        const source = saved('mixed');
        source.assessment.responses.reverse(); source.assessment.submission.evaluation.atoms.reverse();
        const result = project(source, 'actions'); expect(result.status).toBe('ready');
        const expected = metadata.questions.filter(question => source.assessment.responses.find(row => row.itemId === question.id).optionId !== 'yes');
        const questionBlocks = result.blocks.filter(block => block.citations.some(row => row.field.endsWith('.prompt')));
        expect(questionBlocks.map(block => block.title)).toEqual(expected.map(question => question.prompt));
        const actions = result.blocks.filter(block => block.title === 'Suggested starting action');
        expect(actions.map(block => block.text)).toEqual(expected.flatMap(question => question.guidance.startingActions));
        for (const action of actions) {
            const ref = action.citations.find(row => row.kind === 'catalogue');
            expect(ref.field).toMatch(/^questions\[id="[A-Za-z0-9-]+"\]\.guidance\.startingActions\[\d+\]$/);
            expect(ref.profileRef).toEqual(metadata.profileRef);
        }
        expect(content(result)).toContain('no action, owner or due date has been created');
    });
    test.each(['unresolved', 'actions'])('all-Yes %s topic explicitly has no matching items', topic => {
        const result = project(saved(), topic);
        expect(content(result)).toContain(topic === 'unresolved' ? 'There are no unresolved answers' : 'Every saved answer is Yes');
        expect(citations(result).filter(row => row.questionId)).toHaveLength(0);
    });
    test('saved drafts never call resultModel or fabricate a score', () => {
        const source = saved(), validator = jest.fn();
        const result = explanation.explain(source.draft, { metadata, organisationId: source.organisationId, resultModel: validator });
        expect(result.status).toBe('draft'); expect(content(result)).not.toMatch(/\d+(?:\.\d+)?%/); expect(validator).not.toHaveBeenCalled();
    });
    test.each([
        ['profile', a => { a.profileRef.catalogueSha256 = 'f'.repeat(64); }],
        ['organisation', a => { a.submission.evaluation.provenance.organisationId = 'foreign'; }],
        ['assessment', a => { a.submission.evaluation.provenance.assessmentId = 'foreign'; }],
        ['revision', a => { a.submission.evaluation.provenance.assessmentRevision = 'rev-99'; }],
        ['impossible submitted revision', a => { a.revision = 0; a.submission.revision = 0; a.submission.evaluation.provenance.assessmentRevision = 'rev-0'; }],
        ['score', a => { a.submission.evaluation.attainment.lowerDisplay = '99.9%'; }],
        ['fingerprint', a => { a.revisionSha256 = 'invalid'; }],
        ['unsupported evidence', a => { a.submission.evaluation.atoms[0].evidenceState = 'independently_reviewed_current'; }]
    ])('malformed or foreign %s is unavailable without a score', (_name, change) => {
        const source = saved('mixed'); change(source.assessment); const before = clone(source.assessment), result = project(source);
        expect(result.status).toBe('unavailable'); expect(content(result)).not.toMatch(/\d+(?:\.\d+)?%/);
        expect(source.assessment).toEqual(before);
    });
    test('requires existing resultModel injection and a known explicit topic', () => {
        const source = saved();
        expect(explanation.explain(source.assessment, { metadata, organisationId: source.organisationId }).status).toBe('unavailable');
        expect(project(source, 'rank-by-risk').status).toBe('unavailable');
    });
});

describe('explicit saved explanation controller', () => {
    test.each(['range', 'unresolved', 'actions'])('exact citations are retained in closed source disclosures for %s', async topic => {
        const source = saved('mixed'), view = ui(source);
        const labels = { range: 'Saved range', unresolved: 'Unresolved answers', actions: 'Framework starting actions' };
        control(view, labels[topic]).click(); control(view, 'Explain this saved result').click(); await pause();
        const result = project(source, topic), region = view.root.querySelector('[aria-label="Saved explanation"]');
        expect(region.querySelectorAll('p').map(item => item.textContent)).toEqual(result.blocks.map(block => block.text));
        const disclosures = region.querySelectorAll('details'), citedBlocks = result.blocks.filter(block => block.citations.length);
        expect(disclosures).toHaveLength(citedBlocks.length);
        expect(region.children.some(item => item.tagName === 'UL')).toBe(false);
        disclosures.forEach((details, index) => {
            expect(Boolean(details.open)).toBe(false);
            expect(details.children[0].tagName).toBe('SUMMARY');
            expect(details.children[0].textContent).toBe('Sources and calculation details');
            const expected = citedBlocks[index].citations.map(citation => citation.kind === 'saved'
                ? 'Saved assessment ' + citation.assessmentId + ', revision ' + citation.revision +
                    ' · ' + citation.revisionSha256 + ' · ' + citation.field
                : 'Accepted catalogue ' + citation.profileRef.profileId + ' ' + citation.profileRef.profileVersion +
                    ' · ' + citation.profileRef.catalogueSha256 + ' · metadata.' + citation.field);
            expect(details.querySelectorAll('li').map(item => item.textContent)).toEqual(expected);
        });
        expect(view.client.read).toHaveBeenCalledTimes(1);
        view.controller.destroy();
    });
    test('topic and clear rerenders preserve keyboard focus with themed control targets', async () => {
        const source = saved('mixed'), view = ui(source);
        let button = control(view, 'Unresolved answers'); button.focus(); button.click();
        expect(view.document.activeElement).toBe(control(view, 'Unresolved answers'));
        control(view, 'Explain this saved result').click(); await pause();
        button = control(view, 'Framework starting actions'); button.focus(); button.click();
        expect(view.document.activeElement).toBe(control(view, 'Framework starting actions'));
        button = control(view, 'Clear saved explanation'); button.focus(); button.click();
        expect(view.document.activeElement).toBe(control(view, 'Clear saved explanation'));
        expect(view.root.querySelector('[aria-label="Saved explanation"]')).toBeNull();
        view.root.querySelectorAll('button').forEach(item => expect(item.classList.contains('dashboard-button')).toBe(true));
        view.controller.destroy();
    });
    test('explicit load preserves focused control across pending and completed read', async () => {
        const source = saved(), pending = deferred(), view = ui(source);
        view.client.read.mockReturnValue(pending.promise);
        const button = control(view, 'Explain this saved result'); button.focus(); button.click();
        expect(view.document.activeElement).toBe(control(view, 'Explain this saved result'));
        expect(view.document.activeElement.getAttribute('aria-disabled')).toBe('true');
        view.document.activeElement.click(); expect(view.client.read).toHaveBeenCalledTimes(1);
        pending.resolve({ schemaVersion: 1, assessment: clone(source.assessment) }); await pause();
        expect(view.document.activeElement).toBe(control(view, 'Reload saved explanation'));
        expect(view.document.activeElement.getAttribute('aria-disabled')).toBe('false'); view.controller.destroy();
    });
    test('async completion does not steal focus after the user moves outside the explanation', async () => {
        const source = saved(), pending = deferred(), view = ui(source);
        view.client.read.mockReturnValue(pending.promise);
        const load = control(view, 'Explain this saved result'); load.focus(); load.click();
        const elsewhere = view.document.createElement('button'); elsewhere.focus();
        pending.resolve({ schemaVersion: 1, assessment: clone(source.assessment) }); await pause();
        expect(view.document.activeElement).toBe(elsewhere); expect(view.root.textContent).toContain('100.0%'); view.controller.destroy();
    });
    test('initial mount and topic choice perform no reads; explicit click reads once and topic changes remain local', async () => {
        const source = saved('mixed'), view = ui(source);
        expect(view.client.read).not.toHaveBeenCalled();
        control(view, 'Unresolved answers').click(); expect(view.client.read).not.toHaveBeenCalled();
        control(view, 'Explain this saved result').click(); await pause();
        expect(view.client.read).toHaveBeenCalledTimes(1);
        expect(view.client.read).toHaveBeenCalledWith(source.summary.assessmentId, { signal: expect.any(AbortSignal) });
        expect(view.root.textContent).toContain('2 unresolved answers, including 1');
        expect(view.root.querySelector('[data-explanation-version-notice]')).toBeNull();
        control(view, 'Saved range').click(); expect(view.root.textContent).toContain('46.4%–60.7%');
        control(view, 'Framework starting actions').click(); expect(view.client.read).toHaveBeenCalledTimes(1);
        for (const name of ['list', 'create', 'save', 'submit']) expect(view.client[name]).not.toHaveBeenCalled();
        expect(view.root.querySelectorAll('a')).toHaveLength(0); expect(view.root.querySelectorAll('img')).toHaveLength(0);
        expect(view.root.querySelectorAll('script')).toHaveLength(0);
        expect(view.root.textContent).toContain('<img src=x onerror=alert(1)>'); view.controller.destroy();
    });
    test.each(['revision', 'hash'])('changed saved %s requires explicit refresh and retains its host-version notice until detail or host reset', async kind => {
        const source = saved('mixed'), initial = clone(source.summary);
        if (kind === 'revision') initial.revision += 1; else initial.revisionSha256 = 'f'.repeat(64);
        const view = ui(source, { assessment: initial });
        control(view, 'Explain this saved result').click(); await pause();
        expect(view.root.querySelector('[aria-label="Saved explanation"]')).toBeNull();
        expect(view.root.textContent).toContain('revision or fingerprint changed');
        expect(view.client.read).toHaveBeenCalledTimes(1);
        expect(view.root.querySelector('[data-explanation-version-notice]')).toBeNull();
        control(view, 'Refresh saved explanation').click(); await pause();
        expect(view.client.read).toHaveBeenCalledTimes(2); expect(view.root.textContent).toContain('46.4%–60.7%');
        const notice = () => view.root.querySelector('[data-explanation-version-notice]');
        expect(notice()).not.toBeNull(); expect(notice().getAttribute('role')).toBe('status');
        const text = notice().textContent;
        expect(text).toContain('Cyber baseline and this explanation show different saved versions');
        expect(text).toContain('baseline’s Refresh control to reload it');
        expect(text).not.toMatch(/\b(newer|older|latest|earlier)\b/i);
        for (const topic of ['Unresolved answers', 'Framework starting actions', 'Saved range']) {
            control(view, topic).click(); expect(notice().textContent).toBe(text);
        }
        expect(view.client.read).toHaveBeenCalledTimes(2);
        control(view, 'Reload saved explanation').click();
        expect(notice()).toBeNull(); // The pending reload clears its displayed detail.
        await pause(); expect(notice().textContent).toBe(text); expect(view.client.read).toHaveBeenCalledTimes(3);
        control(view, 'Clear saved explanation').click(); expect(notice()).toBeNull();
        expect(view.client.read).toHaveBeenCalledTimes(3);
        control(view, 'Explain this saved result').click(); await pause();
        expect(notice().textContent).toBe(text); expect(view.client.read).toHaveBeenCalledTimes(4);
        view.controller.update({ assessment: source.summary });
        expect(notice()).toBeNull(); expect(view.client.read).toHaveBeenCalledTimes(4);
        control(view, 'Explain this saved result').click(); await pause();
        expect(notice()).toBeNull(); expect(view.root.textContent).toContain('46.4%–60.7%');
        expect(view.client.read).toHaveBeenCalledTimes(5);
        view.controller.destroy();
    });
    test('remount with the matching host version clears the prior notice and waits for an explicit read', async () => {
        const source = saved(), view = ui(source, { assessment: { ...source.summary, revisionSha256: 'f'.repeat(64) } });
        control(view, 'Explain this saved result').click(); await pause();
        control(view, 'Refresh saved explanation').click(); await pause();
        expect(view.root.querySelector('[data-explanation-version-notice]')).not.toBeNull();
        view.controller = explanation.mount(view.root, { client: view.client, metadata, organisationId: source.organisationId,
            resultModel, assessment: source.summary });
        expect(view.root.querySelector('[data-explanation-version-notice]')).toBeNull();
        expect(view.client.read).toHaveBeenCalledTimes(2);
        control(view, 'Explain this saved result').click(); await pause();
        expect(view.root.querySelector('[data-explanation-version-notice]')).toBeNull();
        expect(view.client.read).toHaveBeenCalledTimes(3); view.controller.destroy();
    });
    test('moving revision cannot be silently adopted on explicit refresh', async () => {
        const source = saved(), view = ui(source, { assessment: { ...source.summary, revision: 3 } });
        control(view, 'Explain this saved result').click(); await pause();
        const moved = clone(source.assessment); moved.revision += 1; moved.revisionSha256 = 'a'.repeat(64);
        view.client.read.mockResolvedValue({ schemaVersion: 1, assessment: moved });
        control(view, 'Refresh saved explanation').click(); await pause();
        expect(view.root.querySelector('[aria-label="Saved explanation"]')).toBeNull();
        expect(control(view, 'Refresh saved explanation')).toBeDefined(); view.controller.destroy();
    });
    test.each([
        ['identity', a => { a.assessmentId = 'foreign'; }],
        ['draft', a => { a.status = 'in-progress'; }],
        ['profile', a => { a.profileRef.catalogueSha256 = 'f'.repeat(64); }],
        ['time', a => { a.updatedAt = '2026-09-08T00:00:00.000Z'; }],
        ['organisation', a => { a.submission.evaluation.provenance.organisationId = 'foreign'; }]
    ])('refuses returned %s mismatch without rendering scores', async (_name, change) => {
        const source = saved('mixed'), returned = clone(source.assessment); change(returned);
        const view = ui(source); view.client.read.mockResolvedValue({ schemaVersion: 1, assessment: returned });
        control(view, 'Explain this saved result').click(); await pause();
        expect(view.root.querySelector('[aria-label="Saved explanation"]')).toBeNull(); expect(view.root.textContent).not.toContain('46.4%');
        expect(view.root.textContent).toContain('unavailable'); view.controller.destroy();
    });
    test.each(['created', 'in-progress'])('draft %s descriptor never loads or scores', status => {
        const source = saved(), view = ui(source, { assessment: { ...source.summary, status } });
        expect(control(view, 'Explain this saved result')).toBeUndefined(); expect(view.client.read).not.toHaveBeenCalled(); view.controller.destroy();
    });
    test.each(['update', 'clear', 'destroy', 'remount'])('%s invalidates a pending read even if the transport ignores abort', async action => {
        const source = saved(), pending = deferred(), view = ui(source); view.client.read.mockReturnValue(pending.promise);
        control(view, 'Explain this saved result').click();
        const signal = view.client.read.mock.calls[0][1].signal;
        if (action === 'update') view.controller.update({ assessment: saved('mixed', 'assessment-b').summary });
        if (action === 'clear') control(view, 'Clear saved explanation').click();
        if (action === 'destroy') view.controller.destroy();
        if (action === 'remount') view.controller = explanation.mount(view.root, { client: view.client, metadata,
            organisationId: source.organisationId, resultModel, assessment: source.summary });
        expect(signal.aborted).toBe(true);
        pending.resolve({ schemaVersion: 1, assessment: clone(source.assessment) }); await pause();
        expect(view.root.querySelector('[aria-label="Saved explanation"]')).toBeNull(); expect(view.root.textContent).not.toContain('100.0%');
        if (action === 'destroy') expect(view.root.textContent).toBe('');
        view.controller.destroy();
    });
    test('clear then reopen does not let the old response replace the current selection', async () => {
        const source = saved('mixed'), first = deferred(), second = deferred(), view = ui(source);
        view.client.read.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
        control(view, 'Explain this saved result').click(); control(view, 'Clear saved explanation').click();
        control(view, 'Explain this saved result').click();
        first.resolve({ schemaVersion: 1, assessment: clone(source.assessment) }); await pause();
        expect(view.root.querySelector('[aria-label="Saved explanation"]')).toBeNull();
        second.resolve({ schemaVersion: 1, assessment: clone(source.assessment) }); await pause();
        expect(view.root.textContent).toContain('46.4%–60.7%'); view.controller.destroy();
    });
    test.each([401, 403])('late %i denial still notifies owner after cancellation', async statusCode => {
        const source = saved(), pending = deferred(), onDenied = jest.fn(), view = ui(source, { onDenied });
        view.client.read.mockReturnValue(pending.promise); control(view, 'Explain this saved result').click();
        control(view, 'Clear saved explanation').click(); pending.reject({ statusCode }); await pause();
        expect(onDenied).toHaveBeenCalledTimes(1); expect(view.root.textContent).not.toContain('100.0%'); view.controller.destroy();
    });
    test('late denial clears a newer visible explanation even without an owner callback', async () => {
        const source = saved(), pending = deferred(), view = ui(source);
        view.client.read.mockReturnValueOnce(pending.promise);
        control(view, 'Explain this saved result').click(); control(view, 'Clear saved explanation').click();
        control(view, 'Explain this saved result').click(); await pause(); expect(view.root.textContent).toContain('100.0%');
        pending.reject({ statusCode: 403 }); await pause();
        expect(view.root.querySelector('[aria-label="Saved explanation"]')).toBeNull();
        expect(view.root.textContent).not.toContain('100.0%'); expect(view.root.textContent).toContain('Access to this saved assessment is unavailable');
        view.controller.destroy();
    });
    test('read failure renders generic retry and performs no automatic retries or error disclosure', async () => {
        const source = saved(), view = ui(source); view.client.read.mockRejectedValue(new Error('private-secret-canary'));
        control(view, 'Explain this saved result').click(); await pause();
        expect(view.client.read).toHaveBeenCalledTimes(1); expect(view.root.textContent).toContain('unavailable');
        expect(view.root.textContent).not.toContain('private-secret-canary');
        control(view, 'Explain this saved result').click(); await pause(); expect(view.client.read).toHaveBeenCalledTimes(2);
        view.controller.destroy();
    });
    test('selected summary is snapshotted and update never starts a read', async () => {
        const source = saved(), descriptor = clone(source.summary), view = ui(source, { assessment: descriptor });
        descriptor.assessmentId = 'foreign'; descriptor.revision = 99;
        control(view, 'Explain this saved result').click(); await pause();
        expect(view.client.read).toHaveBeenCalledWith(source.assessment.assessmentId, expect.any(Object));
        view.controller.update({ assessment: null }); expect(view.client.read).toHaveBeenCalledTimes(1);
        expect(view.root.textContent).not.toContain('100.0%'); view.controller.destroy();
    });
});
