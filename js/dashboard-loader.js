(function () {
    'use strict';

    const gateway = document.body.dataset.dashboardGateway === 'true';
    const customerProvider = document.body.dataset.customerProvider;
    const externalCustomer = customerProvider === 'external';
    // Missing or unknown public context must use the existing customer selector.
    // Only an explicitly composed staff document uses workforce dashboard entry.
    const customerEntry = externalCustomer ? '/login?provider=external'
        : customerProvider === 'legacy' ? '/login?provider=legacy' : '/login';
    const customerReauthentication = externalCustomer ? '/api/external-customer-auth/login'
        : customerProvider === 'legacy' ? '/api/customer-auth/login' : '/login?reauthenticate=1';
    if (document.body.dataset.page !== 'operator-dashboard' && !gateway) return;
    const publicGateway = gateway ? document.getElementById('gatewayPublic') : null;

    const REQUEST_MS = 12000;
    const MAX_RECONCILIATIONS = 2;
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    const DIGEST = /^[0-9a-f]{64}$/;
    const ROUTES = ['overview', 'ai-governance', 'cyber-security', 'it-optimisation', 'improvement-plan', 'evidence', 'board-reports', 'services'];
    const ids = { entry: 'dashboardEntry', panel: 'dashboardStatusPanel', heading: 'dashboardHeading', message: 'dashboardMessage',
        status: 'dashboardStatus', retry: 'dashboardRetry', signIn: 'dashboardSignIn', signOut: 'dashboardSignOut',
        chooser: 'dashboardChooser', choices: 'dashboardChoices', more: 'dashboardMore', app: 'dashboardApp' };
    const elements = {};
    Object.keys(ids).forEach(function (key) { elements[key] = document.getElementById(ids[key]); });
    if (Object.keys(elements).some(function (key) { return !elements[key]; })) return;

    const skipLink = document.getElementById('dashboardSkipLink');
    if (skipLink) skipLink.addEventListener('click', function (event) {
        if (document.body.dataset.dashboardState !== 'ready') return;
        event.preventDefault();
        const main = elements.app.querySelector('main');
        if (main && !elements.app.hidden && !elements.app.inert) main.focus();
    });

    let active = null;
    let controller = null;
    let portfolioButton = null;
    let hadSession = false;
    let linkExit = null;
    // An abandoned fetch is not evidence that its server command was cancelled.
    // Retain one immutable command until an acknowledgement or definite denial.
    let unresolved = null;
    function currentRoute() {
        const hash = String(window.location.hash || '');
        return ROUTES.includes(hash.slice(1)) ? hash : '';
    }
    elements.signIn.href = customerProvider === 'staff'
        ? '/api/auth/login?returnTo=' + encodeURIComponent('/dashboard' + currentRoute()) : customerEntry;

    function current(cycle) { return active === cycle && !cycle.closed; }
    function dispose(cycle) {
        if (!cycle || cycle.closed) return;
        cycle.closed = true;
        cycle.cleanup.splice(0).forEach(function (cleanup) { cleanup(); });
    }
    function clearContent() {
        if (portfolioButton) { portfolioButton.hidden = true; portfolioButton.onclick = null; }
        const activation = document.getElementById('customerActivationControls');
        if (activation) activation.remove();
        const clientSetup = document.getElementById('clientSetupControls');
        if (clientSetup) clientSetup.remove();
        const old = controller;
        controller = null;
        if (old) old.destroy();
        elements.app.hidden = true;
        if (publicGateway) publicGateway.hidden = false;
        elements.app.inert = false;
        elements.app.replaceChildren();
        elements.entry.setAttribute('role', 'main');
        elements.choices.replaceChildren();
        elements.chooser.hidden = true;
        elements.more.hidden = true;
    }
    function clientDraft(cycle) {
        return cycle ? (cycle.captureClientDraft && cycle.captureClientDraft()) || cycle.clientDraft : null;
    }
    function blockPendingClientNavigation(cycle) {
        if (!clientDraft(cycle)?.pending) return false;
        const section = document.getElementById('clientSetupControls');
        const status = section && section.querySelector('.client-workspace-status');
        if (status) {
            const direction = 'Check and resume saved setup before changing organisation or signing out.';
            if (!status.textContent.includes(direction)) status.textContent += (status.textContent ? ' ' : '') + direction;
            status.tabIndex = -1;
            status.focus();
        }
        return true;
    }
    function begin(draft) {
        dispose(active);
        linkExit = null;
        const cycle = { closed: false, cleanup: [], session: null, busy: true, clientDraft: draft || null, directoryPageCount: 0 };
        cycle.cleanup.push(function () { window.clearTimeout(cycle.expiryTimer); });
        active = cycle;
        clearContent();
        show(cycle, 'loading');
        return cycle;
    }
    function show(cycle, state, focusHeading) {
        if (!current(cycle)) return;
        const copy = {
            loading: ['Opening your dashboard', 'Checking your current access.', 'Please wait.'],
            selection: ['Choose an organisation', 'Select the organisation you want to view.', 'Your selection will be checked before the dashboard opens.'],
            ready: ['Your dashboard', 'Choose another organisation or sign out when finished.', 'Dashboard ready.'],
            unauthenticated: ['Sign in to your dashboard', 'Use the email address for your No Fries account.', 'You are not signed in.'],
            expired: ['Your session has expired', 'Sign in again to continue.', 'Dashboard content has been cleared.'],
            denied: ['Dashboard access is unavailable', 'Your current identity does not have the required access.', 'No dashboard content is displayed.'],
            unavailable: ['The dashboard could not load', 'Please try again when the service is available.', 'The request could not be confirmed.'],
            signout: ['Sign-out is not confirmed', 'The request may still complete. Retry to check sign-out.', 'Dashboard content has been cleared.']
        }[state];
        if (state === 'ready' && cycle.session?.purpose === 'customer') {
            if (cycle.session.accountType === 'company') copy[1] = 'View your organisation’s saved assessment and next actions.';
            else if (cycle.session.accountType === 'consultant') {
                copy[0] = 'Viewing ' + (cycle.selectedOrganisationName || 'your organisation');
                copy[1] = 'View this organisation’s saved assessment and next actions, or Return to organisations.';
            }
        }
        document.body.dataset.dashboardState = state;
        elements.panel.hidden = gateway && ['loading', 'unauthenticated'].includes(state) && !hadSession;
        if (skipLink) {
            skipLink.href = state === 'ready' ? '#dashboard-content' : elements.panel.hidden ? '#main-content' : '#dashboardHeading';
            skipLink.textContent = state === 'ready' ? 'Skip to dashboard content' : elements.panel.hidden ? 'Skip to content' : 'Skip to dashboard status';
        }
        if (elements.chooser.tagName === 'DETAILS') elements.chooser.open = state !== 'ready';
        if (publicGateway) publicGateway.hidden = ['ready', 'selection'].includes(state);
        if (state === 'selection' && cycle.session?.accountType === 'consultant') {
            const owner = cycle.session.clientSetupAvailable === true;
            copy[0] = 'Your consultant account';
            copy[1] = owner ? 'Choose your own or a client organisation, or add an organisation.'
                : 'Choose an organisation workspace you can access.';
            copy[2] = owner ? 'Account owner · Organisation access is checked separately.'
                : 'Only organisation workspaces available to your account are listed.';
            if (cycle.session.clientSetupAvailable && !document.getElementById('clientSetupControls')) clientSetupControls(cycle);
        }
        elements.heading.textContent = copy[0];
        elements.message.textContent = copy[1];
        elements.status.textContent = copy[2];
        elements.retry.hidden = !['unavailable', 'signout', 'denied'].includes(state);
        elements.retry.disabled = false;
        elements.signIn.hidden = !['unauthenticated', 'expired', 'denied'].includes(state);
        elements.signOut.hidden = !hadSession || !!unresolved || ['unauthenticated', 'expired'].includes(state);
        elements.signOut.disabled = state === 'loading';
        if (focusHeading !== false && state !== 'loading' && !(gateway && !hadSession)) elements.heading.focus();
    }
    function failure(cycle, error) {
        if (!current(cycle)) return;
        const revoked = error && (error.expired || [401, 403].includes(error.status));
        cycle = begin(revoked ? null : clientDraft(cycle));
        cycle.busy = false;
        if (error && (error.status === 401 || error.expired)) {
            unresolved = null;
            show(cycle, hadSession ? 'expired' : 'unauthenticated');
        } else if (unresolved && unresolved.kind === 'logout') show(cycle, 'signout');
        else show(cycle, error && error.status === 403 ? 'denied' : 'unavailable');
    }
    function invalid(transport) { const error = new Error('dashboard_response_invalid'); error.validation = !transport; return error; }
    function fields(value, keys) {
        return value && typeof value === 'object' && !Array.isArray(value) &&
            Object.keys(value).length === keys.length && keys.every(function (key) { return Object.prototype.hasOwnProperty.call(value, key); });
    }
    function canonicalDate(value) {
        return typeof value === 'string' && /^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/.test(value) &&
            Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
    }
    function session(value) {
        if (!fields(value, ['schemaVersion', 'authenticated', 'purpose', 'expiresAt', 'generation', 'selectedBindingId',
            ...(Object.prototype.hasOwnProperty.call(value || {}, 'activationAvailable') ? ['activationAvailable'] : []),
            ...(Object.prototype.hasOwnProperty.call(value || {}, 'clientSetupAvailable') ? ['clientSetupAvailable'] : []),
            ...(Object.prototype.hasOwnProperty.call(value || {}, 'accountType') ? ['accountType'] : [])]) ||
            value.schemaVersion !== 1 || value.authenticated !== true || !['operator_dashboard', 'customer'].includes(value.purpose) ||
            Object.prototype.hasOwnProperty.call(value, 'activationAvailable') && (value.activationAvailable !== true || value.purpose !== 'operator_dashboard') ||
            Object.prototype.hasOwnProperty.call(value, 'accountType') && (value.purpose !== 'customer' || !['company', 'consultant'].includes(value.accountType)) ||
            Object.prototype.hasOwnProperty.call(value, 'clientSetupAvailable') && (value.clientSetupAvailable !== true || value.accountType !== 'consultant') ||
            !canonicalDate(value.expiresAt) || typeof value.generation !== 'string' || !DIGEST.test(value.generation) ||
            value.selectedBindingId !== null && (typeof value.selectedBindingId !== 'string' || !UUID.test(value.selectedBindingId))) throw invalid();
        if (Date.parse(value.expiresAt) <= Date.now()) { const error = invalid(); error.expired = true; throw error; }
        return Object.freeze({ purpose: value.purpose, generation: value.generation, selectedBindingId: value.selectedBindingId, expiresAt: value.expiresAt,
            ...(value.activationAvailable === true ? { activationAvailable: true } : {}),
            ...(value.clientSetupAvailable === true ? { clientSetupAvailable: true } : {}),
            ...(value.accountType ? { accountType: value.accountType } : {}) });
    }
    function sameSession(left, right) {
        return ['purpose', 'generation', 'selectedBindingId', 'activationAvailable', 'clientSetupAvailable', 'accountType']
            .every(function (key) { return left[key] === right[key]; });
    }
    function displayContract(model) {
        // This is only a comparison of freshly validated server display data.
        // Retaining the original snapshot timestamp does not renew authority.
        return JSON.stringify(Object.assign({}, model, { generatedAt: null }));
    }
    function remember(cycle, value) {
        if (!current(cycle)) return;
        hadSession = true;
        if (cycle.clientDraft && (value.accountType !== 'consultant' || !value.clientSetupAvailable ||
            cycle.clientDraft.generation !== value.generation || cycle.clientDraft.bindingId !== value.selectedBindingId)) cycle.clientDraft = null;
        cycle.session = value;
        if (value.activationAvailable === true) activationControls(cycle);
        // This clock only removes content; the server remains the authority.
        window.clearTimeout(cycle.expiryTimer);
        cycle.expiryTimer = window.setTimeout(function () {
            if (!current(cycle)) return;
            const expired = begin();
            expired.busy = false;
            show(expired, 'expired');
        }, Math.min(2147483647, Math.max(0, Date.parse(value.expiresAt) - Date.now())));
    }
    function secureId() {
        if (!window.crypto || typeof window.crypto.randomUUID !== 'function') throw invalid();
        const id = window.crypto.randomUUID();
        if (typeof id !== 'string' || !UUID.test(id)) throw invalid();
        return id;
    }
    function activationControls(cycle) {
        const previous = document.getElementById('customerActivationControls');
        if (previous) previous.remove();
        const section = document.createElement('section'); section.id = 'customerActivationControls';
        const heading = document.createElement('h2'); heading.textContent = 'Approved customer setup';
        const label = document.createElement('label'); label.textContent = 'Approved setup reference';
        const input = document.createElement('input'); input.type = 'text'; input.autocomplete = 'off';
        label.append(input);
        const status = document.createElement('p'); status.setAttribute('role', 'status');
        const actions = [];
        ['prepare', 'activate'].forEach(function (phase) {
            const button = document.createElement('button'); button.type = 'button';
            button.textContent = phase === 'prepare' ? 'Prepare organisation' : 'Complete approved access';
            actions.push(button);
            button.addEventListener('click', async function () {
                if (!current(cycle) || cycle.busy || unresolved) return;
                const activationId = input.value.trim();
                if (!UUID.test(activationId)) { status.textContent = 'Enter the approved setup reference.'; return; }
                cycle.busy = true; actions.forEach(function (item) { item.disabled = true; });
                input.disabled = true; status.textContent = 'Checking the approved setup.';
                try {
                    const result = requireSuccess(await request(cycle, '/api/dashboard/session',
                        { action: 'customer_activation', activationId: activationId, phase: phase }));
                    if (!fields(result, ['schemaVersion', 'phase', 'next']) || result.schemaVersion !== 1 ||
                        result.phase !== (phase === 'prepare' ? 'prepared' : 'activated') ||
                        result.next !== (phase === 'prepare' ? 'customer_terms' : 'owner_finalisation')) throw invalid();
                    if (current(cycle)) status.textContent = phase === 'prepare'
                        ? 'Organisation prepared. The customer can now review and accept the applicable terms.'
                        : 'Approved access recorded. Complete owner finalisation, then ask the customer to sign in again.';
                } catch (_) {
                    if (current(cycle)) status.textContent = 'Setup could not be confirmed. Check the approval and customer terms, then retry this same reference. No new approval was created.';
                } finally {
                    if (current(cycle)) { cycle.busy = false; input.disabled = false; actions.forEach(function (item) { item.disabled = false; }); }
                }
            });
            section.append(button);
        });
        section.prepend(heading, label); section.append(status); elements.entry.append(section);
        cycle.cleanup.push(function () { section.remove(); });
    }
    function command(kind, body) {
        if (unresolved) throw invalid();
        unresolved = Object.freeze({ kind: kind, body: Object.freeze(body) });
        return unresolved;
    }
    function currentRefresh(cycle, refresh) { return current(cycle) && cycle.refresh === refresh && !refresh.closed; }
    function closeRefresh(refresh) {
        if (refresh.closed) return;
        refresh.closed = true;
        refresh.requests.forEach(function (cancel) { cancel(); });
        refresh.requests.clear();
    }
    function request(cycle, path, body, generation, csrf, refresh) {
        if (!current(cycle) || refresh && !currentRefresh(cycle, refresh)) return Promise.reject(invalid());
        const abort = typeof AbortController === 'function' ? new AbortController() : null;
        return new Promise(function (resolve, reject) {
            let settled = false;
            const finish = function (callback, value) {
                if (settled) return;
                settled = true;
                window.clearTimeout(timer);
                if (refresh) refresh.requests.delete(cancel);
                callback(value);
            };
            const cancel = function () {
                if (abort) abort.abort();
                finish(reject, invalid(true));
            };
            const timer = window.setTimeout(cancel, REQUEST_MS);
            if (refresh) refresh.requests.add(cancel);
            else cycle.cleanup.push(cancel);
            const headers = { Accept: 'application/json' };
            if (body !== undefined) headers['Content-Type'] = 'application/json';
            if (generation !== undefined) headers['X-NoFries-Dashboard-Generation'] = generation;
            if (csrf !== undefined) headers['X-CSRF-Token'] = csrf;
            const options = { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
                redirect: 'error', headers: headers };
            if (abort) options.signal = abort.signal;
            if (body !== undefined) options.body = JSON.stringify(body);
            Promise.resolve().then(function () {
                if (!current(cycle) || settled || refresh && !currentRefresh(cycle, refresh)) throw invalid();
                return fetch(path, options);
            }).then(async function (response) {
                if (!current(cycle) || settled || refresh && !currentRefresh(cycle, refresh)) throw invalid();
                if (!response || response.redirected || ['opaque', 'opaqueredirect'].includes(response.type) ||
                    !response.headers || !/^application\/json(?:\s*;|\s*$)/i.test(response.headers.get('content-type') || '')) throw invalid();
                let value;
                try { value = await response.json(); } catch (_) { throw invalid(); }
                if (!current(cycle) || settled || refresh && !currentRefresh(cycle, refresh)) throw invalid();
                finish(resolve, { status: response.status, value: value });
            }).catch(function (error) { finish(reject, error); });
        });
    }
    function requireSuccess(result) {
        if (result.status !== 200) { const error = invalid(); error.status = result.status; throw error; }
        return result.value;
    }
    async function readSession(cycle, refresh) {
        return session(requireSuccess(await request(cycle, '/api/dashboard/session', undefined, undefined, undefined, refresh)));
    }
    async function execute(cycle, pending) {
        const paths = { initialize: '/api/dashboard/session', selection: '/api/dashboard/selection', logout: '/api/dashboard/logout' };
        const result = await request(cycle, paths[pending.kind], pending.body);
        if (!current(cycle)) return;
        // A definite server rejection ends this command. Network/format/5xx
        // uncertainty retains its exact identity and fields for explicit retry.
        if (result.status >= 400 && result.status < 500) {
            if (unresolved === pending) unresolved = null;
            requireSuccess(result);
        }
        const value = requireSuccess(result);
        const valid = pending.kind === 'initialize' ? fields(value, ['schemaVersion', 'initialized']) && value.initialized === true :
            pending.kind === 'logout' ? fields(value, ['schemaVersion', 'loggedOut']) && value.loggedOut === true :
                fields(value, ['schemaVersion', 'generation', 'selectedBindingId']) && typeof value.generation === 'string' && DIGEST.test(value.generation) &&
                typeof value.selectedBindingId === 'string' && UUID.test(value.selectedBindingId) && value.selectedBindingId === pending.body.bindingId;
        if (!valid || value.schemaVersion !== 1) throw invalid();
        if (unresolved === pending) unresolved = null;
        if (pending.kind === 'logout') { window.location.assign(externalCustomer ? '/login?provider=external' : '/'); return; }
        if (pending.kind === 'selection') cycle.openSelection = true;
        // Original receipts acknowledge commands; they never supply current authority.
        await reconcile(cycle, 0, false);
    }
    function reconcile(cycle, transitions, initializeAllowed) {
        // Initialisation can reconcile again within the same cycle. Track the
        // full chain so focus/restore cannot restart a pending authority check.
        cycle.reconciling = (cycle.reconciling || 0) + 1;
        return reconcileCurrent(cycle, transitions, initializeAllowed).finally(function () { cycle.reconciling -= 1; });
    }
    async function reconcileCurrent(cycle, transitions, initializeAllowed) {
        const result = await request(cycle, '/api/dashboard/session');
        if (!current(cycle)) return;
        if (result.status === 409 && initializeAllowed && fields(result.value, ['code']) && result.value.code === 'dashboard_initialization_required') {
            const pending = command('initialize', { operationId: secureId() });
            await execute(cycle, pending);
            return;
        }
        const value = session(requireSuccess(result));
        remember(cycle, value);
        // Navigation records the chosen view, never authority. Keep it across
        // focus/pageshow rechecks after a consultant selects a client.
        if (cycle.openSelection && value.accountType === 'consultant' && !currentRoute()) {
            window.history.replaceState(null, '', '#overview');
        }
        const snapshot = Object.freeze({ generation: value.generation, selectedBindingId: value.selectedBindingId });
        const prefetchProjection = value.selectedBindingId !== null && !(value.accountType === 'consultant' &&
            !cycle.openSelection && (cycle.forcePortfolio || !currentRoute()));
        // Both reads depend only on this fresh session. Reconciliation failure
        // disposes the cycle and cancels siblings; neither response admits the protected shell.
        const middle = prefetchProjection ? await Promise.all([
            directory(cycle, value, [], null),
            request(cycle, '/api/dashboard/bootstrap', undefined, snapshot.generation).then(requireSuccess)
        ]) : [await directory(cycle, value, [], null)];
        if (!current(cycle)) return;
        if (value.selectedBindingId === null || value.accountType === 'consultant' && !cycle.openSelection && (cycle.forcePortfolio || !currentRoute())) { cycle.busy = false; show(cycle, 'selection'); return; }
        // Navigation may change while directory reads are pending. Keep the
        // existing final route decision and fetch if it now opens an organisation.
        const projection = prefetchProjection ? middle[1] :
            requireSuccess(await request(cycle, '/api/dashboard/bootstrap', undefined, snapshot.generation));
        if (!current(cycle)) return;
        await assets(cycle);
        if (!current(cycle)) return;
        const factory = window.NoFriesDashboard;
        if (!factory || typeof factory.validate !== 'function' || typeof factory.mount !== 'function') throw invalid();
        const model = factory.validate(projection);
        if (model.admissionGranted !== false || model.providerAccessGranted !== false) throw invalid();
        cycle.selectedOrganisationName = model.context.displayName;
        const cyberReady = model.modules.some(function (item) { return item.key === 'cyber_security' && item.state === 'ready'; });
        const cyber = cyberReady ? await cyberOptions(cycle, snapshot, model.context.organisationId) : null;
        const improvementReady = model.modules.some(function (item) { return item.key === 'improvement_plan' && item.state === 'ready'; });
        const improvement = improvementReady ? improvementOptions(cycle, snapshot, model.context.organisationId) : null;
        const fresh = await readSession(cycle);
        if (!current(cycle)) return;
        if (!sameSession(value, fresh)) {
            if (transitions >= MAX_RECONCILIATIONS) throw invalid();
            const next = begin();
            reconcile(next, transitions + 1, false).catch(function (error) { failure(next, error); });
            return;
        }
        remember(cycle, fresh);
        // The genuine shell creates its own main landmark. The generic entry
        // owns that role only while no protected shell is mounted.
        elements.entry.removeAttribute('role');
        cycle.cyber = !!cyber;
        cycle.improvement = !!improvement;
        cycle.displayContract = displayContract(model);
        controller = factory.mount(elements.app, model, { window: window, initialRoute: currentRoute(),
            ...(cyber ? { mountCyber: cyber } : {}),
            ...(cyber && cyber.mountPicture ? { mountPicture: cyber.mountPicture } : {}),
            ...(improvement ? { mountImprovement: improvement } : {}) });
        if (!controller || typeof controller.destroy !== 'function') throw invalid();
        elements.app.hidden = false;
        cycle.busy = false;
        show(cycle, 'ready');
        if (fresh.accountType === 'consultant') portfolioControls(cycle);
    }
    function clientSetupControls(cycle) {
        const section = document.createElement('section'); section.id = 'clientSetupControls'; section.className = 'client-workspace';
        const heading = document.createElement('h2'); heading.textContent = 'Add organisation';
        const content = document.createElement('div'), status = document.createElement('p');
        content.className = 'client-workspace-content'; status.className = 'client-workspace-status'; status.setAttribute('role', 'status');
        section.setAttribute('aria-labelledby', 'clientWorkspaceHeading'); heading.id = 'clientWorkspaceHeading';
        section.append(heading, content, status); elements.chooser.append(section);
        let csrf, requestId, pending = null, captureForm = null,
            listCursor = cycle.clientDraft?.listCursor || null, unlimitedList = false, writesClosed = false;
        const clientNames = new Map();
        cycle.captureClientDraft = function () {
            if (pending) return { pending: pending, listCursor: listCursor,
                generation: cycle.session.generation, bindingId: cycle.session.selectedBindingId };
            return captureForm ? captureForm() : null;
        };
        function element(tag, text) { const node = document.createElement(tag); if (text) node.textContent = text; return node; }
        function button(label, action) { const node = element('button', label); node.type = 'button'; node.className = 'client-action'; node.addEventListener('click', action); return node; }
        function available() { return current(cycle) && !cycle.busy && !cycle.authorityPending && !unresolved; }
        function envelope(result) {
            const response = requireSuccess(result);
            if (!fields(response, ['state','csrfToken']) || typeof response.csrfToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(response.csrfToken)) throw invalid();
            return response;
        }
        function clientList(state) {
            const unlimited = state?.remaining === null;
            if (!fields(state, unlimited ? ['status','clients','remaining','nextCursor'] : ['status','clients','remaining']) ||
                !['clients','clients_read_only'].includes(state.status) || state.status === 'clients_read_only' && !unlimited || !Array.isArray(state.clients) ||
                (unlimited ? state.clients.length > 50 || state.nextCursor !== null &&
                    (typeof state.nextCursor !== 'string' || !/^[A-Za-z0-9_-]{1,16384}$/.test(state.nextCursor))
                    : !Number.isSafeInteger(state.remaining) || state.remaining < 0 ||
                        state.remaining > Number.MAX_SAFE_INTEGER - state.clients.length)) throw invalid();
            const ids = new Set();
            state.clients.forEach(function (client) {
                if (!fields(client, ['requestId','organisationName','status']) || !UUID.test(client.requestId) || !validLabel(client.organisationName) ||
                    !['ready','pending','details_required'].includes(client.status) || ids.has(client.requestId)) throw invalid();
                ids.add(client.requestId);
            });
            return state.clients;
        }
        function hideSavedActions() {
            elements.choices.querySelectorAll('.client-workspace-row').forEach(function (row) {
                row.querySelectorAll('button').forEach(function (action) { action.remove(); });
            });
        }
        function recoverClient() {
            hideSavedActions();
            const savedId = pending.requestId;
            status.textContent = (pending.action === 'accept' ? 'Acceptance is not confirmed. Check this saved client before accepting again. '
                : 'Client setup is not confirmed. Check and resume this saved client. ')
                + 'We will use any recorded acceptance to finish setup, or return to the same terms.';
            content.replaceChildren(button('Check and resume saved setup', function () { run({ action: 'resume', requestId: savedId }); }));
        }
        async function run(body, cursor) {
            if (!available() || body && writesClosed) return;
            cycle.clientMutationPending = !!body;
            cycle.clientReadPending = !body;
            cycle.busy = true; section.setAttribute('aria-busy', 'true');
            const controls = Array.from(content.querySelectorAll('button')).concat(Array.from(content.querySelectorAll('input')));
            const disabled = controls.map(function (control) { const previous = control.disabled; control.disabled = true; return [control, previous]; });
            let submitted = false;
            status.textContent = body ? 'Saving your progress…' : 'Checking your saved client organisations…';
            if (body) {
                pending = body; requestId = body.requestId;
                if (body.action === 'create' && validLabel(body.organisationName)) clientNames.set(requestId, body.organisationName);
            }
            try {
                if (body?.action === 'accept') {
                    // A read checks recent identity just before the deliberate
                    // submission. It does not renew proof or authorise consent;
                    // the server rechecks every durable boundary afterwards.
                    status.textContent = 'Confirming your sign-in before submitting acceptance…';
                    const fresh = envelope(await request(cycle, '/api/customer-signup/clients' +
                        (unlimitedList ? '?requestId=' + body.requestId : ''), undefined, undefined, csrf));
                    if (!current(cycle)) return;
                    const freshClients = clientList(fresh.state);
                    if (fresh.state.status === 'clients_read_only') {
                        pending = null; cycle.clientDraft = null; render(fresh.state); return;
                    }
                    const client = freshClients.find(function (item) { return item.requestId === body.requestId; });
                    if (!client || client.status === 'details_required') throw invalid();
                    csrf = fresh.csrfToken;
                    if (client.status === 'ready') { pending = null; render({ status: 'ready', organisationName: client.organisationName }, body.requestId); return; }
                    status.textContent = 'Recording your acceptance and opening this client dashboard…';
                }
                submitted = !!body;
                const selectedCursor = cursor === undefined ? listCursor : cursor;
                let result = await request(cycle, '/api/customer-signup/clients' +
                    (!body && selectedCursor ? '?cursor=' + encodeURIComponent(selectedCursor) : ''), body, undefined, csrf);
                if (!current(cycle)) return;
                if (result.status === 409 && fields(result.value, ['code']) &&
                    ['starter_client_limit', 'starter_details_locked'].includes(result.value.code)) {
                    // These closed responses definitively reject this command.
                    // Reconcile with GET; never repeat it or restore its form.
                    pending = null; captureForm = null; cycle.clientDraft = null;
                    listCursor = null;
                    content.replaceChildren(); status.textContent = 'Client setup changed. Checking your current client organisations…';
                    result = await request(cycle, '/api/customer-signup/clients', undefined, undefined, csrf);
                }
                const response = envelope(result);
                if (!current(cycle)) return;
                const previous = pending;
                if (!body) {
                    if (response.state?.remaining === null && response.state.nextCursor !== null &&
                        response.state.nextCursor === selectedCursor) throw invalid();
                    listCursor = selectedCursor;
                }
                csrf = response.csrfToken; render(response.state, body && body.requestId);
                if (!body && cursor !== undefined) {
                    const firstAction = elements.choices.querySelector('.client-workspace-row button');
                    heading.tabIndex = -1; (firstAction || heading).focus();
                }
                if (pending === previous) pending = null;
            } catch (error) {
                if (!current(cycle)) return;
                if ([401, 403].includes(error.status)) {
                    pending = null; captureForm = null; cycle.clientDraft = null; clientNames.clear(); content.replaceChildren();
                    elements.choices.querySelectorAll('.client-workspace-row').forEach(function (row) { row.remove(); });
                }
                if (error.status === 401) {
                    const confirmation = element('h3', 'Confirm your sign-in to continue'); confirmation.tabIndex = -1; content.append(confirmation);
                    status.textContent = body?.action === 'accept'
                        ? submitted ? 'Acceptance is not confirmed. Sign in again, then check the same saved client before accepting again.'
                            : 'This attempt has not submitted acceptance. Sign in again, then open the same saved client to check its status and continue.'
                        : 'Sign in again to confirm your identity before setting up clients. Open the saved client afterwards to check its recorded progress.';
                    const link = element('a', 'Sign in again to continue');
                    link.href = customerReauthentication; link.className = 'client-action client-action-primary'; content.append(link);
                    confirmation.focus();
                    return;
                }
                if (pending && ['accept','resume'].includes(pending.action)) { recoverClient(); return; }
                if (pending) hideSavedActions();
                status.textContent = pending ? 'We could not confirm this step. Retry to check the same request.'
                    : 'We could not load your current client organisations. Retry to refresh the list.';
                const retry = button('Retry', function () { retry.remove(); run(pending || undefined, cursor); }); content.replaceChildren(retry);
            } finally { if (current(cycle)) {
                disabled.forEach(function (entry) { entry[0].disabled = entry[1]; });
                cycle.busy = false; section.setAttribute('aria-busy', 'false');
                cycle.clientMutationPending = false; cycle.clientReadPending = false;
            } }
        }
        function form(existing, draft) {
            if (writesClosed) return;
            requestId = draft ? draft.requestId : existing ? existing.requestId : secureId(); content.replaceChildren();
            const form = element('form'); form.className = 'consultant-client-form'; const inputs = {};
            [['organisationName','Client organisation name',120],['name','Your full name',160],['role','Your role for this client',120],
                ['address','Client business address',500],['registrationId','NZBN (optional)',160]].forEach(function (field) {
                const label = element('label', field[1]), input = element('input'); input.type = 'text'; input.name = field[0];
                input.maxLength = field[2]; input.required = field[0] !== 'registrationId'; label.append(input);
                if (field[0] === 'registrationId') {
                    const help = element('span', 'The client organisation’s New Zealand Business Number, if it has one.');
                    help.className = 'field-help'; help.setAttribute('id', 'client-nzbn-help');
                    input.setAttribute('aria-label', field[1]); input.setAttribute('aria-describedby', 'client-nzbn-help'); label.append(help);
                }
                form.append(label); inputs[field[0]] = input;
            });
            const authority = element('label', 'I am authorised to set up this dashboard and accept the terms for this client.');
            const confirmed = element('input'); confirmed.type = 'checkbox'; confirmed.required = true; authority.prepend(confirmed); form.append(authority);
            const submit = element('button', 'Review client terms'); submit.type = 'submit'; submit.className = 'client-action client-action-primary'; form.append(submit);
            form.addEventListener('submit', function (event) {
                event.preventDefault(); if (!confirmed.checked || cycle.busy) return;
                const details = {}; ['name','role','address','registrationId'].forEach(function (k) { details[k] = inputs[k].value; }); details.authorityConfirmed = true;
                run({ action: 'create', requestId: requestId, organisationName: inputs.organisationName.value, details: details });
            });
            content.append(form); inputs.organisationName.focus();
            if (existing) { inputs.organisationName.value = existing.organisationName; inputs.organisationName.readOnly = true; }
            if (draft) {
                Object.keys(inputs).forEach(function (key) { inputs[key].value = draft.values[key]; });
                confirmed.checked = draft.authorityConfirmed;
            }
            captureForm = function () {
                if (pending || cycle.busy) return null;
                const values = {}; Object.keys(inputs).forEach(function (key) { values[key] = inputs[key].value; });
                return { requestId: requestId, existing: !!existing, values: values, authorityConfirmed: confirmed.checked, listCursor: listCursor,
                    generation: cycle.session.generation, bindingId: cycle.session.selectedBindingId };
            };
        }
        function render(state, responseRequestId) {
            captureForm = null;
            content.replaceChildren(); status.textContent = '';
            if (['clients','clients_read_only'].includes(state?.status)) {
                const clients = clientList(state);
                const readOnly = state.status === 'clients_read_only';
                writesClosed = readOnly;
                if (readOnly) csrf = null;
                heading.textContent = readOnly ? 'Saved organisation setups' : 'Add organisation';
                unlimitedList = state.remaining === null;
                content.append(element('p', 'Organisations added here share your account’s original access period.'));
                // Only the directory grants ready workspaces. Saved setup
                // records contribute incomplete rows to the same list.
                elements.choices.querySelectorAll('.client-workspace-row').forEach(function (row) { row.remove(); });
                elements.choices.querySelectorAll('.consultant-organisation-empty').forEach(function (row) { row.remove(); });
                let incomplete = 0;
                clientNames.clear();
                clients.forEach(function (client) {
                    clientNames.set(client.requestId, client.organisationName);
                    if (client.status === 'ready') return;
                    incomplete += 1;
                    const row = element('div'); row.className = 'client-workspace-row';
                    row.dataset.requestId = client.requestId;
                    row.append(element('h3', client.organisationName), element('p', client.status === 'details_required' ? 'Client details needed' : 'Setup saved · check terms and completion status'));
                    let action;
                    if (!readOnly && client.status === 'details_required') action = button('Continue details', function () { if (available()) form(client); });
                    if (!readOnly && client.status === 'pending') action = button('Continue setup', function () {
                        run({ action: 'resume', requestId: client.requestId });
                    });
                    if (action) { action.setAttribute('aria-label', (client.status === 'pending' ? 'Continue setup: ' : 'Continue details: ') + client.organisationName); row.append(action); }
                    elements.choices.append(row);
                });
                if (!cycle.directoryRows?.length && !incomplete) {
                    const empty = element('p', 'No organisations available yet.'); empty.className = 'consultant-organisation-empty';
                    elements.choices.append(empty);
                }
                if (readOnly) content.append(element('p', 'Your saved organisation setups have been kept. Further setup steps are currently unavailable.'));
                else if (unlimitedList || state.remaining > 0) {
                    content.append(element('p', unlimitedList ? 'There is no product limit on the number of organisations you can manage. Each organisation needs its own authorised access and agreed scope.'
                        : state.remaining + (state.remaining === 1 ? ' client slot remains.' : ' client slots remain.')));
                    content.append(button('Add organisation', function () { if (available()) form(); }));
                } else content.append(element('p', 'No client slots remain.'));
                if (unlimitedList && state.nextCursor !== null) content.append(button('More saved setups', function () { run(undefined, state.nextCursor); }));
                if (unlimitedList && listCursor !== null) content.append(button('First saved setups', function () { run(undefined, null); }));
                // A routine focus/cache refresh retains inputs or the exact
                // unresolved command in memory. Session, directory and client reads
                // must all succeed before restoring them to the page.
                const draft = readOnly ? null : cycle.clientDraft; cycle.clientDraft = null;
                if (readOnly) pending = null;
                if (draft?.pending) {
                    // A cancelled fetch cannot prove the command was cancelled.
                    // Keep its exact body and ID for an explicit retry.
                    pending = draft.pending; requestId = pending.requestId; content.replaceChildren();
                    hideSavedActions();
                    if (['accept','resume'].includes(pending.action)) recoverClient();
                    else {
                        status.textContent = 'Check your previous client setup request before starting another.';
                        content.append(button('Retry previous client setup', function () { run(pending); }));
                    }
                } else if (draft) {
                    const existing = state.clients.find(function (client) { return client.requestId === draft.requestId; });
                    if (draft.existing ? existing?.status === 'details_required' && existing.organisationName === draft.values.organisationName
                        : !existing && (unlimitedList || state.remaining > 0)) form(existing, draft);
                }
            } else if (state?.status === 'setup_read_only' && fields(state, ['status'])) {
                writesClosed = true; csrf = null; heading.textContent = 'Saved organisation setups';
                pending = null; cycle.clientDraft = null;
                hideSavedActions();
                content.append(element('p', 'Your saved organisation setup has been kept. Further setup steps are currently unavailable.'),
                    button('Back to saved setups', function () { run(); }));
            } else if (state?.status === 'terms' && typeof state.termsText === 'string' && typeof state.scheduleText === 'string' &&
                DIGEST.test(state.termsDigest) && DIGEST.test(state.scheduleDigest) && typeof state.scheduleId === 'string' && UUID.test(responseRequestId)) {
                content.append(element('h3', 'Review the schedule and terms for ' + (clientNames.get(responseRequestId) || 'this client')));
                content.append(element('p', 'This client setup is saved. Acceptance has not been confirmed. We will check your recent sign-in before submitting; if confirmation is needed, return to this same client.'));
                const schedule = element('section'); schedule.className = 'client-terms-section';
                const scheduleHeading = element('h4', 'Client schedule'); scheduleHeading.id = 'clientScheduleHeading';
                schedule.setAttribute('aria-labelledby', scheduleHeading.id);
                const scheduleText = element('p', state.scheduleText); scheduleText.className = 'client-signup-terms';
                schedule.append(scheduleHeading, scheduleText);
                const terms = element('details'); terms.className = 'client-terms-section'; terms.open = true;
                const termsHeading = element('summary', 'Dashboard terms'); termsHeading.id = 'clientTermsHeading';
                terms.setAttribute('aria-labelledby', termsHeading.id);
                const termsText = element('p', state.termsText); termsText.className = 'client-signup-terms';
                terms.append(termsHeading, termsText); content.append(schedule, terms);
                const label = element('label', 'I have read and accept this client’s schedule and dashboard terms.');
                label.className = 'client-consent';
                const accepted = element('input'); accepted.type = 'checkbox'; label.prepend(accepted); content.append(label);
                const accept = button('Accept and create client dashboard', function () {
                    if (!accepted.checked) { status.textContent = 'Read and accept the terms to continue.'; return; }
                    run({ action: 'accept', requestId: responseRequestId, terms: { accepted: true, termsVersion: state.termsVersion,
                        termsDigest: state.termsDigest, scheduleId: state.scheduleId, scheduleDigest: state.scheduleDigest } });
                }); accept.classList.add('client-action-primary'); content.append(accept);
            } else if (fields(state, ['status']) && state.status === 'resume_acceptance' && UUID.test(responseRequestId)) {
                content.append(element('p', 'Your terms acceptance is saved. Complete this client setup using the same saved acceptance.'));
                content.append(button('Complete client setup', function () {
                    run({ action: 'resume_acceptance', requestId: responseRequestId });
                }));
            } else if (state?.status === 'ready') {
                elements.choices.querySelectorAll('.client-workspace-row').forEach(function (row) {
                    if (row.dataset.requestId === responseRequestId) row.remove();
                });
                content.append(element('p', 'Client dashboard ready. Choose it from your organisations.'));
                content.append(button('Refresh organisations', function () { const next = begin(); next.forcePortfolio = true;
                    reconcile(next, 0, false).catch(function (error) { failure(next, error); }); }));
            } else throw invalid();
        }
        // The directory is already authenticated. Defer until show() releases
        // its current turn; every response remains bound to this same cycle.
        Promise.resolve().then(function () { if (current(cycle)) run(); });
    }
    function portfolioControls(cycle) {
        if (!portfolioButton) {
            portfolioButton = document.createElement('button');
            portfolioButton.id = 'consultantPortfolioControls'; portfolioButton.type = 'button';
            portfolioButton.textContent = 'Return to organisations';
            // A details chooser closes while the dashboard is open.
            elements.panel.append(portfolioButton);
        }
        portfolioButton.hidden = false;
        portfolioButton.onclick = function () {
            if (!current(cycle) || cycle.busy || cycle.authorityPending || unresolved) return;
            leave(cycle, function () {
                window.history.replaceState(null, '', '#organisations');
                const next = begin(); next.forcePortfolio = true;
                reconcile(next, 0, false).catch(function (error) { failure(next, error); });
            });
        };
    }
    async function cyberOptions(cycle, snapshot, organisationId) {
        const value = requireSuccess(await request(cycle, '/api/dashboard/modules/cyber_security', undefined, snapshot.generation));
        if (!current(cycle)) throw invalid();
        const contract = cyberContract(value);
        if (value.context?.organisationId !== organisationId) throw invalid();
        cycle.cyberContract = contract;
        const clientFactory = window.NoFriesNcscAssessmentClient;
        const questionnaire = window.NoFriesNcscQuestionnaire;
        if (!clientFactory || typeof clientFactory.createClient !== 'function' ||
            !questionnaire || typeof questionnaire.mount !== 'function') throw invalid();
        const client = clientFactory.createClient({ metadata: value.metadata, fetch: async function (path, options) {
            if (!current(cycle) || cycle.authorityPending) throw invalid();
            // The existing client owns the bounded endpoint and command schema.
            // Bind transport to this exact selection; caller-supplied generations
            // cannot replace the dashboard snapshot.
            const result = await fetch(path, Object.assign({}, options, { headers: Object.assign({}, options.headers,
                { 'X-NoFries-Dashboard-Generation': snapshot.generation }) }));
            if (!current(cycle)) throw invalid();
            if (result && [401, 403].includes(result.status)) {
                const error = invalid(); error.status = result.status; failure(cycle, error); throw error;
            }
            return result;
        } });
        const mountCyber = function (root, presentation) {
            if (!current(cycle)) throw invalid();
            return questionnaire.mount(root, { window: window, metadata: value.metadata, client: client,
                presentationMode: value.presentationMode, organisationId: organisationId,
                initialAssessmentId: presentation && presentation.initialAssessmentId });
        };
        const picture = window.NoFriesOrganisationPicture;
        let pictureSelection = null;
        if (picture && typeof picture.mount === 'function') {
            mountCyber.mountPicture = function (root, presentation) {
                if (!current(cycle)) throw invalid();
                return picture.mount(root, { metadata: value.metadata, client: client, organisationId: organisationId,
                    displayName: presentation.displayName,
                    initialAssessmentId: pictureSelection,
                    onSelection: function (assessmentId) { if (current(cycle)) pictureSelection = assessmentId; },
                    openCyber: presentation.openCyber,
                    ...(typeof presentation.openImprovement === 'function' ? { openImprovement: function (sourceAssessment) {
                        if (!current(cycle) || cycle.authorityPending) return Promise.resolve(false);
                        return presentation.openImprovement(sourceAssessment);
                    } } : {}) });
            };
        }
        return mountCyber;
    }
    function improvementOptions(cycle, snapshot, organisationId) {
        const factory = window.NoFriesImprovementActionPlanClient;
        if (!factory || typeof factory.mount !== 'function') throw invalid();
        return function (root, presentation) {
            if (!current(cycle) || cycle.authorityPending) throw invalid();
            return factory.mount(root, {
                organisationId: organisationId,
                sourceAssessment: presentation && presentation.sourceAssessment,
                newId: secureId,
                isCurrent: function () { return current(cycle) && !cycle.authorityPending; },
                request: async function (path, body) {
                    if (!current(cycle) || cycle.authorityPending) throw invalid();
                    // The existing request wrapper owns current generation,
                    // cookies, media, origin, budget and cancellation behavior.
                    const result = await request(cycle, path, body, snapshot.generation);
                    if (!current(cycle) || cycle.authorityPending) throw invalid();
                    if ([401, 403].includes(result.status)) {
                        const error = invalid(); error.status = result.status; failure(cycle, error); throw error;
                    }
                    return result;
                }
            });
        };
    }
    function cyberContract(value) {
        if (!fields(value, ['schemaVersion', 'context', 'generatedAt', 'module', 'summary', 'services',
            'admissionGranted', 'providerAccessGranted', 'metadata', 'presentationMode']) ||
            value.schemaVersion !== 1 || value.module?.key !== 'cyber_security' || value.module?.state !== 'ready' ||
            value.admissionGranted !== false || value.providerAccessGranted !== false ||
            !['editable', 'read-only'].includes(value.presentationMode)) throw invalid();
        return JSON.stringify([value.metadata, value.presentationMode, value.context, value.module]);
    }
    function leave(cycle, commit) {
        if (!current(cycle)) return Promise.resolve(false);
        const guardedCommit = function () { if (current(cycle)) commit(); };
        if ((cycle.cyber || cycle.improvement) && controller && typeof controller.requestLeave === 'function') return controller.requestLeave(guardedCommit);
        guardedCommit();
        return Promise.resolve(true);
    }
    const leaveLinks = Array.from(document.querySelectorAll('[data-dashboard-home]'))
        .concat(Array.from(document.querySelectorAll('[data-dashboard-leave]')));
    leaveLinks.forEach(function (link) {
        link.addEventListener('click', function (event) {
            // New-tab/modified clicks keep the current document and its draft.
            if (event.defaultPrevented || event.button > 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            const browsingTarget = link.getAttribute('target');
            if (browsingTarget && browsingTarget !== '_self' || link.getAttribute('download') !== null) return;
            const destination = link.getAttribute('href');
            if (!destination) return;
            if (linkExit) { event.preventDefault(); return; }
            const cycle = active;
            if (!controller || !current(cycle)) return;
            event.preventDefault();
            if (cycle.busy || cycle.authorityPending || unresolved) return;
            const exit = { cycle: cycle, committed: false };
            linkExit = exit;
            Promise.resolve(leave(cycle, function () {
                exit.committed = true;
                dispose(cycle);
                clearContent();
                window.location.assign(destination);
            })).catch(function () {
                // Failed leave decisions retain the current view and its draft.
            }).finally(function () {
                if (linkExit === exit && !exit.committed) linkExit = null;
            });
        });
    });
    function validLabel(value) {
        return typeof value === 'string' && value.trim().length > 0 && value.length <= 200 &&
            !/[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(value);
    }
    async function directory(cycle, value, previous, cursor, refresh, quiet) {
        const pageCount = cursor === null ? 1 : cycle.directoryPageCount + 1;
        const path = '/api/dashboard/organisations?limit=50' + (cursor === null ? '' : '&afterBindingId=' + cursor);
        const page = requireSuccess(await request(cycle, path, undefined, undefined, undefined, refresh));
        if (!current(cycle) || refresh && !currentRefresh(cycle, refresh)) return;
        if (!fields(page, ['schemaVersion', 'bindings', 'nextAfterBindingId']) || page.schemaVersion !== 1 ||
            !Array.isArray(page.bindings) || page.bindings.length > 50 ||
            page.nextAfterBindingId !== null && (typeof page.nextAfterBindingId !== 'string' || !UUID.test(page.nextAfterBindingId))) throw invalid();
        let last = cursor;
        page.bindings.forEach(function (binding) {
            if (!fields(binding, ['bindingId', 'organisationLabel']) || typeof binding.bindingId !== 'string' || !UUID.test(binding.bindingId) || !validLabel(binding.organisationLabel) ||
                last !== null && binding.bindingId <= last) throw invalid();
            last = binding.bindingId;
        });
        if (page.nextAfterBindingId !== null && (!page.bindings.length || page.nextAfterBindingId !== last || page.nextAfterBindingId === cursor)) throw invalid();
        const rows = previous.concat(page.bindings.map(function (row) { return Object.freeze({ bindingId: row.bindingId, organisationLabel: row.organisationLabel }); }));
        if (quiet) return { rows: rows, nextAfterBindingId: page.nextAfterBindingId };
        renderDirectory(cycle, value, rows, page.nextAfterBindingId, pageCount);
    }
    async function refreshDirectory(cycle, value, refresh) {
        // Recheck only pages explicitly loaded with More. Use fresh cursors,
        // stage every page and keep the old list until the final session check.
        const requestedPages = cycle.directoryPageCount;
        let choices = { rows: [], nextAfterBindingId: null };
        for (let pageCount = 1; pageCount <= requestedPages; pageCount += 1) {
            choices = await directory(cycle, value, choices.rows, choices.nextAfterBindingId, refresh, true);
            if (!currentRefresh(cycle, refresh)) return;
            choices.pageCount = pageCount;
            if (choices.nextAfterBindingId === null) break;
        }
        return choices;
    }
    function renderDirectory(cycle, value, rows, nextAfterBindingId, pageCount) {
        cycle.directoryPageCount = pageCount;
        const contract = JSON.stringify([value.generation, value.selectedBindingId, rows, nextAfterBindingId]);
        if (cycle.directoryContract === contract) return;
        cycle.directoryRows = rows;
        cycle.directoryContract = contract;
        // Keep incomplete client rows and their focused controls when a fresh
        // directory read changes only the ready bindings.
        const children = Array.from(elements.choices.children);
        const incomplete = children.filter(function (child) { return child.classList.contains('client-workspace-row'); });
        const existing = new Map(children.filter(function (child) { return child.tagName === 'BUTTON' && child.getAttribute('data-binding-id'); })
            .map(function (child) { return [child.getAttribute('data-binding-id'), child]; }));
        const focused = document.activeElement;
        const choices = rows.map(function (binding) {
            let button = existing.get(binding.bindingId);
            if (!button) {
                button = document.createElement('button');
                button.type = 'button';
                button.setAttribute('data-binding-id', binding.bindingId);
                button.addEventListener('click', function () {
                    if (!current(cycle) || cycle.busy || cycle.authorityPending || unresolved || blockPendingClientNavigation(cycle)) return;
                    leave(cycle, function () {
                        const next = begin();
                        try {
                            const pending = command('selection', { bindingId: binding.bindingId, expectedGeneration: value.generation, operationId: secureId() });
                            execute(next, pending).catch(function (error) { failure(next, error); });
                        } catch (error) { failure(next, error); }
                    });
                });
            }
            button.textContent = binding.organisationLabel;
            if (value.accountType === 'consultant') {
                button.className = 'consultant-organisation-ready';
                button.setAttribute('aria-label', binding.organisationLabel + ' · Dashboard ready');
            }
            button.setAttribute('aria-pressed', String(binding.bindingId === value.selectedBindingId));
            return button;
        });
        choices.push(...incomplete);
        if (!rows.length && !incomplete.length && (value.accountType !== 'consultant' || !value.clientSetupAvailable)) {
            const empty = document.createElement('p'); empty.textContent = 'No organisations available yet.';
            empty.className = 'consultant-organisation-empty';
            choices.push(empty);
        }
        // Remember focus while its node is still attached. Replacing children
        // may move the browser's activeElement to the document body.
        const retainFocus = focused && (choices.includes(focused) || incomplete.some(function (row) {
            return Array.from(row.querySelectorAll('button')).includes(focused);
        }));
        elements.choices.replaceChildren(...choices);
        if (retainFocus) focused.focus();
        elements.chooser.hidden = !!cycle.authorityPending;
        elements.more.hidden = nextAfterBindingId === null;
        elements.more.onclick = function () {
            if (!current(cycle) || cycle.busy || cycle.authorityPending || unresolved || nextAfterBindingId === null ||
                blockPendingClientNavigation(cycle)) return;
            leave(cycle, function () {
                let ownsFocus = document.activeElement === elements.more;
                if (value.accountType === 'consultant') window.history.replaceState(null, '', '#organisations');
                const next = begin();
                const focusEvents = ['focusin', 'pointerdown', 'keydown', 'blur'];
                function releaseFocus() {
                    focusEvents.forEach(function (name) { window.removeEventListener(name, movedFocus, true); });
                }
                function movedFocus(event) {
                    // Hiding More can naturally leave focus on the body. A
                    // later user action or focus on another control ends this
                    // operation's ownership, even if focus subsequently returns.
                    if (event.type === 'focusin' && [elements.more, document.body, document.documentElement].includes(event.target)) return;
                    ownsFocus = false;
                }
                if (ownsFocus) {
                    focusEvents.forEach(function (name) { window.addEventListener(name, movedFocus, true); });
                    next.cleanup.push(releaseFocus);
                }
                remember(next, value);
                next.directoryPageCount = cycle.directoryPageCount;
                directory(next, value, rows, nextAfterBindingId).then(function () {
                    if (!current(next)) return;
                    if (Date.parse(value.expiresAt) <= Date.now()) { const error = invalid(); error.expired = true; throw error; }
                    releaseFocus();
                    next.busy = false;
                    show(next, 'selection', false);
                    if (!ownsFocus || ![elements.more, document.body, document.documentElement, null].includes(document.activeElement)) return;
                    const ready = Array.from(elements.choices.children).filter(function (node) {
                        return node.tagName === 'BUTTON' && node.getAttribute('data-binding-id');
                    });
                    const target = ready[rows.length] || ready[ready.length - 1] || elements.heading;
                    target.focus();
                }).catch(function (error) { failure(next, error); });
            });
        };
        cycle.cleanup.push(function () { elements.more.onclick = null; });
    }
    function assets(cycle) {
        function load(tag, metadata, path) {
            return new Promise(function (resolve, reject) {
                const meta = document.getElementById(metadata);
                const integrity = meta && meta.getAttribute('content');
                if (!/^sha256-[A-Za-z0-9+/]{43}=$/.test(integrity || '')) { reject(invalid()); return; }
                const node = document.createElement(tag);
                let settled = false;
                function finish(error) {
                    if (settled) return;
                    settled = true;
                    window.clearTimeout(timer);
                    node.onload = null;
                    node.onerror = null;
                    if (!current(cycle) || error) reject(error || invalid());
                    else resolve();
                }
                const timer = window.setTimeout(function () { finish(invalid()); }, REQUEST_MS);
                cycle.cleanup.push(function () {
                    finish(invalid());
                    if (node.parentNode) node.parentNode.removeChild(node);
                });
                node.integrity = integrity;
                node.crossOrigin = 'anonymous';
                if (tag === 'script') { node.src = path; node.async = true; }
                else { node.rel = 'stylesheet'; node.href = path; }
                node.onload = function () { finish(); };
                node.onerror = function () { finish(invalid()); };
                document.head.append(node);
            });
        }
        return Promise.all([load('script', 'dashboardApplicationIntegrity', '/api/dashboard/app.js'),
            load('link', 'dashboardStyleIntegrity', '/api/dashboard/dashboard.css')]);
    }
    function start() {
        const cycle = begin(active && active.clientDraft);
        const work = unresolved ? execute(cycle, unresolved) : reconcile(cycle, 0, true);
        work.catch(function (error) { failure(cycle, error); });
    }
    elements.retry.addEventListener('click', function () {
        if (!active || active.busy) return;
        if (active.quietRefreshFailed) revalidate(active);
        else if (active.authorityPending) revalidate(active);
        else start();
    });
    elements.signOut.addEventListener('click', function () {
        if (!active || active.busy || active.authorityPending || unresolved || blockPendingClientNavigation(active)) return;
        leave(active, function () {
            const cycle = begin();
            const pending = command('logout', {});
            execute(cycle, pending).catch(function (error) { failure(cycle, error); });
        });
    });
    function restore() {
        // Share current fresh reads only while they are pending. Completion,
        // failure or pagehide permits the next return to check authority anew.
        if (active && current(active) && active.reconciling && !unresolved) return;
        const cycle = begin(clientDraft(active));
        if (unresolved) { cycle.busy = false; show(cycle, unresolved.kind === 'logout' ? 'signout' : 'unavailable'); return; }
        reconcile(cycle, 0, true).catch(function (error) { failure(cycle, error); });
    }
    function revalidate(cycle) {
        if (!current(cycle) || cycle.revalidating) return;
        const account = !controller && document.body.dataset.dashboardState === 'selection' && !currentRoute();
        const previousStatus = cycle.quietStatus === undefined ? elements.status.textContent : cycle.quietStatus;
        cycle.quietStatus = previousStatus;
        cycle.quietRefreshFailed = false;
        const refresh = { closed: false, requests: new Set() };
        cycle.refresh = refresh;
        cycle.cleanup.push(function () { closeRefresh(refresh); });
        cycle.revalidating = true;
        // The existing session expiry timer remains armed while read-only checks
        // run. The current, still-valid view and local drafts stay usable; every
        // protected request is independently authorised by the server.
        readSession(cycle, refresh).then(async function (fresh) {
            if (!currentRefresh(cycle, refresh)) return;
            if (!sameSession(fresh, cycle.session)) { restore(); return; }
            if (account) {
                const choices = await refreshDirectory(cycle, fresh, refresh);
                if (!currentRefresh(cycle, refresh)) return;
                const confirmed = await readSession(cycle, refresh);
                if (!currentRefresh(cycle, refresh)) return;
                if (!sameSession(fresh, confirmed)) { restore(); return; }
                remember(cycle, confirmed);
                renderDirectory(cycle, confirmed, choices.rows, choices.nextAfterBindingId, choices.pageCount);
                elements.status.textContent = previousStatus;
                elements.retry.hidden = true;
                cycle.quietStatus = undefined;
                return;
            }
            // These GETs share only the fresh session/generation, not response
            // data. A failed group cancels every sibling before retry can begin.
            const middle = await Promise.all([
                refreshDirectory(cycle, fresh, refresh),
                request(cycle, '/api/dashboard/bootstrap', undefined, fresh.generation, undefined, refresh).then(requireSuccess),
                cycle.cyber ? request(cycle, '/api/dashboard/modules/cyber_security', undefined,
                    fresh.generation, undefined, refresh).then(requireSuccess) : null
            ]);
            if (!currentRefresh(cycle, refresh)) return;
            const projection = middle[1];
            let model;
            try { model = window.NoFriesDashboard.validate(projection); }
            catch (error) { failure(cycle, error); return; }
            if (displayContract(model) !== cycle.displayContract) { restore(); return; }
            if (cycle.cyber) {
                let contract;
                try { contract = cyberContract(middle[2]); } catch (_) { restore(); return; }
                if (contract !== cycle.cyberContract) { restore(); return; }
            }
            const confirmed = await readSession(cycle, refresh);
            if (!currentRefresh(cycle, refresh)) return;
            if (!sameSession(fresh, confirmed)) { restore(); return; }
            remember(cycle, confirmed);
            renderDirectory(cycle, confirmed, middle[0].rows, middle[0].nextAfterBindingId, middle[0].pageCount);
            elements.status.textContent = previousStatus;
            elements.retry.hidden = true;
            cycle.quietStatus = undefined;
        }).catch(function (error) {
            if (!currentRefresh(cycle, refresh)) return;
            closeRefresh(refresh);
            if (error && (error.expired || [401, 403].includes(error.status))) { failure(cycle, error); return; }
            if (error && error.validation && (!error.status || error.status < 500)) { failure(cycle, error); return; }
            // A transport failure has not extended authority. Keep the old
            // view only until its original expiry timer, with a retry affordance.
            elements.status.textContent = 'Could not refresh access. Retry when the service is available.';
            elements.retry.hidden = false;
            cycle.quietRefreshFailed = true;
        }).finally(function () {
            closeRefresh(refresh);
            if (cycle.refresh === refresh) { cycle.refresh = null; cycle.revalidating = false; }
        });
    }
    window.addEventListener('focus', function () {
        const cycle = active;
        if (cycle && current(cycle) && cycle.session && Date.parse(cycle.session.expiresAt) > Date.now() &&
            !unresolved && (controller || document.body.dataset.dashboardState === 'selection' && !currentRoute()) &&
            !cycle.clientMutationPending) { revalidate(cycle); return; }
        restore();
    });
    window.addEventListener('pageshow', function (event) { if (event && event.persisted) restore(); });
    window.addEventListener('pagehide', function () {
        if (active) { active.clientDraft = clientDraft(active); active.captureClientDraft = null; }
        dispose(active);
        clearContent();
    });
    start();
}());
