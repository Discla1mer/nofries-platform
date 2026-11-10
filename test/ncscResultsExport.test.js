'use strict';

// Covers the submitted-assessment results export: the pure CSV serialiser and
// the GET .../{id}/export HTTP boundary that reuses the same authorised read as
// every other assessment request. Not a browser or SQL engine; the durable
// transaction is replaced, as in the sibling questionnaire suite.
const { createNcscAssessmentService, normaliseNcscCommand, projectNcscDetail,
    NcscAssessmentError } = require('../api/shared/ncscAssessmentService');
const { createNcscAssessmentHandlers } = require('../api/shared/ncscAssessmentHandlers');
const { makeVersion, stableIntent } = require('../api/shared/assessmentLifecycle/postgresNcscAssessmentStore');
const { ncscFixture, createClock, createContext, allResponses, createCommand, saveCommand,
    submitCommand } = require('./fixtures/ncscAssessmentFixture');
const { buildNcscResultsCsv, ncscResultsCsvFilename, NcscResultsCsvError } = require('../api/shared/ncscResultsCsv');

async function backend() {
    const fixture = ncscFixture(), clock = createClock(), context = await createContext(fixture.scope, clock);
    const versions = new Map(), receipts = new Map();
    let denied = false;
    const requireAccess = () => { if (denied) throw new NcscAssessmentError('ncsc_access_denied', 403); };
    const repository = {
        async listNcscAssessments() { requireAccess(); return { schemaVersion: 1, assessments: [], nextAfterAssessmentId: null }; },
        async readNcscAssessment(_context, selector) {
            requireAccess(); const value = versions.get(selector.assessmentId);
            if (!value) throw new NcscAssessmentError('ncsc_not_found', 404);
            return { schemaVersion: 1, assessment: projectNcscDetail(value) };
        },
        async executeNcscAssessment(current, input) {
            requireAccess(); const command = normaliseNcscCommand(input), intent = stableIntent(current, command);
            const digest = JSON.stringify(intent), receipt = receipts.get(command.idempotencyKey);
            if (receipt) { if (receipt.digest !== digest) throw new NcscAssessmentError('ncsc_idempotency_conflict', 409); return receipt.value; }
            const value = makeVersion(intent, command.idempotencyKey, versions.get(command.assessmentId) || null,
                fixture.state.tenantAggregate, clock.now());
            versions.set(command.assessmentId, value);
            const result = { schemaVersion: 1, action: command.action, assessment: projectNcscDetail(value) };
            receipts.set(command.idempotencyKey, { digest, value: result });
            return result;
        }
    };
    const service = createNcscAssessmentService({ repository, requestContext: { resolve: async () => context } });
    const handlers = createNcscAssessmentHandlers({ service, guardMutation: async () => true });
    const execute = command => repository.executeNcscAssessment(context, command);
    return { handlers, execute, deny: () => { denied = true; },
        async submit(option = 'partial') {
            await execute(createCommand());
            await execute(saveCommand('assessment-a', 0, 'save-a', allResponses(option)));
            return (await execute(submitCommand())).assessment;
        } };
}

