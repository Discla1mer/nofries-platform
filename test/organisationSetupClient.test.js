'use strict';
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { createDom } = require('./fixtures/dashboardDom');
const source = fs.readFileSync(path.join(__dirname, '../js/organisation-setup.js'), 'utf8');
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function fixture({ external = false, search = '', hash = '' } = {}) {
    const { document, window } = createDom();
    Object.assign(window.location, { search, hash, replace: jest.fn() });
    if (external) document.body = { dataset: { customerProvider: 'external' } };
    const pageEvents = {};
    const listen = window.addEventListener.bind(window);
    window.addEventListener = (name, fn) => { (pageEvents[name] ||= []).push(fn); listen(name, fn); };
    const lifecycle = (name, event = { persisted: true }) => {
        for (const fn of pageEvents[name] || []) fn(event);
    };
    const representativeNames = ['representative-name', 'representative-role', 'representative-address', 'representative-registration', 'representative-authority'];
    const names = ['form', 'code-form', 'profile-form', 'details-form', 'verified', 'verified-title', 'status', 'email-hint', 'verified-name', 'name', 'email', 'code', 'restart', 'refresh', 'continue', 'choice', 'company', 'consultant', 'back', 'title', 'intro', 'name-label', 'switch', 'leave', 'returning', ...representativeNames];
    const nodes = Object.fromEntries(names.map(name => [name, document.createElement(name.includes('form') ? 'form' : ['name','email','code', ...representativeNames].includes(name) ? 'input' : 'div')]));
    document.getElementById = id => nodes[id.replace('organisation-', '')];
    document.querySelectorAll = () => [nodes.name, nodes.email, nodes.code, nodes.restart, nodes.refresh, nodes.company, nodes.consultant, nodes.back, nodes.leave, ...representativeNames.map(name => nodes[name])];
    nodes.verified.hidden = true; nodes['code-form'].hidden = true; nodes.returning.hidden = true;
    nodes.form.reportValidity = () => true; nodes['profile-form'].reportValidity = () => true;
    nodes.form.reset = () => { nodes.email.value = ''; }; nodes['profile-form'].reset = () => { nodes.name.value = ''; }; nodes['code-form'].reportValidity = () => true;
    nodes['details-form'].reportValidity = () => true;
    nodes['details-form'].reset = () => { for (const name of representativeNames) nodes[name].value = ''; nodes['representative-authority'].checked = false; };
    for (const name of representativeNames) nodes[name].value = name === 'representative-registration' ? '' : 'Synthetic detail';
    nodes['representative-authority'].checked = true;
    nodes.name.value = 'Example Organisation'; nodes.email.value = 'owner@acme.example'; nodes.code.value = '12345678';
    nodes.code.focus = () => { if (!nodes.code.disabled) document.activeElement = nodes.code; };
    window.setTimeout = setTimeout; window.clearTimeout = clearTimeout;
    const requests = [];
    const fetch = jest.fn((url, options) => new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => { const e = new Error(); e.name = 'AbortError'; reject(e); });
        requests.push({ url, options, resolve, reject });
    }));
    vm.runInNewContext(source, { document, window, fetch, AbortController, URLSearchParams });
    const reply = async (index, status, value, defaults = true, responseHeaders = {}) => {
        if (defaults && ['awaiting_code', 'verified'].includes(value.state) && value.requestId === undefined) value = { ...value, requestId: '10000000-0000-4000-8000-000000000001' };
        if (defaults && ['awaiting_code', 'verified'].includes(value.state) && value.accountType === undefined) value = { ...value, accountType: 'company' };
        if (defaults && value.state === 'verified' && value.nextStep === undefined) value = { ...value, nextStep: 'pending_activation' };
        requests[index].resolve({ status, ok: status >= 200 && status < 300, redirected: false,
            headers: { get: name => name === 'content-type' ? 'application/json' :
                Object.hasOwn(responseHeaders, name) ? responseHeaders[name] : name === 'x-nofries-customer-entry' ? 'legacy' : null },
            text: async () => JSON.stringify(value) }); await flush();
    };
    const choose = (type = 'company') => nodes[type].click();
    const fillDetails = () => {
        for (const name of representativeNames) nodes[name].value = name === 'representative-registration' ? '' : 'Synthetic detail';
        nodes['representative-authority'].checked = true;
    };
    const submit = name => { if (name === 'form' && !nodes.choice.hidden) choose(); for (const fn of nodes[name].events.submit) fn({ preventDefault() {} }); };
    return { nodes, document, window, requests, reply, submit, lifecycle, choose, fillDetails };
}
beforeEach(() => jest.useFakeTimers());
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

test('default entry waits for an effective provider before permitting any email request', async () => {
    const h = fixture();
    expect(h.nodes.form.hidden).toBe(true); expect(h.nodes.returning.hidden).toBe(true);
    expect(h.requests[0].options).toMatchObject({ method: 'GET', cache: 'no-store', credentials: 'same-origin',
        headers: { 'X-NoFries-Customer-Entry': 'auto' } });
    h.submit('form'); expect(h.requests).toHaveLength(1);
    await h.reply(0, 200, { state: 'start' });
    h.nodes.email.value = 'synthetic@example.test'; h.submit('form');
    expect(h.requests[1].options.method).toBe('POST');
    expect(h.requests[1].options.headers['X-NoFries-Customer-Entry']).toBeUndefined();
    h.lifecycle('pagehide');
});

test.each([
    { state: 'start' }, { state: 'sign_in' },
    { state: 'awaiting_code', emailHint: 's***@example.test' },
    { state: 'verified', organisationName: 'Retained legacy setup', accessGranted: false }
])('a fresh effective external choice hands off before rendering legacy %j', async state => {
    const h = fixture();
    await h.reply(0, 200, state, true, { 'x-nofries-customer-entry': 'external' });
    expect(h.window.location.replace).toHaveBeenCalledTimes(1);
    expect(h.window.location.replace).toHaveBeenCalledWith('/signup?provider=external');
    expect(h.nodes['verified-name'].textContent).toBe('');
    expect(h.nodes['email-hint'].textContent).toBe('');
    h.submit('form'); h.submit('code-form'); h.fillDetails(); h.submit('details-form');
    expect(h.requests).toHaveLength(1);
    h.lifecycle('pagehide');
});

