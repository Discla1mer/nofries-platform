'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const pendingApi = require('../api/shared/protectedAssets/portalPending');

const source = fs.readFileSync(path.join(__dirname, '..', 'api/shared/protectedAssets/portal.js'), 'utf8');

function report(period) {
    return {
        period,
        issuedAt: `${period}-28T12:00:00Z`,
        attestation: { mode: 'manual' },
        statement: { type: 'nofries_attested_monthly_statement', label: 'No Fries-attested monthly statement' },
        sections: [{ metrics: [{ label: 'Completed service checks', value: '12' }] }],
        evidenceReceipts: [{ source: 'Service checks', evidenceSha256: 'a'.repeat(64) }]
    };
}

function issued(period) { return { state: 'issued', period, report: report(period) }; }
function response(body, status = 200) { return { ok: status === 200, status, json: async () => body }; }
function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
function text(element) {
    return [element.textContent, ...element.childNodes.map(text)].filter(Boolean).join(' ');
}

function createHarness(fetchImpl, current = issued('2026-09')) {
    const elements = new Map();
    function makeElement(id = '') {
        const classes = new Set();
        return {
            id, hidden: false, disabled: false, textContent: '', childNodes: [], dataset: {}, listeners: {},
            addEventListener(type, handler) { this.listeners[type] = handler; },
            append(...children) { this.childNodes.push(...children); },
            replaceChildren(...children) { this.childNodes = children; },
            setAttribute(name, value) { this[name] = String(value); },
            focus: jest.fn(),
            classList: {
                remove(name) { classes.delete(name); },
                toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); }
            }
        };
    }
    function element(id) {
        if (!elements.has(id)) elements.set(id, makeElement(id));
        return elements.get(id);
    }
    const window = {
        listeners: {},
        addEventListener(type, handler) { this.listeners[type] = handler; },
        NoFriesPortalPending: pendingApi,
        print: jest.fn(),
        setTimeout,
        clearTimeout
    };
    vm.runInNewContext(source, {
        window,
        AbortController,
        fetch: fetchImpl,
        navigator: {},
        document: { getElementById: element, createElement: () => makeElement(), body: makeElement() }
    });
    window.NoFriesPortal.start({
        customer: { id: 'synthetic-customer', displayName: 'Synthetic customer' },
        user: { name: 'Customer' },
        tickets: [],
        proof: {
            current,
            history: ['2026-08', '2026-07'].map(period => ({ period, issuedAt: `${period}-28T12:00:00Z` }))
        }
    });
    function select(period) {
        return element('proofHistory').childNodes.find(button => button.dataset.period === period).listeners.click();
    }
    return { element, window, select, click: id => element(id).listeners.click() };
}

