'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { MODULE_ID, ACCEPTED_PROFILE_REF, evaluateAcceptedNcscAssessment } = require('../api/shared/assessmentEngine/ncscAssessmentEvaluator');
const { AssessmentEvaluationError, calculateApplicabilityDecisionSha256, calculateEvidenceSnapshotSha256,
    calculateRiskContextSnapshotSha256, evaluateAssessment, serialiseAssessmentEvaluation } = require('../api/shared/assessmentEngine/assessmentEvaluator');
const { createFrameworkRegistry } = require('../api/shared/assessmentEngine/frameworkProfileRegistry');
const { createAcceptedNcscFrameworkProfile } = require('../api/shared/assessmentEngine/ncscAcceptedFrameworkProfile');
const { getDefaultFrameworkRegistry } = require('../api/shared/assessmentEngine/ncscFrameworkProfile');
const fixture = require('./fixtures/ncscAcceptedEvaluation.json');
const approvedGoldens = require('./fixtures/assessmentEvaluatorGolden.json');
const legacy = require('../examples/ncsc-sme-gap-assessment.json');
const copy = value => JSON.parse(JSON.stringify(value));
const input = () => copy(fixture.input);

function expectFailure(fn, code) {
    try { fn(); } catch (error) {
        expect(error).toBeInstanceOf(AssessmentEvaluationError);
        if (code) expect(error.code).toBe(code);
        return;
    }
    throw new Error('Expected a closed assessment failure');
}
function refreshSnapshots(value) {
    value.evidenceSnapshot.sha256 = calculateEvidenceSnapshotSha256(value.atomInputs.map(({ itemId, evidenceState }) => ({ itemId, evidenceState })));
    value.riskContextSnapshot.sha256 = calculateRiskContextSnapshotSha256(value.atomInputs.map(({ itemId, statedImpact, priorityOverlay }) => ({ itemId, statedImpact, priorityOverlay })));
}
function approve(value, itemId) {
    const atom = value.atomInputs.find(item => item.itemId === itemId);
    atom.response = { optionId: 'not_applicable' };
    atom.applicabilityClaim = { rationaleSha256: '4'.repeat(64) };
    const core = { decisionId: 'decision-' + itemId, decisionRevision: 'decision-rev-1',
        organisationId: value.organisationId, moduleId: value.moduleId, assessmentId: value.assessmentId,
        assessmentRevision: value.assessmentRevision, itemId, frameworkId: value.profileRef.frameworkId,
        frameworkVersion: value.profileRef.frameworkVersion, profileId: value.profileRef.profileId,
        profileVersion: value.profileRef.profileVersion, catalogueSha256: value.profileRef.catalogueSha256,
        scopePopulationSha256: value.scopePopulationSha256, status: 'approved', rationaleSha256: '4'.repeat(64),
        approvedBy: 'synthetic-reviewer-1', approvedAt: '2026-09-07T09:00:00.000Z' };
    atom.applicabilityDecision = { ...core, decisionSha256: calculateApplicabilityDecisionSha256(core) };
    return copy(atom.applicabilityDecision);
}
function trustedOptions(decisions) {
    const saved = new Map(decisions.map(value => [value.decisionSha256, copy(value)]));
    return { applicabilityDecisionRegistry: { getDecision(hash) {
        if (!saved.has(hash)) throw new Error('No trusted decision');
        return copy(saved.get(hash));
    } } };
}
function approvedInput() {
    const value = input();
    const decision = approve(value, 'NF-NCSC-CC-NS-01-Q1');
    return { value, options: trustedOptions([decision]) };
}
function verifyGolden(result, golden) {
    const counts = ['applicableAtoms', 'approvedNotApplicableAtoms', 'claimedNotApplicableAtoms', 'yes', 'partial', 'no',
        'unknown', 'directUnknown', 'missing', 'completionNumerator', 'completionDenominator', 'completionPercentTenths'];
    for (const key of counts) expect(result.countsCompletion[key]).toBe(golden[key]);
    for (const key of ['lowerCreditUnits', 'upperCreditUnits', 'denominatorWeight', 'lowerPercentTenths', 'upperPercentTenths']) {
        expect(result.attainment[key]).toBe(golden[key]);
    }
    expect(result.evidence.providedCoverage.numerator).toBe(golden.providedEvidenceNumerator);
    expect(result.evidence.providedCoverage.percentTenths).toBe(golden.providedEvidencePercentTenths);
    expect(result.evidence.substantiatedCoverage.numerator).toBe(0);
    expect(result.evidence.testedCoverage.numerator).toBe(0);
}

