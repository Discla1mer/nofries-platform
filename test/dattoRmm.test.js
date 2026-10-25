const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDattoRmmClient } = require('../api/shared/integrations/dattoRmmClient');
const { controlledOnboardingPlan, handleDattoRmmRequest } = require('../api/shared/dattoRmmRuntime');
const { createLifecycleRepository } = require('../api/shared/lifecycle/lifecycleRepository');
const { createLifecycleService } = require('../api/shared/lifecycle/lifecycleService');
const { ROLE_CAPABILITIES, tenantStorageKey } = require('../api/shared/tenantAccess');

describe('Datto RMM read-only trial bridge', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-datto-rmm-test-'));
    const originalEnv = Object.assign({}, process.env);

    afterEach(() => {
        process.env = Object.assign({}, originalEnv);
        jest.restoreAllMocks();
    });

    afterAll(() => {
        fs.rmSync(dataDir, { recursive: true, force: true });
    });

    test('status is secret-free and unsafe provider hosts fail closed', async () => {
        const token = 'trial-access-token-that-must-stay-server-side';
        const client = createDattoRmmClient({
            env: {
                NOFRIES_DATTO_RMM_MODE: 'readonly',
                NOFRIES_DATTO_RMM_API_URL: 'https://example.invalid',
                NOFRIES_DATTO_RMM_ACCESS_TOKEN: token
            }
        });

        expect(client.status()).toMatchObject({
            provider: 'datto_rmm',
            readOnly: true,
            configured: false,
            state: 'invalid_configuration',
            writeOperationsEnabled: false
        });
        expect(JSON.stringify(client.status())).not.toContain(token);
        await expect(client.health()).rejects.toMatchObject({
            statusCode: 503,
            details: { code: 'datto_rmm_not_configured' }
        });
    });

    test('site discovery follows only same-origin API pagination and sends GET requests', async () => {
        const fetch = jest.fn(async (url, init) => {
            const parsed = new URL(url);
            const page = parsed.searchParams.get('page');
            return response(page === '2' ? {
                sites: [{ uid: 'site-two', name: 'Second site', numberOfDevices: 2 }],
                pageDetails: {}
            } : {
                sites: [{ uid: 'site-one', name: 'First site', numberOfDevices: 1 }],
                pageDetails: {
                    nextPageUrl: 'https://vidal-api.centrastage.net/api/v2/account/sites?max=250&page=2'
                }
            });
        });
        const client = configuredClient(fetch);
        const result = await client.listSites();

        expect(result).toMatchObject({
            truncated: false,
            pages: 2,
            sites: [
                { siteUid: 'site-one', name: 'First site', deviceCount: 1 },
                { siteUid: 'site-two', name: 'Second site', deviceCount: 2 }
            ]
        });
        expect(fetch).toHaveBeenCalledTimes(2);
        fetch.mock.calls.forEach(([, init]) => {
            expect(init.method).toBe('GET');
            expect(init.headers.Authorization).toBe('Bearer server-only-token');
        });
    });

    test('site snapshots expose bounded device and alert evidence without provider writes', async () => {
        const fetch = jest.fn(async (url, init) => {
            expect(init.method).toBe('GET');
            const pathname = new URL(url).pathname;
            if (pathname.endsWith('/devices')) {
                return response({ devices: [{ uid: 'device-1', hostname: 'PILOT-01', status: 'online' }], pageDetails: {} });
            }
            if (pathname.endsWith('/alerts/open')) {
                return response({ alerts: [{ uid: 'alert-1', deviceUid: 'device-1', severity: 'high' }], pageDetails: {} });
            }
            return response({ uid: 'site-one', name: 'No Fries Pilot' });
        });
        const client = configuredClient(fetch);
        const snapshot = await client.getSiteSnapshot('site-one');

        expect(snapshot).toMatchObject({
            site: { siteUid: 'site-one', name: 'No Fries Pilot' },
            devices: [{ deviceUid: 'device-1', hostname: 'PILOT-01', online: true }],
            openAlerts: [{ alertUid: 'alert-1', deviceUid: 'device-1', priority: 'high' }],
            readOnly: true,
            truncated: false
        });
        expect(fetch).toHaveBeenCalledTimes(3);
    });

    test('lifecycle sync is stage-gated, one-to-one, reconciled and audited', async () => {
        const repository = createLifecycleRepository({ provider: 'local', dataDir });
        const service = createLifecycleService({
            repository,
            now: () => new Date('2026-08-17T04:00:00.000Z'),
            approvedProposalVerifier: {
                verify: jest.fn(async (_access, expected) => ({
                    verified: expected.proposalVersion === 'v1' && expected.proposalSha256 === 'a'.repeat(64),
                    binding: expected
                }))
            }
        });
        const access = operatorAccess('tenant-a');
        let created = await service.createOrganisation(access, {
            displayName: 'Trial Customer',
            facts: [{ field: 'endpoints.estimatedCount', value: 3, certainty: 'explicit' }]
        });
        for (const lifecycleState of ['discovery', 'scoping']) {
            created = await service.updateOrganisation(access, created.organisation.organisationId, {
                expectedRevision: created.revision,
                lifecycleState
            });
        }
        created = await service.linkScopingRecords(access, created.organisation.organisationId, {
            expectedRevision: created.revision,
            salesCustomerId: 'sales-trial-customer',
            assessmentId: 'assessment-trial-customer',
            remainingGapCount: 0
        });
        created = await service.bindApprovedProposal(access, created.organisation.organisationId, {
            expectedRevision: created.revision,
            proposalId: 'proposal-trial-customer',
            proposalVersion: 'v1',
            proposalSha256: 'a'.repeat(64),
            confirmApprovedProposal: true
        });
        created = await acceptProposal(service, access, created, 'proposal-trial-customer');
        await expect(service.updateOrganisation(access, created.organisation.organisationId, {
            expectedRevision: created.revision,
            links: { dattoRmmSiteUid: 'unverified-site' }
        })).rejects.toMatchObject({
            details: { code: 'external_reference_flow_required' }
        });
        const synced = await service.syncDattoRmmSnapshot(access, created.organisation.organisationId, {
            expectedRevision: created.revision,
            siteUid: 'site-one',
            siteName: 'Trial Customer',
            deviceCount: 2,
            openAlertCount: 1
        });

        expect(synced.organisation).toMatchObject({
            links: { dattoRmmSiteUid: 'site-one' },
            context: { endpoints: { estimatedCount: 3, managedCount: 2 } },
            integrations: {
                dattoRmm: {
                    status: 'linked',
                    mode: 'readonly',
                    deviceCount: 2,
                    expectedDeviceCount: 3,
                    openAlertCount: 1,
                    reconciliationStatus: 'review_required'
                }
            }
        });
        expect(synced.organisation.exceptions).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'datto_device_count_mismatch' }),
            expect.objectContaining({ code: 'datto_open_alerts' })
        ]));
        const bootstrap = await service.bootstrap(access);
        expect(bootstrap.activity[0]).toMatchObject({
            action: 'integration.datto_rmm.snapshot_synced',
            organisationId: created.organisation.organisationId,
            details: { siteUid: 'site-one', mode: 'readonly' }
        });

        let second = await service.createOrganisation(access, {
            displayName: 'Other Customer',
            expectedRevision: synced.revision
        });
        for (const lifecycleState of ['discovery', 'scoping']) {
            second = await service.updateOrganisation(access, second.organisation.organisationId, {
                expectedRevision: second.revision,
                lifecycleState
            });
        }
        second = await service.linkScopingRecords(access, second.organisation.organisationId, {
            expectedRevision: second.revision,
            salesCustomerId: 'sales-other-customer',
            assessmentId: 'assessment-other-customer',
            remainingGapCount: 0
        });
        second = await service.bindApprovedProposal(access, second.organisation.organisationId, {
            expectedRevision: second.revision,
            proposalId: 'proposal-other-customer',
            proposalVersion: 'v1',
            proposalSha256: 'a'.repeat(64),
            confirmApprovedProposal: true
        });
        second = await acceptProposal(service, access, second, 'proposal-other-customer');
        await expect(service.syncDattoRmmSnapshot(access, second.organisation.organisationId, {
            expectedRevision: second.revision,
            siteUid: 'site-one',
            siteName: 'Trial Customer',
            deviceCount: 2,
            openAlertCount: 0
        })).rejects.toMatchObject({
            statusCode: 409,
            details: { code: 'datto_rmm_site_link_conflict' }
        });
    });

    test('protected runtime exposes status but rejects cross-site link requests', async () => {
        setDevelopmentIdentity();
        const client = {
            status: () => ({ provider: 'datto_rmm', configured: true, readOnly: true, accessToken: undefined })
        };
        const status = await handleDattoRmmRequest(request('GET', '/api/datto-rmm/status'), {}, { client });
        expect(status).toMatchObject({ status: 200, body: { provider: 'datto_rmm', configured: true, readOnly: true } });
        expect(JSON.stringify(status.body)).not.toContain('server-only-token');

        await expect(handleDattoRmmRequest({
            method: 'POST',
            url: '/api/datto-rmm/sites/site-one/link',
            headers: { 'sec-fetch-site': 'cross-site' },
            body: { email: 'joel@example.com', organisationId: 'organisation-1' }
        }, {}, { client })).rejects.toMatchObject({
            statusCode: 403,
            details: { code: 'same_origin_required' }
        });

        process.env.NOFRIES_ADMIN_EMAILS = 'admin@example.com';
        const getSiteSnapshot = jest.fn();
        await expect(handleDattoRmmRequest({
            method: 'POST',
            url: '/api/datto-rmm/sites/site-one/link',
            headers: {},
            body: { email: 'joel@example.com', organisationId: 'organisation-1' }
        }, {}, { client: { status: client.status, getSiteSnapshot } })).rejects.toMatchObject({
            statusCode: 403,
            details: { code: 'capability_required', capability: 'integration:map' }
        });
        expect(getSiteSnapshot).not.toHaveBeenCalled();
    });

    test('the Datto provider account is bound to one exact No Fries tenant', async () => {
        setDevelopmentIdentity();
        process.env.NOFRIES_DATTO_RMM_TENANT_ID = 'tenant-b';
        const client = {
            status: jest.fn(() => ({
                provider: 'datto_rmm',
                mode: 'controlled_write',
                configured: true,
                state: 'ready',
                writeOperationsEnabled: true
            })),
            health: jest.fn()
        };

        const status = await handleDattoRmmRequest(request('GET', '/api/datto-rmm/status'), {}, { client });
        expect(status).toMatchObject({
            status: 200,
            body: {
                configured: false,
                writeOperationsEnabled: false,
                state: 'tenant_binding_mismatch',
                tenantBindingConfigured: true,
                tenantBindingMatches: false
            }
        });
        await expect(handleDattoRmmRequest(request('GET', '/api/datto-rmm/health'), {}, { client })).rejects.toMatchObject({
            statusCode: 403,
            details: { code: 'datto_rmm_tenant_binding_mismatch' }
        });
        expect(client.health).not.toHaveBeenCalled();

        delete process.env.NOFRIES_DATTO_RMM_TENANT_ID;
        const missingBinding = await handleDattoRmmRequest(request('GET', '/api/datto-rmm/status'), {}, { client });
        expect(missingBinding).toMatchObject({
            status: 200,
            body: {
                configured: false,
                writeOperationsEnabled: false,
                state: 'tenant_binding_required',
                tenantBindingConfigured: false,
                tenantBindingMatches: false
            }
        });
    });

    test('consultants cannot enumerate Datto partner sites', async () => {
        setDevelopmentIdentity();
        process.env.NOFRIES_ADMIN_EMAILS = 'admin@example.com';
        process.env.NOFRIES_SERVICE_OWNER_EMAILS = 'owner@example.com';
        const listSites = jest.fn();

        await expect(handleDattoRmmRequest(
            request('GET', '/api/datto-rmm/sites'),
            {},
            { client: { listSites } }
        )).rejects.toMatchObject({
            statusCode: 403,
            details: { code: 'capability_required', capability: 'integration:discover' }
        });
        expect(listSites).not.toHaveBeenCalled();
        expect(ROLE_CAPABILITIES.admin).toEqual(expect.arrayContaining(['integration:discover', 'integration:map']));
        expect(ROLE_CAPABILITIES.service_owner).toEqual(expect.arrayContaining(['integration:discover', 'integration:map']));
        expect(ROLE_CAPABILITIES.consultant).not.toEqual(expect.arrayContaining(['integration:discover']));
        expect(ROLE_CAPABILITIES.consultant).not.toEqual(expect.arrayContaining(['integration:map']));
    });

    test('site snapshots require a lifecycle organisation before provider access', async () => {
        setDevelopmentIdentity();
        const getSiteSnapshot = jest.fn();
        const getSharedContext = jest.fn();

        await expect(handleDattoRmmRequest(
            request('GET', '/api/datto-rmm/sites/site-one/snapshot'),
            {},
            { client: { getSiteSnapshot }, lifecycleService: { getSharedContext } }
        )).rejects.toMatchObject({
            statusCode: 400,
            details: { code: 'organisation_required' }
        });
        expect(getSharedContext).not.toHaveBeenCalled();
        expect(getSiteSnapshot).not.toHaveBeenCalled();
    });

    test('site snapshots reject a wrong site and organisation pair before provider access', async () => {
        setDevelopmentIdentity();
        const getSiteSnapshot = jest.fn();
        const getSharedContext = jest.fn().mockResolvedValue({
            organisationId: 'organisation-one',
            links: { dattoRmmSiteUid: 'site-two' },
            integrations: { dattoRmm: { siteUid: 'site-two' } }
        });
        const req = request('GET', '/api/datto-rmm/sites/site-one/snapshot');
        req.query.organisationId = 'organisation-one';

        await expect(handleDattoRmmRequest(
            req,
            {},
            { client: { getSiteSnapshot }, lifecycleService: { getSharedContext } }
        )).rejects.toMatchObject({
            statusCode: 403,
            details: { code: 'datto_rmm_site_mapping_required' }
        });
        expect(getSharedContext).toHaveBeenCalledWith(
            expect.objectContaining({ tenant: expect.objectContaining({ id: 'tenant-a' }) }),
            'organisation-one'
        );
        expect(getSiteSnapshot).not.toHaveBeenCalled();
    });

    test('site snapshots return provider data only for the mapped lifecycle organisation', async () => {
        setDevelopmentIdentity();
        const snapshot = {
            site: { siteUid: 'site-one', name: 'Mapped customer' },
            devices: [],
            openAlerts: [],
            truncated: false,
            readOnly: true,
            capturedAt: '2026-08-17T03:00:00.000Z'
        };
        const getSiteSnapshot = jest.fn().mockResolvedValue(snapshot);
        const getSharedContext = jest.fn().mockResolvedValue({
            organisationId: 'organisation-one',
            links: { dattoRmmSiteUid: 'site-one' },
            integrations: { dattoRmm: { siteUid: 'site-one' } }
        });
        const req = request('GET', '/api/datto-rmm/sites/site-one/snapshot');
        req.body.organisationId = 'organisation-one';

        const result = await handleDattoRmmRequest(
            req,
            {},
            { client: { getSiteSnapshot }, lifecycleService: { getSharedContext } }
        );

        expect(result).toMatchObject({ status: 200, body: snapshot });
        expect(getSharedContext).toHaveBeenCalledTimes(1);
        expect(getSiteSnapshot).toHaveBeenCalledWith('site-one');
    });

    test('site snapshots reject provider data for a different site UID', async () => {
        setDevelopmentIdentity();
        const getSiteSnapshot = jest.fn().mockResolvedValue({
            site: { siteUid: 'site-two', name: 'Wrong customer' },
            devices: [],
            openAlerts: [],
            truncated: false,
            readOnly: true,
            capturedAt: '2026-08-17T03:00:00.000Z'
        });
        const getSharedContext = jest.fn().mockResolvedValue({
            organisationId: 'organisation-one',
            links: { dattoRmmSiteUid: 'site-one' },
            integrations: { dattoRmm: { siteUid: 'site-one' } }
        });
        const req = request('GET', '/api/datto-rmm/sites/site-one/snapshot');
        req.query.organisationId = 'organisation-one';

        await expect(handleDattoRmmRequest(
            req,
            {},
            { client: { getSiteSnapshot }, lifecycleService: { getSharedContext } }
        )).rejects.toMatchObject({
            statusCode: 502,
            details: {
                code: 'datto_rmm_site_uid_mismatch',
                requestedSiteUid: 'site-one',
                providerSiteUid: 'site-two'
            }
        });
        expect(getSiteSnapshot).toHaveBeenCalledWith('site-one');
    });

    test('link handoff rejects a provider snapshot for a different site UID', async () => {
        setDevelopmentIdentity();
        const getSiteSnapshot = jest.fn().mockResolvedValue({
            site: { siteUid: 'site-two', name: 'Wrong customer' },
            devices: [],
            openAlerts: [],
            truncated: false,
            capturedAt: '2026-08-17T03:00:00.000Z'
        });
        const syncDattoRmmSnapshot = jest.fn();

        await expect(handleDattoRmmRequest({
            method: 'POST',
            url: '/api/datto-rmm/sites/site-one/link',
            headers: {},
            query: { email: 'joel@example.com' },
            body: { organisationId: 'organisation-one', expectedRevision: 6 }
        }, {}, {
            client: { getSiteSnapshot },
            lifecycleService: { syncDattoRmmSnapshot }
        })).rejects.toMatchObject({
            statusCode: 502,
            details: {
                code: 'datto_rmm_site_uid_mismatch',
                requestedSiteUid: 'site-one',
                providerSiteUid: 'site-two'
            }
        });
        expect(syncDattoRmmSnapshot).not.toHaveBeenCalled();
    });

    test('link handoff sends bounded normalized device evidence to lifecycle', async () => {
        setDevelopmentIdentity();
        const devices = Array.from({ length: 2501 }, (_, index) => ({
            deviceUid: `device-${index}`,
            hostname: index === 0 ? 'PILOT-01\u0000' : `PILOT-${index}`,
            operatingSystem: index === 0 ? 'Windows 11' : 'Unknown',
            lastSeen: index === 0 ? '2026-08-17T15:00:00+12:00' : 'not-a-date',
            online: index === 0,
            providerOnlyField: 'must-not-cross-boundary'
        }));
        const getSiteSnapshot = jest.fn().mockResolvedValue({
            site: { siteUid: 'site-one', name: 'Mapped customer' },
            devices,
            openAlerts: [],
            truncated: false,
            capturedAt: '2026-08-17T15:00:00+12:00'
        });
        const syncDattoRmmSnapshot = jest.fn().mockResolvedValue({ revision: 7, organisation: {} });

        const result = await handleDattoRmmRequest({
            method: 'POST',
            url: '/api/datto-rmm/sites/site-one/link',
            headers: {},
            query: { email: 'joel@example.com' },
            body: { organisationId: 'organisation-one', expectedRevision: 6 }
        }, {}, {
            client: { getSiteSnapshot },
            lifecycleService: { syncDattoRmmSnapshot }
        });

        expect(result.status).toBe(200);
        expect(syncDattoRmmSnapshot).toHaveBeenCalledTimes(1);
        const [, organisationId, payload] = syncDattoRmmSnapshot.mock.calls[0];
        expect(organisationId).toBe('organisation-one');
        expect(payload).toMatchObject({
            expectedRevision: 6,
            siteUid: 'site-one',
            siteName: 'Mapped customer',
            deviceCount: 2501,
            openAlertCount: 0,
            capturedAt: '2026-08-17T03:00:00.000Z',
            truncated: false
        });
        expect(payload.devices).toHaveLength(2500);
        expect(payload.devices[0]).toEqual({
            deviceUid: 'device-0',
            hostname: 'PILOT-01',
            operatingSystem: 'Windows 11',
            lastSeen: '2026-08-17T03:00:00.000Z',
            online: true
        });
        expect(Object.keys(payload.devices[0])).toEqual([
            'deviceUid',
            'hostname',
            'operatingSystem',
            'lastSeen',
            'online'
        ]);
    });

    test('controlled onboarding prepares the exact lifecycle site and platform handoffs', async () => {
        setDevelopmentIdentity();
        const organisation = {
            organisationId: 'organisation-no-fries-hq',
            displayName: 'No Fries HQ',
            lifecycleState: 'onboarding',
            commercialAcceptance: { status: 'verified' },
            links: { dattoRmmSiteUid: '' },
            integrations: { dattoRmm: { status: 'not_connected', siteUid: '' } },
            onboarding: {
                planId: 'onboarding-plan-hq',
                planVersion: 1,
                devices: [
                    { id: 'dell-laptop', label: 'Dell laptop', platform: 'windows', owner: 'joel@example.com', status: 'planned' },
                    { id: 'older-macbook', label: 'Older Apple MacBook', platform: 'macos', owner: 'joel@example.com', status: 'planned' }
                ]
            }
        };
        const client = {
            status: jest.fn(() => ({ mode: 'controlled_write', writeOperationsEnabled: true })),
            getSiteSnapshot: jest.fn(async () => ({
                site: { siteUid: 'site-hq-uid', siteId: 123, name: 'No Fries Headquarters' },
                devices: [],
                openAlerts: [],
                truncated: false,
                capturedAt: '2026-08-21T02:00:00.000Z'
            }))
        };
        const provisioningClient = {
            status: jest.fn(() => ({
                mode: 'controlled_write',
                configured: true,
                writeOperationsEnabled: true,
                state: 'ready'
            })),
            ensureManagedSite: jest.fn(async () => ({
                created: true,
                site: { siteUid: 'site-hq-uid', siteId: 123, name: 'No Fries Headquarters' }
            })),
            buildInstallerHandoffs: jest.fn((_site, devices) => devices.map((device) => ({
                deviceId: device.deviceId,
                label: device.label,
                platform: device.platform,
                downloadUrl: `https://vidal.rmm.datto.com/download-agent/${device.platform === 'macos' ? 'mac' : 'windows'}/123`,
                requiresLocalAdmin: true,
                requiredApprovals: []
            })))
        };
        const lifecycleService = {
            getOrganisation: jest.fn(async () => ({ revision: 7, organisation })),
            claimDattoRmmProvisioning: jest.fn(async () => ({
                revision: 8,
                claim: { claimId: 'datto-provisioning-claim-one' }
            })),
            releaseDattoRmmProvisioning: jest.fn(),
            syncDattoRmmSnapshot: jest.fn(async (_access, _organisationId, payload) => ({
                revision: payload.expectedRevision + 1,
                organisation: Object.assign({}, organisation, {
                    links: { dattoRmmSiteUid: payload.siteUid },
                    integrations: { dattoRmm: { status: 'linked', siteUid: payload.siteUid, mode: payload.mode } }
                })
            })),
            updateOnboardingDevice: jest.fn(async (_access, _organisationId, payload) => {
                organisation.onboarding.devices = organisation.onboarding.devices.map((device) => (
                    device.id === payload.deviceId ? Object.assign({}, device, { status: payload.status }) : device
                ));
                return { revision: payload.expectedRevision + 1, organisation };
            })
        };

        const result = await handleDattoRmmRequest({
            method: 'POST',
            url: '/api/datto-rmm/onboarding/prepare',
            headers: {},
            query: {},
            body: {
                email: 'joel@example.com',
                organisationId: 'organisation-no-fries-hq',
                expectedRevision: 7,
                siteName: 'No Fries HQ',
                confirmCustomerAuthority: true,
                confirmAuthorisedDevices: true,
                confirmNoConflictingManagement: true,
                confirmSupportedOperatingSystems: true,
                confirmNewDeviceApprovalEnabled: true,
                confirm: true
            }
        }, {}, { client, lifecycleService, provisioningClient });

        expect(result).toMatchObject({
            status: 200,
            body: {
                provider: 'datto_rmm',
                mode: 'controlled_write',
                revision: 11,
                site: { siteUid: 'site-hq-uid', siteId: 123, created: true },
                handoffs: [
                    { deviceId: 'dell-laptop', platform: 'windows' },
                    { deviceId: 'older-macbook', platform: 'macos' }
                ]
            }
        });
        expect(provisioningClient.ensureManagedSite).toHaveBeenCalledWith(expect.objectContaining({
            name: 'No Fries Headquarters',
            externalKey: expect.stringMatching(/:organisation-no-fries-hq$/)
        }));
        expect(lifecycleService.syncDattoRmmSnapshot).toHaveBeenCalledWith(
            expect.anything(),
            'organisation-no-fries-hq',
            expect.objectContaining({
                expectedRevision: 8,
                siteUid: 'site-hq-uid',
                mode: 'controlled_write',
                provisioningDisposition: 'created',
                provisioningClaimId: 'datto-provisioning-claim-one',
                provisioningKeyHash: expect.stringMatching(/^[a-f0-9]{64}$/)
            })
        );
        expect(lifecycleService.updateOnboardingDevice).toHaveBeenCalledTimes(2);
        expect(JSON.stringify(result.body)).not.toContain('api-secret');
    });

    test('controlled onboarding is reusable for generic customers and their agreed device plans', () => {
        const inkstone = controlledOnboardingPlan({
            displayName: 'Inkstone Limited',
            lifecycleState: 'onboarding',
            commercialAcceptance: { status: 'verified' },
            onboarding: {
                planId: 'onboarding-plan-inkstone',
                planVersion: 1,
                devices: [
                    { id: 'inkstone-01', label: 'Reception PC', platform: 'windows', owner: 'sponsor@inkstone.example', status: 'planned' },
                    { id: 'inkstone-02', label: 'Studio PC', platform: 'windows', owner: 'sponsor@inkstone.example', status: 'planned' },
                    { id: 'inkstone-03', label: 'Director laptop', platform: 'windows', owner: 'sponsor@inkstone.example', status: 'planned' }
                ]
            }
        }, { siteName: 'Inkstone Limited' });
        const secondCustomer = controlledOnboardingPlan({
            displayName: 'Example Nutrition School',
            lifecycleState: 'onboarding',
            commercialAcceptance: { status: 'verified' },
            onboarding: {
                planId: 'onboarding-plan-nutrition-school',
                planVersion: 1,
                devices: [
                    { id: 'school-01', label: 'Training MacBook', platform: 'macos', owner: 'director@school.example', status: 'planned' }
                ]
            }
        }, { siteName: 'Example Nutrition School' });

        expect(inkstone).toMatchObject({
            siteName: 'Inkstone Limited',
            planId: 'onboarding-plan-inkstone',
            blockers: []
        });
        expect(inkstone.devices).toHaveLength(3);
        expect(secondCustomer).toMatchObject({
            siteName: 'Example Nutrition School',
            planId: 'onboarding-plan-nutrition-school',
            blockers: []
        });
    });

    test('generic mixed-platform onboarding returns safe handoffs and a manual Linux task', async () => {
        setDevelopmentIdentity();
        const organisation = {
            organisationId: 'organisation-inkstone',
            displayName: 'Inkstone Limited',
            lifecycleState: 'onboarding',
            commercialAcceptance: { status: 'verified' },
            links: { dattoRmmSiteUid: '' },
            integrations: { dattoRmm: { status: 'not_connected', siteUid: '' } },
            onboarding: {
                planId: 'onboarding-plan-inkstone',
                planVersion: 1,
                devices: [
                    { id: 'inkstone-win', label: 'Reception PC', platform: 'windows', owner: 'sponsor@inkstone.example', status: 'planned' },
                    { id: 'inkstone-mac', label: 'Director MacBook', platform: 'macos', owner: 'sponsor@inkstone.example', status: 'planned' },
                    { id: 'inkstone-linux', label: 'Studio Linux workstation', platform: 'linux', owner: 'sponsor@inkstone.example', status: 'planned' }
                ]
            }
        };
        const client = {
            status: () => ({ mode: 'controlled_write', writeOperationsEnabled: true }),
            getSiteSnapshot: jest.fn(async () => ({
                site: { siteUid: 'site-inkstone', siteId: 456, name: 'Inkstone Limited' },
                devices: [],
                openAlerts: [],
                truncated: false,
                capturedAt: '2026-08-21T02:00:00.000Z'
            }))
        };
        const provisioningClient = {
            status: () => ({ mode: 'controlled_write', configured: true, writeOperationsEnabled: true, state: 'ready' }),
            ensureManagedSite: jest.fn(async () => ({
                created: true,
                site: { siteUid: 'site-inkstone', siteId: 456, name: 'Inkstone Limited' }
            })),
            buildInstallerHandoffs: jest.fn((_site, devices) => devices.map((device) => ({
                deviceId: device.deviceId,
                label: device.label,
                platform: device.platform,
                downloadUrl: `https://vidal.rmm.datto.com/download-agent/${device.platform === 'macos' ? 'mac' : 'windows'}/456`,
                requiresLocalAdmin: true,
                requiredApprovals: []
            })))
        };
        const lifecycleService = {
            getOrganisation: jest.fn(async () => ({ revision: 20, organisation })),
            claimDattoRmmProvisioning: jest.fn(async () => ({
                revision: 21,
                claim: { claimId: 'datto-provisioning-claim-inkstone' }
            })),
            releaseDattoRmmProvisioning: jest.fn(),
            syncDattoRmmSnapshot: jest.fn(async (_access, _organisationId, payload) => ({
                revision: payload.expectedRevision + 1,
                organisation: Object.assign({}, organisation, {
                    links: { dattoRmmSiteUid: payload.siteUid },
                    integrations: { dattoRmm: { status: 'linked', siteUid: payload.siteUid, mode: payload.mode } }
                })
            })),
            updateOnboardingDevice: jest.fn(async (_access, _organisationId, payload) => {
                organisation.onboarding.devices = organisation.onboarding.devices.map((device) => (
                    device.id === payload.deviceId ? Object.assign({}, device, { status: payload.status }) : device
                ));
                return { revision: payload.expectedRevision + 1, organisation };
            })
        };

        const result = await handleDattoRmmRequest({
            method: 'POST',
            url: '/api/datto-rmm/onboarding/prepare',
            headers: {},
            query: {},
            body: {
                email: 'joel@example.com',
                organisationId: 'organisation-inkstone',
                expectedRevision: 20,
                siteName: 'Inkstone Limited',
                confirmCustomerAuthority: true,
                confirmAuthorisedDevices: true,
                confirmNoConflictingManagement: true,
                confirmSupportedOperatingSystems: true,
                confirmNewDeviceApprovalEnabled: true,
                confirm: true
            }
        }, {}, { client, lifecycleService, provisioningClient });

        expect(result.body.handoffs).toEqual([
            expect.objectContaining({ deviceId: 'inkstone-win', platform: 'windows' }),
            expect.objectContaining({ deviceId: 'inkstone-mac', platform: 'macos' })
        ]);
        expect(result.body.manualTasks).toEqual([
            expect.objectContaining({
                deviceId: 'inkstone-linux',
                platform: 'linux',
                documentationUrl: 'https://rmm.datto.com/help/en/Content/3NEWUI/Devices/AddADevice/InstallLinux.htm'
            })
        ]);
        expect(provisioningClient.buildInstallerHandoffs).toHaveBeenCalledWith(
            expect.objectContaining({ siteUid: 'site-inkstone' }),
            expect.arrayContaining([
                expect.objectContaining({ deviceId: 'inkstone-win' }),
                expect.objectContaining({ deviceId: 'inkstone-mac' })
            ])
        );
        expect(provisioningClient.buildInstallerHandoffs.mock.calls[0][1]).toHaveLength(2);
        expect(lifecycleService.updateOnboardingDevice).toHaveBeenCalledTimes(2);
        expect(organisation.onboarding.devices.find((device) => device.id === 'inkstone-linux').status).toBe('planned');
        expect(JSON.stringify(result.body)).not.toContain('/download-agent/linux/');
    });

    test('controlled onboarding requires customer-level authority and device-scope confirmations', async () => {
        setDevelopmentIdentity();
        const lifecycleService = { getOrganisation: jest.fn() };
        const provisioningClient = { status: jest.fn(), ensureManagedSite: jest.fn() };

        await expect(handleDattoRmmRequest({
            method: 'POST',
            url: '/api/datto-rmm/onboarding/prepare',
            headers: {},
            query: {},
            body: {
                email: 'joel@example.com',
                organisationId: 'organisation-customer-one',
                expectedRevision: 7,
                siteName: 'Customer One',
                confirmOwnedDevices: true,
                confirmNoThirdPartyManagement: true,
                confirmSupportedOperatingSystems: true,
                confirmNewDeviceApprovalEnabled: true,
                confirm: true
            }
        }, {}, {
            client: { status: () => ({ mode: 'controlled_write' }) },
            lifecycleService,
            provisioningClient
        })).rejects.toMatchObject({
            statusCode: 400,
            details: { code: 'datto_rmm_provision_confirmation_required' }
        });
        expect(lifecycleService.getOrganisation).not.toHaveBeenCalled();
        expect(provisioningClient.ensureManagedSite).not.toHaveBeenCalled();
    });

    test('controlled onboarding accepts a variable-size HQ device plan', () => {
        const plan = controlledOnboardingPlan({
            organisationId: 'organisation-no-fries-hq',
            displayName: 'No Fries Headquarters',
            lifecycleState: 'onboarding',
            commercialAcceptance: { status: 'verified' },
            onboarding: {
                planId: 'onboarding-plan-hq',
                planVersion: 1,
                devices: [
                    { id: 'dell-one', label: 'Dell one', platform: 'windows', owner: 'joel@example.com', status: 'planned' },
                    { id: 'dell-two', label: 'Dell two', platform: 'windows', owner: 'joel@example.com', status: 'planned' },
                    { id: 'linux-one', label: 'Linux one', platform: 'linux', owner: 'joel@example.com', status: 'planned' }
                ]
            }
        }, { siteName: 'No Fries Headquarters' });

        expect(plan).toMatchObject({
            siteName: 'No Fries Headquarters',
            planId: 'onboarding-plan-hq',
            planVersion: 1,
            blockers: []
        });
        expect(plan.devices).toHaveLength(3);
    });

    test('controlled onboarding never emits an installer plan while any planned device is blocked', () => {
        const plan = controlledOnboardingPlan({
            displayName: 'No Fries HQ',
            lifecycleState: 'onboarding',
            commercialAcceptance: { status: 'verified' },
            onboarding: {
                planId: 'onboarding-plan-hq',
                planVersion: 1,
                devices: [
                    { id: 'dell-laptop', label: 'Dell laptop', platform: 'windows', owner: 'joel@example.com', status: 'blocked' },
                    { id: 'older-macbook', label: 'Older Apple MacBook', platform: 'macos', owner: 'joel@example.com', status: 'planned' }
                ]
            }
        }, { siteName: 'No Fries HQ' });

        expect(plan.blockers).toContain('Resolve every blocked device before preparing a Datto installer.');
    });

    test('controlled onboarding mode is enforced before a provisioning claim or lifecycle mutation', async () => {
        setDevelopmentIdentity();
        const organisation = {
            organisationId: 'organisation-no-fries-hq',
            displayName: 'No Fries Headquarters',
            lifecycleState: 'onboarding',
            commercialAcceptance: { status: 'verified' },
            onboarding: {
                planId: 'onboarding-plan-hq',
                planVersion: 1,
                devices: [
                    { id: 'dell-laptop', label: 'Dell laptop', platform: 'windows', owner: 'joel@example.com', status: 'planned' },
                    { id: 'older-macbook', label: 'Older Apple MacBook', platform: 'macos', owner: 'joel@example.com', status: 'planned' }
                ]
            }
        };
        const lifecycleService = {
            getOrganisation: jest.fn(async () => ({ revision: 7, organisation })),
            claimDattoRmmProvisioning: jest.fn(),
            syncDattoRmmSnapshot: jest.fn()
        };
        const provisioningClient = {
            status: jest.fn(() => ({
                mode: 'readonly',
                configured: true,
                writeOperationsEnabled: false,
                state: 'ready'
            })),
            ensureManagedSite: jest.fn()
        };

        await expect(handleDattoRmmRequest({
            method: 'POST',
            url: '/api/datto-rmm/onboarding/prepare',
            headers: {},
            query: {},
            body: {
                email: 'joel@example.com',
                organisationId: 'organisation-no-fries-hq',
                expectedRevision: 7,
                siteName: 'No Fries Headquarters',
                confirmCustomerAuthority: true,
                confirmAuthorisedDevices: true,
                confirmNoConflictingManagement: true,
                confirmSupportedOperatingSystems: true,
                confirmNewDeviceApprovalEnabled: true,
                confirm: true
            }
        }, {}, { client: { status: () => ({ mode: 'readonly' }) }, lifecycleService, provisioningClient })).rejects.toMatchObject({
            statusCode: 503,
            details: { code: 'datto_rmm_provisioning_disabled' }
        });
        expect(lifecycleService.claimDattoRmmProvisioning).not.toHaveBeenCalled();
        expect(lifecycleService.syncDattoRmmSnapshot).not.toHaveBeenCalled();
        expect(provisioningClient.ensureManagedSite).not.toHaveBeenCalled();
    });

    test('controlled onboarding refuses a previously mapped site whose provider name no longer matches', async () => {
        setDevelopmentIdentity();
        const organisation = {
            organisationId: 'organisation-no-fries-hq',
            displayName: 'No Fries Headquarters',
            lifecycleState: 'onboarding',
            commercialAcceptance: { status: 'verified' },
            links: { dattoRmmSiteUid: 'site-wrong-customer' },
            onboarding: {
                planId: 'onboarding-plan-hq',
                planVersion: 1,
                devices: [
                    { id: 'dell-laptop', label: 'Dell laptop', platform: 'windows', owner: 'joel@example.com', status: 'planned' },
                    { id: 'older-macbook', label: 'Older Apple MacBook', platform: 'macos', owner: 'joel@example.com', status: 'planned' }
                ]
            }
        };
        const client = {
            status: () => ({ mode: 'controlled_write' }),
            getSiteSnapshot: jest.fn(async () => ({
                site: { siteUid: 'site-wrong-customer', siteId: 999, name: 'Another Customer' },
                devices: [],
                openAlerts: [],
                truncated: false,
                capturedAt: '2026-08-21T02:00:00.000Z'
            }))
        };
        const lifecycleService = {
            getOrganisation: jest.fn(async () => ({ revision: 7, organisation })),
            claimDattoRmmProvisioning: jest.fn(async () => ({
                revision: 8,
                claim: { claimId: 'datto-provisioning-claim-mapped' }
            })),
            releaseDattoRmmProvisioning: jest.fn(),
            syncDattoRmmSnapshot: jest.fn()
        };
        const provisioningClient = {
            status: jest.fn(() => ({
                mode: 'controlled_write',
                configured: true,
                writeOperationsEnabled: true,
                state: 'ready'
            })),
            ensureManagedSite: jest.fn(),
            verifyManagedSite: jest.fn(async () => ({
                siteUid: 'site-wrong-customer',
                siteId: 999,
                name: 'No Fries Headquarters',
                notes: '[nofries:test]'
            })),
            buildInstallerHandoffs: jest.fn()
        };

        await expect(handleDattoRmmRequest({
            method: 'POST',
            url: '/api/datto-rmm/onboarding/prepare',
            headers: {},
            query: {},
            body: {
                email: 'joel@example.com',
                organisationId: 'organisation-no-fries-hq',
                expectedRevision: 7,
                siteName: 'No Fries Headquarters',
                confirmCustomerAuthority: true,
                confirmAuthorisedDevices: true,
                confirmNoConflictingManagement: true,
                confirmSupportedOperatingSystems: true,
                confirmNewDeviceApprovalEnabled: true,
                confirm: true
            }
        }, {}, { client, lifecycleService, provisioningClient })).rejects.toMatchObject({
            statusCode: 409,
            details: {
                code: 'datto_rmm_site_name_mismatch',
                expectedSiteName: 'No Fries Headquarters',
                providerSiteName: 'Another Customer'
            }
        });
        expect(provisioningClient.ensureManagedSite).not.toHaveBeenCalled();
        expect(lifecycleService.syncDattoRmmSnapshot).not.toHaveBeenCalled();
    });
});

