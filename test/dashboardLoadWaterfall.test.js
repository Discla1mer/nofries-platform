'use strict';

// D-013: deterministic network-wave budget, not a production latency benchmark.
// Real loader, shell, assessment client and views; synthetic DOM, GETs and clock.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createDom } = require('./fixtures/dashboardDom');
const { fixture } = require('./fixtures/dashboardFixture');
const { projectDashboard } = require('../api/shared/appLifecycle/dashboardProjection');
const { createNcscQuestionnaireMetadata } = require('../api/shared/ncscQuestionnaireMetadata');
const shell = require('../api/shared/protectedAssets/dashboardShell');
const client = require('../api/shared/protectedAssets/ncscAssessmentClient');
const questionnaire = require('../api/shared/protectedAssets/ncscQuestionnaire');
const picture = require('../api/shared/protectedAssets/organisationPicture');
const source = fs.readFileSync(process.env.NOFRIES_LOAD_WATERFALL_SOURCE || path.join(__dirname, '../js/dashboard-loader.js'), 'utf8');
const NOW = '2026-11-11T00:00:00.000Z', BINDING = '10000000-0000-4000-8000-000000000001', GENERATION = 'a'.repeat(64);
const SESSION = '/api/dashboard/session', DIRECTORY = '/api/dashboard/organisations?limit=50', BOOTSTRAP = '/api/dashboard/bootstrap';
const SCRIPT = '/api/dashboard/app.js?v=' + 'A'.repeat(43), STYLE = '/api/dashboard/dashboard.css?v=' + 'A'.repeat(43), MODULE = '/api/dashboard/modules/cyber_security';
const LIST = '/api/dashboard/ncsc/assessments';
const READ = LIST + '/assessment-latest';
const PLANS = '/api/dashboard/improvement/plans?limit=5';
const PLAN_LIST = planId => '/api/dashboard/improvement/list?planId=' + planId;
const delays = { [SESSION]: 70, [DIRECTORY]: 100, [BOOTSTRAP]: 180, [SCRIPT]: 80, [STYLE]: 130, [MODULE]: 90, [LIST]: 110, [READ]: 95 };
const ids = ['dashboardEntry', 'dashboardStatusPanel', 'dashboardHeading', 'dashboardMessage', 'dashboardStatus', 'dashboardRetry',
    'dashboardSignIn', 'dashboardSignOut', 'dashboardChooser', 'dashboardChoices', 'dashboardMore', 'dashboardApp',
    'dashboardApplicationIntegrity', 'dashboardStyleIntegrity'];

