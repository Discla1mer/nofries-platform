'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const nativeModule = require('../api/shared/assessmentEngine/nistFrameworkProfile');
const { createNistFrameworkProfile, NistFrameworkProfileError } = nativeModule;
const { calculateFrameworkProfileSha256, createFrameworkRegistry, publishFrameworkProfile } =
    require('../api/shared/assessmentEngine/frameworkProfileRegistry');
const { createAcceptedNcscFrameworkProfile } = require('../api/shared/assessmentEngine/ncscAcceptedFrameworkProfile');
const { createNcscFrameworkProfile, getDefaultFrameworkRegistry } = require('../api/shared/assessmentEngine/ncscFrameworkProfile');
const { evaluateAcceptedNcscAssessment } = require('../api/shared/assessmentEngine/ncscAssessmentEvaluator');
const { calculateApplicabilityDecisionSha256,
    calculateEvidenceSnapshotSha256, calculateRiskContextSnapshotSha256,
    evaluateAssessment, serialiseAssessmentEvaluation } = require('../api/shared/assessmentEngine/assessmentEvaluator');
const acceptedFixture = require('./fixtures/ncscAcceptedEvaluation.json');

// Independent reviewed edition literals. No generated publication or scratch fixture supplies the oracle.
const CONTROL_IDS = `GV.OC-01 GV.OC-02 GV.OC-03 GV.OC-04 GV.OC-05
GV.RM-01 GV.RM-02 GV.RM-03 GV.RM-04 GV.RM-05 GV.RM-06 GV.RM-07
GV.RR-01 GV.RR-02 GV.RR-03 GV.RR-04 GV.PO-01 GV.PO-02 GV.OV-01 GV.OV-02 GV.OV-03
GV.SC-01 GV.SC-02 GV.SC-03 GV.SC-04 GV.SC-05 GV.SC-06 GV.SC-07 GV.SC-08 GV.SC-09 GV.SC-10
ID.AM-01 ID.AM-02 ID.AM-03 ID.AM-04 ID.AM-05 ID.AM-07 ID.AM-08
ID.RA-01 ID.RA-02 ID.RA-03 ID.RA-04 ID.RA-05 ID.RA-06 ID.RA-07 ID.RA-08 ID.RA-09 ID.RA-10
ID.IM-01 ID.IM-02 ID.IM-03 ID.IM-04 PR.AA-01 PR.AA-02 PR.AA-03 PR.AA-04 PR.AA-05 PR.AA-06
PR.AT-01 PR.AT-02 PR.DS-01 PR.DS-02 PR.DS-10 PR.DS-11
PR.PS-01 PR.PS-02 PR.PS-03 PR.PS-04 PR.PS-05 PR.PS-06 PR.IR-01 PR.IR-02 PR.IR-03 PR.IR-04
DE.CM-01 DE.CM-02 DE.CM-03 DE.CM-06 DE.CM-09 DE.AE-02 DE.AE-03 DE.AE-04 DE.AE-06 DE.AE-07 DE.AE-08
RS.MA-01 RS.MA-02 RS.MA-03 RS.MA-04 RS.MA-05 RS.AN-03 RS.AN-06 RS.AN-07 RS.AN-08
RS.CO-02 RS.CO-03 RS.MI-01 RS.MI-02 RC.RP-01 RC.RP-02 RC.RP-03 RC.RP-04 RC.RP-05 RC.RP-06 RC.CO-03 RC.CO-04`.split(/\s+/);
const CATEGORY_TITLES = {
    'GV.OC': 'Organizational Context', 'GV.RM': 'Risk Management Strategy',
    'GV.RR': 'Roles, Responsibilities, and Authorities', 'GV.PO': 'Policy', 'GV.OV': 'Oversight',
    'GV.SC': 'Cybersecurity Supply Chain Risk Management', 'ID.AM': 'Asset Management',
    'ID.RA': 'Risk Assessment', 'ID.IM': 'Improvement',
    'PR.AA': 'Identity Management, Authentication, and Access Control', 'PR.AT': 'Awareness and Training',
    'PR.DS': 'Data Security', 'PR.PS': 'Platform Security', 'PR.IR': 'Technology Infrastructure Resilience',
    'DE.CM': 'Continuous Monitoring', 'DE.AE': 'Adverse Event Analysis', 'RS.MA': 'Incident Management',
    'RS.AN': 'Incident Analysis', 'RS.CO': 'Incident Response Reporting and Communication',
    'RS.MI': 'Incident Mitigation', 'RC.RP': 'Incident Recovery Plan Execution', 'RC.CO': 'Incident Recovery Communication'
};
const PROFILE_REF = {
    frameworkId: 'nist-cybersecurity-framework', frameworkVersion: '2.0',
    profileId: 'nf-nist-csf-2-0-core', profileVersion: '2026-09-08.1',
    catalogueSha256: 'ec394a65b11417b67201f96af57a7eabeb284376bb0651b816b40017476b6073',
    sourceCatalogueSha256: 'ab75b51c3561c50cb48cd21b96c01afa2aecafb2efc6b46ae4a8ef8cd753a656'
};
const SOURCE_ID = 'nist-cswp-29-final-2024-02-26';
const copy = value => JSON.parse(JSON.stringify(value));
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