test('automatic external selection never forwards a fragment or arbitrary return target', async () => {
    const h = fixture({ search: '?returnTo=https%3A%2F%2Funtrusted.invalid', hash: '#invitation=private-fragment' });
    await h.reply(0, 200, { state: 'start' }, false, { 'x-nofries-customer-entry': 'external' });
    expect(h.window.location.replace).toHaveBeenCalledWith('/signup?provider=invalid');
    expect(h.requests[0].url).toBe('/api/organisation-setup/state');
    expect(JSON.stringify(h.requests[0].options)).not.toMatch(/private-fragment|untrusted/);
    h.lifecycle('pagehide');
});

test.each(['legacy', 'external'])('unknown-context client recovery selects %s and starts fresh sign-in rather than reopening stale signup state', async provider => {
    const h = fixture({ search: '?reauthenticate=1&returnTo=https%3A%2F%2Funtrusted.invalid' });
    expect(h.nodes.form.hidden).toBe(true); expect(h.nodes.returning.hidden).toBe(true);
    await h.reply(0, 200, { state: 'sign_in' }, false,
        { 'x-nofries-customer-entry': provider, 'x-nofries-customer-sign-in': 'available' });
    expect(h.window.location.replace).toHaveBeenCalledTimes(1);
    expect(h.window.location.replace).toHaveBeenCalledWith('/api/' + (provider === 'external' ? 'external-' : '') + 'customer-auth/login');
    expect(h.requests).toHaveLength(1); expect(h.requests[0].options.method).toBe('GET');
    expect(h.nodes.form.hidden).toBe(true); expect(h.nodes.returning.hidden).toBe(true);
    h.lifecycle('pagehide');
});

test.each(['?reauthenticate=1&reauthenticate=1', '?reauthenticate=0', '?reauthenticate=', '?reauthenticate=https%3A%2F%2Funtrusted.invalid'])
('invalid reauthentication request %s never starts a login or setup request', search => {
    const h = fixture({ search });
    expect(h.window.location.replace).toHaveBeenCalledWith('/signup?provider=invalid');
    expect(h.requests).toHaveLength(0);
});

test.each(['legacy', 'external'])('explicit %s reauthentication uses only its fixed local endpoint', provider => {
    const h = fixture({ search: '?provider=' + provider + '&reauthenticate=1' });
    expect(h.window.location.replace).toHaveBeenCalledWith('/api/' + (provider === 'external' ? 'external-' : '') + 'customer-auth/login');
    expect(h.requests).toHaveLength(0);
});

test('a legacy reauthentication choice without returning-sign-in capability stays unresolved', async () => {
    const h = fixture({ search: '?reauthenticate=1' });
    await h.reply(0, 200, { state: 'sign_in' }, false, { 'x-nofries-customer-entry': 'legacy' });
    expect(h.window.location.replace).not.toHaveBeenCalled();
    expect(h.nodes.form.hidden).toBe(true); expect(h.nodes.returning.hidden).toBe(true);
    expect(h.nodes.status.textContent).toContain('Check progress');
    h.lifecycle('pagehide');
});

test.each(['server failure', 'malformed body', 'missing provider'])('automatic reauthentication cannot use availability before validating %s', async failure => {
    const h = fixture({ search: '?reauthenticate=1' });
    if (failure === 'malformed body') {
        h.requests[0].resolve({ status: 200, ok: true, redirected: false,
            headers: { get: name => ({ 'content-type': 'application/json', 'x-nofries-customer-entry': 'external',
                'x-nofries-customer-sign-in': 'available' })[name] || null }, text: async () => '{' });
        await flush();
    } else await h.reply(0, failure === 'server failure' ? 503 : 200,
        failure === 'server failure' ? { code: 'setup_unavailable' } : { state: 'sign_in' }, false,
        { 'x-nofries-customer-entry': failure === 'missing provider' ? null : 'external', 'x-nofries-customer-sign-in': 'available' });
    expect(h.window.location.replace).not.toHaveBeenCalled();
    expect(h.nodes.form.hidden).toBe(true); expect(h.nodes.returning.hidden).toBe(true);
    expect(h.nodes.status.textContent).toContain('Check progress');
    h.nodes.refresh.click();
    await h.reply(1, 200, { state: 'sign_in' }, false, { 'x-nofries-customer-entry': 'external' });
    expect(h.window.location.replace).toHaveBeenCalledTimes(1);
    expect(h.window.location.replace).toHaveBeenCalledWith('/api/external-customer-auth/login');
    expect(h.requests.every(item => item.options.method === 'GET')).toBe(true);
    h.lifecycle('pagehide');
});

test.each(['missing hint', 'invalid hint', 'server error', 'invalid state', 'invalid JSON', 'oversized JSON', 'redirect', 'wrong content type'])(
    'default entry does not navigate or submit after %s, and recovers only through a valid state read', async failure => {
        const h = fixture();
        if (failure === 'missing hint' || failure === 'invalid hint') {
            await h.reply(0, 200, { state: 'start' }, false,
                { 'x-nofries-customer-entry': failure === 'missing hint' ? null : 'https://untrusted.invalid',
                    'x-nofries-customer-sign-in': 'available' });
        } else if (failure === 'server error') {
            await h.reply(0, 503, { code: 'setup_unavailable' }, false,
                { 'x-nofries-customer-entry': 'external', 'x-nofries-customer-sign-in': 'available' });
        } else {
            h.requests[0].resolve({ status: 200, ok: true, redirected: failure === 'redirect',
                headers: { get: name => name === 'content-type' ? failure === 'wrong content type' ? 'text/html' : 'application/json'
                    : name === 'x-nofries-customer-sign-in' ? 'available' : 'external' },
                text: async () => failure === 'invalid JSON' ? '{' : failure === 'oversized JSON'
                    ? JSON.stringify({ state: 'start', padding: 'x'.repeat(4096) })
                    : JSON.stringify(failure === 'invalid state' ? { state: 'verified', accessGranted: true } : { state: 'start' }) });
            await flush();
        }
        expect(h.window.location.replace).not.toHaveBeenCalled();
        expect(h.nodes.form.hidden).toBe(true); expect(h.nodes.returning.hidden).toBe(true);
        expect(h.nodes.status.textContent).toContain('Check progress');
        h.submit('form'); h.nodes.leave.click(); expect(h.requests).toHaveLength(1);
        expect(h.nodes.refresh.disabled).toBe(false);
        h.nodes.refresh.click(); expect(h.requests[1].options.headers['X-NoFries-Customer-Entry']).toBe('auto');
        await h.reply(1, 200, { state: 'start' });
        h.nodes.email.value = 'synthetic@example.test'; h.submit('form');
        expect(h.requests[2].options.method).toBe('POST');
        h.lifecycle('pagehide');
    });

