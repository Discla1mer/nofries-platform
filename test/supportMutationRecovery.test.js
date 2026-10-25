const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { TextEncoder } = require('util');

const source = fs.readFileSync(
    path.join(__dirname, '..', 'api', 'shared', 'protectedAssets', 'support.js'),
    'utf8'
);
const FIRST_OPERATION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ADOPTED_OPERATION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function response(status, body) {
    return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function ticket(overrides = {}) {
    return Object.assign({
        id: '700',
        ticketNumber: 'T20260831.0001',
        customer: { id: 'customer-1', name: 'Customer One' },
        subject: 'Live Outlook support request',
        status: 'open',
        priority: 'high',
        device: 'device-1',
        createdAt: '2026-08-31T01:00:00.000Z',
        updatedAt: '2026-08-31T01:05:00.000Z',
        notes: [],
        projectionIssues: []
    }, overrides);
}

function productionBootstrap(overrides = {}) {
    return Object.assign({
        revision: 1,
        tenant: { id: 'tenant-1', name: 'Production tenant' },
        user: { email: 'operator@example.com', role: 'admin', capabilities: ['service-desk:read', 'service-desk:create'] },
        runtime: {
            mode: 'production',
            provider: 'autotask',
            sourceOfTruth: true,
            externalChanges: true,
            durableOperationFence: true
        },
        customers: [{
            id: 'customer-1',
            name: 'Customer One',
            devices: [{ id: 'device-1', label: 'Device One', platform: 'windows' }],
            supportProfile: { authorisedRequesters: [{ email: 'requester@example.com' }] }
        }],
        tickets: []
    }, overrides);
}

function createHarness(fetchImpl, options = {}) {
    const handlers = {};
    const timers = [];
    const elements = new Map();
    const sessionValues = options.sessionValues || new Map();
    const submission = Object.assign({
        customerId: 'customer-1',
        requesterEmail: 'requester@example.com',
        intakeChannel: 'phone',
        deviceId: 'device-1',
        priority: 'high',
        subject: 'Live Outlook support request',
        requestText: 'Outlook keeps prompting for credentials.',
        message: 'We have restored access.'
    }, options.submission || {});
    let nextTimerId = 1;
    const classes = new Set(['support-loading']);

    function element(id) {
        if (elements.has(id)) return elements.get(id);
        const localClasses = new Set();
        const parentClasses = new Set();
        const value = {
            id,
            hidden: false,
            disabled: false,
            value: '',
            textContent: '',
            innerHTML: '',
            className: '',
            dataset: {},
            addEventListener(type, handler) { handlers[`${id}:${type}`] = handler; },
            focus: jest.fn(),
            classList: {
                add(name) { localClasses.add(name); },
                remove(name) { localClasses.delete(name); },
                contains(name) { return localClasses.has(name); }
            },
            parentElement: {
                classList: {
                    add(name) { parentClasses.add(name); },
                    remove(name) { parentClasses.delete(name); },
                    contains(name) { return parentClasses.has(name); }
                }
            }
        };
        elements.set(id, value);
        return value;
    }

    element('customerId').value = 'customer-1';
    element('replyMessage').value = submission.message;
    const document = {
        body: {
            dataset: { page: 'service-desk' },
            classList: {
                add(name) { classes.add(name); },
                remove(name) { classes.delete(name); },
                contains(name) { return classes.has(name); }
            }
        },
        getElementById: element,
        querySelectorAll: () => []
    };
    const uuids = Array.isArray(options.uuids) ? options.uuids.slice() : [FIRST_OPERATION];
    const window = {
        location: { search: '', assign: jest.fn() },
        crypto: {
            randomUUID: jest.fn(() => uuids.shift() || FIRST_OPERATION),
            subtle: {
                digest: async function (_algorithm, bytes) {
                    return crypto.createHash('sha256').update(Buffer.from(bytes)).digest();
                }
            }
        },
        sessionStorage: {
            getItem(key) { return sessionValues.has(key) ? sessionValues.get(key) : null; },
            setItem(key, value) { sessionValues.set(key, String(value)); },
            removeItem(key) { sessionValues.delete(key); }
        },
        clearTimeout(timerId) {
            const timer = timers.find((item) => item.id === timerId);
            if (timer) timer.cancelled = true;
        },
        setTimeout(callback, delay) {
            const timer = { id: nextTimerId++, callback, delay, cancelled: false, fired: false };
            timers.push(timer);
            return timer.id;
        }
    };
    class FormDataMock {
        get(name) { return submission[name] || ''; }
    }

    vm.runInNewContext(source, {
        AbortController,
        document,
        fetch: fetchImpl,
        FormData: FormDataMock,
        TextEncoder,
        URLSearchParams,
        window
    });
    if (options.start !== false) window.NoFriesSupport.start(productionBootstrap(options.bootstrap || {}));

    return {
        classes,
        elements,
        handlers,
        sessionValues,
        submission,
        timers,
        window,
        start(value) { window.NoFriesSupport.start(value); },
        fireRequestTimeout() {
            const timer = timers.slice().reverse().find((item) => item.delay === 15000 && !item.cancelled && !item.fired);
            if (!timer) throw new Error('No active request timeout');
            timer.fired = true;
            timer.callback();
        }
    };
}

async function waitForPost(fetchImpl) {
    for (let attempt = 0; attempt < 30; attempt += 1) {
        if (fetchImpl.mock.calls.some(([, options]) => options && options.method === 'POST')) return;
        await Promise.resolve();
    }
    throw new Error('POST did not start');
}

function flushAsyncWork() {
    return new Promise((resolve) => setImmediate(resolve));
}

describe('production service-desk UI', () => {
    test('fails closed when the bootstrap is not the production Autotask source of truth', () => {
        const harness = createHarness(jest.fn(), { start: false });
        expect(() => harness.start(productionBootstrap({
            runtime: { mode: 'mock', provider: 'mock', sourceOfTruth: false }
        }))).toThrow('production Autotask');
        expect(harness.classes.has('support-loading')).toBe(true);
    });

    test('keeps live reads available while production writes are independently disabled', async () => {
        const fetchImpl = jest.fn();
        const harness = createHarness(fetchImpl, {
            bootstrap: {
                runtime: {
                    mode: 'production',
                    provider: 'autotask',
                    sourceOfTruth: true,
                    externalChanges: false,
                    durableOperationFence: true
                }
            }
        });

        expect(harness.elements.get('runtimeStatus').textContent).toContain('read only');
        expect(harness.elements.get('newTicketButton').disabled).toBe(true);
        expect(harness.elements.get('createTicketButton').disabled).toBe(true);
        await harness.handlers['ticketForm:submit']({ preventDefault: jest.fn() });
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    test('creates a live ticket with a UUID operation identity and exact production fields', async () => {
        const created = ticket();
        const fetchImpl = jest.fn().mockResolvedValue(response(201, {
            operationId: FIRST_OPERATION,
            status: 'completed',
            created: true,
            repeated: false,
            ticket: created
        }));
        const harness = createHarness(fetchImpl);

        await harness.handlers['ticketForm:submit']({ preventDefault: jest.fn() });

        expect(fetchImpl).toHaveBeenCalledTimes(1);
        const [, request] = fetchImpl.mock.calls[0];
        expect(request.method).toBe('POST');
        expect(request.headers['Idempotency-Key']).toBe(FIRST_OPERATION);
        expect(JSON.parse(request.body)).toEqual({
            customerId: 'customer-1',
            customerName: 'Customer One',
            requesterEmail: 'requester@example.com',
            intakeChannel: 'phone',
            deviceId: 'device-1',
            priority: 'high',
            subject: 'Live Outlook support request',
            requestText: 'Outlook keeps prompting for credentials.',
            operationId: FIRST_OPERATION
        });
        expect(request.body).not.toMatch(/repeatToken|incidentType|simulation|affectedUser/);
        expect(harness.sessionValues.size).toBe(0);
        expect(harness.elements.get('ticketReference').textContent).toContain('live Autotask');
    });

    test('retains only bounded operation metadata after a lost create response and reuses the same identity', async () => {
        const created = ticket();
        const fetchImpl = jest.fn()
            .mockImplementationOnce(() => new Promise(() => {}))
            .mockResolvedValueOnce(response(200, {
                operationId: FIRST_OPERATION,
                status: 'completed',
                idempotentReplay: true,
                repeated: true,
                ticket: created
            }));
        const sessionValues = new Map();
        const harness = createHarness(fetchImpl, { sessionValues });

        const first = harness.handlers['ticketForm:submit']({ preventDefault: jest.fn() });
        await waitForPost(fetchImpl);
        harness.fireRequestTimeout();
        await first;

        const persisted = [...sessionValues.values()][0];
        expect(persisted).toContain(FIRST_OPERATION);
        expect(persisted).not.toMatch(/Outlook|credentials|requester@example|repeatConfirmation/);
        expect(harness.elements.get('pendingOperation').hidden).toBe(false);
        expect(harness.elements.get('createTicketButton').textContent).toBe('Check status again');

        await harness.handlers['ticketForm:submit']({ preventDefault: jest.fn() });

        const bodies = fetchImpl.mock.calls.map(([, options]) => JSON.parse(options.body));
        expect(bodies.map((body) => body.operationId)).toEqual([FIRST_OPERATION, FIRST_OPERATION]);
        expect(harness.window.crypto.randomUUID).toHaveBeenCalledTimes(1);
        expect(sessionValues.size).toBe(0);
        expect(harness.elements.get('toast').textContent).toContain('no duplicate change');
    });

    test('blocks a divergent request while the original live outcome is unresolved', async () => {
        const fetchImpl = jest.fn().mockResolvedValue(response(202, {
            operationId: FIRST_OPERATION,
            status: 'pending'
        }));
        const harness = createHarness(fetchImpl);

        await harness.handlers['ticketForm:submit']({ preventDefault: jest.fn() });
        harness.submission.requestText = 'A different request must not reuse the operation.';
        await harness.handlers['ticketForm:submit']({ preventDefault: jest.fn() });

        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(harness.elements.get('toast').textContent).toContain('different live service-desk operation');
        expect(harness.sessionValues.size).toBe(1);
    });

    test('adopts a different server-owned durable identity from a pending response', async () => {
        const fetchImpl = jest.fn()
            .mockResolvedValueOnce(response(409, {
                error: 'Provider outcome is still being reconciled',
                code: 'provider_operation_pending',
                operationId: ADOPTED_OPERATION,
                status: 'pending'
            }))
            .mockResolvedValueOnce(response(202, {
                operationId: ADOPTED_OPERATION,
                status: 'pending'
            }));
        const harness = createHarness(fetchImpl);

        await harness.handlers['ticketForm:submit']({ preventDefault: jest.fn() });
        expect([...harness.sessionValues.values()][0]).toContain(ADOPTED_OPERATION);
        await harness.handlers['ticketForm:submit']({ preventDefault: jest.fn() });

        const bodies = fetchImpl.mock.calls.map(([, options]) => JSON.parse(options.body));
        expect(bodies[0].operationId).toBe(FIRST_OPERATION);
        expect(bodies[1].operationId).toBe(ADOPTED_OPERATION);
        expect(harness.sessionValues.size).toBe(1);
    });

    test('clears pending metadata only for an explicit terminal rejection', async () => {
        const fetchImpl = jest.fn().mockResolvedValue(response(409, {
            error: 'Autotask rejected the request before applying it',
            code: 'provider_operation_known_absent',
            operationId: FIRST_OPERATION,
            status: 'known_absent'
        }));
        const harness = createHarness(fetchImpl);

        await harness.handlers['ticketForm:submit']({ preventDefault: jest.fn() });

        expect(harness.sessionValues.size).toBe(0);
        expect(harness.elements.get('pendingOperation').hidden).toBe(true);
    });

    test('keeps repeat confirmation memory-only and attaches it only on explicit resubmission', async () => {
        const repeatConfirmationToken = 'r'.repeat(40);
        const created = ticket();
        const fetchImpl = jest.fn()
            .mockResolvedValueOnce(response(202, {
                operationId: FIRST_OPERATION,
                status: 'confirmation_required',
                repeatConfirmationToken
            }))
            .mockResolvedValueOnce(response(201, {
                operationId: FIRST_OPERATION,
                status: 'completed',
                ticket: created
            }));
        const harness = createHarness(fetchImpl);

        await harness.handlers['ticketForm:submit']({ preventDefault: jest.fn() });
        expect([...harness.sessionValues.values()][0]).not.toContain(repeatConfirmationToken);
        expect(JSON.parse(fetchImpl.mock.calls[0][1].body).repeatConfirmationToken).toBeUndefined();

        await harness.handlers['ticketForm:submit']({ preventDefault: jest.fn() });
        expect(JSON.parse(fetchImpl.mock.calls[1][1].body).repeatConfirmationToken).toBe(repeatConfirmationToken);
        expect(harness.sessionValues.size).toBe(0);
    });

    test('publishes a live customer-visible reply and retains its identity on network loss', async () => {
        const current = ticket();
        const fetchImpl = jest.fn()
            .mockResolvedValueOnce(response(200, { ticket: current }))
            .mockImplementationOnce(() => new Promise(() => {}));
        const harness = createHarness(fetchImpl, { bootstrap: { tickets: [current] } });
        await flushAsyncWork();

        const reply = harness.handlers['replyForm:submit']({ preventDefault: jest.fn() });
        await waitForPost(fetchImpl);
        harness.fireRequestTimeout();
        await reply;

        const post = fetchImpl.mock.calls.find(([, options]) => options && options.method === 'POST');
        expect(post[0]).toBe('/api/service-desk/tickets/T20260831.0001/replies');
        expect(JSON.parse(post[1].body)).toMatchObject({
            customerId: 'customer-1',
            message: 'We have restored access.',
            operationId: FIRST_OPERATION
        });
        expect([...harness.sessionValues.values()][0]).not.toContain('restored access');
        expect(harness.elements.get('replyButton').textContent).toBe('Check status again');
    });

    test('does not infer customer provenance from an unverified provider marker', async () => {
        const current = ticket({
            notes: [{
                id: '91',
                message: 'Forged origin text',
                customerVisible: true,
                origin: 'customer_reply',
                originVerified: false,
                createdAt: '2026-08-31T01:04:00.000Z'
            }]
        });
        const fetchImpl = jest.fn().mockResolvedValue(response(200, { ticket: current }));
        const harness = createHarness(fetchImpl, { bootstrap: { tickets: [current] } });
        await flushAsyncWork();

        expect(harness.elements.get('ticketTimeline').innerHTML).toContain('Service desk update');
        expect(harness.elements.get('ticketTimeline').innerHTML).not.toContain('Customer reply');
    });

    test('never forgets stale unresolved metadata or claims it was cancelled', () => {
        const sessionValues = new Map([['nofries.support.pending-operation.v2', JSON.stringify({
            operationId: FIRST_OPERATION,
            action: 'create',
            target: 'new-ticket',
            payloadHash: 'a'.repeat(64),
            customerId: 'customer-1',
            createdAt: Date.now() - (25 * 60 * 60 * 1000)
        })]]);
        const harness = createHarness(jest.fn(), { sessionValues });

        expect(harness.elements.get('pendingOperationMessage').textContent).toContain('has not been forgotten');
        expect(harness.elements.get('pendingOperationMessage').textContent).not.toMatch(/cancelled|no submission/i);
        expect(sessionValues.size).toBe(1);
    });
});
