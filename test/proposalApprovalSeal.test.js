const fs = require('fs');
const os = require('os');
const path = require('path');

const runtimeDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-proposal-seal-runtime-'));
const previousEnvironment = {
    NOFRIES_DATA_DIR: process.env.NOFRIES_DATA_DIR,
    NOFRIES_REQUIRE_AUTH: process.env.NOFRIES_REQUIRE_AUTH,
    NOFRIES_DEV_EMAIL: process.env.NOFRIES_DEV_EMAIL,
    NOFRIES_ADMIN_EMAILS: process.env.NOFRIES_ADMIN_EMAILS,
    NOFRIES_STORAGE_PROVIDER: process.env.NOFRIES_STORAGE_PROVIDER
};
process.env.NOFRIES_DATA_DIR = runtimeDataDir;
process.env.NOFRIES_REQUIRE_AUTH = 'false';
process.env.NOFRIES_DEV_EMAIL = 'seal-admin@example.com';
process.env.NOFRIES_ADMIN_EMAILS = 'seal-admin@example.com';
process.env.NOFRIES_STORAGE_PROVIDER = 'local';

const {
    LEGACY_PROPOSAL_APPROVAL_SNAPSHOT_SCHEMA,
    createProposalApprovalSeal,
    hashProposalApprovalSnapshot,
    materialiseProposalApprovalSnapshot,
    verifyProposalApprovalSeal
} = require('../api/shared/proposalApprovalSeal');
const { assessProposalCommercialPolicy } = require('../api/shared/proposalQuality');
const {
    SALES_SCHEMA_VERSION,
    createEmptyState,
    createSalesWorkspaceRepository
} = require('../api/shared/salesWorkspaceRepository');
const { resolveTenantAccess } = require('../api/shared/tenantAccess');
const {
    handleSalesRequest,
    resetSalesRuntimeForTests
} = require('../api/shared/salesRuntime');

const access = resolveTenantAccess({ email: 'seal-admin@example.com' }, process.env);