test.each(['network', 'timeout'])('unresolved default %s keeps mutations blocked and permits explicit state recovery', async failure => {
    const h = fixture();
    if (failure === 'network') { h.requests[0].reject(new Error('Synthetic network failure')); await flush(); }
    else { jest.advanceTimersByTime(20001); await flush(); }
    h.submit('form'); expect(h.requests).toHaveLength(1);
    expect(h.window.location.replace).not.toHaveBeenCalled();
    h.nodes.refresh.click(); await h.reply(1, 200, { state: 'sign_in' }, false, { 'x-nofries-customer-entry': 'external' });
    expect(h.window.location.replace).toHaveBeenCalledWith('/signup?provider=external');
    expect(h.requests.every(item => item.options.method === 'GET')).toBe(true);
    h.lifecycle('pagehide');
});

test('explicit legacy selection ignores automatic-entry hints and retains the legacy request contract', async () => {
    const h = fixture({ search: '?provider=legacy' });
    expect(h.requests[0].options.headers['X-NoFries-Customer-Entry']).toBeUndefined();
    await h.reply(0, 200, { state: 'start' }, false, { 'x-nofries-customer-entry': 'external' });
    h.submit('form'); expect(h.requests[1].url).toBe('/api/organisation-setup/request');
    expect(h.window.location.replace).not.toHaveBeenCalled();
    h.lifecycle('pagehide');
});

test.each(['malformed', 'oversized'])('explicit legacy returning capability survives %s setup JSON', async kind => {
    const h = fixture({ search: '?provider=legacy' });
    h.requests[0].resolve({ status: 200, ok: true, redirected: false,
        headers: { get: name => ({ 'content-type': 'application/json',
            'x-nofries-customer-sign-in': 'available', 'x-nofries-customer-entry': 'external' })[name] || null },
        text: async () => kind === 'malformed' ? '{' : JSON.stringify({ state: 'start', padding: 'x'.repeat(4096) }) });
    await flush();
    expect(h.nodes.returning.hidden).toBe(false);
    expect(h.window.location.replace).not.toHaveBeenCalled();
    expect(h.requests).toHaveLength(1);
    expect(h.nodes.refresh.disabled).toBe(false);
    h.lifecycle('pagehide');
});

test('automatic selection exposes no legacy action while its body is delayed or its old response returns after cancellation', async () => {
    const h = fixture(); let releaseBody;
    h.requests[0].resolve({ status: 200, ok: true, redirected: false,
        headers: { get: name => ({ 'content-type': 'application/json', 'x-nofries-customer-entry': 'legacy',
            'x-nofries-customer-sign-in': 'available' })[name] || null },
        text: () => new Promise(resolve => { releaseBody = resolve; }) });
    await flush(); expect(h.nodes.form.hidden).toBe(true); expect(h.nodes.returning.hidden).toBe(true);
    h.lifecycle('pagehide'); h.lifecycle('pageshow');
    expect(h.nodes.form.hidden).toBe(true); expect(h.nodes.returning.hidden).toBe(true);
    await h.reply(1, 200, { state: 'sign_in' }, false, { 'x-nofries-customer-entry': 'external' });
    releaseBody(JSON.stringify({ state: 'start' })); await flush();
    expect(h.window.location.replace).toHaveBeenCalledTimes(1);
    expect(h.window.location.replace).toHaveBeenCalledWith('/signup?provider=external');
    expect(h.nodes.form.hidden).toBe(true); expect(h.nodes.returning.hidden).toBe(true);
    expect(h.requests.every(item => item.options.method === 'GET')).toBe(true);
    h.lifecycle('pagehide');
});

test('a delayed initial body cannot override the fresh choice after pagehide and cached return', async () => {
    const h = fixture(); let releaseBody;
    h.requests[0].resolve({ status: 200, ok: true, redirected: false,
        headers: { get: name => name === 'content-type' ? 'application/json' : 'external' },
        text: () => new Promise(resolve => { releaseBody = resolve; }) });
    await flush(); h.lifecycle('pagehide'); h.lifecycle('pageshow');
    expect(h.requests[1].options.headers['X-NoFries-Customer-Entry']).toBe('auto');
    await h.reply(1, 200, { state: 'start' });
    h.nodes.email.value = 'preserved@example.test';
    releaseBody(JSON.stringify({ state: 'start' })); await flush();
    expect(h.window.location.replace).not.toHaveBeenCalled();
    expect(h.nodes.email.value).toBe('preserved@example.test');
    h.submit('form'); expect(h.requests[2].options.method).toBe('POST');
    h.lifecycle('pagehide');
});

test('a resolved legacy draft survives later status hints and remains gated during cached-return recovery', async () => {
    const h = fixture(); await h.reply(0, 200, { state: 'start' });
    h.nodes.email.value = 'draft@example.test';
    h.nodes.refresh.click();
    expect(h.requests[1].options.headers['X-NoFries-Customer-Entry']).toBeUndefined();
    await h.reply(1, 200, { state: 'start' }, false, { 'x-nofries-customer-entry': 'external' });
    expect(h.nodes.email.value).toBe('draft@example.test');
    h.lifecycle('pagehide'); h.lifecycle('pageshow');
    expect(h.requests[2].options.headers['X-NoFries-Customer-Entry']).toBeUndefined();
    h.submit('form'); expect(h.requests).toHaveLength(3);
    await h.reply(2, 503, { code: 'setup_unavailable' });
    h.submit('form'); expect(h.requests).toHaveLength(3);
    h.nodes.refresh.click(); await h.reply(3, 200, { state: 'start' }, false, { 'x-nofries-customer-entry': null });
    expect(h.nodes.email.value).toBe('draft@example.test');
    expect(h.window.location.replace).not.toHaveBeenCalled();
    h.submit('form'); expect(h.requests[4].options.method).toBe('POST');
    h.lifecycle('pagehide');
});

