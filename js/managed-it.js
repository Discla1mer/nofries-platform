(function () {
    if (document.body.dataset.page !== 'managed-it') {
        return;
    }

    const requestForm = document.getElementById('scope-request-form');
    const codeForm = document.getElementById('scope-code-form');
    const emailInput = document.getElementById('scope-email');
    const websiteInput = document.getElementById('company-website');
    const codeInput = document.getElementById('scope-code');
    const emailHint = document.getElementById('scope-email-hint');
    const status = document.getElementById('scope-form-status');
    const differentEmailButton = document.getElementById('use-different-email');
    const storageKey = 'nofriesScopeChallenge';
    let challenge = readChallenge();

    if (!requestForm || !codeForm || !emailInput || !codeInput || !status) {
        return;
    }

    if (challenge && challenge.id && challenge.emailHint) {
        showCodeStep(challenge.emailHint);
    }

    requestForm.addEventListener('submit', requestCode);
    codeForm.addEventListener('submit', verifyCode);
    differentEmailButton.addEventListener('click', resetForm);

    async function requestCode(event) {
        event.preventDefault();
        clearStatus();

        if (!requestForm.reportValidity()) {
            return;
        }

        const submitButton = requestForm.querySelector('button[type="submit"]');
        setBusy(submitButton, true, 'Sending…');

        try {
            const response = await fetch('/api/scope/request', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    email: emailInput.value.trim(),
                    website: websiteInput ? websiteInput.value : ''
                })
            });
            const payload = await readJson(response);
            if (!response.ok) {
                throw new Error(payload.error || 'We could not send the verification email.');
            }

            challenge = {
                id: payload.challengeId,
                emailHint: payload.emailHint,
                expiresAt: Date.now() + ((payload.expiresInMinutes || 15) * 60 * 1000)
            };
            sessionStorage.setItem(storageKey, JSON.stringify(challenge));
            showCodeStep(payload.emailHint);
            setStatus('The email is on its way. The code expires in 15 minutes.', 'success');
            codeInput.focus();
        } catch (error) {
            setStatus(error.message || 'We could not send the verification email. Please try again.', 'error');
        } finally {
            setBusy(submitButton, false, 'Send code');
        }
    }

    async function verifyCode(event) {
        event.preventDefault();
        clearStatus();

        if (!challenge || !challenge.id) {
            resetForm();
            setStatus('Please request a new code.', 'error');
            return;
        }
        if (!codeForm.reportValidity()) {
            return;
        }

        const submitButton = codeForm.querySelector('button[type="submit"]');
        setBusy(submitButton, true, 'Checking…');

        try {
            const response = await fetch('/api/scope/verify', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    challengeId: challenge.id,
                    code: codeInput.value.replace(/\D/g, '')
                })
            });
            const payload = await readJson(response);
            if (!response.ok) {
                throw new Error(payload.error || 'That code could not be confirmed.');
            }

            sessionStorage.removeItem(storageKey);
            window.location.assign('/scope.html');
        } catch (error) {
            setStatus(error.message || 'That code could not be confirmed. Please check it and try again.', 'error');
            codeInput.select();
        } finally {
            setBusy(submitButton, false, 'Confirm and view service guide');
        }
    }

    function showCodeStep(hint) {
        requestForm.classList.add('is-hidden');
        codeForm.classList.remove('is-hidden');
        emailHint.textContent = hint || 'your address';
    }

    function resetForm() {
        challenge = null;
        sessionStorage.removeItem(storageKey);
        codeForm.reset();
        codeForm.classList.add('is-hidden');
        requestForm.classList.remove('is-hidden');
        clearStatus();
        emailInput.focus();
    }

    function readChallenge() {
        try {
            const value = JSON.parse(sessionStorage.getItem(storageKey));
            if (!value || !value.id || !value.expiresAt || value.expiresAt <= Date.now()) {
                sessionStorage.removeItem(storageKey);
                return null;
            }
            return value;
        } catch (error) {
            sessionStorage.removeItem(storageKey);
            return null;
        }
    }

    function setBusy(button, busy, label) {
        if (!button) return;
        button.disabled = busy;
        button.setAttribute('aria-busy', busy ? 'true' : 'false');
        button.textContent = label;
    }

    function setStatus(message, type) {
        status.textContent = message;
        status.className = `form-status ${type ? `form-status-${type}` : ''}`.trim();
    }

    function clearStatus() {
        setStatus('', '');
    }

    async function readJson(response) {
        try {
            return await response.json();
        } catch (error) {
            return {};
        }
    }
}());
