(function () {
    'use strict';
    const byId = id => document.getElementById(id);
    const load = byId('signupQueueLoad'), next = byId('signupQueueNext'), cancel = byId('signupQueueCancel');
    const check = byId('signupQueueCheck'), status = byId('signupQueueStatus'), result = byId('signupQueueResult');
    let allowed = false, cursor = null, sequence = 0, active = null;
    function clear() { result.replaceChildren(); result.hidden = true; cursor = null; next.disabled = true; }
    function stop() {
        sequence += 1;
        if (active) { active.controller.abort(); window.clearTimeout(active.timer); active = null; }
        cancel.hidden = true; result.setAttribute('aria-busy', 'false'); load.disabled = !allowed;
    }
    function revoke(code, broadcast = true) {
        if (broadcast) window.dispatchEvent?.(new window.CustomEvent('dashboard-admin-revoked', { detail: code }));
        allowed = false; stop(); clear(); check.disabled = false;
        status.textContent = code === 401 ? 'Your session has ended. Sign in to staff workspace again.' :
            'Signup access is unavailable. No signup records are displayed.';
    }
    function begin() {
        stop(); clear();
        const request = { sequence, controller: new AbortController(), timer: null };
        request.timer = window.setTimeout(() => { request.controller.abort(); if (request.sequence === sequence) {
            stop(); clear(); status.textContent = 'Signup request timed out. No signup records are displayed.'; check.disabled = false;
        } }, 15000);
        active = request;
        return request;
    }
    async function read(request, body) {
        const response = await fetch('/api/dashboard-admin/' + (body ? 'signups' : 'capabilities'), {
            method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: request.controller.signal,
            headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
            ...(body ? { body: JSON.stringify(body) } : {}) });
        if ([401, 403].includes(response.status)) { revoke(response.status); return null; }
        if (request.sequence !== sequence || request.controller.signal.aborted) return null;
        if (!response.ok || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) throw new Error();
        return response.json();
    }
    function finish(request) {
        window.clearTimeout(request.timer);
        if (active === request) active = null;
        if (request.sequence === sequence) { load.disabled = !allowed; check.disabled = false; cancel.hidden = true; result.setAttribute('aria-busy', 'false'); }
    }
    async function access() {
        allowed = false; const request = begin(); check.disabled = true;
        status.textContent = 'Checking signup capability. No signup records have been loaded.';
        try {
            const body = await read(request);
            if (request.sequence !== sequence || request.controller.signal.aborted || body === null) return;
            allowed = body?.signupList === true;
            status.textContent = allowed ? 'Signup access confirmed. Load the authorised population to view recorded milestones.' :
                'Signup capability is unavailable. No signup records have been loaded.';
        } catch (_) { if (request.sequence === sequence) status.textContent = 'Signup capability could not be checked. No signup records have been loaded.'; }
        finally { finish(request); }
    }
    function node(tag, value) { const item = document.createElement(tag); if (value !== undefined) item.textContent = value; return item; }
    function exact(value, keys) { return value && typeof value === 'object' && !Array.isArray(value) &&
        Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)); }
    const instant = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
        Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
    const labels = { accountSaved: 'Account saved', setupSaved: 'Setup saved', termsAccepted: 'Terms accepted', accountActivated: 'Account activated', admission: 'Admission record' };
    function validate(body) {
        if (!exact(body, ['status', 'rows', 'observedAt', 'nextCursor', 'continuation']) || !['available', 'unavailable'].includes(body.status) ||
            !Array.isArray(body.rows) || body.rows.length > 25 || body.observedAt !== null && !instant(body.observedAt) ||
            body.nextCursor !== null && (typeof body.nextCursor !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.nextCursor)) ||
            !['more', 'end', 'limit_reached', 'unavailable'].includes(body.continuation)) throw new Error();
        if (body.status === 'unavailable' ? body.rows.length || body.nextCursor !== null || body.continuation !== 'unavailable' :
            body.observedAt === null || body.continuation === 'unavailable' || (body.continuation === 'more') !== (body.nextCursor !== null) ||
            body.nextCursor !== null && !body.rows.length) throw new Error();
        for (const row of body.rows) {
            if (!exact(row, ['email', 'organisation', 'accountType', 'milestones']) ||
                [row.email, row.organisation].some(value => value !== null && (typeof value !== 'string' || !value || value.length > 320 || /[\u0000-\u001f\u007f]/.test(value))) ||
                row.accountType !== null && !['company', 'consultant'].includes(row.accountType) || !exact(row.milestones, Object.keys(labels))) throw new Error();
            for (const key of Object.keys(labels)) {
                const item = row.milestones[key];
                if (!exact(item, ['status', 'at']) || !(key === 'admission' ? ['awaiting_admission', 'revoked', 'unknown', 'unavailable'] :
                    ['recorded', 'unknown', 'unavailable']).includes(item.status) ||
                    (item.status === 'recorded' ? !instant(item.at) || item.at > body.observedAt : item.at !== null)) throw new Error();
            }
        }
    }
    function render(body) {
        validate(body);
        if (body.status === 'unavailable') { status.textContent = 'Signup records are unavailable. This is not an empty population.'; return; }
        const heading = node('h3', body.rows.length ? 'Recorded signup milestones' : 'No signup records in this approved page');
        heading.id = 'signupQueueResultHeading'; heading.setAttribute('tabindex', '-1'); result.append(heading);
        result.append(node('p', 'Observed at ' + body.observedAt));
        for (const row of body.rows) {
            const entry = node('article'), title = node('h3', row.email || 'Email unknown'), details = node('dl');
            entry.append(title);
            const line = (name, value) => { details.append(node('dt', name), node('dd', value)); };
            line('Organisation', row.organisation || 'Unknown'); line('Account type', row.accountType === 'company' ? 'Company' : row.accountType === 'consultant' ? 'Consultant' : 'Unknown');
            for (const key of Object.keys(labels)) {
                const item = row.milestones[key];
                line(labels[key], item.status === 'recorded' ? item.at : item.status === 'awaiting_admission' ? 'Awaiting admission — recorded registration' :
                    item.status === 'revoked' ? 'Revoked — registration; timestamp unknown' : item.status === 'unavailable' ? 'Unavailable' : 'Unknown');
            }
            entry.append(details); result.append(entry);
        }
        result.append(node('p', 'Activation is a recorded milestone. Current dashboard access is not established by this queue.'));
        result.hidden = false; cursor = body.nextCursor; next.disabled = cursor === null;
        status.textContent = body.continuation === 'limit_reached' ? 'Approved viewing limit reached. More records may exist; no further page is available.' :
            body.continuation === 'more' ? 'Page loaded. A next page is available.' : 'Page loaded. End of the approved population snapshot.';
        heading.focus();
    }
    async function page(selectedCursor = null) {
        if (!allowed) return;
        const request = begin(); load.disabled = true; check.disabled = true; cancel.hidden = false; result.setAttribute('aria-busy', 'true');
        status.textContent = 'Loading recorded signup milestones…';
        try {
            const body = await read(request, { cursor: selectedCursor });
            if (request.sequence !== sequence || request.controller.signal.aborted || body === null) return;
            render(body);
        } catch (_) { if (request.sequence === sequence) { clear(); status.textContent = 'Signup records could not be loaded. No signup outcome has been inferred. Load again to start a fresh page.'; } }
        finally { finish(request); }
    }
    load.addEventListener('click', () => page()); next.addEventListener('click', () => { if (cursor !== null) page(cursor); });
    cancel.addEventListener('click', () => { stop(); clear(); check.disabled = false; status.textContent = 'Signup loading cancelled. No records are displayed.'; load.focus(); });
    check.addEventListener('click', access);
    window.addEventListener('dashboard-admin-revoked', event => revoke(event?.detail, false));
    window.addEventListener('pagehide', () => { allowed = false; stop(); clear(); status.textContent = 'Check signup access to continue.'; });
    window.addEventListener('pageshow', event => { if (event?.persisted) access(); });
    access();
}());