function assertFrozen(value) {
    if (value === null || typeof value !== 'object') return;
    expect(Object.isFrozen(value)).toBe(true);
    Object.values(value).forEach(assertFrozen);
}
function buildInput() {
    const value = {
        schemaVersion: 1, scoreContractVersion: 'PROD-003-R1', organisationId: 'synthetic-nist-organisation',
        moduleId: 'cyber_security', assessmentId: 'synthetic-nist-assessment', assessmentRevision: 'rev-1',
        profileRef: { ...PROFILE_REF }, scoreAsOf: '2026-09-08T10:00:00.000Z',
        scopePopulationSha256: '1'.repeat(64),
        evidenceSnapshot: { id: 'synthetic-nist-evidence', sha256: '0'.repeat(64) },
        riskContextSnapshot: { id: 'synthetic-nist-risk', sha256: '0'.repeat(64) },
        atomInputs: CONTROL_IDS.map(id => ({ itemId: `${id}-Q1`, response: { optionId: 'yes' },
            evidenceState: 'not_provided', statedImpact: 'unspecified', priorityOverlay: 'none' }))
    };
    refreshSnapshots(value);
    return value;
}
function refreshSnapshots(value) {
    value.evidenceSnapshot.sha256 = calculateEvidenceSnapshotSha256(
        value.atomInputs.map(({ itemId, evidenceState }) => ({ itemId, evidenceState })));
    value.riskContextSnapshot.sha256 = calculateRiskContextSnapshotSha256(
        value.atomInputs.map(({ itemId, statedImpact, priorityOverlay }) => ({ itemId, statedImpact, priorityOverlay })));
}
function approveLast(value) {
    const atom = value.atomInputs[105];
    atom.response = { optionId: 'not_applicable' };
    atom.applicabilityClaim = { rationaleSha256: '4'.repeat(64) };
    const core = {
        decisionId: 'synthetic-nist-decision', decisionRevision: 'rev-1',
        organisationId: value.organisationId, moduleId: value.moduleId, assessmentId: value.assessmentId,
        assessmentRevision: value.assessmentRevision, itemId: atom.itemId,
        frameworkId: PROFILE_REF.frameworkId, frameworkVersion: PROFILE_REF.frameworkVersion,
        profileId: PROFILE_REF.profileId, profileVersion: PROFILE_REF.profileVersion,
        catalogueSha256: PROFILE_REF.catalogueSha256, scopePopulationSha256: value.scopePopulationSha256,
        status: 'approved', rationaleSha256: atom.applicabilityClaim.rationaleSha256,
        approvedBy: 'synthetic-reviewer', approvedAt: '2026-09-08T09:00:00.000Z'
    };
    atom.applicabilityDecision = { ...core, decisionSha256: calculateApplicabilityDecisionSha256(core) };
    return copy(atom.applicabilityDecision);
}
function expectEvaluationFailure(fn, code) {
    expect(fn).toThrow(expect.objectContaining({ name: 'AssessmentEvaluationError', ...(code ? { code } : {}) }));
}

