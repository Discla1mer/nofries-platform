const {
    canonicalPriorityMapSha256,
    createAutotaskAdapter,
    projectTicket,
    resolveAutotaskAdapterConfig
} = require('../api/shared/serviceDesk/autotaskAdapter');

function config(overrides = {}) {
    const priorityMap = { low: 1, normal: 2, high: 3, urgent: 4 };
    return resolveAutotaskAdapterConfig(Object.assign({
        NOFRIES_AUTOTASK_QUEUE_ID: '1',
        NOFRIES_AUTOTASK_SOURCE_ID: '2',
        NOFRIES_AUTOTASK_DATTO_RMM_SOURCE_ID: '7',
        NOFRIES_AUTOTASK_ISSUE_TYPE_ID: '3',
        NOFRIES_AUTOTASK_SUBISSUE_TYPE_ID: '4',
        NOFRIES_AUTOTASK_CUSTOMER_VISIBLE_PUBLISH_VALUE: '5',
        NOFRIES_AUTOTASK_CUSTOMER_VISIBLE_NOTE_TYPE_ID: '6',
        NOFRIES_AUTOTASK_PORTAL_VISIBLE_UDF_NAME: 'NoFriesCustomerPortal',
        NOFRIES_AUTOTASK_PORTAL_VISIBLE_UDF_VALUE_JSON: 'true',
        NOFRIES_AUTOTASK_STATUS_MAP_JSON: JSON.stringify({ new: 1, open: 2, resolved: 5 }),
        NOFRIES_AUTOTASK_PRIORITY_MAP_JSON: JSON.stringify(priorityMap),
        NOFRIES_AUTOTASK_PRIORITY_MAP_SHA256: canonicalPriorityMapSha256(priorityMap),
        NOFRIES_AUTOTASK_DEVICE_MAP_JSON: '{}'
    }, overrides));
}

function rawTicket(overrides = {}) {
    return Object.assign({
        id: 700,
        ticketNumber: 'T20260831.0001',
        companyID: 10,
        installedProductID: 99,
        status: 1,
        priority: 3,
        source: 7,
        title: 'Email issue',
        createDate: '2026-08-31T01:00:00Z',
        lastTrackedModificationDateTime: '2026-08-31T01:01:00Z',
        userDefinedFields: [{ name: 'NoFriesCustomerPortal', value: true }]
    }, overrides);
}

