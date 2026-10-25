'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const request = require('supertest');
const { createDom } = require('./fixtures/dashboardDom');
const { buildHostedSignupDocument, buildSignupDocument } = require('../lib/signupDocument');
const { customerProductionHarness, uid } = require('./helpers/customerProductionHarness');
const { createProductionApplication } = require('../lib/productionApplication');
const root = path.resolve(__dirname, '..');
const sources = {
    clientSource: fs.readFileSync(path.join(root, 'api/shared/customerSignup/signupClient.js'), 'utf8'),
    journeySource: fs.readFileSync(path.join(root, 'api/shared/customerSignup/signupJourney.js'), 'utf8')
};
const prepared = buildHostedSignupDocument(sources);
const csrf = 'x'.repeat(43);
const settle = async page => {
    for (let i = 0; i < 5; i++) {
        if (page) await Promise.all(page.fetch.mock.results.filter(result => result.type === 'return').map(result => result.value));
        await new Promise(setImmediate);
    }
};
let builtRuntime, builtHelpRuntime, builtConfig, builtLoginSource, builtLoginHtml;
beforeAll(() => {
    execFileSync(process.execPath, ['scripts/build-static.js'], { cwd: root, stdio: 'pipe' });
    const html = fs.readFileSync(path.join(root, 'dist/app/signup.html'), 'utf8');
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    expect(scripts.map(script => script[1])).toEqual(['', ' id="nofriesPublicHelpRuntime"']);
    builtRuntime = scripts[0][2];
    builtHelpRuntime = scripts[1][2];
    expect(builtRuntime).toBe(prepared.runtime);
    expect(builtHelpRuntime).toBe(fs.readFileSync(path.join(root, 'js/prospect-assistant.js'), 'utf8') +
        '\n;\n' + fs.readFileSync(path.join(root, 'js/shared-assistant.js'), 'utf8'));
    builtConfig = JSON.parse(fs.readFileSync(path.join(root, 'dist/staticwebapp.config.json')));
    builtLoginHtml = fs.readFileSync(path.join(root, 'dist/login.html'), 'utf8');
    builtLoginSource = fs.readFileSync(path.join(root, 'dist/js/organisation-setup.js'), 'utf8');
});

// Run the copied static login script with the IDs from its built HTML, then
// forward its real requests through the built SWA route boundary to the app.
function executeBuiltLogin(app, { search = '', hash = '', cookie = '', customerProvider } = {}) {
    const { document } = createDom(), nodes = {}, events = {}, replies = [];
    for (const match of builtLoginHtml.matchAll(/<([a-z][a-z0-9-]*)\b([^>]*\bid="([^"]+)"[^>]*)>/gi)) {
        const node = document.createElement(match[1]);
        node.hidden = /\bhidden(?:\s|>|$)/.test(match[2]); node.value = '';
        node.reset = () => {}; node.reportValidity = () => true;
        nodes[match[3]] = node;
    }
    const provider = builtLoginHtml.match(/<body\b[^>]*\bdata-customer-provider="([^"]+)"/);
    document.body = { dataset: customerProvider ? { customerProvider } : provider ? { customerProvider: provider[1] } : {} };
    document.getElementById = id => nodes[id] || null;
    document.querySelectorAll = () => Object.values(nodes).filter(node => ['INPUT', 'BUTTON'].includes(node.tagName));
    const replace = jest.fn();
    const fetch = jest.fn(async (url, options) => {
        const route = builtConfig.routes.find(item =>
            (item.route.endsWith('*') ? url.startsWith(item.route.slice(0, -1)) : item.route === url) &&
            (!item.methods || item.methods.includes(options.method)));
        expect(route?.allowedRoles ?? ['anonymous']).toContain('anonymous');
        let pending = request(app)[options.method.toLowerCase()](url).set(options.headers);
        if (cookie) pending = pending.set('Cookie', cookie);
        if (options.body) pending = pending.set('Origin', 'https://nofries.nz').set('Sec-Fetch-Site', 'same-origin').send(JSON.parse(options.body));
        const result = await pending; replies.push(result);
        return new Response(result.text, { status: result.status, headers: result.headers });
    });
    const window = { location: { search, hash, replace }, setTimeout, clearTimeout,
        addEventListener(name, fn) { events[name] = fn; } };
    vm.runInNewContext(builtLoginSource, { document, window, fetch, URLSearchParams, AbortController });
    return { document, nodes, fetch, replace, replies, close() { events.pagehide?.(); } };
}

test.each([
    ['inactive external default', false, true, true, 'legacy'],
    ['new customer admission', true, true, true, 'external'],
    ['returning customers only', true, false, true, 'external'],
    ['legacy setup unavailable', true, true, false, 'external']
].flatMap(row => [row.concat(false), row.concat(true)]))('built public login selects %s (external=%s, admission=%s, setup=%s, provider=%s, reauthenticate=%s) without sending email or granting access', async (_name, enabled, admission, setup, expected, reauthenticate) => {
    const server = customerProductionHarness({ starter: true, external: enabled, now: Date.now(), customerClientId: uid(105),
        configureExternal({ env, dependencies }) {
            env.NOFRIES_EXTERNAL_CUSTOMER_ENABLED = String(enabled);
            env.NOFRIES_EXTERNAL_CUSTOMER_ADMISSION_ENABLED = String(admission);
            env.NOFRIES_ORGANISATION_SETUP_ENABLED = String(setup);
            if (dependencies.externalCustomer) dependencies.externalCustomer.allowNewSignup = admission;
        } });
    const snapshot = () => [...server.state.containers].map(([name, store]) => [name,
        [...store.records].map(([key, value]) => [key, value.toString('base64')])]);
    const before = snapshot();
    expect(builtConfig.routes.find(route => route.route === '/login').rewrite).toBe('/login.html');
    expect(builtLoginHtml).toContain('src="/js/organisation-setup.js"');
    const page = executeBuiltLogin(server.app, { search: reauthenticate ? '?reauthenticate=1' : '' });
    try {
        await settle(page);
        expect(page.fetch.mock.calls.map(([url, options]) => [options.method, url])).toEqual([['GET', '/api/organisation-setup/state']]);
        expect(page.fetch.mock.calls[0][1].headers['X-NoFries-Customer-Entry']).toBe('auto');
        expect(page.replies[0].status).toBe(200);
        expect(page.replies[0].headers['x-nofries-customer-entry']).toBe(expected);
        expect(page.replies[0].headers['cache-control']).toContain('no-store');
        expect(page.replies[0].headers['set-cookie']).toBeUndefined();
        if (reauthenticate) expect(page.replace).toHaveBeenCalledWith('/api/' + (expected === 'external' ? 'external-' : '') + 'customer-auth/login');
        else if (expected === 'external') expect(page.replace).toHaveBeenCalledWith('/signup?provider=external');
        else { expect(page.replace).not.toHaveBeenCalled(); expect(page.nodes['organisation-form'].hidden).toBe(false); }
        expect(snapshot()).toEqual(before);
        expect(server.state.delivered).toEqual([]); expect(server.state.authRequests).toEqual([]);
        expect(server.pool.registrations.size).toBe(0); expect(server.pool.receipts.size).toBe(0);
    } finally { page.close(); }
});

