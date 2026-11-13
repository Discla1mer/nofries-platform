'use strict';

const picture = require('../api/shared/protectedAssets/organisationPicture');
const { buildFixtures } = require('../scripts/build-ncsc-questionnaire-preview');
const { createDom } = require('./fixtures/dashboardDom');
const clone = value => JSON.parse(JSON.stringify(value));
// Reuse immutable synthetic source records; each client returns detached copies.
const fixture = buildFixtures();
const AS_OF = '2026-11-12T23:59:59.999Z';
const action = (id, reviewDate, extra = {}) => ({ actionId: id, status: 'completed', dueDate: '2026-10-01',
    isOverdue: false, ownerLabel: 'Synthetic owner', rationale: { suggestedAction: 'Follow-up ' + id },
    completion: reviewDate === undefined ? { at: '2026-10-01T00:00:00.000Z', note: 'Saved completion' }
        : { at: '2026-10-01T00:00:00.000Z', note: 'Saved completion', nextReviewDate: reviewDate }, ...extra });
const input = (actions, extra = {}) => ({ lists: [{ asOf: AS_OF, actions }], more: false, ...extra });
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
function mount(value, options = {}) {
    const record = fixture.tenants[0].assessments[0], dom = createDom();
    const writes = jest.fn(), client = { list: async () => ({ assessments: [clone(record)], nextAfterAssessmentId: null }),
        read: async () => ({ assessment: clone(record) }), save: writes, submit: writes };
    const openImprovement = jest.fn();
    const controller = picture.mount(dom.root, { metadata: fixture.metadata, client,
        organisationId: fixture.tenants[0].model.context.organisationId, openImprovement,
        readActions: async () => value, ...options });
    return { ...dom, controller, writes, openImprovement };
}

test('saved reviews use the server day and separate completed follow-ups from overdue work', () => {
    const value = input([action('today', '2026-11-12'), action('old', '2026-11-01'),
        action('tomorrow', '2026-11-13'), action('edge', '2026-11-26'), action('later', '2026-11-27'), action('legacy')]);
    const before = clone(value), result = picture.actionSummary(value);
    expect(result.overdue.count).toBe(0); expect(result.dueSoon.count).toBe(0);
    expect(result.reviews).toMatchObject({ total: 5, asOfDay: '2026-11-12', due: { count: 2 }, soon: { count: 2 } });
    expect(result.reviews.due.items.map(row => row.title)).toEqual(['Follow-up old', 'Follow-up today']);
    expect(result.reviews.soon.items.map(row => row.title)).toEqual(['Follow-up tomorrow', 'Follow-up edge']);
    expect(value).toEqual(before); // No workflow, score, evidence or dates are changed.
});

test('review counts cover all loaded plans but preview each group with at most three rows in stable date/id order', () => {
    const value = input([], { more: true, lists: [{ asOf: AS_OF, actions: [action('z', '2026-11-01'), action('a', '2026-11-01')] },
        { asOf: '2026-11-13T00:00:00.000Z', actions: [action('b', '2026-11-01'), action('c', '2026-11-02'), action('d', '2026-11-13')] }] });
    const result = picture.actionSummary(value);
    expect(result.more).toBe(true); expect(result.reviews.due.count).toBe(4);
    expect(result.reviews.due.items.map(row => row.title)).toEqual(['Follow-up a', 'Follow-up b', 'Follow-up z']);
    expect(result.reviews.soon.count).toBe(1); expect(result.reviews.asOfDay).toBe('2026-11-12');
});

test('reopened actions and historical completion dates never imply a current review obligation', () => {
    const result = picture.actionSummary(input([action('reopened', undefined, { status: 'open', completion: null,
        isOverdue: true, history: [{ type: 'complete', details: { nextReviewDate: '2026-11-01' } }] }), action('legacy')]));
    expect(result.overdue.count).toBe(1); expect(result.reviews.total).toBe(0);
});

test.each(['2026-02-30', '2026-13-01', '2026-11-12T00:00:00Z', '', null, 12])('malformed review date %p fails closed', date => {
    expect(picture.actionSummary(input([action('invalid', date)]))).toBeNull();
});

test('valid leap days work and invalid current-completion or date-basis data fails closed', () => {
    const value = input([action('leap', '2028-02-29')], { lists: [{ asOf: '2028-02-28T23:59:00.000Z', actions: [action('leap', '2028-02-29')] }] });
    expect(picture.actionSummary(value).reviews.soon.count).toBe(1);
    expect(picture.actionSummary(input([action('inconsistent', '2026-11-01', { status: 'open' })]))).toBeNull();
    expect(picture.actionSummary(input([], { lists: [{ asOf: '2026-02-30T00:00:00.000Z', actions: [] }] }))).toBeNull();
});

test('Overview surfaces review dates honestly, escapes labels, retains bounded-read notice and only navigates', async () => {
    const value = input([action('review', '2026-11-12', { ownerLabel: '<b>Synthetic owner</b>',
        rationale: { suggestedAction: '<img src=x onerror=alert(1)>' } }), action('upcoming', '2026-11-13')], { more: true });
    const dom = mount(value); await flush();
    const card = dom.root.querySelector('.picture-actions');
    expect(card.querySelectorAll('h4').map(node => node.textContent)).toEqual([
        'Overdue (0)', 'Due in the next 14 days (0)', 'Reviews due (1)', 'Reviews in the next 14 days (1)']);
    expect(card.textContent).toContain('Review 12 Nov 2026 · Owner: <b>Synthetic owner</b>');
    expect(card.textContent).toContain('checked against 12 Nov 2026 (UTC)');
    expect(card.textContent).toContain('does not confirm a review took place, verify evidence or change a score');
    expect(card.textContent).toContain('Counts cover the first five saved plans');
    expect(card.querySelector('img')).toBeNull(); expect(card.querySelector('b')).toBeNull();
    card.querySelector('.picture-actions-plan').click(); expect(dom.openImprovement).toHaveBeenCalledTimes(1);
    expect(dom.writes).not.toHaveBeenCalled(); dom.controller.destroy();
});

test('invalid review records leave assessment content available without presenting a partial Actions card', async () => {
    const dom = mount(input([action('good', '2026-11-01'), action('bad', '2026-02-30')])); await flush();
    expect(dom.root.querySelector('.picture-actions')).toBeNull();
    expect(dom.root.querySelector('.picture-resume')).not.toBeNull(); dom.controller.destroy();
});

test('tenant remount discards a delayed old review list', async () => {
    let resolve;
    const delayed = new Promise(done => { resolve = done; });
    const dom = mount(null, { readActions: () => delayed }); await flush(); dom.controller.destroy();
    const client = { list: async () => ({ assessments: [], nextAfterAssessmentId: null }), read: jest.fn() };
    const next = picture.mount(dom.root, { client, metadata: fixture.metadata, organisationId: 'another-synthetic-organisation',
        openImprovement: jest.fn(), readActions: async () => input([]) }); await flush();
    resolve(input([action('old-tenant-review', '2026-11-01')])); await flush();
    expect(dom.root.textContent).not.toContain('old-tenant-review');
    // A new organisation's Overview now leads with "Start your cyber check" (#319).
    expect(dom.root.textContent).toContain('Start your cyber check'); next.destroy();
});
