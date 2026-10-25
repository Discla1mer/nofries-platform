'use strict';

const crypto = require('node:crypto');
const { createTenantAggregate } = require('../api/shared/appLifecycle/tenantDomain');
const { createAssessment, applyAssessmentCommand } = require('../api/shared/assessmentLifecycle/assessmentDomain');
const { acceptedRegistry, acceptedProfile, hashNcscRecord, validateNcscSupportingRecords,
    buildNcscSubmission } = require('../api/shared/assessmentLifecycle/ncscAssessmentSubmission');
const { MODULE_ID, ACCEPTED_PROFILE_REF, evaluateAcceptedNcscAssessment } = require('../api/shared/assessmentEngine/ncscAssessmentEvaluator');
const { calculateEvidenceSnapshotSha256, calculateRiskContextSnapshotSha256,
    serialiseAssessmentEvaluation } = require('../api/shared/assessmentEngine/assessmentEvaluator');

const ACTOR = '10000000-0000-4000-8000-000000000000:10000000-0000-4000-8000-000000000001';
const OTHER_ACTOR = '10000000-0000-4000-8000-000000000000:10000000-0000-4000-8000-000000000002';
const CREATED_AT = '2026-09-07T08:00:00.000Z';
const SAVED_AT = '2026-09-07T09:00:00.000Z';
const SUBMITTED_AT = '2026-09-07T10:00:00.000Z';
const OWNER = { tenantId: 'synthetic-tenant', organisationId: 'synthetic-org', assessmentId: 'synthetic-assessment' };
const NA_ID = 'NF-NCSC-CC-NS-01-Q1';
// Literal accepted response intent and hand-counted PROD-003-R1 half-unit totals.
const MATRIX = [
    ['NF-NCSC-MCSS-RM-01-Q1', 'partial', 'attested', 'high'],
    ['NF-NCSC-MCSS-SA-01-Q1', 'yes', 'attested', 'medium'],
    ['NF-NCSC-MCSS-AI-01-Q1', 'partial', 'attested', 'high'],
    ['NF-NCSC-MCSS-SC-01-Q1', 'partial', 'attested', 'medium'],
    ['NF-NCSC-MCSS-PA-01-Q1', 'yes', 'attested', 'high'],
    ['NF-NCSC-MCSS-MF-01-Q1', 'yes', 'attested', 'critical'],
    ['NF-NCSC-MCSS-DU-01-Q1', 'partial', 'attested', 'high'],
    ['NF-NCSC-MCSS-LP-01-Q1', 'partial', 'attested', 'medium'],
    ['NF-NCSC-MCSS-DR-01-Q1', 'partial', 'attested', 'high'],
    ['NF-NCSC-MCSS-RP-01-Q1', 'no', 'attested', 'high'],
    ['NF-NCSC-CC-PM-01-Q1', 'no', 'not_provided', 'high'],
    ['NF-NCSC-CC-SV-01-Q1', 'partial', 'attested', 'critical'],
    ['NF-NCSC-CC-AC-01-Q1', 'unknown', 'not_provided', 'high'],
    [NA_ID, 'not_applicable', 'not_provided', 'low']
];
const copy = value => JSON.parse(JSON.stringify(value));
function record(kind, fields) {
    const core = { schemaVersion: 1, ...OWNER, recordedRevision: 0, recordedAt: CREATED_AT, ...fields };
    return { ...core, sha256: hashNcscRecord(kind, core) };
}
function rehash(kind, value) {
    const { sha256, ...core } = value;
    value.sha256 = hashNcscRecord(kind, core);
}
function tenant() {
    return createTenantAggregate({ tenant: { tenantId: OWNER.tenantId, displayName: 'Synthetic tenant' },
        organisations: [{ tenantId: OWNER.tenantId, organisationId: OWNER.organisationId, displayName: 'Synthetic organisation' }] });
}
function fixture(status = 'submitted') {
    const aggregate = tenant();
    const scopePopulation = record('scope', { actorSubjectKey: ACTOR,
        body: { description: '  Synthetic office and cloud systems.\nIncludes externally facing services.  ' } });
    const evidence = record('evidence', { profileRef: copy(ACCEPTED_PROFILE_REF), scopePopulationSha256: scopePopulation.sha256,
        entries: MATRIX.map(([itemId, , evidenceState]) => ({ itemId, evidenceState })) });
    const risk = record('risk', { profileRef: copy(ACCEPTED_PROFILE_REF), scopePopulationSha256: scopePopulation.sha256,
        entries: MATRIX.map(([itemId, , , statedImpact]) => ({ itemId, statedImpact, priorityOverlay: 'none' })) });
    let state = createAssessment(aggregate, { ...OWNER, action: 'create',
        payload: { moduleId: MODULE_ID, profileRef: ACCEPTED_PROFILE_REF, scopePopulationSha256: scopePopulation.sha256 },
        expectedRevision: null, actorSubjectKey: ACTOR, now: CREATED_AT, idempotencyKey: 'create-a' }, acceptedRegistry);
    const rationales = status === 'created' ? [] : [record('rationale', { recordedRevision: 1,
        recordedAt: SAVED_AT, actorSubjectKey: ACTOR, itemId: NA_ID,
        body: { text: '  Synthetic claim pending independent review.\nNo approval is asserted.  ' } })];
    if (status !== 'created') {
        state = applyAssessmentCommand(state, aggregate, { ...OWNER, action: 'save', expectedRevision: 0,
            actorSubjectKey: ACTOR, now: SAVED_AT, idempotencyKey: 'save-a', payload: {
                responses: MATRIX.map(([itemId, optionId]) => ({ itemId, optionId,
                    applicabilityRationaleSha256: itemId === NA_ID ? rationales[0].sha256 : null })) } }, acceptedRegistry);
    }
    if (status === 'submitted') {
        state = applyAssessmentCommand(state, aggregate, { ...OWNER, action: 'submit', expectedRevision: 1,
            actorSubjectKey: ACTOR, now: SUBMITTED_AT, idempotencyKey: 'submit-a', payload: {} }, acceptedRegistry);
    }
    return { schemaVersion: 1, ...OWNER, revision: state.revision, state: copy(state),
        scopePopulation, rationales, evidence, risk, submission: null };
}
function invalid(fn) {
    expect(fn).toThrow(expect.objectContaining({ code: 'ncsc_record_invalid', statusCode: 503 }));
}

