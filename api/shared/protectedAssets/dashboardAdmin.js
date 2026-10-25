(function () {
    'use strict';
    const byId = id => document.getElementById(id);
    const form = byId('adminLookupForm'), fields = byId('adminLookupFields');
    const provider = byId('adminProvider'), subject = byId('adminSubject');
    const tenant = byId('adminTenant'), organisation = byId('adminOrganisation');
    const submit = byId('adminLookupSubmit'), cancel = byId('adminLookupCancel');
    const accessStatus = byId('adminAccessStatus'), lookupStatus = byId('adminLookupStatus');
    const checkAccess = byId('adminCheckAccess'), signIn = byId('adminSignIn'), result = byId('adminLookupResult');
    let allowed = false, sequence = 0, active = null;
    const subjectKeyPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    const validIdentifier = value => value.length >= 1 && value.length <= 180 && value === value.trim() && !/[\u0000-\u001f\u007f*]/.test(value);

    function clearResult() { result.replaceChildren(); result.hidden = true; }
    function stop() {
        sequence += 1;
        if (active) { active.controller.abort(); window.clearTimeout(active.timer); active = null; }
        cancel.hidden = true;
        submit.disabled = !allowed;
        form.setAttribute('aria-busy', 'false');
    }
    function revoke(status, broadcast = true) {
        if (broadcast) window.dispatchEvent?.(new window.CustomEvent('dashboard-admin-revoked', { detail: status }));
        allowed = false; stop(); clearResult(); fields.disabled = true;
        subject.value = ''; tenant.value = ''; organisation.value = '';
        lookupStatus.textContent = '';
        signIn.hidden = status !== 401;
        checkAccess.disabled = false;
        accessStatus.textContent = status === 401 ? 'Your session has ended. Sign in again to check operator access.' :
            'Operator access is unavailable. An authorised administrator must confirm your access.';
    }
    function begin() {
        stop();
        const request = { sequence, controller: new AbortController(), timer: null };
        request.timer = window.setTimeout(() => request.controller.abort(), 15000);
        active = request;
        return request;
    }
    function finish(request) {
        window.clearTimeout(request.timer);
        if (active === request) active = null;
    }
    async function read(url, request, body) {
        const response = await fetch(url, { method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
            redirect: 'error', signal: request.controller.signal, headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
            ...(body ? { body: JSON.stringify(body) } : {}) });
        // Any observed access denial clears protected output, even from a request
        // superseded by a newer lookup. Stale successful responses never render.
        if (response.status === 401 || response.status === 403) { revoke(response.status); return null; }
        if (request.sequence !== sequence) return null;
        if (!response.ok || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) throw new Error('unavailable');
        return response.json();
    }
    async function loadCapabilities() {
        allowed = false; stop(); clearResult(); fields.disabled = true; checkAccess.disabled = true; signIn.hidden = true;
        lookupStatus.textContent = '';
        accessStatus.textContent = 'Checking operator access. Lookup is unavailable until access is confirmed.';
        const request = begin();
        try {
            const value = await read('/api/dashboard-admin/capabilities', request);
            if (request.sequence !== sequence || value === null) return;
            if (!value || typeof value.lookup !== 'boolean' || !Array.isArray(value.recovery)) throw new Error('unavailable');
            allowed = value.lookup === true;
            fields.disabled = !allowed; submit.disabled = !allowed;
            accessStatus.textContent = allowed ? 'Operator access confirmed. Exact scoped lookup is available. Account changes are unavailable.' :
                'Lookup capability is unavailable for this operator. No lookup data has been loaded.';
        } catch (_error) {
            if (request.sequence === sequence) accessStatus.textContent = 'Operator capabilities could not be checked. Lookup is unavailable. You can check access again.';
        } finally {
            finish(request);
            if (request.sequence === sequence) checkAccess.disabled = false;
        }
    }
    const text = value => typeof value === 'string' && value.length ? value :
        typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value) ? String(value) : 'Unknown';
    function node(tag, content) { const item = document.createElement(tag); if (content !== undefined) item.textContent = text(content); return item; }
    function details(parent, rows) {
        const list = node('dl');
        rows.forEach(([label, value]) => list.append(node('dt', label), node('dd', value)));
        parent.append(list);
    }
    function records(title, rows, project) {
        result.append(node('h3', title));
        if (!rows.length) { result.append(node('p', 'None recorded in this snapshot.')); return; }
        const list = node('ul'); list.className = 'record-list';
        rows.slice(0, 100).forEach(row => { const item = node('li'); details(item, project(row || {})); list.append(item); });
        result.append(list);
        if (rows.length > 100) result.append(node('p', 'Only the first 100 records are displayed.'));
    }
    function render(value, selection) {
        if (!value || !['found', 'not_found', 'unavailable', 'ambiguous'].includes(value.status) ||
            value.identity?.provider !== selection.provider || value.identity?.subjectKey !== selection.subjectKey ||
            value.scope?.tenantId !== selection.tenantId || value.scope?.organisationId !== selection.organisationId)
            throw new Error('unavailable');
        // Only explicit empty collections establish absence. A partial or
        // malformed successful response must not look like verified account data.
        if (value.status === 'found' && !['memberships', 'invitations', 'entitlements', 'usage']
            .every(key => Array.isArray(value[key]))) throw new Error('unavailable');
        clearResult();
        const titles = { found: 'Scoped access records found', not_found: 'No membership in this exact scope',
            unavailable: 'Scoped lookup unavailable', ambiguous: 'Identity match needs review' };
        const heading = node('h2', titles[value.status]); heading.id = 'adminResultHeading'; heading.setAttribute('tabindex', '-1');
        result.append(heading);
        details(result, [['Provider', selection.provider], ['Immutable subject key', selection.subjectKey],
            ['Tenant ID', selection.tenantId], ['Organisation ID', selection.organisationId], ['Evaluated at', value.evaluatedAt]]);
        if (value.status === 'found') {
            details(result, [['Tenant', value.tenant?.displayName], ['Tenant status', value.tenant?.status],
                ['Organisation', value.organisation?.displayName], ['Organisation status', value.organisation?.status]]);
            records('Memberships', value.memberships, row => [['Membership ID', row.membershipId], ['Saved status', row.status],
                ['Effective status', row.effectiveStatus], ['Roles', Array.isArray(row.roles) ? row.roles.map(text).join(', ') : null],
                ['Valid from', row.validFrom], ['Valid until', row.validUntil]]);
            records('Invitations', value.invitations, row => [['Status', row.status], ['Roles', Array.isArray(row.roles) ? row.roles.map(text).join(', ') : null],
                ['Valid from', row.validFrom], ['Valid until', row.validUntil], ['Expires at', row.expiresAt]]);
            records('Entitlements', value.entitlements, row => [['Grant ID', row.grantId], ['Code', row.code], ['Status', row.status],
                ['Valid from', row.validFrom], ['Valid until', row.validUntil]]);
            result.append(node('p', 'Plan details are unavailable in this view. Entitlement dates above are saved values; no trial duration is assumed.'));
            result.append(node('h3', 'Feature flags'));
            const flags = value.flags?.enabled;
            if (flags && typeof flags === 'object' && !Array.isArray(flags) && Object.keys(flags).length)
                details(result, Object.keys(flags).slice(0, 100).map(key => [key, typeof flags[key] === 'boolean' ? (flags[key] ? 'Enabled' : 'Disabled') : 'Unknown']));
            else result.append(node('p', 'Unavailable in this snapshot.'));
            records('Usage', value.usage, row => [['Grant ID', row.grantId], ...Object.keys(row.counters || {}).slice(0, 30)
                .map(key => [key, typeof row.counters[key] === 'number' && Number.isFinite(row.counters[key]) ? row.counters[key] : null])]);
            result.append(node('h3', 'Snapshot revisions'));
            details(result, [['Tenant revision', value.revisions?.tenant], ['Organisation revision', value.revisions?.organisation],
                ['Membership revision', value.revisions?.membership], ['Entitlement revision', value.revisions?.entitlement],
                ['Flags revision', value.revisions?.flags]]);
        } else {
            result.append(node('p', value.status === 'not_found' ? 'This does not establish whether the identity exists with another provider or in another scope.' :
                value.status === 'ambiguous' ? 'The stored identity match could not be resolved safely. No account details are displayed.' :
                    'An authoritative read is unavailable. No account state or signup outcome has been inferred.'));
        }
        result.append(node('h3', 'Signup and recovery'));
        details(result, [['Signup completion', 'Unavailable — this lookup does not establish signup completion.'],
            ['Signup diagnostics', 'Unavailable — no trusted diagnostic reader is connected.'],
            ['Recovery actions', 'Unavailable — this portal is read only.']]);
        result.hidden = false;
        lookupStatus.textContent = titles[value.status] + '.';
        heading.focus();
    }
    form.addEventListener('submit', async event => {
        event.preventDefault();
        if (!allowed) return;
        const selection = { provider: provider.value, subjectKey: subject.value, tenantId: tenant.value,
            organisationId: organisation.value };
        stop(); clearResult();
        if (!['legacy', 'external'].includes(selection.provider) || !subjectKeyPattern.test(selection.subjectKey) ||
            !validIdentifier(selection.tenantId) || !validIdentifier(selection.organisationId)) {
            lookupStatus.textContent = 'Enter a provider, canonical immutable subject key and exact tenant and organisation identifiers (1–180 characters, without outer spaces, control characters or *).'; return;
        }
        const request = begin(); submit.disabled = true; cancel.hidden = false; form.setAttribute('aria-busy', 'true');
        lookupStatus.textContent = 'Looking up this exact identity and scope…';
        try {
            const body = await read('/api/dashboard-admin/lookup', request, selection);
            if (request.sequence !== sequence || body === null) return;
            render(body?.result, selection);
        } catch (_error) {
            if (request.sequence === sequence) { clearResult(); lookupStatus.textContent = 'Lookup unavailable. No account state has been inferred. You can try again.'; }
        } finally {
            finish(request);
            if (request.sequence === sequence) { submit.disabled = !allowed; cancel.hidden = true; form.setAttribute('aria-busy', 'false'); }
        }
    });
    function changed() {
        if (!allowed) return;
        stop(); clearResult(); lookupStatus.textContent = 'Lookup details changed. Submit the exact scope to load a fresh result.';
    }
    form.addEventListener('input', changed); form.addEventListener('change', changed);
    cancel.addEventListener('click', () => { stop(); clearResult(); lookupStatus.textContent = 'Lookup cancelled. No result is displayed.'; submit.focus(); });
    checkAccess.addEventListener('click', loadCapabilities);
    window.addEventListener('pagehide', () => {
        allowed = false; stop(); clearResult(); fields.disabled = true;
        accessStatus.textContent = 'Check operator access to continue. No account data is displayed.';
    });
    window.addEventListener('pageshow', event => { if (event?.persisted) loadCapabilities(); });
    window.addEventListener('dashboard-admin-revoked', event => revoke(event?.detail, false));
    loadCapabilities();
}());
