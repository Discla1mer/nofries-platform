'use strict';

// Unmounted view. The client is supplied by the reviewed same-origin signup
// transport; this component neither stores credentials nor grants access.
function mountSignupJourney(root, client, { customerTransport, signInRecovery, chooseAccount = false, entryIntent } = {}) {
    if (customerTransport !== undefined && customerTransport !== 'external') throw new TypeError('signup_view_transport_invalid');
    if (signInRecovery !== undefined && !['retry', 'expired'].includes(signInRecovery)) throw new TypeError('signup_view_recovery_invalid');
    if (typeof chooseAccount !== 'boolean' || chooseAccount && !customerTransport) throw new TypeError('signup_view_account_choice_invalid');
    if (entryIntent !== undefined && !['login', 'create'].includes(entryIntent)) throw new TypeError('signup_view_entry_intent_invalid');
    if (!root || !root.ownerDocument || !client ||
        ['load', 'createAccount', 'acceptTerms'].some(k => typeof client[k] !== 'function')) {
        throw new TypeError('signup_view_dependencies_required');
    }
    const doc = root.ownerDocument;
    let disposed = false, busy = false, generation = 0, viewRevision = 0;
    let cancelOperation = null, setupDraft = null;
    const element = (tag, text) => {
        const node = doc.createElement(tag);
        if (text !== undefined) node.textContent = text;
        return node;
    };
    function button(label, action, timeoutMs = 30000, restoreDraft = false) {
        const node = element('button', label);
        const revision = viewRevision;
        node.type = 'button';
        node.className = 'button';
        node.addEventListener('click', () => {
            if (!node.disabled && revision === viewRevision) run(action, timeoutMs, restoreDraft);
        });
        return node;
    }
    function show(state, diagnosticSource = state, restoreDraft = false) {
        if (disposed) return;
        viewRevision++;
        root.replaceChildren();
        const heading = element('h1');
        heading.tabIndex = -1;
        root.append(heading);
        if (!state || !['create_account', 'setup_details', 'resume_setup', 'setup_read_only', 'signin_required', 'continue_authentication', 'terms', 'resume_acceptance', 'pending_preparation', 'pending_admission', 'continue_to_dashboard', 'unavailable'].includes(state.status) ||
            ['setup_details', 'resume_setup'].includes(state.status) && !validSetup(state) ||
            state.status === 'setup_read_only' && (typeof state !== 'object' || Array.isArray(state) ||
                Object.keys(state).length !== 1 || !Object.hasOwn(state, 'status'))) {
            setupDraft = null;
            state = { status: 'unavailable' };
        }
        if (setupDraft && (state.status === 'setup_details'
            ? !sameSetup(setupDraft.binding, state) : state.status !== 'unavailable')) setupDraft = null;
        if (state.status === 'create_account') {
            heading.textContent = chooseAccount ? 'Choose your account' : signInRecovery ? 'Restart secure sign-in'
                : entryIntent === 'create' ? 'Create your account' : entryIntent === 'login' ? 'Log in to No Fries' : 'Sign up / Sign in';
            if (chooseAccount) {
                root.append(element('p', 'Enter the email and password for the account you want to use. Your other account and saved setup are kept.'));
            } else if (signInRecovery) {
                root.append(element('p', signInRecovery === 'expired'
                    ? 'This sign-in attempt has expired or is no longer valid. Start a fresh sign-in to continue.'
                    : 'Sign-in did not finish. Start a fresh sign-in to continue.'),
                element('p', customerTransport
                    ? 'If you finished creating your account, sign in with the same email and password. You do not need to create another account.'
                    : 'Use the same email linked to your account or invitation. Your saved setup and work are kept.'));
            } else {
                root.append(element('p', customerTransport ? entryIntent === 'create' ? 'Create an account with your email and password.'
                    : entryIntent === 'login' ? 'Sign in with your existing email and password.'
                    : 'Create an account with your email and password, or sign in to your existing account.' : 'Continue secure sign-in with the email address you verified or that received your invitation.'));
            }
            if (customerTransport) root.append(element('p', 'Have your inbox ready before continuing. Secure sign-in is time limited; you can return here and restart if it does not finish.'));
            // Browser cancellation backstop only. The server independently
            // enforces its five-minute, one-use authentication transaction.
            const entry = button(chooseAccount ? 'Sign in with another account' : signInRecovery ? 'Restart secure sign-in'
                : entryIntent === 'create' ? 'Create account' : entryIntent === 'login' ? 'Log in' : 'Login',
                signal => client.createAccount({ signal }), 630000);
            entry.classList.add('signup-entry-action'); root.append(entry);
            const start = element('a', customerTransport ? signInRecovery || chooseAccount ? 'Return to No Fries' : 'Back to home' : 'Start with email verification');
            start.href = customerTransport ? '/' : '/login'; start.className = 'text-link signup-secondary-action'; root.append(start);
            if (customerTransport && signInRecovery && !chooseAccount) {
                const choose = element('a', 'Sign in with another account');
                choose.href = '/api/external-customer-auth/login?account=choose';
                choose.className = 'text-link signup-secondary-action'; root.append(choose);
            }
        } else if (state.status === 'setup_details' && customerTransport && typeof client.completeSetup === 'function') {
            heading.textContent = 'Set up your workspace';
            root.append(element('p', 'Signed in as ' + state.email));
            const form = element('form');
            const controls = {}, validateText = [];
            const typeLabel = element('label', 'Account type'), accountType = element('select');
            accountType.name = 'accountType';
            for (const [value, title] of [['company', 'Company'], ['consultant', 'Consultant']]) {
                const option = element('option', title); option.value = value; accountType.append(option);
            }
            typeLabel.append(accountType); form.append(typeLabel);
            for (const [name, title, maximum, required, blankMessage, autocomplete] of [
                ['organisationName', 'Company or consultancy name', 120, true, 'Enter your company or consultancy name.', 'organization'],
                ['name', 'Your name', 160, true, 'Enter your name.', 'name'], ['role', 'Your role', 120, true, 'Enter your role.', 'organization-title'],
                ['address', 'Business address', 500, true, 'Enter your business address.', 'street-address'],
                ['registrationId', 'NZBN (optional)', 160, false, 'Enter your NZBN, or leave this field empty.']
            ]) {
                const label = element('label', title), input = element('input');
                input.name = name; input.type = 'text'; input.maxLength = maximum; input.required = required;
                if (autocomplete) input.setAttribute('autocomplete', autocomplete);
                const validate = () => {
                    if (input.disabled) return;
                    const normalized = input.value.trim().normalize('NFC');
                    input.setCustomValidity(input.value !== '' && !normalized ? blankMessage
                        : /[\u0000-\u001f\u007f-\u009f<>]/u.test(normalized)
                            ? title + ': remove <, > and hidden control characters.' : '');
                };
                input.addEventListener('input', validate); validateText.push(validate);
                label.append(input);
                if (name === 'registrationId') {
                    const help = element('span', 'Your New Zealand Business Number, if you have one.');
                    help.className = 'field-help'; help.setAttribute('id', 'signup-nzbn-help');
                    input.setAttribute('aria-label', title); input.setAttribute('aria-describedby', 'signup-nzbn-help');
                    label.append(help);
                }
                form.append(label); controls[name] = input;
            }
            const reservation = state.reservation ? Object.freeze({ accountType: state.reservation.accountType,
                organisationName: state.reservation.organisationName }) : null;
            const binding = setupBinding(state);
            if (reservation) {
                accountType.value = reservation.accountType; accountType.disabled = true;
                controls.organisationName.value = reservation.organisationName; controls.organisationName.disabled = true;
                root.append(element('p', 'Your account type and organisation are already saved. Complete the remaining details for this workspace.'));
            }
            if (restoreDraft && setupDraft) {
                if (!reservation) accountType.value = setupDraft.accountType;
                for (const name of Object.keys(controls)) {
                    if (name !== 'organisationName' || !reservation) controls[name].value = setupDraft.text[name];
                }
                setupDraft = null;
            }
            const label = element('label'), authority = element('input');
            label.className = 'organisation-authority-check';
            authority.type = 'checkbox'; authority.required = true; authority.name = 'authorityConfirmed';
            authority.checked = false;
            label.append(authority, element('span', ' I am authorised to set up this organisation.')); form.append(label);
            const submit = element('button', 'Continue'); submit.type = 'submit'; submit.className = 'button'; form.append(submit);
            const revision = viewRevision;
            form.addEventListener('submit', event => {
                event.preventDefault();
                if (busy || revision !== viewRevision) return;
                for (const validate of validateText) validate();
                if (!form.reportValidity()) return;
                // Text is private to this mount; approval and request material
                // are never retained. Only a later deliberate state read may
                // restore it to the same still-editable setup.
                setupDraft = { binding, accountType: reservation ? reservation.accountType : accountType.value,
                    text: Object.fromEntries(Object.entries(controls).map(([name, control]) => [name, control.value])) };
                const input = { accountType: reservation ? reservation.accountType : accountType.value,
                    organisationName: reservation ? reservation.organisationName : controls.organisationName.value.trim().normalize('NFC'),
                    details: { name: controls.name.value, role: controls.role.value, address: controls.address.value,
                        registrationId: controls.registrationId.value, authorityConfirmed: authority.checked } };
                run(signal => client.completeSetup(input, { signal }));
            });
            root.append(form);
            setupSignOut();
        } else if (state.status === 'resume_setup' && customerTransport && typeof client.completeSetup === 'function') {
            heading.textContent = 'Resume your workspace setup';
            root.append(element('p', 'Signed in as ' + state.email), element('p', state.organisationName),
                element('p', 'Account type: ' + (state.accountType === 'consultant' ? 'Consultant' : 'Company')),
                element('p', 'Your details are saved, but workspace setup did not finish. Resume using those saved details without entering them again.'),
                button('Resume workspace setup', signal => client.completeSetup({ resume: true }, { signal })));
            // A fresh callback can already have non-provisional assurance
            // after a partial claim published authority. Keep the escape valid
            // for both parents without promising provisional-only logout.
            signInLinks();
        } else if (state.status === 'setup_read_only') {
            heading.textContent = 'Workspace setup saved';
            root.append(element('p', 'Your workspace setup is saved. Further setup steps are unavailable right now.'),
                element('p', 'Check setup status to read any recorded progress. This does not submit details, accept terms or complete setup.'),
                button('Check setup status', signal => client.load({ signal })));
            const home = element('a', 'Back to home'); home.href = '/'; home.className = 'text-link signup-secondary-action'; root.append(home);
        } else if (state.status === 'signin_required' && customerTransport) {
            heading.textContent = 'Sign in again';
            root.append(element('p', 'Continue secure sign-in with the email linked to your account. Your saved setup and work are kept.'));
            signInLinks();
        } else if (state.status === 'continue_authentication' && customerTransport) {
            heading.textContent = 'Continuing account setup';
            const link = element('a', 'Continue securely'); link.href = '/api/external-customer-auth/login'; link.className = 'button';
            root.append(link);
            setupSignOut();
        } else if (state.status === 'terms' && validTerms(state)) {
            heading.textContent = 'Review your terms';
            root.append(element('p', 'Your email has been verified. Review the applicable organisation schedule and agreement before continuing.'));
            if (Object.hasOwn(state, 'scheduleId')) {
                const schedule = element('section');
                schedule.setAttribute('aria-label', 'Organisation schedule');
                const scheduleText = element('p', state.scheduleText); scheduleText.className = 'signup-legal-text';
                schedule.append(element('h2', 'Organisation schedule'), scheduleText);
                schedule.className = 'signup-legal signup-schedule';
                root.append(schedule);
            }
            const terms = element('section');
            terms.setAttribute('aria-label', 'Terms');
            const termsText = element('p', state.termsText); termsText.className = 'signup-legal-text';
            terms.append(element('h2', 'Dashboard agreement'), termsText);
            terms.className = 'signup-legal signup-agreement';
            root.append(terms);
            const label = element('label'), consent = element('input');
            label.className = 'organisation-authority-check signup-consent';
            consent.type = 'checkbox';
            consent.checked = false;
            label.append(consent, element('span', Object.hasOwn(state, 'scheduleId')
                ? ' I accept this organisation schedule and agreement.' : ' I accept these terms.'));
            const submit = button('Accept and continue', signal => {
                if (!consent.checked) return Promise.resolve(state);
                return client.acceptTerms({ termsVersion: state.termsVersion, termsDigest: state.termsDigest,
                    ...(Object.hasOwn(state, 'scheduleId') ? { scheduleId: state.scheduleId, scheduleDigest: state.scheduleDigest } : {}),
                    accepted: true }, { signal });
            });
            submit.disabled = true;
            consent.addEventListener('change', () => { submit.disabled = !consent.checked || busy; });
            root.append(label, submit);
        } else if (state.status === 'resume_acceptance') {
            heading.textContent = 'Complete account setup';
            root.append(element('p', 'Your acceptance was recorded, but account setup did not finish. Resume the protected setup without accepting again.'),
                button('Resume account setup', signal => client.resumeAcceptance({ signal })));
        } else if (state.status === 'continue_to_dashboard' &&
            (state.accountType === undefined || ['company', 'consultant'].includes(state.accountType))) {
            heading.textContent = 'Account setup complete';
            const consultant = state.accountType === 'consultant';
            const link = element('a', consultant ? 'Open your consultant dashboard' : 'Continue to your dashboard');
            link.className = 'button';
            link.href = consultant ? '/dashboard#organisations' : '/dashboard';
            root.append(link);
        } else if (state.status === 'pending_preparation') {
            heading.textContent = 'Your organisation is being prepared';
            root.append(element('p', 'Your identity is verified. No Fries is preparing your approved organisation workspace before you review its terms. Your terms have not been accepted yet.'),
                button('Check setup status', signal => client.load({ signal })));
        } else if (state.status === 'pending_admission') {
            heading.textContent = 'Account setup received';
            root.append(element('p', 'Your terms have been accepted. Workspace access is pending approval. You do not have dashboard access yet.'),
                button('Check access status', signal => client.load({ signal })));
        } else {
            heading.textContent = 'Signup is unavailable';
            root.append(element('p', customerTransport
                ? 'We could not confirm your account setup. Do not create another account or submit your details again.'
                : 'We could not complete account setup. Your invitation may no longer be available, or setup may need attention. We could not confirm your current access.'));
            if (customerTransport) {
                root.append(element('p', 'Error code: NF-SIGNUP-UNCONFIRMED'));
                showDiagnostic(diagnosticSource);
            }
            else root.append(button('Try again', signal => client.load({ signal }), 30000, true));
            const help = element('p', customerTransport
                ? 'Contact No Fries for help and include this error code.'
                : 'If this continues, contact No Fries for help with your existing signup.');
            const report = element('a', 'Report this problem');
            report.href = reportLink(diagnosticSource);
            report.target = '_blank'; report.rel = 'noopener noreferrer';
            report.setAttribute('aria-label', 'Report this problem (opens in a new tab)');
            help.className = 'field-help signup-status-help'; help.append(element('span', ' '), report); root.append(help);
            if (customerTransport) signInLinks();
        }
        heading.focus();
    }
    function showDiagnostic(value) {
        let reference, stage, reason;
        try {
            const metadata = typeof client.diagnostic === 'function' ? client.diagnostic(value) : null;
            reference = metadata?.supportReference; stage = metadata?.signupStage; reason = metadata?.signupReason;
        }
        catch (_) { /* Optional diagnostics never change the signup outcome. */ }
        const validReference = typeof reference === 'string' && reference.length === 19 && /^NF-[A-F0-9]{16}$/.test(reference);
        const stages = { workspace_preparation: 'Preparing your workspace.', workspace_details: 'Saving or reading your workspace details.',
            signup_status: 'Checking signup status.', terms_review: 'Preparing your terms.' };
        const reasons = { step_unconfirmed: 'No Fries could not confirm completion of this step.',
            setup_information_unavailable: 'Setup information was unavailable for this step.',
            terms_unavailable: 'The terms could not be prepared for review.' };
        if (validReference && typeof stage === 'string' && Object.hasOwn(stages, stage) &&
            typeof reason === 'string' && Object.hasOwn(reasons, reason) &&
            (stage === 'terms_review' ? ['step_unconfirmed', 'terms_unavailable'].includes(reason)
                : ['step_unconfirmed', 'setup_information_unavailable'].includes(reason))) {
            root.append(element('p', 'Recorded step: ' + stages[stage]), element('p', 'Reason: ' + reasons[reason]));
        } else {
            root.append(element('p', validReference ? 'No further server diagnostic is available for this attempt.'
                : 'No server diagnostic was received for this attempt.'));
        }
        if (validReference) root.append(element('p', 'Support reference: ' + reference));
    }
    function reportLink(value) {
        const params = new URLSearchParams({ kind: 'error', screen: 'signup', code: 'signup_unavailable' });
        try {
            const metadata = typeof client.diagnostic === 'function' ? client.diagnostic(value) : null;
            const reference = metadata?.supportReference;
            if (typeof reference === 'string' && reference.length === 19 && /^NF-[A-F0-9]{16}$/.test(reference)) {
                params.set('reference', reference);
            }
            const sha = metadata?.apiReleaseSha, runId = metadata?.apiReleaseRunId;
            if (typeof sha === 'string' && sha.length === 40 && /^[a-f0-9]{40}$/.test(sha) &&
                typeof runId === 'string' && runId.length <= 20 && /^[1-9][0-9]{0,19}$/.test(runId)) {
                params.set('apiReleaseSha', sha); params.set('apiReleaseRunId', runId);
            }
        } catch (_) { /* Missing diagnostic context never blocks recovery or reporting. */ }
        return '/report.html#' + params.toString();
    }
    function signInLinks() {
        const restart = element('a', 'Sign in again'); restart.href = '/api/external-customer-auth/login'; restart.className = 'button';
        const choose = element('a', 'Sign in with another account'); choose.href = '/api/external-customer-auth/login?account=choose';
        choose.className = 'text-link signup-secondary-action';
        root.append(restart, choose);
    }
    function validSetup(s) {
        const reserved = s.status === 'setup_details' && Object.hasOwn(s, 'reservation');
        const keys = ['status', 'email', ...(reserved ? ['reservation'] : []), ...(s.status === 'resume_setup' ? ['accountType', 'organisationName'] : [])];
        if (!customerTransport || Object.keys(s).length !== keys.length || Object.keys(s).some(key => !keys.includes(key)) ||
            typeof s.email !== 'string' || s.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+(?![\s\S])/.test(s.email)) return false;
        const account = s.status === 'resume_setup' ? s : reserved ? s.reservation : null;
        if (!account) return !reserved && s.status !== 'resume_setup';
        if (typeof account !== 'object' || Array.isArray(account) || reserved &&
            Object.keys(account).sort().join(',') !== 'accountType,organisationName') return false;
        return ['company', 'consultant'].includes(account.accountType) && typeof account.organisationName === 'string' &&
            account.organisationName.length > 0 && account.organisationName.length <= 120 &&
            account.organisationName === account.organisationName.trim().normalize('NFC') && !/[\u0000-\u001f\u007f-\u009f<>]/u.test(account.organisationName);
    }
    function setupBinding(state) {
        return { email: state.email, reservation: Object.hasOwn(state, 'reservation')
            ? { accountType: state.reservation.accountType, organisationName: state.reservation.organisationName } : null };
    }
    function sameSetup(binding, state) {
        const next = setupBinding(state);
        return binding.email === next.email && (binding.reservation === null ? next.reservation === null
            : next.reservation !== null && binding.reservation.accountType === next.reservation.accountType &&
                binding.reservation.organisationName === next.reservation.organisationName);
    }
    function setupSignOut() {
        // Native same-origin POST remains usable before dashboard admission.
        // It ends only the current provisional No Fries session, not the
        // Microsoft, mailbox, staff or other browser sessions.
        const form = element('form');
        form.method = 'post'; form.action = '/api/external-customer-auth/logout';
        const submit = element('button', 'Sign out and change account');
        submit.type = 'submit'; submit.className = 'button secondary';
        form.append(submit, element('p', 'Your account, saved setup and work are kept.'));
        root.append(form);
    }
    function validTerms(s) {
        const scheduled = Object.hasOwn(s, 'scheduleId');
        return typeof s.termsText === 'string' && s.termsText.length > 0 && s.termsText.length <= 32768 &&
            typeof s.termsVersion === 'string' && s.termsVersion.length > 0 && s.termsVersion.length <= 180 &&
            typeof s.termsDigest === 'string' && /^[a-f0-9]{64}$/.test(s.termsDigest) && (!scheduled ||
                (typeof s.scheduleId === 'string' && s.scheduleId.length > 0 && s.scheduleId.length <= 180 &&
                    typeof s.scheduleText === 'string' && s.scheduleText.length > 0 && s.scheduleText.length <= 32768 &&
                    typeof s.scheduleDigest === 'string' && /^[a-f0-9]{64}$/.test(s.scheduleDigest)));
    }
    async function run(action, timeoutMs = 30000, restoreDraft = false) {
        if (disposed || busy) return;
        busy = true;
        const current = ++generation;
        const controller = new AbortController();
        let timer;
        const cancelled = new Promise((_, reject) => {
            cancelOperation = () => { controller.abort(); reject(new Error('signup_cancelled')); };
            timer = setTimeout(cancelOperation, timeoutMs);
        });
        root.setAttribute('aria-busy', 'true');
        for (const node of [...root.querySelectorAll('button'), ...root.querySelectorAll('input'), ...root.querySelectorAll('select')]) node.disabled = true;
        try {
            const state = await Promise.race([action(controller.signal), cancelled]);
            if (!disposed && current === generation) show(state, state, restoreDraft);
        } catch (error) {
            if (!disposed && current === generation) show({ status: 'unavailable' }, error);
        } finally {
            clearTimeout(timer);
            if (!disposed && current === generation) {
                cancelOperation = null;
                busy = false;
                root.setAttribute('aria-busy', 'false');
            }
        }
    }
    const ready = run(signal => client.load({ signal }));
    return Object.freeze({ ready, dispose() {
        disposed = true; generation++;
        setupDraft = null;
        if (cancelOperation) cancelOperation();
        cancelOperation = null;
        root.replaceChildren();
        root.removeAttribute('aria-busy');
    } });
}

module.exports = { mountSignupJourney };