async function acceptProposal(service, access, current, proposalId) {
    return service.recordCommercialAcceptance(access, current.organisation.organisationId, {
        expectedRevision: current.revision,
        idempotencyKey: `accept:${proposalId}:v1`,
        proposalId,
        proposalVersion: 'v1',
        proposalSha256: 'a'.repeat(64),
        acceptedAt: '2026-08-17T04:00:00.000Z',
        effectiveDate: '2026-08-17T04:00:00.000Z',
        signatoryName: 'Customer Sponsor',
        signatoryEmail: 'sponsor@example.com',
        signatoryTitle: 'Director',
        authorityBasis: 'Director authority confirmed',
        authorityEvidenceId: `contract-register:${proposalId}`,
        authorityEvidenceSha256: 'b'.repeat(64),
        confirmCustomerAuthority: true
    });
}

function configuredClient(fetch) {
    return createDattoRmmClient({
        fetch,
        now: () => new Date('2026-08-17T03:00:00.000Z'),
        env: {
            NOFRIES_DATTO_RMM_MODE: 'readonly',
            NOFRIES_DATTO_RMM_API_URL: 'https://vidal-api.centrastage.net',
            NOFRIES_DATTO_RMM_ACCESS_TOKEN: 'server-only-token'
        }
    });
}

function response(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' }
    });
}

function operatorAccess(tenantId) {
    return {
        allowed: true,
        reason: 'test',
        user: {
            email: 'joel@example.com',
            name: 'Joel',
            role: 'admin',
            capabilities: ROLE_CAPABILITIES.admin.slice()
        },
        tenant: {
            id: tenantId,
            key: tenantStorageKey(tenantId),
            name: `Tenant ${tenantId}`,
            slug: tenantId
        },
        authentication: { required: false, authenticated: true, provider: 'test' }
    };
}

function setDevelopmentIdentity() {
    process.env.NOFRIES_REQUIRE_AUTH = 'false';
    process.env.NOFRIES_DEV_EMAIL = 'joel@example.com';
    process.env.NOFRIES_DEFAULT_TENANT_ID = 'tenant-a';
    process.env.NOFRIES_DATTO_RMM_TENANT_ID = 'tenant-a';
    process.env.NOFRIES_ADMIN_EMAILS = 'joel@example.com';
}

function request(method, url) {
    return {
        method,
        url,
        headers: {},
        query: { email: 'joel@example.com' },
        body: {}
    };
}