test.each([false, true])('dynamic unknown-context reauthentication selects its available provider (external=%s), preserving durable records and fresh one-use login starts', async external => {
    const server = customerProductionHarness({ starter: true, external, now: Date.now(), customerClientId: uid(105),
        configureExternal({ env, dependencies }) {
            env.NOFRIES_EXTERNAL_CUSTOMER_ENABLED = String(external);
            if (dependencies.externalCustomer) dependencies.externalCustomer.allowNewSignup = false;
        } });
    const durable = () => [...server.state.containers].filter(([name]) => !name.endsWith('/nofries-browser-auth'))
        .map(([name, container]) => [name, [...container.records].map(([key, value]) => [key, value.toString('base64')])]);
    const before = durable(), cookies = [];
    for (let attempt = 0; attempt < 2; attempt++) {
        const entry = await request(server.app).get('/login?reauthenticate=1');
        const authPath = '/api/' + (external ? 'external-' : '') + 'customer-auth/login';
        expect(entry.status).toBe(303); expect(entry.headers.location).toBe(authPath);
        expect(entry.headers['set-cookie']).toBeUndefined();
        const started = await request(server.app).get(entry.headers.location);
        expect(started.status).toBe(302);
        expect(new URL(started.headers.location).hostname).toBe(external ? 'synthetic-customer.ciamlogin.com' : 'login.microsoftonline.com');
        const transaction = started.headers['set-cookie'].find(value => value.includes('-tx='));
        expect(transaction).toContain('Max-Age=300'); cookies.push(transaction);
        expect(durable()).toEqual(before);
        expect(server.pool.registrations.size).toBe(0); expect(server.pool.receipts.size).toBe(0);
        expect(server.state.delivered).toEqual([]);
    }
    expect(cookies[0]).not.toBe(cookies[1]);
});

test.each(['?reauthenticate=', '?reauthenticate=0', '?reauthenticate=1&reauthenticate=1'])
('dynamic reauthentication rejects ambiguous or invalid request %s', async query => {
    const server = customerProductionHarness({ starter: true, now: Date.now() });
    const result = await request(server.app).get('/login' + query);
    expect(result.status).toBe(400); expect(result.headers['set-cookie']).toBeUndefined();
    expect(server.state.authRequests).toEqual([]); expect(server.state.delivered).toEqual([]);
    expect(server.pool.registrations.size).toBe(0);
});

test.each(['', '?provider=external'])('reauthentication never invents an unavailable customer provider %s', async query => {
    const { createNoFriesApp } = require('../server');
    const result = await request(createNoFriesApp()).get('/login' + (query || '?') + (query ? '&' : '') + 'reauthenticate=1');
    expect(result.status).toBe(503); expect(result.headers.location).toBeUndefined();
    expect(result.headers['set-cookie']).toBeUndefined();
});

test('dynamic reauthentication retains the existing ambiguous-customer-cookie denial', async () => {
    const server = customerProductionHarness({ starter: true, external: true, now: Date.now() });
    const result = await request(server.app).get('/login?reauthenticate=1')
        .set('Cookie', '__Host-nofries-customer=' + 'a'.repeat(43) + '; __Host-nofries-external-customer=' + 'b'.repeat(43));
    expect(result.status).toBe(401); expect(result.headers.location).toBeUndefined();
    expect(result.headers['set-cookie']).toBeUndefined();
    expect(server.state.authRequests).toEqual([]); expect(server.state.delivered).toEqual([]);
    expect(server.pool.registrations.size).toBe(0); expect(server.pool.receipts.size).toBe(0);
});

test('built explicit legacy login preserves its account route when the runtime default is external', async () => {
    const server = customerProductionHarness({ starter: true, external: true, now: Date.now(), customerClientId: uid(105),
        configureExternal({ env }) { env.NOFRIES_EXTERNAL_CUSTOMER_ENABLED = 'true'; } });
    const page = executeBuiltLogin(server.app, { search: '?provider=legacy' });
    try {
        await settle(page);
        expect(page.fetch.mock.calls[0][1].headers['X-NoFries-Customer-Entry']).toBeUndefined();
        expect(page.replies[0].headers['x-nofries-customer-entry']).toBeUndefined();
        expect(page.replace).not.toHaveBeenCalled();
        expect(page.nodes['organisation-form'].hidden).toBe(false);
        expect(server.state.delivered).toEqual([]);
    } finally { page.close(); }
});

test('built default entry keeps unreadable legacy progress unresolved without changing cookie or records', async () => {
    const server = customerProductionHarness({ starter: true, external: true, now: Date.now(), customerClientId: uid(105),
        configureExternal({ env }) {
            env.NOFRIES_EXTERNAL_CUSTOMER_ENABLED = 'true';
            env.NOFRIES_ORGANISATION_SETUP_ENABLED = 'false';
        } });
    const page = executeBuiltLogin(server.app, { cookie: '__Host-nofries_org_setup=' + 's'.repeat(43) });
    try {
        await settle(page);
        expect(page.replies[0].status).toBe(503);
        expect(page.replies[0].headers['x-nofries-customer-entry']).toBeUndefined();
        expect(page.replies[0].headers['set-cookie']).toBeUndefined();
        expect(page.replace).not.toHaveBeenCalled();
        expect(page.nodes['organisation-form'].hidden).toBe(true);
        expect(page.nodes['organisation-returning'].hidden).toBe(true);
        expect(page.nodes['organisation-send'].disabled).toBe(true);
        expect(page.nodes['organisation-refresh'].disabled).toBe(false);
        expect(server.state.delivered).toEqual([]); expect(server.state.authRequests).toEqual([]);
        expect(server.pool.registrations.size).toBe(0); expect(server.pool.receipts.size).toBe(0);
    } finally { page.close(); }
});

