(function () {
    'use strict';
    // Staff contact request list (read only). Served only while
    // NOFRIES_OPERATOR_CONTACT_REQUESTS_ENABLED is 'true'. Emails travel only in
    // the same-origin response body; nothing is put in a URL or stored.
    const panel = document.getElementById('contactRequestsPanel');
    if (!panel) return;
    const button = document.getElementById('contactRequestsLoad');
    const status = document.getElementById('contactRequestsStatus');
    const result = document.getElementById('contactRequestsResults');
    let active = null;
    const when = value => new Date(value).toLocaleString('en-NZ', { timeZone: 'Pacific/Auckland', dateStyle: 'medium', timeStyle: 'short' });
    async function request(url, body, signal) {
        const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
            redirect: 'error', signal, headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
                ...(url === '/api/dashboard/session' ? { 'X-Nofries-Dashboard-Purpose': 'operator_dashboard' } : {}) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        if (response.redirected || !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') || '')) throw new Error('unavailable');
        return { status: response.status, value: await response.json() };
    }
    // The native operator session gate is a precondition for every staff read.
    async function ready(signal) {
        let session = await request('/api/dashboard/session', undefined, signal);
        if (session.status === 409 && session.value.code === 'dashboard_initialization_required') {
            session = await request('/api/dashboard/session', { operationId: window.crypto.randomUUID() }, signal);
            if (session.status !== 200 || session.value.initialized !== true) throw new Error('unavailable');
            session = await request('/api/dashboard/session', undefined, signal);
        }
        if ([401, 403].includes(session.status)) throw Object.assign(new Error('denied'), { status: session.status });
        if (session.status !== 200 || session.value.authenticated !== true || session.value.purpose !== 'operator_dashboard') throw new Error('unavailable');
    }
    function clear() {
        active?.abort(); active = null; result.replaceChildren(); status.textContent = '';
        button.disabled = false; result.setAttribute('aria-busy', 'false');
    }
    async function load() {
        clear();
        const controller = new AbortController(); active = controller;
        const timer = setTimeout(() => controller.abort(), 30000);
        button.disabled = true; result.setAttribute('aria-busy', 'true');
        status.textContent = 'Checking your staff session…';
        try {
            await ready(controller.signal);
            if (active !== controller) return;
            status.textContent = 'Loading contact requests…';
            const response = await request('/api/dashboard-admin/accounts/lookup', { contactRequests: true }, controller.signal);
            if (active !== controller) return;
            if (response.status !== 200) throw Object.assign(new Error('refused'), { status: response.status });
            const value = response.value;
            const days = Number.isSafeInteger(value.windowDays) ? value.windowDays : 90;
            if (!value.rows.length) {
                status.textContent = `No contact requests in the last ${days} days` + (value.truncated ? ' among the accounts checked. Older or unreadable accounts were not checked.' : '.');
                return;
            }
            const table = document.createElement('table');
            table.createCaption().textContent = 'Contact requests, newest first (read only)';
            const head = table.createTHead().insertRow();
            ['Requested (NZ time)', 'Organisation', 'Topic', 'Contact email'].forEach(label => {
                const cell = document.createElement('th'); cell.scope = 'col'; cell.textContent = label; head.append(cell);
            });
            const body = table.createTBody();
            value.rows.forEach(row => {
                const tr = body.insertRow();
                tr.insertCell().textContent = when(row.requestedAt);
                tr.insertCell().textContent = row.organisation || '—';
                tr.insertCell().textContent = row.topic;
                const email = tr.insertCell();
                email.textContent = row.contactEmail || '—';
                if (row.contactEmail && row.contactBasis !== 'requester') {
                    email.append(Object.assign(document.createElement('small'), { textContent: ' (account owner; the person who asked is not on the account list)' }));
                }
            });
            result.append(table);
            status.textContent = `${value.rows.length} request${value.rows.length === 1 ? '' : 's'} in the last ${days} days` +
                (value.truncated ? '. The list may be incomplete: it is capped, or some accounts could not be read in full.' : '.');
        } catch (error) {
            if (active !== controller) return;
            status.textContent = error.name === 'AbortError' ? 'Loading contact requests timed out. Try again.' :
                error.status === 429 ? 'Too many requests. Try again in a minute.' :
                [401, 403].includes(error.status) ? 'Staff admin access is required. Sign in again.' : 'Contact requests are unavailable.';
        } finally {
            clearTimeout(timer);
            if (active === controller) { active = null; button.disabled = false; result.setAttribute('aria-busy', 'false'); }
        }
    }
    window.addEventListener('pagehide', clear);
    button.addEventListener('click', load);
    status.textContent = 'Select Load contact requests to see who asked No Fries to contact them.';
    panel.hidden = false;
}());
