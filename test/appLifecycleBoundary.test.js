const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
    BASE_PROOF_SOURCES,
    proofPeriodBounds
} = require('../api/shared/appLifecycle/customerOperations');
const {
    createLifecycleRepository: createAppLifecycleRepository,
    normaliseState: normaliseAppState
} = require('../api/shared/appLifecycle/lifecycleRepository');
const { createLifecycleService: createAppLifecycleService } = require('../api/shared/appLifecycle/lifecycleService');
const { PostgresLifecycleRepository: AppPostgresLifecycleRepository } = require('../api/shared/appLifecycle/postgresLifecycleRepository');
const { createLifecycleRepository: createConnectorLifecycleRepository } = require('../api/shared/lifecycle/lifecycleRepository');
const baseTenantAccess = require('../api/shared/tenantAccess');
const appTenantAccess = require('../api/shared/appTenantAccess');
const {
    classifyConnectorImpact,
    CONNECTOR_TRANSITIVE_PATHS
} = require('../scripts/release/validate-connector-impact');

const ROOT = path.resolve(__dirname, '..');
const PROOF_AT = '2026-08-31T12:05:00.000Z';
const CONNECTOR_BLOBS = Object.freeze({
    'api/shared/lifecycle/customerOperations.js': '946ddbe7c78824924707810a3ad0830d0ea98d25',
    'api/shared/lifecycle/lifecycleRepository.js': '042b8ed3756e5f0fed2a0d798e3023989b0f4630',
    'api/shared/lifecycle/lifecycleService.js': 'f075befa2ffb7cdf981051c9d13be4833bb55d3a',
    'api/shared/lifecycle/lifecycleState.js': '90088ef37f4851d907aed38b4cc9c7b7bc7433c8',
    'api/shared/lifecycleRuntime.js': '1f5df47f79bf792b873f97cefee6354ed9005679',
    // REL-001's independently reviewed immutable application-subject boundary.
    'api/shared/tenantAccess.js': '8396cc9f4a2ba23b77d2e881cdfee1d7106082d1'
});
const APP_RUNTIME_OWNERS = Object.freeze([
    'api/lifecycleApp/index.js',
    'api/lifecycleBootstrap/index.js',
    'api/lifecycleControls/index.js',
    'api/lifecycleOrganisations/index.js',
    'api/lifecycleRetention/index.js',
    'api/mcp/index.js',
    'api/shared/customerPortalRuntime.js',
    'api/shared/dattoRmmRuntime.js',
    'api/shared/monthlyProofScheduler.js',
    'api/shared/prospectRuntime.js',
    'api/shared/salesRuntime.js',
    'api/shared/serviceDeskRuntime.js',
    'server.js'
]);

