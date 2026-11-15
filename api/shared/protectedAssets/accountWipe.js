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
    // Reset or delete by email, for accounts lookup cannot offer for selection
    // (a delete that stopped after storage leaves no rows; a row past the scan
    // cap has no selector). The server resolves the account by email itself,
    // and for a partial delete acts only on the reference it kept.
    const resumeEmail = $('ResumeEmail'), resume = $('Resume');
    const WORDS = { reset: 'RESET', delete: 'DELETE' };
    const STAGES = { database: 'Database', storage: 'Stored records', identity: 'Sign-in user' };
    const STATES = { done: 'removed', absent: 'already gone', failed: 'failed', pending: 'not started', unknown: 'result not known', not_applicable: 'not an External ID account (not removed)' };
    const MESSAGES = {
        account_wipe_subject_mismatch: 'The database still holds this account under a different sign-in identity. Nothing was changed; this needs investigating before a delete.',
        account_wipe_identity_unavailable: 'The app could not get access to External ID, so delete was refused before anything was changed. Reset still works.',
        account_wipe_target_changed: 'The account for this email changed after approval (for example it signed up again). Nothing was changed; look it up and approve again.',
        account_wipe_timed_out: 'This took too long and was stopped. Look the account up before retrying.',
        account_wipe_identity_pending: 'The sign-in user was deleted but is not yet ready to be removed permanently.',
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
    const LOOKUP = '/api/dashboard-admin/accounts/lookup';
    const explain = code => code === 'dashboard_admin_account_lookup_429' ? 'Too many requests just now. Wait a minute and try again.' : MESSAGES[code] || 'The service is unavailable. Look the account up again before retrying.';
    let selected = null, action = null, approved = null, busy = false, generation = 0, timer, controller, enabled = false;

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
        resume.disabled = resumeEmail.disabled = busy;
        resetButton.setAttribute('aria-pressed', String(action === 'reset')); deleteButton.setAttribute('aria-pressed', String(action === 'delete'));
        typed.disabled = word.disabled = !idle || !action; approve.disabled = !idle || !action; apply.disabled = busy || !approved;
        approve.textContent = action ? 'Approve ' + action : 'Approve';
        hint.textContent = action ? WORDS[action] : 'RESET or DELETE';
    }
    function choose(next) {
        if (busy || !selected) return;
        generation++; clear(); action = next; typed.value = ''; word.value = ''; status.textContent = '';
        summary.textContent = selected.byEmail && next === 'delete'
            ? 'Delete ' + selected.email + ': removes the account, its email and all its data, then its External ID sign-in user. This cannot be undone. If an earlier delete stopped partway, steps already done are skipped and the server uses only what it kept from that attempt.'
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
        if (result.outcome === 'unknown') return 'The database change for ' + email + ' may or may not have been applied (its confirmation was lost). Look the account up before retrying.' + unrecorded;
        if (result.outcome === 'timed_out_rolled_back') return 'This took too long, so the database change was rolled back and nothing was changed. Approve and apply again.' + unrecorded;
        return 'Refused: ' + explain(result.code) + unrecorded;
    }
    // One-click path for the signup list. The operator has already confirmed a
    // dialog naming the action and the email, so the client supplies the same
    // confirmation the server checks, then uses the single-use approval at once.
    // The server still binds the approval to this staff session and this target.
    async function perform(chosen, email) {
        if (!enabled || !WORDS[chosen] || typeof email !== 'string' || !email) return { done: false, text: 'Reset and delete are unavailable.' };
        const active = new AbortController(), deadline = window.setTimeout(function () { active.abort(); }, 90000);
        try {
            await ready(active.signal);
            const approval = await request(LOOKUP, { wipe: { step: 'approve', action: chosen, email, confirmEmail: email, confirmWord: WORDS[chosen] } }, active.signal);
            if (approval.status !== 200) return { done: false, text: explain(approval.value && approval.value.code) };
            if (approval.value.action !== chosen || typeof approval.value.approvalId !== 'string') throw new Error();
            const result = await request(LOOKUP, { wipe: { step: 'execute', approvalId: approval.value.approvalId, email } }, active.signal);
            if (result.status !== 200) return { done: false, text: explain(result.value && result.value.code) };
            const value = result.value;
            if (value.outcome === 'partial') return { done: false, outcome: value.outcome, text: 'Delete only partly done. ' +
                Object.keys(value.stages).map(key => STAGES[key] + ': ' + (STATES[value.stages[key]] || value.stages[key])).join('; ') + '. ' + explain(value.code) +
                ' Choose Delete again to finish; finished steps are skipped.' };
            return { done: value.outcome === 'succeeded', outcome: value.outcome, text: outcomeText(value, email) };
        } catch (_) {
            return { done: false, text: 'The outcome could not be confirmed. Refresh the list; if the account is still there, try again.' };
        } finally { window.clearTimeout(deadline); }
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
            const result = await request(LOOKUP, body, active.signal);
            if (cycle !== generation) return;
            if (result.status !== 200) { status.textContent = explain(result.value && result.value.code); return; }
            if (execute) {
                status.textContent = outcomeText(result.value, target.email);
                if (!['partial', 'timed_out_rolled_back', 'unknown'].includes(result.value.outcome)) { action = null; typed.value = ''; word.value = ''; }
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
        if (value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) { status.textContent = 'Enter the account email to reset or delete.'; return; }
        generation++; controller?.abort(); clear(); busy = false; action = null; typed.value = ''; word.value = '';
        selected = { email: value, byEmail: true };
        summary.textContent = 'Selected ' + value + ' by email. Choose Reset or Delete.'; status.textContent = ''; controls();
    });
    resetButton.addEventListener('click', function () { choose('reset'); });
    deleteButton.addEventListener('click', function () { choose('delete'); });
    form.addEventListener('submit', function (event) { event.preventDefault(); run(false); });
    form.addEventListener('input', function () { if (!busy && approved) { clear(); status.textContent = ''; controls(); } });
    apply.addEventListener('click', function () { run(true); });
    window.addEventListener('nofries-account-selection', selection);
    window.addEventListener('pagehide', function () { window.nofriesAccountSelection = null; resumeEmail.value = ''; selection(); available(false); });
    window.addEventListener('pageshow', async function (event) {
        if (!event || !event.persisted) return;
        selection(); available(false);
        const cycle = generation, active = new AbortController(), deadline = window.setTimeout(function () { active.abort(); }, 10000);
        try {
            const result = await request('/api/dashboard-admin/entry-capabilities', undefined, active.signal);
            if (cycle === generation) available(result.status === 200 && result.value.accountWipe === true);
        } catch (_) { if (cycle === generation) available(false); }
        finally { window.clearTimeout(deadline); }
    });
    // The signup list shows per-row Reset and Delete only while this is on.
    function available(on) {
        enabled = on; panel.hidden = !on;
        if (typeof window.CustomEvent === 'function') window.dispatchEvent(new window.CustomEvent('nofries-account-wipe', { detail: { available: on } }));
    }
    window.nofriesAccountWipe = Object.freeze({ perform, available: () => enabled });
    selection();
    available(true);
}());
