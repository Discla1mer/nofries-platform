const crypto = require('crypto');
const {
    BASE_PROOF_SOURCES,
    canonicalHash,
    normaliseProofPeriods,
    proofPeriodBounds
} = require('../api/shared/appLifecycle/customerOperations');
const {
    buildProofPublicationEnvelope,
    buildCustomerProofPortalView,
    buildFrozenCustomerProofSnapshot,
    publicationEnvelopeValid,
    proofCustomerId,
    proofSnapshotValid,
    publishedProofForPeriod
} = require('../api/shared/appLifecycle/monthlyProof');
const { createLifecycleService } = require('../api/shared/appLifecycle/lifecycleService');
const PROOF_AT = '2026-08-31T12:05:00.000Z';

describe('Proof Every Month publication', () => {
    const at = PROOF_AT;

    test('freezes only exact allowlisted numeric metrics and emits an explicit customer-safe schema', () => {
        const organisation = organisationFixture();
        const proof = readyProof('2026-08');
        proof.evidenceRefs.find((item) => item.source === 'service_desk').facts = [
            { key: 'tickets.resolved', label: 'Caller-controlled label', value: '12', unit: 'passwords', status: 'positive' },
            { key: 'tickets.comment', label: 'Comment', value: 'Everything was perfect', unit: '', status: 'positive' },
            { key: 'tickets.open', label: 'Tickets open', value: 'not known', unit: '', status: 'unknown' }
        ];
        applyApprovalContext(proof, at);
        const snapshot = buildFrozenCustomerProofSnapshot(organisation, proof, at);
        expect(snapshot).toEqual(expect.objectContaining({
            schemaVersion: 1,
            proofId: proof.id,
            customerId: proof.customerId,
            organisationDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
            statement: {
                type: 'nofries_attested_monthly_statement',
                label: 'No Fries-attested monthly statement'
            },
            period: '2026-08',
            timezone: 'Pacific/Auckland',
            coverage: {
                periodStart: '2026-07-31T12:00:00.000Z',
                periodEnd: '2026-08-31T11:59:59.999Z'
            },
            attestation: { mode: 'manual_attested', label: 'Manually attested' },
            approval: {
                maker: expect.objectContaining({
                    role: 'admin',
                    roleLabel: 'Administrator',
                    label: 'Proof preparer'
                }),
                checker: expect.objectContaining({
                    label: 'Proof approver'
                }),
                preparedAt: at,
                approvedAt: at,
                distinctActors: true
            }
        }));
        const serviceDeskReceipt = snapshot.evidenceReceipts.find((item) => item.source === 'service_desk');
        expect(serviceDeskReceipt).toEqual({
            receiptId: expect.stringMatching(/^receipt_[a-f0-9]{32}$/),
            source: 'service_desk',
            mode: 'manual_attested',
            evidenceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            capturedAt: at,
            periodStart: '2026-07-31T12:00:00.000Z',
            periodEnd: '2026-08-31T11:59:59.999Z'
        });
        expect(snapshot.sections.find((item) => item.source === 'service_desk')).toEqual({
            source: 'service_desk',
            receiptId: serviceDeskReceipt.receiptId,
            attestation: { mode: 'manual_attested', label: 'Manually attested' },
            metrics: [{
                key: 'tickets.resolved',
                label: 'Tickets resolved',
                value: '12',
                unit: 'tickets',
                status: 'positive',
                receiptId: serviceDeskReceipt.receiptId
            }]
        });
        expect(JSON.stringify(snapshot.approval)).not.toMatch(/actorDigest|subjectKey|principalId|email/);
        expect(JSON.stringify(snapshot)).not.toMatch(/evidenceRef|providerRecordId|recordedBy|maker@example|checker@example|maker-subject|tenant-identity|Caller-controlled|Everything was perfect|passwords/);
    });

    test('shows the last completed customer-local period plus at most 13 issued history reports', () => {
        const organisation = organisationFixture();
        organisation.proofPeriods = [];
        for (let index = 0; index < 15; index += 1) {
            const year = 2026 - Math.floor((index + 4) / 12);
            const month = ((7 - index + 120) % 12) + 1;
            const period = `${year}-${String(month).padStart(2, '0')}`;
            organisation.proofPeriods.push(issuedProof(organisation, period, `2026-09-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`));
        }
        organisation.proofPeriods.push(issuedProof(organisation, '2026-08', '2026-09-01T00:00:00.000Z'));
        const view = buildCustomerProofPortalView(organisation, '2026-09-15T00:00:00.000Z');
        expect(view.current).toMatchObject({ period: '2026-08', state: 'issued' });
        expect(view.current.report.sections[0].metrics).toBeInstanceOf(Array);
        expect(canonicalHash(view.current.report.frozenSnapshot)).toBe(view.current.report.snapshotSha256);
        expect(view.current.report.frozenSnapshot).toMatchObject({
            proofId: view.current.report.proofId,
            customerId: view.current.report.customerId,
            period: view.current.report.period
        });
        expect(view.history).toHaveLength(13);
        expect(view.history).toEqual([...view.history].sort((left, right) => right.period.localeCompare(left.period)));
        expect(view.history.some((item) => item.period === '2026-08')).toBe(false);
    });

    test('fails closed for an issued snapshot with a checksum mismatch', () => {
        const organisation = organisationFixture();
        const proof = issuedProof(organisation, '2026-08', '2026-09-01T00:00:00.000Z');
        proof.customerSnapshot.sections[0].metrics[0].value = '999';
        organisation.proofPeriods = [proof];
        expect(proofSnapshotValid(proof)).toBe(false);
        expect(publishedProofForPeriod(organisation, '2026-08')).toBeNull();
        expect(buildCustomerProofPortalView(organisation, '2026-09-15T00:00:00.000Z').current).toEqual({
            period: '2026-08',
            state: 'unavailable',
            report: null
        });
    });

    test.each([
        ['negative count', 'tickets.resolved', '-1'],
        ['fractional count', 'tickets.resolved', '1.5'],
        ['oversized count', 'tickets.resolved', '1000000001'],
        ['percentage over 100', 'sla.met_percent', '100.01'],
        ['negative duration', 'response.median_minutes', '-0.1'],
        ['oversized duration', 'response.median_minutes', '525601']
    ])('rejects %s from the frozen customer snapshot', (_label, key, value) => {
        const organisation = organisationFixture();
        const proof = readyProof('2026-08');
        proof.evidenceRefs.find((item) => item.source === 'service_desk').facts = [{
            key,
            value,
            status: 'informational'
        }];
        applyApprovalContext(proof, at);
        try {
            buildFrozenCustomerProofSnapshot(organisation, proof, at);
            throw new Error('expected rejection');
        } catch (error) {
            expect(error).toMatchObject({
                code: 'proof_customer_metrics_required',
                sources: expect.arrayContaining(['service_desk'])
            });
        }
    });

    test('rejects contradictory duplicate allowlisted metrics within a source', () => {
        const organisation = organisationFixture();
        const proof = readyProof('2026-08');
        proof.evidenceRefs.find((item) => item.source === 'service_desk').facts = [
            { key: 'tickets.resolved', value: '12', status: 'positive' },
            { key: 'tickets.resolved', value: '99', status: 'attention' }
        ];
        applyApprovalContext(proof, at);
        expect(() => buildFrozenCustomerProofSnapshot(organisation, proof, at)).toThrow(expect.objectContaining({
            code: 'proof_customer_metric_duplicate',
            source: 'service_desk',
            metricKey: 'tickets.resolved'
        }));
    });

    test('labels mixed provenance separately without converting manual evidence into provider evidence', () => {
        const organisation = organisationFixture();
        const proof = readyProof('2026-08');
        proof.evidenceRefs.find((item) => item.source === 'datto_rmm').sourceMode = 'live';
        applyApprovalContext(proof, at);
        const snapshot = buildFrozenCustomerProofSnapshot(organisation, proof, at);
        expect(snapshot.attestation).toEqual({
            mode: 'mixed',
            label: 'Provider-collected and manually attested'
        });
        expect(snapshot.sections.find((item) => item.source === 'datto_rmm').attestation).toEqual({
            mode: 'provider_collected',
            label: 'Provider-collected'
        });
        expect(snapshot.sections.find((item) => item.source === 'service_desk').attestation).toEqual({
            mode: 'manual_attested',
            label: 'Manually attested'
        });
    });

    test('requires maker/checker/issuer separation, freezes approval, and explicitly issues without auto-publishing', async () => {
        const organisation = organisationFixture();
        const proof = readyProof('2026-08');
        organisation.proofPeriods = [proof];
        organisation.proofRequirementLedger = [{
            period: '2026-08',
            timezone: 'Pacific/Auckland',
            entitlementCodes: [],
            requiredSources: BASE_PROOF_SOURCES,
            historyComplete: true,
            throughMasterRevision: 1,
            updatedAt: at
        }];
        const repository = memoryRepository(organisation);
        const service = createLifecycleService({ repository, now: () => new Date(at) });
        const maker = access('maker@example.test', 'maker-subject');
        const checker = access('checker@example.test', 'checker-subject');
        const issuer = access('issuer@example.test', 'issuer-subject');

        await expect(service.approveCustomerProof(maker, organisation.id, {
            expectedRevision: 0,
            period: '2026-08',
            confirmComplete: true
        })).rejects.toMatchObject({ details: { code: 'proof_dual_control_required' } });
        const approved = await service.approveCustomerProof(checker, organisation.id, {
            expectedRevision: 0,
            period: '2026-08',
            confirmComplete: true
        });
        expect(approved.proof).toMatchObject({
            status: 'approved',
            checkedBy: { subjectKey: checker.user.subjectKey },
            snapshotSha256: expect.stringMatching(/^[a-f0-9]{64}$/)
        });
        expect(approved.proof.customerSnapshot.approval.distinctActors).toBe(true);
        expect(JSON.stringify(approved.proof.customerSnapshot.approval)).not.toMatch(/actorDigest|subjectKey|principalId|email/);
        expect(publishedProofForPeriod((await repository.read(checker)).organisations[0], '2026-08')).toBeNull();

        const approvedState = await repository.read(checker);
        await expect(service.issueCustomerProof(maker, organisation.id, {
            expectedRevision: approved.revision,
            period: '2026-08',
            confirmIssue: true
        })).rejects.toMatchObject({
            statusCode: 409,
            details: { code: 'proof_issuer_independence_required' }
        });
        expect(await repository.read(checker)).toEqual(approvedState);
        await expect(service.issueCustomerProof(checker, organisation.id, {
            expectedRevision: approved.revision,
            period: '2026-08',
            confirmIssue: true
        })).rejects.toMatchObject({
            statusCode: 409,
            details: { code: 'proof_issuer_independence_required' }
        });
        expect(await repository.read(checker)).toEqual(approvedState);

        const issued = await service.issueCustomerProof(issuer, organisation.id, {
            expectedRevision: approved.revision,
            period: '2026-08',
            confirmIssue: true
        });
        expect(issued).toMatchObject({
            issued: true,
            proof: {
                status: 'issued',
                publicationSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
                publicationEnvelope: {
                    approvedSnapshotSha256: approved.proof.snapshotSha256,
                    statement: { label: 'No Fries-attested monthly statement' },
                    issuer: expect.objectContaining({ roleLabel: 'Administrator', label: 'Proof issuer' })
                }
            }
        });
        const stored = (await repository.read(issuer)).organisations[0];
        expect(stored.proofPeriods[0].issuedBy).toMatchObject({ subjectKey: issuer.user.subjectKey });
        const report = publishedProofForPeriod(stored, '2026-08');
        expect(report).toMatchObject({
            period: '2026-08',
            customerId: 'customer-proof-one',
            approvedAt: at,
            issuedAt: at,
            attestation: { label: 'Manually attested' },
            evidenceReceipts: expect.arrayContaining([
                expect.objectContaining({ mode: 'manual_attested', capturedAt: at })
            ])
        });
        expect(canonicalHash(report.publicationEnvelope)).toBe(report.publicationSha256);
        expect(report.publicationEnvelope.approvedSnapshotSha256).toBe(report.snapshotSha256);
        expect(JSON.stringify(report)).not.toMatch(/maker@example|checker@example|issuer@example|maker-subject|checker-subject|issuer-subject|tenant-identity/);
        const replay = await service.issueCustomerProof(issuer, organisation.id, {
            expectedRevision: approved.revision,
            period: '2026-08',
            confirmIssue: true
        });
        expect(replay).toMatchObject({ issued: false, revision: issued.revision });
    });

    test('rejects evidence captured after the exact approval instant', async () => {
        const organisation = organisationFixture();
        const proof = readyProof('2026-08');
        proof.evidenceRefs[0].capturedAt = '2026-08-31T12:05:01.000Z';
        proof.evidenceRefs[0].ingestedAt = '2026-08-31T12:05:01.000Z';
        organisation.proofPeriods = [proof];
        organisation.proofRequirementLedger = [{
            period: '2026-08',
            timezone: 'Pacific/Auckland',
            entitlementCodes: [],
            requiredSources: BASE_PROOF_SOURCES,
            historyComplete: true,
            throughMasterRevision: 1,
            updatedAt: at
        }];
        const service = createLifecycleService({
            repository: memoryRepository(organisation),
            now: () => new Date(at)
        });
        await expect(service.approveCustomerProof(
            access('checker@example.test', 'checker-subject'),
            organisation.id,
            { expectedRevision: 0, period: '2026-08', confirmComplete: true }
        )).rejects.toMatchObject({ details: { code: 'proof_evidence_after_approval' } });

        applyApprovalContext(proof, at);
        expect(() => buildFrozenCustomerProofSnapshot(organisation, proof, at))
            .toThrow(expect.objectContaining({ code: 'proof_evidence_after_approval' }));
    });

    test('requires the explicit ready transition and immutable maker subject before approval', async () => {
        const collectingOrganisation = organisationFixture();
        const collecting = readyProof('2026-08');
        collecting.status = 'collecting';
        collectingOrganisation.proofPeriods = [collecting];
        collectingOrganisation.proofRequirementLedger = [{
            period: '2026-08',
            timezone: 'Pacific/Auckland',
            entitlementCodes: [],
            requiredSources: BASE_PROOF_SOURCES,
            historyComplete: true,
            throughMasterRevision: 1,
            updatedAt: at
        }];
        const checker = access('checker@example.test', 'checker-subject');
        const collectingService = createLifecycleService({
            repository: memoryRepository(collectingOrganisation),
            now: () => new Date(at)
        });
        await expect(collectingService.approveCustomerProof(checker, collectingOrganisation.id, {
            expectedRevision: 0,
            period: '2026-08',
            confirmComplete: true
        })).rejects.toMatchObject({ details: { code: 'proof_transition_invalid' } });

        const legacyOrganisation = organisationFixture();
        const legacy = readyProof('2026-08');
        legacy.preparedBy = {
            identityTenantId: 'tenant-identity',
            principalId: 'legacy-maker-subject',
            subjectKey: 'tenant-identity:different-subject',
            email: 'legacy-maker@example.test',
            role: 'admin'
        };
        legacyOrganisation.proofPeriods = [legacy];
        legacyOrganisation.proofRequirementLedger = collectingOrganisation.proofRequirementLedger;
        const legacyService = createLifecycleService({
            repository: memoryRepository(legacyOrganisation),
            now: () => new Date(at)
        });
        await expect(legacyService.approveCustomerProof(checker, legacyOrganisation.id, {
            expectedRevision: 0,
            period: '2026-08',
            confirmComplete: true
        })).rejects.toMatchObject({ details: { code: 'proof_immutable_actor_required' } });
    });

    test('rejects caller-asserted provider-live evidence', async () => {
        const organisation = organisationFixture();
        organisation.proofPeriods = [];
        const repository = memoryRepository(organisation);
        const service = createLifecycleService({ repository, now: () => new Date(at) });
        await expect(service.recordProofEvidence(access('maker@example.test', 'maker-subject'), organisation.id, {
            expectedRevision: 0,
            period: '2026-08',
            source: 'service_desk',
            sourceMode: 'live'
        })).rejects.toMatchObject({ details: { code: 'proof_provider_evidence_server_only' } });
    });

    test('fails closed when an evidence receipt or publication envelope is tampered', () => {
        const organisation = organisationFixture();
        const proof = issuedProof(organisation, '2026-08', '2026-09-01T00:00:00.000Z');
        organisation.proofPeriods = [proof];
        expect(proofSnapshotValid(proof)).toBe(true);
        expect(publicationEnvelopeValid(proof)).toBe(true);

        proof.customerSnapshot.evidenceReceipts[0].capturedAt = '2026-08-31T12:06:00.000Z';
        expect(proofSnapshotValid(proof)).toBe(false);
        expect(publishedProofForPeriod(organisation, '2026-08')).toBeNull();

        const cleanProof = issuedProof(organisationFixture(), '2026-08', '2026-09-01T00:00:00.000Z');
        cleanProof.publicationEnvelope.issuer.roleLabel = 'Service owner';
        expect(publicationEnvelopeValid(cleanProof)).toBe(false);

        const persistedTamper = issuedProof(organisationFixture(), '2026-08', '2026-09-01T00:00:00.000Z');
        persistedTamper.publicationEnvelope.issuer.roleLabel = 'Service owner';
        const normalisedTamper = normaliseProofPeriods([persistedTamper])[0];
        expect(normalisedTamper.publicationEnvelope).toBeNull();
        expect(publicationEnvelopeValid(normalisedTamper)).toBe(false);

        for (const actorField of ['preparedBy', 'checkedBy']) {
            const sameActorProof = issuedProof(organisationFixture(), '2026-08', '2026-09-01T00:00:00.000Z');
            expect(() => buildProofPublicationEnvelope(
                sameActorProof,
                sameActorProof[actorField],
                sameActorProof.issuedAt
            )).toThrow(expect.objectContaining({ code: 'proof_publication_receipt_invalid' }));
            sameActorProof.issuedBy = structuredClone(sameActorProof[actorField]);
            expect(canonicalHash(sameActorProof.publicationEnvelope)).toBe(sameActorProof.publicationSha256);
            expect(publicationEnvelopeValid(sameActorProof)).toBe(false);
            const sameActorOrganisation = organisationFixture();
            sameActorOrganisation.proofPeriods = [sameActorProof];
            expect(publishedProofForPeriod(sameActorOrganisation, '2026-08')).toBeNull();
        }
    });

    test('rejects reconstructed receipt tampering even when both public hashes are recomputed', () => {
        const organisation = organisationFixture();
        const proof = issuedProof(organisation, '2026-08', '2026-09-01T00:00:00.000Z');
        proof.customerSnapshot.sections[0].receiptId = proof.customerSnapshot.evidenceReceipts[1].receiptId;
        proof.customerSnapshot.sections[0].metrics[0].receiptId = proof.customerSnapshot.evidenceReceipts[1].receiptId;
        proof.snapshotSha256 = canonicalHash(proof.customerSnapshot);
        proof.publicationEnvelope.approvedSnapshotSha256 = proof.snapshotSha256;
        proof.publicationSha256 = canonicalHash(proof.publicationEnvelope);
        expect(proofSnapshotValid(proof, organisation)).toBe(false);
        expect(publicationEnvelopeValid(proof, organisation)).toBe(false);
    });

    test('binds external organisation and customer IDs explicitly without conflating them', () => {
        const organisation = organisationFixture();
        expect(organisation.id).not.toBe(organisation.customerMaster.customerId);
        expect(proofCustomerId(organisation)).toBe('customer-proof-one');
        const proof = issuedProof(organisation, '2026-08', '2026-09-01T00:00:00.000Z');
        organisation.proofPeriods = [proof];
        expect(publishedProofForPeriod(organisation, '2026-08')).toMatchObject({
            proofId: proof.id,
            customerId: 'customer-proof-one'
        });
        proof.customerId = organisation.id;
        expect(publishedProofForPeriod(organisation, '2026-08')).toBeNull();

        const otherOrganisation = organisationFixture();
        otherOrganisation.id = 'organisation-proof-two';
        otherOrganisation.proofPeriods = [issuedProof(organisation, '2026-08', '2026-09-01T00:00:00.000Z')];
        expect(otherOrganisation.customerMaster.customerId).toBe(organisation.customerMaster.customerId);
        expect(publishedProofForPeriod(otherOrganisation, '2026-08')).toBeNull();
    });

    test('retains both immutable hash preimages through lifecycle normalisation', () => {
        const organisation = organisationFixture();
        const original = issuedProof(organisation, '2026-08', '2026-09-01T00:00:00.000Z');
        const persisted = normaliseProofPeriods([original])[0];
        organisation.proofPeriods = [persisted];
        expect(proofSnapshotValid(persisted)).toBe(true);
        expect(publicationEnvelopeValid(persisted)).toBe(true);
        expect(publishedProofForPeriod(organisation, '2026-08')).toMatchObject({
            snapshotSha256: original.snapshotSha256,
            publicationSha256: original.publicationSha256
        });
    });
});