describe('App lifecycle and connector ownership boundary', () => {
    test('pins five retained lifecycle blobs and the reviewed connector access candidate', () => {
        for (const [relativePath, expected] of Object.entries(CONNECTOR_BLOBS)) {
            expect(gitBlobSha(fs.readFileSync(path.join(ROOT, relativePath)))).toBe(expected);
        }
    });

    test('has one exact runtime owner map and keeps the relocated paths connector-safe', () => {
        const sourceFiles = [
            path.join(ROOT, 'server.js'),
            ...walkJavaScript(path.join(ROOT, 'api'))
        ];
        const owners = { app: [], connector: [] };
        for (const absolutePath of sourceFiles) {
            const relativePath = path.relative(ROOT, absolutePath).split(path.sep).join('/');
            const source = fs.readFileSync(absolutePath, 'utf8');
            for (const request of requireRequests(source)) {
                if (path.posix.basename(request) === 'appLifecycleRuntime') owners.app.push(relativePath);
                if (path.posix.basename(request) === 'lifecycleRuntime') owners.connector.push(relativePath);
            }
        }
        expect([...new Set(owners.app)].sort()).toEqual([...APP_RUNTIME_OWNERS].sort());
        expect([...new Set(owners.connector)].sort()).toEqual(['api/shared/mcpRuntime.js']);

        const relocated = [
            'api/shared/appLifecycle/customerOperations.js',
            'api/shared/appLifecycle/lifecycleModel.js',
            'api/shared/appLifecycle/lifecycleRepository.js',
            'api/shared/appLifecycle/lifecycleService.js',
            'api/shared/appLifecycle/lifecycleState.js',
            'api/shared/appLifecycle/monthlyProof.js',
            'api/shared/appLifecycle/postgresLifecycleRepository.js',
            'api/shared/appLifecycleRuntime.js',
            'api/shared/appTenantAccess.js'
        ];
        expect(relocated.every((item) => !CONNECTOR_TRANSITIVE_PATHS.has(item))).toBe(true);
        expect(classifyConnectorImpact(relocated)).toEqual({ safe: true, impacts: [] });

        expect(read('api/shared/monthlyProofScheduler.js')).toContain("require('./appLifecycleRuntime')");
        expect(read('api/shared/monthlyProofScheduler.js')).not.toContain("require('./appLifecycle/lifecycleRepository')");
        expect(read('api/shared/monthlyProofScheduler.js')).not.toContain("require('./appLifecycle/lifecycleService')");
        expect(read('api/shared/customerPortalService.js')).toContain("require('./appLifecycle/monthlyProof')");
        expect(read('api/shared/appLifecycle/postgresLifecycleRepository.js')).toContain("require('./lifecycleState')");

        const prospectHarness = read('evals/prospect-harness.js');
        expect(prospectHarness).toContain("require('../api/shared/appLifecycle/lifecycleRepository')");
        expect(prospectHarness).toContain("require('../api/shared/appLifecycle/lifecycleService')");
        expect(prospectHarness).not.toContain("require('../api/shared/lifecycle/lifecycleRepository')");
        expect(prospectHarness).not.toContain("require('../api/shared/lifecycle/lifecycleService')");
        expect(prospectHarness).not.toContain("'api/shared/lifecycle/lifecycleModel.js'");
        for (const contractPath of [
            'api/shared/appLifecycle/customerOperations.js',
            'api/shared/appLifecycle/lifecycleModel.js',
            'api/shared/appLifecycle/lifecycleRepository.js',
            'api/shared/appLifecycle/lifecycleService.js',
            'api/shared/appLifecycle/lifecycleState.js',
            'api/shared/appLifecycle/monthlyProof.js',
            'api/shared/appLifecycle/postgresLifecycleRepository.js',
            'api/shared/appLifecycleRuntime.js',
            'api/shared/appTenantAccess.js'
        ]) expect(prospectHarness).toContain(`'${contractPath}'`);

        expect(read('server.js')).toContain('handleMcpRequest(req, { lifecycle: getAppLifecycleService() })');
        expect(read('api/mcp/index.js')).toContain('runMcpFunction(context, req, { lifecycle: getLifecycleService() })');
        expect(read('connector-server.js')).toContain('handleMcpRequest(req)');
        expect(read('connector-server.js')).not.toContain('appLifecycleRuntime');
        expect(read('connector-functions/mcp/index.js')).toContain('runMcpFunction(context, req)');
        expect(read('connector-functions/mcp/index.js')).not.toContain('appLifecycleRuntime');
    });

    test('packages the App stack while the shared MCP default loads only the frozen connector stack', () => {
        execFileSync(process.execPath, ['scripts/build-app-service.js'], { cwd: ROOT, stdio: 'pipe' });
        for (const relativePath of [
            'api/shared/appLifecycleRuntime.js',
            'api/shared/appTenantAccess.js',
            'api/shared/appLifecycle/lifecycleService.js',
            'api/shared/appLifecycle/postgresLifecycleRepository.js'
        ]) {
            expect(fs.existsSync(path.join(ROOT, 'app-service-dist', relativePath))).toBe(true);
        }

        const probe = `
            const path = require('path');
            const root = ${JSON.stringify(ROOT)};
            require(path.join(root, 'api/shared/mcpRuntime.js'));
            const loaded = Object.keys(require.cache).map((item) => item.split(path.sep).join('/'));
            process.stdout.write(JSON.stringify({
                app: loaded.filter((item) => item.includes('/api/shared/appLifecycle/') || item.endsWith('/api/shared/appLifecycleRuntime.js') || item.endsWith('/api/shared/appTenantAccess.js')),
                base: loaded.filter((item) => item.endsWith('/api/shared/lifecycleRuntime.js') || item.endsWith('/api/shared/lifecycle/lifecycleService.js') || item.endsWith('/api/shared/tenantAccess.js'))
            }));
        `;
        const loaded = JSON.parse(execFileSync(process.execPath, ['-e', probe], {
            cwd: ROOT,
            encoding: 'utf8'
        }));
        expect(loaded.app).toEqual([]);
        expect(loaded.base).toHaveLength(3);
    });

    test('shares one App singleton without exposing it through the connector MCP default', () => {
        const runtime = require('../api/shared/appLifecycleRuntime');
        runtime.resetLifecycleRuntimeForTests();
        try {
            expect(runtime.getLifecycleRepository()).toBe(runtime.getLifecycleRepository());
            expect(runtime.getLifecycleService()).toBe(runtime.getLifecycleService());
        } finally {
            runtime.resetLifecycleRuntimeForTests();
        }
        expect(read('api/shared/mcpRuntime.js')).toContain("require('./lifecycleRuntime')");
        expect(read('api/shared/mcpRuntime.js')).not.toContain('appLifecycleRuntime');
    });

    test('adds Proof issue authority only in the App role projection', () => {
        expect(baseTenantAccess.ROLE_CAPABILITIES.admin).not.toContain('proof:issue');
        expect(baseTenantAccess.ROLE_CAPABILITIES.service_owner).not.toContain('proof:issue');
        expect(appTenantAccess.ROLE_CAPABILITIES.admin).toContain('proof:issue');
        expect(appTenantAccess.ROLE_CAPABILITIES.service_owner).toContain('proof:issue');
        expect(appTenantAccess.ROLE_CAPABILITIES.consultant).not.toContain('proof:issue');

        const serviceOwner = {
            allowed: true,
            user: { capabilities: ['proof:approve'] },
            tenant: { key: 'tenant-proof' }
        };
        expect(() => appTenantAccess.assertCapability(serviceOwner, 'proof:issue')).not.toThrow();
        expect(() => appTenantAccess.assertCapability({
            allowed: true,
            user: { capabilities: ['proof:write'] },
            tenant: { key: 'tenant-proof' }
        }, 'proof:issue')).toThrow(expect.objectContaining({
            details: { code: 'capability_required', capability: 'proof:issue' }
        }));
        expect(read('api/shared/appLifecycleRuntime.js')).toContain("assertCapability(access, 'proof:issue')");
    });

    test('preserves issued Proof and reporting period across connector read and later App prospect mutation', async () => {
        const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-app-lifecycle-boundary-'));
        const primary = access('tenant-primary', 'checker@example.test', 'checker-subject');
        const issuer = access('tenant-primary', 'issuer@example.test', 'issuer-subject');
        const other = access('tenant-other', 'other@example.test', 'other-subject');
        try {
            const appRepository = createAppLifecycleRepository({ provider: 'local', dataDir });
            const connectorRepository = createConnectorLifecycleRepository({ provider: 'local', dataDir });
            const appService = createAppLifecycleService({
                repository: appRepository,
                now: () => new Date(PROOF_AT)
            });
            const organisation = organisationFixture();
            await appRepository.mutate(primary, { expectedRevision: 0, auditEvents: [] }, async (state) => {
                state.organisations.push(organisation);
                state.schedules.push(monthlySchedule(organisation.id));
            });

            const approved = await appService.approveCustomerProof(primary, organisation.id, {
                expectedRevision: 1,
                period: '2026-08',
                confirmComplete: true
            });
            const issued = await appService.issueCustomerProof(issuer, organisation.id, {
                expectedRevision: approved.revision,
                period: '2026-08',
                confirmIssue: true
            });
            const receipt = {
                snapshotSha256: issued.proof.snapshotSha256,
                publicationSha256: issued.proof.publicationSha256,
                publicationEnvelope: structuredClone(issued.proof.publicationEnvelope),
                issuedBy: structuredClone(issued.proof.issuedBy),
                issuedAt: issued.proof.issuedAt
            };

            const storedPath = appRepository.filePath(primary);
            const bytesBeforeConnectorRead = fs.readFileSync(storedPath);
            const connectorView = await connectorRepository.read(primary);
            expect(connectorView.organisations[0].proofPeriods[0].customerSnapshot).toBeUndefined();
            expect(fs.readFileSync(storedPath)).toEqual(bytesBeforeConnectorRead);

            await appService.ensureProspectSession(primary, 'a'.repeat(64), { channel: 'text' });
            const afterProspect = await appRepository.read(primary);
            const controls = await appService.runCustomerControls(primary, {
                expectedRevision: afterProspect.revision,
                scheduledFor: PROOF_AT,
                confirmInternalOnly: true
            });
            expect(controls.generated).toEqual(expect.arrayContaining([
                expect.objectContaining({ jobType: 'monthly_proof', reportingPeriod: '2026-08' })
            ]));

            const finalState = await appRepository.read(primary);
            const finalProof = finalState.organisations
                .find((item) => item.id === organisation.id)
                .proofPeriods.find((item) => item.period === '2026-08');
            expect(finalProof).toMatchObject(receipt);
            expect(finalState.controlRuns).toEqual(expect.arrayContaining([
                expect.objectContaining({ reportingPeriod: '2026-08' })
            ]));
            expect((await appRepository.read(other)).organisations).toEqual([]);
            expect((await connectorRepository.read(other)).organisations).toEqual([]);

            const roundTrip = normaliseAppState(structuredClone(finalState), primary);
            expect(roundTrip.organisations.find((item) => item.id === organisation.id).proofPeriods[0])
                .toMatchObject(receipt);
            expect(roundTrip.controlRuns).toEqual(expect.arrayContaining([
                expect.objectContaining({ reportingPeriod: '2026-08' })
            ]));

            const postgresQuery = jest.fn(async (sql) => {
                if (/FROM nofries\.module_revisions/.test(sql)) {
                    return {
                        rows: [{ schema_version: finalState.schemaVersion, revision: finalState.revision }],
                        rowCount: 1
                    };
                }
                if (/FROM nofries\.tenants/.test(sql)) {
                    return {
                        rows: [{
                            logical_id: primary.tenant.id,
                            tenant_key: primary.tenant.key,
                            name: primary.tenant.name,
                            slug: primary.tenant.slug,
                            created_at: PROOF_AT,
                            updated_at: PROOF_AT
                        }],
                        rowCount: 1
                    };
                }
                if (/FROM nofries\.lifecycle_organisations/.test(sql)) {
                    return {
                        rows: finalState.organisations.map((item) => ({
                            organisation_id: item.id,
                            payload: structuredClone(item)
                        })),
                        rowCount: finalState.organisations.length
                    };
                }
                if (/FROM nofries\.lifecycle_control_runs/.test(sql)) {
                    return {
                        rows: finalState.controlRuns.map((item) => ({
                            run_id: item.id,
                            organisation_id: item.organisationId,
                            schedule_id: item.scheduleId,
                            payload: structuredClone(item)
                        })),
                        rowCount: finalState.controlRuns.length
                    };
                }
                if (/^\s*SELECT /.test(sql)) return { rows: [], rowCount: 0 };
                throw new Error('App PostgreSQL normalisation regression issued an unexpected write');
            });
            const postgresRepository = new AppPostgresLifecycleRepository({
                database: {
                    withTenantTransaction: jest.fn(async (tenantKey, work) => {
                        expect(tenantKey).toBe(primary.tenant.key);
                        return work({ query: postgresQuery });
                    })
                }
            });
            const postgresRoundTrip = await postgresRepository.read(primary);
            expect(postgresRoundTrip.organisations.find((item) => item.id === organisation.id).proofPeriods[0])
                .toMatchObject(receipt);
            expect(postgresRoundTrip.controlRuns).toEqual(expect.arrayContaining([
                expect.objectContaining({ reportingPeriod: '2026-08' })
            ]));
        } finally {
            fs.rmSync(dataDir, { recursive: true, force: true });
        }
    });
});

