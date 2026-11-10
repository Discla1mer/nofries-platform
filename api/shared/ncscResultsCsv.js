'use strict';

// Pure serialiser for a submitted NCSC assessment's results.
//
// It consumes the exact projected assessment detail returned by the dashboard
// NCSC read endpoint (projectNcscDetail) — the same authoritative, server
// evaluated payload the results view renders. It never recomputes a score: it
// reflects the deterministic evaluator's own display strings and counts. No
// DOM, I/O, randomness or clock, so the output is deterministic and testable.

const RESPONSE_LABELS = Object.freeze({
    yes: 'Yes', partial: 'Partial', no: 'No', unknown: 'Unknown', not_applicable: 'Not applicable (claimed)'
});
const EVIDENCE_LABELS = Object.freeze({
    not_provided: 'Not provided', attested: 'Self-attested', documented_current: 'Current documentation',
    tested_or_observed_current: 'Currently tested or observed',
    independently_reviewed_current: 'Currently independently reviewed', stale: 'Stale',
    inaccessible: 'Inaccessible', disputed: 'Disputed', unavailable: 'Unavailable'
});

class NcscResultsCsvError extends Error {
    constructor(message) { super(message); this.name = 'NcscResultsCsvError'; this.code = 'ncsc_results_unavailable'; }
}

// RFC 4180 quoting plus spreadsheet formula-injection neutralisation. Scope
// descriptions and rationales are end-user text, so a leading =, +, -, @ or a
// control character is defused with a leading apostrophe before quoting.
function cell(value) {
    let text = value === null || value === undefined ? '' : String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
    if (/[",\r\n]/.test(text)) text = '"' + text.replace(/"/g, '""') + '"';
    return text;
}

function row(values) { return values.map(cell).join(','); }

function attainmentDisplay(attainment) {
    if (!attainment || attainment.status !== 'scored') return 'Not scored';
    const lower = attainment.lowerDisplay, upper = attainment.upperDisplay;
    if (typeof lower !== 'string' || typeof upper !== 'string') return 'Not scored';
    return lower === upper ? lower : lower + '–' + upper;
}

function coverageDisplay(coverage) {
    return coverage && typeof coverage.display === 'string' ? coverage.display : 'Not scored';
}

function requireObject(value, message) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new NcscResultsCsvError(message);
    return value;
}

// Build the complete CSV document for a submitted assessment detail. The file is
// three blank-line-separated blocks (summary, section scores, question
// responses) so one download opens cleanly in a spreadsheet.
function buildNcscResultsCsv(assessment) {
    requireObject(assessment, 'assessment_required');
    if (assessment.status !== 'submitted') throw new NcscResultsCsvError('assessment_not_submitted');
    const submission = requireObject(assessment.submission, 'submission_required');
    const evaluation = requireObject(submission.evaluation, 'evaluation_required');
    const provenance = requireObject(evaluation.provenance, 'provenance_required');
    const counts = requireObject(evaluation.countsCompletion, 'counts_required');
    const evidence = requireObject(evaluation.evidence, 'evidence_required');
    const profileRef = assessment.profileRef || {};
    const scope = assessment.scopePopulation || {};

    const rationaleByItem = new Map();
    for (const response of Array.isArray(assessment.responses) ? assessment.responses : []) {
        rationaleByItem.set(response.itemId, response.rationale && typeof response.rationale.text === 'string'
            ? response.rationale.text : '');
    }

    const summary = [
        ['Field', 'Value'],
        ['Report', 'No Fries NCSC assessment results'],
        ['Organisation', provenance.organisationId],
        ['Assessment', assessment.assessmentId],
        ['Module', assessment.moduleId],
        ['Framework', [profileRef.frameworkId, profileRef.frameworkVersion].filter(Boolean).join(' ')],
        ['Profile', [profileRef.profileId, profileRef.profileVersion].filter(Boolean).join(' ')],
        ['Status', assessment.status],
        ['Submitted at', submission.submittedAt],
        ['Submitted revision', submission.revision],
        ['Scope', scope.description],
        ['Overall implementation', attainmentDisplay(evaluation.attainment)],
        ['Resolved answers', counts.completionNumerator + ' of ' + counts.completionDenominator
            + (counts.completionDisplay ? ' (' + counts.completionDisplay + ')' : '')],
        ['Answered Yes', counts.yes],
        ['Answered Partial', counts.partial],
        ['Answered No', counts.no],
        ['Unknown or unresolved', counts.unknown],
        ['Pending N/A claims', counts.claimedNotApplicableAtoms],
        ['Evidence provided coverage', coverageDisplay(evidence.providedCoverage)],
        ['Evidence substantiated coverage', coverageDisplay(evidence.substantiatedCoverage)],
        ['Evidence tested coverage', coverageDisplay(evidence.testedCoverage)],
        ['Response set SHA-256', submission.responseSetSha256],
        ['Output SHA-256', evaluation.outputSha256],
        ['Note', 'No Fries gap indicators from the deterministic server evaluator. Not an audit or certification.']
    ].map(row);

    const sectionHeader = ['Section type', 'Section id', 'Implementation', 'Resolved answers', 'Total questions'];
    const sections = [sectionHeader];
    for (const domain of Array.isArray(evaluation.domains) ? evaluation.domains : []) {
        const domainCounts = domain.countsCompletion || {};
        sections.push(['Domain', domain.domainId, attainmentDisplay(domain.attainment),
            domainCounts.completionNumerator, domainCounts.completionDenominator]);
    }
    for (const control of Array.isArray(evaluation.controls) ? evaluation.controls : []) {
        const controlCounts = control.countsCompletion || {};
        sections.push(['Control', control.controlId, attainmentDisplay(control.attainment),
            controlCounts.completionNumerator, controlCounts.completionDenominator]);
    }

    const questionHeader = ['Question id', 'Control id', 'Domain id', 'Response', 'Evidence',
        'Weight', 'Lower credit', 'Upper credit', 'Rationale'];
    const questions = [questionHeader];
    for (const atom of Array.isArray(evaluation.atoms) ? evaluation.atoms : []) {
        questions.push([atom.itemId, atom.controlId, atom.domainId,
            RESPONSE_LABELS[atom.responseOptionId] || atom.responseOptionId || atom.response,
            EVIDENCE_LABELS[atom.evidenceState] || atom.evidenceState,
            atom.weight, atom.lowerCreditUnits, atom.upperCreditUnits,
            rationaleByItem.get(atom.itemId) || '']);
    }

    return [summary.join('\r\n'), sections.map(row).join('\r\n'), questions.map(row).join('\r\n')].join('\r\n\r\n') + '\r\n';
}

function safeFilePart(value) {
    return String(value || 'assessment')
        .replace(/[^a-z0-9-_]+/gi, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 100) || 'assessment';
}

function ncscResultsCsvFilename(assessment) {
    const id = assessment && typeof assessment.assessmentId === 'string' ? assessment.assessmentId : 'assessment';
    return 'nofries-ncsc-results-' + safeFilePart(id) + '.csv';
}

module.exports = { buildNcscResultsCsv, ncscResultsCsvFilename, NcscResultsCsvError };
