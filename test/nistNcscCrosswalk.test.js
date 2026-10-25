'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const crosswalkModule = require('../api/shared/assessmentEngine/nistNcscCrosswalk');
const { createNistNcscCrosswalk, NistNcscCrosswalkError } = crosswalkModule;
const { createNistFrameworkProfile } = require('../api/shared/assessmentEngine/nistFrameworkProfile');
const { createAcceptedNcscFrameworkProfile } = require('../api/shared/assessmentEngine/ncscAcceptedFrameworkProfile');
const { calculateFrameworkProfileSha256, createFrameworkRegistry, publishFrameworkProfile } =
    require('../api/shared/assessmentEngine/frameworkProfileRegistry');
const { calculateEvidenceSnapshotSha256, calculateRiskContextSnapshotSha256,
    evaluateAssessment, serialiseAssessmentEvaluation } = require('../api/shared/assessmentEngine/assessmentEvaluator');
const { evaluateAcceptedNcscAssessment } = require('../api/shared/assessmentEngine/ncscAssessmentEvaluator');
const acceptedFixture = require('./fixtures/ncscAcceptedEvaluation.json');

const SOURCE_IDS = `NF-NCSC-MCSS-RM-01 NF-NCSC-MCSS-SA-01 NF-NCSC-MCSS-AI-01 NF-NCSC-MCSS-SC-01
NF-NCSC-MCSS-PA-01 NF-NCSC-MCSS-MF-01 NF-NCSC-MCSS-DU-01 NF-NCSC-MCSS-LP-01 NF-NCSC-MCSS-DR-01
NF-NCSC-MCSS-RP-01 NF-NCSC-CC-PM-01 NF-NCSC-CC-SV-01 NF-NCSC-CC-AC-01 NF-NCSC-CC-NS-01`.split(/\s+/);
// Independent Appendix A physical-page inventory, retaining all numbering gaps.
const IDS_BY_PAGE = {
    21: 'GV.OC-01 GV.OC-02 GV.OC-03 GV.OC-04 GV.OC-05 GV.RM-01 GV.RM-02 GV.RM-03 GV.RM-04 GV.RM-05 GV.RM-06 GV.RM-07',
    22: 'GV.RR-01 GV.RR-02 GV.RR-03 GV.RR-04 GV.PO-01 GV.PO-02 GV.OV-01 GV.OV-02 GV.OV-03 GV.SC-01 GV.SC-02 GV.SC-03 GV.SC-04',
    23: 'GV.SC-05 GV.SC-06 GV.SC-07 GV.SC-08 GV.SC-09 GV.SC-10 ID.AM-01 ID.AM-02 ID.AM-03 ID.AM-04 ID.AM-05 ID.AM-07 ID.AM-08 ID.RA-01',
    24: 'ID.RA-02 ID.RA-03 ID.RA-04 ID.RA-05 ID.RA-06 ID.RA-07 ID.RA-08 ID.RA-09 ID.RA-10 ID.IM-01 ID.IM-02 ID.IM-03 ID.IM-04 PR.AA-01 PR.AA-02 PR.AA-03 PR.AA-04',
    25: 'PR.AA-05 PR.AA-06 PR.AT-01 PR.AT-02 PR.DS-01 PR.DS-02 PR.DS-10 PR.DS-11 PR.PS-01 PR.PS-02 PR.PS-03 PR.PS-04 PR.PS-05 PR.PS-06 PR.IR-01',
    26: 'PR.IR-02 PR.IR-03 PR.IR-04 DE.CM-01 DE.CM-02 DE.CM-03 DE.CM-06 DE.CM-09 DE.AE-02 DE.AE-03 DE.AE-04 DE.AE-06 DE.AE-07 DE.AE-08',
    27: 'RS.MA-01 RS.MA-02 RS.MA-03 RS.MA-04 RS.MA-05 RS.AN-03 RS.AN-06 RS.AN-07 RS.AN-08 RS.CO-02 RS.CO-03 RS.MI-01 RS.MI-02 RC.RP-01',
    28: 'RC.RP-02 RC.RP-03 RC.RP-04 RC.RP-05 RC.RP-06 RC.CO-03 RC.CO-04'
};
const TARGET_IDS = Object.values(IDS_BY_PAGE).flatMap(ids => ids.split(' '));
const PAGE_BY_ID = Object.fromEntries(Object.entries(IDS_BY_PAGE).flatMap(([page, ids]) =>
    ids.split(' ').map(id => [id, Number(page)])));
