'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const pendingApi = require('../api/shared/protectedAssets/portalPending');

const source = fs.readFileSync(path.join(__dirname, '../api/shared/protectedAssets/portal.js'), 'utf8');
const template = fs.readFileSync(path.join(__dirname, '../app/portal.html'), 'utf8');

function ticket(ticketNumber, summary, status = 'open') {
    return { ticketNumber, summary, status, priority: 'normal', updatedAt: '2026-10-13T01:00:00Z', notes: [] };
}

function harness(tickets = [], openTicketCount = 41) {
    const elements = new Map();
    function makeElement() {
        return {
            value: '', textContent: '', hidden: false, disabled: false,
            dataset: {}, childNodes: [], elements: [], listeners: {},
            addEventListener(type, handler) { this.listeners[type] = handler; },
            append(...children) { this.childNodes.push(...children); },
            replaceChildren(...children) { this.childNodes = children; },
            setAttribute(name, value) { this[name] = String(value); },
            set innerHTML(value) { throw new Error('Ticket content must use text nodes'); },
            focus: jest.fn(), reset: jest.fn(),
            classList: { add: jest.fn(), remove: jest.fn(), toggle: jest.fn() }
        };
    }
    const element = (id) => {
        if (!elements.has(id)) elements.set(id, makeElement());
        return elements.get(id);
    };
    element('ticketStatusFilter').value = 'all';
    element('newTicketForm').hidden = true;
    element('ticketDetail').hidden = true;
    const storage = { getItem: jest.fn(() => null), setItem: jest.fn() };
    const fetch = jest.fn(async (url) => {
        const number = decodeURIComponent(url.split('/').pop());
        return { ok: true, status: 200, json: async () => ({ ticket: tickets.find((value) => value.ticketNumber === number) }) };
    });
    const window = {
        listeners: {},
        addEventListener(type, handler) { this.listeners[type] = handler; },
        NoFriesPortalPending: pendingApi,
        sessionStorage: storage,
        setTimeout: jest.fn(), print: jest.fn()
    };
    vm.runInNewContext(source, {
        document: {
            getElementById: element,
            createElement: makeElement,
            body: { dataset: {}, classList: { remove: jest.fn() } }
        },
        window, fetch
    });
    window.NoFriesPortal.start({
        customer: { id: 'synthetic-customer', displayName: 'Synthetic customer' },
        user: { name: 'Synthetic user' },
        tickets, openTicketCount,
        proof: { current: { state: 'not_issued' }, history: [] }
    });
    return {
        element, fetch, storage,
        search(value) { element('ticketSearch').value = value; element('ticketSearch').listeners.input(); },
        status(value) { element('ticketStatusFilter').value = value; element('ticketStatusFilter').listeners.change(); },
        clear() { element('clearTicketFilters').listeners.click(); },
        numbers() { return element('ticketList').childNodes.map((node) => node.dataset.ticketNumber).filter(Boolean); },
        async open(number) {
            element('ticketList').childNodes.find((node) => node.dataset.ticketNumber === number).listeners.click();
            await new Promise(setImmediate);
        }
    };
}