function harness(route, failure, warm = false, store = null, cyberState = 'ready', saved = null, plans = null) {
    const { document, window } = createDom(), started = Date.now(), trace = [], mounts = [];
    const elements = Object.fromEntries(ids.map(id => [id, document.createElement('div')]));
    document.body = document.createElement('body'); document.head = document.createElement('head');
    document.body.dataset = { page: 'operator-dashboard', customerProvider: 'staff' };
    document.body.append(elements.dashboardEntry);
    elements.dashboardEntry.append(elements.dashboardStatusPanel, elements.dashboardChooser, elements.dashboardApp);
    document.getElementById = id => elements[id] || null;
    document.querySelectorAll = selector => document.body.querySelectorAll(selector);
    document.querySelector = selector => document.body.querySelector(selector);
    for (const id of ['dashboardApplicationIntegrity', 'dashboardStyleIntegrity']) elements[id].setAttribute('content', 'sha256-' + 'A'.repeat(43) + '=');
    window.location.hash = '#' + route; window.location.search = '';
    window.setTimeout = setTimeout; window.clearTimeout = clearTimeout;
    if (store) window.localStorage = { getItem: key => store.has(key) ? store.get(key) : null,
        setItem: (key, value) => { store.set(key, String(value)); }, removeItem: key => { store.delete(key); } };
    const model = JSON.parse(JSON.stringify(projectDashboard(fixture({ now: NOW }))));
    model.modules.find(item => item.key === 'cyber_security').state = cyberState;
    if (plans) model.modules.find(item => item.key === 'improvement_plan').state = 'ready';
    const session = { schemaVersion: 1, authenticated: true, purpose: 'operator_dashboard', generation: GENERATION,
        selectedBindingId: BINDING, expiresAt: '2026-11-11T01:00:00.000Z' };
    const payloads = { [SESSION]: session, [DIRECTORY]: { schemaVersion: 1, bindings: [{ bindingId: BINDING, organisationLabel: 'Synthetic organisation' }], nextAfterBindingId: null },
        [BOOTSTRAP]: model, [MODULE]: { schemaVersion: 1, context: model.context, generatedAt: model.generatedAt,
            module: model.modules.find(item => item.key === 'cyber_security'), summary: { state: 'empty', attention: [], metrics: [] },
            services: [], admissionGranted: false, providerAccessGranted: false, metadata: createNcscQuestionnaireMetadata(), presentationMode: 'editable' },
        [LIST]: { schemaVersion: 1, assessments: saved ? [saved.summary] : [], nextAfterAssessmentId: null },
        [READ]: saved ? { schemaVersion: 1, assessment: saved.detail } : { code: 'dashboard_not_found' } };
    const timing = { ...delays };
    if (plans) {
        payloads[PLANS] = { schemaVersion: 1, plans: plans.index, nextAfterPlanId: null }; timing[PLANS] = 100;
        for (const [planId, list] of Object.entries(plans.lists)) { payloads[PLAN_LIST(planId)] = list; timing[PLAN_LIST(planId)] = 80; }
    }
    function schedule(url, options, deliver) {
        const key = url.startsWith(LIST + '?') ? LIST : url;
        if (!Object.hasOwn(timing, key)) throw new Error('Unexpected request: ' + url);
        const event = { url: key, start: Date.now() - started, options }; trace.push(event);
        setTimeout(() => { event.end = Date.now() - started; deliver(key); }, warm && [SCRIPT, STYLE].includes(key) ? 0 : timing[key]);
    }
    const fetch = (url, options) => new Promise(resolve => schedule(url, options, key => {
        const denied = failure === key && (key !== SESSION || trace.filter(row => row.url === SESSION).length === 2);
        const missing = key === READ && !saved || payloads[key] === null;
        const value = denied ? { code: 'dashboard_access_denied' } : payloads[key];
        resolve({ status: denied ? 403 : missing ? 404 : 200, ok: !denied && !missing, redirected: false, type: 'basic',
            headers: { get: name => name.toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null },
            json: async () => value, text: async () => JSON.stringify(value) });
    }));
    document.head.append = node => {
        node.parentNode = document.head; document.head.children.push(node);
        schedule(node.src || node.href, null, key => {
            if (key === SCRIPT) {
                window.NoFriesDashboard = { validate: shell.validate, mount: (...args) => {
                    mounts.push(Date.now() - started); return shell.mount(...args);
                } };
                window.NoFriesNcscAssessmentClient = { createClient: input => client.createClient({
                    metadata: JSON.parse(JSON.stringify(input.metadata)), fetch: input.fetch }) };
                window.NoFriesNcscQuestionnaire = questionnaire; window.NoFriesOrganisationPicture = picture;
                if (plans) window.NoFriesImprovementActionPlanClient = { mount: () => ({ destroy() {} }) };
            }
            if (node.onload) node.onload();
        });
    };
    document.head.removeChild = node => { document.head.children = document.head.children.filter(item => item !== node); node.parentNode = null; };
    vm.runInNewContext(source, { document, window, fetch, AbortController, Date, console }, { filename: 'dashboard-loader.js' });
    return { document, window, elements, trace, mounts };
}

beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(new Date(NOW)); });
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