test('external staged setup keeps its fixed API and describes secure sign-in without claiming invitation delivery or access', async () => {
    const h = fixture({ external: true });
    expect(h.requests[0].url).toBe('/api/external-organisation-setup/state');
    await h.reply(0, 200, { state: 'verified', organisationName: 'Synthetic company', accountType: 'company',
        accessGranted: false, nextStep: 'secure_sign_in' });
    expect(h.nodes.continue.hidden).toBe(false);
    expect(h.nodes.intro.textContent).toContain('Create your password or sign in');
    expect(h.nodes.status.textContent).toContain('review your agreement');
    expect(h.nodes.status.textContent).not.toContain('invitation');
    h.nodes.refresh.click();
    expect(h.requests[1].url).toBe('/api/external-organisation-setup/state');
    expect(h.requests[1].options.method).toBe('GET');
});
test('uncertain invitation status retains email verification and stops offering a details retry', async () => {
    const h = fixture();
    await h.reply(0, 200, { state: 'verified', organisationName: 'Example Organisation', accessGranted: false,
        accountType: 'consultant', nextStep: 'setup_review_required' });
    expect(h.nodes.status.textContent).toContain('details are saved');
    expect(h.nodes.status.textContent).toContain('details are saved');
    expect(h.nodes.status.textContent).toContain('needs review');
    expect(h.nodes['details-form'].hidden).toBe(true);
    expect(h.nodes.continue.hidden).toBe(true);
    expect(h.requests).toHaveLength(1);
});
test('verification advances only on server responses and restores usable code focus', async () => {
    const h = fixture(); await h.reply(0, 200, { state: 'start' });
    h.nodes.name.value = 'Example Organisation'; h.nodes.email.value = 'owner@acme.example';
    h.submit('form'); expect(h.nodes.form.getAttribute('aria-busy')).toBe('true');
    expect(JSON.parse(h.requests[1].options.body)).toEqual({ email: 'owner@acme.example' });
    expect(h.requests[1].url).not.toContain('owner'); expect(h.requests[1].options.redirect).toBe('error');
    await h.reply(1, 202, { state: 'awaiting_code', emailHint: 'o***@acme.example', delivery: 'confirmed' });
    expect(h.nodes['code-form'].hidden).toBe(false); expect(h.document.activeElement).toBe(h.nodes.code);
    h.submit('code-form'); await h.reply(2, 400, { code: 'verification_code_invalid' });
    expect(h.nodes.verified.hidden).toBe(true); expect(h.nodes.status.textContent).toContain('not correct');
    h.submit('code-form'); await h.reply(3, 200, { state: 'verified', organisationName: 'Example Organisation', accessGranted: false });
    expect(h.nodes.verified.hidden).toBe(false); expect(h.nodes.status.textContent).toContain('waiting for activation');
});
test('failure and uncertain delivery do not falsely claim verification or automatically resend', async () => {
    const h = fixture(); await h.reply(0, 503, { code: 'setup_unavailable' });
    expect(h.nodes.status.textContent).toContain('could not confirm your progress');
    expect(h.nodes.status.textContent).not.toContain('account has not been created');
    h.submit('form'); expect(h.requests).toHaveLength(1);
    h.nodes.refresh.click(); await h.reply(1, 200, { state: 'start' });
    h.submit('form'); await h.reply(2, 202, { state: 'awaiting_code', emailHint: 'o***@acme.example', delivery: 'unconfirmed' });
    expect(h.nodes.status.textContent).toContain('could not be confirmed');
    expect(h.nodes.verified.hidden).toBe(true); expect(h.requests).toHaveLength(3);
});
test('timeout permits explicit status recovery without replaying an email request', async () => {
    const h = fixture(); await h.reply(0, 200, { state: 'start' }); h.submit('form');
    jest.advanceTimersByTime(20001); await flush();
    expect(h.nodes.status.textContent).toContain('Check progress'); expect(h.requests).toHaveLength(2);
    h.nodes.refresh.click(); expect(h.requests[2].options.method).toBe('GET');
    await h.reply(2, 200, { state: 'awaiting_code', emailHint: 'o***@acme.example' });
    expect(h.nodes['code-form'].hidden).toBe(false);
});

test('cached return rechecks server state and permits a new explicit verification', async () => {
    const h = fixture(); await h.reply(0, 200, { state: 'start' });
    h.lifecycle('pagehide');
    expect(h.nodes.code.value).toBe('');
    h.lifecycle('pageshow');
    expect(h.requests[1].options.method).toBe('GET');
    await h.reply(1, 200, { state: 'awaiting_code', emailHint: 'o***@acme.example' });
    h.nodes.code.value = '87654321'; h.submit('code-form');
    expect(h.requests[2].url).toBe('/api/organisation-setup/verify');
    await h.reply(2, 200, { state: 'verified', organisationName: 'Example Organisation', accessGranted: false });
    expect(h.nodes.verified.hidden).toBe(false);
});
test('leaving during a send aborts it and cached return never replays the email request', async () => {
    const h = fixture(); await h.reply(0, 200, { state: 'start' }); h.submit('form');
    h.lifecycle('pagehide'); await flush();
    expect(h.requests[1].options.signal.aborted).toBe(true);
    h.lifecycle('pageshow');
    expect(h.requests).toHaveLength(3);
    expect(h.requests[2].options.method).toBe('GET');
    await h.reply(2, 200, { state: 'awaiting_code', emailHint: 'o***@acme.example' });
    expect(h.nodes.form.getAttribute('aria-busy')).toBe('false');
    expect(h.requests.filter(r => r.options.method === 'POST')).toHaveLength(1);
    h.lifecycle('pagehide'); h.lifecycle('pageshow');
    expect(h.requests[3].options.method).toBe('GET');
    await h.reply(3, 200, { state: 'start' });
    expect(h.nodes.form.hidden).toBe(false); expect(h.nodes.choice.hidden).toBe(true);
});
test('ordinary initial pageshow does not duplicate the state request', async () => {
    const h = fixture(); h.lifecycle('pageshow', { persisted: false });
    expect(h.requests).toHaveLength(1);
    await h.reply(0, 200, { state: 'start' });
});

test('only a cookie-bound server continuation exposes account setup without claiming dashboard access', async () => {
    const h = fixture();
    await h.reply(0, 200, { state: 'verified', organisationName: 'Example Organisation', accessGranted: false, nextStep: 'pending_activation' });
    expect(h.nodes.continue.hidden).toBe(true);
    h.nodes.refresh.click();
    await h.reply(1, 200, { state: 'verified', organisationName: 'Example Organisation', accessGranted: false, nextStep: 'check_invitation' });
    expect(h.nodes.continue.hidden).toBe(false);
    expect(h.nodes.status.textContent).toContain('Continue secure sign-in');
    expect(h.nodes.status.textContent).toContain('finish activation');
    expect(h.requests.every(r => r.options.method === 'GET')).toBe(true);
});

