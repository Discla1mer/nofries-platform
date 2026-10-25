const fs = require('fs');
const os = require('os');
const path = require('path');
const { createOrganisation } = require('../api/shared/lifecycle/lifecycleModel');
const {
    createLifecycleRepository,
    normaliseState
} = require('../api/shared/lifecycle/lifecycleRepository');
const { createLifecycleService } = require('../api/shared/lifecycle/lifecycleService');
const { createLifecycleService: createAppLifecycleService } = require('../api/shared/appLifecycle/lifecycleService');
const {
    BASE_PROOF_SOURCES,
    actorFromAccess,
    buildProofNarrativeGroundwork,
    cleanEvidenceReference,
    normaliseProofEvidence,
    normaliseProofPeriods,
    normaliseProofRequirementLedger,
    proofEvidenceContainsSensitiveData,
    proofFactsContainSensitiveData,
    proofReadiness,
    proofPeriodBounds,
    proofPeriodWriteBoundary,
    requiredProofSourcesForEntitlements,
    resolveProofRequirementsForEntitlements,
    resolveProofRequirementsForPeriod,
    sameActor
} = require('../api/shared/lifecycle/customerOperations');
const { ROLE_CAPABILITIES, tenantStorageKey } = require('../api/shared/tenantAccess');

describe('governed customer onboarding and management controls', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-customer-controls-'));
    let current;
    let repository;
    let service;
    let sequence;

    beforeEach(() => {
        current = new Date('2026-08-21T01:00:00.000Z');
        sequence = 0;
        repository = createLifecycleRepository({
            provider: 'local',
            dataDir: path.join(dataDir, String(Date.now()), String(Math.random()))
        });
        service = createLifecycleService({
            repository,
            now: () => new Date(current),
            approvedProposalVerifier: sealedProposalVerifier(),
            createId(prefix) {
                sequence += 1;
                return `${prefix}_controlled_${sequence}`;
            }
        });
    });

    test('binds dual-control actors to immutable Entra subjects', () => {
        const maker = access(
            'maker@example.com',
            '11111111-1111-4111-8111-111111111111',
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
        );
        const crossTenantSameOid = access(
            'other@example.com',
            maker.user.principalId,
            'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
        );
        const sameEmailDifferentSubject = access(
            maker.user.email,
            '22222222-2222-4222-8222-222222222222',
            'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
        );
        const aliasForMaker = access(
            'maker-alias@example.com',
            maker.user.principalId,
            maker.user.identityTenantId
        );

        expect(actorFromAccess(maker)).toMatchObject({
            principalId: maker.user.principalId,
            identityTenantId: maker.user.identityTenantId,
            subjectKey: maker.user.subjectKey
        });
        expect(sameActor(actorFromAccess(maker), actorFromAccess(crossTenantSameOid))).toBe(false);
        expect(sameActor(actorFromAccess(maker), actorFromAccess(sameEmailDifferentSubject))).toBe(true);
        expect(sameActor(actorFromAccess(maker), actorFromAccess(aliasForMaker))).toBe(true);
        expect(sameActor(actorFromAccess(maker), {
            principalId: maker.user.principalId,
            email: 'legacy@example.com'
        })).toBe(true);
    });

    afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

    test('proof sources follow active optional service entitlements', () => {
        expect(requiredProofSourcesForEntitlements([], '2026-08-23T00:00:00.000Z')).toEqual(BASE_PROOF_SOURCES);
        expect(requiredProofSourcesForEntitlements([
            { code: 'endpoint_security', name: 'Threat protection', quantity: 10, effectiveFrom: '2026-08-01T00:00:00.000Z' }
        ], '2026-08-23T00:00:00.000Z')).toEqual([
            'service_desk', 'datto_rmm', 'mdr', 'change', 'risk', 'billing', 'roadmap'
        ]);
        expect(requiredProofSourcesForEntitlements([
            { code: 'endpoint_security', name: 'Threat protection', quantity: 10, effectiveTo: '2026-08-20T00:00:00.000Z' },
            { code: 'work_file_backup', name: 'Work-file backup and recovery', quantity: 10, effectiveFrom: '2026-08-01T00:00:00.000Z' }
        ], '2026-08-23T00:00:00.000Z')).toEqual([
            'service_desk', 'datto_rmm', 'backup', 'change', 'risk', 'billing', 'roadmap'
        ]);
        expect(requiredProofSourcesForEntitlements([
            { code: 'mdr', name: 'MDR', quantity: 0 },
            { code: 'backup', name: 'Backup', quantity: 0 }
        ], '2026-08-23T00:00:00.000Z')).toEqual(BASE_PROOF_SOURCES);

        expect(requiredProofSourcesForEntitlements([
            { code: 'endpoint-security', name: 'Arbitrary display name', quantity: 1 }
        ], '2026-08-23T00:00:00.000Z')).toContain('mdr');
        expect(resolveProofRequirementsForEntitlements([
            { code: 'bespoke_security_service', name: 'CrowdStrike Falcon Complete', quantity: 1 }
        ], '2026-08-23T00:00:00.000Z')).toEqual({
            requiredSources: BASE_PROOF_SOURCES,
            unresolvedEntitlements: ['bespoke_security_service']
        });

        const august = proofPeriodBounds('2026-08', 'Pacific/Auckland');
        expect(august).toMatchObject({
            periodStart: '2026-07-31T12:00:00.000Z',
            periodEnd: '2026-08-31T11:59:59.999Z'
        });
        expect(proofPeriodBounds('2026-09', 'Pacific/Auckland')).toMatchObject({
            periodStart: '2026-08-31T12:00:00.000Z',
            periodEnd: '2026-09-30T10:59:59.999Z'
        });
        const april = proofPeriodBounds('2026-04', 'Pacific/Auckland');
        expect(april).toMatchObject({
            periodStart: '2026-03-31T11:00:00.000Z',
            periodEnd: '2026-04-30T11:59:59.999Z'
        });
        expect((april.endExclusiveMs - april.startMs) / (60 * 60 * 1000)).toBe(721);
        const september = proofPeriodBounds('2026-09', 'Pacific/Auckland');
        expect((september.endExclusiveMs - september.startMs) / (60 * 60 * 1000)).toBe(719);
        expect(proofPeriodBounds('2026-08', 'Not/A-Timezone')).toBeNull();
        expect(proofPeriodWriteBoundary([], '2026-08', 'Not/A-Timezone', '2026-08-21T01:00:00.000Z')).toEqual({
            allowed: false,
            code: 'proof_timezone_invalid'
        });
        expect(resolveProofRequirementsForPeriod([
            { code: 'endpoint_security', quantity: 1, effectiveTo: august.periodStart },
            { code: 'backup', quantity: 1, effectiveFrom: new Date(august.endExclusiveMs).toISOString() }
        ], '2026-08', 'Pacific/Auckland').requiredSources).toEqual(BASE_PROOF_SOURCES);
        expect(resolveProofRequirementsForPeriod([
            { code: 'endpoint_security', quantity: 1, effectiveFrom: august.periodStart, effectiveTo: new Date(august.endExclusiveMs).toISOString() },
            { code: 'backup', quantity: 1, effectiveFrom: new Date(august.endExclusiveMs - 1).toISOString() }
        ], '2026-08', 'Pacific/Auckland').requiredSources).toEqual([
            'service_desk', 'datto_rmm', 'mdr', 'backup', 'change', 'risk', 'billing', 'roadmap'
        ]);
    });

    test('Proof retention never evicts protected or open rows and new-period writes are bounded', () => {
        const openPeriods = Array.from({ length: 60 }, (_, index) => ({
            id: `proof-open-${index}`,
            customerId: 'customer-retention',
            period: `${2000 + Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`,
            timezone: 'Pacific/Auckland',
            status: 'collecting',
            requiredSources: BASE_PROOF_SOURCES,
            evidenceRefs: [],
            createdAt: '2026-08-20T00:00:00.000Z',
            updatedAt: '2026-08-20T00:00:00.000Z'
        }));
        const approved = Object.assign({}, openPeriods[0], {
            id: 'proof-approved-history',
            period: '1999-12',
            status: 'approved',
            approvedBy: 'checker@example.com',
            approvedAt: '2026-08-20T00:00:00.000Z'
        });
        const normalised = normaliseProofPeriods([approved].concat(openPeriods));
        expect(normalised).toHaveLength(61);
        expect(normalised.find((item) => item.id === approved.id)).toMatchObject({ status: 'approved' });
        expect(normalised.filter((item) => item.status === 'collecting')).toHaveLength(60);

        expect(proofPeriodWriteBoundary(normalised, '2026-08', 'Pacific/Auckland', '2026-08-21T01:00:00.000Z')).toMatchObject({
            allowed: false,
            code: 'proof_period_capacity_exceeded',
            maximumOpenPeriods: 60
        });
        expect(proofPeriodWriteBoundary([approved], '2021-08', 'Pacific/Auckland', '2026-08-21T01:00:00.000Z')).toMatchObject({
            allowed: false,
            code: 'proof_period_out_of_window',
            earliestPeriod: '2021-09',
            latestPeriod: '2026-08'
        });
        expect(proofPeriodWriteBoundary([approved], '2026-09', 'Pacific/Auckland', '2026-08-21T01:00:00.000Z')).toMatchObject({
            allowed: false,
            code: 'proof_period_out_of_window'
        });
        expect(proofPeriodWriteBoundary([approved], '2026-08', 'Pacific/Auckland', '2026-08-21T01:00:00.000Z')).toMatchObject({
            allowed: true
        });
    });

    test('legacy Proof evidence overflow is explicit, preserves required evidence, and fails closed', () => {
        const evidence = (id, source) => ({
            id,
            source,
            category: `${source}_monthly_evidence`,
            sourceMode: 'manual',
            providerRecordId: `${id}-record`,
            evidenceRef: `evidence-register:${id}`,
            checksum: canonicalSourceHash(id),
            periodStart: '2026-07-31T12:00:00.000Z',
            periodEnd: '2026-08-31T11:59:59.999Z',
            capturedAt: '2026-08-31T12:05:00.000Z',
            ingestedAt: '2026-08-31T12:05:00.000Z',
            freshUntil: '2026-10-01T00:00:00.000Z'
        });
        const legacyEvidence = [evidence('proof-legacy-sole-service-desk', 'service_desk')]
            .concat(Array.from({ length: 500 }, (_, index) => evidence(`proof-legacy-flood-${index}`, 'risk')));
        const rawProof = {
            id: 'proof-legacy-overflow',
            customerId: 'customer-legacy-overflow',
            period: '2026-08',
            timezone: 'Pacific/Auckland',
            status: 'collecting',
            requiredSources: ['service_desk'],
            evidenceRefs: legacyEvidence,
            createdAt: '2026-08-31T12:05:00.000Z',
            updatedAt: '2026-08-31T12:05:00.000Z'
        };
        const open = normaliseProofPeriods([rawProof])[0];
        expect(open).toMatchObject({ evidenceRefsOverflow: true });
        expect(open.evidenceRefs).toHaveLength(500);
        expect(open.evidenceRefs).toContainEqual(expect.objectContaining({
            id: 'proof-legacy-sole-service-desk',
            source: 'service_desk'
        }));
        expect(proofReadiness(open, '2026-08-31T12:05:00.000Z')).toMatchObject({
            ready: false,
            missing: expect.arrayContaining(['evidence_history:overflow'])
        });
        expect(normaliseProofPeriods([open])[0]).toMatchObject({ evidenceRefsOverflow: true });

        for (const status of ['approved', 'issued']) {
            const protectedProof = normaliseProofPeriods([Object.assign({}, rawProof, { status })])[0];
            expect(protectedProof).toMatchObject({ status, evidenceRefsOverflow: false });
            expect(protectedProof.evidenceRefs).toHaveLength(501);
            expect(protectedProof.evidenceRefs[0]).toMatchObject({ id: 'proof-legacy-sole-service-desk' });
            expect(proofReadiness(protectedProof, '2026-08-31T12:05:00.000Z')).toMatchObject({
                ready: true,
                missing: []
            });
        }
    });

    test('Proof requirement-ledger normalisation unions duplicates and marks code overflow fail-closed', () => {
        const entitlementCodes = Array.from({ length: 101 }, (_, index) => `unknown_entitlement_${String(index).padStart(3, '0')}`);
        const ledger = normaliseProofRequirementLedger([{
            period: '2026-08',
            timezone: 'Pacific/Auckland',
            entitlementCodes: entitlementCodes.slice(0, 100),
            requiredSources: ['service_desk'],
            historyComplete: true,
            throughMasterRevision: 12,
            updatedAt: '2026-08-20T00:00:00.000Z'
        }, {
            period: '2026-08',
            timezone: 'Pacific/Auckland',
            entitlementCodes: [entitlementCodes[100]],
            requiredSources: ['mdr'],
            historyComplete: false,
            throughMasterRevision: 13,
            updatedAt: '2026-08-21T00:00:00.000Z'
        }]);
        expect(ledger).toEqual([expect.objectContaining({
            period: '2026-08',
            entitlementCodes: expect.arrayContaining(entitlementCodes.slice(0, 100)),
            entitlementCodesOverflow: true,
            requiredSources: ['service_desk', 'mdr'],
            historyComplete: false,
            throughMasterRevision: 13
        })]);
        expect(ledger[0].entitlementCodes).toHaveLength(100);
    });

    test('monthly-proof facts are bounded and reject secret-like values', () => {
        const evidence = normaliseProofEvidence([{
            id: 'proof-safe-facts',
            source: 'service_desk',
            sourceMode: 'manual',
            evidenceRef: 'evidence-register:service-desk:2026-08',
            checksum: canonicalSourceHash('proof-safe-facts'),
            capturedAt: '2026-08-23T00:00:00.000Z',
            freshUntil: '2026-09-30T00:00:00.000Z',
            facts: [{ key: 'tickets.resolved', label: 'Tickets resolved', value: 12, unit: 'tickets' }]
        }])[0];
        expect(evidence.facts).toEqual([{
            key: 'tickets.resolved',
            label: 'Tickets resolved',
            value: '12',
            unit: 'tickets',
            status: 'informational'
        }]);
        expect(normaliseProofEvidence([{
            id: 'proof-unsafe-facts',
            source: 'service_desk',
            sourceMode: 'manual',
            evidenceRef: 'evidence-register:service-desk:2026-08',
            checksum: canonicalSourceHash('proof-unsafe-facts'),
            capturedAt: '2026-08-23T00:00:00.000Z',
            facts: [
                { key: 'tickets.resolved', value: '12' },
                { key: 'connector.note', value: 'api key: do-not-store' }
            ]
        }])).toEqual([]);
        [
            { key: 'raw.key', value: 'sk-proj-abcdefghijklmnop' },
            { key: 'header', value: 'Bearer abcdefghijklmnop' },
            { key: 'jwt', value: 'eyJabcdefghijk.eyJabcdefghijk.abcdefghijklmnop' },
            { key: 'payment', value: '4242 4242 4242 4242' },
            { key: 'password', value: 'abcdefghijklmnop' },
            { key: 'backup.password.value', label: 'Backup password value', value: 'correct-horse-battery-staple' },
            { key: 'tickets.total', label: 'Password value from backup', value: '12' },
            { key: 'connector.api_key', value: 'abcdefghijklmnop' },
            { key: 'credential', value: 'abcdefghijklmnop' }
        ].forEach((fact) => expect(proofFactsContainSensitiveData([fact])).toBe(true));
        expect(proofFactsContainSensitiveData([{ key: 'password_resets', value: '12' }])).toBe(false);
        expect(proofFactsContainSensitiveData([{ key: 'change.status', value: 'Password reset completed' }])).toBe(false);
        expect(proofFactsContainSensitiveData([{ key: 'password_age', label: 'Password age', value: '42', unit: 'days' }])).toBe(false);
        expect(proofFactsContainSensitiveData([{ key: 'password_count', label: 'Password count', value: '100' }])).toBe(false);
        expect(proofFactsContainSensitiveData([{ key: 'password_resets', value: 'correct-horse-battery-staple' }])).toBe(true);
        expect(proofEvidenceContainsSensitiveData({
            id: 'password_resets-2026-08',
            providerRecordId: 'recordId=abc123',
            facts: [{ key: 'password_resets', value: '12' }]
        })).toBe(false);
        expect(proofEvidenceContainsSensitiveData({ category: 'Basic dXNlcjpwYXNz' })).toBe(true);
        expect(proofEvidenceContainsSensitiveData({
            category: `Evidence ${Buffer.from('Bearer abcdefghijklmnop').toString('base64')} monthly`
        })).toBe(true);
        for (const width of [4, 8, 10, 11]) {
            const folded = Buffer.from('{"api_key":"abcdefghijklmnop"}').toString('base64')
                .match(new RegExp(`.{1,${width}}`, 'g')).join(' ');
            expect(proofEvidenceContainsSensitiveData({
                category: `Evidence ${folded} monthly`
            })).toBe(true);
            const wrappers = {
                4: ['safe', 'plan'],
                8: ['evidence', 'analysis'],
                10: ['monitoring', 'assessment'],
                11: ['observation', 'evaluations']
            }[width];
            expect(proofEvidenceContainsSensitiveData({
                category: `${`${wrappers[0]} `.repeat(12)}${folded}${` ${wrappers[1]}`.repeat(12)}`
            })).toBe(true);
        }
        const longSecret = `{"api_key":"${'k'.repeat(120)}"}`;
        const safeNarrative = `Monthly availability evidence remained healthy ${'and stable '.repeat(14)}`;
        for (const width of [12, 13, 16, 18, 64, 76, 93, 97, 101, 117]) {
            const folded = foldBase64(longSecret, width);
            const sameWidthWrapper = 'observationalcontext'.padEnd(width, 'x').slice(0, width);
            expect(proofEvidenceContainsSensitiveData({
                category: `Normal monthly evidence ${sameWidthWrapper} ${sameWidthWrapper} ${folded} ${sameWidthWrapper} ${sameWidthWrapper} summary`
            })).toBe(true);
            expect(proofEvidenceContainsSensitiveData({
                category: `Normal monthly evidence ${foldBase64(safeNarrative, width)} summary`
            })).toBe(false);
        }
        [
            foldBase64Uneven('Bearer abcdefghijklmnop', [5]),
            foldBase64Uneven('Bearer abcdefghijklmnop', [3, 17]),
            foldBase64Uneven(longSecret, [7, 2, 19, 4, 11, 23])
        ].forEach((folded) => expect(proofEvidenceContainsSensitiveData({
            category: `Normal monthly evidence ${folded} summary`
        })).toBe(true));
        [
            foldBase64Uneven(safeNarrative, [5]),
            foldBase64Uneven(safeNarrative, [3, 17]),
            foldBase64Uneven(safeNarrative, [7, 2, 19, 4, 11, 23])
        ].forEach((folded) => expect(proofEvidenceContainsSensitiveData({
            category: `Normal monthly evidence ${folded} summary`
        })).toBe(false));
        for (const punctuation of ['.', ')', ']', '"', "'"]) {
            expect(proofEvidenceContainsSensitiveData({ category: `Basic dXNlcjpwYXNz${punctuation}` })).toBe(true);
        }
        expect(proofEvidenceContainsSensitiveData({
            category: 'sk%252525252Dproj%252525252Dabcdefghijklmnop'
        })).toBe(true);
        expect(proofEvidenceContainsSensitiveData({
            category: `Basic ${'A'.repeat(501)}`
        })).toBe(true);
        expect(proofEvidenceContainsSensitiveData({
            category: 'monthly%ZZ-sk%252Dproj%252Dabcdefghijklmnop'
        })).toBe(true);
        expect(proofEvidenceContainsSensitiveData({ category: 'Basic monthly health check' })).toBe(false);
        expect(proofEvidenceContainsSensitiveData({ category: 'Availability was 99% this month' })).toBe(false);
        expect(proofEvidenceContainsSensitiveData({ category: `Evidence ${'a'.repeat(64)} captured 2026-08-31` })).toBe(false);
        expect(proofEvidenceContainsSensitiveData({
            category: 'safe plan note '.repeat(35).slice(0, 500)
        })).toBe(false);
        expect(proofEvidenceContainsSensitiveData({ category: '{"token":"abcdefghijklmnop"}' })).toBe(true);
        expect(proofEvidenceContainsSensitiveData({
            providerRecordId: Buffer.from('Bearer abcdefghijklmnop').toString('base64')
        })).toBe(true);
        expect(proofEvidenceContainsSensitiveData({
            providerRecordId: Buffer.from('{"api_key":"abcdefghijklmnop"}').toString('base64')
        })).toBe(true);
    });

    test('evidence references reject URL and authorization credentials without rejecting record identifiers', () => {
        expect(cleanEvidenceReference('https://vendor.example/evidence?token=abcdefghijklmnop')).toBe('');
        expect(cleanEvidenceReference('Authorization: Basic dXNlcjpwYXNzd29yZA==')).toBe('');
        expect(cleanEvidenceReference('Basic dXNlcjpwYXNz')).toBe('');
        expect(cleanEvidenceReference('Basic dXNlcjpwYXNz.)')).toBe('');
        expect(cleanEvidenceReference('Basic dXNlcjpwYXNz]')).toBe('');
        expect(cleanEvidenceReference('sk%252525252Dproj%252525252Dabcdefghijklmnop')).toBe('');
        expect(cleanEvidenceReference(`Basic ${'A'.repeat(501)}`)).toBe('');
        expect(cleanEvidenceReference('monthly%ZZ-sk%252Dproj%252Dabcdefghijklmnop')).toBe('');
        expect(cleanEvidenceReference('Basic monthly health check')).toBe('Basic monthly health check');
        expect(cleanEvidenceReference('Availability was 99% this month')).toBe('Availability was 99% this month');
        expect(cleanEvidenceReference('https://operator:correct-horse@example.com/evidence')).toBe('');
        expect(cleanEvidenceReference('/evidence/august?sig=abcdefghijklmnop')).toBe('');
        expect(cleanEvidenceReference('/evidence/august;sig=abcdefghijklmnop')).toBe('');
        expect(cleanEvidenceReference('/evidence/august#signature=abcdefghijklmnop')).toBe('');
        expect(cleanEvidenceReference('%252Fevidence%253Ftoken%253Dabcdefghijklmnop')).toBe('');
        expect(cleanEvidenceReference('https://vendor.example/evidence?recordId=abc123')).toBe(
            'https://vendor.example/evidence?recordId=abc123'
        );
        expect(cleanEvidenceReference('/evidence/august?recordId=abc123')).toBe('/evidence/august?recordId=abc123');
    });

    test('monthly-proof groundwork separates unknown facts from supported claims', () => {
        const groundwork = buildProofNarrativeGroundwork({
            period: '2026-08',
            timezone: 'Pacific/Auckland',
            requiredSources: ['service_desk'],
            evidenceRefs: [{
                id: 'proof-unknown',
                source: 'service_desk',
                sourceMode: 'manual',
                evidenceRef: 'evidence-register:service-desk:2026-08',
                checksum: canonicalSourceHash('proof-unknown'),
                periodStart: '2026-07-31T12:00:00.000Z',
                periodEnd: '2026-08-31T11:59:59.999Z',
                capturedAt: '2026-08-31T12:05:00.000Z',
                ingestedAt: '2026-08-31T12:05:00.000Z',
                freshUntil: '2026-09-30T00:00:00.000Z',
                facts: [{ key: 'tickets.total', label: 'Ticket total', value: 'Unknown', unit: '', status: 'unknown' }]
            }]
        }, '2026-08-31T12:05:00.000Z');
        expect(groundwork.sections[0]).toMatchObject({
            state: 'fresh',
            claims: [],
            diagnostics: [expect.objectContaining({ code: 'fact_unknown', key: 'tickets.total' })]
        });
        expect(groundwork).toMatchObject({ readyForDraft: false, missingFacts: ['service_desk'] });
    });

    test('wrong-month evidence cannot become fresh or create claims while wider full-month coverage remains eligible', () => {
        const proof = {
            period: '2026-08',
            timezone: 'Pacific/Auckland',
            requiredSources: ['service_desk'],
            evidenceRefs: [{
                id: 'proof-may-only',
                source: 'service_desk',
                sourceMode: 'manual',
                evidenceRef: 'evidence-register:service-desk:2026-05',
                checksum: canonicalSourceHash('proof-may-only'),
                periodStart: '2026-04-30T12:00:00.000Z',
                periodEnd: '2026-05-31T11:59:59.999Z',
                capturedAt: '2026-08-31T12:05:00.000Z',
                ingestedAt: '2026-08-31T12:05:00.000Z',
                freshUntil: '2026-10-01T00:00:00.000Z',
                facts: [{ key: 'tickets.total', label: 'Ticket total', value: '99', unit: 'tickets', status: 'informational' }]
            }]
        };
        const wrongMonth = buildProofNarrativeGroundwork(proof, '2026-08-31T12:05:00.000Z');
        expect(wrongMonth).toMatchObject({
            readyForDraft: false,
            readyForApproval: false,
            missingEvidence: ['service_desk:coverage_mismatch']
        });
        expect(wrongMonth.sections[0]).toMatchObject({ state: 'coverage_mismatch', claims: [] });

        proof.evidenceRefs.push({
            id: 'proof-full-coverage',
            source: 'service_desk',
            sourceMode: 'manual',
            evidenceRef: 'evidence-register:service-desk:full-coverage',
            checksum: canonicalSourceHash('proof-full-coverage'),
            periodStart: '2026-07-01T00:00:00.000Z',
            periodEnd: '2026-09-01T00:00:00.000Z',
            capturedAt: '2026-08-31T12:05:00.000Z',
            ingestedAt: '2026-08-31T12:05:00.000Z',
            freshUntil: '2026-10-01T00:00:00.000Z',
            facts: [{ key: 'tickets.total', label: 'Ticket total', value: '12', unit: 'tickets', status: 'informational' }]
        });
        const covered = buildProofNarrativeGroundwork(proof, '2026-08-31T12:05:00.000Z');
        expect(covered).toMatchObject({ readyForDraft: true, readyForApproval: true, missingEvidence: [] });
        expect(covered.sections[0]).toMatchObject({
            state: 'fresh',
            evidenceId: 'proof-full-coverage',
            claims: [expect.objectContaining({ value: '12' })]
        });

        const duplicateIdentity = buildProofNarrativeGroundwork(Object.assign({}, proof, {
            evidenceRefs: proof.evidenceRefs.map((item) => Object.assign({}, item, { id: 'proof-duplicate-id' }))
        }), '2026-08-31T12:05:00.000Z');
        expect(duplicateIdentity).toMatchObject({ readyForApproval: false });
        expect(duplicateIdentity.sections[0]).toMatchObject({ state: 'identity_conflict', claims: [] });
    });

    test('domain creation always starts at Prospect and unknown future storage fails closed', () => {
        expect(() => createOrganisation({ recordType: 'customer' })).toThrow(expect.objectContaining({
            details: { code: 'initial_lifecycle_state_forbidden' }
        }));
        expect(() => createOrganisation({ lifecycleState: 'active' })).toThrow(expect.objectContaining({
            details: { code: 'initial_lifecycle_state_forbidden' }
        }));
        expect(() => normaliseState({ schemaVersion: 99 }, access('admin-a@example.com', 'admin-a'))).toThrow(expect.objectContaining({
            details: expect.objectContaining({ code: 'lifecycle_schema_version_unsupported' })
        }));
    });

    test('external acceptance fails closed when the approved proposal seal cannot be verified', async () => {
        service = createLifecycleService({
            repository,
            now: () => new Date(current),
            approvedProposalVerifier: {
                verify: jest.fn(async () => ({ verified: false, code: 'approved_proposal_binding_mismatch' }))
            }
        });
        const actor = access('admin-a@example.com', 'admin-a');
        await expect(prepareAcceptedCustomer(actor, 'unverified')).rejects.toMatchObject({
            details: { code: 'approved_proposal_binding_mismatch' }
        });
        const state = await repository.read(actor);
        expect(state.organisations[0].lifecycleState).toBe('scoping');
        expect(state.organisations[0].recordType).toBe('prospect');
    });

    test('external acceptance fails closed when the Sales verifier is unavailable', async () => {
        service = createLifecycleService({
            repository,
            now: () => new Date(current)
        });
        const actor = access('admin-a@example.com', 'admin-a');
        await expect(prepareAcceptedCustomer(actor, 'no-verifier')).rejects.toMatchObject({
            statusCode: 503,
            details: { code: 'approved_proposal_verification_unavailable' }
        });
        const state = await repository.read(actor);
        expect(state.organisations[0].lifecycleState).toBe('scoping');
    });

    test('proposal identifiers can be bound only through exact sealed-proposal verification', async () => {
        const actor = access('admin-a@example.com', 'admin-a');
        let result = await service.createOrganisation(actor, { displayName: 'Proposal binding customer' });
        for (const lifecycleState of ['discovery', 'scoping']) {
            result = await service.updateOrganisation(actor, result.organisation.organisationId, {
                expectedRevision: result.revision,
                lifecycleState
            });
        }
        await expect(service.updateOrganisation(actor, result.organisation.organisationId, {
            expectedRevision: result.revision,
            scope: { salesCustomerId: 'forged-customer', assessmentId: 'forged-assessment', proposalId: 'forged-proposal' }
        })).rejects.toMatchObject({
            statusCode: 409,
            details: { code: 'proposal_binding_flow_required' }
        });

        result = await service.linkScopingRecords(actor, result.organisation.organisationId, {
            expectedRevision: result.revision,
            salesCustomerId: 'sales-binding-customer',
            assessmentId: 'assessment-binding-customer'
        });
        result = await service.bindApprovedProposal(actor, result.organisation.organisationId, {
            expectedRevision: result.revision,
            proposalId: 'proposal-binding-customer',
            proposalVersion: 'v1',
            proposalSha256: 'a'.repeat(64),
            confirmApprovedProposal: true
        });
        expect(result.organisation).toMatchObject({
            lifecycleState: 'proposal',
            scope: {
                status: 'approved',
                salesCustomerId: 'sales-binding-customer',
                assessmentId: 'assessment-binding-customer',
                proposalId: 'proposal-binding-customer',
                proposalVersion: 'v1',
                proposalSha256: 'a'.repeat(64)
            }
        });
        const replayed = await service.bindApprovedProposal(actor, result.organisation.organisationId, {
            expectedRevision: result.revision - 1,
            proposalId: 'proposal-binding-customer',
            proposalVersion: 'v1',
            proposalSha256: 'a'.repeat(64),
            confirmApprovedProposal: true
        });
        expect(replayed.revision).toBe(result.revision);
        await expect(service.unlinkScopingRecords(actor, result.organisation.organisationId, {
            salesCustomerId: 'sales-binding-customer'
        })).rejects.toMatchObject({
            statusCode: 409,
            details: { code: 'customer_sales_evidence_retention_required' }
        });
    });

    test('verified proposal binding repairs a legacy proposal record with incomplete seal fields', async () => {
        const actor = access('admin-a@example.com', 'admin-a');
        let result = await service.createOrganisation(actor, { displayName: 'Legacy proposal binding customer' });
        for (const lifecycleState of ['discovery', 'scoping']) {
            result = await service.updateOrganisation(actor, result.organisation.organisationId, {
                expectedRevision: result.revision,
                lifecycleState
            });
        }
        result = await service.linkScopingRecords(actor, result.organisation.organisationId, {
            expectedRevision: result.revision,
            salesCustomerId: 'sales-legacy-binding-customer',
            assessmentId: 'assessment-legacy-binding-customer'
        });
        const legacy = await repository.mutate(actor, {
            expectedRevision: result.revision
        }, async (state) => {
            const organisation = state.organisations.find((item) => item.id === result.organisation.organisationId);
            organisation.lifecycleState = 'proposal';
            organisation.scope.status = 'approved';
            organisation.scope.proposalId = 'proposal-legacy-binding-customer';
            organisation.scope.proposalVersion = '';
            organisation.scope.proposalSha256 = '';
            return organisation;
        });

        const repaired = await service.bindApprovedProposal(actor, result.organisation.organisationId, {
            expectedRevision: legacy.state.revision,
            proposalId: 'proposal-legacy-binding-customer',
            proposalVersion: 'v1',
            proposalSha256: 'a'.repeat(64),
            confirmApprovedProposal: true
        });

        expect(repaired.revision).toBe(legacy.state.revision + 1);
        expect(repaired.organisation).toMatchObject({
            lifecycleState: 'proposal',
            scope: {
                status: 'approved',
                proposalId: 'proposal-legacy-binding-customer',
                proposalVersion: 'v1',
                proposalSha256: 'a'.repeat(64),
                proposalBoundBy: 'admin-a@example.com'
            }
        });
    });

    test('local customer-state mutations serialize and audit is not silently truncated at the former cap', async () => {
        const actor = access('admin-a@example.com', 'admin-a');
        await Promise.all([
            repository.mutate(actor, {}, async (state) => {
                await Promise.resolve();
                state.controlRuns.push({ id: 'run-one', organisationId: 'org-one', jobType: 'test', scheduledFor: current.toISOString() });
            }),
            repository.mutate(actor, {}, async (state) => {
                await Promise.resolve();
                state.controlRuns.push({ id: 'run-two', organisationId: 'org-two', jobType: 'test', scheduledFor: current.toISOString() });
            })
        ]);
        const afterConcurrent = await repository.read(actor);
        expect(afterConcurrent.revision).toBe(2);
        expect(afterConcurrent.controlRuns.map((item) => item.id).sort()).toEqual(['run-one', 'run-two']);

        await repository.mutate(actor, {
            expectedRevision: afterConcurrent.revision,
            auditEvents: Array.from({ length: 3005 }, (_, index) => ({
                action: 'audit.capacity_test',
                targetType: 'tenant',
                targetId: actor.tenant.key,
                summary: `Capacity event ${index}`
            }))
        }, async () => null);
        expect((await repository.read(actor)).audit).toHaveLength(3005);
    });

    test('external customer moves from accepted proposal through G0-G5 with three distinct actors', async () => {
        const maker = access('maker@example.com', 'principal-maker');
        const checker = access('checker@example.com', 'principal-checker');
        const executor = access('executor@example.com', 'principal-executor');
        const prepared = await prepareAcceptedCustomer(maker);

        const onboarding = await service.startCustomerOnboarding(maker, prepared.organisation.organisationId, {
            expectedRevision: prepared.revision,
            customerMaster: customerMasterFixture(),
            supportProfile: supportProfileFixture(),
            devices: [
                { id: 'device-one', label: 'Front desk laptop', platform: 'windows', owner: 'installer@customer-one.example' },
                { id: 'device-two', label: 'Owner MacBook', platform: 'macos', owner: 'owner@customer-one.example' }
            ]
        });
        expect(onboarding.organisation.onboarding.gates.map((gate) => gate.code)).toEqual(['G0', 'G1', 'G2', 'G3', 'G4', 'G5']);
        expect(onboarding.organisation.onboarding.gates.find((gate) => gate.code === 'G0').status).toBe('complete');
        expect(onboarding.organisation.onboarding.status).toBe('blocked');
        const concurrent = await service.createInternalPilotCustomer(maker, {
            expectedRevision: onboarding.revision,
            displayName: 'Second Concurrent Onboarding',
            primaryEmail: 'maker@example.com',
            expectedUsers: 1,
            expectedEndpoints: 2,
            devices: [
                { id: 'concurrent-one', label: 'Concurrent one', platform: 'windows' },
                { id: 'concurrent-two', label: 'Concurrent two', platform: 'macos' }
            ],
            confirmInternalPilot: true
        });
        expect(concurrent.organisation.lifecycleState).toBe('onboarding');
        expect(concurrent.organisation.organisationId).not.toBe(onboarding.organisation.organisationId);

        let progress = await service.syncDattoRmmSnapshot(maker, prepared.organisation.organisationId, {
            expectedRevision: concurrent.revision,
            siteUid: 'site-customer-one',
            siteName: 'Customer One',
            deviceCount: 2,
            openAlertCount: 0,
            capturedAt: current.toISOString(),
            truncated: false,
            devices: [
                { deviceUid: 'datto-one', hostname: 'front-desk', operatingSystem: 'Windows 11', lastSeen: current.toISOString(), online: true },
                { deviceUid: 'datto-two', hostname: 'owner-mac', operatingSystem: 'macOS', lastSeen: current.toISOString(), online: true }
            ]
        });
        progress = await service.matchOnboardingDevice(maker, prepared.organisation.organisationId, {
            expectedRevision: progress.revision,
            deviceId: 'device-one',
            providerDeviceUid: 'datto-one',
            confirmMatch: true
        });
        progress = await service.matchOnboardingDevice(maker, prepared.organisation.organisationId, {
            expectedRevision: progress.revision,
            deviceId: 'device-two',
            providerDeviceUid: 'datto-two',
            confirmMatch: true
        });
        for (const deviceId of ['device-one', 'device-two']) {
            for (const status of ['installer_ready', 'enrolled', 'verified']) {
                progress = await service.updateOnboardingDevice(maker, prepared.organisation.organisationId, {
                    expectedRevision: progress.revision,
                    deviceId,
                    status
                });
            }
        }
        expect(progress.organisation.onboarding.gates.find((gate) => gate.code === 'G3').status).toBe('complete');

        const monitoringEvidence = {
            expectedRevision: progress.revision,
            gateId: 'monitoring_acceptance',
            evidenceId: 'monitoring-acceptance-v1',
            evidenceType: 'customer_monitoring_acceptance',
            source: 'signed_service_schedule',
            sourceMode: 'manual',
            evidenceRef: 'contract-register:agreement-one:monitoring',
            checksum: 'c'.repeat(64),
            capturedAt: current.toISOString(),
            validUntil: '2027-08-20T01:00:00.000Z',
            customerAcceptedAt: current.toISOString(),
            customerAuthorityRef: 'authority-register:sponsor-one'
        };
        await expect(service.recordOnboardingEvidence(maker, prepared.organisation.organisationId, Object.assign({}, monitoringEvidence, {
            customerAcceptedAt: '2026-08-21T02:00:00.000Z'
        }))).rejects.toMatchObject({ details: { code: 'monitoring_customer_acceptance_time_invalid' } });
        await expect(service.recordOnboardingEvidence(maker, prepared.organisation.organisationId, Object.assign({}, monitoringEvidence, {
            capturedAt: '2026-08-21T00:00:00.000Z',
            customerAcceptedAt: '2026-08-21T00:30:00.000Z'
        }))).rejects.toMatchObject({ details: { code: 'monitoring_customer_acceptance_order_invalid' } });
        progress = await service.recordOnboardingEvidence(maker, prepared.organisation.organisationId, monitoringEvidence);
        expect(progress.organisation.onboarding.gates.find((gate) => gate.code === 'G4').status).toBe('complete');

        const requested = await service.requestActivation(maker, prepared.organisation.organisationId, {
            expectedRevision: progress.revision,
            idempotencyKey: 'activate:customer-one:2026-08-v1',
            customerAuthorityRef: 'authority-register:sponsor-one',
            confirmNoUnresolvedHighRiskExceptions: true
        });
        await expect(service.reviewActivation(checker, prepared.organisation.organisationId, requested.request.id, {
            expectedRevision: requested.revision
        })).rejects.toMatchObject({ statusCode: 400, details: { code: 'activation_review_decision_invalid' } });
        await expect(service.reviewActivation(checker, prepared.organisation.organisationId, requested.request.id, {
            expectedRevision: requested.revision,
            decision: 'APPROVE'
        })).rejects.toMatchObject({ statusCode: 400, details: { code: 'activation_review_decision_invalid' } });
        await expect(service.reviewActivation(
            access('maker@example.com', 'principal-maker-alias'),
            prepared.organisation.organisationId,
            requested.request.id,
            { expectedRevision: requested.revision, decision: 'approve' }
        )).rejects.toMatchObject({ details: { code: 'lifecycle_user_identity_conflict' } });
        await expect(service.reviewActivation(maker, prepared.organisation.organisationId, requested.request.id, {
            expectedRevision: requested.revision,
            decision: 'approve'
        })).rejects.toMatchObject({ details: { code: 'activation_maker_checker_conflict' } });

        const approved = await service.reviewActivation(checker, prepared.organisation.organisationId, requested.request.id, {
            expectedRevision: requested.revision,
            decision: 'approve'
        });
        await expect(service.executeActivation(checker, prepared.organisation.organisationId, requested.request.id, {
            expectedRevision: approved.revision,
            confirmActivation: true
        })).rejects.toMatchObject({ details: { code: 'activation_checker_executor_conflict' } });
        await expect(service.executeActivation(
            access('checker@example.com', 'principal-checker-alias'),
            prepared.organisation.organisationId,
            requested.request.id,
            { expectedRevision: approved.revision, confirmActivation: true }
        )).rejects.toMatchObject({ details: { code: 'lifecycle_user_identity_conflict' } });

        const active = await service.executeActivation(executor, prepared.organisation.organisationId, requested.request.id, {
            expectedRevision: approved.revision,
            confirmActivation: true
        });
        expect(active.organisation).toMatchObject({
            lifecycleState: 'active',
            serviceStatus: { state: 'active' },
            onboarding: { status: 'complete' }
        });
        expect(active.request).toMatchObject({
            status: 'consumed',
            maker: { principalId: 'principal-maker' },
            checker: { principalId: 'principal-checker' },
            executor: { principalId: 'principal-executor' }
        });
        const directory = await service.listServiceDeskCustomers(maker);
        expect(directory.readiness).toMatchObject({ eligible: true, eligibleCustomerCount: 1 });
        await expect(service.requireServiceDeskCustomer(maker, prepared.organisation.organisationId, {
            requesterEmail: 'unknown@customer-one.example',
            intakeChannel: 'portal',
            requesterVerificationMethod: 'Microsoft identity',
            requesterVerificationRef: 'identity-register:unknown'
        })).rejects.toMatchObject({ details: { code: 'support_requester_not_authorised' } });
        await expect(service.requireServiceDeskCustomer(maker, prepared.organisation.organisationId, {
            requesterEmail: 'sponsor@customer-one.example',
            intakeChannel: 'portal',
            requesterVerificationMethod: 'Microsoft identity',
            requesterVerificationRef: 'identity-register:sponsor'
        })).resolves.toMatchObject({ id: prepared.organisation.organisationId });
        let scheduleState = await repository.read(maker);
        let customerSchedules = scheduleState.schedules.filter((item) => item.organisationId === prepared.organisation.organisationId);
        expect(customerSchedules).toHaveLength(5);
        expect(customerSchedules.every((item) => item.enabled)).toBe(true);

        const suspended = await service.updateServiceStatus(checker, prepared.organisation.organisationId, {
            expectedRevision: active.revision,
            action: 'suspend',
            reason: 'Customer-requested temporary service suspension',
            customerAuthorityRef: 'authority-register:suspension-1'
        });
        expect((await service.listServiceDeskCustomers(maker)).customers).toEqual([]);
        scheduleState = await repository.read(maker);
        customerSchedules = scheduleState.schedules.filter((item) => item.organisationId === prepared.organisation.organisationId);
        expect(customerSchedules.every((item) => item.enabled === false)).toBe(true);
        const resumed = await service.updateServiceStatus(checker, prepared.organisation.organisationId, {
            expectedRevision: suspended.revision,
            action: 'resume',
            reason: 'Customer confirmed service resume',
            customerAuthorityRef: 'authority-register:resume-1'
        });
        expect(resumed.organisation.serviceStatus.state).toBe('active');
        scheduleState = await repository.read(maker);
        customerSchedules = scheduleState.schedules.filter((item) => item.organisationId === prepared.organisation.organisationId);
        expect(customerSchedules.every((item) => item.enabled)).toBe(true);

        const offboarding = await service.updateServiceStatus(checker, prepared.organisation.organisationId, {
            expectedRevision: resumed.revision,
            action: 'start_offboarding',
            reason: 'Customer approved controlled service closure',
            customerAuthorityRef: 'authority-register:offboarding-1'
        });
        scheduleState = await repository.read(maker);
        customerSchedules = scheduleState.schedules.filter((item) => item.organisationId === prepared.organisation.organisationId);
        expect(customerSchedules.every((item) => item.enabled === false)).toBe(true);
        const former = await service.updateServiceStatus(checker, prepared.organisation.organisationId, {
            expectedRevision: offboarding.revision,
            action: 'complete_offboarding',
            reason: 'Offboarding checklist and customer handover completed',
            customerAuthorityRef: 'authority-register:offboarding-complete-1'
        });
        expect(former.organisation.serviceStatus.state).toBe('former');
        scheduleState = await repository.read(maker);
        customerSchedules = scheduleState.schedules.filter((item) => item.organisationId === prepared.organisation.organisationId);
        expect(customerSchedules.every((item) => item.enabled === false)).toBe(true);

        const state = await repository.read(maker);
        expect(state.audit.length).toBeGreaterThan(10);
        expect(state.audit.every((event) => /^[a-f0-9]{64}$/.test(event.integritySha256))).toBe(true);
        expect(state.audit[state.audit.length - 1].previousHash).toBe(state.audit[state.audit.length - 2].integritySha256);
    });

    test('external onboarding requires an explicit owner or authorised installer email for every planned device', async () => {
        const maker = access('maker@example.com', 'principal-maker');
        const prepared = await prepareAcceptedCustomer(maker, 'explicit-owner');
        const master = customerMasterFixture();
        master.externalRefs = [
            verifiedRef('hubspot', 'company', 'hubspot-company-explicit-owner'),
            verifiedRef('autotask', 'account', 'autotask-account-explicit-owner')
        ];

        await expect(service.startCustomerOnboarding(maker, prepared.organisation.organisationId, {
            expectedRevision: prepared.revision,
            customerMaster: master,
            supportProfile: supportProfileFixture(),
            devices: [{ id: 'unowned-device', label: 'Unowned device', platform: 'windows' }]
        })).rejects.toMatchObject({
            statusCode: 400,
            details: { code: 'onboarding_device_owner_required' }
        });
        await expect(service.startCustomerOnboarding(maker, prepared.organisation.organisationId, {
            expectedRevision: prepared.revision,
            customerMaster: master,
            supportProfile: supportProfileFixture(),
            devices: [{ id: 'invalid-owner-device', label: 'Invalid owner device', platform: 'windows', owner: 'not-an-email' }]
        })).rejects.toMatchObject({
            statusCode: 400,
            details: { code: 'onboarding_device_owner_required' }
        });
    });

    test('G3 reconciles the contracted estate while G2 verifies only the representative pilot', async () => {
        const maker = access('large-estate-maker@example.com', 'principal-large-estate-maker');
        const prepared = await prepareAcceptedCustomer(maker, 'large-estate');
        const master = customerMasterFixture();
        master.entitlements[0].quantity = 50;
        master.estate = { contractedUsers: 50, contractedEndpoints: 50, plannedDevices: 2 };
        master.externalRefs = [
            verifiedRef('hubspot', 'company', 'hubspot-company-large-estate'),
            verifiedRef('autotask', 'account', 'autotask-account-large-estate')
        ];

        let progress = await service.startCustomerOnboarding(maker, prepared.organisation.organisationId, {
            expectedRevision: prepared.revision,
            customerMaster: master,
            supportProfile: supportProfileFixture(),
            devices: [
                { id: 'pilot-device-one', label: 'Pilot Windows device', platform: 'windows', owner: 'installer@customer-one.example' },
                { id: 'pilot-device-two', label: 'Pilot Mac device', platform: 'macos', owner: 'installer@customer-one.example' }
            ]
        });
        expect(progress.organisation.context.endpoints.estimatedCount).toBe(50);
        expect(progress.organisation.customerMaster.estate).toMatchObject({
            contractedEndpoints: 50,
            plannedDevices: 2
        });

        const observedDevices = Array.from({ length: 50 }, (_, index) => ({
            deviceUid: `large-estate-datto-${String(index + 1).padStart(2, '0')}`,
            hostname: `large-estate-device-${String(index + 1).padStart(2, '0')}`,
            operatingSystem: index === 1 ? 'macOS' : 'Windows 11',
            lastSeen: current.toISOString(),
            online: true
        }));
        progress = await service.syncDattoRmmSnapshot(maker, prepared.organisation.organisationId, {
            expectedRevision: progress.revision,
            siteUid: 'site-large-estate',
            siteName: 'Large Estate Customer',
            deviceCount: 50,
            openAlertCount: 0,
            capturedAt: current.toISOString(),
            truncated: false,
            devices: observedDevices
        });
        expect(progress.organisation.integrations.dattoRmm).toMatchObject({
            deviceCount: 50,
            expectedDeviceCount: 50,
            reconciliationStatus: 'matched'
        });

        for (const [deviceId, providerDeviceUid] of [
            ['pilot-device-one', 'large-estate-datto-01'],
            ['pilot-device-two', 'large-estate-datto-02']
        ]) {
            progress = await service.matchOnboardingDevice(maker, prepared.organisation.organisationId, {
                expectedRevision: progress.revision,
                deviceId,
                providerDeviceUid,
                confirmMatch: true
            });
            for (const status of ['installer_ready', 'enrolled', 'verified']) {
                progress = await service.updateOnboardingDevice(maker, prepared.organisation.organisationId, {
                    expectedRevision: progress.revision,
                    deviceId,
                    status
                });
            }
        }

        expect(progress.organisation.onboarding.gates.find((gate) => gate.code === 'G2').status).toBe('complete');
        expect(progress.organisation.onboarding.gates.find((gate) => gate.code === 'G3').status).toBe('complete');
    });

    test('onboarding accepts only pre-verified governed crosswalks', async () => {
        const maker = access('maker@example.com', 'principal-maker');
        const prepared = await prepareAcceptedCustomer(maker, 'governed');
        const fabricatedMaster = customerMasterFixture();
        fabricatedMaster.externalRefs = [
            verifiedRef('hubspot', 'company', 'fabricated-hubspot-company'),
            verifiedRef('autotask', 'account', 'autotask-account-governed')
        ];

        await expect(service.startCustomerOnboarding(maker, prepared.organisation.organisationId, {
            expectedRevision: prepared.revision,
            customerMaster: fabricatedMaster,
            supportProfile: supportProfileFixture(),
            devices: [{ id: 'governed-device', label: 'Governed device', platform: 'windows', owner: 'installer@customer-one.example' }]
        })).rejects.toMatchObject({
            statusCode: 409,
            details: { code: 'external_reference_preverification_required' }
        });

        await expect(service.addExternalReference(maker, prepared.organisation.organisationId, {
            expectedRevision: prepared.revision,
            system: 'hubspot',
            recordType: 'company',
            externalId: 'provider-asserted-company',
            status: 'verified',
            verificationMode: 'provider',
            evidenceRef: 'provider-response:untrusted'
        })).rejects.toMatchObject({
            statusCode: 403,
            details: { code: 'external_reference_provider_verification_reserved' }
        });

        const providerMapped = await service.syncDattoRmmSnapshot(maker, prepared.organisation.organisationId, {
            expectedRevision: prepared.revision,
            siteUid: 'provider-managed-site',
            siteName: 'Provider-managed site',
            deviceCount: 0,
            openAlertCount: 0,
            capturedAt: current.toISOString(),
            devices: []
        });
        await expect(service.addExternalReference(maker, prepared.organisation.organisationId, {
            expectedRevision: providerMapped.revision,
            system: 'datto_rmm',
            recordType: 'site',
            externalId: 'provider-managed-site',
            status: 'verified',
            verificationMode: 'manual',
            evidenceRef: 'manual-override:not-allowed',
            confirmManuallyVerified: true
        })).rejects.toMatchObject({
            statusCode: 409,
            details: { code: 'external_reference_provider_managed' }
        });
    });

    test('evidence-bound customer and support changes retain prior versions and revoke pending activation', async () => {
        const maker = access('maker@example.com', 'principal-maker');
        const prepared = await prepareAcceptedCustomer(maker);
        const onboarding = await service.startCustomerOnboarding(maker, prepared.organisation.organisationId, {
            expectedRevision: prepared.revision,
            customerMaster: customerMasterFixture(),
            supportProfile: supportProfileFixture(),
            devices: [{ id: 'change-device', label: 'Change-control device', platform: 'windows', owner: 'installer@customer-one.example' }]
        });
        const injected = await repository.mutate(maker, {
            expectedRevision: onboarding.revision
        }, async (state) => {
            const organisation = state.organisations.find((item) => item.id === prepared.organisation.organisationId);
            organisation.activationRequests.push({
                id: 'activation-change-test',
                idempotencyKey: 'activate:change-test:v1',
                status: 'pending',
                planId: organisation.onboarding.planId,
                planRevision: organisation.onboarding.planRevision,
                payloadSha256: 'f'.repeat(64),
                maker: { principalId: 'principal-maker', email: 'maker@example.com', role: 'admin' },
                checker: {},
                executor: {},
                customerAuthorityRef: 'authority-register:change-test',
                reason: 'Test pending activation invalidation',
                createdAt: current.toISOString(),
                approvedAt: '',
                expiresAt: '2026-08-23T01:00:00.000Z',
                consumedAt: '',
                rejectedAt: '',
                revokedAt: ''
            });
            return organisation;
        });

        const supportProfile = supportProfileFixture();
        supportProfile.authorisedRequesters = [{
            name: 'Replacement Sponsor',
            email: 'replacement@customer-one.example',
            role: 'Sponsor',
            verificationMethod: 'Customer authority register',
            evidenceRef: 'authority-register:replacement-sponsor',
            effectiveFrom: current.toISOString(),
            canApproveRiskyActions: true
        }];
        await expect(service.updateSupportProfile(maker, prepared.organisation.organisationId, {
            supportProfile,
            reason: 'Customer replaced its authorised support requester',
            evidenceRef: 'change-register:support-profile-2',
            confirmChange: true
        })).rejects.toMatchObject({
            statusCode: 400,
            details: { code: 'expected_revision_required' }
        });
        const supportChanged = await service.updateSupportProfile(maker, prepared.organisation.organisationId, {
            expectedRevision: injected.state.revision,
            supportProfile,
            reason: 'Customer replaced its authorised support requester',
            evidenceRef: 'change-register:support-profile-2',
            confirmChange: true
        });
        expect(supportChanged.organisation).toMatchObject({
            supportProfile: {
                revision: 2,
                authorisedRequesters: [{ email: 'replacement@customer-one.example' }]
            },
            supportProfileHistory: [{
                revision: 1,
                evidenceRef: 'change-register:support-profile-2',
                snapshot: { authorisedRequesters: [{ email: 'sponsor@customer-one.example' }] }
            }],
            activationRequests: [{ id: 'activation-change-test', status: 'revoked' }]
        });
        const unchangedTimezoneState = await repository.read(maker);
        expect(unchangedTimezoneState.organisations
            .find((item) => item.id === prepared.organisation.organisationId)
            .proofRequirementLedger.find((entry) => entry.period === '2026-08')).toMatchObject({
            timezone: 'Pacific/Auckland',
            historyComplete: true
        });

        const customerMaster = customerMasterFixture();
        delete customerMaster.externalRefs;
        customerMaster.billing.profileId = 'billing-profile-two';
        await expect(service.updateCustomerMaster(maker, prepared.organisation.organisationId, {
            customerMaster,
            reason: 'Customer approved a replacement billing profile',
            evidenceRef: 'change-register:customer-master-2',
            confirmChange: true
        })).rejects.toMatchObject({
            statusCode: 400,
            details: { code: 'expected_revision_required' }
        });
        const masterChanged = await service.updateCustomerMaster(maker, prepared.organisation.organisationId, {
            expectedRevision: supportChanged.revision,
            customerMaster,
            reason: 'Customer approved a replacement billing profile',
            evidenceRef: 'change-register:customer-master-2',
            confirmChange: true
        });
        expect(masterChanged.organisation.customerMaster).toMatchObject({
            revision: expect.any(Number),
            billing: { profileId: 'billing-profile-two' },
            externalRefs: expect.arrayContaining([
                expect.objectContaining({ system: 'hubspot', externalId: 'hubspot-company-one' }),
                expect.objectContaining({ system: 'autotask', externalId: 'autotask-account-one' })
            ])
        });
        expect(masterChanged.organisation.customerMasterHistory).toHaveLength(1);
        expect(masterChanged.organisation.customerMasterHistory[0]).toMatchObject({
            evidenceRef: 'change-register:customer-master-2',
            snapshot: { billing: { profileId: 'billing-profile-one' } }
        });
    });

    test('singleton customer-system mappings require governed retirement before replacement', async () => {
        const maker = access('maker@example.com', 'principal-maker');
        const prepared = await prepareAcceptedCustomer(maker);
        await expect(service.addExternalReference(maker, prepared.organisation.organisationId, {
            expectedRevision: prepared.revision,
            system: 'hubspot',
            recordType: 'company',
            externalId: 'replacement-company',
            status: 'verified',
            verificationMode: 'manual',
            evidenceRef: 'crosswalk-register:replacement-company',
            confirmManuallyVerified: true
        })).rejects.toMatchObject({ details: { code: 'external_reference_slot_conflict' } });

        const retired = await service.addExternalReference(maker, prepared.organisation.organisationId, {
            expectedRevision: prepared.revision,
            system: 'hubspot',
            recordType: 'company',
            externalId: 'hubspot-company-one',
            status: 'retired',
            verificationMode: 'manual',
            evidenceRef: 'change-register:retire-company-one',
            retirementReason: 'Customer record was merged in HubSpot',
            confirmRetirement: true
        });
        const replaced = await service.addExternalReference(maker, prepared.organisation.organisationId, {
            expectedRevision: retired.revision,
            system: 'hubspot',
            recordType: 'company',
            externalId: 'replacement-company',
            status: 'verified',
            verificationMode: 'manual',
            evidenceRef: 'crosswalk-register:replacement-company',
            confirmManuallyVerified: true
        });
        expect(replaced.organisation.customerMaster.externalRefs).toEqual(expect.arrayContaining([
            expect.objectContaining({ externalId: 'hubspot-company-one', status: 'retired', retirementReason: 'Customer record was merged in HubSpot' }),
            expect.objectContaining({ externalId: 'replacement-company', status: 'verified' })
        ]));
    });

    test('service-desk admission fails closed when the current Datto snapshot no longer contains mapped device UIDs', async () => {
        const maker = access('maker@example.com', 'principal-maker');
        const active = await activateCustomer(
            maker,
            access('checker@example.com', 'principal-checker'),
            access('executor@example.com', 'principal-executor')
        );
        expect((await service.listServiceDeskCustomers(maker)).customers).toHaveLength(1);

        const drifted = await service.syncDattoRmmSnapshot(maker, active.organisation.organisationId, {
            expectedRevision: active.revision,
            siteUid: 'proof-site',
            siteName: 'Proof Site',
            deviceCount: 1,
            openAlertCount: 0,
            capturedAt: current.toISOString(),
            truncated: false,
            devices: [{
                deviceUid: 'replacement-datto-device',
                hostname: 'replacement-device',
                operatingSystem: 'Windows 11',
                lastSeen: current.toISOString(),
                online: true
            }]
        });
        expect(drifted.organisation.integrations.dattoRmm.reconciliationStatus).toBe('matched');
        expect((await service.listServiceDeskCustomers(maker)).customers).toEqual([]);
        await expect(service.requireServiceDeskCustomer(maker, active.organisation.organisationId)).rejects.toMatchObject({
            statusCode: 409,
            details: {
                code: 'customer_setup_incomplete',
                missing: expect.arrayContaining(['current_device_identity_reconciliation_required'])
            }
        });
    });

    test('resolves a portal contact only from one current verified same-scope lifecycle crosswalk', async () => {
        const maker = access('maker@example.com', 'principal-maker');
        const active = await activateCustomer(
            maker,
            access('checker@example.com', 'principal-checker'),
            access('executor@example.com', 'principal-executor')
        );
        const scopedAccount = Object.assign(verifiedRef('autotask', 'account', '10'), { providerScopeId: 'scope-one' });
        let injected = await repository.mutate(maker, { expectedRevision: active.revision, auditEvents: [] }, async (state) => {
            const organisation = state.organisations.find((item) => item.id === active.organisation.organisationId);
            organisation.customerMaster.externalRefs = organisation.customerMaster.externalRefs
                .filter((reference) => reference.system !== 'autotask')
                .concat(scopedAccount);
        });
        const boundService = createAppLifecycleService({
            repository,
            now: () => new Date(current),
            env: {
                NOFRIES_AUTOTASK_PROVIDER_SCOPE_ID: 'scope-one',
                NOFRIES_AUTOTASK_DEVICE_MAP_JSON: JSON.stringify({ '10:proof-datto-device': 99 })
            }
        });
        const admission = {
            requesterEmail: 'sponsor@customer-one.example',
            intakeChannel: 'portal',
            requesterVerificationMethod: 'Verified Microsoft identity',
            requesterVerificationRef: 'identity-register:sponsor',
            requireAutotaskContact: true,
            contactId: '20'
        };
        await expect(boundService.resolveServiceDeskProviderBinding(maker, active.organisation.organisationId, admission))
            .rejects.toMatchObject({ details: { code: 'autotask_contact_mapping_required' } });

        injected = await repository.mutate(maker, { expectedRevision: injected.state.revision, auditEvents: [] }, async (state) => {
            const organisation = state.organisations.find((item) => item.id === active.organisation.organisationId);
            organisation.customerMaster.externalRefs.push(Object.assign(verifiedRef('autotask', 'contact', '20'), {
                providerScopeId: 'scope-one'
            }));
        });
        await expect(boundService.resolveServiceDeskProviderBinding(maker, active.organisation.organisationId, admission))
            .resolves.toMatchObject({ companyId: '10', contactId: '20', providerScopeId: 'scope-one' });
        await expect(boundService.resolveServiceDeskProviderBinding(maker, active.organisation.organisationId, Object.assign({}, admission, {
            contactId: '21'
        }))).rejects.toMatchObject({ details: { code: 'autotask_contact_mapping_required' } });

        await repository.mutate(maker, { expectedRevision: injected.state.revision, auditEvents: [] }, async (state) => {
            const organisation = state.organisations.find((item) => item.id === active.organisation.organisationId);
            organisation.customerMaster.externalRefs.push(Object.assign(verifiedRef('autotask', 'contact', '20'), {
                id: 'duplicate-contact-crosswalk',
                providerScopeId: 'scope-one',
                evidenceRef: 'crosswalk-register:autotask:contact-20-duplicate'
            }));
        });
        await expect(boundService.resolveServiceDeskProviderBinding(maker, active.organisation.organisationId, admission))
            .rejects.toMatchObject({ details: { code: 'autotask_contact_mapping_required' } });
    });

    test('concurrent identical proof writes converge without duplicate evidence, audit, or revision changes', async () => {
        const maker = access('maker@example.com', 'principal-maker');
        const active = await activateCustomer(
            maker,
            access('checker@example.com', 'principal-checker'),
            access('executor@example.com', 'principal-executor')
        );
        current = new Date('2026-08-31T12:05:00.000Z');
        const startingState = await repository.read(maker);
        const startingRevision = startingState.revision;
        const startingAuditCount = startingState.audit.length;
        const organisationId = active.organisation.organisationId;

        const withoutRevision = proofEvidence('service_desk', undefined, {
            id: 'proof-new-without-revision',
            providerRecordId: 'proof-new-without-revision'
        });
        await expect(service.recordProofEvidence(maker, organisationId, withoutRevision)).rejects.toMatchObject({
            statusCode: 400,
            details: { code: 'expected_revision_required' }
        });

        const concurrentEvidence = proofEvidence('service_desk', startingRevision, {
            id: 'proof-concurrent-service-desk',
            providerRecordId: 'proof-concurrent-service-desk',
            evidenceRef: 'evidence-register:service-desk:concurrent:2026-08',
            checksum: canonicalSourceHash('proof-concurrent-service-desk'),
            facts: [{ key: 'tickets.resolved', value: '12', unit: 'tickets' }]
        });
        const results = await Promise.all([
            service.recordProofEvidence(maker, organisationId, concurrentEvidence),
            service.recordProofEvidence(maker, organisationId, Object.assign({}, concurrentEvidence))
        ]);

        expect(results.map((item) => item.created).sort()).toEqual([false, true]);
        expect(results[0].revision).toBe(results[1].revision);
        const convergedState = await repository.read(maker);
        expect(convergedState.revision).toBe(startingRevision + 1);
        expect(convergedState.audit).toHaveLength(startingAuditCount + 1);
        const proof = convergedState.organisations
            .find((item) => item.id === organisationId)
            .proofPeriods.find((item) => item.period === '2026-08');
        expect(proof.evidenceRefs.filter((item) => item.id === 'proof-concurrent-service-desk')).toHaveLength(1);

        await expect(service.recordProofEvidence(maker, organisationId, Object.assign({}, concurrentEvidence, {
            expectedRevision: convergedState.revision,
            checksum: canonicalSourceHash('different-concurrent-service-desk')
        }))).rejects.toMatchObject({ details: { code: 'proof_evidence_idempotency_conflict' } });
        const afterConflict = await repository.read(maker);
        expect(afterConflict.revision).toBe(convergedState.revision);
        expect(afterConflict.audit).toHaveLength(convergedState.audit.length);
    });

    test('proof remains blocked by incomplete sources and internal scheduler is deterministic', async () => {
        const maker = access('maker@example.com', 'principal-maker');
        const checker = access('checker@example.com', 'principal-checker');
        const executor = access('executor@example.com', 'principal-executor');
        const active = await activateCustomer(maker, checker, executor);
        current = new Date('2026-08-31T12:05:00.000Z');
        let revision = active.revision;

        const bootstrap = await service.bootstrap(maker);
        expect(bootstrap.customerControls.schedules.find((item) => (
            item.organisationId === active.organisation.organisationId && item.jobType === 'monthly_proof'
        )).requiredSources).toEqual(BASE_PROOF_SOURCES);

        const stateBeforeRejectedEvidence = await repository.read(maker);
        const maliciousEvidence = [
            { id: 'sk-proj-abcdefghijklmnop' },
            { id: 'proof-sensitive-category', category: 'Basic dXNlcjpwYXNz' },
            { id: 'proof-sensitive-basic-punctuation', category: 'Basic dXNlcjpwYXNz.)]' },
            {
                id: 'proof-sensitive-five-layer-encoding',
                category: 'sk%252525252Dproj%252525252Dabcdefghijklmnop'
            },
            { id: 'proof-sensitive-oversized-basic', category: `Basic ${'A'.repeat(501)}` },
            {
                id: 'proof-sensitive-malformed-percent-decoy',
                category: 'monthly%ZZ-sk%252Dproj%252Dabcdefghijklmnop'
            },
            {
                id: 'proof-sensitive-provider-record',
                providerRecordId: Buffer.from('Bearer abcdefghijklmnop').toString('base64')
            },
            { id: 'proof-sensitive-fact', facts: [{ key: 'connector.value', value: 'sk-proj-abcdefghijklmnop' }] },
            { id: 'proof-sensitive-split-field', facts: [{ key: 'password', value: 'abcdefghijklmnop' }] },
            {
                id: 'proof-sensitive-nested-name',
                facts: [{ key: 'backup.password.value', label: 'Backup password value', value: 'correct-horse-battery-staple' }]
            },
            {
                id: 'proof-sensitive-label-name',
                facts: [{ key: 'backup.metric', label: 'Backup secret value', value: 'correct-horse-battery-staple' }]
            },
            {
                id: 'proof-sensitive-embedded-base64',
                category: `Evidence ${Buffer.from('Bearer abcdefghijklmnop').toString('base64')} monthly`
            },
            {
                id: 'proof-sensitive-folded-base64',
                category: `Evidence ${Buffer.from('{"api_key":"abcdefghijklmnop"}').toString('base64')
                    .match(/.{1,4}/g).join(' ')} monthly`
            },
            ...[12, 13, 16, 18, 64, 76, 93, 97, 101, 117].map((width) => ({
                id: `proof-sensitive-folded-base64-${width}`,
                facts: [{
                    key: 'connector.note',
                    value: `Normal monthly evidence ${'observationalcontext'.padEnd(width, 'x').slice(0, width)} ${foldBase64(
                        `{"api_key":"${'k'.repeat(120)}"}`,
                        width
                    )} summary`
                }]
            })),
            ...[
                ['5-rest', foldBase64Uneven('Bearer abcdefghijklmnop', [5])],
                ['3-17-rest', foldBase64Uneven('Bearer abcdefghijklmnop', [3, 17])],
                ['random-widths', foldBase64Uneven(`{"api_key":"${'k'.repeat(120)}"}`, [7, 2, 19, 4, 11, 23])]
            ].map(([label, value]) => ({
                id: `proof-sensitive-folded-base64-${label}`,
                facts: [{ key: 'connector.note', value: `Normal monthly evidence ${value} summary` }]
            })),
            { id: 'proof-sensitive-reference-token', evidenceRef: 'https://vendor.example/evidence?token=abcdefghijklmnop' },
            { id: 'proof-sensitive-reference-relative', evidenceRef: '/evidence?sig=abcdefghijklmnop' },
            { id: 'proof-sensitive-reference-encoded', evidenceRef: '%252Fevidence%253Ftoken%253Dabcdefghijklmnop' },
            { id: 'proof-sensitive-reference-basic', evidenceRef: 'Basic dXNlcjpwYXNzd29yZA==' }
        ];
        for (const attack of maliciousEvidence) {
            await expect(service.recordProofEvidence(maker, active.organisation.organisationId, proofEvidence(
                'service_desk',
                revision,
                attack
            ))).rejects.toMatchObject({ details: { code: 'proof_evidence_sensitive_data' } });
        }
        const stateAfterRejectedEvidence = await repository.read(maker);
        expect(stateAfterRejectedEvidence.revision).toBe(stateBeforeRejectedEvidence.revision);
        expect(stateAfterRejectedEvidence.audit).toHaveLength(stateBeforeRejectedEvidence.audit.length);
        const rejectedProof = stateAfterRejectedEvidence.organisations
            .find((item) => item.id === active.organisation.organisationId)
            .proofPeriods.find((item) => item.period === '2026-08');
        expect(rejectedProof ? rejectedProof.evidenceRefs : []).toEqual([]);

        await expect(service.recordProofEvidence(maker, active.organisation.organisationId, proofEvidence('service_desk', revision, {
            id: 'proof-wrong-coverage',
            periodStart: '2026-04-30T12:00:00.000Z',
            periodEnd: '2026-05-31T11:59:59.999Z',
            facts: [{ key: 'tickets.total', value: '99' }]
        }))).rejects.toMatchObject({ details: { code: 'proof_evidence_period_coverage_required' } });
        await expect(service.recordProofEvidence(maker, active.organisation.organisationId, proofEvidence('service_desk', revision, {
            id: 'proof-missing-coverage',
            periodStart: '',
            periodEnd: ''
        }))).rejects.toMatchObject({ details: { code: 'proof_evidence_period_coverage_required' } });
        const stateAfterWrongCoverage = await repository.read(maker);
        expect(stateAfterWrongCoverage.revision).toBe(revision);
        expect(stateAfterWrongCoverage.audit).toHaveLength(stateBeforeRejectedEvidence.audit.length);

        let evidence = await service.recordProofEvidence(maker, active.organisation.organisationId, proofEvidence('service_desk', revision, {
            sourceMode: 'simulated',
            periodStart: '2026-07-01T00:00:00.000Z',
            periodEnd: '2026-09-01T00:00:00.000Z',
            facts: [{ key: 'tickets.total', label: 'Ticket total', value: '99', status: 'informational' }]
        }));
        revision = evidence.revision;
        const auditAfterFirstEvidence = (await repository.read(maker)).audit.length;
        const evidenceReplay = await service.recordProofEvidence(maker, active.organisation.organisationId, proofEvidence('service_desk', revision, {
            sourceMode: 'simulated',
            periodStart: '2026-07-01T00:00:00.000Z',
            periodEnd: '2026-09-01T00:00:00.000Z',
            facts: [{ key: 'tickets.total', label: 'Ticket total', value: '99', status: 'informational' }]
        }));
        expect(evidenceReplay.created).toBe(false);
        expect(evidenceReplay.revision).toBe(revision);
        expect((await repository.read(maker)).audit).toHaveLength(auditAfterFirstEvidence);
        expect(evidenceReplay.proof.narrativeGroundwork.sections.find((item) => item.source === 'service_desk')).toMatchObject({
            state: 'simulated',
            claims: [],
            diagnostics: [expect.objectContaining({ code: 'evidence_simulated' })]
        });
        revision = evidenceReplay.revision;
        await expect(service.recordProofEvidence(maker, active.organisation.organisationId, proofEvidence('service_desk', revision, {
            sourceMode: 'simulated',
            periodStart: '2026-07-01T00:00:00.000Z',
            periodEnd: '2026-09-01T00:00:00.000Z',
            checksum: canonicalSourceHash('different-service-desk-record')
        }))).rejects.toMatchObject({ details: { code: 'proof_evidence_idempotency_conflict' } });

        const derivedExpectedRevision = revision;
        const derivedInput = proofEvidence('risk', derivedExpectedRevision, {
            id: '',
            sourceMode: 'simulated',
            providerRecordId: 'risk-derived-record',
            evidenceRef: 'evidence-register:risk:derived:2026-08',
            checksum: canonicalSourceHash('risk-derived-record')
        });
        const derivedEvidence = await service.recordProofEvidence(maker, active.organisation.organisationId, derivedInput);
        expect(derivedEvidence.created).toBe(true);
        const derivedId = derivedEvidence.proof.evidenceRefs.find((item) => item.providerRecordId === 'risk-derived-record').id;
        expect(derivedId).toMatch(/^proof_evidence_[a-f0-9]{40}$/);
        const derivedReplay = await service.recordProofEvidence(maker, active.organisation.organisationId, Object.assign({}, derivedInput, {
            expectedRevision: derivedExpectedRevision
        }));
        expect(derivedReplay).toMatchObject({ created: false, revision: derivedEvidence.revision });
        revision = derivedEvidence.revision;
        await expect(service.approveCustomerProof(checker, active.organisation.organisationId, {
            expectedRevision: revision,
            period: '2026-08',
            confirmComplete: true
        })).rejects.toMatchObject({ details: { code: 'proof_readiness_incomplete' } });

        for (const source of BASE_PROOF_SOURCES) {
            evidence = await service.recordProofEvidence(maker, active.organisation.organisationId, proofEvidence(source, revision, {
                id: `proof-${source}-live`,
                sourceMode: 'manual',
                facts: [proofMetricFact(source)]
            }));
            revision = evidence.revision;
        }
        const approved = await service.approveCustomerProof(checker, active.organisation.organisationId, {
            expectedRevision: revision,
            period: '2026-08',
            confirmComplete: true
        });
        expect(approved.proof.status).toBe('approved');
        expect(approved.proof.narrativeGroundwork).toMatchObject({
            readyForDraft: true,
            readyForApproval: true,
            missingEvidence: [],
            missingFacts: []
        });
        expect(approved.proof.narrativeGroundwork.sections).toHaveLength(BASE_PROOF_SOURCES.length);
        expect(approved.proof.narrativeGroundwork.sections[0].claims[0]).toMatchObject({
            evidenceId: expect.any(String),
            evidenceRef: expect.any(String),
            value: '1'
        });
        await expect(service.recordProofEvidence(maker, active.organisation.organisationId, proofEvidence('risk', approved.revision, {
            id: 'proof-risk-after-approval',
            facts: [{ key: 'risk.changed', value: 'Changed after approval' }]
        }))).rejects.toMatchObject({ details: { code: 'proof_period_immutable' } });
        await expect(service.approveCustomerProof(checker, active.organisation.organisationId, {
            expectedRevision: approved.revision,
            period: '2026-08',
            confirmComplete: true
        })).rejects.toMatchObject({ details: { code: 'proof_period_immutable' } });

        current = new Date('2026-09-25T01:00:00.000Z');
        const controls = await service.runCustomerControls(maker, {
            expectedRevision: approved.revision,
            scheduledFor: current.toISOString(),
            confirmInternalOnly: true
        });
        expect(controls.externalWrites).toBe(false);
        expect(controls.generated.length).toBe(4);
        const replay = await service.runCustomerControls(maker, {
            expectedRevision: controls.revision,
            scheduledFor: current.toISOString(),
            confirmInternalOnly: true
        });
        expect(replay.generated).toEqual([]);
    });

    test('Proof evidence and approval fail closed until the canonical local month ends', async () => {
        const maker = access('proof-close-maker@example.com', 'principal-proof-close-maker');
        const checker = access('proof-close-checker@example.com', 'principal-proof-close-checker');
        const active = await activateCustomer(
            maker,
            checker,
            access('proof-close-executor@example.com', 'principal-proof-close-executor')
        );
        const organisationId = active.organisation.organisationId;
        const fullMonthEvidence = (expectedRevision) => ({
            expectedRevision,
            id: 'proof-close-service-desk',
            period: '2026-08',
            source: 'service_desk',
            category: 'service_desk_monthly_evidence',
            sourceMode: 'manual',
            providerRecordId: 'service-desk-close-record',
            evidenceRef: 'evidence-register:service-desk:close:2026-08',
            checksum: canonicalSourceHash('proof-close-service-desk'),
            periodStart: '2026-07-31T12:00:00.000Z',
            periodEnd: '2026-08-31T11:59:59.999Z',
            capturedAt: current.toISOString(),
            freshUntil: '2026-10-01T00:00:00.000Z'
        });

        const beforeEarlyWrite = await repository.read(maker);
        await expect(service.recordProofEvidence(
            maker,
            organisationId,
            fullMonthEvidence(beforeEarlyWrite.revision)
        )).rejects.toMatchObject({ details: { code: 'proof_evidence_period_not_closed' } });
        const afterEarlyWrite = await repository.read(maker);
        expect(afterEarlyWrite.revision).toBe(beforeEarlyWrite.revision);
        expect(afterEarlyWrite.audit).toHaveLength(beforeEarlyWrite.audit.length);
        expect(afterEarlyWrite.organisations.find((item) => item.id === organisationId).proofPeriods).toHaveLength(0);

        // Capture/ingestion accepts only the explicit five-minute clock-skew window;
        // approval itself remains impossible until the canonical instant has passed.
        current = new Date('2026-08-31T11:56:30.000Z');
        const acceptedAtTolerance = await service.recordProofEvidence(
            maker,
            organisationId,
            fullMonthEvidence(afterEarlyWrite.revision)
        );
        expect(acceptedAtTolerance.created).toBe(true);
        expect(acceptedAtTolerance.proof.readiness).toMatchObject({
            ready: false,
            missing: expect.arrayContaining(['service_desk:period_open'])
        });
        const beforeApproval = await repository.read(maker);
        await expect(service.approveCustomerProof(checker, organisationId, {
            expectedRevision: acceptedAtTolerance.revision,
            period: '2026-08',
            confirmComplete: true
        })).rejects.toMatchObject({ details: { code: 'proof_period_not_closed' } });
        const afterApproval = await repository.read(maker);
        expect(afterApproval.revision).toBe(beforeApproval.revision);
        expect(afterApproval.audit).toHaveLength(beforeApproval.audit.length);
    });

    test('omitted Proof GETs use the last completed month while mutations require an explicit period and revision', async () => {
        const maker = access('proof-default-maker@example.com', 'principal-proof-default-maker');
        const checker = access('proof-default-checker@example.com', 'principal-proof-default-checker');
        const active = await activateCustomer(
            maker,
            checker,
            access('proof-default-executor@example.com', 'principal-proof-default-executor')
        );
        const organisationId = active.organisation.organisationId;
        current = new Date('2026-09-25T01:00:00.000Z');

        const view = await service.getCustomerProof(maker, organisationId, {});
        expect(view.proof).toMatchObject({
            period: '2026-08',
            timezone: 'Pacific/Auckland',
            coverage: {
                periodStart: '2026-07-31T12:00:00.000Z',
                periodEnd: '2026-08-31T11:59:59.999Z'
            }
        });

        const beforeRejectedMutations = await repository.read(maker);
        await expect(service.recordProofEvidence(maker, organisationId, proofEvidence(
            'service_desk',
            view.revision,
            {
                id: 'proof-default-auckland-service-desk',
                period: undefined,
                providerRecordId: 'proof-default-auckland-service-desk',
                evidenceRef: 'evidence-register:service-desk:default:2026-08',
                checksum: canonicalSourceHash('proof-default-auckland-service-desk'),
                capturedAt: current.toISOString(),
                freshUntil: '2026-11-01T00:00:00.000Z'
            }
        ))).rejects.toMatchObject({ details: { code: 'proof_period_required' } });

        await expect(service.approveCustomerProof(checker, organisationId, {
            expectedRevision: view.revision,
            confirmComplete: true
        })).rejects.toMatchObject({ details: { code: 'proof_period_required' } });
        await expect(service.approveCustomerProof(checker, organisationId, {
            period: '2026-08',
            confirmComplete: true
        })).rejects.toMatchObject({ details: { code: 'expected_revision_required' } });
        const afterRejectedMutations = await repository.read(maker);
        expect(afterRejectedMutations.revision).toBe(beforeRejectedMutations.revision);
        expect(afterRejectedMutations.audit).toHaveLength(beforeRejectedMutations.audit.length);
        expect(afterRejectedMutations.organisations
            .find((item) => item.id === organisationId).proofPeriods).toEqual([]);

        for (const invalidPeriod of [
            '2026-08-31',
            '2026-08junk',
            '0000-01',
            '9999-12',
            ['2026-08', '2026-09']
        ]) {
            await expect(service.getCustomerProof(maker, organisationId, {
                period: invalidPeriod
            })).rejects.toMatchObject({ details: { code: 'proof_period_invalid' } });
            await expect(service.recordProofEvidence(maker, organisationId, proofEvidence(
                'service_desk',
                view.revision,
                { period: invalidPeriod }
            ))).rejects.toMatchObject({ details: { code: 'proof_period_invalid' } });
            await expect(service.approveCustomerProof(checker, organisationId, {
                expectedRevision: view.revision,
                period: invalidPeriod,
                confirmComplete: true
            })).rejects.toMatchObject({ details: { code: 'proof_period_invalid' } });
        }
        expect((await service.getCustomerProof(maker, organisationId, {
            period: '2026-08'
        })).proof.period).toBe('2026-08');
        const afterInvalidPeriods = await repository.read(maker);
        expect(afterInvalidPeriods.revision).toBe(beforeRejectedMutations.revision);
        expect(afterInvalidPeriods.audit).toHaveLength(beforeRejectedMutations.audit.length);

        current = new Date('2027-01-15T01:00:00.000Z');
        const januaryView = await service.getCustomerProof(maker, organisationId, {});
        expect(januaryView.proof).toMatchObject({
            period: '2026-12',
            timezone: 'Pacific/Auckland'
        });
    });

    test('omitted Proof GETs respect the exact customer-local month boundary', async () => {
        const maker = access('proof-la-maker@example.com', 'principal-proof-la-maker');
        const active = await activateCustomer(
            maker,
            access('proof-la-checker@example.com', 'principal-proof-la-checker'),
            access('proof-la-executor@example.com', 'principal-proof-la-executor'),
            { timezone: 'America/Los_Angeles' }
        );
        const organisationId = active.organisation.organisationId;
        current = new Date('2026-09-01T06:59:59.999Z');

        const view = await service.getCustomerProof(maker, organisationId, {});
        expect(view.proof).toMatchObject({
            period: '2026-07',
            timezone: 'America/Los_Angeles',
            coverage: {
                periodStart: '2026-07-01T07:00:00.000Z',
                periodEnd: '2026-08-01T06:59:59.999Z'
            }
        });

        const explicitInput = proofEvidence('service_desk', view.revision, {
            id: 'proof-explicit-la-service-desk',
            period: '2026-07',
            providerRecordId: 'proof-explicit-la-service-desk',
            evidenceRef: 'evidence-register:service-desk:explicit:2026-07',
            checksum: canonicalSourceHash('proof-explicit-la-service-desk'),
            periodStart: '2026-07-01T07:00:00.000Z',
            periodEnd: '2026-09-01T06:59:59.999Z',
            capturedAt: current.toISOString(),
            freshUntil: '2026-10-15T00:00:00.000Z'
        });
        const recorded = await service.recordProofEvidence(maker, organisationId, explicitInput);
        expect(recorded).toMatchObject({
            created: true,
            proof: { period: '2026-07', timezone: 'America/Los_Angeles' }
        });
        const afterRecorded = await repository.read(maker);

        current = new Date('2026-09-01T07:00:00.000Z');
        const replay = await service.recordProofEvidence(maker, organisationId, explicitInput);
        expect(replay).toMatchObject({ created: false, revision: recorded.revision });
        const afterReplay = await repository.read(maker);
        expect(afterReplay.revision).toBe(afterRecorded.revision);
        expect(afterReplay.audit).toHaveLength(afterRecorded.audit.length);
        expect(afterReplay.organisations.find((item) => item.id === organisationId)
            .proofPeriods.map((item) => item.period)).toEqual(['2026-07']);

        const nextView = await service.getCustomerProof(maker, organisationId, {});
        expect(nextView.proof).toMatchObject({
            period: '2026-08',
            timezone: 'America/Los_Angeles',
            coverage: {
                periodStart: '2026-08-01T07:00:00.000Z',
                periodEnd: '2026-09-01T06:59:59.999Z'
            }
        });
    });

    test('customer-master entitlement overflow rejects new input and legacy overflow blocks Proof', async () => {
        const maker = access('proof-master-limit-maker@example.com', 'principal-proof-master-limit-maker');
        const checker = access('proof-master-limit-checker@example.com', 'principal-proof-master-limit-checker');
        const active = await activateCustomer(
            maker,
            checker,
            access('proof-master-limit-executor@example.com', 'principal-proof-master-limit-executor')
        );
        const organisationId = active.organisation.organisationId;
        const overflowMaster = customerMasterFixture();
        delete overflowMaster.externalRefs;
        overflowMaster.entitlements = Array.from({ length: 100 }, (_, index) => ({
            code: `managed_endpoint_${index}`,
            name: `Managed endpoint ${index}`,
            quantity: 1,
            effectiveFrom: '2026-08-01T00:00:00.000Z'
        })).concat({
            code: 'endpoint_security',
            name: 'Endpoint security',
            quantity: 1,
            effectiveFrom: '2026-08-01T00:00:00.000Z'
        });
        const beforeRejectedUpdate = await repository.read(maker);
        await expect(service.updateCustomerMaster(maker, organisationId, {
            expectedRevision: active.revision,
            customerMaster: overflowMaster,
            reason: 'Attempt an oversized master replacement',
            evidenceRef: 'change-register:customer-master:oversized',
            confirmChange: true
        })).rejects.toMatchObject({
            details: {
                code: 'customer_master_entitlement_limit_exceeded',
                maximumEntitlements: 100,
                submittedEntitlements: 101
            }
        });
        const afterRejectedUpdate = await repository.read(maker);
        expect(afterRejectedUpdate.revision).toBe(beforeRejectedUpdate.revision);
        expect(afterRejectedUpdate.audit).toHaveLength(beforeRejectedUpdate.audit.length);
        expect(afterRejectedUpdate.organisations.find((item) => item.id === organisationId).customerMaster.entitlementsOverflow).toBe(false);

        await repository.mutate(maker, { expectedRevision: afterRejectedUpdate.revision, auditEvents: [] }, async (state) => {
            state.organisations.find((item) => item.id === organisationId).customerMaster.entitlements = overflowMaster.entitlements;
        });
        let progress = await repository.read(maker);
        expect(progress.organisations.find((item) => item.id === organisationId).customerMaster).toMatchObject({
            entitlementsOverflow: true,
            entitlements: expect.not.arrayContaining([expect.objectContaining({ code: 'endpoint_security' })])
        });
        current = new Date('2026-08-31T12:05:00.000Z');
        for (const source of BASE_PROOF_SOURCES) {
            progress = await service.recordProofEvidence(maker, organisationId, proofEvidence(source, progress.revision, {
                id: `proof-master-overflow-${source}`
            }));
        }
        const view = await service.getCustomerProof(maker, organisationId, { period: '2026-08' });
        expect(view.proof).toMatchObject({
            entitlementCodesOverflow: true,
            requirementHistoryComplete: false,
            readiness: { ready: false, missing: expect.arrayContaining(['requirement_history:incomplete']) }
        });
        const beforeApproval = await repository.read(maker);
        await expect(service.approveCustomerProof(checker, organisationId, {
            expectedRevision: progress.revision,
            period: '2026-08',
            confirmComplete: true
        })).rejects.toMatchObject({
            details: { code: 'proof_requirement_history_incomplete', entitlementCodesOverflow: true }
        });
        const afterApproval = await repository.read(maker);
        expect(afterApproval.revision).toBe(beforeApproval.revision);
        expect(afterApproval.audit).toHaveLength(beforeApproval.audit.length);
    });

    test('a full Proof period rejects unique evidence without evicting required-source evidence', async () => {
        const maker = access('proof-evidence-limit-maker@example.com', 'principal-proof-evidence-limit-maker');
        const checker = access('proof-evidence-limit-checker@example.com', 'principal-proof-evidence-limit-checker');
        const active = await activateCustomer(
            maker,
            checker,
            access('proof-evidence-limit-executor@example.com', 'principal-proof-evidence-limit-executor')
        );
        const organisationId = active.organisation.organisationId;
        current = new Date('2026-08-31T12:05:00.000Z');
        const victimInput = proofEvidence('service_desk', active.revision, { id: 'proof-sole-required-source' });
        const seededEvidence = normaliseProofEvidence([Object.assign({}, victimInput, {
            ingestedAt: current.toISOString(),
            recordedBy: maker.user.email
        })]).concat(Array.from({ length: 499 }, (_, index) => normaliseProofEvidence([{
            id: `proof-flood-${index}`,
            source: 'risk',
            category: 'risk_monthly_evidence',
            sourceMode: 'manual',
            providerRecordId: `risk-flood-${index}`,
            evidenceRef: `evidence-register:risk:flood:${index}`,
            checksum: canonicalSourceHash(`risk-flood-${index}`),
            periodStart: '2026-07-31T12:00:00.000Z',
            periodEnd: '2026-08-31T11:59:59.999Z',
            capturedAt: current.toISOString(),
            ingestedAt: current.toISOString(),
            freshUntil: '2026-10-01T00:00:00.000Z',
            recordedBy: maker.user.email
        }])[0]));
        expect(seededEvidence).toHaveLength(500);
        await repository.mutate(maker, { expectedRevision: active.revision, auditEvents: [] }, async (state) => {
            const organisation = state.organisations.find((item) => item.id === organisationId);
            organisation.proofPeriods.push({
                id: `proof_${organisationId}_2026-08`,
                customerId: organisation.customerMaster.customerId,
                period: '2026-08',
                timezone: 'Pacific/Auckland',
                status: 'collecting',
                requiredSources: BASE_PROOF_SOURCES,
                evidenceRefs: seededEvidence,
                createdAt: current.toISOString(),
                updatedAt: current.toISOString()
            });
        });
        const before = await repository.read(maker);
        await expect(service.recordProofEvidence(maker, organisationId, proofEvidence('risk', before.revision, {
            id: 'proof-unique-over-capacity',
            providerRecordId: 'risk-unique-over-capacity',
            evidenceRef: 'evidence-register:risk:unique-over-capacity',
            checksum: canonicalSourceHash('risk-unique-over-capacity')
        }))).rejects.toMatchObject({
            details: { code: 'proof_evidence_capacity_exceeded', maximumEvidence: 500 }
        });
        const afterRejected = await repository.read(maker);
        const afterRejectedProof = afterRejected.organisations.find((item) => item.id === organisationId)
            .proofPeriods.find((item) => item.period === '2026-08');
        expect(afterRejected.revision).toBe(before.revision);
        expect(afterRejected.audit).toHaveLength(before.audit.length);
        expect(afterRejectedProof.evidenceRefs).toHaveLength(500);
        expect(afterRejectedProof.evidenceRefs).toContainEqual(expect.objectContaining({
            id: 'proof-sole-required-source',
            source: 'service_desk'
        }));

        const retry = await service.recordProofEvidence(maker, organisationId, Object.assign({}, victimInput, {
            expectedRevision: active.revision
        }));
        expect(retry).toMatchObject({ created: false, revision: afterRejected.revision });
        const afterRetry = await repository.read(maker);
        expect(afterRetry.revision).toBe(afterRejected.revision);
        expect(afterRetry.audit).toHaveLength(afterRejected.audit.length);

        const julyCoverage = {
            periodStart: '2026-06-30T12:00:00.000Z',
            periodEnd: '2026-07-31T11:59:59.999Z'
        };
        const legacyEvidence = BASE_PROOF_SOURCES.map((source) => ({
            id: `proof-legacy-july-${source}`,
            source,
            category: `${source}_monthly_evidence`,
            sourceMode: 'manual',
            providerRecordId: `legacy-july-${source}`,
            evidenceRef: `evidence-register:${source}:legacy-july`,
            checksum: canonicalSourceHash(`legacy-july-${source}`),
            ...julyCoverage,
            capturedAt: current.toISOString(),
            ingestedAt: current.toISOString(),
            freshUntil: '2026-10-01T00:00:00.000Z',
            recordedBy: maker.user.email
        })).concat(Array.from({ length: 495 }, (_, index) => ({
            id: `proof-legacy-july-flood-${index}`,
            source: 'risk',
            category: 'risk_monthly_evidence',
            sourceMode: 'manual',
            providerRecordId: `legacy-july-flood-${index}`,
            evidenceRef: `evidence-register:risk:legacy-july:${index}`,
            checksum: canonicalSourceHash(`legacy-july-flood-${index}`),
            ...julyCoverage,
            capturedAt: current.toISOString(),
            ingestedAt: current.toISOString(),
            freshUntil: '2026-10-01T00:00:00.000Z',
            recordedBy: maker.user.email
        })));
        expect(legacyEvidence).toHaveLength(501);
        await repository.mutate(maker, { expectedRevision: afterRetry.revision, auditEvents: [] }, async (state) => {
            const organisation = state.organisations.find((item) => item.id === organisationId);
            organisation.proofPeriods.push({
                id: `proof_${organisationId}_2026-07`,
                customerId: organisation.customerMaster.customerId,
                period: '2026-07',
                timezone: 'Pacific/Auckland',
                status: 'ready',
                requiredSources: BASE_PROOF_SOURCES,
                evidenceRefs: legacyEvidence,
                createdAt: current.toISOString(),
                updatedAt: current.toISOString()
            });
        });
        const beforeLegacyApproval = await repository.read(maker);
        const legacyProof = beforeLegacyApproval.organisations.find((item) => item.id === organisationId)
            .proofPeriods.find((item) => item.period === '2026-07');
        expect(legacyProof).toMatchObject({ evidenceRefsOverflow: true });
        expect(legacyProof.evidenceRefs).toHaveLength(500);
        for (const source of BASE_PROOF_SOURCES) {
            expect(legacyProof.evidenceRefs).toContainEqual(expect.objectContaining({ source }));
        }
        const legacyView = await service.getCustomerProof(maker, organisationId, { period: '2026-07' });
        expect(legacyView.proof.readiness).toMatchObject({
            ready: false,
            missing: expect.arrayContaining(['evidence_history:overflow'])
        });
        await expect(service.approveCustomerProof(checker, organisationId, {
            expectedRevision: beforeLegacyApproval.revision,
            period: '2026-07',
            confirmComplete: true
        })).rejects.toMatchObject({
            details: { code: 'proof_readiness_incomplete', missing: expect.arrayContaining(['evidence_history:overflow']) }
        });
        const afterLegacyApproval = await repository.read(maker);
        expect(afterLegacyApproval.revision).toBe(beforeLegacyApproval.revision);
        expect(afterLegacyApproval.audit).toHaveLength(beforeLegacyApproval.audit.length);
    });

    test('persisted evidence from another month cannot approve a Proof or generate claims', async () => {
        const maker = access('proof-period-maker@example.com', 'principal-proof-period-maker');
        const checker = access('proof-period-checker@example.com', 'principal-proof-period-checker');
        const active = await activateCustomer(
            maker,
            checker,
            access('proof-period-executor@example.com', 'principal-proof-period-executor')
        );
        const organisationId = active.organisation.organisationId;
        current = new Date('2026-08-31T12:05:00.000Z');
        await repository.mutate(maker, { expectedRevision: active.revision, auditEvents: [] }, async (state) => {
            const organisation = state.organisations.find((item) => item.id === organisationId);
            organisation.proofPeriods.push({
                id: `proof_${organisationId}_2026-08`,
                customerId: organisation.customerMaster.customerId,
                period: '2026-08',
                timezone: 'Pacific/Auckland',
                status: 'ready',
                requiredSources: BASE_PROOF_SOURCES,
                evidenceRefs: BASE_PROOF_SOURCES.map((source) => ({
                    id: `proof-wrong-month-${source}`,
                    source,
                    category: `${source}_monthly_evidence`,
                    sourceMode: 'manual',
                    providerRecordId: `${source}-may-record`,
                    evidenceRef: `evidence-register:${source}:2026-05`,
                    checksum: canonicalSourceHash(`wrong-month-${source}`),
                    periodStart: '2026-04-30T12:00:00.000Z',
                    periodEnd: '2026-05-31T11:59:59.999Z',
                    capturedAt: '2026-08-20T00:00:00.000Z',
                    ingestedAt: '2026-08-20T00:00:00.000Z',
                    freshUntil: '2026-10-01T00:00:00.000Z',
                    recordedBy: maker.user.email,
                    facts: [{ key: `${source}.status`, label: `${source} status`, value: 'Healthy', status: 'positive' }]
                })),
                createdAt: '2026-08-20T00:00:00.000Z',
                updatedAt: '2026-08-20T00:00:00.000Z'
            });
        });

        const before = await repository.read(maker);
        const view = await service.getCustomerProof(maker, organisationId, { period: '2026-08' });
        expect(view.proof.readiness).toMatchObject({
            ready: false,
            missing: expect.arrayContaining(BASE_PROOF_SOURCES.map((source) => `${source}:coverage_mismatch`))
        });
        expect(view.proof.narrativeGroundwork.sections.every((section) => section.claims.length === 0)).toBe(true);
        await expect(service.approveCustomerProof(checker, organisationId, {
            expectedRevision: before.revision,
            period: '2026-08',
            confirmComplete: true
        })).rejects.toMatchObject({
            details: { code: 'proof_readiness_incomplete', missing: expect.arrayContaining(['service_desk:coverage_mismatch']) }
        });
        const after = await repository.read(maker);
        expect(after.revision).toBe(before.revision);
        expect(after.audit).toHaveLength(before.audit.length);
    });

    test('writer flooding cannot evict approved Proof history or grow open periods beyond the boundary', async () => {
        const maker = access('proof-retention-maker@example.com', 'principal-proof-retention-maker');
        const active = await activateCustomer(
            maker,
            access('proof-retention-checker@example.com', 'principal-proof-retention-checker'),
            access('proof-retention-executor@example.com', 'principal-proof-retention-executor')
        );
        current = new Date('2026-08-31T12:05:00.000Z');
        const organisationId = active.organisation.organisationId;
        await repository.mutate(maker, { expectedRevision: active.revision, auditEvents: [] }, async (state) => {
            const organisation = state.organisations.find((item) => item.id === organisationId);
            organisation.proofPeriods.push({
                id: 'proof-approved-retention-history',
                customerId: organisation.customerMaster.customerId,
                period: '1999-12',
                timezone: 'Pacific/Auckland',
                status: 'approved',
                requiredSources: BASE_PROOF_SOURCES,
                evidenceRefs: [],
                approvedBy: 'proof-retention-checker@example.com',
                approvedAt: '2026-08-20T00:00:00.000Z',
                createdAt: '2026-08-20T00:00:00.000Z',
                updatedAt: '2026-08-20T00:00:00.000Z'
            });
            Array.from({ length: 60 }, (_, index) => ({
                id: `proof-open-retention-${index}`,
                customerId: organisation.customerMaster.customerId,
                period: `${2000 + Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`,
                timezone: 'Pacific/Auckland',
                status: 'collecting',
                requiredSources: BASE_PROOF_SOURCES,
                evidenceRefs: [],
                createdAt: '2026-08-20T00:00:00.000Z',
                updatedAt: '2026-08-20T00:00:00.000Z'
            })).forEach((proof) => organisation.proofPeriods.push(proof));
        });

        const before = await repository.read(maker);
        expect(before.organisations.find((item) => item.id === organisationId).proofPeriods).toHaveLength(61);
        await expect(service.recordProofEvidence(maker, organisationId, proofEvidence('service_desk', before.revision, {
            id: 'proof-capacity-attempt',
            period: '2026-08'
        }))).rejects.toMatchObject({ details: { code: 'proof_period_capacity_exceeded', maximumOpenPeriods: 60 } });
        await expect(service.recordProofEvidence(maker, organisationId, proofEvidence('service_desk', before.revision, {
            id: 'proof-old-period-attempt',
            period: '2021-08'
        }))).rejects.toMatchObject({
            details: { code: 'proof_period_out_of_window', earliestPeriod: '2021-10', latestPeriod: '2026-09' }
        });
        const after = await repository.read(maker);
        expect(after.revision).toBe(before.revision);
        expect(after.audit).toHaveLength(before.audit.length);
        expect(after.organisations.find((item) => item.id === organisationId).proofPeriods).toHaveLength(61);
        expect(after.organisations.find((item) => item.id === organisationId).proofPeriods).toContainEqual(
            expect.objectContaining({ id: 'proof-approved-retention-history', status: 'approved' })
        );
    });

    test('open proof requirements grow with mapped entitlements and never shrink within the period', async () => {
        const maker = access('proof-requirements-maker@example.com', 'principal-proof-requirements-maker');
        const checker = access('proof-requirements-checker@example.com', 'principal-proof-requirements-checker');
        const executor = access('proof-requirements-executor@example.com', 'principal-proof-requirements-executor');
        const active = await activateCustomer(maker, checker, executor);
        current = new Date('2026-08-31T12:05:00.000Z');
        const organisationId = active.organisation.organisationId;
        let revision = active.revision;

        for (const source of BASE_PROOF_SOURCES) {
            const evidence = await service.recordProofEvidence(maker, organisationId, proofEvidence(source, revision, {
                id: `proof-requirements-${source}`,
                facts: [proofMetricFact(source)]
            }));
            revision = evidence.revision;
        }
        expect((await service.getCustomerProof(maker, organisationId, { period: '2026-08' })).proof.readiness.ready).toBe(true);

        const expandedMaster = customerMasterFixture();
        delete expandedMaster.externalRefs;
        expandedMaster.entitlements.push({
            code: 'endpoint-security',
            name: 'Threat protection',
            quantity: 1,
            effectiveFrom: '2026-08-20T00:00:00.000Z'
        });
        const expanded = await service.updateCustomerMaster(maker, organisationId, {
            expectedRevision: revision,
            customerMaster: expandedMaster,
            reason: 'Customer added endpoint security to the current service schedule',
            evidenceRef: 'change-register:proof-requirements:add-security',
            confirmChange: true
        });
        revision = expanded.revision;

        let state = await repository.read(maker);
        let proof = state.organisations.find((item) => item.id === organisationId)
            .proofPeriods.find((item) => item.period === '2026-08');
        expect(proof.requiredSources).toContain('mdr');
        expect(proof.status).toBe('incomplete');
        expect(state.schedules.find((item) => item.organisationId === organisationId && item.jobType === 'monthly_proof').requiredSources).toContain('mdr');
        await expect(service.approveCustomerProof(checker, organisationId, {
            expectedRevision: revision,
            period: '2026-08',
            confirmComplete: true
        })).rejects.toMatchObject({
            details: { code: 'proof_readiness_incomplete', missing: expect.arrayContaining(['mdr:missing']) }
        });

        const reducedMaster = customerMasterFixture();
        delete reducedMaster.externalRefs;
        const reduced = await service.updateCustomerMaster(maker, organisationId, {
            expectedRevision: revision,
            customerMaster: reducedMaster,
            reason: 'Customer removed endpoint security for future proof periods',
            evidenceRef: 'change-register:proof-requirements:remove-security',
            confirmChange: true
        });
        revision = reduced.revision;
        state = await repository.read(maker);
        proof = state.organisations.find((item) => item.id === organisationId)
            .proofPeriods.find((item) => item.period === '2026-08');
        expect(proof.requiredSources).toContain('mdr');
        expect(state.schedules.find((item) => item.organisationId === organisationId && item.jobType === 'monthly_proof').requiredSources).toEqual(BASE_PROOF_SOURCES);

        const completed = await service.recordProofEvidence(maker, organisationId, proofEvidence('mdr', revision, {
            id: 'proof-requirements-mdr',
            facts: [proofMetricFact('mdr')]
        }));
        const approved = await service.approveCustomerProof(checker, organisationId, {
            expectedRevision: completed.revision,
            period: '2026-08',
            confirmComplete: true
        });
        expect(approved.proof).toMatchObject({ status: 'approved', requiredSources: expect.arrayContaining(['mdr']) });

        const postApprovalMaster = customerMasterFixture();
        delete postApprovalMaster.externalRefs;
        postApprovalMaster.entitlements.push({
            code: 'endpoint-backup',
            name: 'Work-file backup and recovery',
            quantity: 1,
            effectiveFrom: '2026-08-20T00:00:00.000Z'
        });
        await service.updateCustomerMaster(maker, organisationId, {
            expectedRevision: approved.revision,
            customerMaster: postApprovalMaster,
            reason: 'Customer added backup after the period was approved',
            evidenceRef: 'change-register:proof-requirements:post-approval-backup',
            confirmChange: true
        });
        state = await repository.read(maker);
        proof = state.organisations.find((item) => item.id === organisationId)
            .proofPeriods.find((item) => item.period === '2026-08');
        expect(proof).toMatchObject({ status: 'approved', requiredSources: expect.not.arrayContaining(['backup']) });
    });

    test('retrospective first creation includes entitlements that overlapped the Proof month', async () => {
        const maker = access('proof-retrospective-maker@example.com', 'principal-proof-retrospective-maker');
        const checker = access('proof-retrospective-checker@example.com', 'principal-proof-retrospective-checker');
        const active = await activateCustomer(
            maker,
            checker,
            access('proof-retrospective-executor@example.com', 'principal-proof-retrospective-executor')
        );
        const organisationId = active.organisation.organisationId;

        const withSecurity = customerMasterFixture();
        delete withSecurity.externalRefs;
        withSecurity.entitlements.push({
            code: 'endpoint_security',
            name: 'Endpoint security',
            quantity: 2,
            effectiveFrom: '2026-08-01T00:00:00.000Z'
        });
        let progress = await service.updateCustomerMaster(maker, organisationId, {
            expectedRevision: active.revision,
            customerMaster: withSecurity,
            reason: 'Endpoint security was contracted for the August reporting period',
            evidenceRef: 'change-register:proof-retrospective:add-security',
            confirmChange: true
        });

        current = new Date('2026-09-25T01:00:00.000Z');
        const withoutSecurity = customerMasterFixture();
        delete withoutSecurity.externalRefs;
        progress = await service.updateCustomerMaster(maker, organisationId, {
            expectedRevision: progress.revision,
            customerMaster: withoutSecurity,
            reason: 'Endpoint security ended before the September current-state review',
            evidenceRef: 'change-register:proof-retrospective:end-security',
            confirmChange: true
        });

        for (let index = 0; index < 100; index += 1) {
            const benignReplacement = customerMasterFixture();
            delete benignReplacement.externalRefs;
            benignReplacement.billing.profileId = `billing-profile-benign-${index}`;
            progress = await service.updateCustomerMaster(maker, organisationId, {
                expectedRevision: progress.revision,
                customerMaster: benignReplacement,
                reason: `Benign customer-master maintenance ${index}`,
                evidenceRef: `change-register:proof-retrospective:benign-${index}`,
                confirmChange: true
            });
        }

        const retainedState = await repository.read(maker);
        const retainedOrganisation = retainedState.organisations.find((item) => item.id === organisationId);
        expect(retainedOrganisation.customerMasterHistory).toHaveLength(100);
        expect(retainedOrganisation.customerMasterHistory.some((entry) => (
            entry.snapshot.entitlements.some((entitlement) => entitlement.code === 'endpoint_security')
        ))).toBe(false);
        const augustLedger = retainedOrganisation.proofRequirementLedger.find((entry) => entry.period === '2026-08');
        expect(retainedOrganisation.proofRequirementLedger).toHaveLength(60);
        expect(augustLedger).toMatchObject({
            entitlementCodes: expect.arrayContaining(['endpoint_security']),
            requiredSources: expect.arrayContaining(['mdr']),
            entitlementCodesOverflow: false,
            historyComplete: true,
            throughMasterRevision: retainedOrganisation.customerMaster.revision
        });

        let revision = progress.revision;
        for (const source of BASE_PROOF_SOURCES) {
            progress = await service.recordProofEvidence(maker, organisationId, proofEvidence(source, revision, {
                id: `proof-retrospective-${source}`,
                facts: [proofMetricFact(source)]
            }));
            revision = progress.revision;
        }
        const proofView = await service.getCustomerProof(maker, organisationId, { period: '2026-08' });
        expect(proofView.proof).toMatchObject({
            coverage: {
                periodStart: '2026-07-31T12:00:00.000Z',
                periodEnd: '2026-08-31T11:59:59.999Z'
            },
            requiredSources: expect.arrayContaining(['mdr']),
            readiness: { ready: false, missing: expect.arrayContaining(['mdr:missing']) }
        });
        const state = await repository.read(maker);
        expect(state.schedules.find((item) => (
            item.organisationId === organisationId && item.jobType === 'monthly_proof'
        )).requiredSources).toEqual(BASE_PROOF_SOURCES);
        await expect(service.approveCustomerProof(checker, organisationId, {
            expectedRevision: revision,
            period: '2026-08',
            confirmComplete: true
        })).rejects.toMatchObject({
            details: { code: 'proof_readiness_incomplete', missing: expect.arrayContaining(['mdr:missing']) }
        });

        const completed = await service.recordProofEvidence(maker, organisationId, proofEvidence('mdr', revision, {
            id: 'proof-retrospective-mdr',
            facts: [proofMetricFact('mdr')]
        }));
        const approved = await service.approveCustomerProof(checker, organisationId, {
            expectedRevision: completed.revision,
            period: '2026-08',
            confirmComplete: true
        });
        expect(approved.proof).toMatchObject({ status: 'approved', requiredSources: expect.arrayContaining(['mdr']) });
    });

    test('timezone changes fail closed after boundary entitlement history has aged out', async () => {
        const maker = access('proof-timezone-maker@example.com', 'principal-proof-timezone-maker');
        const checker = access('proof-timezone-checker@example.com', 'principal-proof-timezone-checker');
        const active = await activateCustomer(
            maker,
            checker,
            access('proof-timezone-executor@example.com', 'principal-proof-timezone-executor'),
            { timezone: 'UTC' }
        );
        const organisationId = active.organisation.organisationId;

        const withBoundarySecurity = customerMasterFixture();
        delete withBoundarySecurity.externalRefs;
        withBoundarySecurity.serviceSchedule.timezone = 'UTC';
        withBoundarySecurity.entitlements.push({
            code: 'endpoint_security',
            name: 'Boundary endpoint security',
            quantity: 1,
            effectiveFrom: '2026-07-31T13:00:00.000Z',
            effectiveTo: '2026-07-31T23:00:00.000Z'
        });
        let progress = await service.updateCustomerMaster(maker, organisationId, {
            expectedRevision: active.revision,
            customerMaster: withBoundarySecurity,
            reason: 'Record the UTC-to-Auckland boundary entitlement',
            evidenceRef: 'change-register:proof-timezone:add-boundary-security',
            confirmChange: true
        });

        const withoutBoundarySecurity = customerMasterFixture();
        delete withoutBoundarySecurity.externalRefs;
        withoutBoundarySecurity.serviceSchedule.timezone = 'UTC';
        progress = await service.updateCustomerMaster(maker, organisationId, {
            expectedRevision: progress.revision,
            customerMaster: withoutBoundarySecurity,
            reason: 'Remove the expired UTC boundary entitlement',
            evidenceRef: 'change-register:proof-timezone:remove-boundary-security',
            confirmChange: true
        });

        for (let index = 0; index < 101; index += 1) {
            const benignReplacement = customerMasterFixture();
            delete benignReplacement.externalRefs;
            benignReplacement.serviceSchedule.timezone = 'UTC';
            benignReplacement.billing.profileId = `billing-profile-timezone-${index}`;
            progress = await service.updateCustomerMaster(maker, organisationId, {
                expectedRevision: progress.revision,
                customerMaster: benignReplacement,
                reason: `Timezone regression maintenance ${index}`,
                evidenceRef: `change-register:proof-timezone:maintenance-${index}`,
                confirmChange: true
            });
        }

        const agedState = await repository.read(maker);
        const agedOrganisation = agedState.organisations.find((item) => item.id === organisationId);
        expect(agedOrganisation.customerMasterHistory).toHaveLength(100);
        expect(agedOrganisation.customerMasterHistory.some((entry) => (
            entry.snapshot.entitlements.some((entitlement) => entitlement.code === 'endpoint_security')
        ))).toBe(false);
        expect(agedOrganisation.proofRequirementLedger.find((entry) => entry.period === '2026-08')).toMatchObject({
            timezone: 'UTC',
            historyComplete: true,
            requiredSources: expect.not.arrayContaining(['mdr'])
        });

        await repository.mutate(maker, { expectedRevision: agedState.revision, auditEvents: [] }, async (state) => {
            const organisation = state.organisations.find((item) => item.id === organisationId);
            organisation.proofPeriods.push({
                id: `proof_${organisationId}_2026-08`,
                customerId: organisation.customerMaster.customerId,
                period: '2026-08',
                timezone: 'Pacific/Auckland',
                status: 'collecting',
                requiredSources: BASE_PROOF_SOURCES,
                evidenceRefs: [],
                createdAt: current.toISOString(),
                updatedAt: current.toISOString()
            });
        });
        const mismatchedState = await repository.read(maker);
        const mismatchedView = await service.getCustomerProof(maker, organisationId, { period: '2026-08' });
        expect(mismatchedView.proof.readiness).toMatchObject({
            ready: false,
            missing: expect.arrayContaining(['requirement_history:incomplete'])
        });

        const aucklandProfile = supportProfileFixture();
        const timezoneChanged = await service.updateSupportProfile(maker, organisationId, {
            expectedRevision: mismatchedState.revision,
            supportProfile: aucklandProfile,
            reason: 'Move monthly Proof reporting from UTC to Pacific/Auckland',
            evidenceRef: 'change-register:proof-timezone:utc-to-auckland',
            confirmChange: true
        });
        const reconciledState = await repository.read(maker);
        expect(reconciledState.organisations.find((item) => item.id === organisationId)
            .proofRequirementLedger.find((entry) => entry.period === '2026-08')).toMatchObject({
            timezone: 'Pacific/Auckland',
            historyComplete: false
        });

        current = new Date('2026-08-31T12:05:00.000Z');
        progress = timezoneChanged;
        for (const source of BASE_PROOF_SOURCES) {
            progress = await service.recordProofEvidence(maker, organisationId, proofEvidence(source, progress.revision, {
                id: `proof-timezone-${source}`
            }));
        }
        const proofView = await service.getCustomerProof(maker, organisationId, { period: '2026-08' });
        expect(proofView.proof).toMatchObject({
            timezone: 'Pacific/Auckland',
            requiredSources: expect.not.arrayContaining(['mdr']),
            readiness: {
                ready: false,
                missing: expect.arrayContaining(['requirement_history:incomplete'])
            }
        });
        const beforeApproval = await repository.read(maker);
        await expect(service.approveCustomerProof(checker, organisationId, {
            expectedRevision: progress.revision,
            period: '2026-08',
            confirmComplete: true
        })).rejects.toMatchObject({ details: { code: 'proof_requirement_history_incomplete' } });
        const afterApproval = await repository.read(maker);
        expect(afterApproval.revision).toBe(beforeApproval.revision);
        expect(afterApproval.audit).toHaveLength(beforeApproval.audit.length);
    });

    test('missing master-history prefix creates an incomplete ledger row and blocks Proof approval without mutation', async () => {
        const maker = access('proof-history-maker@example.com', 'principal-proof-history-maker');
        const checker = access('proof-history-checker@example.com', 'principal-proof-history-checker');
        const active = await activateCustomer(
            maker,
            checker,
            access('proof-history-executor@example.com', 'principal-proof-history-executor')
        );
        const organisationId = active.organisation.organisationId;
        current = new Date('2026-08-31T12:05:00.000Z');
        let progress = active;
        for (const source of BASE_PROOF_SOURCES) {
            progress = await service.recordProofEvidence(maker, organisationId, proofEvidence(source, progress.revision, {
                id: `proof-history-${source}`
            }));
        }

        await repository.mutate(maker, { expectedRevision: progress.revision, auditEvents: [] }, async (state) => {
            const organisation = state.organisations.find((item) => item.id === organisationId);
            const snapshot = organisation.customerMaster;
            organisation.customerMaster.revision = 120;
            organisation.customerMasterHistory = Array.from({ length: 100 }, (_, index) => ({
                revision: index + 20,
                changedAt: '2026-08-22T00:00:00.000Z',
                changedBy: maker.user.email,
                reason: `Retained history ${index}`,
                evidenceRef: `change-register:retained-history-${index}`,
                snapshot: Object.assign({}, snapshot, { revision: index + 20 })
            }));
            organisation.proofRequirementLedger = organisation.proofRequirementLedger
                .filter((entry) => entry.period !== '2026-08');
        });
        const seeded = await repository.read(maker);
        const replacement = customerMasterFixture();
        delete replacement.externalRefs;
        progress = await service.updateCustomerMaster(maker, organisationId, {
            expectedRevision: seeded.revision,
            customerMaster: replacement,
            reason: 'Exercise fail-closed history migration',
            evidenceRef: 'change-register:proof-history-incomplete',
            confirmChange: true
        });

        const beforeApproval = await repository.read(maker);
        const organisation = beforeApproval.organisations.find((item) => item.id === organisationId);
        expect(organisation.proofRequirementLedger.find((entry) => entry.period === '2026-08')).toMatchObject({
            historyComplete: false,
            throughMasterRevision: 121
        });
        const proofView = await service.getCustomerProof(maker, organisationId, { period: '2026-08' });
        expect(proofView.proof.readiness).toMatchObject({
            ready: false,
            missing: expect.arrayContaining(['requirement_history:incomplete'])
        });
        await expect(service.approveCustomerProof(checker, organisationId, {
            expectedRevision: progress.revision,
            period: '2026-08',
            confirmComplete: true
        })).rejects.toMatchObject({ details: { code: 'proof_requirement_history_incomplete' } });
        const afterApproval = await repository.read(maker);
        expect(afterApproval.revision).toBe(beforeApproval.revision);
        expect(afterApproval.audit).toHaveLength(beforeApproval.audit.length);
    });

    test('entitlement-code overflow is retained and blocks Proof approval without mutation', async () => {
        const maker = access('proof-overflow-maker@example.com', 'principal-proof-overflow-maker');
        const checker = access('proof-overflow-checker@example.com', 'principal-proof-overflow-checker');
        const active = await activateCustomer(
            maker,
            checker,
            access('proof-overflow-executor@example.com', 'principal-proof-overflow-executor')
        );
        const organisationId = active.organisation.organisationId;
        current = new Date('2026-08-31T12:05:00.000Z');
        let progress = active;
        for (const source of BASE_PROOF_SOURCES) {
            progress = await service.recordProofEvidence(maker, organisationId, proofEvidence(source, progress.revision, {
                id: `proof-overflow-${source}`
            }));
        }
        await repository.mutate(maker, { expectedRevision: progress.revision, auditEvents: [] }, async (state) => {
            const organisation = state.organisations.find((item) => item.id === organisationId);
            const august = organisation.proofRequirementLedger.find((entry) => entry.period === '2026-08');
            august.entitlementCodes = Array.from(
                { length: 101 },
                (_, index) => `unknown_entitlement_${String(index).padStart(3, '0')}`
            );
        });
        const beforeApproval = await repository.read(maker);
        const august = beforeApproval.organisations.find((item) => item.id === organisationId)
            .proofRequirementLedger.find((entry) => entry.period === '2026-08');
        expect(august).toMatchObject({ entitlementCodesOverflow: true, historyComplete: true });
        expect(august.entitlementCodes).toHaveLength(100);
        await expect(service.approveCustomerProof(checker, organisationId, {
            expectedRevision: beforeApproval.revision,
            period: '2026-08',
            confirmComplete: true
        })).rejects.toMatchObject({
            details: { code: 'proof_requirement_history_incomplete', entitlementCodesOverflow: true }
        });
        const afterApproval = await repository.read(maker);
        expect(afterApproval.revision).toBe(beforeApproval.revision);
        expect(afterApproval.audit).toHaveLength(beforeApproval.audit.length);
    });

    test('unmapped active entitlement blocks proof approval without changing tenant state', async () => {
        const maker = access('proof-unmapped-maker@example.com', 'principal-proof-unmapped-maker');
        const checker = access('proof-unmapped-checker@example.com', 'principal-proof-unmapped-checker');
        const executor = access('proof-unmapped-executor@example.com', 'principal-proof-unmapped-executor');
        const active = await activateCustomer(maker, checker, executor);
        current = new Date('2026-08-31T12:05:00.000Z');
        const organisationId = active.organisation.organisationId;
        let progress = await service.recordProofEvidence(maker, organisationId, proofEvidence('service_desk', active.revision, {
            id: 'proof-unmapped-service-desk'
        }));

        const replacement = customerMasterFixture();
        delete replacement.externalRefs;
        replacement.entitlements.push({
            code: 'bespoke_security_service',
            name: 'CrowdStrike Falcon Complete',
            quantity: 1,
            effectiveFrom: '2026-08-20T00:00:00.000Z'
        });
        progress = await service.updateCustomerMaster(maker, organisationId, {
            expectedRevision: progress.revision,
            customerMaster: replacement,
            reason: 'Customer added a bespoke security entitlement pending evidence mapping',
            evidenceRef: 'change-register:proof-requirements:bespoke-security',
            confirmChange: true
        });
        const before = await repository.read(maker);
        const proofView = await service.getCustomerProof(maker, organisationId, { period: '2026-08' });
        expect(proofView.proof).toMatchObject({
            readiness: {
                ready: false,
                unresolvedEntitlements: ['bespoke_security_service'],
                missing: expect.arrayContaining(['entitlement:bespoke_security_service:unresolved'])
            }
        });

        await expect(service.approveCustomerProof(checker, organisationId, {
            expectedRevision: progress.revision,
            period: '2026-08',
            confirmComplete: true
        })).rejects.toMatchObject({
            details: {
                code: 'proof_entitlement_mapping_required',
                entitlements: ['bespoke_security_service']
            }
        });
        const after = await repository.read(maker);
        expect(after.revision).toBe(before.revision);
        expect(after.audit).toHaveLength(before.audit.length);
    });

    test('typed crosswalk rejects the same provider record on another customer', async () => {
        const maker = access('maker@example.com', 'principal-maker');
        const first = await prepareAcceptedCustomer(maker);
        const firstOnboarding = await service.startCustomerOnboarding(maker, first.organisation.organisationId, {
            expectedRevision: first.revision,
            customerMaster: customerMasterFixture(),
            supportProfile: supportProfileFixture(),
            devices: [{ id: 'customer-one-device', label: 'Customer one device', platform: 'windows', owner: 'installer@customer-one.example' }]
        });
        const second = await prepareAcceptedCustomer(maker, 'two');
        await expect(service.addExternalReference(maker, second.organisation.organisationId, {
            expectedRevision: second.revision,
            system: 'hubspot',
            recordType: 'company',
            externalId: 'hubspot-company-one',
            status: 'verified',
            verificationMode: 'manual',
            evidenceRef: 'hubspot-review:company-one',
            confirmManuallyVerified: true
        })).rejects.toMatchObject({ details: { code: 'external_reference_conflict' } });
    });

    test('Datto provisioning claims fence the same canonical site name across customer records', async () => {
        const maker = access('maker@example.com', 'principal-maker');
        const siteName = 'Shared Trading Name Limited';
        const first = await prepareAcceptedCustomer(maker, 'site-fence-one', siteName);
        const second = await prepareAcceptedCustomer(maker, 'site-fence-two', siteName);
        const firstMaster = customerMasterFixture();
        firstMaster.externalRefs = [
            verifiedRef('hubspot', 'company', 'hubspot-company-site-fence-one'),
            verifiedRef('autotask', 'account', 'autotask-account-site-fence-one')
        ];
        const secondMaster = customerMasterFixture();
        secondMaster.externalRefs = [
            verifiedRef('hubspot', 'company', 'hubspot-company-site-fence-two'),
            verifiedRef('autotask', 'account', 'autotask-account-site-fence-two')
        ];
        const firstOnboarding = await service.startCustomerOnboarding(maker, first.organisation.organisationId, {
            expectedRevision: second.revision,
            customerMaster: firstMaster,
            supportProfile: supportProfileFixture(),
            devices: [{ id: 'site-fence-one-device', label: 'First device', platform: 'windows', owner: 'installer@first.example' }]
        });
        const secondOnboarding = await service.startCustomerOnboarding(maker, second.organisation.organisationId, {
            expectedRevision: firstOnboarding.revision,
            customerMaster: secondMaster,
            supportProfile: supportProfileFixture(),
            devices: [{ id: 'site-fence-two-device', label: 'Second device', platform: 'windows', owner: 'installer@second.example' }]
        });
        const firstClaim = await service.claimDattoRmmProvisioning(maker, first.organisation.organisationId, {
            expectedRevision: secondOnboarding.revision,
            provisioningKeyHash: '1'.repeat(64)
        });
        expect(firstClaim.claim).toMatchObject({
            state: 'preparing',
            siteName,
            siteNameKey: 'shared trading name limited'
        });

        await expect(service.claimDattoRmmProvisioning(maker, second.organisation.organisationId, {
            expectedRevision: firstClaim.revision,
            provisioningKeyHash: '2'.repeat(64)
        })).rejects.toMatchObject({
            statusCode: 409,
            details: {
                code: 'datto_rmm_site_name_claim_conflict',
                siteName,
                conflictingOrganisationId: first.organisation.organisationId
            }
        });
    });

    async function prepareAcceptedCustomer(actor, suffix = 'one', displayName = `Customer ${suffix} Limited`) {
        const proposalId = `proposal-${suffix}`;
        let result = await service.createOrganisation(actor, {
            displayName,
            facts: [
                { field: 'company.name', value: displayName, certainty: 'explicit' },
                { field: 'company.summary', value: 'Requires managed IT services', certainty: 'explicit' }
            ]
        });
        for (const lifecycleState of ['discovery', 'scoping']) {
            result = await service.updateOrganisation(actor, result.organisation.organisationId, {
                expectedRevision: result.revision,
                lifecycleState
            });
        }
        result = await service.linkScopingRecords(actor, result.organisation.organisationId, {
            expectedRevision: result.revision,
            salesCustomerId: `sales-customer-${suffix}`,
            assessmentId: `assessment-${suffix}`,
            remainingGapCount: 0
        });
        result = await service.bindApprovedProposal(actor, result.organisation.organisationId, {
            expectedRevision: result.revision,
            proposalId,
            proposalVersion: 'v1',
            proposalSha256: 'a'.repeat(64),
            confirmApprovedProposal: true
        });
        result = await service.recordCommercialAcceptance(actor, result.organisation.organisationId, {
            expectedRevision: result.revision,
            idempotencyKey: `accept:customer-${suffix}:${proposalId}:v1`,
            proposalId,
            proposalVersion: 'v1',
            proposalSha256: 'a'.repeat(64),
            acceptedAt: current.toISOString(),
            effectiveDate: '2026-08-21T00:00:00.000Z',
            signatoryName: 'Customer Sponsor',
            signatoryEmail: 'sponsor@customer-one.example',
            signatoryTitle: 'Director',
            authorityBasis: 'Director authorised under customer authority matrix',
            authorityEvidenceId: `contract-register:${proposalId}:signature`,
            authorityEvidenceSha256: 'b'.repeat(64),
            authorityMatrixVersion: 'customer-authority-v1',
            confirmCustomerAuthority: true
        });
        for (const reference of [
            verifiedRef('hubspot', 'company', `hubspot-company-${suffix}`),
            verifiedRef('autotask', 'account', `autotask-account-${suffix}`)
        ]) {
            result = await service.addExternalReference(actor, result.organisation.organisationId, Object.assign({}, reference, {
                expectedRevision: result.revision,
                confirmManuallyVerified: true
            }));
        }
        return result;
    }

    async function activateCustomer(maker, checker, executor, options = {}) {
        const accepted = await prepareAcceptedCustomer(maker);
        const master = customerMasterFixture();
        const timezone = options.timezone || 'Pacific/Auckland';
        master.entitlements[0].quantity = 1;
        master.estate = { contractedUsers: 1, contractedEndpoints: 1, plannedDevices: 1 };
        master.serviceSchedule.timezone = timezone;
        const supportProfile = supportProfileFixture();
        supportProfile.timezone = timezone;
        let progress = await service.startCustomerOnboarding(maker, accepted.organisation.organisationId, {
            expectedRevision: accepted.revision,
            customerMaster: master,
            supportProfile,
            devices: [{ id: 'proof-device', label: 'Proof device', platform: 'windows', owner: 'installer@customer-one.example' }]
        });
        progress = await service.syncDattoRmmSnapshot(maker, accepted.organisation.organisationId, {
            expectedRevision: progress.revision,
            siteUid: 'proof-site',
            siteName: 'Proof Site',
            deviceCount: 1,
            openAlertCount: 0,
            capturedAt: current.toISOString(),
            devices: [{ deviceUid: 'proof-datto-device', hostname: 'proof-device', operatingSystem: 'Windows 11', lastSeen: current.toISOString(), online: true }]
        });
        progress = await service.matchOnboardingDevice(maker, accepted.organisation.organisationId, {
            expectedRevision: progress.revision,
            deviceId: 'proof-device',
            providerDeviceUid: 'proof-datto-device',
            confirmMatch: true
        });
        for (const status of ['installer_ready', 'enrolled', 'verified']) {
            progress = await service.updateOnboardingDevice(maker, accepted.organisation.organisationId, {
                expectedRevision: progress.revision,
                deviceId: 'proof-device',
                status
            });
        }
        progress = await service.recordOnboardingEvidence(maker, accepted.organisation.organisationId, {
            expectedRevision: progress.revision,
            gateId: 'monitoring_acceptance',
            evidenceId: 'proof-monitoring-acceptance',
            evidenceRef: 'contract-register:proof-monitoring',
            checksum: 'd'.repeat(64),
            capturedAt: current.toISOString(),
            validUntil: '2027-08-20T00:00:00.000Z',
            customerAcceptedAt: current.toISOString(),
            customerAuthorityRef: 'authority-register:proof-sponsor'
        });
        const request = await service.requestActivation(maker, accepted.organisation.organisationId, {
            expectedRevision: progress.revision,
            idempotencyKey: 'activate:proof-customer:v1',
            customerAuthorityRef: 'authority-register:proof-sponsor',
            confirmNoUnresolvedHighRiskExceptions: true
        });
        const review = await service.reviewActivation(checker, accepted.organisation.organisationId, request.request.id, {
            expectedRevision: request.revision,
            decision: 'approve'
        });
        return service.executeActivation(executor, accepted.organisation.organisationId, request.request.id, {
            expectedRevision: review.revision,
            confirmActivation: true
        });
    }

    function proofEvidence(source, expectedRevision, overrides = {}) {
        return Object.assign({
            expectedRevision,
            id: `proof-${source}`,
            period: '2026-08',
            source,
            category: `${source}_monthly_evidence`,
            sourceMode: 'manual',
            providerRecordId: `${source}-record-1`,
            evidenceRef: `evidence-register:${source}:2026-08`,
            checksum: canonicalSourceHash(source),
            periodStart: '2026-07-31T12:00:00.000Z',
            periodEnd: '2026-08-31T11:59:59.999Z',
            capturedAt: current.toISOString(),
            freshUntil: '2026-10-01T00:00:00.000Z'
        }, overrides);
    }
});