describe('fixed native NIST CSF 2.0 publication', () => {
    let profile;
    beforeAll(() => { profile = createNistFrameworkProfile(); });

    test('publishes the complete reviewed bytes and independent source/catalogue pins through the real schema', () => {
        expect(Object.keys(nativeModule).sort()).toEqual(['NistFrameworkProfileError', 'createNistFrameworkProfile']);
        expect(createNistFrameworkProfile).toHaveLength(0);
        expect(NistFrameworkProfileError.prototype).toBeInstanceOf(Error);
        expect(profile).toMatchObject({ schemaVersion: 1, status: 'published', publishedAt: '2026-09-08',
            framework: { id: PROFILE_REF.frameworkId, version: PROFILE_REF.frameworkVersion },
            profile: { id: PROFILE_REF.profileId, version: PROFILE_REF.profileVersion, effectiveFrom: '2026-09-08' },
            catalogueSha256: PROFILE_REF.catalogueSha256, sourceCatalogueSha256: PROFILE_REF.sourceCatalogueSha256 });
        expect(calculateFrameworkProfileSha256(profile)).toBe(PROFILE_REF.catalogueSha256);
        expect(publishFrameworkProfile(copy(profile))).toEqual(profile);
        // Pins every reviewed prompt, guidance paragraph, source field and order independently of the module constants.
        expect(sha256(JSON.stringify(profile, null, 2) + '\n')).toBe(
            'ea58442266e9676b5f5fe129428b701a20b1ff1189bc3a69e973d4e9fda7adfc');
    });

    test('retains all 106 official IDs and numbering gaps as exactly one Q1, parent and source reference', () => {
        expect(profile.controls.map(item => item.id)).toEqual(CONTROL_IDS);
        expect(profile.questions.map(item => item.id)).toEqual(CONTROL_IDS.map(id => `${id}-Q1`));
        expect(profile.domains.map(({ id, order }) => [id, order])).toEqual(
            [['GV', 1], ['ID', 2], ['PR', 3], ['DE', 4], ['RS', 5], ['RC', 6]]);
        expect(profile.domains.map(domain => profile.controls.filter(c => c.domainId === domain.id).length))
            .toEqual([31, 21, 22, 11, 13, 8]);
        expect(new Set(CONTROL_IDS.map(id => id.split('-')[0]))).toEqual(new Set(Object.keys(CATEGORY_TITLES)));
        expect(Object.keys(CATEGORY_TITLES)).toHaveLength(22);
        profile.controls.forEach((control, index) => {
            const id = CONTROL_IDS[index];
            expect(control).toMatchObject({ id, domainId: id.slice(0, 2), order: index + 1,
                sourceIds: [SOURCE_ID], sourceReferences: [{ sourceId: SOURCE_ID, referenceId: id, order: 1 }] });
            expect(control.guidance.summary).toContain(`(${CATEGORY_TITLES[id.split('-')[0]]})`);
            expect(profile.questions[index]).toMatchObject({ id: `${id}-Q1`, controlId: id, order: 1, weight: 1,
                sourceIds: [SOURCE_ID], responseOptionIds: ['yes', 'partial', 'no', 'unknown', 'not_applicable'],
                prompt: 'Within the declared assessment scope, how fully is this outcome achieved? ' + control.title });
        });
        expect(profile.controls[0].title).toBe('The organizational mission is understood and informs cybersecurity risk management');
    });

    test('uses the five strict response semantics without weights or scored category nodes', () => {
        expect(profile.responseOptions).toEqual([
            { id: 'yes', label: 'Yes', applicable: true, implementationFactor: 1 },
            { id: 'partial', label: 'Partial', applicable: true, implementationFactor: 0.5 },
            { id: 'no', label: 'No', applicable: true, implementationFactor: 0 },
            { id: 'unknown', label: 'Unknown', applicable: true, implementationFactor: null },
            { id: 'not_applicable', label: 'Not applicable', applicable: false, implementationFactor: null }
        ]);
        expect(profile.controls).toHaveLength(106);
        expect(profile.questions.reduce((total, q) => total + q.weight, 0)).toBe(106);
        expect(profile.controls.some(control => Object.hasOwn(CATEGORY_TITLES, control.id))).toBe(false);
    });

    test('binds the final source, separate publication dates and limited Technical Series attribution', () => {
        expect(profile.sources).toHaveLength(1);
        expect(profile.sources[0]).toMatchObject({ id: SOURCE_ID, version: 'CSWP-29-final-2024-02-26',
            url: 'https://nvlpubs.nist.gov/nistpubs/CSWP/NIST.CSWP.29.pdf', publishedAt: '2024-02-26',
            lastVerifiedAt: '2026-09-08', reviewDueAt: '2027-09-02', reviewCadence: 'annual', rightsStatus: 'verified',
            licenceUrl: 'https://www.nist.gov/open/copyright-fair-use-and-licensing-statements-srd-data-software-and-technical-series-publications' });
        expect(profile.sources[0].licence).toMatch(/NIST Technical Series Publications reprint terms/);
        expect(profile.sources[0].licence).not.toMatch(/CC BY/);
        expect(profile.statements.attribution).toContain('https://doi.org/10.6028/NIST.CSWP.29. Republished courtesy of the National Institute of Standards and Technology.');
        expect(profile.statements.attribution).toContain('No Fries Limited, 2026-09-08');
        expect(profile.statements.limitations.join(' ')).toContain('Logos, imagery, third-party Informative References, other standards and separately updated Implementation Examples are excluded');
        expect(profile.statements.claim).toContain('no official NIST score, Tier, certification');
        const doc = fs.readFileSync(path.join(__dirname, '../docs/nist-csf-2-crosswalk.md'), 'utf8');
        expect(doc).toContain('3c31f46fee98cac0c4323453e5109291a213b4de7fef8c058af9bf67f717433c');
        expect(doc).toContain(profile.sources[0].licenceUrl);
        expect(doc).toContain('Republished courtesy of the National Institute of Standards and Technology.');
    });

    test('returns independent deeply frozen publications and leaves the original intact after mutation attempts', () => {
        const again = createNistFrameworkProfile();
        expect(again).toEqual(profile);
        expect(again).not.toBe(profile);
        expect(again.questions[0]).not.toBe(profile.questions[0]);
        assertFrozen(profile);
        expect(() => { profile.questions[0].weight = 2; }).toThrow(TypeError);
        expect(() => { profile.controls[0].sourceReferences.push({}); }).toThrow(TypeError);
        expect(createNistFrameworkProfile()).toEqual(again);
    });

    test('coexists with exact accepted and historical NCSC versions without changing the default registry', () => {
        const historical = createNcscFrameworkProfile(), accepted = createAcceptedNcscFrameworkProfile();
        const defaults = getDefaultFrameworkRegistry(), before = defaults.listProfiles();
        const registry = createFrameworkRegistry([historical, accepted, profile]);
        expect(registry.listProfiles()).toHaveLength(3);
        expect(registry.getProfile(PROFILE_REF.profileId, PROFILE_REF.profileVersion)).toEqual(profile);
        expect(registry.getProfile(accepted.profile.id, accepted.profile.version)).toEqual(accepted);
        expect(historical.catalogueSha256).toBe('d37caa778e84e59c106c784e0892cc30146c62f4c13de68f01ab5cb5e14adb69');
        expect(historical.sourceCatalogueSha256).toBe('5bdde37694c51757bbd470e44bf7fda5936f8193282228897f93a9be2db418a3');
        expect(accepted.catalogueSha256).toBe('32c3f8d154ffe2be9b1270f8fa1234427a05cdea96b231588cce0b147e7d5375');
        expect(accepted.sourceCatalogueSha256).toBe('26ccecee78ade16607e5e8c194d585dc47c7921f2eea54b2c76776e0d961b6ee');
        expect(accepted.questions).toHaveLength(14);
        expect(defaults.listProfiles()).toEqual(before);
        expect(() => defaults.getProfile(PROFILE_REF.profileId, PROFILE_REF.profileVersion)).toThrow();
        expect(() => registry.getProfile(PROFILE_REF.profileId, 'latest')).toThrow();
        expect(() => defaults.getProfile(accepted.profile.id, accepted.profile.version)).toThrow();
    });
});