test.each(['company', 'consultant'])('email comes before the new %s account choice', async type => {
    const h = fixture(); await h.reply(0, 200, { state: 'start' });
    expect(h.nodes.form.hidden).toBe(false); expect(h.nodes.choice.hidden).toBe(true);
    h.choose(type); expect(h.nodes.choice.hidden).toBe(true);
    h.nodes.email.value = 'tester@gmail.com'; h.submit('form');
    expect(JSON.parse(h.requests[1].options.body)).toEqual({ email: 'tester@gmail.com' });
    await h.reply(1, 202, { state: 'awaiting_code', accountType: null, emailHint: 't***@gmail.com' });
    h.nodes.code.value = '12345678'; h.submit('code-form');
    await h.reply(2, 200, { state: 'verified', accountType: null, organisationName: null, accessGranted: false, nextStep: 'choose_account' });
    expect(h.nodes.choice.hidden).toBe(false); h.choose(type);
    expect(h.nodes['profile-form'].hidden).toBe(false); expect(h.nodes.form.hidden).toBe(true);
    h.nodes.name.value = 'Example'; h.submit('profile-form');
    expect(JSON.parse(h.requests[3].options.body)).toEqual({ accountType: type, organisationName: 'Example' });
    expect(h.requests[3].options.headers['X-NoFries-Setup-Request']).toBe('10000000-0000-4000-8000-000000000001');
});
test('reload uses the server-stored consultant choice and rejects unknown account types', async () => {
    const h = fixture();
    await h.reply(0, 200, { state: 'verified', accountType: 'consultant', organisationName: 'My workspace', accessGranted: false });
    expect(h.nodes['verified-name'].textContent).toBe('Consultant workspace: My workspace');
    h.nodes.refresh.click();
    await h.reply(1, 200, { state: 'verified', accountType: 'staff', organisationName: 'Other', accessGranted: false });
    expect(h.nodes.status.textContent).toContain('could not confirm your progress');
    expect(h.nodes['verified-name'].textContent).toBe('Consultant workspace: My workspace');
});
test('returning users proceed to the saved account without account choice or details', async () => {
    const h = fixture();
    await h.reply(0, 200, { state: 'verified', accountType: 'consultant', organisationName: 'Saved workspace', accessGranted: false, nextStep: 'account_found' });
    expect(h.nodes.choice.hidden).toBe(true); expect(h.nodes['details-form'].hidden).toBe(true);
    expect(h.nodes.continue.hidden).toBe(false); expect(h.nodes['verified-name'].textContent).toContain('Saved workspace');
    expect(h.requests).toHaveLength(1);
});

test.each(['server', 'unknown-server', 'network', 'timeout'])('unconfirmed details submission (%s) preserves verification without assuming invitation delivery or replaying it', async failure => {
    const h = fixture();
    const verified = { state: 'verified', accountType: 'company', organisationName: 'Example Organisation', accessGranted: false, nextStep: 'details_required' };
    await h.reply(0, 200, verified);
    h.fillDetails();
    h.submit('details-form');
    const originalBody = h.requests[1].options.body;
    expect(h.requests[1].url).toBe('/api/organisation-setup/details');
    if (failure === 'server' || failure === 'unknown-server') {
        await h.reply(1, 503, { code: failure === 'server' ? 'setup_unavailable' : 'internal_failure' });
    } else if (failure === 'network') {
        h.requests[1].reject(new Error('Network failure')); await flush();
    } else {
        jest.advanceTimersByTime(20001); await flush();
    }
    expect(h.nodes.status.textContent).toContain('Your email was verified');
    expect(h.nodes.status.textContent).toContain('account setup could not be confirmed');
    expect(h.nodes.status.textContent).toContain('Check your inbox');
    expect(h.nodes.status.textContent).toContain('Check progress');
    expect(h.nodes.status.textContent).not.toMatch(/account has not been created|invitation (?:was|has been) sent|Email verification is not available/);
    expect(h.nodes['details-form'].hidden).toBe(false);
    expect(h.nodes['details-form'].getAttribute('aria-busy')).toBe('false');
    expect(h.nodes['representative-name'].value).toBe('Synthetic detail');
    expect(h.nodes['representative-authority'].checked).toBe(true);
    expect(h.requests).toHaveLength(2);
    h.nodes.refresh.click();
    expect(h.requests[2].options.method).toBe('GET');
    await h.reply(2, 200, verified);
    expect(h.nodes.status.textContent).toContain('Your email is verified');
    expect(h.requests.filter(r => r.options.method === 'POST')).toHaveLength(1);
    h.submit('details-form');
    expect(h.requests[3].options.body).toBe(originalBody);
    await h.reply(3, 200, { ...verified, nextStep: 'check_invitation' });
    expect(h.nodes.continue.hidden).toBe(false);
});

test.each([
    [400, 'starter_authority_required', 'Confirm that you are authorised'],
    [400, 'starter_details_invalid', 'Check your name, role and organisation address'],
    [410, 'setup_expired', 'This verification session has expired'],
    [401, 'setup_session_required', 'Use the browser where you requested the code']
])('details submission preserves the specific %s %s recovery message', async (status, code, expected) => {
    const h = fixture();
    await h.reply(0, 200, { state: 'verified', accountType: 'company', organisationName: 'Example Organisation', accessGranted: false, nextStep: 'details_required' });
    h.fillDetails();
    h.submit('details-form'); await h.reply(1, status, { code });
    expect(h.nodes.status.textContent).toContain(expected);
    expect(h.nodes.status.textContent).not.toContain('Your email was verified');
    expect(h.requests).toHaveLength(2);
});

test.each(['details_required', 'pending_activation', 'check_invitation', 'setup_review_required'])(
    'leaving verified %s restores blank account choice only after server acknowledgement', async nextStep => {
        const h = fixture();
        await h.reply(0, 200, { state: 'verified', accountType: 'company', organisationName: 'Old organisation', accessGranted: false, nextStep });
        expect(h.nodes.switch.hidden).toBe(false);
        h.nodes.leave.click(); h.nodes.leave.click();
        expect(h.requests).toHaveLength(2);
        expect(h.requests[1].url).toBe('/api/organisation-setup/state');
        expect(h.requests[1].options).toMatchObject({ method: 'POST', credentials: 'same-origin', body: JSON.stringify({ action: 'leave' }) });
        expect(h.nodes.choice.hidden).toBe(true); expect(h.nodes.leave.disabled).toBe(true);
        await h.reply(1, 200, { state: 'start' });
        expect(h.nodes.choice.hidden).toBe(true); expect(h.nodes.switch.hidden).toBe(true);
        expect(h.nodes.form.hidden).toBe(false); expect(h.nodes['details-form'].hidden).toBe(true);
        expect(h.nodes.continue.hidden).toBe(true); expect(h.nodes.verified.hidden).toBe(true);
        for (const name of ['name', 'email', 'code', 'representative-name', 'representative-role', 'representative-address', 'representative-registration']) expect(h.nodes[name].value).toBe('');
        expect(h.nodes['representative-authority'].checked).toBe(false);
        expect(h.nodes['verified-name'].textContent).toBe('');
        expect(h.nodes.status.textContent).toContain('saved account are kept');
        expect(h.document.activeElement).toBe(h.nodes.email);
        h.nodes.refresh.click(); await h.reply(2, 200, { state: 'start' });
        expect(h.nodes.choice.hidden).toBe(true);
        h.choose('consultant'); h.nodes.name.value = 'New consultancy'; h.nodes.email.value = 'new@example.test';
        h.submit('form');
        expect(JSON.parse(h.requests[3].options.body)).toEqual({ email: 'new@example.test' });
        await h.reply(3, 202, { state: 'awaiting_code', accountType: 'consultant', emailHint: 'n***@example.test' });
        expect(h.nodes['code-form'].hidden).toBe(false); expect(h.nodes.verified.hidden).toBe(true);
    });

