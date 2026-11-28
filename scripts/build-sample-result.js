'use strict';
// Regenerate the checked-in public example without shipping the engine or calling an API.
const fs = require('node:fs');
const path = require('node:path');
const demo = require('../demo/try/try-demo');
const view = require('../api/shared/protectedAssets/ncscQuestionnaire');
const file = path.join(__dirname, '../sample-result.html');
const answers = { RM:'partly', SA:'yes', AI:'yes', PA:'no', MF:'partly', MFQ2:'mfa_text_code',
    DU:'yes', LP:'partly', DR:'no', DRQ2:'ad_hoc', RP:'no', PM:'yes', SV:'yes', NS:'partly', SU:'unknown', EM:'yes' };
const scope = 'Harbourview Logistics (fictional): office laptops, business email, dispatch and accounts.';
const when = '2026-11-24T00:00:00.000Z';
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
function sampleResult() {
    const server = demo.createServer(() => when), metadata = server.metadata;
    const responses = metadata.questions.map(({ id, responseOptionIds }) => {
        const [, , , code, , number] = id.split('-');
        const optionId = answers[code + (number === 'Q1' ? '' : number)];
        if (!responseOptionIds.includes(optionId)) throw new Error('Update fictional answer for ' + id);
        return { itemId:id, optionId, rationale:null };
    });
    let detail;
    for (const [action, expectedRevision, payload] of [['create', null, {scopePopulation:{description:scope}}],
        ['save', 0, {responses}], ['submit', 1, {}]]) {
        const reply = server.execute({action, expectedRevision, payload, assessmentId:'sample-harbourview', idempotencyKey:'sample-' + action}, when);
        if (reply.status >= 300) throw new Error('Sample ' + action + ' failed');
        detail = reply.body.assessment;
    }
    const result = view.resultModel(detail, metadata, demo.ORGANISATION_ID);
    const gaps = view.topGaps(result, metadata);
    return { metadata, result, gaps, detail };
}
function render() {
    const { metadata, result:r, gaps, detail } = sampleResult();
    const mix = new Map();
    detail.responses.forEach(({optionId}) => mix.set(optionId, (mix.get(optionId) || 0) + 1));
    const gauge = '<svg class="sample-gauge" viewBox="0 0 200 112" aria-hidden="true" focusable="false">' +
        '<path d="M20 100 A80 80 0 0 1 180 100" class="sample-gauge-track"></path>' +
        '<path d="M20 100 A80 80 0 0 1 180 100" class="sample-gauge-fill" pathLength="100" stroke-dasharray="' +
        parseFloat(r.lowerDisplay) + ' 100"></path></svg>';
    const groups = view.boardSummary(detail, metadata, gaps).text.split('\n\n').map(block => block.split('\n'))
        .filter(lines => lines[1]?.startsWith('- '));
    const items = view.questionnaireAnswers(detail, metadata).items.filter(x => ['mfa','backup-storage','admin-rights','payment-checks'].includes(x.id));
    return `        <section aria-labelledby="sample-overall">
            <h2 id="sample-overall">Overall position</h2>
            <p>Questions carry different weights. An unknown answer leaves a range: the lower end assumes it is not in place; the upper end assumes it is fully in place.</p>
            <div class="public-roadmap-grid">
                <article><h3>Reported implementation</h3><p class="sample-result-figure">${r.attainment}</p>${gauge}<p>The gauge shows the lower end of the range. These figures describe reported practice against guidance from New Zealand’s National Cyber Security Centre (NCSC), not independently verified protection.</p></article>
                <article><h3>Answer mix</h3><p>${r.completed} of ${r.total} questions have a resolved answer. The business selected an option for all ${r.total}, including “I don’t know”.</p>
                    <ul>${metadata.responseOptions.filter(o => mix.has(o.id)).map(o => '<li>' + escape(o.label) + ': ' + mix.get(o.id) + '</li>').join('')}</ul></article>
            </div>
        </section>
        <section aria-labelledby="sample-top-gaps"><h2 id="sample-top-gaps">Your top five gaps</h2>
            <details class="sample-rank-note"><summary>How the gaps are ranked</summary><p>The check combines each question’s weight with how far the answer is from fully in place. “I don’t know” also counts as a gap. This order guides planning; it is not an official NCSC priority.</p></details>
            <ol class="public-roadmap-grid sample-result-gaps">
${gaps.map(g => `                <li data-gap-item="${escape(g.itemId)}"><h3>${escape(g.title)}</h3><p>Answer: ${escape(g.answer)}</p><p><strong>Why it matters:</strong> ${escape(g.why)}</p><p><strong>What to do next:</strong> ${escape(g.firstCheck)}</p></li>`).join('\n')}
            </ol>
        </section>
        <section aria-labelledby="sample-functions"><h2 id="sample-functions">Implementation by NCSC function</h2>
            <table class="sample-result-table" role="table"><thead role="rowgroup"><tr role="row"><th scope="col" role="columnheader">NCSC function</th><th scope="col" role="columnheader">Reported implementation</th><th scope="col" role="columnheader">Questions</th></tr></thead>
                <tbody role="rowgroup">
${r.domains.map(d => `                    <tr role="row"><th scope="row" role="rowheader">${escape(d.title)}</th><td role="cell" data-label="Reported implementation">${d.attainment}</td><td role="cell" data-label="Questions">${d.total}</td></tr>`).join('\n')}
                </tbody></table>
            <p>Guide and Govern is about leadership, priorities and everyday guidance.</p>
        </section>
        <section aria-labelledby="sample-board-summary"><h2 id="sample-board-summary">Example summary for the board or insurer</h2>
            <p><strong>Scope:</strong> ${escape(scope)}<br><strong>Assessed:</strong> 24 November 2026, 1 pm NZ time.<br><strong>Basis:</strong> Self-assessment using the No Fries questionnaire adapted from New Zealand NCSC guidance.</p>
            <div class="public-roadmap-grid">
${groups.map(([heading,...rows]) => `                <article><h3>${escape(heading.slice(0,-1))}</h3><ul>${rows.map(s => '<li>' + escape(s.slice(2)) + '</li>').join('')}</ul></article>`).join('\n')}
            </div><p><strong>Next steps agreed (owner and date):</strong> Left for the business to complete.</p>
        </section>
        <section aria-labelledby="sample-questionnaire"><h2 id="sample-questionnaire">Example questionnaire answers</h2>
            <p>Four examples from the same fictional answers. Check the coverage before using them on an insurer or customer form.</p>
            <ol class="public-roadmap-grid sample-result-gaps">
${items.map(i => `                <li><h3${i.id === 'payment-checks' ? ' id="sample-payment-checks"' : ''}>${escape(i.question)}</h3><strong>Suggested answer: ${escape(i.answer)}</strong><p>${escape(i.basis)}</p><p>${escape(i.action)}</p></li>`).join('\n')}
            </ol>
        </section>
`;
}
function update(source) {
    const start = '        <section aria-labelledby="sample-overall">', end = '        <section class="sample-result-next"';
    if (!source.includes(start) || !source.includes(end)) throw new Error('Missing public sample markers');
    return source.slice(0, source.indexOf(start)) + render() + source.slice(source.indexOf(end));
}
if (require.main === module) fs.writeFileSync(file, update(fs.readFileSync(file, 'utf8')));
module.exports = { sampleResult, update };
