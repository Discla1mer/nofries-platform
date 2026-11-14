(async function () {
    if (!document.body || document.body.dataset.page !== 'contact') {
        return;
    }

    const form = document.getElementById('contact-form');
    const status = document.getElementById('contact-status');
    const send = document.getElementById('contact-send');
    const summary = document.getElementById('contact-errors');
    const FALLBACK = 'Please email hello@nofries.nz instead.';
    const checks = {
        'contact-name': function (value) { return value.trim() ? '' : 'Enter your name.'; },
        'contact-email': function (value) {
            const email = value.trim();
            return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? '' : 'Enter a valid email address.';
        },
        'contact-message': function (value) {
            return value.trim().length >= 10 ? '' : 'Tell us how we can help, in at least 10 characters.';
        }
    };

    function describedBy(input, errorId, invalid) {
        const help = (input.getAttribute('aria-describedby') || '').split(/\s+/).filter(function (value) {
            return value && value !== errorId;
        });
        if (invalid) help.unshift(errorId);
        if (help.length) input.setAttribute('aria-describedby', help.join(' '));
        else input.removeAttribute('aria-describedby');
    }

    function showFieldError(id, message) {
        const input = document.getElementById(id);
        const error = document.getElementById(id + '-error');
        if (!input || !error) return;
        error.textContent = message || '';
        error.hidden = !message;
        if (message) input.setAttribute('aria-invalid', 'true');
        else input.removeAttribute('aria-invalid');
        describedBy(input, id + '-error', !!message);
    }

    function validateFields() {
        const problems = [];
        Object.keys(checks).forEach(function (id) {
            const input = document.getElementById(id);
            const message = input ? checks[id](input.value || '') : 'Check this field.';
            showFieldError(id, message);
            if (message) problems.push({ id: id, message: message });
        });
        if (!summary) return problems;
        summary.replaceChildren();
        summary.hidden = problems.length === 0;
        if (!problems.length) return problems;
        const title = document.createElement('p');
        title.textContent = 'Please check these details:';
        const list = document.createElement('ul');
        problems.forEach(function (problem) {
            const item = document.createElement('li');
            const link = document.createElement('a');
            link.href = '#' + problem.id;
            link.textContent = problem.message;
            link.addEventListener('click', function (event) {
                event.preventDefault();
                const field = document.getElementById(problem.id);
                if (field) field.focus();
            });
            item.append(link);
            list.append(item);
        });
        summary.append(title, list);
        return problems;
    }

    let available = false;
    let checking;
    let submitting = false;

    form.addEventListener('submit', async function (event) {
        event.preventDefault();
        // Take the guard before any await so a second click cannot send a second enquiry.
        if (submitting) {
            return;
        }
        submitting = true;
        send.disabled = true;
        try {
            if (checking) {
                status.textContent = 'One moment…';
                await checking;
            }
            if (!available) {
                status.textContent = 'The enquiry form is not available right now. ' + FALLBACK;
                return;
            }
            const problems = validateFields();
            if (problems.length) {
                status.textContent = '';
                const first = document.getElementById(problems[0].id);
                if (first) first.focus();
                return;
            }
            const data = new FormData(form);
            const body = {};
            ['name', 'email', 'organisation', 'message', 'website'].forEach(function (field) {
                body[field] = String(data.get(field) || '');
            });

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
                    return;
                }
                if (!payload || payload.received !== true) {
                    status.textContent = 'We could not confirm your enquiry was sent. ' + FALLBACK;
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
        } finally {
            submitting = false;
            send.disabled = !available;
        }
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
    if (!submitting) send.disabled = !available;
    if (!available && !submitting) {
        status.textContent = 'The enquiry form is not available right now. ' + FALLBACK;
        // Say so above the fields too, so nobody writes a message they cannot send.
        const notice = document.getElementById('contact-unavailable');
        if (notice) notice.hidden = false;
    }
}());