describe('customer portal ticket finder', () => {
    test('searches loaded request numbers and subjects case-insensitively without changing order', () => {
        const page = harness([
            ticket('NF-303', 'Printer is offline'),
            ticket('NF-101', 'Laptop printer setup'),
            ticket('NF-202', 'Email delivery')
        ]);
        expect(page.numbers()).toEqual(['NF-303', 'NF-101', 'NF-202']);
        expect(page.element('ticketListCount').textContent).toBe('Showing 3 of 3 loaded requests.');
        expect(page.element('clearTicketFilters').disabled).toBe(true);

        page.search('  PRINTER  ');
        expect(page.numbers()).toEqual(['NF-303', 'NF-101']);
        expect(page.element('ticketListCount').textContent).toBe('Showing 2 of 3 loaded requests.');
        page.search('nf-202');
        expect(page.numbers()).toEqual(['NF-202']);
        expect(page.fetch).not.toHaveBeenCalled();
    });

    test('combines subject search with canonical status filters and resets both controls', () => {
        const page = harness([
            ticket('NF-1', 'Printer repair', 'open'),
            ticket('NF-2', 'Printer repair', 'completed'),
            ticket('NF-3', 'Email repair', 'closed')
        ]);
        page.search('repair');
        page.status('completed');
        expect(page.numbers()).toEqual(['NF-2', 'NF-3']);
        page.search('printer');
        expect(page.numbers()).toEqual(['NF-2']);
        page.status('open');
        expect(page.numbers()).toEqual(['NF-1']);

        page.clear();
        expect(page.numbers()).toEqual(['NF-1', 'NF-2', 'NF-3']);
        expect(page.element('ticketSearch').value).toBe('');
        expect(page.element('ticketStatusFilter').value).toBe('all');
        expect(page.element('clearTicketFilters').disabled).toBe(true);
        expect(page.element('ticketSearch').focus).toHaveBeenCalledTimes(1);
    });

    test('recognises server open aliases and existing terminal aliases without guessing unknown states', () => {
        const open = ['new', 'open', 'in_progress', 'in progress', 'waiting_customer', 'waiting customer', 'queued'];
        const completed = ['complete', 'completed', 'resolved', 'closed', 'cancelled'];
        const unknown = ['scheduled', '', undefined];
        const tickets = [...open, ...completed, ...unknown].map((status, index) => ({
            ...ticket(`NF-${index}`, 'Synthetic request'), status
        }));
        tickets[0].status = ' NEW ';
        tickets[open.length].status = ' COMPLETE ';
        const page = harness(tickets);
        page.status('open');
        expect(page.numbers()).toEqual(open.map((_, index) => `NF-${index}`));
        page.status('completed');
        expect(page.numbers()).toEqual(completed.map((_, index) => `NF-${index + open.length}`));
        page.status('all');
        expect(page.numbers()).toHaveLength(tickets.length);
    });

    test('keeps matching counts distinct from the authorised server open count', () => {
        const page = harness([ticket('NF-1', 'Printer'), ticket('NF-2', 'Email', 'closed')], 41);
        page.status('open');
        expect(page.element('ticketListCount').textContent).toBe('Showing 1 of 2 loaded requests.');
        expect(page.element('openTicketCount').textContent).toBe('41');
        page.search('missing');
        expect(page.element('ticketListCount').textContent).toBe('Showing 0 of 2 loaded requests.');
        expect(page.element('openTicketCount').textContent).toBe('41');
        page.clear();
        expect(page.element('openTicketCount').textContent).toBe('41');
    });

    test('offers a usable clear action for no matches and distinguishes an empty account', () => {
        const page = harness([ticket('NF-1', 'Printer')]);
        page.search('missing');
        expect(page.numbers()).toEqual([]);
        expect(page.element('ticketList').childNodes[0].textContent).toMatch(/No requests match these filters/);
        expect(page.element('clearTicketFilters').disabled).toBe(false);
        page.clear();
        expect(page.numbers()).toEqual(['NF-1']);

        const empty = harness();
        expect(empty.element('ticketListCount').textContent).toBe('Showing 0 of 0 loaded requests.');
        expect(empty.element('ticketList').childNodes[0].textContent).toBe('No support requests yet.');
        empty.status('completed');
        expect(empty.element('ticketList').childNodes[0].textContent).toBe('No support requests yet.');
    });

    test('filtering preserves selected detail and unsent reply even when the selected row is hidden', async () => {
        const page = harness([ticket('NF-1', 'Printer'), ticket('NF-2', 'Email', 'closed')]);
        await page.open('NF-1');
        page.element('replyMessage').value = 'Unsent private reply';
        const fetchCount = page.fetch.mock.calls.length;
        page.status('completed');
        expect(page.numbers()).toEqual(['NF-2']);
        expect(page.element('ticketNumber').textContent).toBe('NF-1');
        expect(page.element('ticketDetail').hidden).toBe(false);
        expect(page.element('replyMessage').value).toBe('Unsent private reply');
        page.clear();
        const selected = page.element('ticketList').childNodes.find((node) => node.dataset.ticketNumber === 'NF-1');
        expect(selected['aria-current']).toBe('true');
        expect(page.fetch).toHaveBeenCalledTimes(fetchCount);
        expect(page.element('replyMessage').value).toBe('Unsent private reply');
    });

    test('filtering preserves an unsent new request and performs no storage write', () => {
        const page = harness([ticket('NF-1', 'Printer')]);
        page.element('newTicketButton').listeners.click();
        page.element('newTicketSummary').value = 'Unsent subject';
        page.element('newTicketDescription').value = 'Unsent description';
        page.storage.setItem.mockClear();
        page.search('missing');
        page.status('completed');
        page.clear();
        expect(page.element('newTicketForm').hidden).toBe(false);
        expect(page.element('newTicketSummary').value).toBe('Unsent subject');
        expect(page.element('newTicketDescription').value).toBe('Unsent description');
        expect(page.element('newTicketForm').reset).not.toHaveBeenCalled();
        expect(page.storage.setItem).not.toHaveBeenCalled();
        expect(page.fetch).not.toHaveBeenCalled();
    });

    test('handles whitespace and hostile-looking subjects as literal text', () => {
        const subject = '<img src=x onerror=alert(1)> [Printer]';
        const page = harness([ticket('NF-1', subject)]);
        page.search('   ');
        expect(page.numbers()).toEqual(['NF-1']);
        expect(page.element('clearTicketFilters').disabled).toBe(false);
        page.search('[printer]');
        expect(page.numbers()).toEqual(['NF-1']);
        expect(page.element('ticketList').childNodes[0].childNodes[1].textContent).toBe(subject);
        page.search('.*');
        expect(page.numbers()).toEqual([]);
    });

    test('reports the whole loaded set for variable request counts', () => {
        const tickets = Array.from({ length: 250 }, (_, index) => ticket(`NF-${index}`, `Request ${index}`, index % 2 ? 'closed' : 'open'));
        const page = harness(tickets);
        expect(page.numbers()).toHaveLength(250);
        page.status('open');
        expect(page.numbers()).toHaveLength(125);
        expect(page.element('ticketListCount').textContent).toBe('Showing 125 of 250 loaded requests.');
    });

    test('provides explicit labels, keyboard controls and a concise live result count', () => {
        expect(template).toMatch(/<label for="ticketSearch">Search requests<\/label>/);
        expect(template).toMatch(/<input id="ticketSearch" type="search"[^>]*aria-controls="ticketList"/);
        expect(template).toMatch(/<label for="ticketStatusFilter">Status<\/label>/);
        expect(template).toMatch(/<select id="ticketStatusFilter" aria-controls="ticketList">/);
        expect(template).toMatch(/id="clearTicketFilters" type="button"/);
        expect(template).toMatch(/id="ticketListCount" role="status" aria-live="polite"/);
        expect(template).toMatch(/id="ticketList" aria-describedby="ticketListCount"/);
    });
});
