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

function runHome(fetch) {
    const document = { addEventListener() {}, getElementById() { return null; }, querySelectorAll() { return []; } };
    vm.runInNewContext(read('js/home.js'), { document, window: fetch === undefined ? undefined : { fetch } });
}

test('browser and server steps together cover the allow-list exactly once', () => {
    expect([...BROWSER_EVENTS, ...SERVER_EVENTS].sort()).toEqual([...FUNNEL_EVENTS].sort());
});

test('the homepage sends one visit count to the same origin without cookies, referrer or identifiers', async () => {
    const fetch = jest.fn(async () => ({ ok: true, status: 204 }));
    runHome(fetch);
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe('/api/telemetry');
    expect(options).toEqual({ method: 'POST', keepalive: true, credentials: 'omit', mode: 'same-origin', cache: 'no-store',
        redirect: 'error', referrerPolicy: 'no-referrer', headers: { 'Content-Type': 'application/json' }, body: '{"event":"visit"}' });
});

test('the homepage still works without fetch, or when fetch throws or rejects', async () => {
    expect(() => runHome(undefined)).not.toThrow();
    expect(() => runHome(() => { throw new Error('blocked'); })).not.toThrow();
    expect(() => runHome(() => Promise.reject(new Error('offline')))).not.toThrow();
    await flush();
});

test('every browser count helper uses only the relative same-origin endpoint', () => {
    for (const file of ['js/home.js', 'js/organisation-setup.js', 'js/dashboard-loader.js']) {
        const source = read(file);
        expect(source).toContain("window.fetch('/api/telemetry', { method: 'POST', keepalive: true, credentials: 'omit', mode: 'same-origin',");
        expect(source).not.toMatch(/sendBeacon|https?:\/\/[^'"\s]*telemetry/);
    }
});

test('the dashboard passes its count helper to the questionnaire', () => {
    expect(read('js/dashboard-loader.js')).toMatch(/questionnaire\.mount\(root, \{[\s\S]*?onFunnelStep: funnelStep,/);
});

test('connect-src allows the same origin on the public pages and the dashboard', () => {
    const config = JSON.parse(read('staticwebapp.config.json'));
    expect(config.globalHeaders['Content-Security-Policy']).toMatch(/connect-src 'self'/);
    expect(read('server.js')).toMatch(/const publicContentSecurityPolicy = "[^"]*connect-src 'self'/);
    const document = buildDashboardDocument({ template: read('app/dashboard.html'), loaderSource: 'void 0;',
        protectedAppSource: 'void 0;', protectedStyleSource: 'a{}' });
    expect(document.contentSecurityPolicy).toMatch(/connect-src 'self'/);
});
