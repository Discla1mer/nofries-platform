(function () {
    'use strict';
    const panel = document.getElementById('accountMembershipPanel'), form = document.getElementById('accountMembershipForm');
    if (!panel || !form || document.body.dataset.page !== 'operator') return;
    const email = document.getElementById('accountMembershipEmail'), confirmation = document.getElementById('accountMembershipConfirmation');
    const action = document.getElementById('accountMembershipAction'), refresh = document.getElementById('accountMembershipRefresh');
    const approve = document.getElementById('accountMembershipApprove'), apply = document.getElementById('accountMembershipApply');
    const summary = document.getElementById('accountMembershipSummary'), status = document.getElementById('accountMembershipStatus');
    let selected = null, observed = null, approved = null, busy = false, generation = 0, controller, timer;
    const same = (a, b) => a && b && ['provider', 'subjectKey', 'tenantId', 'organisationId'].every(key => a[key] === b[key]);
    function clearApproval() { approved = null; window.clearTimeout(timer); apply.disabled = true; }
    function controls() {
        Array.from(form.elements).forEach(field => { field.disabled = busy || !selected; });
        refresh.disabled = busy || !selected; approve.disabled = busy || !observed; apply.disabled = busy || !approved;
    }
    function reset() {
        generation++; controller?.abort(); busy = false; observed = null; clearApproval(); form.reset();
        selected = window.nofriesAccountSelection || null; email.value = selected?.email || '';
        summary.textContent = ''; status.textContent = selected ? 'Check the current membership before approving a change.' : 'Select an account from lookup first.';
        controls();
    }
    async function request(path, body, signal) {
        const response = await fetch('/api/' + path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin',
            cache: 'no-store', redirect: 'error', signal,
            headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
                ...(path === 'dashboard/session' ? { 'X-Nofries-Dashboard-Purpose': 'operator_dashboard' } : {}) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        if (response.redirected || !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') || '')) throw new Error();
        return { status: response.status, value: await response.json() };
    }
    async function ready(signal) {
        let result = await request('dashboard/session', undefined, signal);
        if (result.status === 409 && result.value.code === 'dashboard_initialization_required') {
            result = await request('dashboard/session', { operationId: window.crypto.randomUUID() }, signal);
            if (result.status !== 200 || result.value.initialized !== true) throw new Error();
            result = await request('dashboard/session', undefined, signal);
        }
        if (result.status !== 200 || result.value.authenticated !== true || result.value.purpose !== 'operator_dashboard') throw new Error();
    }
    async function run(mode) {
        if (busy || !selected || mode !== 'read' && !form.reportValidity()) return;
        if (mode === 'approve' && !observed || mode === 'apply' && (!approved || Date.parse(approved.approvalExpiresAt) <= Date.now())) { clearApproval(); controls(); return; }
        const prior = approved, seen = observed, target = selected, cycle = ++generation;
        clearApproval(); busy = true; controller = new AbortController(); const active = controller;
        const deadline = window.setTimeout(() => active.abort(), 20000); controls(); status.textContent = 'Checking membership…';
        try {
            let result;
            if (mode === 'read') {
                observed = null; summary.textContent = ''; await ready(active.signal); if (cycle !== generation) return;
                result = await request('dashboard-admin/membership', { selector: target.selector }, active.signal);
            } else {
                const input = { selector: target.selector, confirmationEmail: confirmation.value,
                    expectedMembershipRevision: seen.revision, ...(mode === 'apply' ? { operationId: prior.operationId } : {}) };
                result = await request('dashboard-admin/' + (mode === 'apply' ? prior.action : 'approve-' + seen.action), input, active.signal);
            }
            if (cycle !== generation) return;
            if (result.status !== 200) throw Object.assign(new Error(), { status: result.status });
            const value = result.value;
            if (mode === 'read') {
                if (!same(value.selector, target.selector) || !Number.isSafeInteger(value.expectedMembershipRevision) ||
                    value.expectedMembershipRevision < 0 || !['active', 'suspended'].includes(value.membershipStatus)) throw new Error();
                const member = { status: value.membershipStatus };
                observed = { revision: value.expectedMembershipRevision, action: member.status === 'active' ? 'suspend' : 'restore' };
                action.value = observed.action; summary.textContent = 'Membership: ' + member.status + '. Revision: ' + observed.revision + '.';
                status.textContent = 'Type the account email, then approve ' + observed.action + '.';
            } else if (mode === 'approve') {
                if (!same(value.selector, target.selector) || value.action !== seen.action || value.expectedMembershipRevision !== seen.revision ||
                    typeof value.operationId !== 'string' || !(Date.parse(value.approvalExpiresAt) > Date.now())) throw new Error();
                approved = value; apply.textContent = seen.action === 'suspend' ? 'Suspend membership' : 'Restore membership';
                status.textContent = 'Approved. Choose ' + apply.textContent + ' to apply it. Operation ID: ' + value.operationId;
                timer = window.setTimeout(() => { clearApproval(); status.textContent = 'Approval expired. Check membership again.'; }, Date.parse(value.approvalExpiresAt) - Date.now());
            } else {
                if (value.outcome !== 'succeeded' || value.operationId !== prior.operationId) throw new Error();
                observed = null; summary.textContent = ''; status.textContent = 'Membership ' + (prior.action === 'suspend' ? 'suspended' : 'restored') + '. Operation ID: ' + prior.operationId;
            }
        } catch (error) {
            if (cycle === generation) {
                observed = null; summary.textContent = '';
                status.textContent = [400, 403, 409].includes(error.status) ? 'Request refused. Check the current membership and email before approving again.'
                    : 'The outcome could not be confirmed. Check the account and audit before trying again.';
                if (prior) status.textContent += ' Operation ID: ' + prior.operationId;
            }
        } finally { window.clearTimeout(deadline); if (cycle === generation) { busy = false; controls(); } }
    }
    window.addEventListener('nofries-account-selection', reset);
    form.addEventListener('submit', event => { event.preventDefault(); run('approve'); });
    form.addEventListener('input', () => { clearApproval(); controls(); });
    refresh.addEventListener('click', () => run('read')); apply.addEventListener('click', () => run('apply'));
    window.addEventListener('pagehide', () => { window.nofriesAccountSelection = null; reset(); panel.hidden = true; });
    window.addEventListener('pageshow', async event => {
        if (!event.persisted) return;
        window.nofriesAccountSelection = null; reset(); panel.hidden = true;
        const cycle = generation, active = new AbortController(); controller = active;
        const deadline = window.setTimeout(() => active.abort(), 10000);
        try { const result = await request('dashboard-admin/entry-capabilities', undefined, active.signal);
            if (cycle === generation) panel.hidden = result.status !== 200 || result.value.entry !== true || result.value.accountActions !== true;
        } catch (_) { if (cycle === generation) panel.hidden = true; } finally { window.clearTimeout(deadline); }
    });
    reset(); panel.hidden = false;
}());
