(function () {
    'use strict';
    const button = document.getElementById('websiteUsageLoad');
    const status = document.getElementById('websiteUsageStatus');
    const result = document.getElementById('websiteUsageResult');
    if (!button || !status || !result) return;
    let sequence = 0;
    function show(data) {
        const pages = {}, referrers = {}, devices = {};
        let views = 0, clicks = 0, entries = 0;
        for (const row of Object.values(data.days)) {
            for (const [key, value] of Object.entries(row.pages)) { pages[key] = (pages[key] || 0) + value; views += value; }
            for (const [key, value] of Object.entries(row.referrers)) referrers[key] = (referrers[key] || 0) + value;
            for (const [key, value] of Object.entries(row.devices)) devices[key] = (devices[key] || 0) + value;
            clicks += row.createClicks; entries += row.signupEntries;
        }
        const labels = { home: 'Homepage', 'managed-it': 'Managed IT', roadmap: 'Roadmap', privacy: 'Privacy', terms: 'Terms', login: 'Public login', direct: 'Direct or unavailable', search: 'Search', social: 'Social', other: 'Other', unknown: 'Unknown', desktop: 'Desktop', mobile: 'Mobile', tablet: 'Tablet' };
        const node = (tag, text) => { const element = document.createElement(tag); element.textContent = text; return element; };
        const today = new Date();
        const end = today.toISOString().slice(0, 10);
        const earliest = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 89)).toISOString().slice(0, 10);
        const start = data.start > earliest ? data.start : earliest;
        const fragment = document.createDocumentFragment();
        fragment.append(node('p', `Reporting window: ${start} to ${end} UTC (up to 90 days).`));
        fragment.append(node('p', `Recorded page views: ${views.toLocaleString()}.`));
        function section(title, counts) {
            fragment.append(node('h3', title));
            const list = node('ul', '');
            const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
            if (!sorted.length) list.append(node('li', 'No recorded views.'));
            for (const [key, value] of sorted) list.append(node('li', `${labels[key] || 'Unknown'}: ${value.toLocaleString()}`));
            fragment.append(list);
        }
        section('Popular pages', pages); section('Referrer categories', referrers); section('Device categories', devices);
        fragment.append(node('h3', 'Public signup interest'));
        fragment.append(node('p', `Create-account clicks: ${clicks.toLocaleString()}. Signup-entry views: ${entries.toLocaleString()}.`));
        fragment.append(node('p', 'These are separate event totals, not a conversion rate or a cohort.'));
        result.replaceChildren(fragment); result.hidden = false;
    }
    button.addEventListener('click', async () => {
        const request = ++sequence;
        button.disabled = true; result.hidden = true; result.textContent = '';
        status.textContent = 'Loading website usage.';
        try {
            const response = await fetch('/api/website-analytics/summary', { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(8000) });
            if (!response.ok) throw Error();
            const data = await response.json();
            if (request !== sequence) return;
            show(data);
            status.textContent = 'Website usage loaded.';
        } catch (_) { if (request === sequence) { result.textContent = ''; result.hidden = true; status.textContent = 'Website usage is unavailable.'; } }
        finally { if (request === sequence) button.disabled = false; }
    });
    window.addEventListener('dashboard-admin-revoked', () => { sequence++; button.disabled = true; result.textContent = ''; result.hidden = true; status.textContent = 'Website usage is unavailable.'; });
})();
