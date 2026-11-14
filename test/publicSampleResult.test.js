'use strict';

// The public example result (#151) is static HTML for a fictional business.
// Its figures and gap wording must be what the real result view would show
// for the same answers, so they come from the evaluator and the top-three-gaps
// rule here rather than being restated by hand.
const fs = require('node:fs');
const path = require('node:path');
const picture = require('../api/shared/protectedAssets/organisationPicture');
const { resultModel } = require('../api/shared/protectedAssets/ncscQuestionnaire');
const { buildFixtures } = require('../scripts/build-ncsc-questionnaire-preview');
const { ncscFixture, allResponses, createCommand, saveCommand, submitCommand, SUBJECT, NOW } = require('./fixtures/ncscAssessmentFixture');
const { makeVersion } = require('../api/shared/assessmentLifecycle/postgresNcscAssessmentStore');
const { projectNcscDetail } = require('../api/shared/ncscAssessmentService');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'sample-result.html'), 'utf8');
const registry = JSON.parse(fs.readFileSync(path.join(root, 'docs', 'feature-status.json'), 'utf8'));
const text = value => value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
// Fictional Harbourview Logistics answers, by control code.
const ANSWERS = { RM: 'partial', SA: 'yes', AI: 'partial', SC: 'yes', PA: 'yes', MF: 'no', DU: 'partial',
    LP: 'partial', DR: 'no', RP: 'no', PM: 'yes', SV: 'yes', AC: 'partial', NS: 'yes' };

function sampleResult() {
    const tenant = ncscFixture({ tenantId: 'synthetic-preview-a', organisationId: 'shared-preview-organisation' });
    const responses = allResponses().map(row => ({ ...row, optionId: ANSWERS[row.itemId.split('-')[3]], rationale: null }));
    let version = null;
    for (const command of [createCommand('assessment-sample', 'create-sample', 'Fictional example scope.'),
        saveCommand('assessment-sample', 0, 'save-sample', responses), submitCommand('assessment-sample', 1, 'submit-sample')]) {
        version = makeVersion({ ...tenant.scope, actorSubjectKey: SUBJECT, assessmentId: command.assessmentId,
            action: command.action, expectedRevision: command.expectedRevision, payload: command.payload },
        command.idempotencyKey, version, tenant.state.tenantAggregate, NOW);
    }
    const metadata = buildFixtures().metadata;
    return { metadata, result: resultModel(projectNcscDetail(version), metadata, 'shared-preview-organisation') };
}

test('the page is labelled as a fictional example before anything else', () => {
    const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/)[1];
    expect(main.trim()).toMatch(/^<p class="sample-result-banner"><strong>Example only — fictional business\.<\/strong>/);
    expect(html).toContain('Harbourview Logistics');
});

test('figures and top three gaps match the real result view for the same answers', () => {
    const { metadata, result } = sampleResult();
    expect(text(html)).toContain('Reported implementation ' + result.attainment);
    expect(text(html)).toContain(result.completed + ' of ' + result.total + ' questions');
    const table = html.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/)[1];
    const rows = [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(row => text(row[1]));
    // Phones show label/value rows (F1-R05); explicit roles keep the table relationships.
    expect(html).toMatch(/<table class="sample-result-table" role="table">/);
    expect([...table.matchAll(/<td role="cell" data-label="(Reported implementation|Answers)">/g)]).toHaveLength(rows.length * 2);
    expect([...table.matchAll(/<th scope="row" role="rowheader">/g)]).toHaveLength(rows.length);
    expect(rows).toEqual(result.domains.map(domain => `${domain.title} ${domain.attainment} ${domain.total}`));
    const gaps = picture.topGaps(result, metadata);
    expect(gaps).toHaveLength(3);
    const items = [...html.matchAll(/<li data-gap-item="([^"]+)">([\s\S]*?)<\/li>/g)];
    expect(items.map(item => item[1])).toEqual(gaps.map(gap => gap.itemId));
    items.forEach((item, index) => {
        const gap = gaps[index];
        expect(text(item[2])).toBe(`${gap.title} Answer: ${gap.answer} Why it matters: ${gap.why} What to do next: ${gap.next}`);
    });
});

test('it ends with the sign-up and contact paths and claims only live capabilities', () => {
    const next = html.match(/<section class="sample-result-next"[\s\S]*?<\/section>/)[0];
    expect([...next.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/g)].map(match => [match[1], match[2]]))
        .toEqual([['/login?intent=create', 'Start your free assessment'], ['/contact.html', 'Talk to us']]);
    expect(html).not.toMatch(/<script\b|\sstyle=|fonts\.googleapis|https?:\/\/(?!nofries\.nz\/)/);
    const visible = text(html.replace(/<(script|style)\b[\s\S]*?<\/\1>/g, ' '));
    for (const item of registry.capabilities.filter(entry => entry.status !== 'live')) {
        for (const claim of item.availabilityClaims) {
            expect([item.id, visible.match(new RegExp(claim, 'i'))?.[0] || null]).toEqual([item.id, null]);
        }
    }
});

test('NCSC is spelled out at first use and the example figure is explained from the answers', () => {
    for (const page of [html, fs.readFileSync(path.join(root, 'index.html'), 'utf8')]) {
        const body = text(page.match(/<body\b[\s\S]*<\/body>/)[0]);
        expect(body.indexOf('NCSC')).toBe(body.indexOf('New Zealand’s National Cyber Security Centre (NCSC)') + 'New Zealand’s National Cyber Security Centre ('.length);
    }
    const { result } = sampleResult();
    const counts = Object.values(ANSWERS).reduce((all, answer) => ({ ...all, [answer]: (all[answer] || 0) + 1 }), {});
    expect(((counts.yes + counts.partial / 2) / result.total * 100).toFixed(1) + '%').toBe(result.attainment);
    expect(text(html)).toContain(`Each Yes counts in full, each Partial counts as half and each No counts as zero, so ${counts.yes} Yes and ${counts.partial} Partial out of ${result.total} questions gives ${result.attainment}.`);
    expect(text(html)).toContain('Guide and Govern is about leadership, priorities and everyday guidance');
});