test.each(['legacy', 'external'].flatMap(provider => ['login start', 'callback'].map(stage => [provider, stage])))(
    'failed %s customer %s keeps its provider through the built retry entry', async (provider, stage) => {
        const providerFailure = jest.fn(async () => { throw new Error('Synthetic provider failure must not reach the page'); });
        const server = customerProductionHarness({ starter: true, external: true, now: Date.now(), customerClientId: uid(105),
            configureExternal({ env, dependencies }) {
                env.NOFRIES_EXTERNAL_CUSTOMER_ENABLED = 'true';
                const client = provider === 'external' ? dependencies.externalCustomer.client.clientApplication : dependencies.clientApplication;
                client[stage === 'login start' ? 'getAuthCodeUrl' : 'acquireTokenByCode'] = providerFailure;
            } });
        const prefix = provider === 'external' ? '/api/external-customer-auth' : '/api/customer-auth';
        let failure;
        if (stage === 'login start') {
            failure = await request(server.app).get(prefix + '/login').set('Accept', 'text/html');
        } else {
            const started = await request(server.app).get(prefix + '/login');
            expect(started.status).toBe(302);
            failure = await request(server.app).post(prefix + '/callback').set('Accept', 'text/html')
                .set('Cookie', started.headers['set-cookie'][0].split(';')[0]).type('form')
                .send({ state: new URL(started.headers.location).searchParams.get('state'), code: 'synthetic-failed-code' });
        }
        expect(providerFailure).toHaveBeenCalledTimes(1);
        expect(failure.status).toBe(303);
        expect(failure.headers.location).toBe('/login?signin=retry&provider=' + provider);
        expect(failure.headers['cache-control']).toContain('no-store');
        expect(failure.text).not.toContain('Synthetic provider failure');
        expect((failure.headers['set-cookie'] || []).some(cookie => /^__Host-nofries-(?:external-)?customer=[^;]/.test(cookie))).toBe(false);
        const authRequestsBefore = server.state.authRequests.length;
        const page = executeBuiltLogin(server.app, { search: new URL(failure.headers.location, 'https://nofries.nz').search });
        let signup;
        try {
            await settle(page);
            if (provider === 'legacy') {
                expect(page.replace).not.toHaveBeenCalled();
                expect(page.fetch.mock.calls.map(([url, options]) => [options.method, url])).toEqual([
                    ['GET', '/api/organisation-setup/state']
                ]);
                expect(page.fetch.mock.calls[0][1].headers['X-NoFries-Customer-Entry']).toBeUndefined();
                expect(page.nodes['organisation-form'].hidden).toBe(false);
            } else {
                expect(page.fetch).not.toHaveBeenCalled();
                expect(page.replace).toHaveBeenCalledWith('/signup?provider=external&signin=retry');
                const fetch = jest.fn(async (url, options) => {
                    const result = await request(server.app).get(url).set(options.headers);
                    return new Response(result.text, { status: result.status, headers: result.headers });
                });
                signup = execute({ runtime: builtRuntime, search: '?provider=external&signin=retry', fetch });
                await settle(signup);
                expect(fetch.mock.calls.map(([url, options]) => [options.method, url])).toEqual([
                    ['GET', '/api/external-customer-signup/state']
                ]);
                expect(signup.assign).not.toHaveBeenCalled();
                expect(signup.root.textContent).toContain('Sign-in did not finish.');
                expect(signup.root.textContent).toContain('If you finished creating your account');
                signup.root.querySelector('button').click();
                expect(signup.assign).toHaveBeenCalledWith('/api/external-customer-auth/login');
            }
            expect(server.state.authRequests).toHaveLength(authRequestsBefore);
            expect(server.state.delivered).toEqual([]);
            expect(server.pool.registrations.size).toBe(0); expect(server.pool.receipts.size).toBe(0);
            expect(providerFailure).toHaveBeenCalledTimes(1);
        } finally { signup?.close(); page.close(); }
    });

test('an external customer with old valid setup bypasses unavailable legacy reads in the built default entry', async () => {
    const server = customerProductionHarness({ starter: true, external: true, now: Date.now(), customerClientId: uid(105),
        configureExternal({ env }) { env.NOFRIES_EXTERNAL_CUSTOMER_ENABLED = 'true'; } });
    const started = await server.sameOrigin(request(server.app).post('/api/organisation-setup/request'))
        .send({ email: 'retained-legacy@example.test' });
    expect(started.status).toBe(202);
    const setupCookie = started.headers['set-cookie'][0].split(';')[0];
    const loggedIn = await server.loginExternal();
    expect(loggedIn.response.status).toBe(303);
    expect(loggedIn.cookie).toMatch(/^__Host-nofries-external-customer=/);
    const store = server.getContainer('nofries-browser-auth'), original = store.getBlockBlobClient.bind(store);
    const legacyRead = jest.fn(async () => { throw new Error('Synthetic legacy setup storage outage'); });
    store.getBlockBlobClient = key => {
        const blob = original(key);
        return key.startsWith('browser-auth/organisation-setup/') ? { ...blob, download: legacyRead } : blob;
    };
    const snapshot = () => [...server.state.containers].map(([name, container]) => [name,
        [...container.records].map(([key, value]) => [key, value.toString('base64')])]);
    const before = snapshot(), deliveredBefore = server.state.delivered.length, authBefore = server.state.authRequests.length;
    const page = executeBuiltLogin(server.app, { cookie: loggedIn.cookie + '; ' + setupCookie });
    try {
        await settle(page);
        expect(page.fetch.mock.calls.map(([url, options]) => [options.method, url])).toEqual([
            ['GET', '/api/organisation-setup/state']
        ]);
        expect(page.replies[0].status).toBe(200);
        expect(page.replies[0].body).toEqual({ state: 'sign_in' });
        expect(page.replies[0].headers['x-nofries-customer-entry']).toBe('external');
        expect(page.replies[0].headers['set-cookie']).toBeUndefined();
        expect(page.replace).toHaveBeenCalledWith('/signup?provider=external');
        expect(legacyRead).not.toHaveBeenCalled();
        expect(snapshot()).toEqual(before);
        expect(server.state.delivered).toHaveLength(deliveredBefore);
        expect(server.state.authRequests).toHaveLength(authBefore);
        expect(server.pool.registrations.size).toBe(0); expect(server.pool.receipts.size).toBe(0);
    } finally { page.close(); store.getBlockBlobClient = original; }
});

