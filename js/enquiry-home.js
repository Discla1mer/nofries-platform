(async function () {
    if (!document.body || document.body.dataset.page !== 'dashboard-home') return;
    const link = document.getElementById('homepagePrimary');
    // Preserve main's signup destination and copy unless delivery was verified.
    if (!link || link.getAttribute('href') !== '/login?intent=create' ||
        !link.firstChild || link.firstChild.nodeType !== 3) return;
    try {
        const status = await window.enquiryAvailability();
        if (status.available !== true || status.promote !== true) return;
        link.setAttribute('href', '/contact.html');
        link.firstChild.nodeValue = 'Get early access ';
    } catch (_) { /* Keep signup if the runtime check cannot complete. */ }
}());