function organisationFixture() {
    return {
        id: 'organisation-proof-one',
        recordType: 'customer',
        displayName: 'Proof Customer',
        supportProfile: { timezone: 'Pacific/Auckland' },
        customerMaster: {
            customerId: 'customer-proof-one',
            revision: 1,
            entitlements: [],
            serviceSchedule: { timezone: 'Pacific/Auckland' }
        },
        customerMasterHistory: [],
        proofRequirementLedger: [],
        proofPeriods: []
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
            capturedAt: '2026-08-31T12:05:00.000Z',
            ingestedAt: '2026-08-31T12:05:00.000Z',
            freshUntil: '2026-10-01T00:00:00.000Z',
            recordedBy: 'maker@example.test',
            facts: defaultFacts(source)
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

function issuedProof(organisation, period, issuedAt) {
    const proof = readyProof(period);
    const snapshotAt = new Date(proofPeriodBounds(period, proof.timezone).endExclusiveMs + 5 * 60 * 1000).toISOString();
    proof.evidenceRefs.forEach((item) => {
        item.capturedAt = snapshotAt;
        item.ingestedAt = snapshotAt;
        item.freshUntil = new Date(Date.parse(snapshotAt) + (90 * 24 * 60 * 60 * 1000)).toISOString();
    });
    proof.preparedAt = snapshotAt;
    applyApprovalContext(proof, snapshotAt);
    const snapshot = buildFrozenCustomerProofSnapshot(organisation, proof, snapshotAt);
    Object.assign(proof, {
        status: 'approved',
        customerSnapshot: snapshot,
        snapshotSha256: canonicalHash(snapshot),
        approvedBy: 'checker@example.test',
        approvedAt: snapshotAt
    });
    const issuer = {
        principalId: 'issuer-subject',
        identityTenantId: 'tenant-identity',
        subjectKey: 'tenant-identity:issuer-subject',
        email: 'issuer@example.test',
        role: 'admin'
    };
    const publicationEnvelope = buildProofPublicationEnvelope(proof, issuer, issuedAt, organisation);
    return Object.assign(proof, {
        status: 'issued',
        issuedBy: issuer,
        issuedAt,
        publicationEnvelope,
        publicationSha256: canonicalHash(publicationEnvelope)
    });
}

function applyApprovalContext(proof, approvedAt) {
    proof.checkedBy = {
        principalId: 'checker-subject',
        identityTenantId: 'tenant-identity',
        subjectKey: 'tenant-identity:checker-subject',
        email: 'checker@example.test',
        role: 'admin'
    };
    proof.approvedAt = approvedAt;
    return proof;
}

function defaultFacts(source) {
    const bySource = {
        service_desk: { key: 'tickets.resolved', value: '12' },
        datto_rmm: { key: 'devices.monitored', value: '5' },
        mdr: { key: 'alerts.reviewed', value: '0' },
        backup: { key: 'backups.successful', value: '5' },
        change: { key: 'changes.completed', value: '2' },
        risk: { key: 'risks.open', value: '1' },
        billing: { key: 'managed_devices', value: '5' },
        roadmap: { key: 'recommendations.open', value: '3' }
    };
    const fact = bySource[source] || { key: 'alerts.reviewed', value: '0' };
    return [{ key: fact.key, label: 'Caller label', value: fact.value, unit: '', status: 'informational' }];
}

function memoryRepository(organisation) {
    let state = { revision: 0, organisations: [organisation], audit: [] };
    return {
        async read() {
            return structuredClone(state);
        },
        async mutate(_access, options, mutator) {
            if (Number(options.expectedRevision) !== state.revision) {
                const error = new Error('revision conflict');
                error.statusCode = 409;
                error.details = { code: 'revision_conflict' };
                throw error;
            }
            const next = structuredClone(state);
            const result = await mutator(next);
            next.revision += 1;
            next.audit.push(...(options.auditEvents || []));
            state = next;
            return { state: structuredClone(state), result };
        }
    };
}

function access(email, principalId) {
    return {
        allowed: true,
        user: {
            email,
            role: 'admin',
            principalId,
            identityTenantId: 'tenant-identity',
            subjectKey: `tenant-identity:${principalId}`,
            capabilities: []
        },
        tenant: { id: 'tenant-proof', key: 'tenant-proof', name: 'Proof tenant', slug: 'proof' }
    };
}