function execute({ runtime = prepared.runtime, search = '', hash = '', fetch = jest.fn(async () => response({ status: 'create_account' })) } = {}) {
    const dom = createDom(), create = dom.document.createElement;
    dom.document.createElement = tag => Object.assign(create(tag), { style: {}, reportValidity: () => true });
    const help = dom.document.createElement('a'); help.setAttribute('href', '/login');
    dom.document.getElementById = id => id === 'signup' ? dom.root : id === 'signup-return-to-login' ? help : null;
    const listeners = {}, assign = jest.fn(), replace = jest.fn(), replaceState = jest.fn();
    const window = { fetch, location: { search, hash, assign, replace }, history: { replaceState },
        addEventListener(name, fn) { listeners[name] = fn; } };
    vm.runInNewContext(runtime, { document: dom.document, window, URLSearchParams, AbortController, TextDecoder, setTimeout, clearTimeout });
    return { ...dom, fetch, help, assign, replace, replaceState, close() { listeners.pagehide?.(); } };
}
function response(state, token) {
    return new Response(JSON.stringify({ state, ...(token ? { csrfToken: token } : {}) }), {
        status: 200, headers: { 'content-type': 'application/json' }
    });
}

const entryRuntime = kind => kind === 'hosted' ? builtRuntime : buildSignupDocument({ ...sources,
    customerLogin: true, customerTransport: 'external' }).runtime;
test.each(['dynamic', 'hosted'].flatMap(kind => ['login', 'create'].map(intent => [kind, intent])))(
    '%s public %s starts once after the initial fresh state without a second click', async (kind, intent) => {
        const fetch = jest.fn(async () => response({ status: 'create_account' }));
        const page = execute({ runtime: entryRuntime(kind), search: '?provider=external&intent=' + intent, fetch });
        try {
            await settle();
            expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/external-customer-signup/state']);
            expect(page.replace.mock.calls).toEqual([['/api/external-customer-auth/login' + (intent === 'create' ? '?intent=create' : '')]]);
            expect(page.assign).not.toHaveBeenCalled();
        } finally { page.close(); await settle(); }
    });

test.each(['dynamic', 'hosted'].flatMap(kind => ['login', 'create'].flatMap(intent =>
    ['company', 'consultant'].map(accountType => [kind, intent, accountType]))))(
    '%s ready %s entry opens the validated %s workspace without restarting authentication', async (kind, intent, accountType) => {
        const page = execute({ runtime: entryRuntime(kind), search: '?provider=external&intent=' + intent,
            fetch: jest.fn(async () => response({ status: 'continue_to_dashboard', accountType })) });
        try {
            await settle(); expect(page.replace.mock.calls).toEqual([[accountType === 'consultant' ? '/dashboard#organisations' : '/dashboard']]);
            expect(page.assign).not.toHaveBeenCalled();
        } finally { page.close(); }
    });

test.each(['dynamic', 'hosted'].flatMap(kind => ['login', 'create'].map(intent => [kind, intent])))(
    '%s typed expired session respects %s intent', async (kind, intent) => {
        const page = execute({ runtime: entryRuntime(kind), search: '?provider=external&intent=' + intent,
            fetch: jest.fn(async () => new Response(JSON.stringify({ error: 'Signup is unavailable', code: 'signup_signin_required' }),
                { status: 401, headers: { 'content-type': 'application/json' } })) });
        try {
            await settle(); expect(page.assign).not.toHaveBeenCalled();
            if (intent === 'login') expect(page.replace.mock.calls).toEqual([['/api/external-customer-auth/login']]);
            else { expect(page.replace).not.toHaveBeenCalled(); expect(page.root.textContent).toContain('Sign in again'); }
        } finally { page.close(); await settle(); }
    });

test.each(['', '&signin=retry', '&signin=expired', '&signin=unknown', '&signin=', '&signin=retry&signin=expired',
    '&account=choose', '&account=unknown', '&account=', '&account=choose&account=choose', '&intent=login', '&reauthenticate=0'])(
    'public intent never auto-starts with conflicting or malformed hints %s', async suffix => {
        const search = suffix ? '?provider=external&intent=create' + suffix : '?provider=external';
        const page = execute({ search });
        try { await settle(); expect(page.assign).not.toHaveBeenCalled(); expect(page.replace).not.toHaveBeenCalled(); }
        finally { page.close(); }
    });

test.each(['bad', '', 'login&intent=create'])('invalid or duplicate intent %s remains manual', async intent => {
    const page = execute({ search: '?provider=external&intent=' + intent });
    try { await settle(); expect(page.assign).not.toHaveBeenCalled(); expect(page.replace).not.toHaveBeenCalled(); }
    finally { page.close(); }
});

test.each(['dynamic', 'hosted'])('%s initial failure stays unconfirmed and fresh recovery navigation remains manual', async kind => {
    const fetch = jest.fn().mockResolvedValueOnce(new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } }));
    const page = execute({ runtime: entryRuntime(kind), search: '?provider=external&intent=login', fetch }); let fresh;
    try {
        await settle(); expect(page.root.textContent).toContain('Signup is unavailable');
        expect(page.root.textContent).toContain('Error code: NF-SIGNUP-UNCONFIRMED');
        expect(page.root.querySelector('button')).toBeNull();
        expect(fetch).toHaveBeenCalledTimes(1); expect(page.assign).not.toHaveBeenCalled(); expect(page.replace).not.toHaveBeenCalled();
        page.close(); fetch.mockResolvedValueOnce(response({ status: 'create_account' }));
        fresh = execute({ runtime: entryRuntime(kind), search: '?provider=external&signin=retry', fetch }); await settle();
        expect(fresh.root.textContent).toContain('Restart secure sign-in');
        expect(fresh.replace).not.toHaveBeenCalled(); expect(fresh.assign).not.toHaveBeenCalled();
        fresh.root.querySelector('button').click(); expect(fresh.assign).toHaveBeenCalledWith('/api/external-customer-auth/login');
        expect(fetch).toHaveBeenCalledTimes(2);
    } finally { fresh?.close(); page.close(); await settle(); }
});

test.each(['dynamic', 'hosted'])('%s unrecognized401 never triggers automatic login', async kind => {
    const page = execute({ runtime: entryRuntime(kind), search: '?provider=external&intent=login',
        fetch: jest.fn(async () => new Response(JSON.stringify({ code: 'unknown' }), { status: 401, headers: { 'content-type': 'application/json' } })) });
    try { await settle(); expect(page.root.textContent).toContain('Signup is unavailable'); expect(page.replace).not.toHaveBeenCalled(); }
    finally { page.close(); }
});