describe('retained NCSC submission mapping', () => {
    test('factory registry pins the exact accepted profile and fourteen literal question IDs', () => {
        expect(acceptedProfile.questions.map(question => question.id).sort()).toEqual(MATRIX.map(([id]) => id).sort());
        expect(acceptedProfile.catalogueSha256).toBe('32c3f8d154ffe2be9b1270f8fa1234427a05cdea96b231588cce0b147e7d5375');
        expect(acceptedProfile.sourceCatalogueSha256).toBe('26ccecee78ade16607e5e8c194d585dc47c7921f2eea54b2c76776e0d961b6ee');
        expect(acceptedRegistry.getProfile('nz-ncsc-mcss-2025-v3-sme', '2026-09-02.1')).toEqual(acceptedProfile);
        expect(() => acceptedRegistry.getProfile('nz-ncsc-mcss-2025-v3-sme', '2026-08-31.1')).toThrow();
        expect(Object.isFrozen(acceptedRegistry)).toBe(true);
        expect(Object.isFrozen(acceptedProfile.questions[0])).toBe(true);
    });

    test('maps all response, evidence and risk facts with exact sealed revision/time and original provenance', () => {
        const source = fixture(), result = buildNcscSubmission(source), { input, evaluation } = result;
        expect(Object.keys(result).sort()).toEqual(['evaluation', 'input']);
        expect(input).toMatchObject({ schemaVersion: 1, scoreContractVersion: 'PROD-003-R1',
            organisationId: OWNER.organisationId, assessmentId: OWNER.assessmentId, moduleId: 'cyber_security',
            assessmentRevision: 'rev-2', scoreAsOf: SUBMITTED_AT, profileRef: ACCEPTED_PROFILE_REF,
            scopePopulationSha256: source.scopePopulation.sha256 });
        expect(input.atomInputs.map(atom => [atom.itemId, atom.response.optionId, atom.evidenceState, atom.statedImpact]).sort())
            .toEqual(copy(MATRIX).sort());
        expect(input.atomInputs).toHaveLength(14);
        expect(input.atomInputs.every(atom => atom.priorityOverlay === 'none')).toBe(true);
        expect(input.evidenceSnapshot).toEqual({ id: `evidence-${source.evidence.sha256}`,
            sha256: 'd3a2b80b74c489c8f66883cf2b8ac3d4c97bc4ee50960b4b7a2f8a6a0fe9d558' });
        expect(input.riskContextSnapshot).toEqual({ id: `risk-${source.risk.sha256}`,
            sha256: '24406ad7610ada725885db43dd6f374fa084eac283122def31dc6ec73190ce7c' });
        expect(evaluation.provenance).toMatchObject({ assessmentRevision: 'rev-2', scoreAsOf: SUBMITTED_AT,
            organisationId: OWNER.organisationId, assessmentId: OWNER.assessmentId, profileRef: ACCEPTED_PROFILE_REF,
            evaluatorSourceSha256: 'd27f39d71d191fc8ca63eb1c4f4df7ab2368a72732894f120ab5bc8500eddb9e' });
        expect(evaluation).toEqual(evaluateAcceptedNcscAssessment(input));
        expect(JSON.parse(serialiseAssessmentEvaluation(evaluation))).toEqual(evaluation);
    });

    test('pending N/A remains unknown with literal 13/28–17/28 attainment and 12/14 completion', () => {
        const source = fixture(), { input, evaluation } = buildNcscSubmission(source);
        expect(input.atomInputs.find(atom => atom.itemId === NA_ID)).toMatchObject({
            response: { optionId: 'not_applicable' }, applicabilityClaim: { rationaleSha256: source.rationales[0].sha256 } });
        expect(input.atomInputs.every(atom => !Object.hasOwn(atom, 'applicabilityDecision'))).toBe(true);
        expect(evaluation.countsCompletion).toMatchObject({ applicableAtoms: 14, approvedNotApplicableAtoms: 0,
            claimedNotApplicableAtoms: 1, yes: 3, partial: 7, no: 2, unknown: 2, directUnknown: 1, missing: 0,
            completionNumerator: 12, completionDenominator: 14, completionPercentTenths: 857 });
        expect(evaluation.attainment).toMatchObject({ lowerCreditUnits: 13, upperCreditUnits: 17,
            denominatorWeight: 14, lowerPercentTenths: 464, upperPercentTenths: 607 });
        expect(evaluation.atoms.find(atom => atom.itemId === NA_ID)).toMatchObject({ applicable: true,
            response: 'unknown', responseOrigin: 'claimed_not_applicable' });
        expect(evaluation.evidence.providedCoverage).toMatchObject({ numerator: 11, denominator: 14, percentTenths: 786 });
        expect(evaluation.domains.map(domain => [domain.domainId, domain.attainment.lowerCreditUnits,
            domain.attainment.upperCreditUnits, domain.attainment.denominatorWeight]).sort()).toEqual([
            ['guide-govern', 3, 3, 2], ['identify-understand', 1, 1, 1], ['prevent-protect', 7, 9, 7],
            ['detect-contain', 1, 3, 2], ['respond-recover', 1, 1, 2]
        ].sort());
    });

    test('changing explicit evidence and risk preserves independent attainment/completion lanes', () => {
        const first = buildNcscSubmission(fixture()), changed = fixture();
        changed.evidence.entries.forEach(entry => { entry.evidenceState = 'tested_or_observed_current'; });
        changed.risk.entries.forEach(entry => { entry.statedImpact = 'critical'; entry.priorityOverlay = 'critical_controls'; });
        rehash('evidence', changed.evidence); rehash('risk', changed.risk);
        const second = buildNcscSubmission(changed);
        expect(second.evaluation.attainment).toEqual(first.evaluation.attainment);
        expect(second.evaluation.countsCompletion).toEqual(first.evaluation.countsCompletion);
        expect(second.evaluation.evidence.testedCoverage).toMatchObject({ numerator: 14, percentTenths: 1000 });
        expect(second.evaluation.remediationPriority).toEqual({ status: 'not_calculated', reason: 'priority_adapter_required' });
        expect(second.evaluation.outputSha256).not.toBe(first.evaluation.outputSha256);
    });

    test('detaches and freezes input/results without changing source, text or timestamps; JSON restore reproduces hashes', () => {
        const source = fixture(), before = copy(source), first = buildNcscSubmission(source);
        const saved = validateNcscSupportingRecords({ ...source, submission: first });
        expect(source).toEqual(before);
        expect(saved.scopePopulation.body.description).toBe(before.scopePopulation.body.description);
        expect(saved.rationales[0].body.text).toBe(before.rationales[0].body.text);
        expect(Object.isFrozen(saved.scopePopulation.body)).toBe(true);
        expect(Object.isFrozen(first.input.atomInputs[0].response)).toBe(true);
        expect(Object.isFrozen(first.evaluation.provenance)).toBe(true);
        source.risk.entries[0].statedImpact = 'low';
        expect(first.input.atomInputs.find(atom => atom.itemId === MATRIX[0][0]).statedImpact).toBe('high');
        const now = jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2030-01-01T00:00:00.000Z'));
        try {
            expect(buildNcscSubmission(copy(saved))).toEqual(first);
            expect(hashNcscRecord('version', copy(saved))).toBe(hashNcscRecord('version', saved));
            expect(first.input.evidenceSnapshot.sha256).toBe(calculateEvidenceSnapshotSha256(saved.evidence.entries));
            expect(first.input.riskContextSnapshot.sha256).toBe(calculateRiskContextSnapshotSha256(saved.risk.entries));
        } finally { now.mockRestore(); }
    });

    test.each(['created', 'in-progress'])('valid %s assessment cannot be evaluated before submission', status => {
        const source = fixture(status);
        expect(validateNcscSupportingRecords(source)).toEqual(source);
        expect(() => buildNcscSubmission(source)).toThrow(expect.objectContaining({ code: 'ncsc_state_conflict', statusCode: 409 }));
    });

    test.each(['scopePopulation', 'rationales', 'evidence', 'risk'])('missing retained %s cannot be defaulted', field => {
        const source = fixture(); delete source[field]; invalid(() => buildNcscSubmission(source));
        const empty = fixture(); empty[field] = null; invalid(() => buildNcscSubmission(empty));
    });

    test.each(['scopePopulation', 'evidence', 'risk', 'rationale'])('unchanged digest detects modified %s core', field => {
        const source = fixture(), value = field === 'rationale' ? source.rationales[0] : source[field];
        value.recordedAt = '2026-09-07T08:01:00.000Z'; invalid(() => buildNcscSubmission(source));
    });

    test.each(['tenantId', 'organisationId', 'assessmentId'])('rehashed foreign %s records cannot cross the outer owner', field => {
        for (const kind of ['scope', 'rationale', 'evidence', 'risk']) {
            const source = fixture(), value = kind === 'scope' ? source.scopePopulation :
                kind === 'rationale' ? source.rationales[0] : source[kind];
            value[field] = 'foreign-scope'; rehash(kind, value); invalid(() => buildNcscSubmission(source));
        }
        const source = fixture(); source[field] = 'foreign-scope'; invalid(() => buildNcscSubmission(source));
    });

    test.each(['evidence', 'risk'])('rehashed %s record still needs the exact accepted profile, scope, revision and original timestamp', kind => {
        for (const [field, value] of [['scopePopulationSha256', 'a'.repeat(64)], ['recordedRevision', 1],
            ['recordedAt', SAVED_AT], ['recordedAt', '2026-09-07T08:00:00Z'],
            ['profileRef', { ...ACCEPTED_PROFILE_REF, sourceCatalogueSha256: 'b'.repeat(64) }]]) {
            const source = fixture(); source[kind][field] = value; rehash(kind, source[kind]);
            invalid(() => buildNcscSubmission(source));
        }
    });

    test.each(['evidence', 'risk'])('%s requires exactly the accepted fourteen explicit entries with no extra fields', kind => {
        const mutations = [entries => entries.pop(), entries => entries.push(copy(entries[0])),
            entries => { entries[0].itemId = 'foreign-question'; }, entries => { entries[0].extra = true; },
            entries => { delete entries[0][kind === 'evidence' ? 'evidenceState' : 'statedImpact']; },
            entries => { entries[0][kind === 'evidence' ? 'evidenceState' : 'statedImpact'] = 'invented'; }];
        for (const mutate of mutations) {
            const source = fixture(); mutate(source[kind].entries); rehash(kind, source[kind]);
            invalid(() => buildNcscSubmission(source));
        }
    });

    test('rationale must bind the exact active response, digest, save revision, actor and time', () => {
        for (const [field, value] of [['itemId', MATRIX[0][0]], ['recordedRevision', 0], ['recordedRevision', 2],
            ['actorSubjectKey', OTHER_ACTOR], ['recordedAt', SUBMITTED_AT], ['body', { text: 'Replacement text' }]]) {
            const source = fixture(); source.rationales[0][field] = value; rehash('rationale', source.rationales[0]);
            invalid(() => buildNcscSubmission(source));
        }
        const missing = fixture(); missing.rationales = []; invalid(() => buildNcscSubmission(missing));
        const duplicate = fixture(); duplicate.rationales.push(copy(duplicate.rationales[0])); invalid(() => buildNcscSubmission(duplicate));
    });

    test('later saves retain old rationale revisions, sort new active claims and remove only replaced active claims', () => {
        const previous = validateNcscSupportingRecords(fixture('in-progress'));
        const itemId = MATRIX[0][0], now = '2026-09-07T09:30:00.000Z';
        const newRationale = record('rationale', { actorSubjectKey: OTHER_ACTOR, itemId,
            recordedRevision: 2, recordedAt: now, body: { text: 'Another synthetic unresolved claim.' } });
        const state = applyAssessmentCommand(previous.state, tenant(), { ...OWNER, action: 'save',
            expectedRevision: 1, actorSubjectKey: OTHER_ACTOR, now, idempotencyKey: 'save-b',
            payload: { responses: [{ itemId, optionId: 'not_applicable', applicabilityRationaleSha256: newRationale.sha256 }] }
        }, acceptedRegistry);
        const next = { ...previous, state, revision: 2, rationales: [...previous.rationales, newRationale]
            .sort((left, right) => left.itemId < right.itemId ? -1 : 1) };
        const retained = validateNcscSupportingRecords(next);
        expect(retained.rationales.find(row => row.itemId === NA_ID)).toEqual(previous.rationales[0]);
        expect(retained.rationales.find(row => row.itemId === itemId).recordedRevision).toBe(2);
        expect(retained.scopePopulation).toEqual(previous.scopePopulation);
        expect(retained.evidence).toEqual(previous.evidence);
        expect(retained.risk).toEqual(previous.risk);
        invalid(() => validateNcscSupportingRecords({ ...next, rationales: [...next.rationales].reverse() }));
        const removedState = applyAssessmentCommand(state, tenant(), { ...OWNER, action: 'save',
            expectedRevision: 2, actorSubjectKey: OTHER_ACTOR, now, idempotencyKey: 'save-c',
            payload: { responses: [{ itemId, optionId: null, applicabilityRationaleSha256: null }] }
        }, acceptedRegistry);
        const removed = validateNcscSupportingRecords({ ...next, revision: 3, state: removedState, rationales: previous.rationales });
        expect(removed.rationales).toHaveLength(1);
        expect(retained.rationales).toHaveLength(2);
        expect(previous.rationales).toHaveLength(1);
        invalid(() => validateNcscSupportingRecords({ ...next, revision: 3, state: removedState }));
    });

    test('rehashed scope retains exact creation actor, timestamp and state digest', () => {
        for (const [field, value] of [['actorSubjectKey', OTHER_ACTOR], ['recordedAt', SAVED_AT],
            ['recordedRevision', 1], ['body', { description: 'Different scope' }]]) {
            const source = fixture(); source.scopePopulation[field] = value; rehash('scope', source.scopePopulation);
            invalid(() => buildNcscSubmission(source));
        }
    });

    test.each(['', ' \n\t ', 'x'.repeat(4001)])('invalid declaration/rationale text is rejected even after rehashing', value => {
        const declaration = fixture(); declaration.scopePopulation.body.description = value;
        rehash('scope', declaration.scopePopulation); invalid(() => buildNcscSubmission(declaration));
        const rationale = fixture(); rationale.rationales[0].body.text = value;
        rehash('rationale', rationale.rationales[0]); invalid(() => buildNcscSubmission(rationale));
    });

    test('changed accepted state profile, module, revision, unknown fields and unsorted responses fail closed', () => {
        const mutations = [source => { source.state.profileRef.profileVersion = '2026-08-31.1'; },
            source => { source.state.moduleId = 'other-module'; }, source => { source.revision += 1; },
            source => { source.revision = 129; }, source => { source.schemaVersion = 2; },
            source => { source.state.responses.reverse(); }, source => { source.approval = true; }];
        for (const mutate of mutations) { const source = fixture(); mutate(source); invalid(() => buildNcscSubmission(source)); }
    });

    test('retained submission cannot substitute changed input, output or a fresh scoring time', () => {
        const mutations = [source => { source.submission.input.scoreAsOf = SAVED_AT; },
            source => { source.submission.input.assessmentRevision = 'rev-1'; },
            source => { source.submission.evaluation.attainment.lowerCreditUnits += 1; },
            source => { source.submission.evaluation.outputSha256 = 'f'.repeat(64); },
            source => { source.submission.approval = true; }];
        for (const mutate of mutations) {
            const source = fixture(); source.submission = copy(buildNcscSubmission(source)); mutate(source);
            invalid(() => validateNcscSupportingRecords(source));
        }
        const rehashed = fixture();
        const input = copy(buildNcscSubmission(rehashed).input);
        input.scoreAsOf = '2026-09-07T10:00:00.001Z';
        rehashed.submission = { input, evaluation: evaluateAcceptedNcscAssessment(input) };
        invalid(() => validateNcscSupportingRecords(rehashed));
    });
});

