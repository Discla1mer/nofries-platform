'use strict';

const request = require('supertest');
const vm = require('vm');
const crypto = require('crypto');
const http = require('node:http');
const { createDom } = require('../fixtures/dashboardDom');

// Execute the HTTP-served document/loader and protected bundle against the same
// application. Only the DOM and native asset events are doubles; this is not a
// layout/browser-CSP test. Hashes are checked against the actual returned bytes.
async function servedDashboard(options) {
    // Own one server for this rendering so aborted Supertest requests cannot
    // leave their individually created listeners alive after a failed deadline.
    const server = http.createServer(options.app);
    try {
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', resolve);
        });
        return await renderDashboard({ ...options, app: server });
    } finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
}

async function renderDashboard({ app, cookie, now, origin, hash: initialHash = '', chooseOrganisationLabel }) {
    const page = await request(app).get('/dashboard').set('Cookie', cookie);
    expect(page.status).toBe(200);
    const { document, window } = createDom();
    window.location.hash = initialHash;
    const elements = {};
    for (const match of page.text.matchAll(/<([a-z][a-z0-9]*)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
        const node = document.createElement(match[1]); node.id = match[3];
        for (const attr of match[2].matchAll(/([\w-]+)="([^"]*)"/g)) node.setAttribute(attr[1], attr[2]);
        elements[node.id] = node;
    }
    document.getElementById = id => elements[id] || null;
    document.body = document.createElement('body');
    document.querySelectorAll = selector => document.body.querySelectorAll(selector);
    document.body.dataset.page = page.text.match(/<body data-page="([^"]+)"/)[1];
    if (/<body\b[^>]*data-customer-provider="external"/.test(page.text)) document.body.dataset.customerProvider = 'external';
    document.body.append(elements.dashboardEntry);
    elements.dashboardEntry.append(elements.dashboardStatusPanel, elements.dashboardChooser, elements.dashboardApp);
    document.head = document.createElement('head');
    document.head.removeChild = node => { document.head.children = document.head.children.filter(item => item !== node); node.parentNode = null; };
    window.setTimeout = setTimeout; window.clearTimeout = clearTimeout;
    window.crypto = { randomUUID: crypto.randomUUID };
    const trace = [], failures = [];
    const pendingRequests = new Map();
    async function send(url, init = {}) {
        if (init.signal?.aborted) throw new Error('served_dashboard_request_aborted');
        const method = (init.method || 'GET').toLowerCase();
        let call = request(app)[method](url).set('Cookie', cookie);
        if (init.headers) call = call.set(init.headers);
        if (method === 'post') call = call.set('Origin', origin).set('Sec-Fetch-Site', 'same-origin');
        if (init.body !== undefined) call = call.send(init.body);
        const abort = () => { call.abort(); };
        init.signal?.addEventListener('abort', abort, { once: true });
        const pending = Promise.resolve(call);
        pendingRequests.set(call, pending);
        try {
            const response = await pending;
            trace.push({ url, method, status: response.status });
            return response;
        } finally {
            pendingRequests.delete(call);
            init.signal?.removeEventListener('abort', abort);
        }
    }
    const fetch = async (url, init) => {
        const response = await send(url, init);
        return { status: response.status, redirected: false, type: 'basic',
            headers: { get: key => response.headers[key.toLowerCase()] },
            json: async () => parseJson(response.text), text: async () => response.text };
    };
    const RealDate = Date;
    class ClockDate extends RealDate {
        constructor(...args) { super(...(args.length ? args : [now])); }
        static now() { return Number(new RealDate(now)); }
    }
    const context = vm.createContext({ document, window, globalThis: window, fetch, AbortController, URL,
        setTimeout, clearTimeout, Date: ClockDate });
    // A browser parses network JSON in its own realm. Host-parsed objects have
    // foreign prototypes and correctly fail the delivered client's data guard.
    const parseJson = vm.runInContext('JSON.parse', context);
    const hash = source => 'sha256-' + crypto.createHash('sha256').update(source).digest('base64');
    document.head.append = node => {
        node.parentNode = document.head; document.head.children.push(node);
        (async () => {
            const response = await send(node.src || node.href);
            expect(response.status).toBe(200);
            expect(hash(response.text)).toBe(node.integrity);
            if (node.tagName === 'SCRIPT') vm.runInContext(response.text, context);
            if (node.onload) node.onload();
        })().catch(error => { failures.push(error); if (node.onerror) node.onerror(); });
    };
    try {
        const loader = page.text.match(/<script id="dashboardRuntime">([\s\S]*?)<\/script>/)[1];
        expect(page.headers['content-security-policy']).toContain("'" + hash(loader) + "'");
        vm.runInContext(loader, context);
        const deadline = RealDate.now() + 10000;
        const unsettled = () => !document.body.dataset.dashboardState || document.body.dataset.dashboardState === 'loading' || pendingRequests.size > 0;
        async function settle() {
            while (unsettled() && RealDate.now() < deadline) await new Promise(resolve => setImmediate(resolve));
            if (failures.length) throw failures[0];
            if (unsettled()) throw new Error('served_dashboard_did_not_settle');
        }
        await settle();
        if (chooseOrganisationLabel !== undefined) {
            expect(document.body.dataset.dashboardState).toBe('selection');
            const choices = elements.dashboardChoices.querySelectorAll('button').filter(button => button.textContent === chooseOrganisationLabel);
            expect(choices).toHaveLength(1);
            choices[0].click();
            await settle();
        }
        return { state: document.body.dataset.dashboardState, text: elements.dashboardApp.textContent,
            hidden: elements.dashboardApp.hidden, trace };
    } finally {
        window.dispatch('pagehide');
        const pending = [...pendingRequests.values()];
        for (const call of pendingRequests.keys()) call.abort();
        await Promise.allSettled(pending);
    }
}

module.exports = { servedDashboard };