// Five waves: session -> directory + projection -> assets + Cyber Security module -> closing session witness -> saved list.
// #343 starts the module read as soon as the projection lists it ready, beside the protected assets, so mount is at
// 450 ms (was 540 ms with a separate module wave). Assets still wait for both middle reads; nothing mounts before the witness.
test.each(['overview', 'cyber-security'])('%s reaches saved data in five controlled network waves', async route => {
    const h = harness(route);
    await jest.advanceTimersByTimeAsync(449);
    expect(h.mounts).toEqual([]);
    await jest.advanceTimersByTimeAsync(1);
    expect(h.mounts).toEqual([450]);
    expect(h.trace.map(({ url, start }) => [url, start])).toEqual([
        [SESSION, 0], [DIRECTORY, 70], [BOOTSTRAP, 70], [MODULE, 250], [SCRIPT, 250], [STYLE, 250], [SESSION, 380], [LIST, 450]
    ]);
    await jest.advanceTimersByTimeAsync(109);
    expect(h.elements.dashboardApp.textContent).not.toContain('No saved assessments yet.');
    await jest.advanceTimersByTimeAsync(1);
    expect(h.trace.at(-1).end).toBe(560);
    expect(h.document.body.dataset.dashboardState).toBe('ready');
    expect(h.elements.dashboardApp.textContent).toContain('No saved assessments yet.');
    expect(h.elements.dashboardApp.textContent).not.toMatch(/Loading saved|Loading assessment/);
    // Idle must not silently re-fetch or make a mutation.
    await jest.advanceTimersByTimeAsync(1000);
    expect(h.trace).toHaveLength(8);
    for (const row of h.trace.filter(item => item.options)) {
        expect(row.options).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
        expect(row.options.body).toBeUndefined();
        if ([BOOTSTRAP, MODULE, LIST].includes(row.url)) expect(row.options.headers['X-NoFries-Dashboard-Generation']).toBe(GENERATION);
    }
    h.window.dispatch('pagehide');
});

test.each([BOOTSTRAP, MODULE, SESSION])('the wave budget never skips a denied %s', async failure => {
    const h = harness('overview', failure);
    await jest.advanceTimersByTimeAsync(1000);
    expect(h.mounts).toEqual([]);
    expect(h.trace.some(row => row.url === LIST)).toBe(false);
    expect(h.document.body.dataset.dashboardState).toBe('denied');
    if (failure === BOOTSTRAP) expect(h.trace.some(row => row.url === SCRIPT || row.url === STYLE)).toBe(false);
    h.window.dispatch('pagehide');
});

// Cache-hit model: only static bytes become local; all authentication/data waves remain.
test.each(['overview', 'cyber-security'])('%s warm assets preserve the closing witness and save one asset wait', async route => {
    const h = harness(route, null, true);
    await jest.advanceTimersByTimeAsync(409);
    expect(h.mounts).toEqual([]);
    await jest.advanceTimersByTimeAsync(111);
    expect(h.mounts).toEqual([410]);
    expect(h.trace.filter(row => row.url === SESSION)).toHaveLength(2);
    expect(h.trace.find(row => row.url === LIST).end).toBe(520);
    h.window.dispatch('pagehide');
});