describe('native NIST evaluation through the unchanged generic engine', () => {
    let registry;
    beforeAll(() => { registry = createFrameworkRegistry([createNistFrameworkProfile()]); });

    test('reconciles all 106 independent unit leaves and exact mixed-response arithmetic', () => {
        const input = buildInput();
        input.atomInputs[100].response.optionId = 'partial';
        input.atomInputs[101].response.optionId = 'partial';
        input.atomInputs[102].response.optionId = 'no';
        input.atomInputs[103].response.optionId = 'unknown';
        delete input.atomInputs[104].response;
        input.atomInputs[105].response.optionId = 'not_applicable';
        input.atomInputs[105].applicabilityClaim = { rationaleSha256: '4'.repeat(64) };
        input.atomInputs[0].evidenceState = 'documented_current';
        refreshSnapshots(input);
        const before = copy(input), result = evaluateAssessment(input, { registry });
        expect(result.atoms.map(atom => atom.itemId)).toEqual(CONTROL_IDS.map(id => `${id}-Q1`));
        expect(result.countsCompletion).toMatchObject({ applicableAtoms: 106, yes: 100, partial: 2, no: 1,
            unknown: 3, directUnknown: 1, missing: 1, claimedNotApplicableAtoms: 1, approvedNotApplicableAtoms: 0,
            completionNumerator: 103, completionDenominator: 106, completionPercentTenths: 972 });
        expect(result.attainment).toMatchObject({ lowerCreditUnits: 202, upperCreditUnits: 208,
            denominatorWeight: 106, lowerPercentTenths: 953, upperPercentTenths: 981 });
        expect(result.controls).toHaveLength(106);
        expect(result.domains.map(d => d.attainment.denominatorWeight)).toEqual([31, 21, 22, 11, 13, 8]);
        expect(result.controls.reduce((n, c) => n + c.attainment.lowerCreditUnits, 0)).toBe(202);
        expect(result.domains.reduce((n, d) => n + d.attainment.upperCreditUnits, 0)).toBe(208);
        expect(result.provenance).toMatchObject({ profileRef: PROFILE_REF, scoreAsOf: input.scoreAsOf,
            scopePopulationSha256: input.scopePopulationSha256,
            evidenceSnapshot: input.evidenceSnapshot, riskContextSnapshot: input.riskContextSnapshot });
        expect(result.evidence.substantiatedCoverage.numerator).toBe(1);
        expect(input).toEqual(before);
        input.atomInputs.reverse();
        expect(serialiseAssessmentEvaluation(evaluateAssessment(input, { registry }))).toBe(serialiseAssessmentEvaluation(result));
    });

    test('only a separate trusted exact N/A record removes a native outcome from the denominator', () => {
        const pending = buildInput();
        pending.atomInputs[105].response.optionId = 'not_applicable';
        pending.atomInputs[105].applicabilityClaim = { rationaleSha256: '4'.repeat(64) };
        const pendingResult = evaluateAssessment(pending, { registry });
        expect(pendingResult.attainment).toMatchObject({ denominatorWeight: 106, lowerCreditUnits: 210, upperCreditUnits: 212 });
        const approved = copy(pending), decision = approveLast(approved);
        expectEvaluationFailure(() => evaluateAssessment(approved, { registry }), 'applicability_decision_untrusted');
        const options = { registry, applicabilityDecisionRegistry: { getDecision(hash) {
            expect(hash).toBe(decision.decisionSha256); return copy(decision);
        } } };
        const result = evaluateAssessment(approved, options);
        expect(result.countsCompletion).toMatchObject({ applicableAtoms: 105, approvedNotApplicableAtoms: 1, claimedNotApplicableAtoms: 0 });
        expect(result.attainment).toMatchObject({ denominatorWeight: 105, lowerCreditUnits: 210, upperCreditUnits: 210,
            lowerPercentTenths: 1000, upperPercentTenths: 1000 });
        expect(result.provenance.applicabilityBasisSha256).not.toBe(pendingResult.provenance.applicabilityBasisSha256);
        const changedScope = copy(approved); changedScope.scopePopulationSha256 = '9'.repeat(64);
        expectEvaluationFailure(() => evaluateAssessment(changedScope, options), 'applicability_decision_mismatch');
    });

    test.each([
        ['missing native leaf', value => value.atomInputs.pop(), 'missing_atom_input'],
        ['duplicate native leaf', value => { value.atomInputs[1].itemId = value.atomInputs[0].itemId; }, 'duplicate_atom_input'],
        ['NCSC answer substituted for a native leaf', value => { value.atomInputs[0].itemId = 'NF-NCSC-MCSS-RM-01-Q1'; }, 'unknown_atom_input']
    ])('rejects %s instead of deriving an answer from mappings', (_label, alter, code) => {
        const value = buildInput(); alter(value);
        expectEvaluationFailure(() => evaluateAssessment(value, { registry }), code);
    });

    test.each(['catalogueSha256', 'sourceCatalogueSha256'])('rejects a changed native %s pin', field => {
        const value = buildInput(); value.profileRef[field] = '9'.repeat(64);
        expectEvaluationFailure(() => evaluateAssessment(value, { registry }));
    });

    test('uses the declared score date and does not enter the closed accepted-NCSC adapter', () => {
        const value = buildInput(); value.scoreAsOf = '2026-09-07T23:59:59.999Z';
        expectEvaluationFailure(() => evaluateAssessment(value, { registry }), 'profile_not_yet_effective');
        value.scoreAsOf = '2027-09-03T00:00:00.000Z';
        expectEvaluationFailure(() => evaluateAssessment(value, { registry }), 'framework_snapshot_stale');
        expectEvaluationFailure(() => evaluateAcceptedNcscAssessment(buildInput()));
        expect(evaluateAcceptedNcscAssessment(copy(acceptedFixture.input)).atoms).toHaveLength(14);
    });
});