describe('proposal approval seals', () => {
    afterAll(() => {
        resetSalesRuntimeForTests();
        fs.rmSync(runtimeDataDir, { recursive: true, force: true });
        Object.entries(previousEnvironment).forEach(([key, value]) => {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        });
    });

    beforeEach(() => {
        resetSalesRuntimeForTests();
        fs.rmSync(runtimeDataDir, { recursive: true, force: true });
        fs.mkdirSync(runtimeDataDir, { recursive: true });
    });

    test('canonical customer-facing snapshots are deterministic and tamper-evident', () => {
        const customer = { name: 'Seal Test Limited', id: 'customer_seal' };
        const tenant = { name: 'No Fries Test', id: 'tenant_seal' };
        const first = proposalFixture();
        const second = Object.assign({}, proposalFixture(), {
            commercial: {
                confirmed: true,
                plannedStart: '2026-09-01',
                termMonths: 12,
                onboardingFeeExGst: 750,
                locationCount: 1,
                managedEndpointCount: 2,
                userCount: 2,
                monthlyTotalExGst: 238
            },
            pricing: Object.assign({}, proposalFixture().pricing)
        });
        const firstSeal = createProposalApprovalSeal({ proposal: first, customer, tenant });
        const secondSeal = createProposalApprovalSeal({ proposal: second, customer, tenant });

        expect(assessProposalCommercialPolicy(first)).toMatchObject({
            status: 'current',
            approvalAllowed: true
        });
        expect(firstSeal).toMatchObject({
            schemaVersion: 2,
            snapshot: {
                schema: 'nofries.proposal.approved.v2',
                document: {
                    commercialPolicy: first.commercialPolicy
                }
            }
        });
        expect(firstSeal.sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(secondSeal.sha256).toBe(firstSeal.sha256);
        expect(hashProposalApprovalSnapshot(secondSeal.snapshot)).toBe(firstSeal.sha256);

        first.approvalSeal = firstSeal;
        expect(verifyProposalApprovalSeal(first, {
            proposalId: first.id,
            customerId: first.customerId,
            assessmentId: first.assessmentId,
            version: 'v2',
            sha256: firstSeal.sha256
        })).toMatchObject({ verified: true });
        expect(materialiseProposalApprovalSnapshot(firstSeal)).toMatchObject({
            proposal: { id: first.id, title: first.title, versionNumber: 2 },
            customer,
            tenant
        });

        const snapshotTamper = JSON.parse(JSON.stringify(first));
        snapshotTamper.approvalSeal.snapshot.document.title = 'Altered approved title';
        expect(verifyProposalApprovalSeal(snapshotTamper)).toMatchObject({
            verified: false,
            code: 'approval_seal_hash_mismatch'
        });

        const liveTamper = JSON.parse(JSON.stringify(first));
        liveTamper.title = 'Altered live title';
        expect(verifyProposalApprovalSeal(liveTamper)).toMatchObject({
            verified: false,
            code: 'approved_proposal_content_changed'
        });

        const policyTamper = JSON.parse(JSON.stringify(first));
        policyTamper.commercialPolicy.policyVersion = 'tampered-policy';
        expect(verifyProposalApprovalSeal(policyTamper)).toMatchObject({
            verified: false,
            code: 'approved_proposal_content_changed'
        });
    });

    test('schema v3 versions proposals per assessment and never manufactures a legacy approval seal', async () => {
        const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-proposal-migration-'));
        const repository = createSalesWorkspaceRepository({ dataDir, provider: 'local' });
        const state = createEmptyState(access);
        state.schemaVersion = 2;
        const approved = proposalFixture({ id: 'proposal_legacy', status: 'approved', versionNumber: undefined });
        delete approved.approvalSeal;
        const draft = proposalFixture({ id: 'proposal_draft', status: 'draft', versionNumber: undefined });
        state.proposals = [approved, draft];
        fs.mkdirSync(path.dirname(repository.filePath(access)), { recursive: true });
        fs.writeFileSync(repository.filePath(access), JSON.stringify(state), 'utf8');

        const migrated = await repository.read(access);
        expect(migrated.schemaVersion).toBe(SALES_SCHEMA_VERSION);
        expect(migrated.proposals.map((proposal) => proposal.versionNumber)).toEqual([1, 2]);
        expect(migrated.proposals[0].approvalSeal).toMatchObject({
            schemaVersion: 2,
            status: 'legacy_unsealed',
            version: 'v1',
            sha256: '',
            snapshot: null
        });
        expect(verifyProposalApprovalSeal(migrated.proposals[0])).toMatchObject({
            verified: false,
            code: 'approved_proposal_unsealed'
        });
        expect(migrated.proposals[1].approvalSeal).toBeUndefined();
        fs.rmSync(dataDir, { recursive: true, force: true });
    });

    test('legacy draft policy data stays unchanged through GET and save while approval requires migration', async () => {
        const repository = createSalesWorkspaceRepository({ dataDir: runtimeDataDir, provider: 'local' });
        const customer = { id: 'customer_seal', name: 'Seal Test Limited' };
        const legacy = proposalFixture({
            id: 'proposal_legacy_policy',
            versionNumber: 1,
            status: 'draft',
            pricing: legacyPricing(),
            approvedBy: '',
            approvedAt: ''
        });
        delete legacy.commercialPolicy;
        delete legacy.approvalSeal;
        await repository.mutate(access, {}, (state) => {
            state.customers.push(customer);
            state.assessments.push({
                id: legacy.assessmentId,
                customerId: customer.id,
                answers: {},
                recommendations: []
            });
            state.proposals.push(legacy);
        });
        resetSalesRuntimeForTests();

        const detail = await handleSalesRequest(request('GET', `/api/sales/proposals/${legacy.id}`));
        expect(detail.status).toBe(200);
        expect(detail.body.proposal.pricing).toEqual(legacyPricing());
        expect(detail.body.proposal.pricing).not.toHaveProperty('policyId');
        expect(detail.body.proposal.commercialPolicy).toBeUndefined();
        expect(detail.body.proposal.commercialPolicyStatus).toMatchObject({
            status: 'migration_required',
            approvalAllowed: false,
            code: 'commercial_policy_migration_required'
        });
        expect(detail.body.proposal.approvalChecks.warnings).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'commercial_policy_migration_required', blocking: true })
        ]));

        const saved = await handleSalesRequest(request(
            'PUT',
            `/api/sales/proposals/${legacy.id}`,
            proposalUpdateBody(detail.body.proposal, detail.body.revision, 'draft', {
                executiveSummary: 'The legacy draft remains editable without changing its recorded pricing.'
            })
        ));
        expect(saved.status).toBe(200);
        expect(saved.body.proposal.executiveSummary).toContain('remains editable');
        expect(saved.body.proposal.pricing).toEqual(legacyPricing());
        expect(saved.body.proposal.commercialPolicy).toBeUndefined();
        expect(saved.body.proposal.commercialPolicyStatus.status).toBe('migration_required');

        await expect(handleSalesRequest(request(
            'PUT',
            `/api/sales/proposals/${legacy.id}`,
            proposalUpdateBody(saved.body.proposal, saved.body.revision, 'approved')
        ))).rejects.toMatchObject({
            statusCode: 422,
            details: {
                code: 'commercial_policy_migration_required',
                policyStatus: { status: 'migration_required', approvalAllowed: false }
            }
        });

        const persisted = await repository.read(access);
        expect(persisted.proposals[0]).toMatchObject({
            status: 'draft',
            pricing: legacyPricing()
        });
        expect(persisted.proposals[0].commercialPolicy).toBeUndefined();
    });

    test('sealed v1 proposals remain verifiable and export only their recorded legacy pricing', async () => {
        const repository = createSalesWorkspaceRepository({ dataDir: runtimeDataDir, provider: 'local' });
        const customer = { id: 'customer_seal', name: 'Seal Test Limited' };
        const proposal = proposalFixture({
            id: 'proposal_sealed_v1',
            pricing: legacyPricing(),
            commercial: {
                userCount: null,
                managedEndpointCount: null,
                locationCount: null,
                onboardingFeeExGst: 600,
                termMonths: 12,
                plannedStart: '2026-09-01',
                confirmed: true,
                monthlyTotalExGst: null
            }
        });
        delete proposal.commercialPolicy;
        proposal.approvalSeal = legacyV1Seal(proposal, customer, { id: 'tenant_seal', name: 'No Fries Test' });

        expect(verifyProposalApprovalSeal(proposal)).toMatchObject({ verified: true });
        expect(materialiseProposalApprovalSnapshot(proposal.approvalSeal).proposal).not.toHaveProperty('commercialPolicy');
        await repository.mutate(access, {}, (state) => {
            state.tenant.id = 'tenant_seal';
            state.tenant.name = 'No Fries Test';
            state.customers.push(customer);
            state.assessments.push({
                id: proposal.assessmentId,
                customerId: customer.id,
                answers: {},
                recommendations: []
            });
            state.proposals.push(proposal);
        });
        resetSalesRuntimeForTests();

        const exported = await handleSalesRequest(request(
            'GET',
            `/api/sales/proposals/${proposal.id}/export`,
            {},
            { format: 'html' }
        ));
        expect(exported.status).toBe(200);
        expect(exported.body).toContain('NZ$99 + GST per user each month');
        expect(exported.body).not.toContain('NZ$119 + GST per user each month');
        expect(exported.body).not.toContain('managed_it_2026_08_4');
    });

    test('bundled sealed exports render the service identity recorded in each approval snapshot', async () => {
        const repository = createSalesWorkspaceRepository({ dataDir: runtimeDataDir, provider: 'local' });
        const customer = { id: 'customer_seal', name: 'Seal Test Limited' };
        const tenant = { id: 'tenant_seal', name: 'No Fries Test' };
        const legacyServiceName = 'Legacy <em>Managed IT</em>';
        const legacyProposal = bundledProposalFixture(legacyServiceName, {
            id: 'proposal_bundled_v1',
            assessmentId: 'assessment_bundled_v1',
            pricing: Object.assign(legacyPricing(), {
                serviceName: legacyServiceName,
                users: 2,
                endpoints: 2,
                locations: 1,
                monthly: 198,
                onboarding: 600
            }),
            commercial: {
                userCount: 2,
                managedEndpointCount: 2,
                locationCount: 1,
                onboardingFeeExGst: 600,
                termMonths: 12,
                plannedStart: '2026-09-01',
                confirmed: true,
                monthlyTotalExGst: 198
            }
        });
        delete legacyProposal.commercialPolicy;
        legacyProposal.approvalSeal = legacyV1Seal(legacyProposal, customer, tenant);

        const currentProposal = bundledProposalFixture('No Fries Managed IT', {
            id: 'proposal_bundled_v2',
            assessmentId: 'assessment_bundled_v2'
        });
        currentProposal.approvalSeal = createProposalApprovalSeal({
            proposal: currentProposal,
            customer,
            tenant
        });

        expect(verifyProposalApprovalSeal(legacyProposal)).toMatchObject({ verified: true });
        expect(verifyProposalApprovalSeal(currentProposal)).toMatchObject({ verified: true });
        await repository.mutate(access, {}, (state) => {
            state.tenant.id = tenant.id;
            state.tenant.name = tenant.name;
            state.customers.push(customer);
            state.assessments.push(
                { id: legacyProposal.assessmentId, customerId: customer.id, answers: {}, recommendations: [] },
                { id: currentProposal.assessmentId, customerId: customer.id, answers: {}, recommendations: [] }
            );
            state.proposals.push(legacyProposal, currentProposal);
        });
        resetSalesRuntimeForTests();

        const legacyExport = await handleSalesRequest(request(
            'GET',
            `/api/sales/proposals/${legacyProposal.id}/export`,
            {},
            { format: 'html' }
        ));
        expect(legacyExport.status).toBe(200);
        expect(legacyExport.body).toContain('<h2>Your Legacy &lt;em&gt;Managed IT&lt;/em&gt; service</h2>');
        expect(legacyExport.body).not.toContain('No Fries Managed IT');
        expect(legacyExport.body).not.toContain('<h2>Your Legacy <em>Managed IT</em> service</h2>');
        expect(legacyExport.body).toContain('NZ$198 + GST per month');

        const currentExport = await handleSalesRequest(request(
            'GET',
            `/api/sales/proposals/${currentProposal.id}/export`,
            {},
            { format: 'html' }
        ));
        expect(currentExport.status).toBe(200);
        expect(currentExport.body).toContain('<h2>Your No Fries Managed IT service</h2>');
        expect(currentExport.body).not.toContain('Legacy &lt;em&gt;Managed IT&lt;/em&gt;');
        expect(currentExport.body).toContain('NZ$238 + GST per month');
    });

    test('approved API records are immutable and exports remain stable after customer metadata changes', async () => {
        const repository = createSalesWorkspaceRepository({ dataDir: runtimeDataDir, provider: 'local' });
        const customer = { id: 'customer_seal', name: 'Seal Test Limited' };
        const proposal = proposalFixture();
        const seeded = await repository.mutate(access, {}, (state) => {
            proposal.approvalSeal = createProposalApprovalSeal({ proposal, customer, tenant: state.tenant });
            state.customers.push(customer);
            state.assessments.push({
                id: proposal.assessmentId,
                customerId: customer.id,
                answers: {},
                recommendations: []
            });
            state.proposals.push(proposal);
            return proposal;
        });

        const summary = await handleSalesRequest(request('GET', '/api/sales/proposals'));
        expect(summary.body.proposals[0]).toMatchObject({
            versionNumber: 2,
            approvalSealStatus: 'sealed',
            approvedVersion: 'v2',
            approvedSha256: proposal.approvalSeal.sha256
        });

        const firstExport = await handleSalesRequest(request(
            'GET',
            `/api/sales/proposals/${proposal.id}/export`,
            {},
            { format: 'html' }
        ));
        const renamed = await repository.mutate(access, {
            expectedRevision: seeded.state.revision,
            action: 'customer.renamed'
        }, (state) => {
            state.customers[0].name = 'Renamed After Approval Limited';
        });
        const secondExport = await handleSalesRequest(request(
            'GET',
            `/api/sales/proposals/${proposal.id}/export`,
            {},
            { format: 'html' }
        ));
        expect(secondExport.body).toBe(firstExport.body);
        expect(secondExport.headers['Content-Disposition']).toBe(firstExport.headers['Content-Disposition']);
        expect(secondExport.body).toContain('Prepared for Seal Test Limited');
        expect(secondExport.body).not.toContain('Renamed After Approval Limited');

        await expect(handleSalesRequest(request(
            'PATCH',
            `/api/sales/proposals/${proposal.id}`,
            { expectedRevision: renamed.state.revision, title: 'Changed after approval', status: 'draft' }
        ))).rejects.toMatchObject({
            statusCode: 409,
            details: { code: 'approved_proposal_immutable' }
        });
        const persisted = await repository.read(access);
        expect(persisted.proposals[0].title).toBe(proposal.title);
        expect(verifyProposalApprovalSeal(persisted.proposals[0])).toMatchObject({ verified: true });
    });

    test('local sales mutations serialize across repository instances and preserve all audit evidence', async () => {
        const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-sales-serial-'));
        const firstRepository = createSalesWorkspaceRepository({ dataDir, provider: 'local' });
        const secondRepository = createSalesWorkspaceRepository({ dataDir, provider: 'local' });
        await Promise.all([
            firstRepository.mutate(access, { action: 'parallel.first' }, async (state) => {
                await new Promise((resolve) => setImmediate(resolve));
                state.customers.push({ id: 'customer_first', name: 'First' });
            }),
            secondRepository.mutate(access, { action: 'parallel.second' }, async (state) => {
                state.customers.push({ id: 'customer_second', name: 'Second' });
            })
        ]);
        const afterParallel = await firstRepository.read(access);
        expect(afterParallel.revision).toBe(2);
        expect(afterParallel.customers.map((customer) => customer.id).sort()).toEqual([
            'customer_first',
            'customer_second'
        ]);
        expect(afterParallel.audit).toHaveLength(2);
        expect(afterParallel.audit.every((event) => /^[a-f0-9]{64}$/.test(event.integritySha256))).toBe(true);
        expect(afterParallel.audit[1].previousHash).toBe(afterParallel.audit[0].integritySha256);
        expect(fs.readdirSync(path.dirname(firstRepository.filePath(access))).filter((name) => name.endsWith('.tmp'))).toEqual([]);

        const evidence = createEmptyState(access);
        evidence.audit = Array.from({ length: 1005 }, (_item, index) => ({
            id: `historical_${index}`,
            action: 'historical.evidence'
        }));
        fs.writeFileSync(firstRepository.filePath(access), JSON.stringify(evidence), 'utf8');
        await firstRepository.mutate(access, { expectedRevision: 0, action: 'evidence.appended' }, () => {});
        const preserved = await firstRepository.read(access);
        expect(preserved.audit).toHaveLength(1006);
        expect(preserved.audit[0].id).toBe('historical_0');
        fs.rmSync(dataDir, { recursive: true, force: true });
    });
});