describe('NCSC domain-separated bounded record hashing', () => {
    test('sorted canonical JSON preserves arrays and text and includes one namespace newline', () => {
        const literal = 'nofries:ncsc004:scope:v1\n{"a":1,"b":[true,null," x\\n"]}';
        expect(hashNcscRecord('scope', { b: [true, null, ' x\n'], a: 1 }))
            .toBe(crypto.createHash('sha256').update(literal).digest('hex'));
        expect(hashNcscRecord('scope', { a: 1, b: [true, null, ' x\n'] }))
            .toBe(hashNcscRecord('scope', { b: [true, null, ' x\n'], a: 1 }));
        const kinds = ['scope', 'rationale', 'evidence', 'risk', 'version', 'intent', 'receipt', 'policy', 'result'];
        expect(new Set(kinds.map(kind => hashNcscRecord(kind, { a: 1 })))).toHaveProperty('size', kinds.length);
        invalid(() => hashNcscRecord('unknown', {}));
    });

    test.each([undefined, NaN, Infinity, -Infinity, -0, 1n, () => {}, Symbol('x'), new Date(), new Map(), new Set()])(
        'rejects non-JSON or ambiguous scalar/object values', value => { invalid(() => hashNcscRecord('scope', { value })); });

    test('rejects getters, proxies, symbols, hidden fields, custom prototypes, sparse arrays and cycles without executing hooks', () => {
        let executions = 0;
        const getter = {}; Object.defineProperty(getter, 'value', { enumerable: true, get() { executions += 1; return 1; } });
        const proxy = new Proxy({}, { ownKeys() { executions += 1; return []; } });
        const hidden = {}; Object.defineProperty(hidden, 'value', { value: 1 });
        const arrayGetter = [1]; Object.defineProperty(arrayGetter, '0', { enumerable: true, get() { executions += 1; return 1; } });
        const cycle = {}; cycle.self = cycle;
        const decorated = [1]; decorated.extra = true;
        const inputs = [getter, proxy, hidden, arrayGetter, cycle, decorated, Array(1), Object.create({ inherited: 1 }),
            { [Symbol('x')]: 1 }, { toJSON() { executions += 1; return {}; } }, JSON.parse('{"__proto__":{}}')];
        for (const value of inputs) invalid(() => hashNcscRecord('scope', value));
        const source = fixture(); Object.defineProperty(source, 'state', { enumerable: true, get() { executions += 1; return {}; } });
        invalid(() => buildNcscSubmission(source)); expect(executions).toBe(0);
    });

    test('bounds canonical UTF-8 bytes, graph depth, key bytes and receipt size separately', () => {
        const limit = 256 * 1024;
        expect(hashNcscRecord('version', 'x'.repeat(limit - 2))).toMatch(/^[a-f0-9]{64}$/);
        invalid(() => hashNcscRecord('version', 'x'.repeat(limit - 1)));
        invalid(() => hashNcscRecord('version', 'é'.repeat(limit / 2)));
        expect(hashNcscRecord('receipt', 'x'.repeat(1024 * 1024 - 2))).toMatch(/^[a-f0-9]{64}$/);
        invalid(() => hashNcscRecord('receipt', 'x'.repeat(1024 * 1024 - 1)));
        invalid(() => hashNcscRecord('scope', { ['x'.repeat(257)]: 1 }));
        let nested = null; for (let i = 0; i < 66; i += 1) nested = { nested };
        invalid(() => hashNcscRecord('scope', nested));
    });
});