const POSITIVES = [
    ['NF-NCSC-MCSS-RM-01', 'GV.RM-02 GV.RM-03 GV.RR-02 GV.OV-02'],
    ['NF-NCSC-MCSS-SA-01', 'PR.AT-01 PR.AT-02'],
    ['NF-NCSC-MCSS-AI-01', 'ID.AM-01 ID.AM-02 ID.AM-07 ID.AM-08'],
    ['NF-NCSC-MCSS-SC-01', 'PR.PS-01 ID.RA-07'],
    ['NF-NCSC-MCSS-PA-01', 'PR.PS-02'], ['NF-NCSC-MCSS-MF-01', 'PR.AA-03'],
    ['NF-NCSC-MCSS-DU-01', 'PR.PS-04 DE.CM-09 DE.AE-02'],
    ['NF-NCSC-MCSS-LP-01', 'PR.AA-01 PR.AA-05'],
    ['NF-NCSC-MCSS-DR-01', 'PR.DS-11 PR.IR-03'],
    ['NF-NCSC-MCSS-RP-01', 'GV.RR-02 ID.IM-02 ID.IM-03 ID.IM-04'],
    ['NF-NCSC-CC-PM-01', 'PR.AA-01'], ['NF-NCSC-CC-AC-01', 'PR.PS-05'], ['NF-NCSC-CC-NS-01', 'PR.IR-01']
].flatMap(([source, targets]) => targets.split(' ').map(target => [source, target]));
// Authored explicitly, rather than deriving all no-match claims by subtracting positive links.
const NO_MATCH_TARGETS = `GV.OC-01 GV.OC-02 GV.OC-03 GV.OC-04 GV.OC-05 GV.RM-01 GV.RM-04 GV.RM-05 GV.RM-06 GV.RM-07
GV.RR-01 GV.RR-03 GV.RR-04 GV.PO-01 GV.PO-02 GV.OV-01 GV.OV-03
GV.SC-01 GV.SC-02 GV.SC-03 GV.SC-04 GV.SC-05 GV.SC-06 GV.SC-07 GV.SC-08 GV.SC-09 GV.SC-10
ID.AM-03 ID.AM-04 ID.AM-05 ID.RA-01 ID.RA-02 ID.RA-03 ID.RA-04 ID.RA-05 ID.RA-06 ID.RA-08 ID.RA-09 ID.RA-10 ID.IM-01
PR.AA-02 PR.AA-04 PR.AA-06 PR.DS-01 PR.DS-02 PR.DS-10 PR.PS-03 PR.PS-06 PR.IR-02 PR.IR-04
DE.CM-01 DE.CM-02 DE.CM-03 DE.CM-06 DE.AE-03 DE.AE-04 DE.AE-06 DE.AE-07 DE.AE-08
RS.MA-01 RS.MA-02 RS.MA-03 RS.MA-04 RS.MA-05 RS.AN-03 RS.AN-06 RS.AN-07 RS.AN-08 RS.CO-02 RS.CO-03 RS.MI-01 RS.MI-02
RC.RP-01 RC.RP-02 RC.RP-03 RC.RP-04 RC.RP-05 RC.RP-06 RC.CO-03 RC.CO-04`.split(/\s+/);
const SOURCE_REF = {
    frameworkId: 'nz-ncsc-cyber-security-framework', frameworkVersion: 'beta-verified-2026-09-02',
    profileId: 'nz-ncsc-mcss-2025-v3-sme', profileVersion: '2026-09-02.1',
    catalogueSha256: '32c3f8d154ffe2be9b1270f8fa1234427a05cdea96b231588cce0b147e7d5375',
    sourceCatalogueSha256: '26ccecee78ade16607e5e8c194d585dc47c7921f2eea54b2c76776e0d961b6ee'
};
const TARGET_REF = {
    frameworkId: 'nist-cybersecurity-framework', frameworkVersion: '2.0',
    profileId: 'nf-nist-csf-2-0-core', profileVersion: '2026-09-08.1',
    catalogueSha256: 'ec394a65b11417b67201f96af57a7eabeb284376bb0651b816b40017476b6073',
    sourceCatalogueSha256: 'ab75b51c3561c50cb48cd21b96c01afa2aecafb2efc6b46ae4a8ef8cd753a656'
};
const CROSSWALK_SHA = '61f68fba7bfd3ce9480a0db5f6e4d297bdcf1aff63e80073bffd27dc2abf1e17';
const copy = value => JSON.parse(JSON.stringify(value));
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const keys = value => Object.keys(value).sort();