function proposalFixture(overrides = {}) {
    return Object.assign({
        id: 'proposal_seal',
        customerId: 'customer_seal',
        assessmentId: 'assessment_seal',
        versionNumber: 2,
        title: 'Seal Test Limited — managed IT proposal',
        status: 'approved',
        commercialModel: 'service_recommendations',
        executiveSummary: 'A bounded managed IT service for Seal Test Limited.',
        objectives: ['Reliable support'],
        observations: ['Support response needs improvement.'],
        recommendations: [{
            recommendationId: 'recommendation_support',
            serviceKey: 'managed-support',
            serviceName: 'Managed support',
            outcome: 'Reliable support',
            why: 'The customer needs dependable response.',
            confirm: '',
            roadmap: 'now'
        }],
        pricing: {
            policyId: 'managed_it_2026_08_4',
            policyVersion: '2026.08.4',
            policyEffectiveFrom: '2026-08-23',
            serviceName: 'No Fries Managed IT',
            currency: 'NZD',
            gstExclusive: true,
            perUserMonthly: 119,
            includedEndpointsPerUser: 1,
            includedLocations: 1,
            onboardingFrom: 750,
            additionalEndpointMonthly: 20,
            additionalLocationMonthly: 125,
            additionalEndpointOnboarding: 30,
            additionalLocationOnboarding: 250
        },
        commercialPolicy: {
            policyId: 'managed_it_2026_08_4',
            policyVersion: '2026.08.4',
            effectiveFrom: '2026-08-23',
            serviceName: 'No Fries Managed IT'
        },
        commercial: {
            userCount: 2,
            managedEndpointCount: 2,
            locationCount: 1,
            onboardingFeeExGst: 750,
            termMonths: 12,
            plannedStart: '2026-09-01',
            confirmed: true,
            monthlyTotalExGst: 238
        },
        roadmap: { now: ['Managed support'], next: [], later: [] },
        assumptions: ['Scope changes require a new proposal version.'],
        nextStep: 'Accept this proposal.',
        createdBy: 'seal-admin@example.com',
        createdAt: '2026-08-21T00:00:00.000Z',
        updatedBy: 'seal-admin@example.com',
        updatedAt: '2026-08-21T01:00:00.000Z',
        approvedBy: 'seal-admin@example.com',
        approvedAt: '2026-08-21T01:00:00.000Z',
        approvalChecks: { checkedAt: '2026-08-21T01:00:00.000Z', blockingCount: 0, warnings: [] },
        aiReview: { status: 'reviewed' },
        dynamics: { status: 'not_sent', sentAt: '', handoffId: '', recordUrl: '' }
    }, overrides);
}

