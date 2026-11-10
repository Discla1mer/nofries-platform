(function () {
    'use strict';
    const panel = document.getElementById('accountLookupPanel');
    if (!panel) return;
    const form = document.getElementById('accountLookupForm');
    const email = document.getElementById('accountLookupEmail');
    const status = document.getElementById('accountLookupStatus');
    const result = document.getElementById('accountLookupResults');
    const button = form.querySelector('button');
    const COLUMNS = [['email', 'Email'], ['kind', 'Store'], ['schemaVersion', 'Schema'], ['plan', 'Plan'], ['accountType', 'Type'],
        ['organisation', 'Organisation'], ['status', 'Sign-in record'], ['effectiveAt', 'Activated (UTC)'], ['expiresAt', 'Recorded end date, not enforced (UTC)'], ['revision', 'Revision']];
    // Accounts do not expire: a passed recorded end date is shown, never treated as a block.
    const STATUS = { active: 'Active', expired: 'Active (recorded end date passed, not enforced)', revoked: 'Revoked', missing: 'No sign-in record', unknown: 'Not scanned (cap reached)' };
    let active = null;
    const text = value => value === null || value === undefined || value === '' ? '—' : String(value);
    function select(row) { window.nofriesAccountSelection = row; window.dispatchEvent(new Event('nofries-account-selection')); }
    function reset() {
        active?.abort(); active = null; select(null); result.replaceChildren(); button.disabled = false; result.setAttribute('aria-busy', 'false');
    }
    async function request(url, body, signal) {
        const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
            redirect: 'error', signal, headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
                ...(url === '/api/dashboard/session' ? { 'X-Nofries-Dashboard-Purpose': 'operator_dashboard' } : {}) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        if (response.redirected || !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') || '')) throw new Error('unavailable');
        return { status: response.status, value: await response.json() };
    }
    // The native operator session gate is a precondition for every staff read.
    // Opening it is explicit and idempotent; it grants nothing by itself.
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
    function message(error) {
        if (error.name === 'AbortError') return 'Lookup timed out. Try again.';
        if (error.status === 429) return 'Too many lookups. Try again in a minute.';
        if ([401, 403].includes(error.status)) return 'Staff admin access is required. Sign in again.';
        return 'Account lookup is unavailable.';
    }
    function membershipCell(row, cell) {
        if (!row.selector) { cell.textContent = '—'; return; }
        const show = document.createElement('button'); show.type = 'button'; show.textContent = 'Show dashboard access';
        const output = document.createElement('div'); output.setAttribute('aria-live', 'polite');
        show.addEventListener('click', async () => {
            show.disabled = true; output.textContent = 'Reading dashboard access…';
            const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 12000);
            try {
                const response = await request('/api/dashboard-admin/lookup', row.selector, controller.signal);
                if (response.status !== 200) throw Object.assign(new Error('denied'), { status: response.status });
                const value = response.value.result;
                output.replaceChildren();
                if (value.status !== 'found') { output.textContent = value.status === 'not_found' ? 'No dashboard membership in this organisation.' : 'Dashboard access is unavailable right now.'; return; }
                row.membershipRevision = value.revisions.membership; row.memberships = value.memberships;
                const list = document.createElement('ul');
                value.memberships.forEach(member => {
                    const item = document.createElement('li');
                    item.textContent = `${member.effectiveStatus} (saved ${member.status}); roles ${member.roles.join(', ')}; until ${member.validUntil}`;
                    list.append(item);
                });
                if (!value.memberships.length) output.textContent = 'Invited only; no membership yet.';
                output.append(list, Object.assign(document.createElement('p'), { textContent: `${value.organisation.displayName} · membership revision ${value.revisions.membership}` }));
                if (window.nofriesAccountSelection === row) select(row);
            } catch (error) { output.textContent = message(error); }
            finally { clearTimeout(timer); show.disabled = false; }
        });
        cell.append(show, output);
    }
    form.addEventListener('input', reset);
    panel.hidden = false;
    window.addEventListener('pagehide', () => { reset(); email.value = ''; status.textContent = ''; });
    window.addEventListener('pageshow', event => { if (event?.persisted) { reset(); email.value = ''; status.textContent = ''; } });
    form.addEventListener('submit', async event => {
        event.preventDefault();
        reset();
        const controller = new AbortController(); active = controller;
        const timer = setTimeout(() => controller.abort(), 20000);
        button.disabled = true; result.setAttribute('aria-busy', 'true');
        status.textContent = 'Checking your staff session…';
        try {
            await ready(controller.signal);
            if (active !== controller) return;
            status.textContent = 'Looking up account…';
            const response = await request('/api/dashboard-admin/accounts/lookup', { email: email.value.trim() }, controller.signal);
            if (active !== controller) return;
            if (response.status !== 200) throw Object.assign(new Error('refused'), { status: response.status });
            const value = response.value;
            if (!value.rows.length) {
                status.textContent = value.truncated ? 'The bounded scan hit its 100-record cap before finishing, so this result is incomplete. No matching record was seen.'
                    : 'No account records were found for this email in any customer store.';
                return;
            }
            const table = document.createElement('table');
            table.createCaption().textContent = 'Customer account records (read only)';
            const head = table.createTHead().insertRow();
            [...COLUMNS.map(([, label]) => label), 'Dashboard access', ...(value.rows.some(row => row.selector) ? ['Select'] : [])].forEach(label => {
                const cell = document.createElement('th'); cell.scope = 'col'; cell.textContent = label; head.append(cell);
            });
            const body = table.createTBody();
            value.rows.forEach(row => {
                const tr = body.insertRow();
                COLUMNS.forEach(([key]) => { tr.insertCell().textContent = key === 'status' ? STATUS[row.status] || text(row.status) : text(row[key]); });
                membershipCell(row, tr.insertCell());
                if (row.selector) {
                    const choose = document.createElement('button'); choose.type = 'button'; choose.textContent = 'Select account';
                    choose.addEventListener('click', () => select(row)); tr.insertCell().append(choose);
                }
            });
            result.append(table);
            status.textContent = (value.truncated ? 'The bounded scan hit its 100-record cap, so other matching records may exist. ' : 'Lookup complete. ')
                + 'Recorded end dates are not enforced. An active record alone does not prove sign-in will succeed.';
        } catch (error) {
            if (active === controller) status.textContent = message(error);
        } finally {
            clearTimeout(timer);
            if (active === controller) { active = null; button.disabled = false; result.setAttribute('aria-busy', 'false'); }
        }
    });
}());