test.each(['login', 'create'])('explicit public %s preserves required setup and unchecked terms', async intent => {
    for (const state of [{ status: 'setup_details', email: 'synthetic@example.test' },
        { status: 'terms', termsText: 'Synthetic agreement', termsVersion: 'v1', termsDigest: 'a'.repeat(64) },
        { status: 'pending_preparation' }, { status: 'pending_admission' }, { status: 'unavailable' }]) {
        const page = execute({ search: '?provider=external&intent=' + intent, fetch: jest.fn(async () => response(state, csrf)) });
        try {
            await settle(); expect(page.assign).not.toHaveBeenCalled(); expect(page.replace).not.toHaveBeenCalled();
            if (state.status === 'terms') { expect(page.root.querySelector('input').checked).toBe(false); expect(page.root.querySelector('button').disabled).toBe(true); }
        } finally { page.close(); }
    }
});

test.each(['login', 'create'])('fresh public selector propagates %s only after the existing provider response', async intent => {
    const server = customerProductionHarness({ starter: true, external: true, now: Date.now(), customerClientId: uid(105),
        configureExternal({ env }) { env.NOFRIES_EXTERNAL_CUSTOMER_ENABLED = 'true'; } });
    const page = executeBuiltLogin(server.app, { search: '?intent=' + intent });
    try {
        await settle(page); expect(page.fetch.mock.calls.map(([url]) => url)).toEqual(['/api/organisation-setup/state']);
        expect(page.replace).toHaveBeenCalledWith('/signup?provider=external&intent=' + intent);
        expect(server.state.delivered).toEqual([]); expect(server.state.authRequests).toEqual([]);
    } finally { page.close(); }
});

test.each(['login', 'create'])('explicit external entry propagates public %s without a legacy email request', async intent => {
    const page = executeBuiltLogin(null, { search: '?provider=external&intent=' + intent });
    try { await settle(); expect(page.fetch).not.toHaveBeenCalled(); expect(page.replace).toHaveBeenCalledWith('/signup?provider=external&intent=' + intent); }
    finally { page.close(); }
});

test('legacy public login uses its state document while legacy creation retains email setup', async () => {
    const server = customerProductionHarness({ starter: true, now: Date.now() });
    for (const intent of ['login', 'create']) {
        const page = executeBuiltLogin(server.app, { search: '?intent=' + intent });
        try {
            await settle(page);
            if (intent === 'login') expect(page.replace).toHaveBeenCalledWith('/signup?provider=legacy&intent=login');
            else { expect(page.replace).not.toHaveBeenCalled(); expect(page.nodes['organisation-form'].hidden).toBe(false); }
            expect(server.state.delivered).toEqual([]);
        } finally { page.close(); }
    }
    const manual = execute({ search: '?provider=legacy&intent=create' });
    try { await settle(); expect(manual.replace).not.toHaveBeenCalled(); } finally { manual.close(); }
});

test.each([
    ['', '/api/customer-signup/state', '/api/customer-auth/login'],
    ['?provider=legacy', '/api/customer-signup/state', '/api/customer-auth/login'],
    ['?provider=external', '/api/external-customer-signup/state', '/api/external-customer-auth/login'],
    ['?signin=retry&provider=external', '/api/external-customer-signup/state', '/api/external-customer-auth/login']
])('hosted selector %s uses only its fixed state and explicit sign-in action', async (search, stateRoute, loginRoute) => {
    const h = execute({ search }); await settle();
    expect(h.fetch.mock.calls.map(([url]) => url)).toEqual([stateRoute]);
    expect(h.assign).not.toHaveBeenCalled(); expect(h.replace).not.toHaveBeenCalled();
    expect(h.help.getAttribute('href')).toBe(search.includes('external') ? '/api/external-customer-auth/login?account=choose' : '/login');
    h.root.querySelector('button').click();
    expect(h.assign).toHaveBeenCalledWith(loginRoute);
    h.close(); await settle();
});

test.each(['?provider=', '?provider=unknown', '?provider=https%3A%2F%2Funtrusted.invalid',
    '?provider=external&provider=legacy', '?provider=external&provider=external'])('invalid hosted selector %s performs no transport work', async search => {
    const h = execute({ search, hash: '#invitation=private-fragment' }); await settle();
    expect(h.fetch).not.toHaveBeenCalled(); expect(h.assign).not.toHaveBeenCalled(); expect(h.replace).not.toHaveBeenCalled();
    expect(h.replaceState).toHaveBeenCalledWith(null, '', '/signup');
    expect(h.root.textContent).toContain('Signup is unavailable');
    expect(h.root.textContent).not.toContain('private-fragment');
    expect(h.document.activeElement.tagName).toBe('H1');
});

test('external hosted entry rejects a legacy invitation fragment without bootstrapping it', async () => {
    const h = execute({ search: '?provider=external', hash: '#invitation=' + 'x'.repeat(43) }); await settle();
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.replaceState).toHaveBeenCalledWith(null, '', '/signup?provider=external');
    expect(h.root.textContent).toContain('Signup is unavailable');
    expect(h.assign).not.toHaveBeenCalled();
});

test.each(['company', 'consultant'])('hosted managed %s setup retains its CSRF-bound external transport', async accountType => {
    const fetch = jest.fn(async (_url, options) => options.method === 'POST'
        ? response({ status: 'continue_authentication' })
        : response({ status: 'setup_details', email: 'synthetic@example.test' }, csrf));
    const h = execute({ search: '?provider=external', fetch }); await settle();
    const values = { organisationName: 'Synthetic organisation', name: 'Synthetic Person', role: 'Owner', address: 'Synthetic address', registrationId: '' };
    for (const field of h.root.querySelectorAll('input')) {
        if (field.name === 'authorityConfirmed') field.checked = true;
        else field.value = values[field.name];
    }
    h.root.querySelector('select').value = accountType;
    for (const handler of h.root.querySelector('form').events.submit) handler({ preventDefault() {} });
    await settle();
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/external-customer-signup/state', '/api/external-customer-signup/setup']);
    expect(fetch.mock.calls[1][1].headers['X-CSRF-Token']).toBe(csrf);
    expect(JSON.parse(fetch.mock.calls[1][1].body).accountType).toBe(accountType);
    expect(h.replace).toHaveBeenCalledWith('/api/external-customer-auth/login');
    h.close();
});

