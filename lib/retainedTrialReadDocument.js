'use strict';

const { createAcceptedNcscFrameworkProfile } = require('../api/shared/assessmentEngine/ncscAcceptedFrameworkProfile');
const catalogue = createAcceptedNcscFrameworkProfile();
const questions = new Map(catalogue.questions.map(item => [item.id, item.prompt]));
const options = new Map(catalogue.responseOptions.map(item => [item.id, item.label]));
const contentSecurityPolicy = "default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; style-src 'self'; img-src 'self'";
const escape = value => String(value ?? '').replace(/[&<>"']/g, value => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[value]);

function retainedResultPath(selection, signIn = false) {
    if (typeof signIn !== 'boolean') throw new Error('retained_read_document_invalid');
    return '/api/retained-results?' + new URLSearchParams({ bindingId: selection.bindingId,
        assessmentId: selection.assessmentId, ...(signIn ? { signin: '1' } : {}) }).toString();
}
function buildRetainedTrialReadDocument({ selection = null, result = null, status = 'signin' } = {}) {
    if (!['signin', 'result', 'unavailable'].includes(status) || status === 'result' && (!result || result.schemaVersion !== 1 || result.readOnly !== true))
        throw new Error('retained_read_document_invalid');
    let content;
    if (status === 'result') {
        const a = result.assessment, e = a.submission?.evaluation;
        if (a.status !== 'submitted' || !e || !Array.isArray(a.responses) || a.responses.length > questions.size) throw new Error('retained_read_document_invalid');
        const attainment = e.attainment.lowerDisplay === e.attainment.upperDisplay ? e.attainment.lowerDisplay :
            e.attainment.lowerDisplay + ' to ' + e.attainment.upperDisplay;
        const responses = a.responses.map(response => {
            if (!questions.has(response.itemId) || !options.has(response.optionId)) throw new Error('retained_read_document_invalid');
            return `<li><h3>${escape(questions.get(response.itemId))}</h3><p><strong>${escape(options.get(response.optionId))}</strong></p>` +
                (response.rationale ? `<p>${escape(response.rationale.text)}</p>` : '') + '</li>';
        }).join('');
        content = `<h1 id="saved-results-title" tabindex="-1">Saved assessment results</h1>` +
            `<p>Your trial ended on <time datetime="${escape(result.trialEndedAt)}">${escape(result.trialEndedAt.replace('T', ' ').replace('Z', ' UTC'))}</time>. This saved assessment is read only.</p>` +
            `<p>You can review this submission here. You cannot change answers or submit another assessment from this page.</p>` +
            `<p>${escape(catalogue.profile.title)} · Submitted <time datetime="${escape(a.submission.submittedAt)}">${escape(a.submission.submittedAt.replace('T', ' ').replace('Z', ' UTC'))}</time></p>` +
            `<p>Assessment reference: <strong>${escape(a.assessmentId)}</strong></p>` +
            `<h2>Saved result</h2><p>Reported attainment: <strong>${escape(attainment)}</strong>. Completion: ${escape(e.countsCompletion.completionDisplay)}.</p>` +
            `<p>Evidence provided: ${escape(e.evidence.providedCoverage.display)}. These are the saved self-assessment results for this submission.</p>` +
            `<h2>Assessment scope</h2><p>${escape(a.scopePopulation.description)}</p><h2>Saved responses</h2><ol>${responses}</ol>` +
            `<form method="post" action="/api/retained-results"><button type="submit" class="button button-secondary">Sign out of saved results</button></form>`;
    } else {
        content = `<h1 id="saved-results-title" tabindex="-1">${status === 'signin' ? 'Open your saved result' : 'Saved result unavailable'}</h1>` +
            `<p>${status === 'signin' ? 'Sign in with the account that owns this assessment to view its saved result.' : 'This saved result could not be opened. Check your original result link or sign in again.'}</p>` +
            '<p>Saved results are read only. Signing in here does not restart your trial.</p>' +
            (selection ? `<a class="button" href="${escape(retainedResultPath(selection, true))}">Sign in to saved results</a>` :
                '<p>Use the saved result link for your submitted assessment.</p>');
    }
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
        `<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><title>No Fries | Saved assessment</title>` +
        `<link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/home.css"></head>` +
        `<body class="access-page"><a class="skip-link" href="#saved-results-title">Skip to saved results</a>` +
        `<header class="site-header shell"><a class="brand" href="/">No Fries</a><a class="text-link" href="/">Back to home</a></header>` +
        `<main class="shell"><article class="organisation-card">${content}</article></main>` +
        `<footer class="home-footer"><a href="/privacy.html">Privacy</a><a href="/terms.html">Terms</a></footer></body></html>`;
}

module.exports = { buildRetainedTrialReadDocument, retainedResultPath, contentSecurityPolicy };
