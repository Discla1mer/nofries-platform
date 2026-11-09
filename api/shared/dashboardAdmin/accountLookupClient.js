(function () {
    'use strict';
    const panel = document.getElementById('accountLookupPanel');
    if (!panel) return;
    const form = document.getElementById('accountLookupForm');
    const email = document.getElementById('accountLookupEmail');
    const status = document.getElementById('accountLookupStatus');
    const result = document.getElementById('accountLookupResults');
    const button = form.querySelector('button');
    let active = null;
    panel.hidden = false;
    window.addEventListener('pagehide', () => {
        active?.abort(); active = null; result.replaceChildren(); email.value = ''; status.textContent = '';
    });
    form.addEventListener('submit', async event => {
        event.preventDefault();
        active?.abort();
        const controller = new AbortController(); active = controller;
        const timer = setTimeout(() => controller.abort(), 12000);
        result.replaceChildren(); button.disabled = true; result.setAttribute('aria-busy', 'true');
        status.textContent = 'Looking up account…';
        try {
            const response = await fetch('/api/dashboard-admin/accounts/lookup?email=' + encodeURIComponent(email.value.trim()), {
                credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal,
                headers: { Accept: 'application/json' }
            });
            if (!response.ok) throw new Error(response.status === 429 ? 'Too many lookups. Try again in a minute.' :
                [401, 403].includes(response.status) ? 'Staff admin access is required. Sign in again.' : 'Account lookup is unavailable.');
            const value = await response.json();
            if (active !== controller) return;
            const table = document.createElement('table');
            const caption = table.createCaption(); caption.textContent = 'Customer sign-in authority (read only)';
            const head = table.createTHead().insertRow();
            ['Email', 'Account type', 'Organisation', 'Status', 'Expires at (UTC)', 'Revision'].forEach(label => {
                const cell = document.createElement('th'); cell.scope = 'col'; cell.textContent = label; head.append(cell);
            });
            const body = table.createTBody();
            value.rows.forEach(row => {
                const tr = body.insertRow();
                ['email', 'accountType', 'organisation', 'status', 'expiresAt', 'revision'].forEach(key => {
                    tr.insertCell().textContent = row[key] ?? 'Unknown';
                });
            });
            result.append(table);
            status.textContent = 'Lookup complete. Missing means no usable matching subject record was found. Active authority alone does not prove sign-in will succeed.';
        } catch (error) {
            if (active === controller) status.textContent = error.name === 'AbortError' ? 'Lookup timed out. Try again.' : error.message;
        } finally {
            clearTimeout(timer);
            if (active === controller) { active = null; button.disabled = false; result.setAttribute('aria-busy', 'false'); }
        }
    });
}());