test.each(['company', 'consultant'].flatMap(accountType =>
    ['failed submission', 'committed response lost'].map(outcome => [accountType, outcome])))(
    'interrupted hosted %s setup (%s) uses fresh navigation without resubmitting details or consent', async (accountType, outcome) => {
        const server = customerProductionHarness({ starter: true, external: true, now: Date.now(), customerClientId: uid(105) });
        server.addUser({ email: server.state.externalEmail });
        const snapshot = records => [...records].map(([key, value]) => [key, value.toString('base64')]);
        const legacy = server.getContainer('customer-authority').records, legacyBefore = snapshot(legacy);
        const login = await server.loginExternal();
        expect(login.response.status).toBe(303);
        const store = server.getContainer('external-starter-authority'), original = store.getBlockBlobClient.bind(store);
        if (outcome === 'failed submission') store.getBlockBlobClient = key => {
            const blob = original(key);
            if (key.includes('/starter-setups/')) blob.uploadData = async () => { throw new Error('Synthetic details outage'); };
            return blob;
        };
        let setupResponse;
        const fetch = jest.fn(async (url, options) => {
            const post = options.method === 'POST';
            let operation = request(server.app)[post ? 'post' : 'get'](url).set(options.headers).set('Cookie', login.cookie);
            if (post) operation = server.sameOrigin(operation).send(JSON.parse(options.body));
            const result = await operation;
            if (post) {
                setupResponse = result;
                if (outcome === 'committed response lost') {
                    throw new Error('Synthetic lost setup response');
                }
            }
            return new Response(result.text, { status: result.status, headers: result.headers });
        });
        let page = execute({ runtime: builtRuntime, search: '?provider=external', fetch });
        const settled = async () => {
            await Promise.allSettled(fetch.mock.results.filter(result => result.type === 'return').map(result => result.value));
            await settle();
        };
        try {
            await settled();
            const form = page.root.querySelector('form');
            const values = { organisationName: 'Synthetic organisation', name: 'Synthetic Person', role: 'Owner', address: 'Synthetic address', registrationId: '' };
            for (const field of form.querySelectorAll('input')) {
                if (field.name === 'authorityConfirmed') field.checked = true;
                else field.value = values[field.name];
            }
            form.querySelector('select').value = accountType;
            const submit = () => { for (const handler of form.events.submit) handler({ preventDefault() {} }); };
            submit(); await settled();
            expect(setupResponse.status).toBe(outcome === 'failed submission' ? 503 : 200);
            if (outcome === 'committed response lost') expect(setupResponse.body.state).toEqual({ status: 'continue_authentication' });
            const failureText = page.root.textContent;
            expect(page.root.querySelector('button')).toBeNull();
            expect(page.root.querySelector('form')).toBeNull();
            expect(page.root.getAttribute('aria-busy')).toBe('false');
            expect(page.document.activeElement.tagName).toBe('H1');
            expect(page.assign).not.toHaveBeenCalled(); expect(page.replace).not.toHaveBeenCalled();
            const retained = snapshot(store.records);
            expect([...store.records.keys()].some(key => key.startsWith('customer-subjects/'))).toBe(outcome === 'committed response lost');
            submit(); await settled();
            expect(fetch.mock.calls.map(([url, options]) => [options.method, url])).toEqual([
                ['GET', '/api/external-customer-signup/state'], ['POST', '/api/external-customer-signup/setup']
            ]);
            expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ accountType, organisationName: values.organisationName,
                details: { name: values.name, role: values.role, address: values.address, registrationId: '', authorityConfirmed: true } });
            store.getBlockBlobClient = original;
            page.close(); page = execute({ runtime: builtRuntime, search: '?provider=external', fetch }); await settled();
            expect(fetch.mock.calls.map(([url, options]) => [options.method, url])).toEqual([
                ['GET', '/api/external-customer-signup/state'], ['POST', '/api/external-customer-signup/setup'],
                ['GET', '/api/external-customer-signup/state']
            ]);
            if (outcome === 'failed submission') {
                expect(page.root.textContent).toContain('Set up your workspace');
                expect(page.root.querySelector('form')).not.toBe(form);
                expect(page.root.querySelector('select').value).toBe(accountType);
                expect(page.root.querySelector('select').disabled).toBe(true);
                for (const field of page.root.querySelectorAll('input')) {
                    if (field.type === 'checkbox') expect(field.checked).not.toBe(true);
                    else if (field.name === 'organisationName') {
                        expect(field.value).toBe(values.organisationName);
                        expect(field.disabled).toBe(true);
                    }
                    else expect(field.value || '').toBe('');
                }
                expect(page.replace).not.toHaveBeenCalled();
            } else {
                expect(page.root.textContent).toContain('Continuing account setup');
                expect(page.replace).toHaveBeenCalledTimes(1);
                expect(page.replace).toHaveBeenCalledWith('/api/external-customer-auth/login');
            }
            submit(); await settled();
            expect(fetch).toHaveBeenCalledTimes(3);
            expect(snapshot(store.records)).toEqual(retained); expect(snapshot(legacy)).toEqual(legacyBefore);
            expect(server.pool.receipts.size).toBe(0); expect(server.pool.registrations.size).toBe(0);
            expect(server.state.delivered).toEqual([]);
            expect(failureText).toContain('We could not confirm your account setup.');
            expect(failureText).toContain('Do not create another account or submit your details again.');
            expect(failureText).toContain('Error code: NF-SIGNUP-UNCONFIRMED');
            expect(failureText).not.toMatch(/invitation|No access has been granted|Synthetic .* (outage|response)/);
            expect(failureText).not.toContain('Check setup status');
        } finally { page.close(); }
    });

test.each(['', '?provider=legacy'])('hosted legacy recovery %s preserves invitation guidance and state reload', async search => {
    const fetch = jest.fn(async () => new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } }));
    const page = execute({ runtime: builtRuntime, search, fetch });
    try {
        await settle(page);
        expect(page.root.textContent).toContain('Your invitation may no longer be available');
        expect(page.root.querySelector('button').textContent).toBe('Try again');
        fetch.mockResolvedValueOnce(response({ status: 'create_account' }));
        page.root.querySelector('button').click(); await settle(page);
        expect(fetch.mock.calls.map(([url, options]) => [options.method, url])).toEqual([
            ['GET', '/api/customer-signup/state'], ['GET', '/api/customer-signup/state']
        ]);
        expect(page.assign).not.toHaveBeenCalled(); expect(page.replace).not.toHaveBeenCalled();
    } finally { page.close(); }
});

