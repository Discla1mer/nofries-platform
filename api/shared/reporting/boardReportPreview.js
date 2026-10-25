'use strict';

const { evaluateAssessment, serialiseAssessmentEvaluation } = require('../assessmentEngine/assessmentEvaluator');

const PREVIEW_CONTRACT_VERSION = 'board-report-preview-v1';
const FIXED_LIMITATIONS = Object.freeze([
    'Internal draft preview. This report has not been approved or issued.',
    'Assessment indicators are not independent certification, formal assurance or a regulatory compliance determination.',
    'Implementation attainment reflects recorded responses. Evidence coverage is shown separately and does not prove control effectiveness.',
    'Evidence states describe the supplied snapshot; this preview does not inspect evidence files or verify their contents.',
    'Remediation priority is not calculated. Trend is not assessed; no improvement over time is claimed.'
]);
const EVIDENCE_LABELS = Object.freeze({
    not_provided: 'Not provided', attested: 'Attested', documented_current: 'Current documentation',
    tested_or_observed_current: 'Current test or observation', independently_reviewed_current: 'Current independent review',
    stale: 'Stale', inaccessible: 'Inaccessible', disputed: 'Disputed', unavailable: 'Unavailable'
});

/** Pure source projection. Dependencies must come from a trusted caller. No
 * supplied score object, access authority or issued-report envelope is accepted.
 */
function buildBoardReportPreview(input, evaluatorOptions, presentation) {
    const generatedAt = generationTime(presentation);
    const evaluation = evaluateAssessment(input, evaluatorOptions);
    if (generatedAt < evaluation.provenance.scoreAsOf) invalidPresentation();
    const counts = evaluation.countsCompletion;
    const limitations = [...FIXED_LIMITATIONS];
    if (counts.unknown > 0) {
        limitations.push(`${counts.unknown} applicable questions remain unresolved. The attainment range includes this uncertainty; its upper bound is not achieved performance.`);
    }
    if (counts.claimedNotApplicableAtoms > 0) {
        limitations.push(`${counts.claimedNotApplicableAtoms} not-applicable claims await an approved applicability decision and remain in the denominator as unknown.`);
    }
    if (counts.approvedNotApplicableAtoms > 0) {
        limitations.push(`${counts.approvedNotApplicableAtoms} questions have approved not-applicable decisions and are excluded from applicable-question and evidence denominators.`);
    }
    if (evaluation.attainment.status === 'not_scored') {
        limitations.push('No applicable weighted questions remain. Not scored is not a zero score or a completed assessment outcome.');
    }
    return freeze({
        schemaVersion: 1, previewContractVersion: PREVIEW_CONTRACT_VERSION,
        audience: 'internal_preview', status: 'draft', generatedAt,
        provenance: evaluation.provenance,
        sourceEvaluationSha256: evaluation.outputSha256,
        measures: {
            countsCompletion: counts, attainment: evaluation.attainment,
            evidence: evaluation.evidence, remediationPriority: evaluation.remediationPriority,
            trend: evaluation.trend
        },
        domains: evaluation.domains,
        followUp: [
            { kind: 'resolve_unknown', questionCount: counts.unknown,
                description: 'Clarify unresolved responses, including any pending applicability claims.' },
            { kind: 'review_reported_gaps', questionCount: counts.no + counts.partial,
                description: 'Review reported partial and absent implementation before agreeing improvement actions.' },
            { kind: 'review_supporting_evidence',
                questionCount: counts.applicableAtoms - evaluation.evidence.substantiatedCoverage.numerator,
                description: 'Review questions without current supporting documentation, testing or independent review.' }
        ],
        limitations
    });
}

