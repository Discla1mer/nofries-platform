(function () {
    'use strict';
    // Staff view of anonymous daily funnel totals (#151 F5). The panel stays
    // hidden unless the capability check grants `funnel`.
    const byId = id => document.getElementById(id);
    const panel = byId('funnelPanel'), load = byId('funnelLoad'), status = byId('funnelStatus'), result = byId('funnelResult');
    if (!panel || !load || !status || !result) return;
    const EVENTS = ['visit', 'signup_started', 'code_confirmed', 'first_answer', 'submitted', 'result_viewed', 'enquiry_sent'];
    const LABELS = { visit: 'Home page visits', signup_started: 'Signups started', code_confirmed: 'Codes confirmed',
        first_answer: 'First answers', submitted: 'Assessments submitted', result_viewed: 'Results viewed', enquiry_sent: 'Enquiries sent' };
    const DAY = /^\d{4}-\d{2}-\d{2}$/;
    let sequence = 0;
    const node = (tag, text) => { const item = document.createElement(tag); if (text !== undefined) item.textContent = text; return item; };
    function clear() { result.replaceChildren(); result.hidden = true; }
    function hide() { sequence += 1; clear(); panel.hidden = true; load.disabled = true; status.textContent = 'No funnel counts have been loaded.'; }
    async function read(path, request) {
        const response = await fetch('/api/dashboard-admin/' + path, { method: 'GET', credentials: 'same-origin', cache: 'no-store',
            redirect: 'error', headers: { Accept: 'application/json' } });
        if (request !== sequence) return null;
        if ([401, 403].includes(response.status)) { hide(); return null; }
        if (!response.ok || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) throw new Error();
        return response.json();
    }
    function validate(body) {
        if (!body || !Array.isArray(body.days) || body.days.length !== 30 || !DAY.test(body.from) || !DAY.test(body.to) ||
            JSON.stringify(body.events) !== JSON.stringify(EVENTS)) throw new Error();
        for (const row of body.days) {
            if (!row || !DAY.test(row.day) || !row.counts || EVENTS.some(event => !Number.isSafeInteger(row.counts[event]) || row.counts[event] < 0)) throw new Error();
        }
    }
    function render(body) {
        validate(body);
        const table = node('table'), head = node('thead'), headRow = node('tr'), rows = node('tbody'), foot = node('tfoot'), totalRow = node('tr');
        table.append(node('caption', 'Daily totals from ' + body.from + ' to ' + body.to + ', newest first'));
        const corner = node('th', 'Day'); corner.scope = 'col'; headRow.append(corner);
        for (const event of EVENTS) { const cell = node('th', LABELS[event]); cell.scope = 'col'; headRow.append(cell); }
        head.append(headRow);
        const totals = Object.fromEntries(EVENTS.map(event => [event, 0]));
        for (const row of body.days.slice().reverse()) {
            const line = node('tr'), day = node('th', row.day); day.scope = 'row'; line.append(day);
            for (const event of EVENTS) { totals[event] += row.counts[event]; line.append(node('td', String(row.counts[event]))); }
            rows.append(line);
        }
        const label = node('th', '30-day total'); label.scope = 'row'; totalRow.append(label);
        for (const event of EVENTS) totalRow.append(node('td', String(totals[event])));
        foot.append(totalRow);
        table.append(head, rows, foot);
        result.replaceChildren(table); result.hidden = false;
        status.textContent = 'Funnel counts loaded for ' + body.from + ' to ' + body.to + '.';
    }
    async function access() {
        const request = ++sequence;
        try {
            const body = await read('capabilities', request);
            if (body === null) return;
            if (body.funnel === true) { panel.hidden = false; load.disabled = false; } else hide();
        } catch (_) { if (request === sequence) hide(); }
    }
    async function show() {
        const request = ++sequence;
        load.disabled = true; clear(); status.textContent = 'Loading funnel counts…';
        try {
            const body = await read('funnel', request);
            if (body !== null) render(body);
        } catch (_) { if (request === sequence) status.textContent = 'Funnel counts could not be loaded. Try again.'; }
        finally { if (request === sequence && !panel.hidden) load.disabled = false; }
    }
    load.addEventListener('click', show);
    window.addEventListener('dashboard-admin-revoked', hide);
    window.addEventListener('pagehide', hide);
    window.addEventListener('pageshow', event => { if (event && event.persisted) access(); });
    access();
}());