describe('fixed native publication dependency drift', () => {
    afterEach(() => { jest.dontMock('../api/shared/assessmentEngine/frameworkProfileRegistry'); });

    test.each([
        ['catalogue calculation changes', 'nist_profile_digest_mismatch', actual => ({ ...actual,
            calculateFrameworkProfileSha256: () => '9'.repeat(64) })],
        ['publisher rejects the fixed definition', 'nist_profile_invalid', actual => ({ ...actual,
            publishFrameworkProfile: () => { throw new Error('private source details must not escape'); } })]
    ])('fails closed when %s', (_label, code, replacement) => {
        jest.isolateModules(() => {
            jest.doMock('../api/shared/assessmentEngine/frameworkProfileRegistry', () =>
                replacement(jest.requireActual('../api/shared/assessmentEngine/frameworkProfileRegistry')));
            const isolated = require('../api/shared/assessmentEngine/nistFrameworkProfile');
            expect(isolated.createNistFrameworkProfile).toThrow(expect.objectContaining({ name: 'NistFrameworkProfileError', code }));
            try { isolated.createNistFrameworkProfile(); } catch (error) {
                expect(error).toBeInstanceOf(isolated.NistFrameworkProfileError);
                expect(error.message).not.toContain('private source details');
            }
        });
    });
});
