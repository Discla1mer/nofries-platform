(() => {
    'use strict';
    if (window.__nofriesWebsiteAnalytics) return;
    window.__nofriesWebsiteAnalytics = true;
    const blocked = navigator.globalPrivacyControl === true || navigator.doNotTrack === '1' || window.doNotTrack === '1';
    const page = ({ '/': 'home', '/managed-it.html': 'managed-it', '/roadmap.html': 'roadmap', '/privacy.html': 'privacy', '/terms.html': 'terms', '/login': 'login', '/login.html': 'login' })[location.pathname];
    if (!page) return;
    // Probe availability once; no counts are shown publicly.
    const enabled = blocked ? Promise.resolve(false) : fetch('/api/website-analytics/status', { credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' })
        .then(r => r.ok ? r.json() : Promise.reject())
        .then(value => Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).join(',') === 'status' && value.status === 'available'))
        .catch(() => false);
    function referrer() {
        if (!document.referrer) return 'direct';
        try { const host = new URL(document.referrer).hostname.toLowerCase();
            if (host === location.hostname) return 'direct';
            if (/(^|\.)(google|bing|duckduckgo|yahoo)\./.test(host)) return 'search';
            if (/(^|\.)(facebook|instagram|linkedin|reddit|x|twitter)\.com$/.test(host)) return 'social';
            return 'other';
        } catch (_) { return 'unknown'; }
    }
    function device() {
        const ua = navigator.userAgent || '';
        if (/ipad|tablet/i.test(ua)) return 'tablet';
        if (/mobile|iphone|android/i.test(ua)) return 'mobile';
        if (/windows|macintosh|linux/i.test(ua)) return 'desktop';
        return 'unknown';
    }
    function send(payload) {
        if (blocked) return;
        enabled.then(available => { if (!available) return; return fetch('/api/website-analytics/events', { method: 'POST', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), keepalive: true }).catch(() => {}); });
    }
    let pending = false;
    function visibleView() {
        if (!pending || document.visibilityState !== 'visible') return;
        if (page === 'home') {
            const panel = document.getElementById('gatewayPublic');
            const state = document.body.dataset.dashboardState;
            if (!state || state === 'loading' || !panel || panel.hidden || panel.getClientRects().length === 0) return;
        }
        pending = false;
        send({ event: 'view', page, referrer: referrer(), device: device() });
        if (page === 'login' && new URLSearchParams(location.search).get('intent') === 'create') send({ event: 'signup-entry' });
    }
    window.addEventListener('pageshow', () => { pending = true; visibleView(); });
    document.addEventListener('visibilitychange', visibleView);
    if (page === 'home') new MutationObserver(visibleView).observe(document.body, { attributes: true, attributeFilter: ['data-dashboard-state'] });
    if (page === 'home') {
        document.querySelector('a[href="/login?intent=create"]')?.addEventListener('click', () => send({ event: 'create-click' }));
    }
})();
