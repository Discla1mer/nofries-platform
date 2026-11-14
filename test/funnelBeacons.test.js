'use strict';

// #151 F4: browser counts for the steps the server cannot see. Same-origin
// only, no cookies, no identifiers, at most once per step per page view.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { FUNNEL_EVENTS } = require('../api/shared/funnelCounts');
const { buildDashboardDocument } = require('../lib/dashboardDocument');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const flush = async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); };
const BROWSER_EVENTS = ['visit', 'signup_started', 'first_answer', 'result_viewed'];
// Counted by their own server handlers instead (slice F3).
const SERVER_EVENTS = ['code_confirmed', 'submitted', 'enquiry_sent'];

function runHome({ funnel, fetch, navigator, doNotTrack }) {
    const enquiry = { hidden: true };
    const document = { body: { dataset: { page: 'dashboard-home' } }, getElementById: id => id === 'homepageEnquiry' ? enquiry : null };
    const window = { fetch, navigator, doNotTrack, enquiryAvailability: async () => ({ available: true, promote: false, ...(funnel ? { funnel: true } : {}) }) };
    vm.runInNewContext(read('js/enquiry-home.js'), { document, window });
}
test('browser and server steps together cover the allow-list exactly once', () => {
    expect([...BROWSER_EVENTS, ...SERVER_EVENTS].sort()).toEqual([...FUNNEL_EVENTS].sort());
});

test('flag off: the homepage sends no visit count', async () => {
    const fetch = jest.fn(async () => ({ ok: true, status: 204 }));
    runHome({ funnel: false, fetch });
    await flush();
    expect(fetch).not.toHaveBeenCalled();
});

test('flag on: the homepage sends one visit count to the same origin without cookies, referrer or identifiers', async () => {
    const fetch = jest.fn(async () => ({ ok: true, status: 204 }));
    runHome({ funnel: true, fetch });
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe('/api/telemetry');
    expect(options).toEqual({ method: 'POST', keepalive: true, credentials: 'omit', mode: 'same-origin', cache: 'no-store',
        redirect: 'error', referrerPolicy: 'no-referrer', headers: { 'Content-Type': 'application/json' }, body: '{"event":"visit"}' });
});

test.each([
    ['Global Privacy Control', { navigator: { globalPrivacyControl: true } }],
    ['navigator Do Not Track', { navigator: { doNotTrack: '1' } }],
    ['window Do Not Track', { doNotTrack: '1' }]
])('flag on with %s: the homepage sends no visit count', async (_name, signal) => {
    const fetch = jest.fn(async () => ({ ok: true, status: 204 }));
    runHome({ funnel: true, fetch, ...signal });
    await flush();
    expect(fetch).not.toHaveBeenCalled();
    runHome({ funnel: true, fetch, navigator: { globalPrivacyControl: false, doNotTrack: '0' } });
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);
});

test('the dashboard and signup helpers check Global Privacy Control and Do Not Track before sending', () => {
    for (const file of ['js/dashboard-loader.js', 'js/organisation-setup.js']) {
        expect(read(file)).toMatch(/if \(funnelPrivacySignal\(\)\) return;/);
        expect(read(file)).toContain("nav.globalPrivacyControl === true || nav.doNotTrack === '1') || window.doNotTrack === '1'");
    }
});

test('the homepage still works when fetch is missing, throws or rejects', async () => {
    runHome({ funnel: true, fetch: undefined });
    runHome({ funnel: true, fetch: () => { throw new Error('blocked'); } });
    runHome({ funnel: true, fetch: () => Promise.reject(new Error('offline')) });
    await flush();
});

test('enquiry availability reports the marker only when the server sent it', async () => {
    for (const [header, expected] of [[null, { available: true, promote: false }], ['on', { available: true, promote: false, funnel: true }]]) {
        const window = {};
        const fetch = async () => ({ ok: true, headers: { get: name => name === 'x-nofries-funnel' ? header : null },
            json: async () => ({ available: true, promote: false }) });
        vm.runInNewContext(read('js/enquiry-availability.js'), { window, fetch, AbortController, setTimeout, clearTimeout });
        expect(await window.enquiryAvailability()).toEqual(expected);
    }
});

describe('server marker', () => {
    const request = require('supertest');
    afterEach(() => { delete process.env.NOFRIES_FUNNEL_COUNTS_ENABLED; });
    test.each([[undefined, undefined], ['TRUE', undefined], ['true', 'on']])('flag %s gives marker %s on API responses', async (flag, marker) => {
        if (flag === undefined) delete process.env.NOFRIES_FUNNEL_COUNTS_ENABLED; else process.env.NOFRIES_FUNNEL_COUNTS_ENABLED = flag;
        const app = require('../server').createNoFriesApp();
        const response = await request(app).get('/api/enquiry');
        expect(response.headers['x-nofries-funnel']).toBe(marker);
        expect((await request(app).get('/')).headers['x-nofries-funnel']).toBeUndefined();
    });
});