function proofMetricFact(source) {
    const metrics = {
        service_desk: ['tickets.resolved', 'Tickets resolved'],
        datto_rmm: ['devices.monitored', 'Devices monitored'],
        mdr: ['alerts.reviewed', 'Security alerts reviewed'],
        backup: ['backups.successful', 'Successful backups'],
        change: ['changes.completed', 'Changes completed'],
        risk: ['risks.open', 'Open risks'],
        billing: ['managed_devices', 'Managed devices'],
        roadmap: ['recommendations.open', 'Open recommendations']
    };
    const [key, label] = metrics[source];
    return { key, label, value: '1', status: 'informational' };
}

function sealedProposalVerifier() {
    return {
        verify: jest.fn(async (_access, expected) => ({
            verified: expected.proposalSha256 === 'a'.repeat(64) && expected.proposalVersion === 'v1',
            code: expected.proposalSha256 === 'a'.repeat(64) ? '' : 'approved_proposal_binding_mismatch',
            binding: expected
        }))
    };
}

function customerMasterFixture() {
    const contact = (name, email, role) => ({ name, email, role, evidenceRef: `authority-register:${role}` });
    return {
        identity: { legalName: 'Customer One Limited', tradingName: 'Customer One', domains: ['customer-one.example'] },
        contacts: {
            sponsor: contact('Customer Sponsor', 'sponsor@customer-one.example', 'sponsor'),
            technical: contact('Technical Contact', 'technical@customer-one.example', 'technical'),
            security: contact('Security Contact', 'security@customer-one.example', 'security'),
            billing: contact('Billing Contact', 'billing@customer-one.example', 'billing'),
            emergencyAfterHours: contact('Emergency Contact', 'emergency@customer-one.example', 'emergency')
        },
        serviceSchedule: {
            agreementId: 'agreement-one',
            version: 'v1',
            contentHash: 'e'.repeat(64),
            startAt: '2026-08-21T00:00:00.000Z',
            supportHours: '08:30-17:00 Monday-Friday',
            slaId: 'sla-business-hours-v1',
            timezone: 'Pacific/Auckland'
        },
        entitlements: [{ code: 'managed_endpoint', name: 'Managed endpoint', quantity: 2, effectiveFrom: '2026-08-21T00:00:00.000Z' }],
        estate: { contractedUsers: 2, contractedEndpoints: 2, plannedDevices: 2 },
        billing: { profileId: 'billing-profile-one', currency: 'NZD', taxTreatment: 'gst_standard', billingCadence: 'monthly' },
        governance: { serviceOwner: 'maker@example.com', proofDueRule: 'monthly', nextReviewAt: '2026-09-20T00:00:00.000Z' },
        externalRefs: [
            verifiedRef('hubspot', 'company', 'hubspot-company-one'),
            verifiedRef('autotask', 'account', 'autotask-account-one')
        ]
    };
}