// This test-side canonical encoder is independent of both fixed module implementations.
function canonical(value) {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort()
        .map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
    return JSON.stringify(value);
}
function assertFrozen(value) {
    if (value === null || typeof value !== 'object') return;
    expect(Object.isFrozen(value)).toBe(true);
    Object.values(value).forEach(assertFrozen);
}
function unansweredNative() {
    const value = copy(acceptedFixture.input);
    value.assessmentId = 'synthetic-independent-native';
    value.scoreAsOf = '2026-09-08T10:00:00.000Z';
    value.profileRef = { ...TARGET_REF };
    value.atomInputs = TARGET_IDS.map(id => ({ itemId: `${id}-Q1`, evidenceState: 'not_provided',
        statedImpact: 'unspecified', priorityOverlay: 'none' }));
    value.evidenceSnapshot.sha256 = calculateEvidenceSnapshotSha256(
        value.atomInputs.map(({ itemId, evidenceState }) => ({ itemId, evidenceState })));
    value.riskContextSnapshot.sha256 = calculateRiskContextSnapshotSha256(
        value.atomInputs.map(({ itemId, statedImpact, priorityOverlay }) => ({ itemId, statedImpact, priorityOverlay })));
    return value;
}

describe('fixed directional NCSC to NIST reference publication', () => {
    let crosswalk, source, target;
    beforeAll(() => {
        crosswalk = createNistNcscCrosswalk();
        source = createAcceptedNcscFrameworkProfile(); target = createNistFrameworkProfile();
    });

    test('pins the closed non-scoring surface, complete publication bytes and domain-separated digest', () => {
        expect(keys(crosswalkModule)).toEqual(['NistNcscCrosswalkError', 'createNistNcscCrosswalk']);
        expect(createNistNcscCrosswalk).toHaveLength(0);
        expect(NistNcscCrosswalkError.prototype).toBeInstanceOf(Error);
        expect(keys(crosswalk)).toEqual(['schemaVersion', 'id', 'version', 'publishedAt', 'direction', 'comparisonBasis',
            'fromProfileRef', 'toProfileRef', 'reviewedSourceQuestionIds', 'reviewedTargetControlIds',
            'provenance', 'statements', 'records', 'crosswalkSha256'].sort());
        expect(crosswalk).toMatchObject({ schemaVersion: 1, id: 'nf-ncsc-to-nist-csf-2-0', version: '2026-09-08.1',
            publishedAt: '2026-09-08', direction: 'ncsc-question-to-nist-outcome',
            comparisonBasis: 'accepted-no-fries-ncsc-question-prompt-to-official-nist-subcategory-outcome',
            fromProfileRef: SOURCE_REF, toProfileRef: TARGET_REF, crosswalkSha256: CROSSWALK_SHA });
        expect(keys(crosswalk.fromProfileRef)).toEqual(keys(SOURCE_REF));
        expect(keys(crosswalk.toProfileRef)).toEqual(keys(TARGET_REF));
        expect(sha256(JSON.stringify(crosswalk, null, 2) + '\n')).toBe(
            '4fd74a503472b531d9a408041c9b11178ae360cebe67a756ec9e754af122e54e');
        const { crosswalkSha256, ...body } = crosswalk;
        expect(sha256('no-fries-nist-ncsc-crosswalk-v1\n' + canonical(body))).toBe(CROSSWALK_SHA);
        expect(sha256(canonical(body))).not.toBe(crosswalkSha256);
        expect(new Set([CROSSWALK_SHA, SOURCE_REF.catalogueSha256, SOURCE_REF.sourceCatalogueSha256,
            TARGET_REF.catalogueSha256, TARGET_REF.sourceCatalogueSha256])).toHaveProperty('size', 5);
    });

    test('retains exactly the 28 reviewed partial pairs and 81 explicit null-side no-match records in order', () => {
        expect(crosswalk.records).toHaveLength(109);
        expect(crosswalk.records.map(r => r.id)).toEqual([
            ...POSITIVES.map(([from, to]) => `${from}--${to}`),
            ...NO_MATCH_TARGETS.map(id => `ALL-NCSC14--${id}`), 'NF-NCSC-CC-SV-01--ALL-NIST106'
        ]);
        expect(crosswalk.records.map(r => r.order)).toEqual(Array.from({ length: 109 }, (_, index) => index + 1));
        expect(crosswalk.records.filter(r => r.relationship === 'partial').map(r => [r.source.controlId, r.target.controlId]))
            .toEqual(POSITIVES);
        expect(crosswalk.records.filter(r => r.relationship === 'exact')).toEqual([]);
        expect(crosswalk.records.filter(r => r.source === null).map(r => r.target.controlId)).toEqual(NO_MATCH_TARGETS);
        expect(crosswalk.records.filter(r => r.target === null).map(r => r.source.controlId)).toEqual(['NF-NCSC-CC-SV-01']);
        expect(new Set(POSITIVES.map(pair => pair[1]))).toHaveProperty('size', 26);
    });

    test('keeps every record a closed typed union with an explicit rationale and partial omissions', () => {
        const pairs = new Set();
        for (const record of crosswalk.records) {
            expect(keys(record)).toEqual(['id', 'order', 'source', 'target', 'relationship', 'rationale', 'omittedTargetScope', 'locators'].sort());
            expect(record.rationale.trim().length).toBeGreaterThan(0);
            for (const endpoint of [record.source, record.target]) {
                if (endpoint !== null) {
                    expect(keys(endpoint)).toEqual(['controlId', 'questionId']);
                    expect(endpoint.questionId).toBe(`${endpoint.controlId}-Q1`);
                }
            }
            if (record.relationship === 'partial') {
                expect(record.source).not.toBeNull(); expect(record.target).not.toBeNull();
                expect(record.omittedTargetScope.length).toBeGreaterThan(0);
                record.omittedTargetScope.forEach(text => expect(text.trim().length).toBeGreaterThan(0));
            } else {
                expect(record.relationship).toBe('no_match');
                expect(Number(record.source === null) + Number(record.target === null)).toBe(1);
                expect(record.omittedTargetScope).toEqual([]);
            }
            const pair = JSON.stringify([record.source, record.target]);
            expect(pairs.has(pair)).toBe(false); pairs.add(pair);
        }
    });

    test('disposes all 14 and 106 reviewed endpoints once without converting unlisted pairs to no-match', () => {
        expect(crosswalk.reviewedSourceQuestionIds).toEqual(SOURCE_IDS.map(id => `${id}-Q1`));
        expect(crosswalk.reviewedTargetControlIds).toEqual(TARGET_IDS);
        expect(source.questions.map(q => q.id)).toEqual(SOURCE_IDS.map(id => `${id}-Q1`));
        expect(target.controls.map(c => c.id)).toEqual(TARGET_IDS);
        for (const [side, ids] of [['source', SOURCE_IDS], ['target', TARGET_IDS]]) {
            for (const id of ids) {
                const records = crosswalk.records.filter(r => r[side] && r[side].controlId === id);
                expect(records.length).toBeGreaterThan(0);
                if (records.some(r => r.relationship === 'partial')) {
                    expect(records.every(r => r.relationship === 'partial')).toBe(true);
                } else {
                    expect(records).toHaveLength(1);
                    expect(records[0].relationship).toBe('no_match');
                }
            }
        }
        // Both endpoints have positive dispositions elsewhere, but this individual pair is unasserted.
        expect(crosswalk.records.some(r => r.source?.controlId === 'NF-NCSC-MCSS-RM-01' && r.target?.controlId === 'PR.AT-01')).toBe(false);
        expect(crosswalk.statements.limitations.join(' ')).toContain('An absent individual source-target pair is unasserted, not implicitly no-match.');
    });

    test('resolves every pointer and physical PDF locator against the real immutable endpoints', () => {
        for (const record of crosswalk.records) {
            expect(keys(record.locators)).toEqual(['sourceQuestionPointer', 'targetReference']);
            if (record.source) {
                const index = SOURCE_IDS.indexOf(record.source.controlId);
                expect(index).toBeGreaterThanOrEqual(0);
                expect(record.locators.sourceQuestionPointer).toBe(`/questions/${index}/prompt`);
                expect(source.questions[index]).toMatchObject({ id: record.source.questionId, controlId: record.source.controlId });
            } else expect(record.locators.sourceQuestionPointer).toBeNull();
            if (record.target) {
                const id = record.target.controlId;
                expect(record.locators.targetReference).toEqual({ sourceId: 'nist-cswp-29-final-2024-02-26',
                    referenceId: id, pdfPage: PAGE_BY_ID[id] });
                const control = target.controls.find(c => c.id === id);
                expect(control.sourceReferences).toEqual([{ sourceId: 'nist-cswp-29-final-2024-02-26', referenceId: id, order: 1 }]);
                expect(target.questions.find(q => q.id === record.target.questionId).controlId).toBe(id);
            } else expect(record.locators.targetReference).toBeNull();
        }
    });

    test('preserves the material editorial limits for incident alternatives, backups and identity proofing', () => {
        const byId = new Map(crosswalk.records.map(r => [r.id, r]));
        expect(byId.get('NF-NCSC-MCSS-RP-01--ID.IM-02').omittedTargetScope).toEqual([
            'The source permits incident lessons alone; it does not require all security tests and exercises or supplier and third-party coordination.'
        ]);
        expect(byId.get('NF-NCSC-MCSS-RP-01--ID.IM-03').omittedTargetScope).toEqual([
            'The source permits exercise lessons alone; improvements from the complete range of actual operational processes, procedures and activities are broader.'
        ]);
        expect(byId.get('NF-NCSC-MCSS-DR-01--PR.DS-11').omittedTargetScope).toEqual([
            'The wider data population and the full maintenance of backups are not expressly covered.'
        ]);
        expect(byId.get('NF-NCSC-CC-SV-01--ALL-NIST106')).toMatchObject({ relationship: 'no_match', target: null });
        expect(byId.get('ALL-NCSC14--PR.AA-02')).toMatchObject({ relationship: 'no_match', source: null });
        expect(crosswalk.statements.limitations.join(' ')).toContain('neither exact nor partial establishes an automatic inverse relationship');
    });

    test('binds exact source observations, all human-readable records and unchanged NCSC reuse limits', () => {
        expect(crosswalk.provenance).toEqual({ author: 'No Fries Limited', authoredAt: '2026-09-08',
            methodVersion: 'prompt-to-outcome-editorial-v1',
            nistSourceUrl: 'https://nvlpubs.nist.gov/nistpubs/CSWP/NIST.CSWP.29.pdf',
            nistSourceVersion: 'CSF 2.0 / CSWP 29 / final / 2024-02-26',
            nistSourceFileSha256: '3c31f46fee98cac0c4323453e5109291a213b4de7fef8c058af9bf67f717433c',
            nistOutcomeTranscriptionSha256: 'd74aec7af57ae8fc7f78b55df698a316cb0bec911b6e3af3a8967c21ad2e4e4c',
            acceptedNcscModuleSha256: '18e0b79f4527c419f09f38be4fa01b083bccbaa310a65f0de1cfdac45769fe58' });
        expect(sha256(fs.readFileSync(path.join(__dirname, '../api/shared/assessmentEngine/ncscAcceptedFrameworkProfile.js'))))
            .toBe(crosswalk.provenance.acceptedNcscModuleSha256);
        expect(crosswalk.statements.attribution).toContain(source.statements.attribution);
        expect(source.sources.find(s => s.id === 'ncsc-minimum-standards-pdf-2025-v3').rightsStatus).toBe('review_required');
        expect(source.statements.limitations.join(' ')).toContain('Paid or customer-facing release');
        expect(crosswalk.statements.limitations.join(' ')).toContain('source-specific rights states and exact-publication legal-review limitation remain unchanged');
        const doc = fs.readFileSync(path.join(__dirname, '../docs/nist-csf-2-crosswalk.md'), 'utf8');
        for (const record of crosswalk.records) expect(doc).toContain(record.id);
        expect(doc).toContain(CROSSWALK_SHA);
    });

    test('returns detached deeply frozen records, endpoints and omissions on repeated construction', () => {
        const again = createNistNcscCrosswalk();
        expect(again).toEqual(crosswalk); expect(again).not.toBe(crosswalk);
        expect(again.records[0]).not.toBe(crosswalk.records[0]);
        expect(again.records[0].source).not.toBe(crosswalk.records[0].source);
        assertFrozen(crosswalk);
        expect(() => { crosswalk.records[0].omittedTargetScope.length = 0; }).toThrow(TypeError);
        expect(() => { crosswalk.fromProfileRef.profileVersion = 'latest'; }).toThrow(TypeError);
        expect(createNistNcscCrosswalk()).toEqual(again);
    });

    test('keeps accepted NCSC output byte-identical while all independent unanswered native atoms remain unknown', () => {
        const input = copy(acceptedFixture.input), originalInput = copy(input);
        const before = serialiseAssessmentEvaluation(evaluateAcceptedNcscAssessment(input));
        const sourceBefore = JSON.stringify(createAcceptedNcscFrameworkProfile());
        const mapped = createNistNcscCrosswalk();
        const registry = createFrameworkRegistry([createAcceptedNcscFrameworkProfile(), createNistFrameworkProfile()]);
        const after = evaluateAssessment(input, { registry });
        expect(serialiseAssessmentEvaluation(after)).toBe(before);
        expect(serialiseAssessmentEvaluation(evaluateAcceptedNcscAssessment(input))).toBe(before);
        expect(JSON.stringify(createAcceptedNcscFrameworkProfile())).toBe(sourceBefore);
        expect(input).toEqual(originalInput);
        // Evaluator order follows the five NCSC domains; pointer order above follows the published questionnaire.
        expect(after.atoms.map(a => a.itemId)).toEqual([
            'NF-NCSC-MCSS-RM-01-Q1', 'NF-NCSC-MCSS-SA-01-Q1', 'NF-NCSC-MCSS-AI-01-Q1',
            'NF-NCSC-MCSS-SC-01-Q1', 'NF-NCSC-MCSS-PA-01-Q1', 'NF-NCSC-MCSS-MF-01-Q1',
            'NF-NCSC-MCSS-LP-01-Q1', 'NF-NCSC-CC-PM-01-Q1', 'NF-NCSC-CC-SV-01-Q1',
            'NF-NCSC-CC-AC-01-Q1', 'NF-NCSC-MCSS-DU-01-Q1', 'NF-NCSC-CC-NS-01-Q1',
            'NF-NCSC-MCSS-DR-01-Q1', 'NF-NCSC-MCSS-RP-01-Q1'
        ]);
        expect(after.attainment).toMatchObject({ denominatorWeight: 14, lowerCreditUnits: 13, upperCreditUnits: 17 });
        expect(mapped.records.filter(r => r.source?.questionId === 'NF-NCSC-MCSS-RM-01-Q1')).toHaveLength(4);
        const native = evaluateAssessment(unansweredNative(), { registry });
        expect(native.atoms.map(a => a.itemId)).toEqual(TARGET_IDS.map(id => `${id}-Q1`));
        expect(native.countsCompletion).toMatchObject({ applicableAtoms: 106, unknown: 106, missing: 106, completionNumerator: 0 });
        expect(native.attainment).toMatchObject({ denominatorWeight: 106, lowerCreditUnits: 0, upperCreditUnits: 212 });
        expect(native.evidence.providedCoverage.numerator).toBe(0);
        expect(native.provenance.profileRef).toEqual(TARGET_REF);
        const borrowed = copy(input); borrowed.profileRef = { ...TARGET_REF }; borrowed.scoreAsOf = '2026-09-08T10:00:00.000Z';
        expect(() => evaluateAssessment(borrowed, { registry })).toThrow(expect.objectContaining({ code: 'unknown_atom_input' }));
        expect(mapped).not.toHaveProperty('atomInputs');
        expect(mapped).not.toHaveProperty('score');
        expect(mapped).not.toHaveProperty('combinedDenominator');
    });
});

