(function () {
    'use strict';
    const panel = document.getElementById('frameworkAccessPanel'), form = document.getElementById('frameworkAccessForm');
    if (!panel || !form || document.body.dataset.page !== 'operator') return;
    const apply = document.getElementById('frameworkAccessApply'), target = document.getElementById('frameworkAccessTarget');
    const status = document.getElementById('frameworkAccessStatus');
    const profiles = { nist: ['nf-nist-csf-2-0-core', '2026-09-08.1'], iso: ['nf-iso-27001-2022-readiness', '2026-11-19.1'] };
    let selection, approval, controller, expiry, generation = 0;
    function clear() { approval = null; apply.disabled = true; clearTimeout(expiry); }
    function select() {
        generation++; controller?.abort(); controller = null; clear(); form.reset(); status.textContent = '';
        const row = window.nofriesAccountSelection;
        selection = row?.selector && Number.isSafeInteger(row.membershipRevision) && row.memberships?.some(m => m.status === 'active') ? row : null;
        form.hidden = !selection;
        target.textContent = selection ? 'Organisation: ' + (selection.organisation || selection.selector.organisationId) +
            ' (' + selection.selector.organisationId + '). Account: ' + selection.email : 'Choose Show dashboard access for the intended organisation.';
    }
    function enable(enabled) {
        for (const field of form.elements) field.disabled = !enabled;
        apply.disabled = !enabled || !approval;
    }
    async function run(execute) {
        if (controller || !selection || !form.reportValidity()) return;
        const prior = approval, cycle = generation, [profileId, version] = profiles[form.elements.profile.value];
        if (execute && (!prior || Date.parse(prior.approvalExpiresAt) <= Date.now())) { clear(); return; }
        const tuple = { moduleId: 'cyber_security', profileId, version };
        const input = { selector: selection.selector, expectedMembershipRevision: selection.membershipRevision,
            tuple, action: form.elements.action.value, confirmationEmail: form.elements.email.value,
            reason: form.elements.reason.value.trim(), step: execute ? 'apply' : 'approve', ...(execute ? { operationId: prior.operationId } : {}) };
        clear(); enable(false);
        const active = new AbortController(); controller = active;
        const timeout = setTimeout(() => active.abort(), 20000);
        try {
            status.textContent = execute ? 'Applying change…' : 'Recording approval…';
            const response = await fetch('/api/dashboard-admin/lookup', { method: 'POST', credentials: 'same-origin',
                cache: 'no-store', redirect: 'error', signal: active.signal, headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify({ frameworkAccess: input }) });
            const result = await response.json();
            if (generation !== cycle) return;
            if (!response.ok) throw new Error([400, 403, 409].includes(response.status) ? 'refused' : 'unconfirmed');
            if (execute) {
                if (result.outcome !== 'succeeded' || result.operationId !== prior.operationId) throw new Error();
                status.textContent = 'Recorded ' + input.action + ' for ' + profileId + ' ' + version + ' in the selected organisation.';
            } else {
                if (!result.operationId || result.action !== input.action || result.tuple?.profileId !== profileId ||
                    result.tuple?.version !== version || !(Date.parse(result.approvalExpiresAt) > Date.now())) throw new Error();
                approval = result; expiry = setTimeout(clear, Date.parse(result.approvalExpiresAt) - Date.now());
                status.textContent = 'Approval recorded. Choose Apply approved change within 15 minutes.';
            }
        } catch (error) {
            if (generation === cycle) status.textContent = error.message === 'refused' ? 'Request refused. Check the organisation, email and current access.'
                : 'Outcome unconfirmed. Check the staff record before retrying.';
        } finally {
            clearTimeout(timeout);
            if (generation === cycle) { controller = null; enable(true); }
        }
    }
    form.addEventListener('input', clear);
    form.addEventListener('submit', event => { event.preventDefault(); run(false); });
    apply.addEventListener('click', () => run(true));
    window.addEventListener('nofries-account-selection', () => { select(); enable(true); });
    window.addEventListener('pagehide', () => { window.nofriesAccountSelection = null; select(); panel.hidden = true; });
    window.addEventListener('pageshow', event => { if (event.persisted) window.location.reload(); });
    select(); panel.hidden = false;
}());