describe('Autotask exact adapter', () => {
    test('projects only positively customer-visible notes and never raw description', () => {
        const projected = projectTicket(Object.assign(rawTicket(), { description: 'secret raw description' }), [
            { id: 1, ticketID: 700, description: 'Internal', publish: 1, noteType: 6, createDateTime: '2026-08-31T01:00:00Z' },
            { id: 3, ticketID: 700, description: 'Wrong type', publish: 5, noteType: 99, createDateTime: '2026-08-31T01:00:30Z' },
            { id: 4, ticketID: 701, description: 'Foreign ticket note', publish: 5, noteType: 6, createDateTime: '2026-08-31T01:00:40Z' },
            { id: 2, ticketID: 700, description: 'Visible\n\n[No Fries operation abcdefgh-1234]', publish: 5, noteType: 6, createDateTime: '2026-08-31T01:01:00Z' }
        ], {
            config: config(),
            devices: [{ id: 'device-one', autotaskInstalledProductId: '99' }]
        });
        expect(projected).toMatchObject({
            device: 'device-one',
            source: 'datto_rmm',
            status: 'new',
            priority: 'high',
            notes: [{ id: '2', message: 'Visible', customerVisible: true }]
        });
        expect(projected.description).toBeUndefined();
        expect(JSON.stringify(projected)).not.toContain('Internal');
        expect(JSON.stringify(projected)).not.toContain('Wrong type');
        expect(JSON.stringify(projected)).not.toContain('Foreign ticket note');
        expect(JSON.stringify(projected)).not.toContain('secret raw description');
    });

    test('does not hide tickets with unmapped status or device', () => {
        const projected = projectTicket(rawTicket({ status: 777, priority: 777, installedProductID: 888 }), [], { config: config(), devices: [] });
        expect(projected.status).toBe('unavailable');
        expect(projected.priority).toBe('unavailable');
        expect(projected.device).toBe('');
        expect(projected.projectionIssues).toEqual(expect.arrayContaining([
            { field: 'status', code: 'status_mapping_unavailable' },
            { field: 'priority', code: 'priority_mapping_unavailable' },
            { field: 'device', code: 'device_mapping_unavailable' }
        ]));
    });

    test('never falls back to another customer device mapping in a governed projection', () => {
        const mapped = config({ NOFRIES_AUTOTASK_DEVICE_MAP_JSON: JSON.stringify({ '10:other-device': 99 }) });
        const governed = projectTicket(rawTicket(), [], { config: mapped, devices: [] });
        expect(governed.device).toBe('');
        expect(governed.projectionIssues).toContainEqual({ field: 'device', code: 'device_mapping_unavailable' });

        const explicitlyUnscoped = projectTicket(rawTicket(), [], { config: mapped });
        expect(explicitlyUnscoped.device).toBe('other-device');
    });

    test('lists summaries in one paged ticket query without an N+1 note read', async () => {
        const client = {
            queryTickets: jest.fn().mockResolvedValue({ items: [rawTicket(), rawTicket({ id: 701, ticketNumber: 'T20260831.0002' })], pages: 1, truncated: false }),
            queryTicketNotes: jest.fn(),
            status: () => ({ writeOperationsEnabled: true })
        };
        const adapter = createAutotaskAdapter({ client, config: config() });
        const result = await adapter.listTickets({ companyId: '10', devices: [{ id: 'device-one', autotaskInstalledProductId: '99' }] });
        expect(result.tickets).toHaveLength(2);
        expect(client.queryTickets).toHaveBeenCalledTimes(1);
        expect(client.queryTicketNotes).not.toHaveBeenCalled();
    });

    test('fails closed when a provider list response contains a different company', async () => {
        const client = {
            queryTickets: jest.fn().mockResolvedValue({
                items: [rawTicket({ companyID: 11 })],
                pages: 1,
                truncated: false
            }),
            queryTicketNotes: jest.fn()
        };
        const adapter = createAutotaskAdapter({ client, config: config() });
        await expect(adapter.listTickets({ companyId: '10', devices: [] })).resolves.toMatchObject({ tickets: [] });
    });

    test('provider-filters and re-verifies portal-visible tickets without exposing internal same-company tickets', async () => {
        const visible = rawTicket();
        const internal = rawTicket({
            id: 701,
            ticketNumber: 'T20260831.0002',
            title: 'Internal security investigation',
            userDefinedFields: [{ name: 'NoFriesCustomerPortal', value: false }]
        });
        const client = {
            queryTickets: jest.fn().mockResolvedValue({ items: [visible, internal], pages: 1, truncated: false }),
            queryTicketNotes: jest.fn()
        };
        const adapter = createAutotaskAdapter({ client, config: config() });
        const listed = await adapter.listTickets({ companyId: '10', devices: [], portalVisibleOnly: true });
        expect(listed.tickets.map((ticket) => ticket.ticketNumber)).toEqual(['T20260831.0001']);
        expect(client.queryTickets.mock.calls[0][0]).toContainEqual({
            op: 'eq',
            field: 'NoFriesCustomerPortal',
            udf: true,
            value: true
        });

        client.queryTickets.mockResolvedValueOnce({ items: [internal], pages: 1, truncated: false });
        await expect(adapter.getTicketByNumber({
            companyId: '10',
            ticketNumber: 'T20260831.0002',
            devices: [],
            portalVisibleOnly: true
        })).rejects.toMatchObject({ statusCode: 404, details: { code: 'ticket_not_found' } });
        expect(client.queryTicketNotes).not.toHaveBeenCalled();
    });

    test.each([
        ['revoked', rawTicket({ userDefinedFields: [{ name: 'NoFriesCustomerPortal', value: false }] })],
        ['reassigned', rawTicket({ companyID: 11 })]
    ])('masks a portal ticket %s while detail notes are being projected', async (_case, afterNotes) => {
        const client = {
            queryTickets: jest.fn().mockResolvedValue({ items: [rawTicket()], pages: 1, truncated: false }),
            queryTicketNotes: jest.fn().mockResolvedValue({ items: [], truncated: false }),
            getTicket: jest.fn().mockResolvedValue(afterNotes)
        };
        const adapter = createAutotaskAdapter({ client, config: config() });
        await expect(adapter.getTicketByNumber({
            companyId: '10',
            ticketNumber: 'T20260831.0001',
            devices: [],
            portalVisibleOnly: true
        })).rejects.toMatchObject({ statusCode: 404, details: { code: 'ticket_not_found' } });
    });

    test('fails closed when provider version changes during a portal detail projection', async () => {
        const client = {
            queryTickets: jest.fn().mockResolvedValue({ items: [rawTicket()], pages: 1, truncated: false }),
            queryTicketNotes: jest.fn().mockResolvedValue({ items: [], truncated: false }),
            getTicket: jest.fn().mockResolvedValue(rawTicket({ lastTrackedModificationDateTime: '2026-08-31T01:02:00Z' }))
        };
        const adapter = createAutotaskAdapter({ client, config: config() });
        await expect(adapter.getTicketByNumber({
            companyId: '10',
            ticketNumber: 'T20260831.0001',
            devices: [],
            portalVisibleOnly: true
        })).rejects.toMatchObject({ statusCode: 409, details: { code: 'autotask_ticket_projection_changed' } });
    });

    test('requires an exact configured device before provider ticket creation', () => {
        const client = { status: () => ({ writeOperationsEnabled: true }) };
        const adapter = createAutotaskAdapter({ client, config: config() });
        expect(() => adapter.validateCreateInput({
            companyId: '10',
            operationId: 'operation-create-0001',
            deviceId: 'device-one',
            devices: [{ id: 'device-one', dattoDeviceUid: 'datto-one', autotaskInstalledProductId: '' }],
            priority: 'normal',
            subject: 'Email issue'
        })).toThrow(expect.objectContaining({ details: { code: 'autotask_device_mapping_required' } }));
    });

    test('fails readiness for partial, duplicate or digest-mismatched priority maps', () => {
        expect(config({
            NOFRIES_AUTOTASK_PRIORITY_MAP_JSON: JSON.stringify({ low: 1, normal: 2, high: 3 }),
            NOFRIES_AUTOTASK_PRIORITY_MAP_SHA256: canonicalPriorityMapSha256({ low: 1, normal: 2, high: 3 })
        }).configurationError).toMatch(/exactly low, normal, high and urgent/);
        expect(config({
            NOFRIES_AUTOTASK_PRIORITY_MAP_JSON: JSON.stringify({ low: 1, normal: 1, high: 3, urgent: 4 }),
            NOFRIES_AUTOTASK_PRIORITY_MAP_SHA256: canonicalPriorityMapSha256({ low: 1, normal: 1, high: 3, urgent: 4 })
        }).configurationError).toMatch(/values must be unique/);
        expect(config({ NOFRIES_AUTOTASK_PRIORITY_MAP_SHA256: 'f'.repeat(64) }).configurationError)
            .toMatch(/must match/);
    });

    test('requires a distinct exact Datto RMM source mapping for readiness', () => {
        expect(config({ NOFRIES_AUTOTASK_DATTO_RMM_SOURCE_ID: '' }).configurationError).toBe('');
        const missing = createAutotaskAdapter({ client: {}, config: config({ NOFRIES_AUTOTASK_DATTO_RMM_SOURCE_ID: '' }) }).status();
        expect(missing).toMatchObject({ configured: false, dattoRmmSourceMappingReady: false });
        expect(config({ NOFRIES_AUTOTASK_DATTO_RMM_SOURCE_ID: '2' }).configurationError).toMatch(/must be distinct/);
    });

    test('keeps the semantic provider intent stable across operation IDs', () => {
        const adapter = createAutotaskAdapter({ client: {}, config: config() });
        const base = {
            companyId: '10',
            devices: [],
            priority: 'normal',
            subject: 'Email issue'
        };
        expect(adapter.providerIntentSha256('create', Object.assign({}, base, { operationId: 'operation-create-0001' })))
            .toBe(adapter.providerIntentSha256('create', Object.assign({}, base, { operationId: 'operation-create-0002' })));
    });

    test('round-trips a non-default canonical priority through the provider payload', async () => {
        const client = {
            createTicket: jest.fn().mockResolvedValue({ itemId: '700' }),
            getTicket: jest.fn().mockResolvedValue(rawTicket({
                priority: 4,
                source: 2,
                queueID: 1,
                issueType: 3,
                subIssueType: 4,
                installedProductID: null,
                userDefinedFields: [
                    { name: 'NoFriesOperationId', value: 'operation-create-0001' },
                    { name: 'NoFriesCustomerPortal', value: true }
                ]
            })),
            queryTicketNotes: jest.fn().mockResolvedValue({ items: [], truncated: false })
        };
        const adapter = createAutotaskAdapter({ client, config: config() });
        const ticket = await adapter.createTicket({
            companyId: '10',
            operationId: 'operation-create-0001',
            devices: [],
            priority: 'urgent',
            subject: 'Email issue'
        });
        expect(client.createTicket).toHaveBeenCalledWith(expect.objectContaining({ priority: 4 }));
        expect(client.createTicket).toHaveBeenCalledWith(expect.objectContaining({
            userDefinedFields: expect.arrayContaining([
                { name: 'NoFriesOperationId', value: 'operation-create-0001' },
                { name: 'NoFriesCustomerPortal', value: true }
            ])
        }));
        expect(ticket.priority).toBe('urgent');
        expect(ticket.source).toBe('no_fries');
        expect(ticket.portalVisible).toBe(true);
    });

    test('verifies the governed contact company and exact created-ticket readback', async () => {
        const createdRaw = rawTicket({
            source: 2,
            queueID: 1,
            issueType: 3,
            subIssueType: 4,
            priority: 3,
            installedProductID: null,
            contactID: 20,
            userDefinedFields: [
                { name: 'NoFriesOperationId', value: 'operation-create-0001' },
                { name: 'NoFriesCustomerPortal', value: true }
            ]
        });
        const client = {
            getContact: jest.fn().mockResolvedValue({ id: 20, companyID: 10 }),
            createTicket: jest.fn().mockResolvedValue({ itemId: '700' }),
            getTicket: jest.fn().mockResolvedValue(createdRaw),
            queryTicketNotes: jest.fn().mockResolvedValue({ items: [], truncated: false })
        };
        const adapter = createAutotaskAdapter({ client, config: config() });
        await expect(adapter.createTicket({
            companyId: '10',
            contactId: '20',
            operationId: 'operation-create-0001',
            devices: [],
            priority: 'high',
            subject: 'Email issue'
        })).resolves.toMatchObject({ id: '700', companyId: '10', source: 'no_fries' });
        expect(client.createTicket).toHaveBeenCalledWith(expect.objectContaining({ companyID: 10, contactID: 20 }));

        client.getContact.mockResolvedValueOnce({ id: 20, companyID: 11 });
        await expect(adapter.createTicket({
            companyId: '10',
            contactId: '20',
            operationId: 'operation-create-0002',
            devices: [],
            priority: 'high',
            subject: 'Email issue'
        })).rejects.toMatchObject({ details: { code: 'autotask_contact_company_mismatch', providerDispatched: false } });
        expect(client.createTicket).toHaveBeenCalledTimes(1);
    });

    test('keeps a misdirected create or note 2xx uncertain until exact readback reconciles', async () => {
        const createdRaw = rawTicket({
            title: 'Another ticket',
            source: 2,
            queueID: 1,
            issueType: 3,
            subIssueType: 4,
            priority: 2,
            installedProductID: null,
            userDefinedFields: [
                { name: 'NoFriesOperationId', value: 'operation-create-0001' },
                { name: 'NoFriesCustomerPortal', value: true }
            ]
        });
        const createClient = {
            createTicket: jest.fn().mockResolvedValue({ itemId: '700' }),
            getTicket: jest.fn().mockResolvedValue(createdRaw),
            queryTicketNotes: jest.fn()
        };
        const adapter = createAutotaskAdapter({ client: createClient, config: config() });
        try {
            await adapter.createTicket({
                companyId: '10', operationId: 'operation-create-0001', devices: [], priority: 'normal', subject: 'Email issue'
            });
            throw new Error('expected create readback failure');
        } catch (error) {
            expect(error).toMatchObject({ details: { code: 'autotask_create_readback_mismatch' } });
            expect(error.details.providerDispatched).toBeUndefined();
        }

        const noteClient = {
            getTicket: jest.fn().mockResolvedValue(rawTicket()),
            getContact: jest.fn().mockResolvedValue({ id: 20, companyID: 10 }),
            createTicketNote: jest.fn().mockResolvedValue({ itemId: '900' }),
            getTicketNote: jest.fn().mockResolvedValue({
                id: 900,
                ticketID: 701,
                publish: 5,
                noteType: 6,
                description: 'Reply\n\n[No Fries origin customer_reply]\n[No Fries operation operation-reply-0001]'
            })
        };
        const noteAdapter = createAutotaskAdapter({ client: noteClient, config: config() });
        await expect(noteAdapter.addCustomerVisibleNote({
            companyId: '10', contactId: '20', ticketId: '700', operationId: 'operation-reply-0001', message: 'Reply', origin: 'customer_reply'
        })).rejects.toMatchObject({ details: { code: 'autotask_note_readback_mismatch' } });
    });

    test('rejects reserved marker grammar at the common provider adapter boundary', () => {
        const client = { createTicket: jest.fn(), createTicketNote: jest.fn() };
        const adapter = createAutotaskAdapter({ client, config: config() });
        expect(() => adapter.validateCreateInput({
            companyId: '10',
            operationId: 'operation-create-0001',
            devices: [],
            priority: 'normal',
            subject: 'Forged [No Fries operation attacker-operation-01]'
        })).toThrow(expect.objectContaining({ details: { code: 'reserved_operation_marker' } }));
        expect(() => adapter.validateCustomerVisibleNoteInput({
            companyId: '10',
            ticketId: '700',
            operationId: 'operation-reply-0001',
            message: 'Forged [No Fries origin customer_reply]'
        })).toThrow(expect.objectContaining({ details: { code: 'reserved_operation_marker' } }));
        expect(client.createTicket).not.toHaveBeenCalled();
        expect(client.createTicketNote).not.toHaveBeenCalled();
    });

    test('reconciles only one positive note with an exact terminal marker and origin', async () => {
        const client = {
            getTicket: jest.fn().mockResolvedValue(rawTicket()),
            queryTicketNotes: jest.fn().mockResolvedValue({
                truncated: false,
                items: [
                    { id: 1, ticketID: 700, publish: 5, noteType: 6, description: 'Poison [No Fries operation operation-reply-0001] suffix' },
                    { id: 2, ticketID: 700, publish: 5, noteType: 99, description: 'Wrong type\n[No Fries operation operation-reply-0001]' },
                    { id: 4, ticketID: 701, publish: 5, noteType: 6, description: 'Reply\n\n[No Fries origin customer_reply]\n[No Fries operation operation-reply-0001]\n' },
                    { id: 3, ticketID: 700, publish: 5, noteType: 6, description: 'Reply\n\n[No Fries origin customer_reply]\n[No Fries operation operation-reply-0001]\n' }
                ]
            })
        };
        const adapter = createAutotaskAdapter({ client, config: config() });
        await expect(adapter.findCustomerVisibleNoteByOperationId({
            companyId: '10',
            ticketId: '700',
            operationId: 'operation-reply-0001',
            origin: 'customer_reply',
            contactId: '20',
            expectedMessage: 'Reply'
        })).resolves.toMatchObject({ id: '3', message: 'Reply', origin: 'service_desk_update', originVerified: false, customerVisible: true });
    });

    test('does not write or reconcile a portal note after visibility is revoked', async () => {
        const client = {
            getTicket: jest.fn().mockResolvedValue(rawTicket({
                userDefinedFields: [{ name: 'NoFriesCustomerPortal', value: false }]
            })),
            createTicketNote: jest.fn(),
            queryTicketNotes: jest.fn()
        };
        const adapter = createAutotaskAdapter({ client, config: config() });
        const input = {
            companyId: '10',
            ticketId: '700',
            operationId: 'operation-reply-0001',
            message: 'Customer reply',
            origin: 'customer_reply',
            contactId: '20',
            portalVisibleOnly: true
        };
        await expect(adapter.addCustomerVisibleNote(input))
            .rejects.toMatchObject({ statusCode: 404, details: { code: 'ticket_not_found' } });
        await expect(adapter.findCustomerVisibleNoteByOperationId(input))
            .rejects.toMatchObject({ statusCode: 404, details: { code: 'ticket_not_found' } });
        expect(client.createTicketNote).not.toHaveBeenCalled();
        expect(client.queryTicketNotes).not.toHaveBeenCalled();
    });

    test.each([
        ['missing', undefined],
        ['non-canonical', 'contact-20'],
        ['unsafe', '9007199254740992']
    ])('rejects a %s portal-reply contact before any provider read or note POST', async (_case, contactId) => {
        const client = {
            getTicket: jest.fn(),
            getContact: jest.fn(),
            createTicketNote: jest.fn()
        };
        const adapter = createAutotaskAdapter({ client, config: config() });
        await expect(adapter.addCustomerVisibleNote({
            companyId: '10',
            contactId,
            ticketId: '700',
            operationId: 'operation-reply-contact-invalid',
            message: 'Customer reply',
            origin: 'customer_reply',
            portalVisibleOnly: true
        })).rejects.toMatchObject({ details: { code: 'autotask_contact_mapping_required' } });
        expect(client.getTicket).not.toHaveBeenCalled();
        expect(client.getContact).not.toHaveBeenCalled();
        expect(client.createTicketNote).not.toHaveBeenCalled();
    });

    test.each([
        ['moved to another company', () => Promise.resolve({ id: 20, companyID: 11 }), 'autotask_contact_company_mismatch'],
        ['revoked or replaced', () => Promise.resolve({ id: 21, companyID: 10 }), 'autotask_contact_company_mismatch'],
        ['unavailable provider read', () => Promise.reject(new Error('contact read unavailable')), 'autotask_note_preflight_failed']
    ])('does not POST a portal reply when the governed contact is %s', async (_case, getContact, code) => {
        const client = {
            getTicket: jest.fn().mockResolvedValue(rawTicket()),
            getContact: jest.fn(getContact),
            createTicketNote: jest.fn()
        };
        const adapter = createAutotaskAdapter({ client, config: config() });
        await expect(adapter.addCustomerVisibleNote({
            companyId: '10',
            contactId: '20',
            ticketId: '700',
            operationId: 'operation-reply-contact-preflight',
            message: 'Customer reply',
            origin: 'customer_reply',
            portalVisibleOnly: true
        })).rejects.toMatchObject({ details: { code, providerDispatched: false } });
        expect(client.getContact).toHaveBeenCalledTimes(1);
        expect(client.getContact).toHaveBeenCalledWith('20');
        expect(client.createTicketNote).not.toHaveBeenCalled();
    });

    test('freshly verifies the exact portal contact-company binding before the note POST', async () => {
        const description = 'Customer reply\n\n[No Fries origin customer_reply]\n[No Fries operation operation-reply-contact-exact]';
        const client = {
            getTicket: jest.fn().mockResolvedValue(rawTicket()),
            getContact: jest.fn().mockResolvedValue({ id: 20, companyID: 10 }),
            createTicketNote: jest.fn().mockResolvedValue({ itemId: '900' }),
            getTicketNote: jest.fn().mockResolvedValue({
                id: 900,
                ticketID: 700,
                publish: 5,
                noteType: 6,
                description
            })
        };
        const adapter = createAutotaskAdapter({ client, config: config() });
        await expect(adapter.addCustomerVisibleNote({
            companyId: '10',
            contactId: '20',
            ticketId: '700',
            operationId: 'operation-reply-contact-exact',
            message: 'Customer reply',
            origin: 'customer_reply',
            portalVisibleOnly: true
        })).resolves.toMatchObject({ id: '900', message: 'Customer reply', customerVisible: true });
        expect(client.getContact).toHaveBeenCalledTimes(1);
        expect(client.getContact.mock.invocationCallOrder[0])
            .toBeLessThan(client.createTicketNote.mock.invocationCallOrder[0]);
        expect(client.createTicketNote).toHaveBeenCalledWith(expect.objectContaining({
            ticketID: 700,
            description
        }));
    });

    test('does not adopt an operation-marker ticket whose portal visibility was revoked', async () => {
        const client = {
            queryTickets: jest.fn().mockResolvedValue({
                items: [rawTicket({ userDefinedFields: [
                    { name: 'NoFriesOperationId', value: 'operation-create-0001' },
                    { name: 'NoFriesCustomerPortal', value: false }
                ] })],
                pages: 1,
                truncated: false
            }),
            queryTicketNotes: jest.fn()
        };
        const adapter = createAutotaskAdapter({ client, config: config() });
        await expect(adapter.findTicketByOperationId({
            companyId: '10',
            operationId: 'operation-create-0001',
            devices: [],
            portalVisibleOnly: true
        })).rejects.toMatchObject({ details: { code: 'autotask_portal_visibility_verification_failed' } });
        expect(client.queryTicketNotes).not.toHaveBeenCalled();
    });
});
