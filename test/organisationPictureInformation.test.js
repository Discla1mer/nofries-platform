'use strict';

const picture = require('../api/shared/protectedAssets/organisationPicture');
const { createDom } = require('./fixtures/dashboardDom');
const { buildFixtures } = require('../scripts/build-ncsc-questionnaire-preview');
const { ncscFixture, allResponses, createCommand, saveCommand, submitCommand, SUBJECT, NOW } = require('./fixtures/ncscAssessmentFixture');
const { makeVersion } = require('../api/shared/assessmentLifecycle/postgresNcscAssessmentStore');
const { projectNcscDetail } = require('../api/shared/ncscAssessmentService');
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
const clone = value => JSON.parse(JSON.stringify(value));
function submitted(assessmentId = 'assessment-information', options = ['unknown', 'not_applicable']) {
    const tenant = ncscFixture({ tenantId: 'synthetic-preview-a', organisationId: 'shared-preview-organisation' });
    const responses = allResponses().map((row, index) => ({ ...row, optionId: options[index] || 'yes',
        rationale: options[index] === 'not_applicable' ? { text: 'Synthetic applicability question.' } : null }));
    let version = null;
    for (const command of [createCommand(assessmentId, 'create-information', 'Synthetic scope.'),
        saveCommand(assessmentId, 0, 'save-information', responses), submitCommand(assessmentId, 1, 'submit-information')]) {
        version = makeVersion({ ...tenant.scope, actorSubjectKey: SUBJECT, assessmentId, action: command.action,
            expectedRevision: command.expectedRevision, payload: command.payload }, command.idempotencyKey,
        version, tenant.state.tenantAggregate, NOW);
    }
    return projectNcscDetail(version);
}
function setup(records = [submitted()], options = {}) {
    const dom = createDom(), fixtures = buildFixtures();
    const client = { list: jest.fn(async () => ({ assessments: records, nextAfterAssessmentId: null })),
        read: jest.fn(async id => ({ assessment: clone(records.find(row => row.assessmentId === id)) })),
        create: jest.fn(), save: jest.fn(), submit: jest.fn() };
    const config = { metadata: fixtures.metadata, organisationId: 'shared-preview-organisation', client,
        initialAssessmentId: records[0].assessmentId, ...options };
    return { ...dom, client, config, fixtures, controller: picture.mount(dom.root, config) };
}
const section = dom => dom.root.querySelector('.picture-information');
const action = dom => section(dom)?.querySelector('button');
const refresh = dom => dom.root.querySelectorAll('button').find(button => button.textContent === 'Refresh').click();
const select = (dom, id) => { const picker = dom.root.querySelector('.picture-toolbar').querySelector('select');
    picker.value = id; picker.events.change.forEach(callback => callback()); };
const binding = record => ({ assessmentId: record.assessmentId, revision: record.revision,
    revisionSha256: record.revisionSha256, profileRef: record.profileRef, outputSha256: record.submission.evaluation.outputSha256 });

test('counts saved Unknown separately from pending N/A and uses human question titles', async () => {
    const dom = setup([submitted('assessment-information', ['unknown', 'unknown', 'not_applicable', 'no', 'partial'])]); await flush();
    expect(section(dom).textContent).toContain('2 saved Unknown answers · 1 saved Not applicable answer awaiting review.');
    expect(section(dom).textContent).toContain('not unanswered questions or a risk score');
    expect(section(dom).querySelectorAll('li')).toHaveLength(3);
    expect(section(dom).querySelectorAll('h4').map(item => item.textContent)).toEqual(dom.fixtures.metadata.questions.slice(0, 3).map(row => row.prompt));
    expect(dom.root.querySelectorAll('.picture-follow-up')).toHaveLength(1);
    expect(section(dom).getAttribute('aria-labelledby')).toBe(section(dom).querySelector('h3').id);
    for (const method of ['create', 'save', 'submit']) expect(dom.client[method]).not.toHaveBeenCalled();
    dom.controller.destroy();
});

