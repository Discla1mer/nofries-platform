(function () {
    'use strict';
    const byId = suffix => document.getElementById('accountActions' + suffix);
    const selectorForm = byId('SelectorForm'), selectorFields = byId('SelectorFields'), inspect = byId('Inspect');
    const provider = byId('Provider'), subject = byId('Subject'), tenant = byId('Tenant'), organisation = byId('Organisation');
    const check = byId('Check'), cancel = byId('Cancel'), status = byId('Status'), inspectionView = byId('Inspection');
    const prepareForm = byId('PrepareForm'), prepareFields = byId('PrepareFields'), action = byId('Action');
    const confirmationName = byId('ConfirmationName'), confirmationNameLabel = byId('ConfirmationNameLabel');
    const name = byId('Name'), nameLabel = byId('NameLabel'), effect = byId('Effect'), preview = byId('Preview');
    const confirmForm = byId('ConfirmForm'), confirmFields = byId('ConfirmFields'), confirm = byId('Confirm'), execute = byId('Execute');
    const discard = byId('Discard'), outcome = byId('Outcome'), recover = byId('Recover'), resume = byId('Resume'), fresh = byId('Fresh');
    const labels = { reset: 'Reset stuck signup', edit: 'Edit staff-facing account label', delete: 'Remove organisation access', restore: 'Restore organisation access', archive: 'Delete organisation account', unarchive: 'Recover deleted organisation account' };
    const effects = {
        reset: 'Clears only the active account and optional subject-authority pointers of a half-created External ID signup. Existing identities, setup evidence and legal records are retained. Accounts with canonical data or registrations cannot be reset. The person can start a new signup.',
        archive: 'Soft-deletes this organisation account by suspending the organisation for every member. Data and identities are retained. It can be recovered; there is no automatic permanent deletion.',
        unarchive: 'Recovers an organisation soft-deleted by this workflow. Existing member roles and validity dates are preserved.',
        edit: 'Changes only the staff-facing account label for this identity and organisation. The dashboard organisation name, identity, accepted signup details and membership stay unchanged.',
        delete: 'Suspends this identity’s membership in this organisation. Stored data, the global identity and memberships in other organisations are preserved. Permanent account erasure is unavailable here.',
        restore: 'Restores the organisation membership suspended by this removal flow, with its existing roles and validity dates. It does not extend access dates or guarantee current effective access.'
    };
    const SUBJECT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    const digest = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
    const identifier = value => typeof value === 'string' && value.length >= 1 && value.length <= 180 && value === value.trim() && !/[\u0000-\u001f\u007f*]/.test(value);
    const displayName = value => typeof value === 'string' && value.length >= 1 && value.length <= 200 &&
        value === value.trim().normalize('NFC') && !/[\p{Cc}\p{Cf}\u2028\u2029<>]/u.test(value);
    const existingName = value => typeof value === 'string' && value.length >= 1 && value.length <= 320 && !/[\u0000-\u001f\u007f]/.test(value);
    const instant = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
        Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
    function exact(value, keys) { return value && typeof value === 'object' && !Array.isArray(value) &&
        Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)); }
    function validSelector(value) { return exact(value, ['provider', 'subjectKey', 'tenantId', 'organisationId']) &&
        ['legacy', 'external'].includes(value.provider) && SUBJECT.test(value.subjectKey) && identifier(value.tenantId) && identifier(value.organisationId); }
    function sameSelector(left, right) { return validSelector(left) && validSelector(right) && Object.keys(right).every(key => left[key] === right[key]); }
    function validMembership(value) { return exact(value, ['membershipId', 'status', 'validFrom', 'validUntil']) && identifier(value.membershipId) &&
        ['active', 'suspended', 'removed'].includes(value.status) && instant(value.validFrom) && instant(value.validUntil) && value.validFrom < value.validUntil; }
    let allowed = false, sequence = 0, active = null, snapshot = null, prepared = null, ticket = null, expiryTimer = null;
    let attempted = false, terminal = false, lastOutcome = null;
    const expired = () => !ticket || Date.parse(ticket.expiresAt) <= Date.now();
    const unresolved = () => attempted && !terminal;
    const current = request => request.sequence === sequence && !request.controller.signal.aborted;
    function clearView(element) { element.replaceChildren(); element.hidden = true; }
    function controls() {
        const locked = !!active || attempted;
        selectorFields.disabled = !allowed || locked;
        inspect.disabled = !allowed || locked;
        check.disabled = !!active || allowed && unresolved();
        prepareForm.hidden = !snapshot;
        prepareFields.disabled = !allowed || locked || !snapshot || !Object.hasOwn(labels, action.value);
        confirmForm.hidden = !prepared || attempted;
        confirmFields.disabled = !allowed || !!active || attempted;
        confirm.disabled = confirmFields.disabled || expired();
        execute.disabled = confirm.disabled || !confirm.checked;
        cancel.hidden = !active || active.kind === 'capabilities';
        cancel.textContent = active && ['execute', 'outcome'].includes(active.kind) ? 'Stop waiting for this request' : 'Cancel inspection or preview';
        recover.hidden = !allowed || !ticket || !unresolved(); recover.disabled = !!active;
        resume.hidden = !allowed || !ticket || lastOutcome !== 'not_started' || terminal || expired(); resume.disabled = !!active;
        fresh.hidden = !allowed || !terminal; fresh.disabled = !!active;
        selectorForm.setAttribute('aria-busy', String(!!active && active.kind === 'inspect'));
        prepareForm.setAttribute('aria-busy', String(!!active && active.kind === 'prepare'));
        confirmForm.setAttribute('aria-busy', String(!!active && active.kind === 'execute'));
        outcome.setAttribute('aria-busy', String(!!active && active.kind === 'outcome'));
    }
    function stop() {
        sequence += 1;
        if (active) { active.controller.abort(); window.clearTimeout(active.timer); active = null; }
    }
    function clearPreview() {
        window.clearTimeout(expiryTimer); expiryTimer = null;
        prepared = null; ticket = null; confirm.checked = false; clearView(preview);
    }
    function clearAll() {
        clearPreview(); snapshot = null; attempted = false; terminal = false; lastOutcome = null;
        clearView(inspectionView); clearView(outcome); action.replaceChildren(); action.value = ''; name.value = ''; confirmationName.value = '';
    }
    function clearFields() { provider.value = 'legacy'; subject.value = ''; tenant.value = ''; organisation.value = ''; }
    function revoked(code, broadcast = true) {
        // Keep only the opaque recovery ticket in memory while the page remains
        // open. It is actor-bound server-side; all displayed identity data clears.
        const pendingTicket = unresolved() ? ticket : null;
        allowed = false; stop(); clearAll(); clearFields();
        if (pendingTicket) { ticket = pendingTicket; attempted = true; }
        status.textContent = (code === 401 ? 'Your session has ended. Sign in to staff workspace again.' : 'Account action access is unavailable.') +
            (pendingTicket ? ' An action may still have completed. Recheck access to recover this same request’s outcome.' : ' No account action details are displayed.');
        controls();
        if (broadcast) window.dispatchEvent?.(new window.CustomEvent('dashboard-admin-revoked', { detail: code }));
    }
    function interrupted(kind) {
        stop();
        if (['execute', 'outcome'].includes(kind)) {
            lastOutcome = null;
            status.textContent = 'The request outcome is unverified. Stopping waiting does not cancel a server action. Keep this page open and check this same request’s outcome before doing anything again.';
        } else {
            if (kind === 'prepare') clearPreview();
            status.textContent = 'Inspection or preview interrupted. No action was sent. You can try again.';
        }
        controls();
    }
    function begin(kind) {
        stop();
        const request = { kind, sequence, controller: new AbortController(), timer: null };
        active = request;
        request.timer = window.setTimeout(() => {
            if (!current(request)) return;
            if (kind === 'capabilities') {
                stop(); status.textContent = 'Account action capability could not be checked. Actions are unavailable.'; controls();
            } else interrupted(kind);
        }, 15000);
        controls(); return request;
    }
    function finish(request) {
        window.clearTimeout(request.timer);
        if (active === request) active = null;
        if (request.sequence === sequence) controls();
    }
    async function read(request, path, body) {
        const response = await fetch('/api/dashboard-admin/' + path, { method: body ? 'POST' : 'GET',
            credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: request.controller.signal,
            headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
            ...(body ? { body: JSON.stringify(body) } : {}) });
        // Access denials invalidate every protected panel even after cancellation.
        if ([401, 403].includes(response.status)) { revoked(response.status); return null; }
        if (!current(request)) return null;
        if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) throw new Error();
        const value = await response.json();
        if (!current(request)) return null;
        if (!response.ok) {
            const error = new Error();
            error.conflict = response.status === 409 && exact(value, ['code']) && value.code === 'dashboard_admin_conflict';
            throw error;
        }
        return value;
    }
    async function access() {
        if (active || allowed && unresolved()) return;
        allowed = false;
        if (!unresolved()) clearAll();
        const request = begin('capabilities');
        status.textContent = 'Checking account action capability…';
        try {
            const value = await read(request, 'capabilities');
            if (!current(request) || value === null) return;
            allowed = value?.accountActions === true;
            status.textContent = allowed ? unresolved() ? 'Access confirmed. Recover this same request’s outcome before preparing another change.' :
                'Action access confirmed. Inspect an exact identity and organisation to see available changes.' : 'Account action capability is unavailable. No changes can be prepared.';
        } catch (_) { if (current(request)) status.textContent = 'Account action capability could not be checked. Actions are unavailable.'; }
        finally { finish(request); }
    }
    function node(tag, text) { const item = document.createElement(tag); if (text !== undefined) item.textContent = text; return item; }
    function details(parent, rows) {
        const list = node('dl'); for (const [label, value] of rows) list.append(node('dt', label), node('dd', value)); parent.append(list);
    }
    function scopeDetails(parent, selection) { details(parent, [['Provider', selection.provider], ['Immutable subject key', selection.subjectKey],
        ['Tenant ID', selection.tenantId], ['Organisation ID', selection.organisationId]]); }
    function heading(parent, id, text) { const title = node('h3', text); title.id = id; title.setAttribute('tabindex', '-1'); parent.append(title); return title; }
    function validateInspection(value, selected) {
        if (!exact(value, ['selector', 'version', 'displayName', 'displayLabel', 'membership', 'actions', ...(Object.hasOwn(value || {}, 'members') ? ['members', 'invitations'] : []), ...(Object.hasOwn(value || {}, 'signup') ? ['signup'] : [])]) || !sameSelector(value.selector, selected) ||
            !digest(value.version) || !existingName(value.displayName) || value.displayLabel !== null && !displayName(value.displayLabel) || !(value.signup ? value.membership === null && exact(value.signup, ['state', 'accountId', 'hasAuthority']) && value.signup.state === 'half_created' && UUID.test(value.signup.accountId) && typeof value.signup.hasAuthority === 'boolean' : validMembership(value.membership)) || !Array.isArray(value.actions) ||
            value.actions.length > 6 || new Set(value.actions).size !== value.actions.length || value.actions.some(key => !['edit', 'delete', 'restore', 'reset', 'archive', 'unarchive'].includes(key))) throw new Error();
    }
    function renderMembers(value) {
        if (!Object.hasOwn(value, 'members')) {
            inspectionView.append(node('p', 'Organisation member listing requires its own current approval.'));
            return;
        }
        for (const key of ['members', 'invitations']) {
            if (!Array.isArray(value[key]) || value[key].length > 10000) throw new Error();
            inspectionView.append(node('h4', key === 'members' ? 'All organisation memberships' : 'All organisation invitations'));
            const table = node('table'), header = node('tr');
            for (const text of ['Subject ID', 'Status', 'Roles', 'Valid from', 'Valid until']) header.append(node('th', text));
            table.append(header);
            for (const row of value[key]) {
                if (!SUBJECT.test(row.subjectKey) || typeof row.status !== 'string' || !Array.isArray(row.roles) ||
                    row.roles.some(role => !['admin', 'editor', 'viewer', 'fractional_advisor'].includes(role)) ||
                    !instant(row.validFrom) || !instant(row.validUntil)) throw new Error();
                const tr = node('tr');
                for (const text of [row.subjectKey, row.effectiveStatus || row.status, row.roles.join(', '), row.validFrom, row.validUntil]) tr.append(node('td', text));
                table.append(tr);
            }
            inspectionView.append(table, node('p', String(value[key].length) + ' records. Complete for this organisation.'));
        }
    }
    function renderInspection(value) {
        snapshot = value;
        const title = heading(inspectionView, 'accountActionsInspectionHeading', 'Inspected identity and organisation');
        scopeDetails(inspectionView, value.selector);
        const member = value.membership || { membershipId: 'Not created', status: 'Not created', validFrom: 'Not created', validUntil: 'Not created' };
        details(inspectionView, [['Organisation display name', value.displayName], ['Staff-facing account label', value.displayLabel || 'Not set'], ['Membership ID', member.membershipId],
            ['Saved membership status', member.status], ['Valid from', member.validFrom], ['Valid until', member.validUntil]]);
        const available = value.actions.filter(key => Object.hasOwn(labels, key));
        for (const key of available) { const option = node('option', labels[key]); option.value = key; action.append(option); }
        action.value = available[0] || ''; name.value = value.displayLabel || '';
        const unavailable = Object.keys(labels).filter(key => !available.includes(key)).map(key => labels[key]);
        inspectionView.append(node('p', (unavailable.length ? 'Unavailable for this record: ' + unavailable.join('; ') + '. ' : '') +
            'Permanent account erasure is unavailable in this view.'));
        renderMembers(value);
        inspectionView.hidden = false; selectedAction();
        status.textContent = available.length ? 'Inspection loaded. Choose an available action and review its preview.' : 'No supported account actions are available for this record.';
        title.focus();
    }
    async function inspectSelection() {
        if (!allowed || active || unresolved()) return;
        const selected = { provider: provider.value, subjectKey: subject.value, tenantId: tenant.value, organisationId: organisation.value };
        clearAll();
        if (!validSelector(selected)) {
            status.textContent = 'Enter a provider, canonical immutable subject key and exact tenant and organisation identifiers (1–180 characters, without outer spaces, control characters or *).'; controls(); return;
        }
        const request = begin('inspect'); status.textContent = 'Inspecting actions for this exact identity and organisation…';
        try {
            const value = await read(request, 'actions/inspect', selected);
            if (!current(request) || value === null) return;
            validateInspection(value, selected); renderInspection(value);
        } catch (_) { if (current(request)) { clearAll(); status.textContent = 'Account actions could not be inspected. No account state has been inferred. You can inspect again.'; } }
        finally { finish(request); }
    }
    function selectedAction() {
        nameLabel.hidden = action.value !== 'edit'; name.required = action.value === 'edit';
        confirmationNameLabel.hidden = !['delete', 'archive', 'reset'].includes(action.value); confirmationName.required = ['delete', 'archive', 'reset'].includes(action.value);
        effect.textContent = effects[action.value] || 'No supported action is available.';
    }
    function validatePreview(value, selected, selectedAction, patch) {
        if (!exact(value, ['confirmationToken', 'operationId', 'selector', 'action', 'patch', 'before', 'expiresAt']) ||
            typeof value.confirmationToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.confirmationToken) || !UUID.test(value.operationId) ||
            !sameSelector(value.selector, selected) || value.action !== selectedAction || !instant(value.expiresAt) ||
            !exact(value.before, ['displayName', 'displayLabel', 'membership']) || !existingName(value.before.displayName) ||
            value.before.displayLabel !== null && !displayName(value.before.displayLabel) || !(value.action === 'reset' ? value.before.membership === null : validMembership(value.before.membership)) ||
            (patch === null ? value.patch !== null : !exact(value.patch, ['displayLabel']) || value.patch.displayLabel !== patch.displayLabel)) throw new Error();
        if (value.action === 'delete' && value.before.membership.status !== 'active' || value.action === 'restore' && value.before.membership.status !== 'suspended') throw new Error();
    }
    function renderPreview(value) {
        prepared = value; ticket = { confirmationToken: value.confirmationToken, operationId: value.operationId, expiresAt: value.expiresAt };
        const member = value.before.membership || { membershipId: 'Not created', status: 'Not created', validFrom: 'Not created', validUntil: 'Not created' };
        const title = heading(preview, 'accountActionsPreviewHeading', 'Review: ' + labels[value.action]); scopeDetails(preview, value.selector);
        details(preview, [['Membership ID', member.membershipId], ['Organisation name (unchanged)', value.before.displayName],
            ['Account label before', value.before.displayLabel || 'Not set'], ['Account label after', value.action === 'edit' ? value.patch.displayLabel : value.before.displayLabel || 'Not set'],
            ['Membership status before', member.status],
            ['Membership status after', value.action === 'delete' ? 'suspended' : value.action === 'restore' ? 'active' : member.status],
            ['Validity dates', member.validFrom + ' to ' + member.validUntil + ' (unchanged)'],
            ['Confirmation expires', value.expiresAt], ['Request reference', value.operationId]]);
        preview.append(node('p', effects[value.action]));
        preview.append(node('p', 'Keep this page open until the outcome is confirmed. Stopping waiting does not cancel a server action. This page will not start another action automatically.'));
        preview.hidden = false; confirm.checked = false; execute.textContent = 'Confirm: ' + labels[value.action];
        status.textContent = expired() ? 'This preview has expired. Inspect current state and prepare a fresh preview.' : 'Preview ready. Review the exact identity, organisation, and before and after values, then confirm explicitly.';
        expiryTimer = window.setTimeout(() => {
            if (!ticket) return;
            if (!attempted) status.textContent = 'This preview has expired. Discard it and prepare a fresh preview before applying a change.';
            else if (unresolved() && !active) status.textContent = 'This confirmation has expired. Check this same request’s outcome. A new change requires a completed outcome or server-confirmed expiry without applying.';
            controls();
        }, Math.max(0, Date.parse(value.expiresAt) - Date.now()));
        title.focus();
    }
    async function prepareChange() {
        if (!allowed || active || attempted || !snapshot || !snapshot.actions.includes(action.value) || !Object.hasOwn(labels, action.value)) return;
        const selected = snapshot.selector, selectedAction = action.value, patch = selectedAction === 'edit' ? { displayLabel: name.value } : null;
        clearPreview(); clearView(outcome);
        if (patch && !displayName(patch.displayLabel)) {
            status.textContent = 'Enter an account label of 1–200 characters without outer spaces, control or formatting characters, or angle brackets. Use normalised text.'; controls(); return;
        }
        if (['delete', 'archive', 'reset'].includes(selectedAction) && confirmationName.value !== snapshot.displayName) {
            status.textContent = 'Type the exact organisation name shown in the inspection to confirm removal.'; controls(); return;
        }
        const request = begin('prepare'); status.textContent = 'Preparing a scoped preview. No action has been sent…';
        try {
            const value = await read(request, 'actions/prepare', { selector: selected, action: selectedAction, patch,
                ...(['delete', 'archive', 'reset'].includes(selectedAction) ? { confirmationName: confirmationName.value } : {}) });
            if (!current(request) || value === null) return;
            validatePreview(value, selected, selectedAction, patch); renderPreview(value);
        } catch (error) { if (current(request)) { clearPreview(); status.textContent = error.conflict ?
            'The record changed or this action no longer applies. Inspect current state and prepare a fresh preview.' : 'A trustworthy preview could not be prepared. No action was sent. You can inspect again.'; } }
        finally { finish(request); }
    }
    function validateOutcome(value) {
        if (!exact(value, ['operationId', 'commandSha256', 'status', 'version', 'occurredAt']) || value.operationId !== ticket.operationId ||
            !digest(value.commandSha256) || !['succeeded', 'pending', 'not_started', 'not_started_expired'].includes(value.status) ||
            (['not_started', 'not_started_expired'].includes(value.status) ? value.version !== null || value.occurredAt !== null : !digest(value.version) || !instant(value.occurredAt))) throw new Error();
    }
    function renderOutcome(value) {
        clearView(outcome); lastOutcome = value.status; terminal = ['succeeded', 'not_started_expired'].includes(value.status);
        const title = heading(outcome, 'accountActionsOutcomeHeading', value.status === 'succeeded' ? 'Request completed' : value.status === 'not_started_expired' ? 'Request expired without applying' : 'Request outcome needs follow-up');
        details(outcome, [['Request reference', value.operationId], ['Outcome', value.status === 'succeeded' ? 'Succeeded' : value.status === 'not_started_expired' ? 'Expired without applying' : value.status === 'pending' ? 'Pending' : 'No committed outcome found yet'],
            ['Recorded at', value.occurredAt || 'Not recorded']]);
        status.textContent = value.status === 'succeeded' ? 'This request succeeded. Inspect current state before preparing another change. The confirmed request will not be sent again.' :
            value.status === 'not_started_expired' ? 'The server confirmed that this request expired without applying a change. You can now inspect current state and review a new preview.' :
            value.status === 'pending' ? 'This request is pending. Keep this page open and check this same request’s outcome. Do not prepare another change.' :
                'No committed outcome was found yet. The original request may still finish. Check again, or apply the same confirmed request while its confirmation remains valid. A new request becomes available only after a completed outcome or server-confirmed expiry without applying.';
        outcome.append(node('p', status.textContent)); outcome.hidden = false; title.focus();
    }
    async function send(kind) {
        if (!allowed || active || !ticket || terminal) return;
        if (kind === 'execute' && (expired() || !attempted && (!prepared || !confirm.checked) || attempted && lastOutcome !== 'not_started')) return;
        if (kind === 'outcome' && !attempted) return;
        if (kind === 'execute') attempted = true;
        lastOutcome = null; clearView(outcome);
        const request = begin(kind); status.textContent = kind === 'execute' ? 'Applying the confirmed request. Keep this page open until its outcome is verified…' : 'Checking the outcome of this same request…';
        try {
            const value = await read(request, 'actions/' + kind, { confirmationToken: ticket.confirmationToken });
            if (!current(request) || value === null) return;
            validateOutcome(value); renderOutcome(value);
        } catch (error) {
            if (!current(request)) return;
            status.textContent = error.conflict ?
                'This confirmation is stale, expired, or no longer applicable. Check this same request’s outcome before preparing another change.' :
                'The request outcome could not be verified. It may have completed. Keep this page open and check this same request’s outcome before doing anything again.';
        } finally { finish(request); }
    }
    selectorForm.addEventListener('submit', event => { event.preventDefault(); inspectSelection(); });
    prepareForm.addEventListener('submit', event => { event.preventDefault(); prepareChange(); });
    confirmForm.addEventListener('submit', event => { event.preventDefault(); send('execute'); });
    function selectorChanged() {
        if (!allowed || attempted) return;
        stop(); clearAll(); status.textContent = 'Identity or organisation changed. Inspect this exact scope before preparing a change.'; controls();
    }
    selectorForm.addEventListener('input', selectorChanged); selectorForm.addEventListener('change', selectorChanged);
    function changeAction() {
        if (!allowed || attempted) return;
        stop(); clearPreview(); selectedAction(); status.textContent = 'Change details updated. Prepare and review a fresh preview.'; controls();
    }
    prepareForm.addEventListener('input', changeAction); prepareForm.addEventListener('change', changeAction);
    confirm.addEventListener('change', controls);
    discard.addEventListener('click', () => { if (attempted || active) return; clearPreview(); status.textContent = 'Preview discarded. No action was sent.'; controls(); byId('Prepare').focus(); });
    cancel.addEventListener('click', () => { if (!active) return; const kind = active.kind; interrupted(kind); (unresolved() ? recover : inspect).focus(); });
    recover.addEventListener('click', () => send('outcome'));
    resume.addEventListener('click', () => send('execute'));
    fresh.addEventListener('click', inspectSelection);
    check.addEventListener('click', access);
    window.addEventListener('dashboard-admin-revoked', event => revoked(event?.detail, false));
    window.addEventListener('beforeunload', event => { if (unresolved()) { event.preventDefault(); event.returnValue = ''; } });
    window.addEventListener('pagehide', () => {
        const pending = unresolved(); allowed = false; stop(); clearAll(); clearFields(); controls();
        status.textContent = pending ? 'This page closed before the request outcome was verified. Re-establish its outcome before repeating any change.' : 'Check action access to continue. No account action details are displayed.';
    });
    window.addEventListener('pageshow', event => { if (event?.persisted) access(); });
    access();
}());
