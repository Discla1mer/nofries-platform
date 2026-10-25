const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { TextEncoder } = require('util');
const pendingApi = require('../api/shared/protectedAssets/portalPending');

const source = fs.readFileSync(
    path.join(__dirname, '..', 'api', 'shared', 'protectedAssets', 'portal.js'),
    'utf8'
);
const OPERATION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function response(status, body) {
    return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function bootstrap(overrides = {}) {
    return Object.assign({
        customer: {
            id: 'customer-one',
            proofCustomerId: 'proof-customer-one',
            displayName: 'Customer One',
            timezone: 'Pacific/Auckland'
        },
        user: { name: 'Customer Admin', email: 'customer@example.test', role: 'customer_admin' },
        tickets: [],
        openTicketCount: 0,
        proof: {
            status: 'available',
            proofCustomerId: 'proof-customer-one',
            current: { period: '2026-07', state: 'not_issued', report: null },
            history: []
        }
    }, overrides);
}

function createHarness(fetchImpl, options = {}) {
    const handlers = {};
    const elements = new Map();
    const sessionValues = options.sessionValues || new Map();
    const submission = Object.assign({
        summary: 'Live support request',
        description: 'The customer cannot access an approved service.',
        priority: 'high'
    }, options.submission || {});

    function makeElement(id = '') {
        const listeners = {};
        const classes = new Set();
        return {
            id,
            hidden: false,
            disabled: false,
            value: '',
            textContent: '',
            className: '',
            childNodes: [],
            dataset: {},
            elements: [],
            listeners,
            addEventListener(type, handler) {
                listeners[type] = handler;
                if (id) handlers[`${id}:${type}`] = handler;
            },
            append(...children) { this.childNodes.push(...children); },
            replaceChildren(...children) { this.childNodes = children; },
            setAttribute(name, value) { this[name] = String(value); },
            focus: jest.fn(),
            reset: jest.fn(),
            classList: {
                add(name) { classes.add(name); },
                remove(name) { classes.delete(name); },
                toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
                contains(name) { return classes.has(name); }
            }
        };
    }

    function element(id) {
        if (!elements.has(id)) elements.set(id, makeElement(id));
        return elements.get(id);
    }

    const createFields = { summary: 'newTicketSummary', description: 'newTicketDescription', priority: 'newTicketPriority' };
    Object.entries(createFields).forEach(([name, id]) => { element(id).value = submission[name]; });
    element('newTicketForm').elements = Object.values(createFields).map(element).concat([
        element('cancelNewTicket'), element('newTicketSubmit'), element('checkPendingCreate')
    ]);
    element('newTicketForm').reset = jest.fn(() => {
        Object.entries(createFields).forEach(([name, id]) => { element(id).value = name === 'priority' ? 'normal' : ''; });
    });
    element('replyForm').elements = [element('replyMessage'), element('checkPendingReply')];
    element('ticketDetail').hidden = true;
    element('newTicketForm').hidden = true;

    const bodyClasses = new Set(['portal-loading']);
    const document = {
        body: {
            dataset: {},
            classList: {
                add(name) { bodyClasses.add(name); },
                remove(name) { bodyClasses.delete(name); },
                contains(name) { return bodyClasses.has(name); }
            }
        },
        createElement: () => makeElement(),
        getElementById: element
    };
    const window = {
        NoFriesPortalPending: pendingApi,
        crypto: {
            randomUUID: jest.fn(() => OPERATION_ID),
            subtle: { digest: options.digest || (async (_algorithm, bytes) => crypto.createHash('sha256').update(bytes).digest()) }
        },
        sessionStorage: {
            getItem(key) { return sessionValues.has(key) ? sessionValues.get(key) : null; },
            setItem(key, value) { sessionValues.set(key, String(value)); }
        },
        setTimeout: jest.fn(() => 1),
        addEventListener(type, handler) { handlers[`window:${type}`] = handler; },
        print: jest.fn()
    };
    class FormDataMock {
        get(name) { return submission[name] || ''; }
    }

    vm.runInNewContext(source, {
        document,
        fetch: fetchImpl,
        FormData: FormDataMock,
        navigator: {},
        TextEncoder,
        window
    });
    window.NoFriesPortal.start(bootstrap(options.bootstrap));
    return { elements, handlers, sessionValues, submission, window };
}

describe('customer portal durable mutation recovery UI', () => {
    test('checks a pending create after refresh without resending private ticket text', async () => {
        const sessionValues = new Map();
        const firstFetch = jest.fn(async (url, request) => {
            expect(url).toBe('/api/customer-portal/tickets');
            expect(request.method).toBe('POST');
            return response(202, { operationId: OPERATION_ID, status: 'pending' });
        });
        const firstPage = createHarness(firstFetch, { sessionValues });

        await firstPage.handlers['newTicketForm:submit']({ preventDefault: jest.fn() });

        const persisted = sessionValues.get(pendingApi.STORAGE_KEY);
        expect(persisted).toContain(OPERATION_ID);
        expect(persisted).not.toContain('Live support request');
        expect(persisted).not.toContain('approved service');
        expect(firstPage.elements.get('checkPendingCreate').hidden).toBe(false);

        const secondFetch = jest.fn(async (url, request) => {
            expect(request.method).toBe('GET');
            if (url === `/api/customer-portal/tickets/operations/${OPERATION_ID}`) {
                return response(200, {
                    operationId: OPERATION_ID,
                    status: 'completed',
                    terminal: true,
                    retrySameOperation: false,
                    idempotentReplay: true,
                    repeatedFromOperationId: ''
                });
            }
            if (url === '/api/customer-portal/tickets') {
                return response(200, { tickets: [], openCount: 0 });
            }
            throw new Error(`Unexpected request: ${url}`);
        });
        const refreshedPage = createHarness(secondFetch, { sessionValues });
        refreshedPage.handlers['newTicketButton:click']();

        const checking = refreshedPage.handlers['checkPendingCreate:click']();
        expect(refreshedPage.elements.get('newTicketStatus').textContent).toBe('Checking status…');
        expect(refreshedPage.elements.get('checkPendingCreate').disabled).toBe(true);
        await checking;

        expect(secondFetch.mock.calls.map(([url]) => url)).toEqual([
            `/api/customer-portal/tickets/operations/${OPERATION_ID}`,
            '/api/customer-portal/tickets'
        ]);
        expect(secondFetch.mock.calls.every(([, request]) => request.body === undefined)).toBe(true);
        expect(JSON.parse(sessionValues.get(pendingApi.STORAGE_KEY))).toEqual([]);
        expect(refreshedPage.elements.get('checkPendingCreate').hidden).toBe(true);
        expect(refreshedPage.elements.get('portalToast').textContent).toContain('ticket list has been refreshed');
    });

    test('keeps pending metadata when a status check is unavailable', async () => {
        const sessionValues = new Map();
        const store = pendingApi.createStore({
            storage: {
                getItem(key) { return sessionValues.has(key) ? sessionValues.get(key) : null; },
                setItem(key, value) { sessionValues.set(key, String(value)); }
            },
            customerScope: 'customer-one',
            now: () => Date.parse('2026-08-31T12:00:00.000Z')
        });
        store.remember({
            operationId: OPERATION_ID,
            action: 'create',
            target: '',
            payloadHash: 'a'.repeat(64),
            timestamp: Date.parse('2026-08-31T12:00:00.000Z')
        });
        const fetchImpl = jest.fn(async () => response(503, {
            error: 'Operation status is temporarily unavailable',
            code: 'service_desk_provider_not_ready'
        }));
        const page = createHarness(fetchImpl, { sessionValues });
        page.handlers['newTicketButton:click']();

        const checking = page.handlers['checkPendingCreate:click']();
        expect(page.elements.get('newTicketStatus').textContent).toBe('Checking status…');
        expect(page.elements.get('checkPendingCreate').disabled).toBe(true);
        await checking;

        expect(JSON.parse(sessionValues.get(pendingApi.STORAGE_KEY))).toHaveLength(1);
        expect(page.elements.get('newTicketStatus').textContent).toContain('may still complete');
        expect(page.elements.get('checkPendingCreate').hidden).toBe(false);
    });
});

const TICKET_A = 'T20261013.0001';
const TICKET_B = 'T20261013.0002';

function supportTicket(ticketNumber) {
    return {
        ticketNumber, summary: `Support request ${ticketNumber}`, status: 'open', priority: 'normal',
        createdAt: '2026-10-13T01:00:00.000Z', updatedAt: '2026-10-13T01:00:00.000Z', notes: []
    };
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function flushAsyncWork() { return new Promise((resolve) => setImmediate(resolve)); }

function draftHarness(fetchImpl, options = {}) {
    const fetcher = fetchImpl || jest.fn(async (url) => response(200, { ticket: supportTicket(url.split('/').pop()) }));
    const page = createHarness(fetcher, Object.assign({
        submission: { summary: '', description: '', priority: 'normal' },
        bootstrap: { tickets: [supportTicket(TICKET_A), supportTicket(TICKET_B)] }
    }, options));
    page.fetch = fetcher;
    page.open = async (ticketNumber) => {
        const button = page.elements.get('ticketList').childNodes.find((item) => item.dataset.ticketNumber === ticketNumber);
        button.listeners.click();
        await flushAsyncWork();
    };
    page.reply = (text) => {
        page.elements.get('replyMessage').value = text;
        page.handlers['replyMessage:input']();
    };
    page.unload = () => {
        const event = { preventDefault: jest.fn() };
        page.handlers['window:beforeunload'](event);
        return event;
    };
    return page;
}

describe('customer support drafts stay in the open page', () => {
    test('restores distinct ticket replies after A to B to A and a visit to the new-request form', async () => {
        const page = draftHarness();
        await page.open(TICKET_A);
        page.reply('  Draft A, with its original spacing.\n');
        await page.open(TICKET_B);
        expect(page.elements.get('replyMessage').value).toBe('');
        page.reply('Draft B');
        page.handlers['newTicketButton:click']();
        await page.open(TICKET_A);
        expect(page.elements.get('replyMessage').value).toBe('  Draft A, with its original spacing.\n');
        await page.open(TICKET_B);
        expect(page.elements.get('replyMessage').value).toBe('Draft B');
        expect(page.sessionValues.size).toBe(0);
    });

    test('Close retains every new-request field and never implies submission', async () => {
        const page = draftHarness();
        page.handlers['newTicketButton:click']();
        page.elements.get('newTicketSummary').value = 'Printer problem';
        page.elements.get('newTicketDescription').value = 'Print jobs stop after the first page.';
        page.elements.get('newTicketPriority').value = 'high';
        page.handlers['cancelNewTicket:click']();
        expect(page.elements.get('newTicketForm').hidden).toBe(true);
        expect(page.unload().preventDefault).toHaveBeenCalled();
        page.handlers['newTicketButton:click']();
        expect(page.elements.get('newTicketSummary').value).toBe('Printer problem');
        expect(page.elements.get('newTicketDescription').value).toBe('Print jobs stop after the first page.');
        expect(page.elements.get('newTicketPriority').value).toBe('high');
        expect(page.elements.get('newTicketForm').reset).not.toHaveBeenCalled();
        expect(page.fetch).not.toHaveBeenCalled();
        expect(page.sessionValues.size).toBe(0);
    });

    test('failed ticket reads leave the original view and most recent text intact', async () => {
        const read = deferred();
        const page = draftHarness(jest.fn()
            .mockResolvedValueOnce(response(200, { ticket: supportTicket(TICKET_A) }))
            .mockImplementationOnce(() => read.promise));
        await page.open(TICKET_A);
        page.reply('Original draft');
        await page.open(TICKET_B);
        page.reply('Still editing while the ticket loads');
        page.handlers['newTicketButton:click']();
        expect(page.elements.get('newTicketForm').hidden).toBe(true);
        read.resolve(response(503, { error: 'Try again later' }));
        await flushAsyncWork();
        expect(page.elements.get('ticketNumber').textContent).toBe(TICKET_A);
        expect(page.elements.get('replyMessage').value).toBe('Still editing while the ticket loads');
        expect(page.elements.get('portalToast').textContent).toContain('Try again later');
        expect(page.elements.get('newTicketButton').disabled).toBe(false);
    });

    test('captures text typed while a successful ticket read is in flight', async () => {
        const read = deferred();
        const page = draftHarness(jest.fn()
            .mockResolvedValueOnce(response(200, { ticket: supportTicket(TICKET_A) }))
            .mockImplementationOnce(() => read.promise)
            .mockResolvedValueOnce(response(200, { ticket: supportTicket(TICKET_A) })));
        await page.open(TICKET_A);
        page.reply('First words');
        await page.open(TICKET_B);
        page.reply('First words and the rest');
        read.resolve(response(200, { ticket: supportTicket(TICKET_B) }));
        await flushAsyncWork();
        await page.open(TICKET_A);
        expect(page.elements.get('replyMessage').value).toBe('First words and the rest');
    });

    test('locks context before hashing and clears only the reply that completed', async () => {
        const hash = deferred();
        const send = deferred();
        const page = draftHarness(jest.fn(async (url, request) => request.method === 'POST'
            ? send.promise : response(200, { ticket: supportTicket(url.split('/').pop()) })), {
            digest: () => hash.promise
        });
        await page.open(TICKET_B);
        page.reply('Keep draft B');
        await page.open(TICKET_A);
        page.reply('Send reply A');
        const sending = page.handlers['replyForm:submit']({ preventDefault: jest.fn() });
        expect(page.elements.get('replyMessage').disabled).toBe(true);
        page.handlers['newTicketButton:click']();
        page.handlers['cancelNewTicket:click']();
        await page.open(TICKET_B);
        expect(page.elements.get('ticketNumber').textContent).toBe(TICKET_A);
        expect(page.elements.get('ticketDetail').hidden).toBe(false);
        expect(page.fetch.mock.calls.filter(([, request]) => request.method === 'POST')).toHaveLength(0);
        hash.resolve(crypto.createHash('sha256').update(JSON.stringify({ message: 'Send reply A' })).digest());
        await flushAsyncWork();
        await page.open(TICKET_B);
        const writes = page.fetch.mock.calls.filter(([, request]) => request.method === 'POST');
        expect(writes).toHaveLength(1);
        expect(writes[0][0]).toBe(`/api/customer-portal/tickets/${TICKET_A}/reply`);
        expect(JSON.parse(writes[0][1].body).message).toBe('Send reply A');
        send.resolve(response(200, { status: 'completed', ticket: supportTicket(TICKET_A) }));
        await sending;
        expect(page.elements.get('replyMessage').value).toBe('');
        expect(page.elements.get('replyMessage').disabled).toBe(false);
        await page.open(TICKET_B);
        expect(page.elements.get('replyMessage').value).toBe('Keep draft B');
        await page.open(TICKET_A);
        expect(page.elements.get('replyMessage').value).toBe('');
        expect(JSON.parse(page.sessionValues.get(pendingApi.STORAGE_KEY))).toEqual([]);
    });

    test.each(['pending', 'unavailable', 'rejected'])('retains text after a %s reply outcome', async (outcome) => {
        const page = draftHarness(jest.fn(async (url, request) => {
            if (request.method !== 'POST') return response(200, { ticket: supportTicket(url.split('/').pop()) });
            if (outcome === 'unavailable') throw new Error('Network lost');
            return response(outcome === 'rejected' ? 400 : 202, {
                status: outcome, operationId: OPERATION_ID, error: outcome === 'rejected' ? 'Reply rejected' : undefined
            });
        }));
        await page.open(TICKET_A);
        page.reply('Keep my private words');
        await page.handlers['replyForm:submit']({ preventDefault: jest.fn() });
        await page.open(TICKET_B);
        await page.open(TICKET_A);
        expect(page.elements.get('replyMessage').value).toBe('Keep my private words');
        const persisted = page.sessionValues.get(pendingApi.STORAGE_KEY);
        expect(persisted).not.toContain('Keep my private words');
        expect(JSON.parse(persisted)).toHaveLength(outcome === 'rejected' ? 0 : 1);
        expect(page.elements.get('checkPendingReply').hidden).toBe(outcome === 'rejected');
    });

    test.each([false, true])('status completion clears only matching reply text (edited: %s)', async (edited) => {
        const page = draftHarness(jest.fn(async (url, request) => {
            if (request.method === 'POST') return response(202, { status: 'pending', operationId: OPERATION_ID });
            if (url.includes('/operations/')) return response(200, { status: 'completed', operationId: OPERATION_ID });
            return response(200, { ticket: supportTicket(url.split('/').pop()) });
        }));
        await page.open(TICKET_A);
        page.reply('Original reply');
        await page.handlers['replyForm:submit']({ preventDefault: jest.fn() });
        if (edited) page.reply('A different unsent reply');
        await page.handlers['checkPendingReply:click']();
        expect(page.elements.get('replyMessage').value).toBe(edited ? 'A different unsent reply' : '');
        expect(JSON.parse(page.sessionValues.get(pendingApi.STORAGE_KEY))).toEqual([]);
        expect(page.unload().preventDefault).toHaveBeenCalledTimes(edited ? 1 : 0);
    });

    test('a failed refresh after confirmed completion preserves newer work and reports the known outcome', async () => {
        let reads = 0;
        const page = draftHarness(jest.fn(async (url, request) => {
            if (request.method === 'POST') return response(202, { status: 'pending', operationId: OPERATION_ID });
            if (url.includes('/operations/')) return response(200, { status: 'completed', operationId: OPERATION_ID });
            reads += 1;
            return reads === 1 ? response(200, { ticket: supportTicket(TICKET_A) }) : response(503, { error: 'Read unavailable' });
        }));
        await page.open(TICKET_A);
        page.reply('Original reply');
        await page.handlers['replyForm:submit']({ preventDefault: jest.fn() });
        page.reply('New unsent text');
        await page.handlers['checkPendingReply:click']();
        expect(page.elements.get('replyMessage').value).toBe('New unsent text');
        expect(page.elements.get('replyStatus').textContent).toContain('operation completed');
        expect(page.elements.get('replyStatus').textContent).not.toContain('may still complete');
        expect(JSON.parse(page.sessionValues.get(pendingApi.STORAGE_KEY))).toEqual([]);
        expect(page.elements.get('replyMessage').disabled).toBe(false);
    });

    test.each([false, true])('status completion clears only matching new-request fields (edited: %s)', async (edited) => {
        const page = draftHarness(jest.fn(async (url, request) => {
            if (request.method === 'POST') return response(202, { status: 'pending', operationId: OPERATION_ID });
            if (url.includes('/operations/')) return response(200, { status: 'completed', operationId: OPERATION_ID });
            return response(200, { tickets: [], openCount: 0 });
        }));
        page.handlers['newTicketButton:click']();
        page.elements.get('newTicketSummary').value = 'Original request';
        page.elements.get('newTicketDescription').value = 'Original detail';
        await page.handlers['newTicketForm:submit']({ preventDefault: jest.fn() });
        if (edited) page.elements.get('newTicketSummary').value = 'A different draft';
        await page.handlers['checkPendingCreate:click']();
        page.handlers['newTicketButton:click']();
        expect(page.elements.get('newTicketSummary').value).toBe(edited ? 'A different draft' : '');
        expect(page.elements.get('newTicketDescription').value).toBe(edited ? 'Original detail' : '');
        expect(JSON.parse(page.sessionValues.get(pendingApi.STORAGE_KEY))).toEqual([]);
        expect(page.unload().preventDefault).toHaveBeenCalledTimes(edited ? 1 : 0);
    });

    test('Close and ticket changes cannot interrupt new-request hashing or send', async () => {
        const hash = deferred();
        const send = deferred();
        const page = draftHarness(jest.fn(() => send.promise), { digest: () => hash.promise });
        page.handlers['newTicketButton:click']();
        page.elements.get('newTicketSummary').value = 'My new request';
        page.elements.get('newTicketDescription').value = 'More details';
        const sending = page.handlers['newTicketForm:submit']({ preventDefault: jest.fn() });
        page.handlers['cancelNewTicket:click']();
        await page.open(TICKET_B);
        expect(page.elements.get('newTicketForm').hidden).toBe(false);
        expect(page.fetch).not.toHaveBeenCalled();
        hash.resolve(crypto.createHash('sha256').update('synthetic payload').digest());
        await flushAsyncWork();
        page.handlers['cancelNewTicket:click']();
        expect(page.elements.get('newTicketForm').hidden).toBe(false);
        send.resolve(response(200, { status: 'completed', ticket: supportTicket(TICKET_A) }));
        await sending;
        expect(page.elements.get('newTicketSummary').value).toBe('');
        expect(page.elements.get('ticketNumber').textContent).toBe(TICKET_A);
        expect(page.unload().preventDefault).not.toHaveBeenCalled();
    });

    test.each(['reply', 'create'])('hash failure retains the %s draft and unlocks navigation', async (action) => {
        const page = draftHarness(undefined, { digest: async () => { throw new Error('Hash unavailable'); } });
        if (action === 'reply') { await page.open(TICKET_A); page.reply('Keep reply'); }
        else {
            page.handlers['newTicketButton:click']();
            page.elements.get('newTicketSummary').value = 'Keep summary';
        }
        await page.handlers[action === 'reply' ? 'replyForm:submit' : 'newTicketForm:submit']({ preventDefault: jest.fn() });
        expect(page.elements.get(action === 'reply' ? 'replyMessage' : 'newTicketSummary').value).toContain('Keep');
        expect(page.elements.get(action === 'reply' ? 'replyStatus' : 'newTicketStatus').textContent).toBe('Hash unavailable');
        expect(page.elements.get('newTicketButton').disabled).toBe(false);
        expect(page.elements.get(action === 'reply' ? 'replyMessage' : 'newTicketSummary').disabled).toBe(false);
        expect(page.fetch.mock.calls.some(([, request]) => request.method === 'POST')).toBe(false);
    });

    test('warns only for unsent work, includes hidden drafts, and never restores private text after reload', async () => {
        const page = draftHarness();
        expect(page.unload().preventDefault).not.toHaveBeenCalled();
        await page.open(TICKET_A);
        page.reply('Private draft in page memory');
        await page.open(TICKET_B);
        expect(page.unload().preventDefault).toHaveBeenCalled();
        await page.open(TICKET_A);
        page.reply('');
        expect(page.unload().preventDefault).not.toHaveBeenCalled();
        page.reply('Private draft in page memory');
        const reloaded = draftHarness(undefined, { sessionValues: page.sessionValues });
        await reloaded.open(TICKET_A);
        expect(reloaded.elements.get('replyMessage').value).toBe('');
        expect(reloaded.unload().preventDefault).not.toHaveBeenCalled();
    });
});
