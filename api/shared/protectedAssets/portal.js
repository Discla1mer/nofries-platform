(function () {
    'use strict';

    const pendingApi = window.NoFriesPortalPending;
    const elements = {
        loadingPanel: document.getElementById('loadingPanel'),
        app: document.getElementById('portalApp'),
        customerName: document.getElementById('customerName'),
        signedInUser: document.getElementById('signedInUser'),
        openTicketCount: document.getElementById('openTicketCount'),
        ticketSearch: document.getElementById('ticketSearch'),
        ticketStatusFilter: document.getElementById('ticketStatusFilter'),
        clearTicketFilters: document.getElementById('clearTicketFilters'),
        ticketListCount: document.getElementById('ticketListCount'),
        ticketList: document.getElementById('ticketList'),
        ticketEmpty: document.getElementById('ticketEmpty'),
        ticketDetail: document.getElementById('ticketDetail'),
        ticketNumber: document.getElementById('ticketNumber'),
        ticketSummary: document.getElementById('ticketSummary'),
        ticketStatus: document.getElementById('ticketStatus'),
        ticketFacts: document.getElementById('ticketFacts'),
        ticketNotes: document.getElementById('ticketNotes'),
        replyForm: document.getElementById('replyForm'),
        replyMessage: document.getElementById('replyMessage'),
        replyStatus: document.getElementById('replyStatus'),
        checkPendingReply: document.getElementById('checkPendingReply'),
        newTicketButton: document.getElementById('newTicketButton'),
        newTicketForm: document.getElementById('newTicketForm'),
        newTicketSummary: document.getElementById('newTicketSummary'),
        newTicketDescription: document.getElementById('newTicketDescription'),
        newTicketPriority: document.getElementById('newTicketPriority'),
        cancelNewTicket: document.getElementById('cancelNewTicket'),
        newTicketSubmit: document.getElementById('newTicketSubmit'),
        checkPendingCreate: document.getElementById('checkPendingCreate'),
        newTicketStatus: document.getElementById('newTicketStatus'),
        proofCurrent: document.getElementById('proofCurrent'),
        proofHistory: document.getElementById('proofHistory'),
        proofSelection: document.getElementById('proofSelection'),
        proofStatus: document.getElementById('proofStatus'),
        latestProofButton: document.getElementById('latestProofButton'),
        retryProofButton: document.getElementById('retryProofButton'),
        printProofButton: document.getElementById('printProofButton'),
        toast: document.getElementById('portalToast')
    };
    const state = {
        bootstrap: null,
        tickets: [],
        ticketSearch: '',
        ticketStatusFilter: 'all',
        selectedTicketNumber: '',
        replyDrafts: new Map(),
        pendingCreate: null,
        pendingReplies: new Map(),
        pendingStore: null,
        proofSelection: 'current',
        proofRequest: null,
        proofPrintable: false,
        busy: false
    };

    function start(bootstrap) {
        if (!pendingApi || typeof pendingApi.createStore !== 'function') throw new Error('Secure retry recovery is unavailable.');
        state.bootstrap = bootstrap;
        let storage = null;
        try { storage = window.sessionStorage; } catch (error) { storage = null; }
        state.pendingStore = pendingApi.createStore({
            storage: storage,
            customerScope: bootstrap.customer.id
        });
        state.pendingStore.load();
        state.tickets = Array.isArray(bootstrap.tickets) ? bootstrap.tickets.slice() : [];
        elements.customerName.textContent = bootstrap.customer.displayName;
        elements.signedInUser.textContent = bootstrap.user.name || bootstrap.user.email || 'Signed-in customer';
        elements.openTicketCount.textContent = String(Number(bootstrap.openTicketCount) || 0);
        renderTicketList();
        renderProofState(bootstrap.proof.current);
        renderProofHistory(bootstrap.proof.history);
        bindEvents();
        document.body.classList.remove('portal-loading');
        elements.loadingPanel.hidden = true;
        elements.app.hidden = false;
        document.body.dataset.startup = 'ready';
        if (state.pendingStore.hadExpired()) {
            showToast('An older operation may still complete. Re-enter its exact details to check status safely.', false);
        }
    }

    function bindEvents() {
        elements.ticketSearch.addEventListener('input', function () {
            state.ticketSearch = elements.ticketSearch.value;
            renderTicketList();
        });
        elements.ticketStatusFilter.addEventListener('change', function () {
            state.ticketStatusFilter = elements.ticketStatusFilter.value;
            renderTicketList();
        });
        elements.clearTicketFilters.addEventListener('click', function () {
            state.ticketSearch = '';
            state.ticketStatusFilter = 'all';
            elements.ticketSearch.value = '';
            elements.ticketStatusFilter.value = 'all';
            renderTicketList();
            elements.ticketSearch.focus();
        });
        elements.newTicketButton.addEventListener('click', showNewTicket);
        elements.cancelNewTicket.addEventListener('click', showEmptyTicket);
        elements.newTicketForm.addEventListener('submit', createTicket);
        elements.checkPendingCreate.addEventListener('click', checkPendingCreate);
        elements.replyForm.addEventListener('submit', replyToTicket);
        elements.replyMessage.addEventListener('input', rememberReplyDraft);
        elements.checkPendingReply.addEventListener('click', checkPendingReply);
        elements.latestProofButton.addEventListener('click', function () { return openProofPeriod('current'); });
        elements.retryProofButton.addEventListener('click', function () { return openProofPeriod(state.proofSelection); });
        elements.printProofButton.addEventListener('click', function () {
            if (state.proofPrintable && !state.proofRequest) window.print();
        });
        window.addEventListener('beforeunload', function (event) {
            rememberReplyDraft();
            const request = newTicketPayload();
            if (!state.replyDrafts.size && !request.summary && !request.description && request.priority === 'normal') return;
            event.preventDefault();
            event.returnValue = '';
        });
    }

    function renderTicketList() {
        const query = state.ticketSearch.trim().toLowerCase();
        // Keep open aliases aligned with the customer portal service. Unknown
        // statuses remain visible in All requests rather than guessed complete.
        const open = new Set(['new', 'open', 'in_progress', 'in progress', 'waiting_customer', 'waiting customer', 'queued']);
        const completed = new Set(['complete', 'completed', 'resolved', 'closed', 'cancelled']);
        const matches = state.tickets.filter(function (ticket) {
            const status = String(ticket.status || '').trim().toLowerCase();
            if (state.ticketStatusFilter === 'open' && !open.has(status)) return false;
            if (state.ticketStatusFilter === 'completed' && !completed.has(status)) return false;
            return !query || [ticket.ticketNumber, ticket.summary].some(function (value) {
                return String(value || '').toLowerCase().includes(query);
            });
        });
        elements.ticketListCount.textContent = `Showing ${matches.length} of ${state.tickets.length} loaded requests.`;
        elements.clearTicketFilters.disabled = !state.ticketSearch && state.ticketStatusFilter === 'all';
        elements.ticketList.replaceChildren();
        if (!state.tickets.length) {
            elements.ticketList.append(createElement('div', 'empty-list', 'No support requests yet.'));
            return;
        }
        if (!matches.length) {
            elements.ticketList.append(createElement('div', 'empty-list', 'No requests match these filters. Clear filters to see all loaded requests.'));
            return;
        }
        matches.forEach(function (ticket) {
            const button = createElement('button', 'ticket-button');
            button.type = 'button';
            button.dataset.ticketNumber = ticket.ticketNumber;
            if (ticket.ticketNumber === state.selectedTicketNumber) button.setAttribute('aria-current', 'true');
            const head = createElement('div', 'ticket-button-head');
            head.append(createElement('strong', '', ticket.ticketNumber), createElement('span', 'status-pill', ticket.status));
            button.append(head, createElement('p', '', ticket.summary));
            button.addEventListener('click', function () { openTicket(ticket.ticketNumber); });
            elements.ticketList.append(button);
        });
    }

    async function openTicket(ticketNumber) {
        if (state.busy) return;
        rememberReplyDraft();
        setSupportBusy(true);
        try {
            const result = await api(`/api/customer-portal/tickets/${encodeURIComponent(ticketNumber)}`);
            if (!result.ticket) throw new Error('The ticket response was incomplete.');
            rememberReplyDraft();
            state.selectedTicketNumber = result.ticket.ticketNumber;
            upsertTicket(result.ticket);
            renderTicketDetail(result.ticket);
            renderTicketList();
        } catch (error) {
            showToast(error.message || 'The support request could not be loaded.', true);
        } finally {
            setSupportBusy(false);
        }
    }

    function renderTicketDetail(ticket) {
        elements.newTicketForm.hidden = true;
        elements.ticketEmpty.hidden = true;
        elements.ticketDetail.hidden = false;
        elements.ticketNumber.textContent = ticket.ticketNumber;
        elements.ticketSummary.textContent = ticket.summary;
        elements.ticketStatus.textContent = label(ticket.status);
        elements.ticketFacts.replaceChildren(
            fact('Priority', label(ticket.priority)),
            fact('Created', formatDateTime(ticket.createdAt)),
            fact('Updated', formatDateTime(ticket.updatedAt))
        );
        elements.ticketNotes.replaceChildren();
        const notes = Array.isArray(ticket.notes) ? ticket.notes : [];
        if (!notes.length) {
            const item = createElement('li', 'empty-list', 'No customer-visible updates yet.');
            elements.ticketNotes.append(item);
        } else {
            notes.forEach(function (note) {
                const item = createElement('li', 'ticket-note');
                item.append(
                    createElement('p', '', note.body),
                    createElement('small', '', `${note.author || noteOriginLabel(note.origin)} · ${formatDateTime(note.createdAt)}`)
                );
                elements.ticketNotes.append(item);
            });
        }
        elements.replyMessage.value = state.replyDrafts.get(ticket.ticketNumber) || '';
        const recoveredReply = state.pendingStore.find('reply', ticket.ticketNumber);
        elements.checkPendingReply.hidden = !recoveredReply;
        elements.replyStatus.textContent = recoveredReply
            ? 'A recent reply is unresolved and may still complete. Check its durable status before retrying.'
            : '';
    }

    function showNewTicket() {
        if (state.busy) return;
        rememberReplyDraft();
        elements.ticketEmpty.hidden = true;
        elements.ticketDetail.hidden = true;
        elements.newTicketForm.hidden = false;
        const recoveredCreate = state.pendingStore.find('create', '');
        elements.newTicketSubmit.textContent = recoveredCreate ? 'Retry exact request' : 'Submit request';
        elements.checkPendingCreate.hidden = !recoveredCreate;
        elements.newTicketStatus.textContent = recoveredCreate
            ? 'A recent request is unresolved and may still complete. Check its durable status before retrying.'
            : '';
        elements.newTicketSummary.focus();
    }

    function showEmptyTicket() {
        if (state.busy) return;
        rememberReplyDraft();
        renderEmptyTicket();
    }

    function renderEmptyTicket() {
        elements.newTicketForm.hidden = true;
        elements.ticketDetail.hidden = true;
        elements.ticketEmpty.hidden = false;
    }

    function rememberReplyDraft() {
        if (!state.selectedTicketNumber || elements.ticketDetail.hidden) return;
        const draft = String(elements.replyMessage.value || '');
        if (draft) state.replyDrafts.set(state.selectedTicketNumber, draft);
        else state.replyDrafts.delete(state.selectedTicketNumber);
    }

    function newTicketPayload() {
        return {
            summary: String(elements.newTicketSummary.value || '').trim(),
            description: String(elements.newTicketDescription.value || '').trim(),
            priority: String(elements.newTicketPriority.value || 'normal')
        };
    }

    function setSupportBusy(busy) {
        state.busy = busy;
        elements.newTicketButton.disabled = busy;
        elements.cancelNewTicket.disabled = busy;
    }

    async function clearCompletedDraft(pending) {
        rememberReplyDraft();
        const draft = pending.action === 'create'
            ? newTicketPayload()
            : { message: String(state.replyDrafts.get(pending.target) || '').trim() };
        let hash;
        try { hash = await pendingApi.payloadHash(draft, window.crypto); } catch (error) { return; }
        if (hash !== pending.payloadHash) return;
        if (pending.action === 'create') elements.newTicketForm.reset();
        else {
            state.replyDrafts.delete(pending.target);
            if (state.selectedTicketNumber === pending.target) elements.replyMessage.value = '';
        }
    }

    function checkPendingReply() {
        if (!state.selectedTicketNumber) return;
        const pending = state.pendingReplies.get(state.selectedTicketNumber) ||
            state.pendingStore.find('reply', state.selectedTicketNumber);
        if (!pending) return;
        return pollPendingOperation(pending, elements.replyStatus);
    }

    function checkPendingCreate() {
        const pending = state.pendingCreate || state.pendingStore.find('create', '');
        if (!pending) return;
        return pollPendingOperation(pending, elements.newTicketStatus);
    }

    async function createTicket(event) {
        event.preventDefault();
        if (state.busy) return;
        const payload = newTicketPayload();
        let payloadHash;
        setSupportBusy(true);
        setFormBusy(elements.newTicketForm, true);
        try {
            try {
                payloadHash = await pendingApi.payloadHash(payload, window.crypto);
            } catch (error) {
                elements.newTicketStatus.textContent = error.message;
                return;
            }
            const recovered = state.pendingStore.find('create', '');
            const current = state.pendingCreate || recovered;
            if (current && current.payloadHash !== payloadHash) {
                elements.newTicketStatus.textContent = 'These details differ from the unresolved request. Restore the exact original details and check status before starting another request.';
                return;
            }
            if (!state.pendingCreate) {
                state.pendingCreate = Object.assign({}, current || {
                    operationId: newOperationId(),
                    action: 'create',
                    target: '',
                    payloadHash: payloadHash,
                    timestamp: Date.now()
                }, { repeatConfirmationToken: '' });
                try {
                    state.pendingStore.remember(state.pendingCreate);
                } catch (error) {
                    state.pendingCreate = null;
                    elements.newTicketStatus.textContent = error.message || 'Safe request recovery is unavailable. No request was sent.';
                    return;
                }
            }
            elements.newTicketSubmit.textContent = 'Retry exact request';
            elements.checkPendingCreate.hidden = false;
            elements.newTicketStatus.textContent = 'Submitting safely…';
            const result = await api('/api/customer-portal/tickets', {
                method: 'POST',
                body: Object.assign({}, payload, {
                    operationId: state.pendingCreate.operationId,
                    repeatConfirmationToken: state.pendingCreate.repeatConfirmationToken || undefined
                })
            });
            if (result.status !== 'completed') {
                adoptDurableOperation(state.pendingCreate, result, payloadHash);
                if (result.repeatConfirmationToken) state.pendingCreate.repeatConfirmationToken = result.repeatConfirmationToken;
                if (result.status === 'confirmation_required') elements.newTicketSubmit.textContent = 'Confirm request';
                elements.newTicketStatus.textContent = result.status === 'confirmation_required'
                    ? 'No ticket was changed. Submit once more to confirm this request.'
                    : 'The service desk is confirming the outcome. Use Check status again before retrying.';
                return;
            }
            if (!result.ticket) throw new Error('The service desk did not return the completed ticket.');
            state.pendingStore.clearTerminal('create', '', 'completed');
            state.pendingCreate = null;
            elements.newTicketSubmit.textContent = 'Submit request';
            elements.checkPendingCreate.hidden = true;
            elements.newTicketForm.reset();
            upsertTicket(result.ticket);
            state.selectedTicketNumber = result.ticket.ticketNumber;
            renderTicketList();
            renderTicketDetail(result.ticket);
            updateOpenCount();
            showToast(result.repeated ? 'The existing support request was confirmed.' : 'Support request submitted.');
        } catch (error) {
            const pendingResult = pendingOperationResult(error);
            if (pendingResult) {
                adoptDurableOperation(state.pendingCreate, pendingResult, payloadHash);
                if (pendingResult.repeatConfirmationToken) {
                    state.pendingCreate.repeatConfirmationToken = pendingResult.repeatConfirmationToken;
                }
                if (pendingResult.status === 'confirmation_required') elements.newTicketSubmit.textContent = 'Confirm request';
            } else if (isTerminalError(error)) {
                state.pendingStore.clearTerminal('create', '', 'rejected');
                state.pendingCreate = null;
                elements.newTicketSubmit.textContent = 'Submit request';
                elements.checkPendingCreate.hidden = true;
            }
            elements.newTicketStatus.textContent = `${error.message || 'The outcome could not be confirmed.'} Use Check status again before retrying.`;
        } finally {
            setSupportBusy(false);
            setFormBusy(elements.newTicketForm, false);
        }
    }

    async function replyToTicket(event) {
        event.preventDefault();
        if (state.busy || !state.selectedTicketNumber) return;
        const ticketNumber = state.selectedTicketNumber;
        rememberReplyDraft();
        const message = String(elements.replyMessage.value || '').trim();
        let pending;
        let payloadHash;
        setSupportBusy(true);
        setFormBusy(elements.replyForm, true);
        try {
            try {
                payloadHash = await pendingApi.payloadHash({ message: message }, window.crypto);
            } catch (error) {
                elements.replyStatus.textContent = error.message;
                return;
            }
            const existing = state.pendingReplies.get(ticketNumber) ||
                state.pendingStore.find('reply', ticketNumber);
            if (existing && existing.payloadHash !== payloadHash) {
                elements.replyStatus.textContent = 'This text differs from the unresolved reply. Restore the exact original text and check status before sending a different reply.';
                elements.checkPendingReply.hidden = false;
                return;
            }
            pending = Object.assign({}, existing || {
                operationId: newOperationId(),
                action: 'reply',
                target: ticketNumber,
                payloadHash: payloadHash,
                timestamp: Date.now()
            }, { repeatConfirmationToken: existing && existing.repeatConfirmationToken || '' });
            state.pendingReplies.set(ticketNumber, pending);
            try {
                state.pendingStore.remember(pending);
            } catch (error) {
                state.pendingReplies.delete(ticketNumber);
                elements.replyStatus.textContent = error.message || 'Safe reply recovery is unavailable. No reply was sent.';
                return;
            }
            elements.checkPendingReply.hidden = false;
            elements.replyStatus.textContent = 'Sending safely…';
            const result = await api(`/api/customer-portal/tickets/${encodeURIComponent(ticketNumber)}/reply`, {
                method: 'POST',
                body: {
                    message: message,
                    operationId: pending.operationId,
                    repeatConfirmationToken: pending.repeatConfirmationToken || undefined
                }
            });
            if (result.status !== 'completed') {
                adoptDurableOperation(pending, result, payloadHash);
                if (result.repeatConfirmationToken) pending.repeatConfirmationToken = result.repeatConfirmationToken;
                elements.replyStatus.textContent = result.status === 'confirmation_required'
                    ? 'No reply was added. Send once more to confirm it.'
                    : 'The service desk is confirming the outcome. Use Check status again before retrying.';
                return;
            }
            if (!result.ticket) throw new Error('The service desk did not return the completed ticket.');
            state.replyDrafts.delete(ticketNumber);
            elements.replyMessage.value = '';
            state.pendingStore.clearTerminal('reply', ticketNumber, 'completed');
            state.pendingReplies.delete(ticketNumber);
            elements.checkPendingReply.hidden = true;
            upsertTicket(result.ticket);
            renderTicketDetail(result.ticket);
            renderTicketList();
            elements.replyStatus.textContent = '';
            showToast(result.repeated ? 'The existing reply was confirmed.' : 'Reply sent.');
        } catch (error) {
            const pendingResult = pendingOperationResult(error);
            if (pendingResult) {
                adoptDurableOperation(pending, pendingResult, payloadHash);
                if (pendingResult.repeatConfirmationToken) pending.repeatConfirmationToken = pendingResult.repeatConfirmationToken;
            } else if (isTerminalError(error)) {
                state.pendingStore.clearTerminal('reply', ticketNumber, 'rejected');
                state.pendingReplies.delete(ticketNumber);
                elements.checkPendingReply.hidden = true;
            }
            elements.replyStatus.textContent = `${error.message || 'The outcome could not be confirmed.'} Use Check status again before retrying.`;
        } finally {
            setSupportBusy(false);
            setFormBusy(elements.replyForm, false);
        }
    }

    async function pollPendingOperation(pending, statusElement) {
        if (state.busy) return;
        setSupportBusy(true);
        const form = pending.action === 'create' ? elements.newTicketForm : elements.replyForm;
        setFormBusy(form, true);
        let completed = false;
        statusElement.textContent = 'Checking status…';
        try {
            const result = await api(`/api/customer-portal/tickets/operations/${encodeURIComponent(pending.operationId)}`);
            if (pendingApi.operationDisposition(result) !== 'terminal' || result.status !== 'completed') {
                statusElement.textContent = 'This operation is still pending. It may still complete; check again before retrying.';
                return;
            }
            completed = true;
            await clearCompletedDraft(pending);
            if (pending.action === 'create') {
                state.pendingStore.clearTerminal('create', '', 'completed');
                state.pendingCreate = null;
                elements.newTicketSubmit.textContent = 'Submit request';
                elements.checkPendingCreate.hidden = true;
                await refreshTicketList();
                renderEmptyTicket();
                showToast('The support request completed. The ticket list has been refreshed.');
                return;
            }
            state.pendingStore.clearTerminal('reply', pending.target, 'completed');
            state.pendingReplies.delete(pending.target);
            elements.checkPendingReply.hidden = true;
            await refreshTicketDetail(pending.target);
            elements.replyStatus.textContent = '';
            showToast('The reply completed and the ticket has been refreshed.');
        } catch (error) {
            statusElement.textContent = completed
                ? 'The operation completed, but the latest support details could not be loaded. Reopen the request to refresh.'
                : `${error.message || 'The operation status is unavailable.'} The operation may still complete; check again later.`;
        } finally {
            setSupportBusy(false);
            setFormBusy(form, false);
        }
    }

    async function refreshTicketList() {
        const result = await api('/api/customer-portal/tickets');
        state.tickets = Array.isArray(result.tickets) ? result.tickets.slice() : [];
        elements.openTicketCount.textContent = String(Number(result.openCount) || 0);
        renderTicketList();
    }

    async function refreshTicketDetail(ticketNumber) {
        const result = await api(`/api/customer-portal/tickets/${encodeURIComponent(ticketNumber)}`);
        if (!result.ticket) throw new Error('The completed ticket could not be refreshed.');
        state.selectedTicketNumber = result.ticket.ticketNumber;
        upsertTicket(result.ticket);
        renderTicketDetail(result.ticket);
        renderTicketList();
        updateOpenCount();
    }

    function renderProofState(current) {
        state.proofPrintable = false;
        elements.printProofButton.disabled = true;
        elements.proofCurrent.setAttribute('aria-busy', 'false');
        elements.retryProofButton.hidden = true;
        elements.proofCurrent.replaceChildren();
        const period = current && current.period;
        updateProofSelection(period);
        if (!current || !['issued', 'not_issued'].includes(current.state) ||
            !isProofPeriod(period) ||
            (current.state === 'issued' && (!current.report || current.report.period !== period))) {
            const card = proofMessageCard('Report unavailable', 'We cannot verify the published report right now. No unverified evidence is shown.');
            elements.proofCurrent.append(card);
            elements.proofStatus.textContent = 'Report unavailable. Try loading this selection again.';
            elements.retryProofButton.hidden = false;
            return;
        }
        if (current.state === 'not_issued') {
            const card = proofMessageCard(`Report not issued for ${formatPeriod(period)}`, 'No customer report has been published for this period yet.');
            elements.proofCurrent.append(card);
            elements.proofStatus.textContent = 'No issued report for this month. You can choose a previous report below.';
            return;
        }
        elements.proofCurrent.append(proofReportCard(current.report));
        elements.proofStatus.textContent = `Showing the issued report for ${formatPeriod(period)}. Ready to print or save PDF.`;
        state.proofPrintable = true;
        elements.printProofButton.disabled = false;
    }

    function updateProofSelection(period) {
        const isCurrent = state.proofSelection === 'current';
        const selectedPeriod = isCurrent ? period : state.proofSelection;
        elements.proofSelection.textContent = `${isCurrent ? 'Latest completed month' : 'Archived report'}${isProofPeriod(selectedPeriod) ? ` · ${formatPeriod(selectedPeriod)}` : ''}`;
        elements.latestProofButton.disabled = isCurrent;
        Array.from(elements.proofHistory.childNodes).forEach(function (button) {
            if (button.dataset.period) button.setAttribute('aria-current', String(!isCurrent && button.dataset.period === state.proofSelection));
        });
    }

    function renderProofHistory(history) {
        elements.proofHistory.replaceChildren();
        const reports = Array.isArray(history) ? history.slice(0, 13) : [];
        if (!reports.length) {
            elements.proofHistory.append(createElement('p', 'empty-list', 'No previous issued reports yet.'));
            return;
        }
        reports.forEach(function (report) {
            const button = createElement('button', 'proof-history-button');
            button.type = 'button';
            button.dataset.period = report.period;
            button.setAttribute('aria-controls', 'proofCurrent');
            button.setAttribute('aria-current', String(state.proofSelection === report.period));
            button.append(
                createElement('strong', '', formatPeriod(report.period)),
                createElement('span', '', `Issued ${formatDate(report.issuedAt)}`)
            );
            button.addEventListener('click', function () { return openProofPeriod(report.period); });
            elements.proofHistory.append(button);
        });
    }

    async function openProofPeriod(period) {
        if (period !== 'current' && !isProofPeriod(period)) return;
        if (state.proofRequest) state.proofRequest.controller.abort();
        const request = { controller: new AbortController(), timeout: null };
        state.proofRequest = request;
        state.proofSelection = period;
        state.proofPrintable = false;
        elements.printProofButton.disabled = true;
        elements.retryProofButton.hidden = true;
        updateProofSelection();
        elements.proofCurrent.setAttribute('aria-busy', 'true');
        elements.proofCurrent.replaceChildren(proofMessageCard('Loading report', 'Please wait while we load your selected monthly service record.'));
        elements.proofStatus.textContent = `Loading ${period === 'current' ? 'the latest completed month' : formatPeriod(period)}…`;
        try {
            const result = await Promise.race([
                api(`/api/customer-portal/proof/${encodeURIComponent(period)}`, { signal: request.controller.signal }),
                new Promise(function (_, reject) {
                    request.timeout = window.setTimeout(function () {
                        reject(new Error('The report took too long to load. Please try again.'));
                        request.controller.abort();
                    }, 15000);
                })
            ]);
            if (state.proofRequest !== request) return;
            renderProofState(period === 'current' ? result.current : { state: 'issued', period: period, report: result.report });
        } catch (error) {
            if (state.proofRequest !== request) return;
            renderProofState({ state: 'unavailable', period: period === 'current' ? '' : period });
        } finally {
            window.clearTimeout(request.timeout);
            if (state.proofRequest === request) state.proofRequest = null;
        }
    }

    function isProofPeriod(value) { return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(value || '')); }

    function proofReportCard(report) {
        const card = createElement('article', 'proof-card');
        const head = createElement('div', 'proof-card-head');
        const title = createElement('div');
        title.append(
            createElement('p', 'eyebrow', 'Issued monthly record'),
            createElement('h3', '', formatPeriod(report.period)),
            createElement('small', '', `Issued ${formatDate(report.issuedAt)} · ${attestationLabel(report.attestation)}`)
        );
        head.append(title, createElement('span', 'proof-badge', 'Issued'));
        card.append(head);
        if (report.statement && report.statement.type === 'nofries_attested_monthly_statement' &&
            report.statement.label === 'No Fries-attested monthly statement') {
            card.append(createElement('p', 'proof-statement', report.statement.label));
        }
        card.append(proofProvenance(report));
        const metrics = createElement('div', 'proof-sections');
        (Array.isArray(report.sections) ? report.sections : []).forEach(function (section) {
            const values = section && Array.isArray(section.metrics) ? section.metrics : [];
            values.forEach(function (value) {
                if (!value || typeof value !== 'object' || !isSafeNumericValue(value.value)) return;
                const metric = createElement('div', 'proof-metric');
                const displayValue = `${formatNumericValue(value.value)}${value.unit ? ` ${String(value.unit).slice(0, 24)}` : ''}`;
                metric.append(
                    createElement('strong', '', displayValue),
                    createElement('span', '', String(value.label || value.key || 'Service measure').slice(0, 120))
                );
                if (value.status) metric.append(createElement('span', '', label(String(value.status).slice(0, 40))));
                metrics.append(metric);
            });
        });
        if (!metrics.childNodes.length) metrics.append(createElement('p', 'empty-list', 'This issued report contains no numeric service measures.'));
        card.append(metrics);
        return card;
    }

    function proofProvenance(report) {
        const wrapper = createElement('section', 'proof-provenance');
        wrapper.setAttribute('aria-label', 'Publication and evidence receipts');
        const summary = createElement('dl', 'proof-provenance-summary');
        const approval = report.approval && typeof report.approval === 'object' ? report.approval : {};
        summary.append(
            fact('Evidence', attestationLabel(report.attestation)),
            fact('Capture window', `${formatDate(report.periodStart)} – ${formatDate(report.periodEnd)}`),
            fact('Approved', provenanceEvent(report.approvedAt, [approval.maker, approval.checker])),
            fact('Issued', provenanceEvent(report.issuedAt, [report.issuer]))
        );
        wrapper.append(summary);
        const receipts = createElement('div', 'proof-receipts');
        (Array.isArray(report.evidenceReceipts) ? report.evidenceReceipts : []).forEach(function (receipt) {
            if (!receipt || !isSafeSha256(receipt.evidenceSha256)) return;
            const item = createElement('article', 'proof-receipt');
            const head = createElement('div', 'proof-receipt-head');
            head.append(
                createElement('strong', '', label(String(receipt.source || 'Service evidence').slice(0, 80))),
                createElement('span', '', attestationLabel({ mode: receipt.mode }))
            );
            const checksum = String(receipt.evidenceSha256);
            const hash = createElement('div', 'proof-receipt-hash');
            hash.append(
                createElement('span', '', `Receipt ${checksum.slice(0, 12)}…`),
                createElement('code', '', checksum)
            );
            const copy = createElement('button', 'text-button', 'Copy checksum');
            copy.type = 'button';
            copy.addEventListener('click', function () { copyChecksum(checksum, copy); });
            item.append(
                head,
                createElement('small', '', `Captured ${formatDateTime(receipt.capturedAt)} · ${formatDate(receipt.periodStart)} – ${formatDate(receipt.periodEnd)}`),
                hash,
                copy
            );
            receipts.append(item);
        });
        if (receipts.childNodes.length) wrapper.append(createElement('h4', '', 'Evidence receipts'), receipts);
        return wrapper;
    }

    function provenanceEvent(at, actors) {
        const roles = (Array.isArray(actors) ? actors : []).map(safeActorLabel).filter(Boolean);
        const date = formatDateTime(at);
        return roles.length ? `${date} · ${roles.join(' and ')}` : date;
    }

    function safeActorLabel(actor) {
        if (!actor || typeof actor !== 'object') return '';
        return String(actor.roleLabel || actor.label || '').trim().slice(0, 120);
    }

    async function copyChecksum(checksum, button) {
        try {
            if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') throw new Error('Clipboard unavailable');
            await navigator.clipboard.writeText(checksum);
            button.textContent = 'Copied';
            window.setTimeout(function () { button.textContent = 'Copy checksum'; }, 1800);
        } catch (error) {
            showToast('Select the full checksum shown in the receipt to copy it.', true);
        }
    }

    function proofMessageCard(title, message) {
        const card = createElement('article', 'proof-card');
        card.append(createElement('h3', '', title), createElement('p', '', message));
        return card;
    }

    async function api(url, options) {
        const settings = options || {};
        const response = await fetch(url, {
            method: settings.method || 'GET',
            credentials: 'same-origin',
            headers: Object.assign({ Accept: 'application/json' }, settings.body ? { 'Content-Type': 'application/json' } : {}),
            body: settings.body ? JSON.stringify(settings.body) : undefined,
            signal: settings.signal
        });
        const body = await response.json().catch(function () { return {}; });
        if (!response.ok) {
            const error = new Error(body.error || 'The customer portal request failed.');
            error.code = body.code || '';
            error.httpStatus = response.status;
            error.operationResult = body && typeof body === 'object' ? body : null;
            throw error;
        }
        return body;
    }

    function upsertTicket(ticket) {
        const summary = {
            ticketNumber: ticket.ticketNumber,
            summary: ticket.summary,
            status: ticket.status,
            priority: ticket.priority,
            device: ticket.device,
            createdAt: ticket.createdAt,
            updatedAt: ticket.updatedAt
        };
        const index = state.tickets.findIndex(function (candidate) { return candidate.ticketNumber === ticket.ticketNumber; });
        if (index === -1) state.tickets.unshift(summary);
        else state.tickets[index] = summary;
        state.tickets.sort(function (left, right) { return String(right.updatedAt).localeCompare(String(left.updatedAt)); });
    }

    function updateOpenCount() {
        const closed = new Set(['complete', 'completed', 'resolved', 'closed', 'cancelled']);
        const count = state.tickets.filter(function (ticket) { return !closed.has(String(ticket.status || '').toLowerCase()); }).length;
        elements.openTicketCount.textContent = String(count);
    }

    function fact(term, description) {
        const wrapper = createElement('div');
        wrapper.append(createElement('dt', '', term), createElement('dd', '', description || 'Not available'));
        return wrapper;
    }

    function createElement(tagName, className, text) {
        const element = document.createElement(tagName);
        if (className) element.className = className;
        if (text != null) element.textContent = String(text);
        return element;
    }

    function setFormBusy(form, busy) {
        Array.from(form.elements).forEach(function (element) { element.disabled = busy; });
    }

    function showToast(message, isError) {
        elements.toast.textContent = message;
        elements.toast.classList.toggle('error', isError === true);
        elements.toast.hidden = false;
        window.setTimeout(function () { elements.toast.hidden = true; }, 5000);
    }

    function adoptDurableOperation(pending, result, payloadHash) {
        const durableOperationId = String(result && result.operationId || '');
        if (!durableOperationId || durableOperationId === pending.operationId) return;
        const adopted = state.pendingStore.adopt(pending, durableOperationId, payloadHash);
        pending.operationId = adopted.operationId;
        pending.timestamp = adopted.timestamp;
    }

    function isTerminalError(error) {
        const result = error && error.operationResult;
        return Boolean(result && pendingApi.operationDisposition(result) === 'terminal' && result.status !== 'completed');
    }

    function pendingOperationResult(error) {
        const result = error && error.operationResult;
        return result && pendingApi.operationDisposition(result) === 'pending'
            ? result
            : null;
    }

    function newOperationId() {
        if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
        if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
            const values = new Uint8Array(16);
            window.crypto.getRandomValues(values);
            values[6] = (values[6] & 0x0f) | 0x40;
            values[8] = (values[8] & 0x3f) | 0x80;
            const hex = Array.from(values).map(function (value) { return value.toString(16).padStart(2, '0'); }).join('');
            return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
        }
        throw new Error('Secure retry protection is unavailable in this browser.');
    }

    function label(value) {
        return String(value || 'Not available').replace(/[_-]+/g, ' ').replace(/\b\w/g, function (letter) { return letter.toUpperCase(); });
    }
    function formatDateTime(value) {
        const date = new Date(value || '');
        return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('en-NZ', { dateStyle: 'medium', timeStyle: 'short' }).format(date) : 'Not available';
    }
    function formatDate(value) {
        const date = new Date(value || '');
        return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('en-NZ', { dateStyle: 'medium' }).format(date) : 'Not available';
    }
    function formatPeriod(value) {
        const match = /^(\d{4})-(\d{2})$/.exec(String(value || ''));
        if (!match) return 'Monthly report';
        return new Intl.DateTimeFormat('en-NZ', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1)));
    }
    function isSafeNumericValue(value) {
        return typeof value === 'number' && Number.isFinite(value) ||
            typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value));
    }
    function isSafeSha256(value) { return /^[a-f0-9]{64}$/.test(String(value || '')); }
    function formatNumericValue(value) { return new Intl.NumberFormat('en-NZ', { maximumFractionDigits: 4 }).format(Number(value)); }
    function attestationLabel(value) {
        const source = value && typeof value === 'object' ? (value.mode || value.label) : value;
        const mode = String(source || '').toLowerCase();
        if (mode.includes('mixed')) return 'Mixed provider-collected and manually attested evidence';
        if (mode.includes('manual')) return 'Manually attested';
        if (mode.includes('provider')) return 'Provider-collected evidence';
        return 'Issued evidence';
    }
    function noteOriginLabel(value) {
        if (String(value || '') === 'customer_request') return 'Customer request';
        return String(value || '') === 'customer_reply' ? 'Customer reply' : 'Service desk update';
    }

    window.NoFriesPortal = { start: start };
}());