/** Re-evaluate from source; never render caller-supplied preview figures. */
function renderBoardReportPreviewHtml(input, evaluatorOptions, presentation) {
    const preview = buildBoardReportPreview(input, evaluatorOptions, presentation);
    const { countsCompletion: counts, attainment, evidence } = preview.measures;
    const provenance = preview.provenance;
    const reference = provenance.profileRef;
    const domains = preview.domains.map(domain => `<tr>
<th scope="row">${escapeHtml(humanise(domain.domainId))}<small>${escapeHtml(domain.domainId)}</small></th>
<td>${escapeHtml(domain.countsCompletion.completionDisplay || 'Not scored')}</td>
<td>${escapeHtml(attainmentDisplay(domain.attainment))}</td>
<td>${escapeHtml(domain.evidence.substantiatedCoverage.display || 'Not scored')}</td>
<td>${domain.countsCompletion.unknown}</td></tr>`).join('');
    const evidenceRows = Object.entries(evidence.distribution).map(([state, count]) =>
        `<tr><th scope="row">${escapeHtml(EVIDENCE_LABELS[state] || state)}</th><td>${count}</td></tr>`).join('');
    const followUp = preview.followUp.map(item => `<li><strong>${item.questionCount} questions</strong><span>${escapeHtml(item.description)}</span></li>`).join('');
    const limitations = preview.limitations.map(item => `<li>${escapeHtml(item)}</li>`).join('');
    const auditRows = flattenProvenance({ ...provenance, sourceEvaluationSha256: preview.sourceEvaluationSha256,
        previewContractVersion: preview.previewContractVersion, generatedAt: preview.generatedAt })
        .map(([key, value]) => `<tr><th scope="row">${escapeHtml(key)}</th><td>${escapeHtml(value)}</td></tr>`).join('');
    return `<!doctype html>
<html lang="en-NZ"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>No Fries assessment report — internal preview</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f3f5f6;color:#14232b;font:16px/1.55 system-ui,sans-serif}
main{max-width:1120px;margin:auto;padding:40px 28px 64px}header{border-top:5px solid #16766c;padding-top:24px}
.brand{font-size:15px;font-weight:750;letter-spacing:.13em}.badge{display:inline-block;background:#fff0d1;color:#694600;padding:4px 10px;border-radius:4px;font-size:13px;font-weight:650}
h1{font-size:38px;line-height:1.15;margin:16px 0 12px}h2{font-size:23px;margin:0 0 12px}p{margin:8px 0 16px}.muted,small{color:#53646e}
.identity{display:grid;grid-template-columns:1fr 1fr;gap:12px 28px;margin:24px 0}.identity div{min-width:0}.identity span{display:block;font-size:13px;color:#53646e}.identity strong{font-size:15px;overflow-wrap:anywhere}
.cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin:28px 0}.card{background:white;padding:20px;border:1px solid #d7e1e4;border-radius:8px}.card h2{font-size:14px;font-weight:650;min-height:44px;margin:0}.value{font-size:27px;font-weight:750;margin:9px 0;color:#145c54}.card p{font-size:13px;margin:0;color:#53646e}
section{background:white;border:1px solid #d7e1e4;border-radius:8px;margin-top:20px;padding:24px}.status{border-left:4px solid #c68a23;background:#fff8eb;padding:15px 20px}.status p{margin:0}.status strong{color:#694600}
.table-wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:14px}caption{text-align:left;color:#53646e;padding-bottom:12px}th,td{padding:11px 12px;border-bottom:1px solid #dfe6e8;text-align:left;vertical-align:top}thead th{font-size:12px;letter-spacing:.02em;background:#f4f7f8}tbody th{font-weight:550}small{display:block;font-size:11px;overflow-wrap:anywhere}.follow-up{list-style:none;padding:0;margin:0}.follow-up li{display:grid;grid-template-columns:120px 1fr;gap:16px;border-bottom:1px solid #e1e7e9;padding:15px 0}.limitations li{margin:10px 0}.provenance td{font:12px/1.5 ui-monospace,monospace;overflow-wrap:anywhere;word-break:break-word}.provenance th{width:34%;overflow-wrap:anywhere}footer{font-size:13px;color:#53646e;margin-top:24px}
@media(max-width:760px){main{padding:22px 16px 40px}.cards{grid-template-columns:1fr 1fr}.identity{grid-template-columns:1fr}h1{font-size:31px}section{padding:18px}.value{font-size:23px}}
@media(max-width:420px){.cards{grid-template-columns:1fr}.card h2{min-height:0}.follow-up li{grid-template-columns:1fr;gap:3px}}
@media print{body{background:white}main{padding:0}.card,section{break-inside:avoid}h2{break-after:avoid}.provenance{font-size:11px}.badge{border:1px solid #c68a23}}
</style></head><body><main>
<header><div class="brand">NO FRIES</div><p><span class="badge">INTERNAL DRAFT · NOT ISSUED</span></p>
<h1>Assessment report</h1><p class="muted">A management view of implementation, supporting evidence and unresolved questions.</p>
<div class="identity">
${identity('Organisation', provenance.organisationId)}${identity('Assessment / revision', `${provenance.assessmentId} / ${provenance.assessmentRevision}`)}
${identity('Framework / version', `${reference.frameworkId} / ${reference.frameworkVersion}`)}${identity('Profile / version', `${reference.profileId} / ${reference.profileVersion}`)}
${identity('Assessment as at (UTC)', provenance.scoreAsOf)}${identity('Preview generated (UTC)', preview.generatedAt)}
</div></header>
<div class="status"><p><strong>${counts.completionStatus === 'not_scored' ? 'Not scored' : counts.unknown > 0 ? 'Provisional assessment' : 'Responses complete'}</strong> · ${counts.yes} yes, ${counts.partial} partial, ${counts.no} no, ${counts.unknown} unresolved; ${counts.approvedNotApplicableAtoms} approved exclusions.</p></div>
<div class="cards">
${card('Response completion', counts.completionDisplay || 'Not scored', `${counts.completionNumerator} of ${counts.completionDenominator} applicable questions answered yes, partial or no.`)}
${card('Implementation attainment', attainmentDisplay(attainment), 'Weighted response range. The upper bound includes unresolved questions.')}
${card('Current supporting evidence', evidence.substantiatedCoverage.display || 'Not scored', `${evidence.substantiatedCoverage.numerator} of ${evidence.denominator} applicable questions have current documentation, testing or independent review.`)}
${card('Tested or observed evidence', evidence.testedCoverage.display || 'Not scored', `${evidence.testedCoverage.numerator} of ${evidence.denominator} applicable questions have current testing, observation or independent review.`)}
</div>
<section aria-labelledby="domain-heading"><h2 id="domain-heading">Framework areas</h2><div class="table-wrap"><table>
<caption>Separate measures for each framework area. Evidence does not change implementation attainment.</caption>
<thead><tr><th scope="col">Area</th><th scope="col">Response completion</th><th scope="col">Implementation</th><th scope="col">Supporting evidence</th><th scope="col">Unresolved</th></tr></thead><tbody>${domains}</tbody></table></div></section>
<section aria-labelledby="follow-up-heading"><h2 id="follow-up-heading">Management follow-up</h2><p class="muted">Discussion prompts from the recorded assessment. Categories can overlap; this is not a risk-ranked action plan.</p><ul class="follow-up">${followUp}</ul><p><strong>Risk priority:</strong> Not calculated. <strong>Trend:</strong> Not assessed.</p></section>
<section aria-labelledby="evidence-heading"><h2 id="evidence-heading">Evidence state</h2><p class="muted">${evidence.providedCoverage.numerator} of ${evidence.denominator} applicable questions have supplied evidence, including attestation. Attestation alone is not supporting documentation or a test.</p><table><thead><tr><th scope="col">Recorded state</th><th scope="col">Questions</th></tr></thead><tbody>${evidenceRows}</tbody></table></section>
<section aria-labelledby="limitations-heading"><h2 id="limitations-heading">Scope and limitations</h2><p>The scope population is identified by the retained digest in the provenance below. This preview does not include a reviewed narrative scope or exclusions statement.</p><ul class="limitations">${limitations}</ul></section>
<section aria-labelledby="provenance-heading"><h2 id="provenance-heading">Reproducibility and provenance</h2><p class="muted">Exact source versions and snapshot identifiers. Digests are reproducibility markers; they do not grant access or approve a report.</p><table class="provenance"><thead><tr><th scope="col">Field</th><th scope="col">Value</th></tr></thead><tbody>${auditRows}</tbody></table></section>
<footer>Prepared by deterministic No Fries source code. Internal preview only; no report has been issued.</footer>
</main></body></html>`;
}

