(function () {
    'use strict';
    const byId = id => document.getElementById(id);
    const form = byId('organisation-form');
    if (!form) return;
    const query = window.location?.search ? new URLSearchParams(window.location.search) : null;
    const providers = query ? query.getAll('provider') : [];
    const reauthentications = query ? query.getAll('reauthenticate') : [];
    const reauthenticate = reauthentications.length === 1 && reauthentications[0] === '1';
    if ((reauthentications.length && !reauthenticate) || (reauthenticate && window.location.hash)) {
        window.location.replace('/signup?provider=invalid'); return;
    }
    const recoveries = query ? query.getAll('signin') : [];
    const signInRecovery = recoveries.length === 1 && ['retry', 'expired'].includes(recoveries[0])
        ? recoveries[0] : undefined;
    const recoverySuffix = signInRecovery ? '&signin=' + signInRecovery : '';
    const accounts = query ? query.getAll('account') : [];
    const accountSuffix = accounts.length === 1 && accounts[0] === 'choose' ? '&account=choose' : '';
    const intents = query ? query.getAll('intent') : [];
    const entryIntent = intents.length === 1 && ['login', 'create'].includes(intents[0]) &&
        !recoveries.length && !accounts.length && !reauthentications.length && !window.location.hash ? intents[0] : undefined;
    const intentSuffix = entryIntent ? '&intent=' + entryIntent : '';
    if (providers.length > 1 || providers.length === 1 && providers[0] !== 'legacy') {
        // A managed signup never starts the separate legacy email-code flow.
        // Only fixed local destinations are possible; fragments are not relayed.
        window.location.replace(providers.length === 1 && providers[0] === 'external' && !window.location.hash
            ? reauthenticate ? '/api/external-customer-auth/login' : '/signup?provider=external' + recoverySuffix + accountSuffix + intentSuffix
            : '/signup?provider=invalid');
        return;
    }
    const externalCustomer = document.body?.dataset?.customerProvider === 'external';
    if (reauthenticate && (providers.length === 1 || externalCustomer)) {
        window.location.replace(providers.length === 1 ? '/api/customer-auth/login' : '/api/external-customer-auth/login'); return;
    }
    if (entryIntent && (externalCustomer || providers[0] === 'legacy' && entryIntent === 'login')) {
        window.location.replace('/signup?provider=' + (externalCustomer ? 'external' : 'legacy') + intentSuffix); return;
    }
    const defaultEntry = providers.length === 0 && !externalCustomer;
    const setupRoute = externalCustomer ? '/api/external-organisation-setup/' : '/api/organisation-setup/';
    const codeForm = byId('organisation-code-form'), profileForm = byId('organisation-profile-form');
    const detailsForm = byId('organisation-details-form'), status = byId('organisation-status');
    let current = { state: 'start' }, selectedType = null, requestId = null, initialReadFailed = false, rendered = false;
    let busy = false, sequence = 0, disposed = false, controller;
    let entryChosen = !defaultEntry, ready = !defaultEntry, navigating = false;
    const messages = {
        work_email_invalid: 'Enter a valid email address.',
        account_type_invalid: 'Choose Company or Consultant.',
        organisation_name_invalid: 'Enter your organisation’s name, using up to 120 characters.',
        verification_code_invalid: 'That code is not correct. Check the eight digits and try again.',
        verification_code_expired: 'That code has expired. Request a new code.',
        verification_attempts_exhausted: 'Too many attempts. Request a new code.',
        setup_rate_limited: 'The verification limit has been reached. Please try again later.',
        setup_expired: 'This verification session has expired. Enter your email again; your saved account is kept.',
        setup_session_required: 'Use the browser where you requested the code, or verify your email again.',
        setup_verification_required: 'Verify your email before continuing.',
        setup_changed: 'Setup changed in another tab. Use Check progress to refresh.',
        starter_account_exists: 'Your email already has an account. Use Check progress to continue to it.',
        starter_details_invalid: 'Check your name, role and organisation address.',
        starter_authority_required: 'Confirm that you are authorised to set up this organisation.',
        starter_details_locked: 'Your details are already saved. Use Check progress to continue.',
        setup_origin_invalid: 'Reload this page at https://nofries.nz and try again.',
        setup_input_invalid: 'Check your details and reload this page before trying again.',
        setup_unavailable: 'We could not confirm your progress. Use Check progress before trying again.'
    };
    function setBusy(value) {
        busy = value;
        for (const item of [form, codeForm, profileForm, detailsForm]) item.setAttribute('aria-busy', String(value));
        for (const control of document.querySelectorAll('#create-organisation input, #create-organisation button')) {
            control.disabled = value || navigating || !ready && control !== byId('organisation-refresh');
        }
    }
    function hideLegacyEntry() {
        for (const item of [form, codeForm, profileForm, detailsForm, byId('organisation-choice'),
            byId('organisation-verified'), byId('organisation-returning'), byId('organisation-switch')]) item.hidden = true;
    }
    function validateState(value) {
        if (!value || !['start', 'sign_in', 'awaiting_code', 'verified'].includes(value.state)) throw new Error('setup_unavailable');
        const legacySignIn = value.state === 'sign_in';
        if (legacySignIn && Object.keys(value).join(',') !== 'state') throw new Error('setup_unavailable');
        if (!['start', 'sign_in'].includes(value.state) && !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.requestId)) throw new Error('setup_unavailable');
        if (value.state === 'awaiting_code' && (typeof value.emailHint !== 'string' || value.emailHint.length > 254)) throw new Error('setup_unavailable');
        const verificationOnly = value.state === 'verified' && !Object.hasOwn(value, 'nextStep');
        if (value.state === 'verified' && (value.accessGranted !== false || !verificationOnly && !['choose_account', 'account_found', 'details_required', 'check_invitation', 'pending_activation', 'setup_review_required', 'secure_sign_in'].includes(value.nextStep))) throw new Error('setup_unavailable');
        if (verificationOnly && !['company', 'consultant'].includes(value.accountType)) throw new Error('setup_unavailable');
        if (value.state === 'verified' && value.nextStep !== 'choose_account' && (typeof value.organisationName !== 'string' || value.organisationName.length > 120)) throw new Error('setup_unavailable');
        if (!['start', 'sign_in'].includes(value.state) && value.accountType !== null && !['company', 'consultant'].includes(value.accountType)) throw new Error('setup_unavailable');
        return { legacySignIn, verificationOnly };
    }
    function render(value) {
        const { legacySignIn, verificationOnly } = validateState(value);
        const nextId = ['start', 'sign_in'].includes(value.state) ? null : value.requestId;
        if (nextId !== requestId || !rendered && !initialReadFailed) {
            selectedType = null; detailsForm.reset(); profileForm.reset(); byId('organisation-code').value = '';
            if (value.state === 'start') form.reset();
        }
        requestId = nextId; current = value; rendered = true;
        if (value.accountType) selectedType = value.accountType;
        const choosing = value.state === 'verified' && value.nextStep === 'choose_account';
        const details = value.state === 'verified' && value.nextStep === 'details_required';
        const continuing = legacySignIn || value.state === 'verified' && ['account_found', 'check_invitation', 'secure_sign_in'].includes(value.nextStep);
        form.hidden = value.state !== 'start'; codeForm.hidden = value.state !== 'awaiting_code';
        byId('organisation-choice').hidden = !choosing || selectedType !== null;
        profileForm.hidden = !choosing || selectedType === null; detailsForm.hidden = !details;
        byId('organisation-verified').hidden = !legacySignIn && (value.state !== 'verified' || choosing || details);
        byId('organisation-verified-title').textContent = legacySignIn ? 'Continue to your account' : 'Email verified';
        byId('organisation-continue').hidden = !continuing;
        byId('organisation-switch').hidden = ['start', 'sign_in'].includes(value.state);
        byId('organisation-title').textContent = choosing ? 'How will you use No Fries?' : value.state === 'awaiting_code' ? 'Check your inbox' : details ? 'Your account details' : continuing ? 'Welcome back to No Fries' : 'Sign up / Sign in';
        byId('organisation-intro').textContent = legacySignIn ? 'Use the email address associated with your existing account.' : choosing ? 'Email verified. Choose the account that fits you.' : details ? 'Complete your organisation’s representative details.' : continuing ? 'Your saved account is ready to continue.' : 'Enter your email to create an account or recover access.';
        byId('organisation-name-label').textContent = selectedType === 'consultant' ? 'Your name or consultancy' : 'Organisation name';
        if (legacySignIn) {
            byId('organisation-verified-name').textContent = '';
            status.textContent = 'Continue secure sign-in to return to your account. Your saved work is kept.';
        } else if (value.state === 'awaiting_code') {
            byId('organisation-email-hint').textContent = 'Check ' + value.emailHint + ' for your code.';
            status.textContent = value.delivery === 'unconfirmed' ? 'Delivery could not be confirmed. If a code arrives, enter it here; otherwise request a new code.' : value.codeExpired ? messages.verification_code_expired : value.attemptsExhausted ? messages.verification_attempts_exhausted : 'Enter the code to verify your email.';
        } else if (value.state === 'verified') {
            byId('organisation-verified-name').textContent = value.organisationName ? (selectedType === 'consultant' ? 'Consultant workspace: ' : 'Organisation: ') + value.organisationName : '';
            status.textContent = choosing ? '' : details ? 'Your email is verified.' : verificationOnly ? 'Your email is verified and your organisation details are saved. Account access has not been activated.' : continuing ? 'Continue secure sign-in to open your existing account or finish activation. Your saved work is kept.' : value.nextStep === 'setup_review_required' ? 'Your details are saved. Invitation delivery could not be confirmed and needs review. Your signup has not been reset or resent.' : 'Your saved setup is waiting for activation. Your account and saved details are kept.';
        } else status.textContent = signInRecovery === 'expired'
            ? 'This sign-in attempt has expired or is no longer valid. Start secure sign-in again with the same email. Your saved work is kept.'
            : signInRecovery === 'retry'
            ? 'Sign-in did not finish. Try secure sign-in again, or verify the same email to recover access. Your saved work is kept.' : '';
        if (value.nextStep === 'secure_sign_in') {
            byId('organisation-title').textContent = 'Continue secure sign-in';
            byId('organisation-intro').textContent = 'Create your password or sign in with your verified email.';
            status.textContent = 'Your details are saved. Continue secure sign-in, then review your agreement before opening your workspace.';
        }
    }
    async function request(route, body) {
        if (busy || disposed || navigating || body && !ready) return;
        const stateRead = route === 'state' && !body;
        const automaticEntry = defaultEntry && !entryChosen && stateRead;
        if (defaultEntry && stateRead) ready = false;
        if (automaticEntry) hideLegacyEntry();
        setBusy(true); const serial = ++sequence; let focus = null;
        controller = new AbortController(); const timer = window.setTimeout(() => controller.abort(), 20000);
        try {
            const response = await fetch(setupRoute + route, {
                method: body ? 'POST' : 'GET', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store',
                referrerPolicy: 'same-origin', signal: controller.signal,
                headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}),
                    ...(automaticEntry ? { 'X-NoFries-Customer-Entry': 'auto' } : {}),
                    ...(body && route !== 'request' && requestId ? { 'X-NoFries-Setup-Request': requestId } : {}) },
                ...(body ? { body: JSON.stringify(body) } : {})
            });
            if (disposed || serial !== sequence) return;
            if (response.redirected || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) throw new Error('setup_unavailable');
            const returningAvailable = response.headers.get('x-nofries-customer-sign-in') === 'available';
            // A known provider may retain returning sign-in during setup failure.
            // Availability alone cannot resolve an automatic provider choice.
            if (stateRead && entryChosen) byId('organisation-returning').hidden = !returningAvailable;
            const text = await response.text(); if (text.length > 4096) throw new Error('setup_unavailable');
            const value = JSON.parse(text);
            if (disposed || serial !== sequence) return;
            if (!response.ok) throw new Error(Object.hasOwn(messages, value.code) ? value.code : 'setup_unavailable');
            if (body?.action === 'leave' && value.state !== 'start') throw new Error('setup_unavailable');
            validateState(value);
            if (automaticEntry) {
                const entry = response.headers.get('x-nofries-customer-entry');
                if (!['legacy', 'external'].includes(entry)) throw new Error('setup_unavailable');
                if (reauthenticate) {
                    if (entry === 'legacy' && !returningAvailable) throw new Error('setup_unavailable');
                    navigating = true; hideLegacyEntry();
                    window.location.replace(entry === 'external' ? '/api/external-customer-auth/login' : '/api/customer-auth/login');
                    return;
                }
                if (entry === 'external') {
                    navigating = true;
                    hideLegacyEntry();
                    status.textContent = 'Opening secure sign-in…';
                    window.location.replace(window.location.hash ? '/signup?provider=invalid' : '/signup?provider=external' + recoverySuffix + intentSuffix);
                    return;
                }
                if (entryIntent === 'login' && returningAvailable) {
                    navigating = true; hideLegacyEntry();
                    window.location.replace('/signup?provider=legacy&intent=login'); return;
                }
                entryChosen = true;
            }
            if (stateRead) { ready = true; byId('organisation-returning').hidden = !returningAvailable; }
            render(value);
            if (body?.action === 'leave') {
                form.reset(); byId('organisation-verified-name').textContent = ''; byId('organisation-email-hint').textContent = '';
                status.textContent = 'Your previous signup and saved account are kept.'; focus = byId('organisation-email');
            } else if (route === 'request') focus = byId('organisation-code');
            else if (route === 'verify' && value.nextStep === 'choose_account') focus = byId('organisation-company');
            else if (route === 'choose' && value.nextStep === 'details_required') focus = byId('representative-name');
        } catch (error) {
            if (!rendered) initialReadFailed = true;
            if (!disposed && serial === sequence) status.textContent = body?.action === 'leave' && error.message === 'setup_changed'
                ? 'This browser is now linked to another setup. Use Check progress before leaving it.'
                : body?.action === 'leave'
                ? 'Leaving could not be confirmed. Your records are kept. Use Check progress before trying again.'
                : route === 'details' && (!Object.hasOwn(messages, error.message) || error.message === 'setup_unavailable')
                ? 'Your email was verified, but account setup could not be confirmed. Check your inbox, then use Check progress before retrying.'
                : error.name === 'AbortError' ? 'The request could not be confirmed. Use Check progress before requesting another code.' : messages[error.message] || messages.setup_unavailable;
        } finally {
            window.clearTimeout(timer);
            if (!disposed && serial === sequence) { setBusy(false); if (focus) focus.focus(); }
        }
    }
    form.addEventListener('submit', event => { event.preventDefault(); if (form.reportValidity()) request('request', { email: byId('organisation-email').value }); });
    codeForm.addEventListener('submit', event => { event.preventDefault(); if (codeForm.reportValidity()) request('verify', { code: byId('organisation-code').value.trim() }); });
    profileForm.addEventListener('submit', event => { event.preventDefault(); if (selectedType && profileForm.reportValidity()) request('choose', { accountType: selectedType, organisationName: byId('organisation-name').value }); });
    detailsForm.addEventListener('submit', event => {
        event.preventDefault(); if (!detailsForm.reportValidity()) return;
        request('details', { name: byId('representative-name').value, role: byId('representative-role').value,
            address: byId('representative-address').value, registrationId: byId('representative-registration').value,
            authorityConfirmed: byId('representative-authority').checked });
    });
    for (const type of ['company', 'consultant']) byId('organisation-' + type).addEventListener('click', () => {
        if (busy || navigating || !ready || current.nextStep !== 'choose_account') return;
        selectedType = type; render(current); byId('organisation-name').focus();
    });
    byId('organisation-back').addEventListener('click', () => { if (!busy && ready && !navigating) { selectedType = null; render(current); byId('organisation-company').focus(); } });
    byId('organisation-restart').addEventListener('click', () => { if (!busy && ready && !navigating) { render({ state: 'start' }); byId('organisation-email').focus(); } });
    byId('organisation-refresh').textContent = 'Check progress';
    byId('organisation-refresh').addEventListener('click', () => request('state'));
    byId('organisation-leave').addEventListener('click', () => request('state', { action: 'leave' }));
    window.addEventListener('pagehide', () => { disposed = true; sequence++; if (defaultEntry) ready = false; byId('organisation-code').value = ''; if (controller) controller.abort(); });
    window.addEventListener('pageshow', event => { if (event.persisted) { disposed = false; navigating = false; setBusy(false); request('state'); } });
    request('state');
}());
