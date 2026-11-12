(async function () {
    if (!document.body || document.body.dataset.page !== 'dashboard-home') return;
    const enquiry = document.getElementById('homepageEnquiry');
    // Enquiry availability says nothing about signup availability. Keep the
    // primary action stable and offer verified contact as a separate route.
    if (!enquiry) return;
    try {
        const status = await window.enquiryAvailability();
        if (status.available !== true || status.promote !== true) return;
        enquiry.hidden = false;
    } catch (_) { /* The account entry remains usable without this read. */ }
}());
