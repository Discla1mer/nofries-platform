(async function () {
    if (!document.body || document.body.dataset.page !== 'contact') {
        return;
    }

    const form = document.getElementById('contact-form');
    const status = document.getElementById('contact-status');
    const send = document.getElementById('contact-send');
    const FALLBACK = 'Please email hello@nofries.nz instead.';

    let available = false;
    let checking;

    form.addEventListener('submit', async function (event) {
        event.preventDefault();
        if (checking) {
            status.textContent = 'One moment…';
            await checking;
        }
        if (!available) {
            status.textContent = 'The enquiry form is not available right now. ' + FALLBACK;
            return;
        }
        if (!form.reportValidity()) {
            return;
        }
        const data = new FormData(form);
        const body = {};
        ['name', 'email', 'organisation', 'message', 'website'].forEach(function (field) {
            body[field] = String(data.get(field) || '');
        });

        send.disabled = true;
        status.textContent = 'Sending…';
        try {
            const response = await fetch('/api/enquiry', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                body: JSON.stringify(body)
            });
            const payload = await response.json().catch(function () { return {}; });
            if (!response.ok) {
                status.textContent = (payload && payload.error) || ('Your enquiry could not be sent. ' + FALLBACK);
                send.disabled = false;
                return;
            }
            if (!payload || payload.received !== true) {
                status.textContent = 'We could not confirm your enquiry was sent. ' + FALLBACK;
                send.disabled = false;
                return;
            }
            form.reset();
            status.textContent = 'Thanks — your enquiry has been sent. We will reply by email.';
            if (window.plausible) {
                window.plausible('Enquiry Sent');
            }
        } catch (error) {
            status.textContent = 'We could not confirm your enquiry was sent. ' + FALLBACK;
        }
        send.disabled = false;
    });
    // The handler is attached, so the button can be used while availability is checked.
    send.disabled = false;
    checking = (async function () {
        try {
            available = (await window.enquiryAvailability()).available === true;
        } catch (_) { /* Missing client script also fails closed. */ }
    }());
    await checking;
    checking = null;
    send.disabled = !available;
    if (!available) status.textContent = 'The enquiry form is not available right now. ' + FALLBACK;
}());