test.each([
    ['?provider=external', '', '/signup?provider=external'],
    ['?signin=retry&provider=external', '', '/signup?provider=external&signin=retry'],
    ['?signin=expired&provider=external', '', '/signup?provider=external&signin=expired'],
    ['?signin=expired&signin=retry&provider=external', '', '/signup?provider=external'],
    ['?signin=untrusted&provider=external&code=private-value', '', '/signup?provider=external'],
    ['?provider=external&provider=legacy', '', '/signup?provider=invalid'],
    ['?provider=https%3A%2F%2Funtrusted.invalid', '', '/signup?provider=invalid'],
    ['?provider=external', '#invitation=private-fragment', '/signup?provider=invalid']
])('static login %s hands off locally before any legacy email flow', (search, hash, destination) => {
    const source = fs.readFileSync(path.join(root, 'dist/js/organisation-setup.js'), 'utf8');
    const replace = jest.fn(), fetch = jest.fn(() => { throw new Error('No login API request is expected'); });
    vm.runInNewContext(source, { document: { getElementById: id => id === 'organisation-form' ? {} : null },
        window: { location: { search, hash, replace } }, fetch, URLSearchParams });
    expect(replace).toHaveBeenCalledWith(destination); expect(fetch).not.toHaveBeenCalled();
});

test('the real static build authorizes only its hosted selector and exact public helper', () => {
    const hash = crypto.createHash('sha256').update(builtRuntime).digest('base64');
    const helperHash = crypto.createHash('sha256').update(builtHelpRuntime).digest('base64');
    const route = builtConfig.routes.find(item => item.route === '/signup');
    expect(route.headers['Content-Security-Policy'].split(';').map(value => value.trim())
        .filter(value => /^script-src(?:\s|$)/.test(value)))
        .toEqual(["script-src 'sha256-" + hash + "' 'sha256-" + helperHash + "'"]);
    expect(route.headers['Content-Security-Policy']).not.toContain('unsafe-inline');
    expect(fs.readFileSync(path.join(root, 'dist/staticwebapp.config.json')).length).toBeLessThanOrEqual(20000);
});

test('a real synthetic external callback opens its setup state through the actual built document', async () => {
    const h = customerProductionHarness({ starter: true, external: true, now: Date.now(), customerClientId: uid(105) });
    const login = await h.loginExternal();
    expect(login.response.status).toBe(303); expect(login.response.headers.location).toBe('/signup?provider=external');
    const fetch = jest.fn(async (url, options) => {
        const result = await request(h.app).get(url).set(options.headers).set('Cookie', login.cookie);
        return new Response(result.text, { status: result.status, headers: result.headers });
    });
    const page = execute({ runtime: builtRuntime, search: new URL(login.response.headers.location, 'https://synthetic.invalid').search, fetch });
    await settle(page);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/external-customer-signup/state']);
    expect(page.root.textContent).toContain('Set up your workspace');
    expect(page.assign).not.toHaveBeenCalled(); expect(page.replace).not.toHaveBeenCalled();
    page.close();
});

test.each([undefined, 'false'])('actual built external entry with ENABLED=%s cannot activate or fall back', async enabled => {
    const h = customerProductionHarness({ starter: true, now: Date.now(), customerClientId: uid(105) });
    const env = { ...h.env };
    if (enabled !== undefined) env.NOFRIES_EXTERNAL_CUSTOMER_ENABLED = enabled;
    const credentialRead = jest.fn(() => { throw new Error('Inactive credential read'); });
    Object.defineProperty(env, 'NOFRIES_EXTERNAL_CUSTOMER_CLIENT_SECRET', { get: credentialRead, configurable: true });
    expect(require('../lib/externalCustomerConfiguration').externalCustomerConfiguration(env)).toBeNull();
    expect(credentialRead).not.toHaveBeenCalled();
    // The legacy harness copies its environment for independent auth clients.
    // Check the disabled external reader separately, then omit that credential
    // altogether while exercising the real HTTP composition and built page.
    delete env.NOFRIES_EXTERNAL_CUSTOMER_CLIENT_SECRET;
    const app = createProductionApplication(env, h.dependencies);
    const snapshot = () => [...h.state.containers].map(([name, store]) => [name, [...store.records].map(([key, value]) => [key, value.toString('base64')])]);
    const before = snapshot();
    const fetch = jest.fn(async (url, options) => {
        const result = await request(app).get(url).set(options.headers);
        expect(result.status).toBe(410); expect(result.headers.location).toBeUndefined(); expect(result.headers['set-cookie']).toBeUndefined();
        return new Response(result.text, { status: result.status, headers: result.headers });
    });
    const page = execute({ runtime: builtRuntime, search: '?provider=external', fetch }); await settle(page);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/external-customer-signup/state']);
    expect(page.assign).not.toHaveBeenCalled(); expect(page.replace).not.toHaveBeenCalled();
    expect(credentialRead).not.toHaveBeenCalled(); expect(snapshot()).toEqual(before);
    expect(h.state.authRequests).toEqual([]); expect(h.state.delivered).toEqual([]);
    expect(h.pool.registrations.size).toBe(0); expect(h.pool.receipts.size).toBe(0);
    page.close();
});


test.each(['login', 'create'])('server-selected external body propagates %s without a redundant selector request', async intent => {
    const page = executeBuiltLogin(null, { search: '?intent=' + intent, customerProvider: 'external' });
    try { await settle(page); expect(page.fetch).not.toHaveBeenCalled();
        expect(page.replace).toHaveBeenCalledWith('/signup?provider=external&intent=' + intent);
    } finally { page.close(); }
});

test.each(['dynamic', 'hosted'])('%s disposing an initial check prevents a late automatic handoff', async kind => {
    let resolve;
    const page = execute({ runtime: entryRuntime(kind), search: '?provider=external&intent=login',
        fetch: jest.fn(() => new Promise(done => { resolve = done; })) });
    page.close(); resolve(response({ status: 'create_account' })); await settle(page);
    expect(page.replace).not.toHaveBeenCalled(); expect(page.assign).not.toHaveBeenCalled();
});

test.each(['&signin=retry', '&signin=expired', '&signin=bad', '&signin=', '&signin=retry&signin=retry',
    '&account=choose', '&account=bad', '&account=', '&account=choose&account=choose', '&intent=login', '&reauthenticate=1'])(
    'recognized authentication-needed response remains manual with any recovery/account hint %s', async suffix => {
        const page = execute({ search: '?provider=external&intent=login' + suffix,
            fetch: jest.fn(async () => new Response(JSON.stringify({ error: 'Signup is unavailable', code: 'signup_signin_required' }),
                { status: 401, headers: { 'content-type': 'application/json' } })) });
        try { await settle(); expect(page.replace).not.toHaveBeenCalled(); expect(page.assign).not.toHaveBeenCalled(); }
        finally { page.close(); }
    });