describe('accepted NCSC profile evaluator adapter', () => {
    test('pins the literal accepted tuple, source digest and Cyber Security module', () => {
        expect(ACCEPTED_PROFILE_REF).toEqual(fixture.input.profileRef);
        expect(Object.isFrozen(ACCEPTED_PROFILE_REF)).toBe(true);
        expect(MODULE_ID).toBe('cyber_security');
        const result = evaluateAcceptedNcscAssessment(input());
        expect(result.provenance).toMatchObject({ evaluatorId: 'no-fries-deterministic-assessment-evaluator',
            evaluatorVersion: '2026-09-02.1', evaluatorSourceSha256: 'd27f39d71d191fc8ca63eb1c4f4df7ab2368a72732894f120ab5bc8500eddb9e',
            scoreContractVersion: 'PROD-003-R1', roundingRule: 'decimal-half-up-one-place-v1',
            organisationId: 'synthetic-harbour-services', moduleId: 'cyber_security',
            profileRef: fixture.input.profileRef });
    });

    test('preserves independently reauthored legacy question/response intent without treating legacy JSON as current authority', () => {
        const pairs = fixture.input.atomInputs.map(atom => [atom.itemId, atom.response.optionId]);
        expect(pairs).toHaveLength(14);
        for (const [id, response] of pairs) expect(legacy.responses[id.replace(/-Q1$/, '')].response).toBe(response);
        expectFailure(() => evaluateAcceptedNcscAssessment(legacy));
        expect(legacy.profileVersion).toBe('2026-08-31.1');
    });

    test('pending N/A has independent 13/28–17/28 attainment and 12/14 completion goldens', () => {
        const result = evaluateAcceptedNcscAssessment(input());
        verifyGolden(result, fixture.expected.pending);
        expect(result.attainment.lowerDisplay).toBe('46.4%');
        expect(result.attainment.upperDisplay).toBe('60.7%');
        expect(result.countsCompletion.completionDisplay).toBe('85.7%');
        expect(result.atoms.find(atom => atom.itemId === 'NF-NCSC-CC-NS-01-Q1')).toMatchObject({
            applicable: true, response: 'unknown', responseOrigin: 'claimed_not_applicable' });
    });

    test('trusted exact N/A decision reproduces approved PROD-003 example A literal goldens', () => {
        const { value, options } = approvedInput();
        const result = evaluateAcceptedNcscAssessment(value, options);
        expect(result.countsCompletion).toEqual(approvedGoldens.prod003ExampleA.countsCompletion);
        expect(result.attainment).toEqual(approvedGoldens.prod003ExampleA.attainment);
        verifyGolden(result, fixture.expected.approved);
        expect(result.evidence.distribution).toMatchObject({ attested: 11, not_provided: 2 });
        expect(result.evidence.providedCoverage.display).toBe('84.6%');
        expect(result.domains.find(domain => domain.domainId === 'detect-contain').attainment).toMatchObject({
            lowerCreditUnits: 1, upperCreditUnits: 1, denominatorWeight: 1, lowerPercentTenths: 500, upperPercentTenths: 500 });
    });

    test('five domain totals follow literal mapping and are rebuilt from fourteen single-counted unit leaves', () => {
        const result = evaluateAcceptedNcscAssessment(input());
        expect(result.atoms).toHaveLength(14); expect(result.controls).toHaveLength(14); expect(result.domains).toHaveLength(5);
        expect(new Set(result.atoms.map(atom => atom.itemId)).size).toBe(14);
        for (const expected of fixture.expected.pendingDomainTotals) {
            const actual = result.domains.find(domain => domain.domainId === expected.domainId);
            expect(actual.countsCompletion.applicableAtoms).toBe(expected.applicableAtoms);
            const { domainId, applicableAtoms, ...attainment } = expected;
            expect(actual.attainment).toMatchObject(attainment);
        }
        for (const field of ['lowerCreditUnits', 'upperCreditUnits', 'denominatorWeight']) {
            expect(result.domains.reduce((sum, domain) => sum + domain.attainment[field], 0)).toBe(result.attainment[field]);
            expect(result.controls.reduce((sum, control) => sum + control.attainment[field], 0)).toBe(result.attainment[field]);
        }
        expect(result.atoms.every(atom => atom.weight === 1)).toBe(true);
    });

    test('omitted response is missing while an omitted question envelope fails closed', () => {
        const value = input(); delete value.atomInputs.find(atom => atom.itemId === 'NF-NCSC-CC-AC-01-Q1').response;
        const result = evaluateAcceptedNcscAssessment(value);
        expect(result.countsCompletion).toMatchObject({ missing: 1, directUnknown: 0, unknown: 2, claimedNotApplicableAtoms: 1 });
        expect(result.attainment).toEqual(evaluateAcceptedNcscAssessment(input()).attainment);
        value.atomInputs.pop(); expectFailure(() => evaluateAcceptedNcscAssessment(value));
    });

    test('all missing stays 0–100% provisional; all trusted exclusions return Not scored and null percentages', () => {
        const missing = input(); missing.atomInputs.forEach(atom => { delete atom.response; delete atom.applicabilityClaim; });
        const unresolved = evaluateAcceptedNcscAssessment(missing);
        expect(unresolved.countsCompletion).toMatchObject({ applicableAtoms: 14, unknown: 14, missing: 14, completionPercentTenths: 0 });
        expect(unresolved.attainment).toMatchObject({ lowerCreditUnits: 0, upperCreditUnits: 28, denominatorWeight: 14, lowerDisplay: '0.0%', upperDisplay: '100.0%' });
        const excluded = input(), decisions = excluded.atomInputs.map(atom => approve(excluded, atom.itemId));
        const result = evaluateAcceptedNcscAssessment(excluded, trustedOptions(decisions));
        expect(result.attainment).toMatchObject({ status: 'not_scored', denominatorWeight: 0, lowerPercentTenths: null, upperPercentTenths: null });
        expect(result.countsCompletion).toMatchObject({ applicableAtoms: 0, approvedNotApplicableAtoms: 14, completionStatus: 'not_scored', completionPercentTenths: null });
        expect(result.evidence.providedCoverage).toMatchObject({ numerator: 0, denominator: 0, percentTenths: null });
    });

    test('changing evidence, impact and Critical Controls overlay leaves attainment and completion unchanged', () => {
        const first = evaluateAcceptedNcscAssessment(input()), changed = input();
        changed.atomInputs.forEach(atom => { atom.evidenceState = 'tested_or_observed_current'; atom.statedImpact = 'critical'; atom.priorityOverlay = 'critical_controls'; });
        refreshSnapshots(changed);
        const second = evaluateAcceptedNcscAssessment(changed);
        expect(second.attainment).toEqual(first.attainment); expect(second.countsCompletion).toEqual(first.countsCompletion);
        expect(second.evidence.testedCoverage).toMatchObject({ numerator: 14, denominator: 14, percentTenths: 1000 });
        expect(second.remediationPriority).toEqual({ status: 'not_calculated', reason: 'priority_adapter_required' });
        expect(second.trend).toEqual({ status: 'not_requested' });
    });

    test('stale evidence stays distinct and gives no current coverage credit', () => {
        const value = input(); value.atomInputs.forEach(atom => { atom.evidenceState = 'stale'; }); refreshSnapshots(value);
        const result = evaluateAcceptedNcscAssessment(value);
        expect(result.evidence.distribution.stale).toBe(14);
        expect(result.evidence.providedCoverage.percentTenths).toBe(0);
        expect(result.attainment.lowerPercentTenths).toBe(464);
    });

    test('approved exclusion needs a separately trusted record; a caller-computed digest is insufficient', () => {
        const { value } = approvedInput();
        expectFailure(() => evaluateAcceptedNcscAssessment(value));
        expectFailure(() => evaluateAcceptedNcscAssessment(value, trustedOptions([])));
        const decision = value.atomInputs.find(atom => atom.applicabilityDecision).applicabilityDecision;
        const record = copy(decision); record.approvedBy = 'different-reviewer';
        expectFailure(() => evaluateAcceptedNcscAssessment(value, trustedOptions([record])));
    });

    test.each(['organisationId', 'moduleId', 'assessmentId', 'assessmentRevision', 'scopePopulationSha256'])(
        'a previously trusted N/A record cannot be replayed across %s', field => {
            const { value, options } = approvedInput();
            value[field] = field === 'scopePopulationSha256' ? '9'.repeat(64) : 'different-scope';
            expectFailure(() => evaluateAcceptedNcscAssessment(value, options));
        });

    test.each(['frameworkId', 'frameworkVersion', 'profileId', 'profileVersion', 'catalogueSha256', 'sourceCatalogueSha256'])(
        'exact accepted profile refuses changed %s', field => {
            const value = input(); value.profileRef[field] = field.endsWith('Sha256') ? '9'.repeat(64) : 'different-version';
            expectFailure(() => evaluateAcceptedNcscAssessment(value));
        });

    test('historical profile, latest aliases, omitted source digest and foreign module are never inferred or upgraded', () => {
        for (const version of ['2026-08-31.1', 'latest', '2026-09-02.2']) {
            const value = input(); value.profileRef.profileVersion = version; expectFailure(() => evaluateAcceptedNcscAssessment(value));
        }
        const noDigest = input(); delete noDigest.profileRef.sourceCatalogueSha256; expectFailure(() => evaluateAcceptedNcscAssessment(noDigest));
        for (const module of ['ai_governance', 'it_optimisation', 'Cyber_Security']) {
            const value = input(); value.moduleId = module; expectFailure(() => evaluateAcceptedNcscAssessment(value), 'ncsc_module_unsupported');
        }
    });

    test('registry overrides, unexpected options, accessors and proxies cannot select a profile', () => {
        expectFailure(() => evaluateAcceptedNcscAssessment(input(), { registry: getDefaultFrameworkRegistry() }), 'ncsc_options_invalid');
        expectFailure(() => evaluateAcceptedNcscAssessment(input(), { latest: true }), 'ncsc_options_invalid');
        let reads = 0;
        const options = {}; Object.defineProperty(options, 'applicabilityDecisionRegistry', { enumerable: true, get() { reads += 1; return {}; } });
        expectFailure(() => evaluateAcceptedNcscAssessment(input(), options), 'ncsc_options_invalid'); expect(reads).toBe(0);
        expectFailure(() => evaluateAcceptedNcscAssessment(input(), new Proxy({}, { ownKeys() { throw new Error('proxy executed'); } })), 'ncsc_options_invalid');
    });

    test('tampered evidence/risk bodies, duplicate questions and input accessors retain generic fail-closed behaviour', () => {
        const evidence = input(); evidence.atomInputs[0].evidenceState = 'documented_current'; expectFailure(() => evaluateAcceptedNcscAssessment(evidence));
        const risk = input(); risk.atomInputs[0].statedImpact = 'low'; expectFailure(() => evaluateAcceptedNcscAssessment(risk));
        const duplicate = input(); duplicate.atomInputs.push(copy(duplicate.atomInputs[0])); expectFailure(() => evaluateAcceptedNcscAssessment(duplicate));
        let reads = 0; const accessor = input(); Object.defineProperty(accessor, 'moduleId', { get() { reads += 1; return 'cyber_security'; } });
        expectFailure(() => evaluateAcceptedNcscAssessment(accessor)); expect(reads).toBe(0);
    });

    test('profile temporal boundaries use only supplied score time and retain recorded publication-date semantics', () => {
        const value = input(); value.scoreAsOf = '2025-10-29T23:59:59.999Z';
        expectFailure(() => evaluateAcceptedNcscAssessment(value), 'profile_not_yet_effective');
        value.scoreAsOf = '2025-10-30T00:00:00.000Z'; expect(evaluateAcceptedNcscAssessment(value).attainment.lowerPercentTenths).toBe(464);
        value.scoreAsOf = '2027-08-31T23:59:59.999Z'; expect(evaluateAcceptedNcscAssessment(value).attainment.lowerPercentTenths).toBe(464);
        value.scoreAsOf = '2027-09-01T00:00:00.000Z'; expectFailure(() => evaluateAcceptedNcscAssessment(value), 'framework_snapshot_stale');
    });

    test('delegation preserves exact generic result/provenance/digest and is immutable and order-independent', () => {
        const value = input(), before = copy(value);
        const registry = createFrameworkRegistry([createAcceptedNcscFrameworkProfile()]);
        const direct = evaluateAssessment(value, { registry }), result = evaluateAcceptedNcscAssessment(value);
        expect(result).toEqual(direct); expect(value).toEqual(before); expect(Object.isFrozen(result)).toBe(true);
        expect(Object.isFrozen(result.atoms[0])).toBe(true); expect(Object.isFrozen(result.provenance.profileRef)).toBe(true);
        value.atomInputs.reverse();
        expect(serialiseAssessmentEvaluation(evaluateAcceptedNcscAssessment(value))).toBe(serialiseAssessmentEvaluation(result));
        expect(evaluateAcceptedNcscAssessment(value).outputSha256).toBe(result.outputSha256);
        expect(() => getDefaultFrameworkRegistry().getProfile('nz-ncsc-mcss-2025-v3-sme', '2026-09-02.1')).toThrow();
    });

    test('generic evaluator and literal source digests remain pinned and unchanged', () => {
        const source = fs.readFileSync(path.join(__dirname, '../api/shared/assessmentEngine/assessmentEvaluator.js'));
        expect(crypto.createHash('sha256').update(source).digest('hex')).toBe('d27f39d71d191fc8ca63eb1c4f4df7ab2368a72732894f120ab5bc8500eddb9e');
        expect(createAcceptedNcscFrameworkProfile().catalogueSha256).toBe('32c3f8d154ffe2be9b1270f8fa1234427a05cdea96b231588cce0b147e7d5375');
    });

    test('isolated evaluation works with network and tenant/provider modules denied and no wall-clock/random access', () => {
        const script = `const Module=require('module');const original=Module._load;
            Module._load=function(name,...rest){if(/^(node:)?(https?|net|tls|dns)$|tenantAccess|appTenantAccess|serviceDesk|@azure|openai|undici/.test(name))throw new Error('forbidden dependency');return original.call(this,name,...rest);};
            const adapter=require('./api/shared/assessmentEngine/ncscAssessmentEvaluator');
            const fixture=require('./test/fixtures/ncscAcceptedEvaluation.json');
            Date.now=()=>{throw new Error('clock read');};Math.random=()=>{throw new Error('random read');};
            const result=adapter.evaluateAcceptedNcscAssessment(fixture.input);process.stdout.write(JSON.stringify(result.attainment));`;
        const run = spawnSync(process.execPath, ['-e', script], { cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 10000 });
        expect(run.status).toBe(0);
        expect(JSON.parse(run.stdout)).toMatchObject({ lowerPercentTenths: 464, upperPercentTenths: 607 });
    });
});