function bundledProposalFixture(serviceName, overrides = {}) {
    const base = proposalFixture();
    return proposalFixture(Object.assign({
        title: `Seal Test Limited — ${serviceName} proposal`,
        commercialModel: 'bundled_managed_it',
        executiveSummary: `One recorded ${serviceName} service.`,
        recommendations: [{
            recommendationId: 'recommendation_managed_it',
            serviceKey: 'managed-it-core',
            serviceName,
            outcome: 'Reliable managed IT',
            why: 'The customer needs dependable support.',
            confirm: '',
            roadmap: 'now'
        }],
        bundle: {
            serviceKey: 'managed-it-core',
            serviceName,
            outcome: 'Reliable managed IT',
            why: 'The customer needs dependable support.',
            confirm: '',
            includedComponents: [],
            validationComponents: []
        },
        pricing: Object.assign({}, base.pricing, {
            serviceName,
            users: 2,
            endpoints: 2,
            locations: 1,
            monthly: 238,
            onboarding: 750
        }),
        roadmap: { now: [serviceName], next: [], later: [] }
    }, overrides));
}

function legacyPricing() {
    return {
        currency: 'NZD',
        gstExclusive: true,
        perUserMonthly: 99,
        includedEndpointsPerUser: 1,
        includedLocations: 1,
        onboardingFrom: 600,
        additionalEndpointMonthly: 15,
        additionalLocationMonthly: 100,
        additionalEndpointOnboarding: 25,
        additionalLocationOnboarding: 200
    };
}

function proposalUpdateBody(proposal, expectedRevision, status, overrides = {}) {
    return Object.assign({
        expectedRevision,
        title: proposal.title,
        executiveSummary: proposal.executiveSummary,
        objectives: proposal.objectives,
        observations: proposal.observations,
        assumptions: proposal.assumptions,
        nextStep: proposal.nextStep,
        recommendations: proposal.recommendations,
        commercial: proposal.commercial,
        status
    }, overrides);
}

function legacyV1Seal(proposal, customer, tenant) {
    const currentSeal = createProposalApprovalSeal({ proposal, customer, tenant });
    const snapshot = JSON.parse(JSON.stringify(currentSeal.snapshot));
    snapshot.schema = LEGACY_PROPOSAL_APPROVAL_SNAPSHOT_SCHEMA;
    delete snapshot.document.commercialPolicy;
    return Object.assign({}, currentSeal, {
        schemaVersion: 1,
        snapshot,
        sha256: hashProposalApprovalSnapshot(snapshot)
    });
}

function request(method, originalUrl, body = {}, query = {}) {
    return {
        method,
        originalUrl,
        url: originalUrl,
        headers: {},
        body,
        query
    };
}
