(function () {
    'use strict';
    const panel = document.getElementById('accountActionsPanel'), form = document.getElementById('accountActionsForm');
    if (!panel || !form || document.body.dataset.page !== 'operator') return;
    const email = document.getElementById('accountActionsEmail'), confirmation = document.getElementById('accountActionsConfirmation');
    const expiry = document.getElementById('accountActionsExpiry'), extend = document.getElementById('accountActionsExtend');
    const status = document.getElementById('accountActionsStatus');
    let selected = null, approved = null, busy = false, generation = 0, timer, controller;
    function clear() { approved = null; extend.disabled = true; window.clearTimeout(timer); }
    async function request(url, body, signal) {
        const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin',
            cache: 'no-store', redirect: 'error', signal: signal,
            headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
                ...(url === '/api/dashboard/session' ? { 'X-Nofries-Dashboard-Purpose': 'operator_dashboard' } : {}) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        if (response.redirected || !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') || '')) throw new Error();
        const value = await response.json();
        return { status: response.status, value: value };
    }
    async function ready(signal) {
        let result = await request('/api/dashboard/session', undefined, signal);
        if (result.status === 409 && result.value.code === 'dashboard_initialization_required') {
            result = await request('/api/dashboard/session', { operationId: window.crypto.randomUUID() }, signal);
            if (result.status !== 200 || result.value.initialized !== true) throw new Error();
            result = await request('/api/dashboard/session', undefined, signal);
        }
        if (result.status !== 200 || result.value.authenticated !== true || result.value.purpose !== 'operator_dashboard') throw new Error();
    }
    async function run(execute) {
        if (busy || !selected || !form.reportValidity()) return;
        const prior = approved, target = selected, cycle = ++generation;
        if (execute && (!prior || Date.parse(prior.approvalExpiresAt) <= Date.now())) { clear(); return; }
        clear(); busy = true; controller = new AbortController();
        const active = controller, deadline = window.setTimeout(function () { active.abort(); }, 20000);
        Array.from(form.elements).forEach(function (field) { field.disabled = true; });
        status.textContent = execute ? 'Extending access…' : 'Approving extension…';
        try {
            if (!execute) await ready(active.signal);
            if (cycle !== generation) return;
            const input = execute ? { selector: prior.selector, operationId: prior.operationId, newExpiresAt: prior.newExpiresAt,
                confirmationEmail: confirmation.value } : { selector: target.selector, confirmationEmail: confirmation.value,
                newExpiresAt: new Date(expiry.value).toISOString() };
            const result = await request('/api/dashboard-admin/' + (execute ? 'extend-expired-access' : 'approve-extension'), input, active.signal);
            if (cycle !== generation) return;
            if (result.status !== 200) throw Object.assign(new Error(), { status: result.status });
            if (execute) {
                if (result.value.outcome !== 'succeeded' || result.value.operationId !== prior.operationId) throw new Error();
                status.textContent = 'Access expiry extended to ' + new Date(prior.newExpiresAt).toLocaleString() + '.';
            } else {
                if (!result.value.selector || !result.value.operationId || result.value.newExpiresAt !== input.newExpiresAt ||
                    !(Date.parse(result.value.approvalExpiresAt) > Date.now())) throw new Error();
                approved = result.value;
                status.textContent = 'Approved for ' + target.email + ' until ' + new Date(input.newExpiresAt).toLocaleString() + '. Choose Extend access to apply it.';
                timer = window.setTimeout(function () { clear(); status.textContent = 'Approval expired. Approve the extension again.'; }, Date.parse(approved.approvalExpiresAt) - Date.now());
            }
        } catch (error) {
            if (cycle === generation) status.textContent = [400, 403, 409].includes(error.status)
                ? 'Request refused. Check the email, expiry and current account status before approving again.'
                : 'The outcome could not be confirmed. Check the account and audit before trying again.';
        } finally {
            window.clearTimeout(deadline);
            if (cycle === generation) { busy = false; Array.from(form.elements).forEach(function (field) { field.disabled = false; }); extend.disabled = !approved; }
        }
    }
    function selection() {
        generation++; controller?.abort(); clear(); busy = false; form.reset();
        selected = window.nofriesAccountSelection || null; email.value = selected?.email || '';
        Array.from(form.elements).forEach(function (field) { field.disabled = false; }); extend.disabled = true;
        status.textContent = selected ? 'Selected ' + selected.organisation + '. Type the account email to approve.' : 'Select an account from lookup first.';
    }
    window.addEventListener('nofries-account-selection', selection); selection();
    form.addEventListener('submit', function (event) { event.preventDefault(); run(false); });
    form.addEventListener('input', function () { clear(); status.textContent = ''; });
    extend.addEventListener('click', function () { run(true); });
    window.addEventListener('pagehide', function () { window.nofriesAccountSelection = null; selection(); panel.hidden = true; status.textContent = ''; });
    window.addEventListener('pageshow', async function (event) {
        if (!event.persisted) return;
        window.nofriesAccountSelection = null; selection();
        const cycle = ++generation, active = new AbortController(); controller = active; clear(); busy = true; panel.hidden = true;
        const deadline = window.setTimeout(function () { active.abort(); }, 10000);
        try {
            const result = await request('/api/dashboard-admin/entry-capabilities', undefined, active.signal);
            if (cycle === generation) panel.hidden = result.status !== 200 || result.value.entry !== true || result.value.accountActions !== true;
        } catch (_) { if (cycle === generation) panel.hidden = true; }
        finally {
            window.clearTimeout(deadline);
            if (cycle === generation) { busy = false; Array.from(form.elements).forEach(function (field) { field.disabled = false; }); extend.disabled = true; }
        }
    });
    panel.hidden = false;
}());