// D-013: a browser that last opened this organisation with Cyber Security ready starts the module read beside the
// projection, one round trip earlier. With cached assets the shell mounts at 321 ms (was 410 ms). The witness is unchanged.
describe('remembered Cyber Security hint', () => {
    const HINT = 'nofries-dashboard-cyber-ready';
    test('a first visit keeps the original waves and records the hint after mounting', async () => {
        const store = new Map(), h = harness('overview', null, true, store);
        await jest.advanceTimersByTimeAsync(600);
        expect(h.trace.find(row => row.url === MODULE).start).toBe(250);
        expect(h.mounts).toEqual([410]);
        expect(store.get(HINT)).toBe(BINDING);
        h.window.dispatch('pagehide');
    });
    test('a repeat visit reads the module beside the projection and still waits for the closing witness', async () => {
        const h = harness('overview', null, true, new Map([[HINT, BINDING]]));
        await jest.advanceTimersByTimeAsync(320);
        expect(h.mounts).toEqual([]);
        await jest.advanceTimersByTimeAsync(300);
        expect(h.mounts).toEqual([321]);
        expect(h.trace.map(({ url, start }) => [url, start])).toEqual([
            [SESSION, 0], [DIRECTORY, 70], [BOOTSTRAP, 70], [MODULE, 70], [SCRIPT, 250], [STYLE, 250], [SESSION, 251], [LIST, 321]
        ]);
        expect(h.trace.filter(row => row.url === MODULE)).toHaveLength(1);
        expect(h.document.body.dataset.dashboardState).toBe('ready');
        h.window.dispatch('pagehide');
    });
    test('a hint for another organisation is ignored', async () => {
        const h = harness('overview', null, true, new Map([[HINT, '00000000-0000-4000-8000-000000000009']]));
        await jest.advanceTimersByTimeAsync(600);
        expect(h.trace.find(row => row.url === MODULE).start).toBe(250);
        h.window.dispatch('pagehide');
    });
    test('an early read is discarded and the hint cleared when the projection no longer lists the module ready', async () => {
        const store = new Map([[HINT, BINDING]]), h = harness('overview', null, true, store, 'planned');
        await jest.advanceTimersByTimeAsync(600);
        expect(h.trace.filter(row => row.url === MODULE)).toHaveLength(1);
        expect(h.mounts).toHaveLength(1);
        expect(h.trace.some(row => row.url === LIST)).toBe(false);
        expect(store.has(HINT)).toBe(false);
        h.window.dispatch('pagehide');
    });
    test('the hint is dropped with the last-organisation hint when the session is refused', async () => {
        const store = new Map([[HINT, BINDING], ['nofries-dashboard-last-organisation', BINDING]]);
        const loader = fs.readFileSync(path.join(__dirname, '../js/dashboard-loader.js'), 'utf8');
        const forget = loader.slice(loader.indexOf('function forgetLastOrganisation()'), loader.indexOf('if (hasDirectorySearch)'));
        expect(forget).toContain('store.removeItem(LAST_ORGANISATION_KEY)');
        expect(forget).toContain('store.removeItem(CYBER_READY_KEY)');
        expect(store.size).toBe(2);
    });
    test('a denied early read still denies the dashboard', async () => {
        const h = harness('overview', MODULE, true, new Map([[HINT, BINDING]]));
        await jest.advanceTimersByTimeAsync(1000);
        expect(h.mounts).toEqual([]);
        expect(h.document.body.dataset.dashboardState).toBe('denied');
        h.window.dispatch('pagehide');
    });
});

