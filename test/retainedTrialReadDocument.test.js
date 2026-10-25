'use strict';
const assert = require('node:assert/strict');
const { buildRetainedTrialReadDocument, contentSecurityPolicy } = require('../lib/retainedTrialReadDocument');
const { createRetainedTrialAssessmentReader } = require('../api/shared/customerSignup/retainedTrialAssessmentReader');
const { retainedTrialFixture } = require('./fixtures/retainedTrialReadFixture');

test('saved result document renders original accepted-profile results and escapes every customer text field', async () => {
    const f = await retainedTrialFixture(), result = JSON.parse(JSON.stringify(await createRetainedTrialAssessmentReader(f.options).read({}, f.input)));
    result.assessment.scopePopulation.description = '<img src=x onerror="alert(1)">& original scope';
    result.assessment.responses[0].rationale = { text: '</p><script>alert(2)</script>' };
    result.assessment.assessmentId = '<script>not-an-identifier</script>';
    const html = buildRetainedTrialReadDocument({ selection: f.input, result, status: 'result' });
    assert.match(html, /Reported attainment: <strong>100.0%<\/strong>/);
    assert.ok(html.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp; original scope'));
    assert.ok(html.includes('&lt;/p&gt;&lt;script&gt;alert(2)&lt;/script&gt;'));
    assert.ok(html.includes('Assessment reference: <strong>&lt;script&gt;not-an-identifier&lt;/script&gt;</strong>'));
    assert.doesNotMatch(html, /<(?:script|input|textarea|select)\b|<[^>]+\s(?:onerror|contenteditable)=/i);
    assert.equal((html.match(/<form\b/g) || []).length, 1);
    assert.match(html, /<form method="post" action="\/api\/retained-results">/);
    assert.equal((html.match(/<li>/g) || []).length, result.assessment.responses.length);
    assert.ok(!html.includes(f.identity.oid));
});

test('saved result identifies the returned assessment and precise submission and expiry in UTC', async () => {
    const f = await retainedTrialFixture();
    const result = await createRetainedTrialAssessmentReader(f.options).read({}, f.input);
    const html = buildRetainedTrialReadDocument({ selection: { ...f.input, assessmentId: 'other-selection' }, result, status: 'result' });
    assert.ok(html.includes('Assessment reference: <strong>saved-assessment</strong>'));
    assert.ok(!html.includes('other-selection'));
    assert.ok(html.includes('<time datetime="2026-11-02T12:00:02.000Z">2026-11-02 12:00:02.000 UTC</time>'));
    assert.ok(html.includes('<time datetime="2027-02-01T12:00:00.000Z">2027-02-01 12:00:00.000 UTC</time>'));
    assert.ok(html.includes('You cannot change answers or submit another assessment from this page.'));
    const later = JSON.parse(JSON.stringify(result));
    later.assessment.assessmentId = 'later-assessment';
    later.assessment.submission.submittedAt = '2026-11-02T15:30:45.678Z';
    later.assessment.submission.evaluation.attainment.lowerDisplay = '37.5%';
    later.assessment.submission.evaluation.attainment.upperDisplay = '62.5%';
    const laterHtml = buildRetainedTrialReadDocument({ result: later, status: 'result' });
    for (const document of [html, laterHtml]) {
        assert.ok(document.includes('<h2>Saved result</h2>'));
        assert.ok(document.includes('These are the saved self-assessment results for this submission.'));
        assert.doesNotMatch(document, /Original result|from your original submission/);
    }
    assert.ok(laterHtml.includes('Assessment reference: <strong>later-assessment</strong>'));
    assert.ok(laterHtml.includes('<time datetime="2026-11-02T15:30:45.678Z">2026-11-02 15:30:45.678 UTC</time>'));
    assert.ok(laterHtml.includes('Reported attainment: <strong>37.5% to 62.5%</strong>'));
    assert.ok(!laterHtml.includes('Reported attainment: <strong>100.0%</strong>'));
    assert.ok(!laterHtml.includes('2026-11-02 12:00:02.000 UTC'));
});

test.each(['signin', 'unavailable'])('%s explains retained access without exposing result details or promising renewal', async status => {
    const f = await retainedTrialFixture();
    for (const selection of [null, f.input]) {
        const html = buildRetainedTrialReadDocument({ selection, status });
        assert.ok(html.includes('Saved results are read only. Signing in here does not restart your trial.'));
        assert.doesNotMatch(html, /Assessment reference:|Reported attainment:|<time\b|14[ -]days?/i);
        assert.ok(html.includes('<h1 id="saved-results-title" tabindex="-1">'));
        assert.doesNotMatch(html, /<(?:script|form|input|textarea|select)\b/i);
    }
});

test('anonymous document offers one exact-result sign-in link without protected data or automatic provider navigation', async () => {
    const f = await retainedTrialFixture(), html = buildRetainedTrialReadDocument({ selection: f.input });
    const href = /href="([^"]+)">Sign in to saved results<\/a>/.exec(html)[1].replaceAll('&amp;', '&');
    const url = new URL(href, 'https://nofries.invalid');
    assert.equal(url.pathname, '/api/retained-results');
    assert.deepEqual(Object.fromEntries(url.searchParams), { ...f.input, signin: '1' });
    assert.doesNotMatch(html, /<(?:script|form|iframe)\b|<meta\s[^>]*http-equiv=/i);
    assert.ok(!html.includes('Reported attainment'));
    assert.doesNotMatch(contentSecurityPolicy, /unsafe-inline|unsafe-eval|connect-src/);
});

test('the browser transport has one exact anonymous GET/POST handoff before the protected catch-all', () => {
    const routes = require('../staticwebapp.config.json').routes.filter(route => route.route === '/retained-results' || route.route.startsWith('/api/retained-results'));
    assert.deepEqual(routes, [{ route: '/api/retained-results', methods: ['GET', 'POST'], allowedRoles: ['anonymous'] }]);
    // Admission is not authentication. The actual source/built first-match
    // transport tests still require the production purpose-bound BFF session.
});