function read(relativePath) {
    return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function gitBlobSha(buffer) {
    return crypto.createHash('sha1')
        .update(Buffer.from(`blob ${buffer.length}\0`, 'utf8'))
        .update(buffer)
        .digest('hex');
}

function walkJavaScript(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const absolutePath = path.join(directory, entry.name);
        if (entry.isDirectory()) return walkJavaScript(absolutePath);
        return entry.isFile() && entry.name.endsWith('.js') ? [absolutePath] : [];
    });
}

function requireRequests(source) {
    const values = [];
    const pattern = /require\(['"]([^'"]+)['"]\)/g;
    let match;
    while ((match = pattern.exec(source))) values.push(match[1]);
    return values;
}

function access(tenantKey, email, principalId) {
    return {
        allowed: true,
        user: {
            email,
            name: email,
            role: 'admin',
            principalId,
            identityTenantId: 'tenant-identity',
            subjectKey: `tenant-identity:${principalId}`,
            capabilities: ['proof:write', 'proof:approve', 'proof:issue']
        },
        tenant: { id: tenantKey, key: tenantKey, name: tenantKey, slug: tenantKey }
    };
}

function organisationFixture() {
    return {
        id: 'organisation-proof-one',
        recordType: 'customer',
        displayName: 'Proof Customer',
        lifecycleState: 'active',
        serviceStatus: { state: 'active' },
        supportProfile: { timezone: 'Pacific/Auckland' },
        customerMaster: {
            customerId: 'customer-proof-one',
            revision: 1,
            entitlements: [],
            serviceSchedule: { timezone: 'Pacific/Auckland' }
        },
        customerMasterHistory: [],
        proofRequirementLedger: [{
            period: '2026-08',
            timezone: 'Pacific/Auckland',
            entitlementCodes: [],
            requiredSources: BASE_PROOF_SOURCES,
            historyComplete: true,
            throughMasterRevision: 1,
            updatedAt: PROOF_AT
        }],
        proofPeriods: [readyProof('2026-08')]
    };
}