// D-013: a browser that last saw this organisation's Overview remembers which assessment was shown by default and
// reads it beside the list, not after it. The fresh list still decides what is shown.
describe('remembered Overview assessment hint', () => {
    const { ncscFixture, allResponses, createCommand, saveCommand, submitCommand, SUBJECT } = require('./fixtures/ncscAssessmentFixture');
    const { makeVersion } = require('../api/shared/assessmentLifecycle/postgresNcscAssessmentStore');
    const { projectNcscSummary, projectNcscDetail } = require('../api/shared/ncscAssessmentService');
    const HINT = 'nofries-dashboard-picture-latest', CYBER = 'nofries-dashboard-cyber-ready';
    function saved() {
        const model = projectDashboard(fixture({ now: NOW }));
        const tenant = ncscFixture({ now: NOW, organisationId: model.context.organisationId }), id = 'assessment-latest';
        let version = null;
        for (const command of [createCommand(id, 'create-latest', 'Synthetic scope.'), saveCommand(id, 0, 'save-latest', allResponses()),
            submitCommand(id, 1, 'submit-latest')]) {
            version = makeVersion({ ...tenant.scope, actorSubjectKey: SUBJECT, assessmentId: id, action: command.action,
                expectedRevision: command.expectedRevision, payload: command.payload }, command.idempotencyKey, version, tenant.state.tenantAggregate, NOW);
        }
        return JSON.parse(JSON.stringify({ summary: projectNcscSummary(version), detail: projectNcscDetail(version) }));
    }
    const starts = h => h.trace.filter(row => [LIST, READ].includes(row.url)).map(({ url, start }) => [url, start]);
    test('a first visit reads the assessment after the list and remembers the default choice', async () => {
        const store = new Map([[CYBER, BINDING]]), h = harness('overview', null, true, store, 'ready', saved());
        await jest.advanceTimersByTimeAsync(1000);
        expect(starts(h)).toEqual([[LIST, 321], [READ, 431]]);
        expect(h.elements.dashboardApp.textContent).toContain('Source and calculation details');
        expect(store.get(HINT)).toBe(BINDING + ' assessment-latest');
        h.window.dispatch('pagehide');
    });
    test('a repeat visit reads the assessment beside the list and shows it one round trip earlier', async () => {
        const h = harness('overview', null, true, new Map([[CYBER, BINDING], [HINT, BINDING + ' assessment-latest']]), 'ready', saved());
        await jest.advanceTimersByTimeAsync(431);
        expect(starts(h)).toEqual([[LIST, 321], [READ, 321]]);
        expect(h.elements.dashboardApp.textContent).toContain('Source and calculation details');
        await jest.advanceTimersByTimeAsync(600);
        expect(h.trace.filter(row => row.url === READ)).toHaveLength(1);
        const read = h.trace.find(row => row.url === READ);
        expect(read.options).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
        expect(read.options.headers['X-NoFries-Dashboard-Generation']).toBe(GENERATION);
        h.window.dispatch('pagehide');
    });
    test('a hint for another organisation is ignored', async () => {
        const store = new Map([[CYBER, BINDING], [HINT, '00000000-0000-4000-8000-000000000009 assessment-latest']]);
        const h = harness('overview', null, true, store, 'ready', saved());
        await jest.advanceTimersByTimeAsync(1000);
        expect(starts(h)).toEqual([[LIST, 321], [READ, 431]]);
        h.window.dispatch('pagehide');
    });
    test('a hint for an assessment that no longer exists costs one refused read and changes nothing shown', async () => {
        const h = harness('overview', null, true, new Map([[CYBER, BINDING], [HINT, BINDING + ' assessment-latest']]));
        await jest.advanceTimersByTimeAsync(1000);
        expect(starts(h)).toEqual([[LIST, 321], [READ, 321]]);
        expect(h.document.body.dataset.dashboardState).toBe('ready');
        expect(h.elements.dashboardApp.textContent).toContain('No saved assessments yet.');
        h.window.dispatch('pagehide');
    });
    test.each(['assessment latest', '../x', ''])('a malformed stored hint %j is ignored', async value => {
        const h = harness('overview', null, true, new Map([[CYBER, BINDING], [HINT, BINDING + ' ' + value]]), 'ready', saved());
        await jest.advanceTimersByTimeAsync(1000);
        expect(starts(h)).toEqual([[LIST, 321], [READ, 431]]);
        h.window.dispatch('pagehide');
    });
    test('the hint is dropped with the other remembered hints', () => {
        const loader = fs.readFileSync(path.join(__dirname, '../js/dashboard-loader.js'), 'utf8');
        const forget = loader.slice(loader.indexOf('function forgetLastOrganisation()'), loader.indexOf('if (hasDirectorySearch)'));
        expect(forget).toContain('store.removeItem(PICTURE_LATEST_KEY)');
    });
});