function supportProfileFixture() {
    return {
        contractStatus: 'signed',
        serviceStartAt: '2026-08-21T00:00:00.000Z',
        slaScheduleRef: 'contract-register:agreement-one:sla',
        slaVersion: 'v1',
        timezone: 'Pacific/Auckland',
        supportHours: '08:30-17:00 Monday-Friday',
        channels: ['email', 'phone', 'portal'],
        authorisedRequesters: [{
            name: 'Customer Sponsor',
            email: 'sponsor@customer-one.example',
            role: 'Sponsor',
            verificationMethod: 'Customer authority register',
            evidenceRef: 'authority-register:sponsor',
            effectiveFrom: '2026-08-21T00:00:00.000Z',
            canApproveRiskyActions: true
        }]
    };
}

function verifiedRef(system, recordType, externalId) {
    return {
        system,
        recordType,
        externalId,
        status: 'verified',
        verificationMode: 'manual',
        verifiedAt: '2026-08-20T01:00:00.000Z',
        verifiedBy: 'maker@example.com',
        evidenceRef: `crosswalk-register:${system}:${externalId}`,
        createdAt: '2026-08-20T01:00:00.000Z'
    };
}

function access(email, principalId, identityTenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') {
    const subjectKey = identityTenantId && principalId
        ? `${String(identityTenantId).toLowerCase()}:${String(principalId).toLowerCase()}`
        : '';
    return {
        allowed: true,
        user: {
            email,
            name: email.split('@')[0],
            principalId,
            identityTenantId,
            subjectKey,
            actorId: subjectKey,
            role: 'admin',
            capabilities: ROLE_CAPABILITIES.admin.slice()
        },
        tenant: {
            id: 'tenant-customer-controls',
            key: tenantStorageKey('tenant-customer-controls'),
            name: 'Customer controls tenant',
            slug: 'customer-controls'
        },
        authentication: { required: false, authenticated: true, provider: 'test' }
    };
}

function canonicalSourceHash(source) {
    return require('crypto').createHash('sha256').update(`proof:${source}:2026-08`).digest('hex');
}

function foldBase64(value, width) {
    return Buffer.from(value).toString('base64').match(new RegExp(`.{1,${width}}`, 'g')).join(' ');
}

function foldBase64Uneven(value, widths) {
    const encoded = Buffer.from(value).toString('base64');
    const chunks = [];
    let offset = 0;
    widths.forEach((width) => {
        chunks.push(encoded.slice(offset, offset + width));
        offset += width;
    });
    if (offset < encoded.length) chunks.push(encoded.slice(offset));
    return chunks.filter(Boolean).join(' ');
}
