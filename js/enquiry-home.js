(async function () {
    // #151 F4: one anonymous home page visit count, sent only when the server
    // marked the availability response (funnel counts on). No cookies,
    // referrer or identifiers; failures are ignored.
    function homeVisit() {
        if (typeof window.fetch !== 'function') return;
        try {
            window.fetch('/api/telemetry', { method: 'POST', keepalive: true, credentials: 'omit', mode: 'same-origin',
                cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
                headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: 'visit' }) }).catch(function () {});
        } catch (_) { /* best-effort */ }
    }
    if (!document.body || document.body.dataset.page !== 'dashboard-home') return;
    const enquiry = document.getElementById('homepageEnquiry');
    // Enquiry availability says nothing about signup availability. Keep the
    // primary action stable and offer verified contact as a separate route.
    if (!enquiry) return;
    try {
        const status = await window.enquiryAvailability();
        if (status.funnel === true) homeVisit();
        if (status.available !== true || status.promote !== true) return;
        enquiry.hidden = false;
    } catch (_) { /* The account entry remains usable without this read. */ }
}());
