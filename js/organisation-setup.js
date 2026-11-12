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
    const signInRecovery = recoveries.length === 1 && ['retry', 'expired', 'account'].includes(recoveries[0])
        ? recoveries[0] : undefined;
    // Support references are display-only (NF- plus six characters); anything else is dropped.
    const references = query ? query.getAll('ref') : [];
    const supportReference = signInRecovery && references.length === 1 && /^NF-[A-Z2-9]{6}$/.test(references[0]) ? references[0] : '';
    const recoverySuffix = signInRecovery ? '&signin=' + signInRecovery + (supportReference ? '&ref=' + supportReference : '') : '';
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
    if (defaultEntry && entryIntent === 'create') {
        byId('organisation-title').textContent = 'Create your account';
        byId('organisation-intro').textContent = 'Create an account with your email and password. You will continue to Microsoft’s secure sign-in, then choose Company or Consultant and set up your organisation.';
    } else if (defaultEntry && entryIntent === 'login') {
        byId('organisation-title').textContent = 'Log in to No Fries';
        byId('organisation-intro').textContent = 'Sign in with your existing email and password. You will continue to Microsoft’s secure sign-in and return to your saved work.';
    }
    const setupRoute = externalCustomer ? '/api/external-organisation-setup/' : '/api/organisation-setup/';
    const codeForm = byId('organisation-code-form'), profileForm = byId('organisation-profile-form');
    const detailsForm = byId('organisation-details-form'), status = byId('organisation-status');
    let current = { state: 'start' }, selectedType = null, requestId = null, initialReadFailed = false, rendered = false;
    let busy = false, sequence = 0, disposed = false, controller;
    let emailRecord = null, returningAvailable = false, step = null, localAccountHistory = false;
    const fieldErrors = new Map();
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
    const fields = {
        'organisation-email': { form, label: 'Email address', error: 'Enter a valid email address.', valid: value => value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) },
        'organisation-code': { form: codeForm, label: 'Verification code', error: 'Enter the 8 digits from the email.', valid: value => /^[0-9]{8}$/.test(value) },
        'organisation-name': { form: profileForm, label: 'Organisation name', maximum: 120 },
        'representative-name': { form: detailsForm, label: 'Your full name', maximum: 160 },
        'representative-role': { form: detailsForm, label: 'Your role', maximum: 120 },
        'representative-address': { form: detailsForm, label: 'Business address', maximum: 500 },
        'representative-registration': { form: detailsForm, label: 'NZBN', error: 'Enter the 13 digits of your NZBN, or leave it empty.', valid: value => !value || /^[0-9]{13}$/.test(value) },
        'representative-authority': { form: detailsForm, label: 'Permission to set up this account', error: messages.starter_authority_required, valid: () => byId('representative-authority').checked }
    };
    const normalizeCode = () => { const input = byId('organisation-code'); input.value = input.value.replace(/[\s-]/g, ''); };
    function updateErrors() {
        const summary = byId('organisation-errors');
        summary.replaceChildren(); summary.hidden = fieldErrors.size === 0;
        if (!fieldErrors.size) return;
        const title = document.createElement('p'); title.textContent = 'Please check these details:'; summary.append(title);
        const list = document.createElement('ul');
        for (const [id, message] of fieldErrors) {
            const item = document.createElement('li'), link = document.createElement('a');
            link.href = '#' + id; link.textContent = message;
            link.addEventListener('click', event => { event.preventDefault(); byId(id).focus(); });
            item.append(link); list.append(item);
        }
        summary.append(list);
    }
    function fieldError(id, message) {
        const input = byId(id), error = byId(id + '-error');
        const described = (input.getAttribute('aria-describedby') || '').split(/\s+/).filter(value => value && value !== id + '-error');
        error.textContent = message || ''; error.hidden = !message;
        if (message) { fieldErrors.set(id, message); input.setAttribute('aria-invalid', 'true'); described.push(id + '-error'); }
        else { fieldErrors.delete(id); input.removeAttribute('aria-invalid'); }
        if (described.length) input.setAttribute('aria-describedby', described.join(' ')); else input.removeAttribute('aria-describedby');
    }
    function clearErrors() { for (const id of fieldErrors.keys()) fieldError(id, ''); updateErrors(); }
    function validationMessage(id) {
        const spec = fields[id], value = byId(id).value.trim().normalize('NFC');
        if (spec.valid) return spec.valid(value) ? '' : spec.error;
        if (!value) return 'Enter ' + spec.label.toLowerCase() + '.';
        if (value.length > spec.maximum) return spec.label + ' must be ' + spec.maximum + ' characters or fewer.';
        if (/[\u0000-\u001f\u007f-\u009f<>]/u.test(value)) return spec.label + ': remove <, > and hidden control characters.';
        return '';
    }
    function validateForm(target) {
        if (busy || navigating || !ready || target.hidden) return false;
        clearErrors();
        for (const [id, spec] of Object.entries(fields)) if (spec.form === target) fieldError(id, validationMessage(id));
        updateErrors();
        if (fieldErrors.size) byId(fieldErrors.keys().next().value).focus();
        return fieldErrors.size === 0;
    }
    function rememberAccountChoice(type, push = false) {
        const history = window.history;
        if (!history?.replaceState || push && !history.pushState) return;
        history[push ? 'pushState' : 'replaceState']({ noFriesSetupView: type || 'choose' }, '');
        localAccountHistory = true;
    }
    function focusHeading() {
        const heading = byId('organisation-title'); heading.focus({ preventScroll: true }); heading.scrollIntoView?.({ block: 'start', behavior: 'instant' });
    }
    function setBusy(value) {
        busy = value;
        for (const item of [form, codeForm, profileForm, detailsForm]) item.setAttribute('aria-busy', String(value));
        for (const control of document.querySelectorAll('#create-organisation input, #create-organisation button')) {
            control.disabled = value || navigating || !ready && control !== byId('organisation-refresh');
        }
        if (current.state === 'awaiting_code' && (current.attemptsExhausted || current.codeExpired)) {
            byId('organisation-code').disabled = true; byId('organisation-verify').disabled = true;
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
        if (nextId !== requestId) localAccountHistory = false;
        if (emailRecord && emailRecord.requestId !== nextId) emailRecord = null;
        requestId = nextId; current = value; rendered = true;
        const nextStep = value.state + ':' + (value.nextStep || '') + ':' + (selectedType || '');
        const stepChanged = step !== nextStep; step = nextStep;
        if (stepChanged) clearErrors();
        if (value.accountType) selectedType = value.accountType;
        const choosing = value.state === 'verified' && value.nextStep === 'choose_account';
        if (choosing && !localAccountHistory) rememberAccountChoice(selectedType);
        const details = value.state === 'verified' && value.nextStep === 'details_required';
        const continuing = legacySignIn || value.state === 'verified' && ['account_found', 'check_invitation', 'secure_sign_in'].includes(value.nextStep);
        form.hidden = value.state !== 'start'; codeForm.hidden = value.state !== 'awaiting_code';
        byId('organisation-choice').hidden = !choosing || selectedType !== null;
        profileForm.hidden = !choosing || selectedType === null; detailsForm.hidden = !details;
        byId('organisation-verified').hidden = !legacySignIn && (value.state !== 'verified' || choosing || details);
        byId('organisation-verified-title').textContent = legacySignIn ? 'Continue to your account' : 'Email verified';
        byId('organisation-continue').hidden = !continuing;
        byId('organisation-switch').hidden = ['start', 'sign_in'].includes(value.state);
        const steps = byId('organisation-steps');
        if (steps) steps.hidden = false;
        byId('organisation-title').textContent = choosing ? selectedType ? selectedType === 'consultant' ? 'Name your consultancy' : 'Name your organisation' : 'How will you use No Fries?' : value.state === 'awaiting_code' ? 'Check your inbox' : details ? 'Your account details' : continuing ? 'Welcome back to No Fries' : entryIntent === 'create' ? 'Create your account' : 'Sign up / Sign in';
        byId('organisation-intro').textContent = legacySignIn ? 'Use the email address associated with your existing account.' : choosing ? selectedType ? 'Email verified. You chose ' + (selectedType === 'consultant' ? 'Consultant' : 'Company') + '. Add the name for this organisation.' : 'Email verified. Choose the account that fits you.' : details ? 'Add the person and business details for your dashboard agreement.' : continuing ? 'Your saved account is ready to continue.' : value.state === 'awaiting_code' ? 'Enter the 8 digits we emailed you to confirm this address.' : 'New here or coming back, start with your email.';
        byId('organisation-name-label').textContent = selectedType === 'consultant' ? 'Your name or consultancy' : 'Organisation name';
        if (legacySignIn) {
            byId('organisation-verified-name').textContent = '';
            status.textContent = 'Continue secure sign-in to return to your account. Your saved work is kept.';
        } else if (value.state === 'awaiting_code') {
            byId('organisation-email-hint').textContent = 'Check ' + (emailRecord?.email || value.emailHint) + ' for your code.';
            status.textContent = value.delivery === 'unconfirmed' ? 'Delivery could not be confirmed. If a code arrives, enter it here; otherwise request a new code.' : value.codeExpired ? messages.verification_code_expired : value.attemptsExhausted ? messages.verification_attempts_exhausted : 'Enter the code to verify your email.';
        } else if (value.state === 'verified') {
            byId('organisation-verified-name').textContent = value.organisationName ? (selectedType === 'consultant' ? 'Consultancy: ' : 'Organisation: ') + value.organisationName : '';
            status.textContent = choosing ? '' : details ? 'Your email is verified.' : verificationOnly ? 'Your email is verified and your organisation details are saved. Account access has not been activated.' : continuing ? 'Continue secure sign-in to open your existing account or finish activation. Your saved work is kept.' : value.nextStep === 'setup_review_required' ? 'Your details are saved. Invitation delivery could not be confirmed and needs review. Your signup has not been reset or resent.' : 'Your saved setup is waiting for activation. Your account and saved details are kept.';
        } else status.textContent = signInRecovery === 'expired'
            ? 'This sign-in attempt has expired or is no longer valid. Start secure sign-in again with the same email. Your saved work is kept.'
            : signInRecovery === 'account'
            ? 'Your sign-in worked, but your No Fries account is not active. Email hello@nofries.nz' + (supportReference ? ' and quote ' + supportReference : '') + ' so we can restore access. Your saved work is kept.'
            : signInRecovery === 'retry'
            ? 'Sign-in did not finish. Try secure sign-in again, or verify the same email to recover access. Your saved work is kept.' : '';
        byId('organisation-returning').hidden = !returningAvailable || value.state === 'verified' || legacySignIn;
        const returningLink = byId('organisation-returning-sign-in');
        returningLink.className = entryIntent === 'create' || value.state === 'awaiting_code' ? 'text-link' : 'button';
        byId('organisation-details-summary').textContent = details
            ? (selectedType === 'consultant' ? 'Consultant' : 'Company') + ' · ' + value.organisationName + (emailRecord ? ' · ' + emailRecord.email : '') : '';
        // Organisation setup happens after Microsoft sign-in, on the signup page.
        const activeStep = value.state === 'start' ? 'email' : value.state === 'awaiting_code' ? 'code'
            : choosing || details ? 'account' : 'signin';
        for (const name of ['email', 'code', 'account', 'signin', 'organisation']) {
            const item = byId('organisation-step-' + name);
            if (name === activeStep) item.setAttribute('aria-current', 'step'); else item.removeAttribute('aria-current');
        }
        byId('organisation-name-count').textContent = byId('organisation-name').value.length + ' of 120 characters';
        if (value.state === 'verified' && !choosing && !details && !continuing) {
            byId('organisation-title').textContent = value.nextStep === 'setup_review_required' ? 'Your setup needs a check' : 'Your setup is saved';
            byId('organisation-intro').textContent = 'Email verified. Check the setup status below for your next step.';
        }
        if (value.nextStep === 'secure_sign_in') {
            byId('organisation-title').textContent = 'Continue secure sign-in';
            byId('organisation-intro').textContent = 'Create your password or sign in with your verified email.';
            status.textContent = 'Your details are saved. Continue secure sign-in, then review your agreement before opening your Dashboard.';
        }
        return stepChanged;
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
            const signInAvailable = response.headers.get('x-nofries-customer-sign-in') === 'available';
            // A known provider may retain returning sign-in during setup failure.
            // Availability alone cannot resolve an automatic provider choice.
            if (stateRead && entryChosen) byId('organisation-returning').hidden = !signInAvailable;
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
                    if (entry === 'legacy' && !signInAvailable) throw new Error('setup_unavailable');
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
                if (entryIntent === 'login' && signInAvailable) {
                    navigating = true; hideLegacyEntry();
                    window.location.replace('/signup?provider=legacy&intent=login'); return;
                }
                entryChosen = true;
            }
            if (stateRead) { ready = true; returningAvailable = signInAvailable; byId('organisation-returning').hidden = !signInAvailable; }
            if (route === 'request' && body) emailRecord = { requestId: value.requestId, email: body.email.trim() };
            if (render(value) || body) focus = byId('organisation-title');
            if (body?.action === 'leave') {
                form.reset(); byId('organisation-verified-name').textContent = ''; byId('organisation-email-hint').textContent = '';
                status.textContent = 'Any previous signup and saved account are kept.';
            }
        } catch (error) {
            if (error.message === 'verification_attempts_exhausted') current = { ...current, attemptsExhausted: true };
            if (error.message === 'verification_code_expired') current = { ...current, codeExpired: true };
            const invalidField = { work_email_invalid: 'organisation-email', verification_code_invalid: 'organisation-code',
                organisation_name_invalid: 'organisation-name', starter_authority_required: 'representative-authority' }[error.message];
            if (!disposed && serial === sequence && invalidField) {
                fieldError(invalidField, messages[error.message]); updateErrors(); focus = byId(invalidField);
            }
            if (!disposed && serial === sequence && error.message === 'starter_details_invalid') {
                for (const id of ['representative-name', 'representative-role', 'representative-address']) {
                    fieldError(id, validationMessage(id) || 'Check ' + fields[id].label.toLowerCase() + '.');
                }
                updateErrors(); focus = byId('representative-name');
            }

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
            if (!disposed && serial === sequence) { setBusy(false); if (focus === byId('organisation-title')) focusHeading(); else if (focus) focus.focus(); }
        }
    }
    form.addEventListener('submit', event => { event.preventDefault(); if (validateForm(form)) request('request', { email: byId('organisation-email').value }); });
    codeForm.addEventListener('submit', event => { event.preventDefault(); normalizeCode(); if (!byId('organisation-code').disabled && validateForm(codeForm)) request('verify', { code: byId('organisation-code').value.trim() }); });
    profileForm.addEventListener('submit', event => { event.preventDefault(); if (selectedType && validateForm(profileForm)) request('choose', { accountType: selectedType, organisationName: byId('organisation-name').value }); });
    detailsForm.addEventListener('submit', event => {
        event.preventDefault(); if (!validateForm(detailsForm)) return;
        request('details', { name: byId('representative-name').value, role: byId('representative-role').value,
            address: byId('representative-address').value, registrationId: byId('representative-registration').value,
            authorityConfirmed: byId('representative-authority').checked });
    });
    for (const type of ['company', 'consultant']) byId('organisation-' + type).addEventListener('click', () => {
        if (busy || navigating || !ready || current.nextStep !== 'choose_account') return;
        rememberAccountChoice(type, true); selectedType = type; render(current); focusHeading();
    });
    byId('organisation-back').addEventListener('click', () => {
        if (busy || !ready || navigating) return;
        if (localAccountHistory && window.history.back) window.history.back();
        else { selectedType = null; render(current); focusHeading(); }
    });
    byId('organisation-restart').addEventListener('click', () => {
        if (busy || !ready || navigating) return;
        if (emailRecord) request('request', { email: emailRecord.email });
        else { render({ state: 'start' }); byId('organisation-intro').textContent = 'Enter your email again so we can send a new code.'; focusHeading(); }
    });
    byId('organisation-refresh').textContent = 'Check progress';
    byId('organisation-refresh').addEventListener('click', () => request('state'));
    byId('organisation-leave').addEventListener('click', () => request('state', { action: 'leave' }));
    for (const [id] of Object.entries(fields)) {
        const input = byId(id);
        const correct = () => {
            if (id === 'organisation-code') normalizeCode();
            if (id === 'organisation-name') byId('organisation-name-count').textContent = input.value.length + ' of 120 characters';
            if (fieldErrors.has(id)) { fieldError(id, validationMessage(id)); updateErrors(); if (!fieldErrors.size) status.textContent = ''; }
        };
        input.addEventListener('input', correct); input.addEventListener('change', correct);
    }
    window.addEventListener('popstate', event => {
        if (!localAccountHistory || busy || navigating || !ready || current.state !== 'verified' || current.nextStep !== 'choose_account') return;
        const choice = event.state?.noFriesSetupView;
        if (!['choose', 'company', 'consultant'].includes(choice)) return;
        selectedType = choice === 'choose' ? null : choice; render(current); focusHeading();
    });
    window.addEventListener('beforeunload', event => {
        const unsavedName = !profileForm.hidden && byId('organisation-name').value.trim();
        const unsavedDetails = !detailsForm.hidden && ['representative-name', 'representative-role', 'representative-address', 'representative-registration']
            .some(id => byId(id).value.trim());
        if (unsavedName || unsavedDetails) { event.preventDefault(); event.returnValue = ''; }
    });
    window.addEventListener('keydown', event => {
        if (event.key === 'Enter' && event.repeat) event.preventDefault();
    }, true);
    window.addEventListener('pagehide', () => { disposed = true; sequence++; if (defaultEntry) ready = false; byId('organisation-code').value = ''; if (controller) controller.abort(); });
    window.addEventListener('pageshow', event => { if (event.persisted) { disposed = false; navigating = false; setBusy(false); request('state'); } });
    request('state');
}());