test('every browser count helper uses only the relative same-origin endpoint', () => {
    for (const file of ['js/enquiry-home.js', 'js/organisation-setup.js', 'js/dashboard-loader.js']) {
        const source = read(file);
        expect(source).toContain("window.fetch('/api/telemetry', { method: 'POST', keepalive: true, credentials: 'omit', mode: 'same-origin',");
        expect(source).not.toMatch(/sendBeacon|https?:\/\/[^'"\s]*telemetry/);
    }
});

test('the dashboard passes its count helper to the questionnaire and arms it only from a marked API response', () => {
    const source = read('js/dashboard-loader.js');
    expect(source).toMatch(/questionnaire\.mount\(root, \{[\s\S]*?onFunnelStep: funnelStep,/);
    expect(source).toMatch(/'X-NoFries-Dashboard-Generation': snapshot\.generation \}\) \}\)\);\n\s*funnelMarked\(result\);/);
    expect(source).toMatch(/if \(!funnelOn \|\| funnelOff/);
});

describe('managed signup document', () => {
    const { buildSignupDocument } = require('../lib/signupDocument');
    const { createDom } = require('./fixtures/dashboardDom');
    const sources = () => ({ clientSource: read('api/shared/customerSignup/signupClient.js'),
        journeySource: read('api/shared/customerSignup/signupJourney.js') });
    async function run(search, marker, navigator = {}) {
        const { runtime } = buildSignupDocument({ ...sources(), customerLogin: true, customerTransport: 'external' });
        const dom = createDom(), create = dom.document.createElement;
        dom.document.createElement = tag => Object.assign(create(tag), { style: {} });
        dom.document.getElementById = id => id === 'signup' ? dom.root : null;
        const fetch = jest.fn(async url => url === '/api/telemetry' ? new Response(null, { status: 204 }) :
            new Response(JSON.stringify({ state: { status: 'create_account' }, csrfToken: 'x'.repeat(43) }),
                { status: 200, headers: { 'content-type': 'application/json', ...(marker ? { 'x-nofries-funnel': 'on' } : {}) } }));
        const replace = jest.fn();
        vm.runInNewContext(runtime, { document: dom.document, window: { fetch, navigator, location: { search, hash: '', assign: jest.fn(), replace },
            history: { replaceState() {} }, addEventListener() {} }, AbortController, URLSearchParams, TextDecoder, setTimeout, clearTimeout });
        for (let i = 0; i < 5; i += 1) await new Promise(setImmediate);
        return { fetch, replace };
    }

    test('flag on: Create account sends one signup_started count', async () => {
        const { fetch } = await run('?intent=create', true);
        const counts = fetch.mock.calls.filter(([url]) => url === '/api/telemetry');
        expect(counts).toHaveLength(1);
        expect(counts[0][1]).toMatchObject({ method: 'POST', keepalive: true, credentials: 'omit', body: '{"event":"signup_started"}' });
    });

    test.each([['flag off', '?intent=create', false, {}], ['no create intent', '', true, {}],
        ['Global Privacy Control', '?intent=create', true, { globalPrivacyControl: true }],
        ['Do Not Track', '?intent=create', true, { doNotTrack: '1' }]])('%s: no count', async (_name, search, marker, navigator) => {
        const { fetch } = await run(search, marker, navigator);
        expect(fetch.mock.calls.map(([url]) => url)).not.toContain('/api/telemetry');
    });
});

test('SWA lets anonymous visitors POST counts, and only POST, to the exact telemetry path', () => {
    const config = JSON.parse(read('staticwebapp.config.json'));
    const edgeRule = (pathname, method) => config.routes.find(rule => (!rule.methods || rule.methods.includes(method)) &&
        (rule.route === pathname || rule.route.endsWith('*') && pathname.startsWith(rule.route.slice(0, -1))));
    const rule = edgeRule('/api/telemetry', 'POST');
    expect(rule).toEqual({ route: '/api/telemetry', methods: ['POST'], allowedRoles: ['anonymous'], headers: {
        'Cache-Control': 'private, no-store, max-age=0', 'X-Robots-Tag': 'noindex, nofollow',
        'Content-Security-Policy': "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" } });
    expect(config.routes.indexOf(rule)).toBeLessThan(config.routes.findIndex(item => item.route === '/api/*'));
    for (const method of ['GET', 'PUT', 'DELETE']) expect(edgeRule('/api/telemetry', method)).toMatchObject({ route: '/api/*', allowedRoles: ['authenticated'] });
    expect(edgeRule('/api/telemetry/x', 'POST')).toMatchObject({ route: '/api/*', allowedRoles: ['authenticated'] });
});

test('connect-src allows the same origin on the public pages and the dashboard', () => {
    const config = JSON.parse(read('staticwebapp.config.json'));
    expect(config.globalHeaders['Content-Security-Policy']).toMatch(/connect-src 'self'/);
    expect(read('server.js')).toMatch(/const publicContentSecurityPolicy = "[^"]*connect-src 'self'/);
    const document = buildDashboardDocument({ template: read('app/dashboard.html'), loaderSource: 'void 0;',
        protectedAppSource: 'void 0;', protectedStyleSource: 'a{}' });
    expect(document.contentSecurityPolicy).toMatch(/connect-src 'self'/);
});
