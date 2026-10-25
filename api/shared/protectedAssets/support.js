(function () {
    if (document.body.dataset.page !== 'service-desk') return;

    const elements = {
        loadingPanel: document.getElementById('loadingPanel'),
        supportApp: document.getElementById('supportApp'),
        tenantName: document.getElementById('tenantName'),
        userIdentity: document.getElementById('userIdentity'),
        runtimeStatus: document.getElementById('runtimeStatus'),
        runtimeMessage: document.getElementById('runtimeMessage'),
        pendingOperation: document.getElementById('pendingOperation'),
        pendingOperationMessage: document.getElementById('pendingOperationMessage'),
        ticketList: document.getElementById('ticketList'),
        newTicketButton: document.getElementById('newTicketButton'),
        newTicketView: document.getElementById('newTicketView'),
        noReadyCustomers: document.getElementById('noReadyCustomers'),
        ticketView: document.getElementById('ticketView'),
        ticketForm: document.getElementById('ticketForm'),
        customerSelect: document.getElementById('customerId'),
        customerReadiness: document.getElementById('customerReadiness'),
        deviceSelect: document.getElementById('deviceId'),
        requesterEmail: document.getElementById('requesterEmail'),
        createTicketButton: document.getElementById('createTicketButton'),
        formStatus: document.getElementById('formStatus'),
        ticketReference: document.getElementById('ticketReference'),
        ticketTitle: document.getElementById('ticketTitle'),
        ticketMeta: document.getElementById('ticketMeta'),
        ticketStatus: document.getElementById('ticketStatus'),
        refreshTicketButton: document.getElementById('refreshTicketButton'),
        ticketProjectionStatus: document.getElementById('ticketProjectionStatus'),
        ticketTimeline: document.getElementById('ticketTimeline'),
        replyCard: document.getElementById('replyCard'),
        replyForm: document.getElementById('replyForm'),
        replyMessage: document.getElementById('replyMessage'),
        replyButton: document.getElementById('replyButton'),
        replyStatus: document.getElementById('replyStatus'),
        toast: document.getElementById('toast')
    };
    const API_TIMEOUT_MS = 15000;
    const PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000;
    const PENDING_KEY = 'nofries.support.pending-operation.v2';
    const OPERATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const TERMINAL_OPERATION_STATES = new Set(['completed', 'known_absent', 'rejected']);
    const state = {
        bootstrap: null,
        tickets: [],
        currentTicketKey: '',
        busy: false,
        writesEnabled: false,
        pending: null,
        repeatConfirmationTokens: new Map(),
        toastTimer: null
    };
    let started = false;

    window.NoFriesSupport = { start };

    function start(bootstrap) {
        if (started) return;
        assertProductionBootstrap(bootstrap);
        started = true;
        state.bootstrap = bootstrap;
        state.tickets = Array.isArray(bootstrap.tickets) ? bootstrap.tickets : [];
        state.writesEnabled = bootstrap.runtime.externalChanges === true &&
            bootstrap.runtime.durableOperationFence === true;
        state.pending = readPending();

        elements.ticketForm.addEventListener('submit', createTicket);
        elements.replyForm.addEventListener('submit', replyToTicket);
        elements.newTicketButton.addEventListener('click', showNewTicket);
        elements.ticketList.addEventListener('click', selectTicketFromList);
        elements.customerSelect.addEventListener('change', renderCustomerDevices);
        elements.refreshTicketButton.addEventListener('click', refreshCurrentTicket);

        elements.tenantName.textContent = bootstrap.tenant.name;
        elements.userIdentity.textContent = `${bootstrap.user.email || bootstrap.user.name || 'Signed-in operator'} · ${formatLabel(bootstrap.user.role)}`;
        renderRuntime();
        renderCustomers();
        renderTicketList();
        renderPending();
        if (state.tickets.length) selectTicket(ticketKey(state.tickets[0]));
        else showNewTicket();
        elements.loadingPanel.hidden = true;
        elements.supportApp.hidden = false;
        document.body.classList.remove('support-loading');
    }

    function assertProductionBootstrap(bootstrap) {
        const runtime = bootstrap && bootstrap.runtime;
        if (!runtime || runtime.mode !== 'production' || runtime.provider !== 'autotask' || runtime.sourceOfTruth !== true) {
            const error = new Error('The production Autotask service desk is not active.');
            error.code = 'production_service_desk_required';
            throw error;
        }
    }

    function renderRuntime() {
        const boundary = elements.runtimeStatus.parentElement;
        if (state.writesEnabled) {
            elements.runtimeStatus.textContent = 'Production · live writes';
            elements.runtimeMessage.textContent = 'Autotask is the source of truth. Ticket creation and customer-visible replies are live.';
            if (boundary && boundary.classList) boundary.classList.remove('is-read-only');
        } else {
            elements.runtimeStatus.textContent = 'Production · read only';
            elements.runtimeMessage.textContent = 'Live Autotask tickets are available, but production writes are currently disabled.';
            if (boundary && boundary.classList) boundary.classList.add('is-read-only');
        }
    }

    function renderCustomers() {
        const customers = state.bootstrap.customers || [];
        const requestedCustomerId = new URLSearchParams(window.location.search).get('customerId') || '';
        elements.customerSelect.innerHTML = customers.map(function (customer) {
            return `<option value="${escapeHtml(customer.id)}">${escapeHtml(customer.name)}</option>`;
        }).join('');
        if (customers.some(function (customer) { return customer.id === requestedCustomerId; })) {
            elements.customerSelect.value = requestedCustomerId;
        }
        const ready = customers.length > 0;
        elements.ticketForm.hidden = !ready;
        elements.noReadyCustomers.hidden = ready;
        elements.newTicketButton.disabled = !ready || !state.writesEnabled;
        elements.createTicketButton.disabled = !state.writesEnabled;
        elements.replyButton.disabled = !state.writesEnabled;
        renderCustomerDevices();
    }

    function renderCustomerDevices() {
        const customer = selectedCustomer();
        const devices = customer && Array.isArray(customer.devices) ? customer.devices : [];
        elements.deviceSelect.innerHTML = devices.map(function (device) {
            return `<option value="${escapeHtml(device.id)}">${escapeHtml(device.label || device.id)}${device.platform ? ` · ${escapeHtml(formatLabel(device.platform))}` : ''}</option>`;
        }).join('');
        elements.customerReadiness.textContent = customer
            ? `Governed support customer · ${devices.length} verified ${devices.length === 1 ? 'device' : 'devices'}`
            : 'Select an eligible customer';
        const requesters = customer && customer.supportProfile &&
            Array.isArray(customer.supportProfile.authorisedRequesters)
            ? customer.supportProfile.authorisedRequesters : [];
        elements.requesterEmail.value = requesters.length ? requesters[0].email || '' : '';
    }

    function selectedCustomer() {
        return (state.bootstrap.customers || []).find(function (customer) {
            return customer.id === elements.customerSelect.value;
        }) || null;
    }

    async function createTicket(event) {
        event.preventDefault();
        if (state.busy || !state.writesEnabled) return;
        const data = new FormData(elements.ticketForm);
        const customer = selectedCustomer();
        const payload = {
            customerId: normaliseOpaqueId(data.get('customerId'), 180),
            customerName: normaliseText(customer && customer.name, 180),
            requesterEmail: normaliseText(data.get('requesterEmail'), 254).toLowerCase(),
            intakeChannel: normaliseId(data.get('intakeChannel'), 40),
            deviceId: normaliseOpaqueId(data.get('deviceId'), 180),
            priority: normaliseId(data.get('priority'), 20),
            subject: normaliseText(data.get('subject'), 160),
            requestText: normaliseText(data.get('requestText'), 8000)
        };
        if (!payload.customerId || !payload.requesterEmail || !payload.deviceId ||
            !payload.subject || !payload.requestText || !['low', 'normal', 'high', 'urgent'].includes(payload.priority)) {
            showToast('Complete the governed customer, requester, device, priority, subject, and request before submitting.', true);
            return;
        }
        await submitMutation({
            action: 'create',
            target: 'new-ticket',
            customerId: payload.customerId,
            payload,
            url: '/api/service-desk/tickets',
            createdMessage: 'Live Autotask ticket created.',
            pendingMessage: 'The create request may still complete in Autotask. Check status again with the same form details.',
            statusElement: elements.formStatus,
            button: elements.createTicketButton
        });
    }

    async function replyToTicket(event) {
        event.preventDefault();
        if (state.busy || !state.writesEnabled) return;
        const ticket = currentTicket();
        const message = normaliseText(elements.replyMessage.value, 8000);
        if (!ticket || !message) return;
        const key = ticketKey(ticket);
        const customerId = ticket.customer && ticket.customer.id || '';
        await submitMutation({
            action: 'reply',
            target: key,
            customerId,
            payload: { customerId, customerName: ticket.customer && ticket.customer.name || '', message },
            url: `/api/service-desk/tickets/${encodeURIComponent(key)}/replies`,
            createdMessage: 'Customer-visible reply published to Autotask.',
            pendingMessage: 'The reply may still publish in Autotask. Check status again with the same message.',
            statusElement: elements.replyStatus,
            button: elements.replyButton
        });
    }

    async function submitMutation(context) {
        setBusy(true, context.statusElement, 'Submitting live change…');
        try {
            const payloadHash = await hashPayload(context.action, context.target, context.payload);
            const pending = ensurePending(context, payloadHash);
            if (!pending) return;
            const requestBody = Object.assign({}, context.payload, { operationId: pending.operationId });
            const token = state.repeatConfirmationTokens.get(pending.operationId);
            if (token) requestBody.repeatConfirmationToken = token;
            let result;
            try {
                result = await api(context.url, {
                    method: 'POST',
                    headers: { 'Idempotency-Key': pending.operationId },
                    body: requestBody
                });
            } catch (error) {
                adoptPendingOperation(error.payload, payloadHash);
                if (isExplicitTerminal(error.payload)) clearPending();
                else renderPending(context.pendingMessage);
                showToast(error.message || context.pendingMessage, true);
                return;
            }
            adoptPendingOperation(result, payloadHash);
            if (result.status === 'confirmation_required') {
                if (validRepeatToken(result.repeatConfirmationToken)) {
                    state.repeatConfirmationTokens.set(state.pending.operationId, result.repeatConfirmationToken);
                }
                renderPending('Autotask found a potentially repeated action. Review the unchanged form and submit once more to confirm it.');
                context.button.textContent = 'Confirm intentional repeat';
                showToast('Review and confirm the intentional repeated action.', true);
                return;
            }
            if (result.status === 'pending') {
                renderPending(context.pendingMessage);
                context.button.textContent = 'Check status again';
                showToast(context.pendingMessage, true);
                return;
            }
            if (result.status !== 'completed' || !result.ticket) {
                renderPending(context.pendingMessage);
                showToast(context.pendingMessage, true);
                return;
            }
            clearPending();
            upsertTicket(result.ticket);
            await selectTicket(ticketKey(result.ticket), false);
            if (context.action === 'reply') elements.replyMessage.value = '';
            context.button.textContent = context.action === 'reply' ? 'Publish live reply' : 'Create live ticket';
            showToast(result.idempotentReplay === true || result.repeated === true
                ? 'The existing completed Autotask operation was confirmed; no duplicate change was made.'
                : context.createdMessage);
        } catch (error) {
            showToast(error && error.message || 'Secure operation recovery is unavailable. No live change was sent.', true);
        } finally {
            setBusy(false, context.statusElement, '');
        }
    }

    function ensurePending(context, payloadHash) {
        if (state.pending) {
            if (state.pending.action !== context.action || state.pending.target !== context.target ||
                state.pending.customerId !== context.customerId || state.pending.payloadHash !== payloadHash) {
                renderPending('A different live submission is still unresolved. Restore its original form values and check status before starting another change.');
                showToast('A different live service-desk operation is still unresolved.', true);
                return null;
            }
            return state.pending;
        }
        state.pending = {
            operationId: newOperationId(),
            action: context.action,
            target: context.target,
            payloadHash,
            customerId: context.customerId,
            createdAt: Date.now()
        };
        persistPending();
        renderPending();
        return state.pending;
    }

    function adoptPendingOperation(payload, payloadHash) {
        if (!state.pending || !payload || typeof payload !== 'object') return;
        const candidate = String(payload.operationId || '').trim().toLowerCase();
        if (!OPERATION_ID_PATTERN.test(candidate) || state.pending.payloadHash !== payloadHash) return;
        if (candidate !== state.pending.operationId && ['pending', 'confirmation_required'].includes(payload.status)) {
            const existingToken = state.repeatConfirmationTokens.get(state.pending.operationId);
            state.repeatConfirmationTokens.delete(state.pending.operationId);
            state.pending.operationId = candidate;
            if (existingToken) state.repeatConfirmationTokens.set(candidate, existingToken);
            persistPending();
        }
    }

    function isExplicitTerminal(payload) {
        return Boolean(payload && TERMINAL_OPERATION_STATES.has(String(payload.status || '')));
    }

    function readPending() {
        let parsed;
        try { parsed = JSON.parse(window.sessionStorage.getItem(PENDING_KEY) || 'null'); }
        catch (_error) { return null; }
        if (!parsed || typeof parsed !== 'object' || !OPERATION_ID_PATTERN.test(String(parsed.operationId || '')) ||
            !['create', 'reply'].includes(parsed.action) || !/^[a-f0-9]{64}$/.test(String(parsed.payloadHash || '')) ||
            !normaliseOpaqueId(parsed.customerId, 180) || !normaliseText(parsed.target, 180) ||
            !Number.isFinite(Number(parsed.createdAt)) || Number(parsed.createdAt) <= 0) return null;
        return {
            operationId: String(parsed.operationId),
            action: parsed.action,
            target: normaliseText(parsed.target, 180),
            payloadHash: String(parsed.payloadHash),
            customerId: normaliseOpaqueId(parsed.customerId, 180),
            createdAt: Number(parsed.createdAt)
        };
    }

    function persistPending() {
        if (!state.pending) return;
        try { window.sessionStorage.setItem(PENDING_KEY, JSON.stringify(state.pending)); }
        catch (_error) { /* in-memory recovery remains active */ }
    }

    function clearPending() {
        if (state.pending) state.repeatConfirmationTokens.delete(state.pending.operationId);
        state.pending = null;
        try { window.sessionStorage.removeItem(PENDING_KEY); }
        catch (_error) { /* in-memory state is already terminal */ }
        renderPending();
    }

    function renderPending(overrideMessage) {
        if (!state.pending) {
            elements.pendingOperation.hidden = true;
            elements.pendingOperationMessage.textContent = '';
            return;
        }
        const old = Date.now() - state.pending.createdAt > PENDING_MAX_AGE_MS;
        const action = state.pending.action === 'reply' ? `reply to ${state.pending.target}` : 'new ticket';
        elements.pendingOperation.hidden = false;
        elements.pendingOperationMessage.textContent = overrideMessage || (old
            ? `The unresolved ${action} is over 24 hours old. It has not been forgotten. Re-enter the original values to check it, or ask a service owner to reconcile operation ${state.pending.operationId}.`
            : `A live ${action} has an unresolved outcome. Re-enter the exact original values and choose Check status again. Do not start a different change.`);
        if (state.pending.action === 'create') elements.createTicketButton.textContent = 'Check status again';
        if (state.pending.action === 'reply' && state.currentTicketKey === state.pending.target) elements.replyButton.textContent = 'Check status again';
    }

    async function hashPayload(action, target, payload) {
        if (!window.crypto || !window.crypto.subtle || typeof window.crypto.subtle.digest !== 'function' || typeof TextEncoder !== 'function') {
            throw new Error('Secure operation recovery is unavailable in this browser.');
        }
        const canonical = JSON.stringify({
            action,
            target,
            customerId: normaliseOpaqueId(payload.customerId, 180),
            customerName: normaliseText(payload.customerName, 180),
            requesterEmail: normaliseText(payload.requesterEmail, 254).toLowerCase(),
            intakeChannel: normaliseId(payload.intakeChannel, 40),
            deviceId: normaliseOpaqueId(payload.deviceId, 180),
            priority: normaliseId(payload.priority, 20),
            subject: normaliseText(payload.subject, 160),
            requestText: normaliseText(payload.requestText, 8000),
            message: normaliseText(payload.message, 8000)
        });
        const bytes = new TextEncoder().encode(canonical);
        const digest = await window.crypto.subtle.digest('SHA-256', bytes);
        return Array.from(new Uint8Array(digest), function (value) {
            return value.toString(16).padStart(2, '0');
        }).join('');
    }

    function newOperationId() {
        if (!window.crypto || typeof window.crypto.randomUUID !== 'function') {
            throw new Error('A secure browser-generated operation identity is required.');
        }
        const value = String(window.crypto.randomUUID()).toLowerCase();
        if (!OPERATION_ID_PATTERN.test(value)) throw new Error('The browser returned an invalid operation identity.');
        return value;
    }

    function validRepeatToken(value) {
        return /^[A-Za-z0-9_-]{32,200}$/.test(String(value || ''));
    }

    function selectTicketFromList(event) {
        const button = event.target.closest('[data-ticket-key]');
        if (button) selectTicket(button.dataset.ticketKey);
    }

    async function selectTicket(key, fetchDetail) {
        state.currentTicketKey = key;
        elements.newTicketView.hidden = true;
        elements.ticketView.hidden = false;
        renderTicketList();
        renderTicket();
        renderPending();
        if (fetchDetail !== false) await refreshCurrentTicket();
    }

    function showNewTicket() {
        state.currentTicketKey = '';
        elements.ticketView.hidden = true;
        elements.newTicketView.hidden = false;
        renderTicketList();
        elements.formStatus.textContent = '';
        renderPending();
        if ((state.bootstrap.customers || []).length) elements.customerSelect.focus();
    }

    function currentTicket() {
        return state.tickets.find(function (ticket) { return ticketKey(ticket) === state.currentTicketKey; }) || null;
    }

    async function refreshCurrentTicket() {
        const current = currentTicket();
        if (!current || state.busy) return;
        setBusy(true, elements.replyStatus, 'Refreshing from Autotask…');
        try {
            const customerId = current.customer && current.customer.id || '';
            const result = await api(`/api/service-desk/tickets/by-number/${encodeURIComponent(ticketKey(current))}?customerId=${encodeURIComponent(customerId)}`);
            if (!result || !result.ticket) throw new Error('Autotask returned an incomplete ticket response.');
            upsertTicket(result.ticket);
            state.currentTicketKey = ticketKey(result.ticket);
            renderTicket();
        } catch (error) {
            showToast(error.message, true);
        } finally {
            setBusy(false, elements.replyStatus, '');
        }
    }

    function upsertTicket(ticket) {
        const key = ticketKey(ticket);
        const index = state.tickets.findIndex(function (item) { return ticketKey(item) === key; });
        if (index === -1) state.tickets.unshift(ticket);
        else state.tickets[index] = ticket;
        renderTicketList();
    }

    function renderTicketList() {
        if (!state.tickets.length) {
            elements.ticketList.innerHTML = '<div class="empty-list">No production tickets are currently available.</div>';
            return;
        }
        elements.ticketList.innerHTML = state.tickets.map(function (ticket) {
            const key = ticketKey(ticket);
            const active = key === state.currentTicketKey ? ' is-active' : '';
            return [
                `<button type="button" class="ticket-list-button${active}" data-ticket-key="${escapeHtml(key)}">`,
                `<span>${escapeHtml(key)} · ${escapeHtml(formatLabel(ticket.status))}</span>`,
                `<strong>${escapeHtml(ticket.subject || ticket.summary)}</strong>`,
                `<small>${escapeHtml(ticket.customer && ticket.customer.name || 'Customer')} · ${escapeHtml(formatDate(ticket.updatedAt))}</small>`,
                '</button>'
            ].join('');
        }).join('');
    }

    function renderTicket() {
        const ticket = currentTicket();
        if (!ticket) { showNewTicket(); return; }
        elements.ticketReference.textContent = `${ticketKey(ticket)} · live Autotask`;
        elements.ticketTitle.textContent = ticket.subject || ticket.summary || 'Untitled ticket';
        elements.ticketMeta.textContent = [
            ticket.customer && ticket.customer.name,
            ticket.device ? `Device ${ticket.device}` : 'No mapped device',
            `Priority ${formatLabel(ticket.priority || 'unavailable')}`
        ].filter(Boolean).join(' · ');
        elements.ticketStatus.textContent = formatLabel(ticket.status || 'unavailable');
        elements.ticketStatus.className = `status-pill status-${normaliseId(ticket.status, 60)}`;
        const issues = Array.isArray(ticket.projectionIssues) ? ticket.projectionIssues : [];
        elements.ticketProjectionStatus.textContent = issues.length
            ? 'Some Autotask fields could not be mapped safely. Unavailable values are shown honestly.'
            : 'Customer-visible service-desk activity is current from Autotask.';
        renderNotes(ticket);
        elements.replyCard.hidden = !state.writesEnabled;
    }

    function renderNotes(ticket) {
        const notes = Array.isArray(ticket.notes) ? ticket.notes.filter(function (note) {
            return note && note.customerVisible === true && typeof note.message === 'string';
        }) : [];
        if (!notes.length) {
            elements.ticketTimeline.innerHTML = '<li class="empty-list">No customer-visible messages are available.</li>';
            return;
        }
        elements.ticketTimeline.innerHTML = notes.map(function (note) {
            const origin = note.originVerified === true ? note.origin : 'service_desk_update';
            return [
                '<li class="timeline-item">',
                `<span class="timeline-dot" aria-hidden="true">${origin === 'customer_reply' ? 'CR' : origin === 'customer_portal_submission' ? 'CQ' : 'SD'}</span>`,
                '<div class="timeline-copy">',
                `<strong>${escapeHtml(noteLabel(origin))}</strong>`,
                `<p>${escapeHtml(note.message)}</p>`,
                `<small>${escapeHtml(formatDate(note.createdAt))}</small>`,
                '</div>',
                '</li>'
            ].join('');
        }).join('');
    }

    function noteLabel(origin) {
        if (origin === 'customer_portal_submission') return 'Customer request';
        if (origin === 'customer_reply') return 'Customer reply';
        return 'Service desk update';
    }

    function ticketKey(ticket) {
        return normaliseText(ticket && (ticket.ticketNumber || ticket.externalTicketId || ticket.id), 80);
    }

    async function api(url, options) {
        const requestOptions = Object.assign({
            method: 'GET',
            credentials: 'same-origin',
            headers: { Accept: 'application/json' }
        }, options || {});
        requestOptions.headers = Object.assign({ Accept: 'application/json' }, requestOptions.headers || {});
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        if (controller) requestOptions.signal = controller.signal;
        if (requestOptions.body && typeof requestOptions.body !== 'string') {
            requestOptions.headers['Content-Type'] = 'application/json';
            requestOptions.body = JSON.stringify(requestOptions.body);
        }
        let timer;
        try {
            const timeout = new Promise(function (_, reject) {
                timer = window.setTimeout(function () {
                    if (controller) try { controller.abort(); } catch (_error) { /* best effort */ }
                    const error = new Error('The live service desk did not respond in time. The operation outcome remains unresolved.');
                    error.code = 'request_timeout';
                    reject(error);
                }, API_TIMEOUT_MS);
            });
            const response = await Promise.race([fetch(url, requestOptions), timeout]);
            let payload;
            try { payload = await Promise.race([response.json(), timeout]); }
            catch (error) {
                if (error && error.code === 'request_timeout') throw error;
                const unreadable = new Error('The live service desk returned an unreadable response. The operation outcome remains unresolved.');
                unreadable.code = 'invalid_response';
                throw unreadable;
            }
            if (response.status === 401) {
                window.location.assign('/api/auth/login?returnTo=%2Fsupport');
            }
            if (!response.ok) {
                const error = new Error(payload && payload.error || 'No Fries could not complete that service-desk request.');
                error.code = payload && payload.code || '';
                error.status = response.status;
                error.payload = payload;
                throw error;
            }
            return payload;
        } catch (error) {
            if (requestOptions.method !== 'GET' && error && !error.code) {
                const uncertain = new Error('The connection ended before the live operation outcome was known. Check status again.');
                uncertain.code = 'request_outcome_unknown';
                throw uncertain;
            }
            throw error;
        } finally {
            window.clearTimeout(timer);
        }
    }

    function setBusy(busy, statusElement, message) {
        state.busy = busy;
        if (statusElement) statusElement.textContent = message || '';
        document.querySelectorAll('button').forEach(function (button) { button.disabled = busy; });
        if (!busy) {
            elements.newTicketButton.disabled = !(state.bootstrap.customers || []).length || !state.writesEnabled;
            elements.createTicketButton.disabled = !state.writesEnabled;
            elements.replyButton.disabled = !state.writesEnabled;
        }
    }

    function showToast(message, isError) {
        window.clearTimeout(state.toastTimer);
        elements.toast.textContent = message || '';
        elements.toast.className = `toast${isError ? ' is-error' : ''}`;
        elements.toast.hidden = false;
        state.toastTimer = window.setTimeout(function () { elements.toast.hidden = true; }, 6000);
    }

    function normaliseText(value, limit) {
        return String(value == null ? '' : value).trim().slice(0, limit);
    }

    function normaliseId(value, limit) {
        return normaliseText(value, limit).toLowerCase().replace(/[^a-z0-9@._:-]+/g, '-').replace(/^-+|-+$/g, '');
    }

    function normaliseOpaqueId(value, limit) {
        const result = normaliseText(value, limit);
        return /[\u0000-\u001f\u007f]/.test(result) ? '' : result;
    }

    function formatDate(value) {
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return 'Time unavailable';
        return new Intl.DateTimeFormat('en-NZ', {
            day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit'
        }).format(date);
    }

    function formatLabel(value) {
        return normaliseText(value, 120).replace(/_/g, ' ').replace(/\b\w/g, function (letter) { return letter.toUpperCase(); });
    }

    function escapeHtml(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
    }
}());
