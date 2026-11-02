(function () {
    if (!document.body || document.body.dataset.page !== 'contact') {
        return;
    }

    const form = document.getElementById('contact-form');
    const status = document.getElementById('contact-status');
    const send = document.getElementById('contact-send');
    const FALLBACK = 'Please email hello@nofries.nz instead.';

    form.addEventListener('submit', async function (event) {
        event.preventDefault();
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
            form.reset();
            status.textContent = 'Thanks — your enquiry has been sent. We will reply by email.';
            if (window.plausible) {
                window.plausible('Enquiry Sent');
            }
        } catch (error) {
            status.textContent = 'Your enquiry could not be sent. ' + FALLBACK;
        }
        send.disabled = false;
    });
    send.disabled = false;
}());
