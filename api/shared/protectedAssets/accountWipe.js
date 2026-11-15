(function () {
    'use strict';
    // Reset or delete one customer account. Two explicit steps: approve by typing
    // the account email and RESET or DELETE (held on the server for 15 minutes,
    // bound to this staff session, single use), then apply. Loaded only when
    // NOFRIES_DASHBOARD_ADMIN_ACCOUNT_WIPE is on.
    const panel = document.getElementById('accountWipePanel'), form = document.getElementById('accountWipeForm');
    if (!panel || !form || document.body.dataset.page !== 'operator') return;
    const $ = id => document.getElementById('accountWipe' + id);
    const resetButton = $('Reset'), deleteButton = $('Delete'), typed = $('Email'), word = $('Word'), hint = $('WordHint');
    const approve = $('Approve'), apply = $('Apply'), status = $('Status'), summary = $('Summary');
    // A delete that stopped after storage leaves no lookup rows to select, so it
    // can be finished by email. The server acts only on the reference it kept.
    const resumeEmail = $('ResumeEmail'), resume = $('Resume');
    const WORDS = { reset: 'RESET', delete: 'DELETE' };
    const STAGES = { database: 'Database', storage: 'Stored records', identity: 'Sign-in user' };
    const STATES = { done: 'removed', absent: 'already gone', failed: 'failed', pending: 'not started', not_applicable: 'not an External ID account (not removed)' };
    const MESSAGES = {
        account_wipe_confirmation_mismatch: 'Type the account email exactly, and the action word in capitals.',
        account_wipe_approval_invalid: 'The approval has expired, was already used or belongs to another session. Approve again.',
        account_wipe_account_not_found: 'No account was found for this email.',
        account_wipe_account_ambiguous: 'This email is in both customer stores. Nothing was changed.',
        account_wipe_subject_unknown: 'This account has no recorded sign-in identity, so it cannot be reset or deleted here.',
        account_wipe_legacy_index_configured: 'Delete is off while the legacy signup listing is configured. Reset still works.',
        account_wipe_identity_not_configured: 'Delete needs the External ID (Graph) settings, which are not set. Nothing was changed.',
        account_wipe_role_unavailable: 'The database wipe role is not granted to the app. Nothing was changed.',
        account_wipe_reference_blocked: 'A session the wipe cannot see still uses this account (a staff dashboard session, or another person in a client organisation). End it and try again. Nothing was changed.',
        account_wipe_tenant_mismatch: 'One of this account\'s organisations is not linked to it in the database (for example a client that was never set up). Nothing was changed.',
        account_wipe_busy: 'The account is busy. Try again in a moment.',
        account_wipe_storage_incomplete: 'Some stored record versions could not be removed.',
        account_wipe_identity_forbidden: 'The app is not allowed to remove the sign-in user.',
        account_wipe_identity_reference_lost: 'The sign-in user\'s reference is no longer held. Remove the user by hand in the Entra admin centre.',
        account_wipe_audit_unavailable: 'The audit record could not be written, so nothing was changed.'
    };
    const explain = code => MESSAGES[code] || 'The service is unavailable. Look the account up again before retrying.';
    let selected = null, action = null, approved = null, busy = false, generation = 0, timer, controller;

    async function request(url, body, signal) {
        const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal,
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
    function clear() { approved = null; apply.disabled = true; window.clearTimeout(timer); }
    function controls() {
        const idle = !busy && Boolean(selected);
        resetButton.disabled = deleteButton.disabled = !idle;
        if (selected && selected.resume) resetButton.disabled = true;
        resume.disabled = resumeEmail.disabled = busy;
        resetButton.setAttribute('aria-pressed', String(action === 'reset')); deleteButton.setAttribute('aria-pressed', String(action === 'delete'));
        typed.disabled = word.disabled = !idle || !action; approve.disabled = !idle || !action; apply.disabled = busy || !approved;
        approve.textContent = action ? 'Approve ' + action : 'Approve';
        hint.textContent = action ? WORDS[action] : 'RESET or DELETE';
    }
    function choose(next) {
        if (busy || !selected) return;
        generation++; clear(); action = next; typed.value = ''; word.value = ''; status.textContent = '';
        summary.textContent = selected.resume
            ? 'Finish the delete of ' + selected.email + ': steps already done are skipped, and the server uses only what it kept from the earlier attempt.'
            : next === 'reset'
            ? 'Reset ' + selected.email + ': clears assessments, evidence and improvement plans in every organisation of this account. Sign-in, email and organisations are kept.'
            : 'Delete ' + selected.email + ': removes the account, its email and all its data, then its External ID sign-in user. This cannot be undone.';
        controls();
    }
    function outcomeText(result, email) {
        const stages = Object.keys(result.stages).map(key => STAGES[key] + ': ' + (STATES[result.stages[key]] || result.stages[key])).join('; ');
        const unrecorded = result.recorded === false ? ' The outcome record could not be stored; keep a note of this result.' : '';
        if (result.outcome === 'succeeded') return (result.action === 'reset'
            ? 'Reset complete for ' + email + ': ' + result.counts.databaseRows + ' database rows cleared. Sign-in is kept.'
            : 'Delete complete for ' + email + '. ' + stages + '.') + unrecorded;
        if (result.outcome === 'partial') return 'Delete only partly done for ' + email + '. ' + stages + '. ' + explain(result.code) +
            ' Approve and apply Delete again to finish the remaining steps; finished steps are skipped.' + unrecorded;
        return 'Refused: ' + explain(result.code) + unrecorded;
    }
    async function run(execute) {
        if (busy || !selected || !action) return;
        if (!execute && !form.reportValidity()) return;
        const prior = approved, target = selected, chosen = action, cycle = ++generation;
        if (execute && (!prior || Date.parse(prior.approvalExpiresAt) <= Date.now())) { clear(); status.textContent = 'Approval expired. Approve again.'; return; }
        clear(); busy = true; controls(); controller = new AbortController();
        const active = controller, deadline = window.setTimeout(function () { active.abort(); }, execute ? 70000 : 20000);
        status.textContent = execute ? (chosen === 'delete' ? 'Deleting… do not close this page.' : 'Resetting…') : 'Recording approval…';
        try {
            if (!execute) await ready(active.signal);
            if (cycle !== generation) return;
            const body = execute ? { wipe: { step: 'execute', approvalId: prior.approvalId, email: target.email } }
                : { wipe: { step: 'approve', action: chosen, email: target.email, confirmEmail: typed.value, confirmWord: word.value } };
            const result = await request('/api/dashboard-admin/accounts/lookup', body, active.signal);
            if (cycle !== generation) return;
            if (result.status !== 200) { status.textContent = explain(result.value && result.value.code); return; }
            if (execute) {
                status.textContent = outcomeText(result.value, target.email);
                if (result.value.outcome !== 'partial') { action = null; typed.value = ''; word.value = ''; }
            } else {
                if (result.value.action !== chosen || !(Date.parse(result.value.approvalExpiresAt) > Date.now())) throw new Error();
                approved = result.value;
                status.textContent = 'Approved: ' + chosen + ' ' + target.email + '. Choose Apply within 15 minutes to carry it out.';
                timer = window.setTimeout(function () { clear(); status.textContent = 'Approval expired. Approve again.'; }, Date.parse(approved.approvalExpiresAt) - Date.now());
            }
        } catch (_) {
            if (cycle === generation) status.textContent = execute
                ? 'The outcome could not be confirmed. Look the account up again; if it is still there, approve and apply again.'
                : 'The approval could not be recorded. Try again.';
        } finally {
            window.clearTimeout(deadline);
            if (cycle === generation) { busy = false; controls(); }
        }
    }
    function selection() {
        generation++; controller?.abort(); clear(); busy = false; action = null; typed.value = ''; word.value = '';
        selected = window.nofriesAccountSelection && window.nofriesAccountSelection.email ? window.nofriesAccountSelection : null;
        summary.textContent = selected ? 'Selected ' + selected.email + '. Choose Reset or Delete.' : 'Select an account from lookup first.';
        status.textContent = ''; controls();
    }
    resume.addEventListener('click', function () {
        const value = String(resumeEmail.value || '').trim();
        if (busy) return;
        if (value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) { status.textContent = 'Enter the account email whose delete you want to finish.'; return; }
        generation++; controller?.abort(); clear(); selected = { email: value, resume: true }; choose('delete');
    });
    resetButton.addEventListener('click', function () { choose('reset'); });
    deleteButton.addEventListener('click', function () { choose('delete'); });
    form.addEventListener('submit', function (event) { event.preventDefault(); run(false); });
    form.addEventListener('input', function () { if (!busy && approved) { clear(); status.textContent = ''; controls(); } });
    apply.addEventListener('click', function () { run(true); });
    window.addEventListener('nofries-account-selection', selection);
    window.addEventListener('pagehide', function () { window.nofriesAccountSelection = null; resumeEmail.value = ''; selection(); panel.hidden = true; });
    window.addEventListener('pageshow', async function (event) {
        if (!event || !event.persisted) return;
        selection(); panel.hidden = true;
        const cycle = generation, active = new AbortController(), deadline = window.setTimeout(function () { active.abort(); }, 10000);
        try {
            const result = await request('/api/dashboard-admin/entry-capabilities', undefined, active.signal);
            if (cycle === generation) panel.hidden = result.status !== 200 || result.value.accountWipe !== true;
        } catch (_) { if (cycle === generation) panel.hidden = true; }
        finally { window.clearTimeout(deadline); }
    });
    selection();
    panel.hidden = false;
}());