test.each(['dynamic', 'hosted'])('%s a fresh authentication-needed observation keeps explicit sign-in routes without automatic retry', async kind => {
    const fetch = jest.fn().mockResolvedValueOnce(new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } }));
    const page = execute({ runtime: entryRuntime(kind), search: '?provider=external&intent=login', fetch }); let fresh;
    try {
        await settle(); expect(page.root.querySelector('button')).toBeNull(); expect(fetch).toHaveBeenCalledTimes(1);
        page.close();
        fetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Signup is unavailable', code: 'signup_signin_required' }),
            { status: 401, headers: { 'content-type': 'application/json' } }));
        fresh = execute({ runtime: entryRuntime(kind), search: '?provider=external&signin=retry', fetch }); await settle();
        expect(fresh.root.textContent).toContain('Sign in again');
        expect(fresh.replace).not.toHaveBeenCalled(); expect(fresh.assign).not.toHaveBeenCalled();
        const signIn = [...fresh.root.querySelectorAll('a')].find(link => link.textContent === 'Sign in again');
        expect(signIn.href).toBe('/api/external-customer-auth/login');
        expect(fetch).toHaveBeenCalledTimes(2);
    } finally { fresh?.close(); page.close(); await settle(); }
});


test.each(['dynamic', 'hosted'])('%s legacy invitation fragment consumes only its bootstrap and keeps intent manual', async kind => {
    const runtime = kind === 'hosted' ? builtRuntime : buildSignupDocument({ ...sources, customerLogin: true }).runtime;
    const fetch = jest.fn().mockResolvedValueOnce(new Response(null, { status: 204 }))
        .mockResolvedValueOnce(response({ status: 'create_account' }));
    const page = execute({ runtime, search: '?provider=legacy&intent=login', hash: '#invitation=' + 'a'.repeat(43), fetch });
    try {
        await settle();
        expect(fetch.mock.calls.map(([url, options]) => [url, options.method])).toEqual([
            ['/api/customer-signup/bootstrap', 'POST'], ['/api/customer-signup/state', 'GET']]);
        expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ invitationToken: 'a'.repeat(43) });
        expect(page.replace).not.toHaveBeenCalled(); expect(page.assign).not.toHaveBeenCalled();
        expect(page.root.querySelector('button').textContent).toBe('Login');
        page.root.querySelector('button').click();
        expect(page.assign).toHaveBeenCalledWith('/api/customer-auth/login');
    } finally { page.close(); await settle(); }
});

// Keep the real production composition, identity policy, HTTP handler and store.
// This private SDK boundary models URL serialization only; no provider is called.
test.each([false, true])('production registration requires the SDK to retain its fixed prompt (preserve=%s)', async preservePrompt => {
    const requests = [];
    const server = customerProductionHarness({ starter: true, external: true, now: Date.now(), customerClientId: uid(105),
        configureExternal({ env, dependencies }) {
            env.NOFRIES_EXTERNAL_CUSTOMER_ENABLED = 'true';
            const client = dependencies.externalCustomer.client.clientApplication, serialize = client.getAuthCodeUrl;
            client.getAuthCodeUrl = async input => {
                requests.push(input);
                const url = new URL(await serialize(input));
                if (preservePrompt && input.prompt) url.searchParams.set('prompt', input.prompt);
                return url.href;
            };
        } });
    const snapshot = () => [...server.state.containers].flatMap(([container, store]) =>
        [...store.records].map(([key, bytes]) => ({ container, key, bytes: bytes.toString('base64') })));
    const initial = snapshot();
    const ordinary = await request(server.app).get('/api/external-customer-auth/login').set('Accept', 'application/json');
    expect(ordinary.status).toBe(302); expect(requests).toHaveLength(1);
    expect(requests[0].prompt).toBeUndefined(); expect(new URL(ordinary.headers.location).searchParams.has('prompt')).toBe(false);
    const before = snapshot();
    expect(before).toHaveLength(initial.length + 1);
    const registration = await request(server.app).get('/api/external-customer-auth/login?intent=create').set('Accept', 'application/json');
    expect(requests).toHaveLength(2); expect(requests[1].prompt).toBe('create'); expect(requests[1]).not.toHaveProperty('loginHint');
    if (preservePrompt) {
        expect(registration.status).toBe(302);
        const url = new URL(registration.headers.location);
        expect(url.searchParams.getAll('prompt')).toEqual(['create']); expect(url.searchParams.has('login_hint')).toBe(false);
        const added = snapshot().filter(row => !before.some(previous => previous.container === row.container && previous.key === row.key));
        expect(added).toHaveLength(1); expect(added[0].key).toMatch(/^browser-auth\/transactions\//);
        const transaction = JSON.parse(Buffer.from(added[0].bytes, 'base64').toString());
        expect(transaction).toMatchObject({ returnTo: '/signup', customerTransport: 'external', customer: { verifiedEmail: null } });
        expect(transaction.expiresAt - transaction.issuedAt).toBe(300000); expect(transaction).not.toHaveProperty('registration');
        for (const field of ['state', 'nonce']) expect(url.searchParams.get(field)).toBe(transaction[field]);
        expect(url.searchParams.get('state')).not.toBe(new URL(ordinary.headers.location).searchParams.get('state'));
        expect(url.searchParams.get('nonce')).not.toBe(new URL(ordinary.headers.location).searchParams.get('nonce'));
        expect(registration.headers['set-cookie'][0]).toContain('Max-Age=300');
    } else {
        expect(registration.status).toBe(503); expect(registration.body.code).toBe('browser_auth_unavailable');
        expect(registration.headers['set-cookie']).toBeUndefined(); expect(snapshot()).toEqual(before);
    }
    for (const row of before) expect(snapshot()).toContainEqual(row);
    const after = snapshot();
    for (const suffix of ['intent=create&account=choose', 'intent=create&intent=create']) {
        const conflict = await request(server.app).get('/api/external-customer-auth/login?' + suffix).set('Accept', 'application/json');
        expect(conflict.status).toBe(400); expect(conflict.headers['set-cookie']).toBeUndefined();
        expect(requests).toHaveLength(2); expect(snapshot()).toEqual(after);
    }
    expect(server.state.delivered).toEqual([]); expect(server.pool.registrations.size).toBe(0); expect(server.pool.receipts.size).toBe(0);
});