test.each(['network', 'timeout', 'server', 'unexpected-state'])('unconfirmed leave (%s) retains the old screen and never sends an email', async failure => {
    const h = fixture();
    await h.reply(0, 200, { state: 'verified', accountType: 'company', organisationName: 'Old organisation', accessGranted: false, nextStep: 'setup_review_required' });
    h.nodes.leave.click();
    if (failure === 'network') { h.requests[1].reject(new Error('Network failure')); await flush(); }
    else if (failure === 'timeout') { jest.advanceTimersByTime(20001); await flush(); }
    else await h.reply(1, failure === 'server' ? 503 : 200, failure === 'server' ? { code: 'setup_unavailable' } : { state: 'verified' });
    expect(h.nodes.status.textContent).toContain('Leaving could not be confirmed');
    expect(h.nodes.choice.hidden).toBe(true); expect(h.nodes.switch.hidden).toBe(false);
    expect(h.nodes['verified-name'].textContent).toBe('Organisation: Old organisation');
    expect(h.requests).toHaveLength(2); expect(h.nodes.leave.disabled).toBe(false);
    h.nodes.refresh.click(); await h.reply(2, 200, { state: 'start' });
    expect(h.nodes.choice.hidden).toBe(true); expect(h.nodes.email.value).toBe('');
    expect(h.requests.filter(r => r.options.method === 'POST').map(r => r.url)).toEqual(['/api/organisation-setup/state']);
});

test('cached return reconciles an interrupted leave without restoring the previous email or replaying any POST', async () => {
    const h = fixture();
    await h.reply(0, 200, { state: 'awaiting_code', accountType: 'company', emailHint: 'o***@example.test' });
    expect(h.nodes.switch.hidden).toBe(false);
    h.nodes.leave.click(); h.lifecycle('pagehide'); await flush(); h.lifecycle('pageshow');
    await h.reply(2, 200, { state: 'start' });
    expect(h.nodes.choice.hidden).toBe(true); expect(h.nodes.form.hidden).toBe(false);
    expect(h.nodes.email.value).toBe(''); expect(h.nodes.name.value).toBe('');
    expect(h.requests.filter(r => r.options.method === 'POST')).toHaveLength(1);
});

test.each(['awaiting_code', 'verified'])('another tab leaving a %s setup clears this tab on its next server read', async state => {
    const h = fixture();
    await h.reply(0, 200, state === 'verified'
        ? { state, accountType: 'company', organisationName: 'Old organisation', accessGranted: false, nextStep: 'setup_review_required' }
        : { state, accountType: 'company', emailHint: 'o***@example.test' });
    h.nodes.refresh.click(); await h.reply(1, 200, { state: 'start' });
    expect(h.nodes.choice.hidden).toBe(true); expect(h.nodes.form.hidden).toBe(false);
    expect(h.nodes.email.value).toBe(''); expect(h.nodes.name.value).toBe('');
    expect(h.nodes['representative-name'].value).toBe(''); expect(h.nodes['representative-authority'].checked).toBe(false);
    h.choose('consultant');
    expect(h.nodes.email.value).toBe(''); expect(h.nodes.name.value).toBe('');
    expect(h.requests.every(r => r.options.method === 'GET')).toBe(true);
});

test('a fresh start clears browser-restored values, while checking a new unsent draft preserves its inputs', async () => {
    const h = fixture(); await h.reply(0, 200, { state: 'start' });
    expect(h.nodes.choice.hidden).toBe(true);
    for (const name of ['name', 'email', 'code', 'representative-name']) expect(h.nodes[name].value).toBe('');
    expect(h.nodes['representative-authority'].checked).toBe(false);
    h.choose('consultant'); h.nodes.name.value = 'Unsent consultancy'; h.nodes.email.value = 'unsent@example.test';
    h.nodes.refresh.click(); await h.reply(1, 200, { state: 'start' });
    expect(h.nodes.form.hidden).toBe(false); expect(h.nodes.name.value).toBe('Unsent consultancy');
    expect(h.nodes.email.value).toBe('unsent@example.test');
});

test('details are bound to the displayed request and discarded when another verified request replaces it', async () => {
    const h = fixture(), requestId = '10000000-0000-4000-8000-000000000001';
    const state = { state: 'verified', accountType: 'company', organisationName: 'Old organisation', requestId, accessGranted: false, nextStep: 'details_required' };
    await h.reply(0, 200, state); h.fillDetails(); h.submit('details-form');
    expect(h.requests[1].options.headers['X-NoFries-Setup-Request']).toBe(requestId);
    await h.reply(1, 409, { code: 'setup_changed' });
    expect(h.nodes.status.textContent).toContain('Setup changed');
    h.nodes.refresh.click();
    const nextId = '10000000-0000-4000-8000-000000000002';
    await h.reply(2, 200, { ...state, requestId: nextId, organisationName: 'New consultancy', accountType: 'consultant' });
    expect(h.nodes['representative-name'].value).toBe(''); expect(h.nodes['representative-authority'].checked).toBe(false);
    expect(h.nodes['verified-name'].textContent).toBe('Consultant workspace: New consultancy');
    h.fillDetails(); h.submit('details-form');
    expect(h.requests[3].options.headers['X-NoFries-Setup-Request']).toBe(nextId);
    await h.reply(3, 200, { ...state, requestId: nextId, organisationName: 'New consultancy', accountType: 'consultant', nextStep: 'check_invitation' });
});

