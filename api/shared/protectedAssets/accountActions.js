(function () {
    'use strict';
    // Suspend or restore one customer's dashboard membership. Every write is an
    // explicit two-step: a typed-email approval bound to this staff session and
    // one operation (15 minutes), then the action itself. Nothing is deleted.
    const panel = document.getElementById('accountActionsPanel'), form = document.getElementById('accountActionsForm');
    if (!panel || !form || document.body.dataset.page !== 'operator') return;
    const email = document.getElementById('accountActionsEmail'), confirmation = document.getElementById('accountActionsConfirmation');
    const approve = document.getElementById('accountActionsApprove'), apply = document.getElementById('accountActionsApply');
    const status = document.getElementById('accountActionsStatus'), summary = document.getElementById('accountActionsSummary');
    const LABEL = { suspend: 'Suspend dashboard access', restore: 'Restore dashboard access' };
    let selected = null, action = null, approved = null, busy = false, generation = 0, timer, controller;
    function fields(disabled) { Array.from(form.elements).forEach(function (field) { field.disabled = disabled; }); }
    function clear() { approved = null; apply.disabled = true; window.clearTimeout(timer); }
    async function request(url, body, signal) {
        const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin',
            cache: 'no-store', redirect: 'error', signal: signal,
            headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
                ...(url === '/api/dashboard/session' ? { 'X-Nofries-Dashboard-Purpose': 'operator_dashboard' } : {}) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        if (response.redirected || !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') || '')) throw new Error();
        return { status: response.status, value: await response.json() };
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
    // Which action applies follows the membership the operator has just read:
    // an active membership can be suspended, a suspended one restored.
    function decide(row) {
        if (!row || !row.selector || !Array.isArray(row.memberships) || !Number.isSafeInteger(row.membershipRevision)) return null;
        const live = row.memberships.filter(function (member) { return ['active', 'suspended'].includes(member.status); });
        if (live.length !== 1) return null;
        return live[0].status === 'active' ? 'suspend' : 'restore';
    }
    async function run(execute) {
        if (busy || !selected || !action || !form.reportValidity()) return;
        const prior = approved, target = selected, chosen = action, cycle = ++generation;
        if (execute && (!prior || Date.parse(prior.approvalExpiresAt) <= Date.now())) { clear(); return; }
        clear(); busy = true; controller = new AbortController();
        const active = controller, deadline = window.setTimeout(function () { active.abort(); }, 20000);
        fields(true);
        status.textContent = execute ? 'Applying ' + chosen + '…' : 'Recording approval…';
        try {
            if (!execute) await ready(active.signal);
            if (cycle !== generation) return;
            const input = { selector: target.selector, confirmationEmail: confirmation.value, expectedMembershipRevision: target.membershipRevision,
                ...(execute ? { operationId: prior.operationId } : {}) };
            const result = await request('/api/dashboard-admin/' + (execute ? chosen : 'approve-' + chosen), input, active.signal);
            if (cycle !== generation) return;
            if (result.status !== 200) throw Object.assign(new Error(), { status: result.status });
            if (execute) {
                if (result.value.outcome !== 'succeeded' || result.value.operationId !== prior.operationId) throw new Error();
                status.textContent = LABEL[chosen] + ' succeeded for ' + target.email + '. Choose Show dashboard access again to read the new state.';
                target.memberships = null; action = null; approve.disabled = true;
            } else {
                if (!result.value.operationId || result.value.action !== chosen || result.value.expectedMembershipRevision !== target.membershipRevision ||
                    !(Date.parse(result.value.approvalExpiresAt) > Date.now())) throw new Error();
                approved = result.value;
                status.textContent = 'Approved: ' + LABEL[chosen].toLowerCase() + ' for ' + target.email + '. Choose Apply to carry it out within 15 minutes.';
                timer = window.setTimeout(function () { clear(); status.textContent = 'Approval expired. Approve again.'; }, Date.parse(approved.approvalExpiresAt) - Date.now());
            }
        } catch (error) {
            if (cycle === generation) status.textContent = [400, 403, 409].includes(error.status)
                ? 'Request refused. Check the typed email and re-read dashboard access; the membership may have changed.'
                : 'The outcome could not be confirmed. Re-read dashboard access and check the audit before trying again.';
        } finally {
            window.clearTimeout(deadline);
            if (cycle === generation) { busy = false; fields(false); approve.disabled = !action; apply.disabled = !approved; }
        }
    }
    function selection() {
        generation++; controller?.abort(); clear(); busy = false; form.reset();
        selected = window.nofriesAccountSelection || null; action = decide(selected);
        email.value = selected?.email || ''; fields(false); apply.disabled = true; approve.disabled = !action;
        approve.textContent = action ? 'Approve ' + action : 'Approve';
        summary.textContent = !selected ? 'Select an account from lookup first.'
            : !selected.selector ? 'This record has no dashboard membership to act on.'
                : !Array.isArray(selected.memberships) ? 'Choose Show dashboard access for the selected row first.'
                    : action ? 'Selected ' + (selected.organisation || 'account') + ': membership is ' + (action === 'suspend' ? 'active' : 'suspended') +
                        ' at revision ' + selected.membershipRevision + '. Type the account email to approve ' + action + '.'
                        : 'No single active or suspended membership to act on.';
        status.textContent = '';
    }
    window.addEventListener('nofries-account-selection', selection); selection();
    form.addEventListener('submit', function (event) { event.preventDefault(); run(false); });
    form.addEventListener('input', function () { clear(); status.textContent = ''; });
    apply.addEventListener('click', function () { run(true); });
    window.addEventListener('pagehide', function () { window.nofriesAccountSelection = null; selection(); panel.hidden = true; });
    window.addEventListener('pageshow', async function (event) {
        if (!event.persisted) return;
        window.nofriesAccountSelection = null; selection();
        const cycle = ++generation, active = new AbortController(); controller = active; busy = true; panel.hidden = true;
        const deadline = window.setTimeout(function () { active.abort(); }, 10000);
        try {
            const result = await request('/api/dashboard-admin/entry-capabilities', undefined, active.signal);
            if (cycle === generation) panel.hidden = result.status !== 200 || result.value.entry !== true || result.value.accountActions !== true;
        } catch (_) { if (cycle === generation) panel.hidden = true; }
        finally {
            window.clearTimeout(deadline);
            if (cycle === generation) { busy = false; fields(false); apply.disabled = true; approve.disabled = !action; }
        }
    });
    panel.hidden = false;
}());