describe('customer portal monthly Proof navigation', () => {
    afterEach(() => jest.useRealTimers());

    test('initial latest issued report retains safe evidence and is printable', () => {
        const fetchImpl = jest.fn();
        const page = createHarness(fetchImpl);

        expect(page.element('proofSelection').textContent).toBe('Latest completed month · September 2026');
        expect(page.element('latestProofButton').disabled).toBe(true);
        expect(page.element('retryProofButton').hidden).toBe(true);
        expect(page.element('printProofButton').disabled).toBe(false);
        expect(text(page.element('proofCurrent'))).toContain('No Fries-attested monthly statement');
        expect(text(page.element('proofCurrent'))).toContain('a'.repeat(64));
        expect(text(page.element('proofCurrent'))).toContain('12 Completed service checks');
        page.click('printProofButton');
        expect(page.window.print).toHaveBeenCalledTimes(1);
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    test('selecting history immediately clears the previous report and prevents printing until accepted', async () => {
        const request = deferred();
        const fetchImpl = jest.fn(() => request.promise);
        const page = createHarness(fetchImpl);
        const loading = page.select('2026-08');

        expect(page.element('proofSelection').textContent).toBe('Archived report · August 2026');
        expect(page.element('proofStatus').textContent).toContain('Loading August 2026');
        expect(page.element('proofCurrent')['aria-busy']).toBe('true');
        expect(text(page.element('proofCurrent'))).not.toContain('September 2026');
        expect(page.element('printProofButton').disabled).toBe(true);
        page.click('printProofButton');
        expect(page.window.print).not.toHaveBeenCalled();
        expect(fetchImpl).toHaveBeenCalledWith('/api/customer-portal/proof/2026-08', expect.objectContaining({ method: 'GET', credentials: 'same-origin', signal: expect.any(AbortSignal) }));

        request.resolve(response({ report: report('2026-08') }));
        await loading;

        expect(page.element('proofCurrent')['aria-busy']).toBe('false');
        expect(page.element('proofHistory').childNodes[0]['aria-current']).toBe('true');
        expect(page.element('proofHistory').childNodes[1]['aria-current']).toBe('false');
        expect(page.element('proofStatus').textContent).toContain('August 2026');
        expect(page.element('printProofButton').disabled).toBe(false);
        page.click('printProofButton');
        expect(page.window.print).toHaveBeenCalledTimes(1);
    });

    test.each(['success', 'failure'])('late older %s cannot replace a newer accepted report or its print state', async outcome => {
        const older = deferred();
        const newer = deferred();
        const fetchImpl = jest.fn().mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
        const page = createHarness(fetchImpl);
        const firstSelection = page.select('2026-08');
        const secondSelection = page.select('2026-07');
        expect(fetchImpl.mock.calls[0][1].signal.aborted).toBe(true);

        newer.resolve(response({ report: report('2026-07') }));
        await secondSelection;
        if (outcome === 'success') older.resolve(response({ report: report('2026-08') }));
        else older.reject(new Error('Older read failed'));
        await firstSelection;

        expect(page.element('proofSelection').textContent).toBe('Archived report · July 2026');
        expect(text(page.element('proofCurrent'))).toContain('July 2026');
        expect(text(page.element('proofCurrent'))).not.toContain('August 2026');
        expect(page.element('retryProofButton').hidden).toBe(true);
        expect(page.element('printProofButton').disabled).toBe(false);
        expect(page.element('proofHistory').childNodes[1]['aria-current']).toBe('true');
    });

    test('failure removes the prior report and retry reloads the exact selected month', async () => {
        const fetchImpl = jest.fn()
            .mockResolvedValueOnce(response({ error: 'Service unavailable' }, 503))
            .mockResolvedValueOnce(response({ report: report('2026-08') }));
        const page = createHarness(fetchImpl);

        await page.select('2026-08');
        expect(text(page.element('proofCurrent'))).toContain('Report unavailable');
        expect(text(page.element('proofCurrent'))).not.toContain('September 2026');
        expect(page.element('retryProofButton').hidden).toBe(false);
        expect(page.element('proofCurrent')['aria-busy']).toBe('false');
        expect(page.element('printProofButton').disabled).toBe(true);
        page.click('printProofButton');
        expect(page.window.print).not.toHaveBeenCalled();

        await page.click('retryProofButton');
        expect(fetchImpl.mock.calls.map(call => call[0])).toEqual(['/api/customer-portal/proof/2026-08', '/api/customer-portal/proof/2026-08']);
        expect(text(page.element('proofCurrent'))).toContain('August 2026');
        expect(page.element('retryProofButton').hidden).toBe(true);
        expect(page.element('printProofButton').disabled).toBe(false);
    });

    test.each([
        ['issued', issued('2026-09'), false, false],
        ['not issued', { state: 'not_issued', period: '2026-09', report: null }, true, false],
        ['unavailable', { state: 'unavailable', period: '', report: null }, true, true]
    ])('return to latest refreshes current endpoint and handles %s state', async (_, current, printDisabled, retryVisible) => {
        const fetchImpl = jest.fn()
            .mockResolvedValueOnce(response({ report: report('2026-08') }))
            .mockResolvedValueOnce(response({ current }));
        const page = createHarness(fetchImpl);
        await page.select('2026-08');
        expect(page.element('latestProofButton').disabled).toBe(false);
        await page.click('latestProofButton');

        expect(fetchImpl.mock.calls[1][0]).toBe('/api/customer-portal/proof/current');
        expect(page.element('proofSelection').textContent).toContain('Latest completed month');
        expect(page.element('latestProofButton').disabled).toBe(true);
        expect(page.element('printProofButton').disabled).toBe(printDisabled);
        expect(page.element('retryProofButton').hidden).toBe(!retryVisible);
        expect(text(page.element('proofCurrent'))).not.toContain('August 2026');
        expect(page.element('proofHistory').childNodes.every(button => button['aria-current'] === 'false')).toBe(true);
        if (current.state === 'not_issued') expect(text(page.element('proofCurrent'))).toContain('Report not issued for September 2026');
    });

    test('returning to latest supersedes an in-flight archive read', async () => {
        const older = deferred();
        const fetchImpl = jest.fn()
            .mockReturnValueOnce(older.promise)
            .mockResolvedValueOnce(response({ current: issued('2026-09') }));
        const page = createHarness(fetchImpl);
        const archive = page.select('2026-08');
        await page.click('latestProofButton');
        older.resolve(response({ report: report('2026-08') }));
        await archive;
        expect(text(page.element('proofCurrent'))).toContain('September 2026');
        expect(page.element('proofSelection').textContent).toContain('Latest completed month');
    });

    test('a stalled read expires, offers retry and ignores its eventual response', async () => {
        jest.useFakeTimers();
        const stalled = deferred();
        const fetchImpl = jest.fn()
            .mockReturnValueOnce(stalled.promise)
            .mockResolvedValueOnce(response({ report: report('2026-07') }));
        const page = createHarness(fetchImpl);
        const loading = page.select('2026-08');
        await jest.advanceTimersByTimeAsync(15000);
        await loading;
        expect(fetchImpl.mock.calls[0][1].signal.aborted).toBe(true);
        expect(page.element('proofCurrent')['aria-busy']).toBe('false');
        expect(page.element('retryProofButton').hidden).toBe(false);
        expect(page.element('printProofButton').disabled).toBe(true);

        await page.select('2026-07');
        stalled.resolve(response({ report: report('2026-08') }));
        await jest.advanceTimersByTimeAsync(0);
        expect(text(page.element('proofCurrent'))).toContain('July 2026');
        expect(page.element('printProofButton').disabled).toBe(false);
        expect(jest.getTimerCount()).toBe(0);
    });

    test.each([{}, { report: report('2026-07') }, { report: { period: '2026-99' } }])('incomplete or wrong-period response is never printable: %j', async body => {
        const page = createHarness(jest.fn().mockResolvedValue(response(body)));
        await page.select('2026-08');
        expect(text(page.element('proofCurrent'))).toContain('Report unavailable');
        expect(page.element('printProofButton').disabled).toBe(true);
        expect(page.element('retryProofButton').hidden).toBe(false);
        expect(page.element('proofSelection').textContent).toContain('August 2026');
    });

    test('unavailable bootstrap can recover by reading current without reloading support', async () => {
        const fetchImpl = jest.fn().mockResolvedValue(response({ current: issued('2026-09') }));
        const page = createHarness(fetchImpl, { state: 'unavailable', period: '' });
        expect(page.element('retryProofButton').hidden).toBe(false);
        await page.click('retryProofButton');
        expect(fetchImpl.mock.calls.map(call => call[0])).toEqual(['/api/customer-portal/proof/current']);
        expect(page.element('printProofButton').disabled).toBe(false);
    });

    test('template announces status separately and print CSS hides navigation and history', () => {
        const html = fs.readFileSync(path.join(__dirname, '..', 'app/portal.html'), 'utf8');
        const css = fs.readFileSync(path.join(__dirname, '..', 'app/portal.css'), 'utf8');
        expect(html).toMatch(/id="proofStatus"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"/);
        expect(html).toMatch(/id="printProofButton"[^>]*disabled/);
        expect(css.split('@media print')[1]).toMatch(/\.proof-history-wrap[^}]*#latestProofButton[^}]*#retryProofButton[^}]*display: none !important/);
        expect(css.split('@media print')[1]).not.toMatch(/\.proof-current[^}]*display: none/);
    });
});