test.each(['server', 'network', 'timeout'])('recovering the initial state check (%s) keeps a new explicitly chosen draft', async failure => {
    const h = fixture();
    if (failure === 'server') await h.reply(0, 503, { code: 'setup_unavailable' });
    else if (failure === 'network') { h.requests[0].reject(new Error('Network failure')); await flush(); }
    else { jest.advanceTimersByTime(20001); await flush(); }
    h.choose('consultant'); h.nodes.name.value = 'New unsent consultancy'; h.nodes.email.value = 'new@example.test';
    h.nodes.refresh.click(); await h.reply(1, 200, { state: 'start' });
    expect(h.nodes.form.hidden).toBe(false); expect(h.nodes.choice.hidden).toBe(true);
    expect(h.nodes.name.value).toBe('New unsent consultancy'); expect(h.nodes.email.value).toBe('new@example.test');
    expect(h.nodes.title.textContent).toBe('Sign up / Sign in');
    expect(h.requests.every(r => r.options.method === 'GET')).toBe(true);
});

test('a stale tab cannot leave a newer setup without first displaying its current state', async () => {
    const h = fixture(), firstId = '10000000-0000-4000-8000-000000000001', nextId = '10000000-0000-4000-8000-000000000002';
    await h.reply(0, 200, { state: 'verified', accountType: 'company', requestId: firstId, organisationName: 'Old organisation', accessGranted: false, nextStep: 'setup_review_required' });
    h.nodes.leave.click();
    expect(h.requests[1].options.headers['X-NoFries-Setup-Request']).toBe(firstId);
    await h.reply(1, 409, { code: 'setup_changed' });
    expect(h.nodes.status.textContent).toContain('linked to another setup');
    expect(h.nodes.choice.hidden).toBe(true);
    h.nodes.refresh.click();
    await h.reply(2, 200, { state: 'awaiting_code', requestId: nextId, accountType: 'consultant', emailHint: 'n***@example.test' });
    expect(h.nodes['code-form'].hidden).toBe(false);
    h.nodes.leave.click(); expect(h.requests[3].options.headers['X-NoFries-Setup-Request']).toBe(nextId);
    await h.reply(3, 200, { state: 'start' }); expect(h.nodes.choice.hidden).toBe(true);
});

test('verification carries the displayed request and clears an old code when another request is shown', async () => {
    const h = fixture(), firstId = '10000000-0000-4000-8000-000000000001', nextId = '10000000-0000-4000-8000-000000000002';
    const state = { state: 'awaiting_code', requestId: firstId, accountType: 'consultant', emailHint: 'a***@example.test' };
    await h.reply(0, 200, state);
    h.nodes.code.value = '12345678'; h.submit('code-form');
    expect(h.requests[1].options.headers['X-NoFries-Setup-Request']).toBe(firstId);
    await h.reply(1, 409, { code: 'setup_changed' });
    h.nodes.refresh.click(); await h.reply(2, 200, { ...state, requestId: nextId, emailHint: 'b***@example.test' });
    expect(h.nodes.code.value).toBe('');
    h.nodes.code.value = '87654321'; h.submit('code-form');
    expect(h.requests[3].options.headers['X-NoFries-Setup-Request']).toBe(nextId);
    expect(JSON.parse(h.requests[3].options.body)).toEqual({ code: '87654321' });
});


test('the static login document exposes direct customer sign-in from the runtime capability response', async () => {
    const request = require('supertest');
    const { customerProductionHarness } = require('./helpers/customerProductionHarness');
    const production = customerProductionHarness();
    const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../staticwebapp.config.json')));
    expect(config.routes.find(route => route.route === '/login').rewrite).toBe('/login.html');
    const html = fs.readFileSync(path.join(__dirname, '../login.html'), 'utf8');
    expect(html).toContain('src="/js/organisation-setup.js"');
    expect(html).toContain('id="organisation-continue" href="/api/customer-auth/login"');
    const h = fixture();
    const response = await request(production.app).get(h.requests[0].url).set(h.requests[0].options.headers);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ state: 'sign_in' });
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.headers['set-cookie']).toBeUndefined();
    await h.reply(0, response.status, response.body, false, response.headers);
    expect(h.nodes.form.hidden).toBe(true);
    expect(h.nodes.choice.hidden).toBe(true);
    expect(h.nodes.verified.hidden).toBe(false);
    expect(h.nodes.continue.hidden).toBe(false);
    expect(h.nodes['verified-title'].textContent).toBe('Continue to your account');
    expect(h.requests).toHaveLength(1);
    for (const action of ['request', 'verify', 'choose', 'details', 'state']) {
        expect((await request(production.app).post('/api/organisation-setup/' + action).send({})).status).toBe(503);
    }
    expect((await request(production.app).get('/api/organisation-setup/state?returnTo=https://evil.example')).status).toBe(503);
    h.lifecycle('pagehide');
});

test('a transient setup failure does not masquerade as the legacy sign-in capability', async () => {
    const h = fixture();
    await h.reply(0, 503, { code: 'setup_unavailable' });
    expect(h.nodes.verified.hidden).toBe(true);
    expect(h.nodes.status.textContent).toContain('Check progress');
    expect(h.requests).toHaveLength(1);
    h.lifecycle('pagehide');
});

test('returning customers can sign in from the static entry after the signup email budget is exhausted', async () => {
    const request = require('supertest');
    const { customerProductionHarness } = require('./helpers/customerProductionHarness');
    const production = customerProductionHarness({ starter: true, now: Date.now() });
    const user = production.addUser({ email: 'returning@gmail.com' });
    // This completed earlier login establishes the durable mailbox proof. The
    // returning browser below has neither an invitation nor a setup cookie.
    expect((await production.login(user)).response.status).toBe(303);
    for (let i = 0; i < 20; i++) {
        const sent = await production.sameOrigin(request(production.app).post('/api/organisation-setup/request'))
            .set('X-Forwarded-For', '192.0.2.' + (i + 1)).send({ email: 'new' + i + '@example.test' });
        expect(sent.status).toBe(202);
    }
    const limited = await production.sameOrigin(request(production.app).post('/api/organisation-setup/request'))
        .set('X-Forwarded-For', '192.0.2.100').send({ email: 'another@example.test' });
    expect(limited.status).toBe(429); expect(limited.body.code).toBe('setup_rate_limited');
    const budget = () => [...production.getContainer('nofries-browser-auth').records]
        .filter(([key]) => key.includes('/budget/')).map(([key, bytes]) => [key, bytes.toString()]);
    const before = budget(), sentBefore = production.state.delivered.length;
    const h = fixture();
    const state = await request(production.app).get(h.requests[0].url).set(h.requests[0].options.headers);
    expect(state.body).toEqual({ state: 'start' });
    expect(state.headers['set-cookie']).toBeUndefined();
    await h.reply(0, state.status, state.body, false, state.headers);
    expect(h.nodes.returning.hidden).toBe(false); expect(h.nodes.form.hidden).toBe(false);
    const html = fs.readFileSync(path.join(__dirname, '../login.html'), 'utf8');
    expect(html).toContain('id="organisation-returning" hidden');
    expect(html).toContain('id="organisation-returning-sign-in" href="/api/customer-auth/login"');
    expect(html).not.toContain('reconnect you to your existing account after verification');
    const returned = await production.login(user, { bootstrap: false });
    expect(returned.response.status).toBe(303);
    expect(returned.cookie).toMatch(/^__Host-nofries-customer=/);
    expect(production.state.delivered).toHaveLength(sentBefore);
    expect(budget()).toEqual(before);
    expect(production.pool.registrations.size).toBe(0); expect(production.pool.receipts.size).toBe(0);
    expect(h.requests).toHaveLength(1); expect(h.requests[0].options.method).toBe('GET');
    // Even if someone first tries the email form, the independent sign-in link
    // stays available after its quota error; it never sends another email itself.
    h.submit('form'); await h.reply(1, limited.status, limited.body, false, limited.headers);
    expect(h.nodes.returning.hidden).toBe(false);
    h.lifecycle('pagehide');
});