describe('NCSC results CSV serialiser', () => {
    test('renders summary, every section score and one row per answered question from the server payload', async () => {
        const h = await backend(), assessment = await h.submit('partial');
        const csv = buildNcscResultsCsv(assessment);
        const blocks = csv.split('\r\n\r\n');
        expect(blocks).toHaveLength(3);
        expect(csv).toContain('Organisation,shared-organisation');
        expect(csv).toContain('Assessment,assessment-a');
        expect(csv).toContain('Overall implementation,50.0%');
        expect(csv).toContain('Resolved answers,14 of 14 (100.0%)');
        expect(csv).toContain('Output SHA-256,' + assessment.submission.evaluation.outputSha256);
        // Five NCSC functions plus 14 controls, each a section row, and a header.
        const sectionRows = blocks[1].split('\r\n');
        expect(sectionRows[0]).toBe('Section type,Section id,Implementation,Resolved answers,Total questions');
        expect(sectionRows.filter(row => row.startsWith('Domain,'))).toHaveLength(5);
        expect(sectionRows.filter(row => row.startsWith('Control,'))).toHaveLength(14);
        // One header plus one row per atom.
        const questionRows = blocks[2].replace(/\r\n$/, '').split('\r\n');
        expect(questionRows[0]).toBe('Question id,Control id,Domain id,Response,Evidence,Weight,Lower credit,Upper credit,Rationale');
        expect(questionRows).toHaveLength(1 + assessment.submission.evaluation.atoms.length);
        expect(questionRows.some(row => row.startsWith('NF-NCSC-MCSS-RM-01-Q1,NF-NCSC-MCSS-RM-01,guide-govern,Partial,Not provided,1,'))).toBe(true);
    });

    test('never recomputes: it reflects the evaluator display strings and counts verbatim', async () => {
        const h = await backend(), assessment = await h.submit('yes');
        const evaluation = assessment.submission.evaluation;
        const csv = buildNcscResultsCsv(assessment);
        expect(csv).toContain('Overall implementation,' + evaluation.attainment.lowerDisplay);
        expect(csv).toContain('Answered Yes,' + evaluation.countsCompletion.yes);
    });

    test('quotes and neutralises spreadsheet-formula injection in end-user text', () => {
        const assessment = {
            assessmentId: 'a,b"c', status: 'submitted', moduleId: 'cyber_security',
            profileRef: { frameworkId: 'fw', frameworkVersion: '1', profileId: 'p', profileVersion: '2' },
            scopePopulation: { description: 'Line one\nLine two, with "quote"' },
            responses: [{ itemId: 'Q1', optionId: 'no', rationale: { text: '=1+2, "danger"' } }],
            submission: { revision: 2, submittedAt: '2026-01-01T00:00:00.000Z', responseSetSha256: 'set', evaluation: {
                outputSha256: 'out', attainment: { status: 'scored', lowerDisplay: '10.0%', upperDisplay: '20.0%' },
                countsCompletion: { completionNumerator: 1, completionDenominator: 1, completionDisplay: '100.0%',
                    yes: 0, partial: 0, no: 1, unknown: 0, claimedNotApplicableAtoms: 0 },
                evidence: { providedCoverage: { display: '0.0%' }, substantiatedCoverage: { display: '0.0%' }, testedCoverage: { display: '0.0%' } },
                domains: [{ domainId: 'D1', attainment: { status: 'scored', lowerDisplay: '10.0%', upperDisplay: '20.0%' },
                    countsCompletion: { completionNumerator: 1, completionDenominator: 1 } }],
                controls: [{ controlId: 'C1', attainment: { status: 'not_scored' }, countsCompletion: { completionNumerator: 0, completionDenominator: 0 } }],
                atoms: [{ itemId: 'Q1', controlId: 'C1', domainId: 'D1', responseOptionId: 'no', response: 'no',
                    evidenceState: 'not_provided', weight: 1, lowerCreditUnits: 0, upperCreditUnits: 0 }],
                provenance: { organisationId: 'org' }
            } }
        };
        const csv = buildNcscResultsCsv(assessment);
        // en dash range from distinct lower/upper displays.
        expect(csv).toContain('Overall implementation,10.0%–20.0%');
        // Dangerous leading '=' defused with a leading apostrophe, then RFC 4180 quoted.
        expect(csv).toContain('"\'=1+2, ""danger"""');
        // Scope with newline/comma/quote is quoted.
        expect(csv).toContain('"Line one\nLine two, with ""quote"""');
        // not_scored control renders a stable label.
        expect(csv).toContain('Control,C1,Not scored,0,0');
        expect(ncscResultsCsvFilename(assessment)).toBe('nofries-ncsc-results-a-b-c.csv');
    });

    test('refuses to serialise an assessment that is not a submitted evaluation', () => {
        expect(() => buildNcscResultsCsv({ status: 'in-progress' })).toThrow(NcscResultsCsvError);
        expect(() => buildNcscResultsCsv({ status: 'submitted', submission: { revision: 1, submittedAt: 'x' } })).toThrow(NcscResultsCsvError);
        expect(() => buildNcscResultsCsv(null)).toThrow(NcscResultsCsvError);
    });
});

describe('NCSC results export HTTP boundary', () => {
    const get = (handlers, route) => handlers.handleRequest({ method: 'GET', query: {} }, route);

    test('a submitted assessment downloads as an attachment CSV', async () => {
        const h = await backend(); await h.submit('partial');
        const result = await get(h.handlers, 'assessment-a/export');
        expect(result.status).toBe(200);
        expect(result.isRaw).toBe(true);
        expect(result.headers['Content-Type']).toBe('text/csv; charset=utf-8');
        expect(result.headers['Content-Disposition']).toBe('attachment; filename="nofries-ncsc-results-assessment-a.csv"');
        expect(result.headers['Cache-Control']).toBe('private, no-store, max-age=0');
        expect(typeof result.body).toBe('string');
        expect(result.body).toContain('No Fries NCSC assessment results');
        expect(result.body).toContain('Overall implementation,');
    });

    test('export is refused with the same access denial as a read a user may not see', async () => {
        const h = await backend(); await h.submit('partial'); h.deny();
        const result = await get(h.handlers, 'assessment-a/export');
        expect(result.status).toBe(403);
        expect(result.isRaw).toBe(false);
        expect(result.body).toEqual({ code: 'ncsc_access_denied' });
    });

    test('export of a started but unsubmitted assessment is a submission conflict, not a download', async () => {
        const h = await backend(); await h.execute(createCommand());
        const result = await get(h.handlers, 'assessment-a/export');
        expect(result.status).toBe(409);
        expect(result.body).toEqual({ code: 'ncsc_submission_unavailable' });
    });

    test('export is read-only: a write method is rejected before any service runs', async () => {
        const h = await backend(); await h.submit('partial');
        const result = await h.handlers.handleRequest({ method: 'POST', body: { payload: {} } }, 'assessment-a/export');
        expect(result.status).toBe(405);
        expect(result.headers.Allow).toBe('GET');
    });

    test('an unknown assessment sub-action stays a not-found route', async () => {
        const h = await backend();
        expect((await get(h.handlers, 'assessment-a/bogus')).status).toBe(404);
    });
});
