'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createDom } = require('./fixtures/dashboardDom');
const source = fs.readFileSync(path.join(__dirname, '../api/shared/protectedAssets/operator.js'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const flush = () => new Promise(resolve => setImmediate(resolve));

function organisation(id = 'org-a', displayName = 'Synthetic customer') {
    return { organisationId: id, displayName, recordType: 'customer', lifecycleState: 'active',
        updatedAt: '2026-08-01T00:00:00.000Z', discovery: { missingFields: [], summary: '' },
        nextAction: { type: 'review', detail: 'Review retained records' },
        context: { contacts: { primary: {} }, users: {}, endpoints: {}, productivity: {}, itProvider: {} } };
}
function schedule(overrides = {}) {
    return { id: 'schedule-a', organisationId: 'org-a', jobType: 'quarterly_service_review',
        cadence: 'quarterly', timezone: 'Pacific/Auckland', nextDueAt: '2026-09-30T11:00:00.000Z',
        enabled: true, ...overrides };
}
function run(overrides = {}) {
    return { id: 'run-a', scheduleId: 'schedule-a', organisationId: 'org-a', jobType: 'quarterly_service_review',
        scheduledFor: '2026-06-30T12:00:00.000Z', status: 'generated', ...overrides };
}
function bootstrap(overrides = {}) {
    return { revision: 2, tenant: { name: 'Synthetic tenant' },
        user: { role: 'viewer', name: 'Synthetic operator', capabilities: ['lifecycle:read'] },
        counts: { exceptions: 0, operatorTasks: 0, conversations: 0, approvals: 0 },
        ai: { approximateCostUsd: 0 }, lifecycle: {}, organisations: [organisation()],
        exceptions: [], operatorTasks: [], serviceProof: {},
        customerControls: { schedules: [schedule()], recentRuns: [] }, ...overrides };
}
async function render(value = bootstrap(), status = 200) {
    const dom = createDom(), document = dom.document, root = dom.root;
    const elements = { operatorRoot: root, loadingPanel: document.createElement('div'),
        loadingStatus: document.createElement('p'), operatorToast: document.createElement('p') };
    document.getElementById = id => elements[id] || null;
    document.body = document.createElement('body');
    const create = document.createElement;
    document.createElement = tag => {
        const element = create(tag);
        Object.defineProperty(element, 'innerHTML', { set() { throw new Error('HTML sink forbidden'); } });
        return element;
    };
    const window = { location: { search: '', assign: jest.fn(), replace: jest.fn() },
        confirm: jest.fn(() => { throw new Error('Confirmation forbidden during a read'); }),
        prompt: jest.fn(() => { throw new Error('Prompt forbidden during a read'); }), setTimeout: jest.fn() };
    const fetch = jest.fn(async (url, options) => {
        if (options.method && options.method !== 'GET') throw new Error('Mutation forbidden');
        if (url === '/api/lifecycle/bootstrap') return { ok: status === 200, status, json: async () => value };
        if (url === '/api/datto-rmm/status') return { ok: true, status: 200,
            json: async () => ({ configured: false, state: 'disabled', mode: 'disabled', missing: [] }) };
        throw new Error('Unexpected request');
    });
    vm.runInNewContext(source, { document, window, fetch, URLSearchParams, URL, Intl });
    await flush(); await flush();
    const section = root.querySelector('[aria-label="Recurring service reviews and controls"]');
    if (status === 200) expect(elements.loadingPanel.hidden).toBe(true);
    return { ...dom, ...elements, window, fetch, section };
}
function facts(detail) {
    const children = detail.querySelector('dl').children;
    return Object.fromEntries(children.filter(node => node.tagName === 'DT')
        .map(node => [node.textContent, children[children.indexOf(node) + 1].textContent]));
}
const rows = harness => harness.section.querySelectorAll('details');

test('renders retained service controls, paused state and exact run association without new requests or mutations', async () => {
    const value = bootstrap({ customerControls: { schedules: [schedule(), schedule({ id: 'paused', enabled: false })],
        recentRuns: [run({ id: 'older', status: 'completed', scheduledFor: '2026-03-30T12:00:00.000Z' }), run(),
            run({ id: 'foreign', organisationId: 'org-other', status: 'completed', scheduledFor: '2026-08-30T12:00:00.000Z' })] } });
    const before = clone(value), h = await render(value), displayed = rows(h);
    expect(displayed).toHaveLength(2);
    expect(facts(displayed[0])).toEqual({
        'Schedule state': 'Enabled', 'Recorded cadence': 'Quarterly', 'Time zone': 'Pacific/Auckland',
        'Next scheduled (local)': '2026-10-01 00:00:00 GMT+13:00', 'Next scheduled (UTC)': '2026-09-30T11:00:00.000Z',
        'Latest included run': 'Task generated', 'Run scheduled for (local)': '2026-07-01 00:00:00 GMT+12:00',
        'Run scheduled for (UTC)': '2026-06-30T12:00:00.000Z'
    });
    expect(facts(displayed[1])).toMatchObject({ 'Schedule state': 'Paused', 'Latest included run': 'No run included in this snapshot' });
    expect(h.section.textContent).toContain('not assessment-review schedules');
    expect(h.section.textContent).toContain('A generated task does not mean a review is complete or evidence is verified.');
    expect(h.section.textContent).toContain('up to 200 schedules and 100 recent runs');
    expect(h.section.textContent).toContain('Older records may not be included.');
    expect(value).toEqual(before);
    expect(h.fetch.mock.calls.map(call => call[0])).toEqual(['/api/lifecycle/bootstrap', '/api/datto-rmm/status']);
    expect(h.fetch.mock.calls.every(([, options]) => options.credentials === 'same-origin' && !options.method)).toBe(true);
    for (const tag of ['button', 'input', 'select', 'a', 'form']) expect(h.section.querySelectorAll(tag)).toEqual([]);
    expect(h.window.confirm).not.toHaveBeenCalled(); expect(h.window.prompt).not.toHaveBeenCalled();
    displayed.forEach(detail => {
        expect(detail.children[0].tagName).toBe('SUMMARY');
        expect(detail.getAttribute('open')).toBeNull();
        expect(detail.children[0].getAttribute('tabindex')).toBeNull();
        expect(detail.children[0].events).toEqual({});
    });
});

test.each([
    ['2026-09-26T13:59:59.000Z', 'Pacific/Auckland', '2026-09-27 01:59:59 GMT+12:00'],
    ['2026-09-26T14:00:00.000Z', 'Pacific/Auckland', '2026-09-27 03:00:00 GMT+13:00'],
    ['2026-04-04T13:59:59.000Z', 'Pacific/Auckland', '2026-04-05 02:59:59 GMT+13:00'],
    ['2026-04-04T14:00:00.000Z', 'Pacific/Auckland', '2026-04-05 02:00:00 GMT+12:00'],
    ['2026-08-31T11:15:00.000Z', 'Pacific/Chatham', '2026-09-01 00:00:00 GMT+12:45'],
    ['2026-09-30T10:15:00.000Z', 'Pacific/Chatham', '2026-10-01 00:00:00 GMT+13:45'],
    ['2028-02-29T23:30:00.000Z', 'UTC', '2028-02-29 23:30:00 GMT+00:00'],
    ['2028-02-29T11:30:00.000Z', 'Pacific/Auckland', '2028-03-01 00:30:00 GMT+13:00'],
    ['2026-12-31T11:00:00.000Z', 'Pacific/Auckland', '2027-01-01 00:00:00 GMT+13:00']
])('preserves %s while rendering the actual stored timezone %s', async (nextDueAt, timezone, expected) => {
    const h = await render(bootstrap({ customerControls: { schedules: [schedule({ nextDueAt, timezone })], recentRuns: [] } }));
    expect(facts(rows(h)[0])).toMatchObject({ 'Next scheduled (UTC)': nextDueAt,
        'Next scheduled (local)': expected, 'Time zone': timezone });
});

test.each([undefined, null, '', 'Not/A-Timezone', '+12:00', 'UTC ', '<img src=x onerror=alert(1)>', {}])(
    'invalid or missing timezone %p never falls back to the browser timezone', async timezone => {
        const h = await render(bootstrap({ customerControls: { schedules: [schedule({ timezone })], recentRuns: [] } }));
        expect(facts(rows(h)[0])).toMatchObject({ 'Next scheduled (UTC)': '2026-09-30T11:00:00.000Z',
            'Next scheduled (local)': 'Unavailable: no valid time zone',
            'Time zone': timezone == null || timezone === '' ? 'Not recorded' : 'Unavailable: invalid time zone' });
    }
);

test.each([undefined, null, '', '2026-02-29T00:00:00.000Z', '2026-02-30T00:00:00.000Z', '2026-09-30',
    '2026-09-30T11:00:00+00:00', '0000-01-01T00:00:00.000Z', 1234])(
    'missing or invalid due instant %p is not normalised to a fabricated date', async nextDueAt => {
        const h = await render(bootstrap({ customerControls: { schedules: [schedule({ nextDueAt })], recentRuns: [] } }));
        const expected = nextDueAt == null || nextDueAt === '' ? 'Not recorded' : 'Unavailable: invalid date';
        expect(facts(rows(h)[0])).toMatchObject({ 'Next scheduled (UTC)': expected, 'Next scheduled (local)': expected,
            'Time zone': 'Pacific/Auckland' });
    }
);

test('does not disclose unmatched schedules or mix same-ID runs from another organisation or control type', async () => {
    const h = await render(bootstrap({ customerControls: {
        schedules: [schedule(), schedule({ id: 'foreign-secret', organisationId: 'org-not-loaded', jobType: 'foreign-secret' })],
        recentRuns: [run({ organisationId: 'org-not-loaded', status: 'completed' }), run({ jobType: 'monthly_proof', status: 'completed' }),
            run({ scheduleId: 'different', status: 'completed' })]
    } }));
    expect(rows(h)).toHaveLength(1); expect(h.section.textContent).not.toContain('foreign-secret');
    expect(facts(rows(h)[0])['Latest included run']).toBe('No run included in this snapshot');
});

test('ambiguous organisation identities are withheld instead of choosing a display name', async () => {
    const h = await render(bootstrap({ organisations: [organisation(), organisation('org-a', 'Ambiguous second name')] }));
    expect(rows(h)).toEqual([]);
    expect(h.section.textContent).toContain('No recurring service schedules for the loaded organisations are included');
});

test.each([
    { recentRuns: [run(), run({ id: 'same-date', status: 'completed' })] },
    { recentRuns: [run(), run({ id: 'invalid-date', scheduledFor: '2026-02-30T00:00:00.000Z', status: 'completed' })] }
])('invalid or tied included run dates cannot silently produce a latest-completed claim', async ({ recentRuns }) => {
    const h = await render(bootstrap({ customerControls: { schedules: [schedule()], recentRuns } }));
    expect(facts(rows(h)[0])['Latest included run']).toBe('Unavailable: included run dates are invalid or ambiguous');
    expect(facts(rows(h)[0])).not.toHaveProperty('Run scheduled for (UTC)');
});

test('unknown retained vocabularies remain unknown and markup stays inert text', async () => {
    const displayName = '<img src=x onerror=alert(1)> & <script>bad()</script>';
    const h = await render(bootstrap({ organisations: [organisation('org-a', displayName)], customerControls: {
        schedules: [schedule({ enabled: 'yes', cadence: 'weekly', jobType: '__proto__' })],
        recentRuns: [run({ jobType: '__proto__', status: 'verified' })]
    } }));
    expect(rows(h)[0].children[0].textContent).toBe(displayName + ' · Service control');
    expect(facts(rows(h)[0])).toMatchObject({ 'Schedule state': 'Unknown', 'Recorded cadence': 'Unknown', 'Latest included run': 'Unknown' });
    for (const tag of ['img', 'script', 'svg', 'iframe', 'a']) expect(h.section.querySelectorAll(tag)).toEqual([]);
});

test.each([undefined, {}, { schedules: [], recentRuns: null }, { schedules: {}, recentRuns: [] }])(
    'unavailable snapshot %p is not described as an empty schedule history', async customerControls => {
        const h = await render(bootstrap({ customerControls }));
        expect(h.section.textContent).toContain('records are unavailable in this snapshot');
        expect(rows(h)).toEqual([]);
    }
);

test('an empty snapshot and bounded schedule/run pages do not claim complete historical coverage', async () => {
    const empty = await render(bootstrap({ customerControls: { schedules: [], recentRuns: [] } }));
    expect(empty.section.textContent).toContain('No recurring service schedules for the loaded organisations are included');
    const h = await render(bootstrap({ customerControls: {
        schedules: Array.from({ length: 201 }, (_, i) => schedule({ id: 'schedule-' + i })),
        recentRuns: [...Array.from({ length: 100 }, (_, i) => run({ scheduleId: 'unrelated-' + i })),
            run({ scheduleId: 'schedule-0', status: 'completed' })]
    } }));
    expect(rows(h)).toHaveLength(200);
    expect(facts(rows(h)[0])['Latest included run']).toBe('No run included in this snapshot');
    expect(h.section.textContent).toContain('Older records may not be included');
});

test('a denied bootstrap does not render schedules or make another data request', async () => {
    const h = await render({ error: 'Access is unavailable' }, 403);
    expect(h.section).toBeNull(); expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.loadingStatus.textContent).toBe('Access is unavailable');
});