test('known legacy sign-in capability survives a setup storage failure without granting account access', async () => {
    const request = require('supertest');
    const { customerProductionHarness } = require('./helpers/customerProductionHarness');
    const production = customerProductionHarness({ starter: true, now: Date.now() });
    const container = production.getContainer('nofries-browser-auth');
    const blob = container.getBlockBlobClient;
    container.getBlockBlobClient = key => key.startsWith('browser-auth/organisation-setup/requests/')
        ? { ...blob(key), async download() { throw new Error('synthetic setup storage failure'); } } : blob(key);
    const h = fixture({ search: '?provider=legacy' });
    const response = await request(production.app).get(h.requests[0].url).set(h.requests[0].options.headers)
        .set('Cookie', '__Host-nofries_org_setup=' + 'a'.repeat(43));
    expect(response.status).toBe(503); expect(response.body).toEqual({ code: 'setup_unavailable' });
    expect(response.headers['x-nofries-customer-sign-in']).toBe('available');
    await h.reply(0, response.status, response.body, false, response.headers);
    expect(h.nodes.returning.hidden).toBe(false);
    expect(h.nodes.verified.hidden).toBe(true); expect(h.nodes.status.textContent).toContain('could not confirm');
    expect(production.state.delivered).toHaveLength(0); expect(h.requests).toHaveLength(1);
    h.lifecycle('pagehide');
});

test.each([undefined, 'false', 'true', 'https://foreign.example'])('returning sign-in is hidden without the exact public capability (%s)', async capability => {
    const h = fixture();
    await h.reply(0, 200, { state: 'start' }, false, { 'x-nofries-customer-sign-in': capability });
    expect(h.nodes.returning.hidden).toBe(true);
    expect(h.requests).toHaveLength(1);
    h.lifecycle('pagehide');
});

test.each([
    ['company', false], ['consultant', false], ['company', true], ['consultant', true]
])('verification-only production configuration preserves %s setup (saved choice=%s)', async (accountType, savedChoice) => {
    const request = require('supertest');
    const { customerProductionHarness } = require('./helpers/customerProductionHarness');
    const production = customerProductionHarness({ organisationSetup: true, customerSignup: false });
    const initial = await request(production.app).get('/api/organisation-setup/state');
    expect(initial.headers['x-nofries-customer-sign-in']).toBeUndefined();
    const selection = { accountType, organisationName: 'Saved organisation' };
    const start = await production.sameOrigin(request(production.app).post('/api/organisation-setup/request'))
        .send({ email: 'person@gmail.com', ...(savedChoice ? selection : {}) });
    expect(start.status).toBe(202);
    const cookie = start.headers['set-cookie'][0].split(';')[0];
    const h = fixture();
    async function deliver(index) {
        const { url, options } = h.requests[index];
        const call = request(production.app)[options.method.toLowerCase()](url).set('Cookie', cookie).set(options.headers);
        const response = options.method === 'POST'
            ? await production.sameOrigin(call).send(JSON.parse(options.body)) : await call;
        expect(response.status).toBe(200);
        await h.reply(index, response.status, response.body, false, response.headers);
        expect(h.nodes.returning.hidden).toBe(true);
        return response;
    }
    await deliver(0);
    h.nodes.code.value = production.state.delivered[0].text.match(/\b[0-9]{8}\b/)[0];
    h.submit('code-form');
    let result = await deliver(1);
    if (!savedChoice) {
        expect(result.body.nextStep).toBe('choose_account');
        expect(h.nodes.choice.hidden).toBe(false);
        h.choose(accountType); h.nodes.name.value = selection.organisationName;
        h.submit('profile-form'); result = await deliver(2);
    }
    expect(result.body).toMatchObject({ state: 'verified', ...selection, accessGranted: false });
    expect(result.body).not.toHaveProperty('nextStep');
    expect(h.nodes['code-form'].hidden).toBe(true);
    expect(h.nodes.verified.hidden).toBe(false);
    expect(h.nodes['verified-title'].textContent).toBe('Email verified');
    expect(h.nodes.status.textContent).toContain('organisation details are saved');
    expect(h.nodes.status.textContent).not.toContain('waiting for activation');
    expect(h.nodes.continue.hidden).toBe(true);
    expect(h.nodes['details-form'].hidden).toBe(true);
    const savedRecords = [...production.getContainer('nofries-browser-auth').records].map(([key, bytes]) => [key, bytes.toString()]);
    h.nodes.refresh.click();
    expect((await deliver(h.requests.length - 1)).body).toEqual(result.body);
    expect([...production.getContainer('nofries-browser-auth').records].map(([key, bytes]) => [key, bytes.toString()])).toEqual(savedRecords);
    expect(production.state.delivered).toHaveLength(1);
    expect(production.pool.registrations.size).toBe(0);
    expect(production.pool.receipts.size).toBe(0);
    expect(production.pool.organisations.size).toBe(0);
    h.lifecycle('pagehide');
});

test.each([
    { nextStep: null }, { nextStep: 'unknown' }, { accessGranted: true },
    { accountType: null }, { organisationName: null }
])('verification-only compatibility still refuses malformed or privileged state %j', async defect => {
    const h = fixture();
    await h.reply(0, 200, { state: 'verified', requestId: '10000000-0000-4000-8000-000000000001',
        accountType: 'company', organisationName: 'Saved organisation', accessGranted: false, ...defect }, false);
    expect(h.nodes.verified.hidden).toBe(true);
    expect(h.nodes.status.textContent).toContain('could not confirm');
    h.lifecycle('pagehide');
});
