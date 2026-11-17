'use strict';

// D-013: Overview may read the assessment a previous visit showed beside the
// first list. The fresh list still decides what is shown.
const picture = require('../api/shared/protectedAssets/organisationPicture');
const { createDom } = require('./fixtures/dashboardDom');
const { buildFixtures } = require('../scripts/build-ncsc-questionnaire-preview');
const { ncscFixture, allResponses, createCommand, saveCommand, submitCommand, SUBJECT, NOW } = require('./fixtures/ncscAssessmentFixture');
const { makeVersion } = require('../api/shared/assessmentLifecycle/postgresNcscAssessmentStore');
const { projectNcscDetail } = require('../api/shared/ncscAssessmentService');
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
const clone = value => JSON.parse(JSON.stringify(value));
function submitted(assessmentId) {
    const tenant = ncscFixture({ tenantId: 'synthetic-preview-a', organisationId: 'shared-preview-organisation' });
    let version = null;
    for (const command of [createCommand(assessmentId, 'create-' + assessmentId, 'Synthetic scope.'),
        saveCommand(assessmentId, 0, 'save-' + assessmentId, allResponses()), submitCommand(assessmentId, 1, 'submit-' + assessmentId)]) {
        version = makeVersion({ ...tenant.scope, actorSubjectKey: SUBJECT, assessmentId, action: command.action,
            expectedRevision: command.expectedRevision, payload: command.payload }, command.idempotencyKey,
        version, tenant.state.tenantAggregate, NOW);
    }
    return projectNcscDetail(version);
}
function setup(records, options = {}, behaviour = {}) {
    const dom = createDom(), fixtures = buildFixtures(), order = [], signals = [];
    let releaseList = null;
    const client = {
        list: jest.fn(() => { order.push('list'); return new Promise(resolve => {
            releaseList = () => resolve({ assessments: records, nextAfterAssessmentId: null });
            if (!behaviour.holdList) releaseList();
        }); }),
        read: jest.fn(async (id, input) => {
            order.push('read:' + id); signals.push(input.signal);
            if (behaviour.failFirstRead && client.read.mock.calls.length === 1) throw Object.assign(new Error('refused'), { statusCode: 403 });
            return { assessment: clone(records.find(row => row.assessmentId === id)) };
        }),
        create: jest.fn(), save: jest.fn(), submit: jest.fn() };
    const onSelection = jest.fn();
    const config = { metadata: fixtures.metadata, organisationId: 'shared-preview-organisation', client, onSelection, ...options };
    const controller = picture.mount(dom.root, config);
    return { ...dom, client, order, signals, onSelection, controller, releaseList: () => releaseList() };
}
const shown = dom => dom.root.textContent;
// Saved at the same instant: the view then prefers the lower identifier, 'assessment-newer'.
const newer = () => submitted('assessment-newer');
const older = () => submitted('assessment-older');

test('a correct hint is read beside the list and used without a second read', async () => {
    const dom = setup([newer(), older()], { likelyAssessmentId: 'assessment-newer' }, { holdList: true });
    await flush();
    expect(dom.order).toEqual(['list', 'read:assessment-newer']);
    expect(shown(dom)).not.toContain('Source and calculation details');
    dom.releaseList(); await flush();
    expect(dom.client.read).toHaveBeenCalledTimes(1);
    expect(dom.signals[0].aborted).toBe(false);
    expect(shown(dom)).toContain('Source and calculation details');
    expect(dom.onSelection).toHaveBeenCalledWith('assessment-newer', undefined);
    for (const method of ['create', 'save', 'submit']) expect(dom.client[method]).not.toHaveBeenCalled();
    dom.controller.destroy();
});

test('a stale hint is cancelled and the assessment chosen by the fresh list is read and shown', async () => {
    const dom = setup([newer(), older()], { likelyAssessmentId: 'assessment-older' }); await flush();
    expect(dom.order).toEqual(['list', 'read:assessment-older', 'read:assessment-newer']);
    expect(dom.signals[0].aborted).toBe(true);
    expect(dom.onSelection).toHaveBeenCalledTimes(1);
    expect(dom.onSelection).toHaveBeenCalledWith('assessment-newer', undefined);
    dom.controller.destroy();
});

test('a hint for an assessment that is not listed is never shown', async () => {
    const dom = setup([newer()], { likelyAssessmentId: 'assessment-elsewhere' }); await flush();
    expect(dom.order).toEqual(['list', 'read:assessment-elsewhere', 'read:assessment-newer']);
    expect(dom.onSelection).toHaveBeenCalledWith('assessment-newer', undefined);
    dom.controller.destroy();
});

test('a refused early read is ignored; the normal read then decides', async () => {
    const dom = setup([newer()], { likelyAssessmentId: 'assessment-newer' }, { failFirstRead: true }); await flush();
    expect(dom.client.read).toHaveBeenCalledTimes(2);
    expect(shown(dom)).toContain('Source and calculation details');
    expect(shown(dom)).not.toContain('This organisation picture is unavailable');
    dom.controller.destroy();
});

test('the hint is tried once per mount and never on refresh', async () => {
    const dom = setup([newer()], { likelyAssessmentId: 'assessment-newer' }); await flush();
    dom.root.querySelectorAll('button').find(button => button.textContent === 'Refresh').click(); await flush();
    expect(dom.order).toEqual(['list', 'read:assessment-newer', 'list', 'read:assessment-newer']);
    expect(dom.order.indexOf('list', 1)).toBe(2);
    dom.controller.destroy();
});

test.each([
    ['a carried selection', { initialAssessmentId: 'assessment-older', likelyAssessmentId: 'assessment-newer' }, ['list', 'read:assessment-older']],
    ['a malformed hint', { likelyAssessmentId: '../assessment-newer' }, ['list', 'read:assessment-newer']],
    ['a non-string hint', { likelyAssessmentId: { toString: () => 'assessment-newer' } }, ['list', 'read:assessment-newer']]
])('%s means no early read', async (_name, options, expected) => {
    const dom = setup([newer(), older()], options); await flush();
    expect(dom.order).toEqual(expected);
    dom.controller.destroy();
});

test('a view destroyed while the list is outstanding shows nothing from the early read', async () => {
    const dom = setup([newer()], { likelyAssessmentId: 'assessment-newer' }, { holdList: true }); await flush();
    dom.controller.destroy(); dom.releaseList(); await flush();
    expect(dom.onSelection).not.toHaveBeenCalled();
    expect(shown(dom)).not.toContain('Source and calculation details');
});