describe('crosswalk fixed endpoint dependency drift', () => {
    const dependencies = {
        source: ['../api/shared/assessmentEngine/ncscAcceptedFrameworkProfile', 'createAcceptedNcscFrameworkProfile'],
        target: ['../api/shared/assessmentEngine/nistFrameworkProfile', 'createNistFrameworkProfile']
    };
    afterEach(() => {
        jest.dontMock('../api/shared/assessmentEngine/ncscAcceptedFrameworkProfile');
        jest.dontMock('../api/shared/assessmentEngine/nistFrameworkProfile');
    });

    function rejectsEndpoint(side, mutate) {
        const [modulePath, exportName] = dependencies[side];
        jest.isolateModules(() => {
            jest.doMock(modulePath, () => {
                const actual = jest.requireActual(modulePath);
                return { ...actual, [exportName]: () => mutate(copy(actual[exportName]())) };
            });
            const isolated = require('../api/shared/assessmentEngine/nistNcscCrosswalk');
            expect(isolated.createNistNcscCrosswalk).toThrow(expect.objectContaining({
                name: 'NistNcscCrosswalkError', code: 'crosswalk_profile_mismatch'
            }));
            try { isolated.createNistNcscCrosswalk(); } catch (error) {
                expect(error).toBeInstanceOf(isolated.NistNcscCrosswalkError);
                expect(error.message).not.toContain('private dependency content');
            }
        });
    }

    test.each(['source', 'target'].flatMap(side => Object.keys(SOURCE_REF).map(field => [side, field])))(
        'refuses changed %s endpoint %s without a fallback version', (side, field) => {
            rejectsEndpoint(side, value => {
                if (field === 'frameworkId') value.framework.id = 'different-framework';
                else if (field === 'frameworkVersion') value.framework.version = 'different-version';
                else if (field === 'profileId') value.profile.id = 'different-profile';
                else if (field === 'profileVersion') value.profile.version = 'different-version';
                else value[field] = '9'.repeat(64);
                return value;
            });
        });

    test.each(['source', 'target'])('refuses %s prompt drift even when the dependency reports original pins', side => {
        rejectsEndpoint(side, value => { value.questions[0].prompt = 'Changed exact compared prompt'; return value; });
    });

    test.each(['source', 'target'])('refuses a validly republished but different %s edition', side => {
        rejectsEndpoint(side, value => {
            value.profile.version = '2026-09-08.2';
            delete value.catalogueSha256;
            value.catalogueSha256 = calculateFrameworkProfileSha256(value);
            return publishFrameworkProfile(value);
        });
    });

    test.each(['source', 'target'])('reports a safe fixed failure if the %s publication cannot be constructed', side => {
        rejectsEndpoint(side, () => { throw new Error('private dependency content'); });
    });
});