// D-013: the Overview Actions card read the plan index and then each plan's action list. A browser that has
// seen the card remembers the plan IDs and reads those lists beside the index. The fresh index still decides.
describe('remembered Overview action plans hint', () => {
    const KEY = 'nofries-dashboard-action-plans', CYBER = 'nofries-dashboard-cyber-ready';
    const list = (planId, planRevision) => ({ schemaVersion: 1, scope: { planId }, planRevision, asOf: NOW, summary: {}, actions: [] });
    const two = () => ({ index: [{ planId: 'plan-a', planRevision: 3 }, { planId: 'plan-b', planRevision: 1 }],
        lists: { 'plan-a': list('plan-a', 3), 'plan-b': list('plan-b', 1) } });
    const starts = h => h.trace.filter(row => row.url.startsWith('/api/dashboard/improvement/')).map(({ url, start }) => [url, start]);
    const open = (store, plans) => harness('overview', null, true, store, 'ready', null, plans);

    test('a first visit reads the lists after the index and remembers the plans', async () => {
        const store = new Map([[CYBER, BINDING]]), h = open(store, two());
        await jest.advanceTimersByTimeAsync(1000);
        expect(starts(h)).toEqual([[PLANS, 321], [PLAN_LIST('plan-a'), 421], [PLAN_LIST('plan-b'), 421]]);
        expect(store.get(KEY)).toBe(BINDING + ' plan-a plan-b');
        expect(h.document.body.dataset.dashboardState).toBe('ready');
        h.window.dispatch('pagehide');
    });
    test('a repeat visit reads the lists beside the index and does not read them again', async () => {
        const h = open(new Map([[CYBER, BINDING], [KEY, BINDING + ' plan-a plan-b']]), two());
        await jest.advanceTimersByTimeAsync(1000);
        expect(starts(h)).toEqual([[PLAN_LIST('plan-a'), 321], [PLAN_LIST('plan-b'), 321], [PLANS, 321]]);
        const read = h.trace.find(row => row.url === PLAN_LIST('plan-a'));
        expect(read.options).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
        expect(read.options.headers['X-NoFries-Dashboard-Generation']).toBe(GENERATION);
        h.window.dispatch('pagehide');
    });
    test('an early list at a different revision from the fresh index is read again', async () => {
        const plans = two(); plans.index[0].planRevision = 4;
        const h = open(new Map([[CYBER, BINDING], [KEY, BINDING + ' plan-a plan-b']]), plans);
        await jest.advanceTimersByTimeAsync(1000);
        expect(starts(h)).toEqual([[PLAN_LIST('plan-a'), 321], [PLAN_LIST('plan-b'), 321], [PLANS, 321], [PLAN_LIST('plan-a'), 421]]);
        h.window.dispatch('pagehide');
    });
    test('an early list that answers for another plan is not used', async () => {
        const plans = two(); plans.lists['plan-a'] = list('plan-b', 3);
        const h = open(new Map([[CYBER, BINDING], [KEY, BINDING + ' plan-a']]), plans);
        await jest.advanceTimersByTimeAsync(1000);
        expect(starts(h).filter(([url]) => url === PLAN_LIST('plan-a')).map(([, at]) => at)).toEqual([321, 421]);
        h.window.dispatch('pagehide');
    });
    test('a remembered plan that no longer exists costs one refused read; the hint follows the fresh index', async () => {
        const plans = { index: [{ planId: 'plan-b', planRevision: 1 }], lists: { 'plan-a': null, 'plan-b': list('plan-b', 1) } };
        const store = new Map([[CYBER, BINDING], [KEY, BINDING + ' plan-a']]), h = open(store, plans);
        await jest.advanceTimersByTimeAsync(1000);
        expect(starts(h)).toEqual([[PLAN_LIST('plan-a'), 321], [PLANS, 321], [PLAN_LIST('plan-b'), 421]]);
        expect(store.get(KEY)).toBe(BINDING + ' plan-b');
        expect(h.document.body.dataset.dashboardState).toBe('ready');
        h.window.dispatch('pagehide');
    });
    test('no plans clears the hint', async () => {
        const store = new Map([[CYBER, BINDING], [KEY, BINDING + ' plan-a']]);
        const h = open(store, { index: [], lists: { 'plan-a': null } });
        await jest.advanceTimersByTimeAsync(1000);
        expect(store.has(KEY)).toBe(false);
        h.window.dispatch('pagehide');
    });
    test.each([
        ['another organisation', '00000000-0000-4000-8000-000000000009 plan-a plan-b'],
        ['a malformed plan ID', BINDING + ' plan-a ../x'],
        ['a repeated plan ID', BINDING + ' plan-a plan-a'],
        ['more plans than the card reads', BINDING + ' a b c d e f']
    ])('a hint for %s is ignored', async (_name, value) => {
        const h = open(new Map([[CYBER, BINDING], [KEY, value]]), two());
        await jest.advanceTimersByTimeAsync(1000);
        expect(starts(h)).toEqual([[PLANS, 321], [PLAN_LIST('plan-a'), 421], [PLAN_LIST('plan-b'), 421]]);
        h.window.dispatch('pagehide');
    });
    test('the hint is dropped with the other remembered hints', () => {
        const loader = fs.readFileSync(path.join(__dirname, '../js/dashboard-loader.js'), 'utf8');
        const forget = loader.slice(loader.indexOf('    function forgetLastOrganisation()'), loader.indexOf('if (hasDirectorySearch)'));
        expect(forget).toContain('store.removeItem(ACTION_PLANS_KEY)');
    });
});
