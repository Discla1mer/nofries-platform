'use strict';

const fs = require('node:fs');
const vm = require('node:vm');
const { buildSignupDocument } = require('../lib/signupDocument');
const { createDom } = require('./fixtures/dashboardDom');

const documentBundle = () => buildSignupDocument({
    clientSource: fs.readFileSync('api/shared/customerSignup/signupClient.js', 'utf8'),
    journeySource: fs.readFileSync('api/shared/customerSignup/signupJourney.js', 'utf8')
});
const invitation = '#invitation=' + 'x'.repeat(43);
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(setImmediate); };

function openPage(location, bootstrap = async () => ({ status: 204 })) {
    const dom = createDom(), skip = dom.document.createElement('a'), listeners = {};
    dom.document.getElementById = id => id === 'signup' ? dom.root : id === 'signup-skip' ? skip : null;
    const history = { replaceState: jest.fn((_state, _title, url) => { location.href = new URL(url, location.href).href; }) };
    const fetch = jest.fn(async url => url.endsWith('/bootstrap') ? bootstrap() : new Response(JSON.stringify({
        state: { status: 'pending_admission' }, csrfToken: 'c'.repeat(43)
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const bundle = documentBundle();
    vm.runInNewContext(bundle.runtime, { document: dom.document,
        window: { fetch, history, location, addEventListener: (name, fn) => { listeners[name] = fn; } },
        AbortController, TextDecoder, URLSearchParams, setTimeout, clearTimeout });
    const activate = () => {
        const event = { preventDefault: jest.fn() };
        for (const handler of skip.events.click || []) handler(event);
        // Model native anchor navigation if the runtime did not cancel it.
        if (!event.preventDefault.mock.calls.length) location.hash = '#signup';
        expect(event.preventDefault).toHaveBeenCalledTimes(1);
        expect(dom.document.activeElement).toBe(dom.root);
    };
    return { ...dom, fetch, history, activate, close: () => listeners.pagehide?.() };
}

test.each(['', invitation])('skip preserves the scrubbed URL and refresh mounts the normal journey (%s)', async fragment => {
    const location = new URL('https://nofries.invalid/signup' + fragment);
    const page = openPage(location);
    await settle();
    expect(page.root.textContent).toContain('Account setup received');
    page.activate();
    expect(location.href).toBe('https://nofries.invalid/signup');
    expect(page.fetch.mock.calls.map(([url]) => url)).toEqual([
        ...(fragment ? ['/api/customer-signup/bootstrap'] : []), '/api/customer-signup/state'
    ]);
    page.close();
    const refreshed = openPage(location);
    await settle();
    expect(refreshed.root.textContent).toContain('Account setup received');
    expect(refreshed.fetch.mock.calls.map(([url]) => url)).toEqual(['/api/customer-signup/state']);
    refreshed.close();
});

test('skip is safe while invitation bootstrap is pending', async () => {
    let finish;
    const location = new URL('https://nofries.invalid/signup' + invitation);
    const page = openPage(location, () => new Promise(resolve => { finish = resolve; }));
    page.activate();
    expect(location.href).toBe('https://nofries.invalid/signup');
    expect(page.fetch).toHaveBeenCalledTimes(1);
    finish({ status: 204 }); await settle();
    expect(page.root.textContent).toContain('Account setup received');
    page.close();
});

test.each(['#signup', '#other', '#invitation=short', invitation + '&other=x',
    '#invitation=' + 'x'.repeat(42), '#invitation=' + 'x'.repeat(44), '#invitation=%78' + 'x'.repeat(42)
])('malformed fragment stays scrubbed and rejected without any request (%s)', async fragment => {
    const location = new URL('https://nofries.invalid/signup' + fragment);
    const page = openPage(location);
    await settle();
    expect(location.hash).toBe('');
    expect(page.root.textContent).toContain('Signup is unavailable');
    expect(page.root.textContent).not.toContain(fragment);
    expect(page.fetch).not.toHaveBeenCalled();
    expect(page.document.activeElement.tagName).toBe('H1');
    page.activate();
    expect(location.hash).toBe('');
    expect(page.root.textContent).toContain('Signup is unavailable');
    expect(page.fetch).not.toHaveBeenCalled();
});