function readyProof(period) {
    const bounds = proofPeriodBounds(period, 'Pacific/Auckland');
    return {
        id: `proof-customer-${period}`,
        customerId: 'customer-proof-one',
        period,
        timezone: 'Pacific/Auckland',
        status: 'ready',
        requiredSources: BASE_PROOF_SOURCES,
        evidenceRefs: BASE_PROOF_SOURCES.map((source) => ({
            id: `evidence-${source}-${period}`,
            source,
            category: `${source}_monthly_evidence`,
            sourceMode: 'manual',
            providerRecordId: `${source}-${period}`,
            evidenceRef: `evidence-register:${source}:${period}`,
            checksum: crypto.createHash('sha256').update(`${source}:${period}`).digest('hex'),
            periodStart: bounds.periodStart,
            periodEnd: bounds.periodEnd,
            capturedAt: PROOF_AT,
            ingestedAt: PROOF_AT,
            freshUntil: '2026-10-01T00:00:00.000Z',
            recordedBy: 'maker@example.test',
            facts: proofFacts(source)
        })),
        evidenceRefsOverflow: false,
        preparedBy: {
            principalId: 'maker-subject',
            identityTenantId: 'tenant-identity',
            subjectKey: 'tenant-identity:maker-subject',
            email: 'maker@example.test',
            role: 'admin'
        },
        preparedAt: PROOF_AT,
        createdAt: PROOF_AT,
        updatedAt: PROOF_AT
    };
}

function proofFacts(source) {
    const bySource = {
        service_desk: ['tickets.resolved', '12'],
        datto_rmm: ['devices.monitored', '5'],
        mdr: ['alerts.reviewed', '0'],
        backup: ['backups.successful', '5'],
        change: ['changes.completed', '2'],
        risk: ['risks.open', '1'],
        billing: ['managed_devices', '5'],
        roadmap: ['recommendations.open', '3']
    };
    const [key, value] = bySource[source];
    return [{ key, label: 'Stored label', value, unit: '', status: 'informational' }];
}

function monthlySchedule(organisationId) {
    return {
        id: 'monthly-proof-schedule',
        organisationId,
        jobType: 'monthly_proof',
        cadence: 'monthly',
        timezone: 'Pacific/Auckland',
        nextDueAt: new Date(proofPeriodBounds('2026-08', 'Pacific/Auckland').endExclusiveMs).toISOString(),
        enabled: true,
        templateVersion: '1',
        deliveryMode: 'internal',
        requiredSources: BASE_PROOF_SOURCES,
        createdAt: PROOF_AT,
        updatedAt: PROOF_AT,
        revision: 1
    };
}