test('view without a host plan callback is honest and cannot be enabled by mutating options', async () => {
    const dom = setup(); await flush();
    expect(section(dom).textContent).toContain('This view only lists information needs. Use the questions above to agree who will find the information and when to review it. No requests have been created or sent.');
    expect(action(dom)).toBeNull();
    dom.config.openImprovement = jest.fn(); refresh(dom); await flush();
    expect(action(dom)).toBeNull(); expect(dom.config.openImprovement).not.toHaveBeenCalled(); dom.controller.destroy();
});

test('explicit open hands off only the exact validated submission without writes or score changes', async () => {
    const record = submitted(), before = clone(record), openImprovement = jest.fn();
    const dom = setup([record], { openImprovement }); await flush();
    expect(openImprovement).not.toHaveBeenCalled();
    expect(section(dom).textContent).toContain('Opening the plan creates or sends nothing.');
    expect(section(dom).textContent).toContain('This may also create other recommended actions.');
    expect(section(dom).textContent).toContain('Completing an action does not approve a Not applicable answer, verify a control or change assessment scores.');
    expect(action(dom).textContent).toBe('Open plan for information requests'); expect(action(dom).type).toBe('button');
    action(dom).click(); expect(openImprovement).toHaveBeenCalledTimes(1);
    expect(openImprovement).toHaveBeenCalledWith(binding(record));
    expect(Object.isFrozen(openImprovement.mock.calls[0][0])).toBe(true);
    expect(Object.isFrozen(openImprovement.mock.calls[0][0].profileRef)).toBe(true);
    for (const method of ['create', 'save', 'submit']) expect(dom.client[method]).not.toHaveBeenCalled();
    expect(record).toEqual(before); dom.controller.destroy();
});

test('no suggested requests offers no create shortcut or claim of verified controls', async () => {
    const dom = setup([submitted('assessment-information', [])], { openImprovement: jest.fn() }); await flush();
    expect(section(dom).textContent).toContain('0 saved Unknown answers · 0 saved Not applicable answers awaiting review.');
    expect(section(dom).textContent).toContain('This does not verify that controls are effective.');
    expect(action(dom)).toBeNull(); dom.controller.destroy();
});

test.each(['draft', 'foreign', 'invalid-result', 'missing-binding'])('%s never exposes an information plan shortcut', async kind => {
    const record = clone(kind === 'draft' ? buildFixtures().tenants[0].assessments[0] : submitted());
    if (kind === 'foreign') record.submission.evaluation.provenance.organisationId = 'foreign';
    if (kind === 'invalid-result') record.submission.evaluation.outputSha256 = 'invalid';
    if (kind === 'missing-binding') delete record.revisionSha256;
    const openImprovement = jest.fn(), dom = setup([record], { openImprovement }); await flush();
    expect(action(dom)).toBeFalsy(); expect(openImprovement).not.toHaveBeenCalled(); dom.controller.destroy();
});

test.each(['refresh', 'selection', 'remount', 'denial', 'detached', 'destroy'])('old information control cannot act after %s, even reattached', async transition => {
    const first = submitted(), second = submitted('assessment-second', ['unknown']);
    const openImprovement = jest.fn(), dom = setup([first, second], { openImprovement }); await flush();
    const old = section(dom), control = action(dom);
    if (transition === 'refresh') refresh(dom);
    if (transition === 'selection') select(dom, second.assessmentId);
    if (transition === 'remount') dom.controller = picture.mount(dom.root, { ...dom.config, initialAssessmentId: second.assessmentId });
    if (transition === 'denial') { dom.client.read.mockRejectedValue({ statusCode: 403 }); refresh(dom); }
    if (transition === 'detached') old.remove();
    if (transition === 'destroy') dom.controller.destroy();
    await flush();
    if (transition !== 'detached') dom.root.append(old);
    control.click(); expect(openImprovement).not.toHaveBeenCalled();
    if (transition === 'selection') { action(dom).click(); expect(openImprovement).toHaveBeenCalledWith(binding(second)); }
    dom.controller.destroy();
});