function generationTime(presentation) {
    let value;
    try { value = JSON.parse(serialiseAssessmentEvaluation(presentation)); }
    catch { invalidPresentation(); }
    if (!value || Array.isArray(value) || typeof value !== 'object' ||
        Object.keys(value).length !== 1 || !Object.hasOwn(value, 'generatedAt') ||
        typeof value.generatedAt !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.generatedAt)) invalidPresentation();
    const milliseconds = Date.parse(value.generatedAt);
    if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value.generatedAt) invalidPresentation();
    return value.generatedAt;
}
function invalidPresentation() {
    const error = new Error('board_report_preview_presentation_invalid');
    error.code = 'board_report_preview_presentation_invalid';
    throw error;
}
function freeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.values(value).forEach(freeze);
        Object.freeze(value);
    }
    return value;
}
function attainmentDisplay(value) {
    if (value.status !== 'scored') return 'Not scored';
    return value.lowerDisplay === value.upperDisplay ? value.lowerDisplay : `${value.lowerDisplay}–${value.upperDisplay}`;
}
function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}
function humanise(identifier) {
    return identifier.replace(/[-_]/g, ' ').replace(/\b[a-z]/g, character => character.toUpperCase());
}
function identity(label, value) {
    return `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}
function card(label, value, note) {
    return `<article class="card"><h2>${escapeHtml(label)}</h2><div class="value">${escapeHtml(value)}</div><p>${escapeHtml(note)}</p></article>`;
}
function flattenProvenance(value, prefix = '') {
    return Object.entries(value).flatMap(([key, child]) => {
        const label = prefix ? `${prefix}.${key}` : key;
        return child && typeof child === 'object' ? flattenProvenance(child, label) : [[label, child]];
    });
}

module.exports = { PREVIEW_CONTRACT_VERSION, buildBoardReportPreview, renderBoardReportPreviewHtml };
