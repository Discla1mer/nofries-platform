'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { sampleResult, update } = require('../scripts/build-sample-result');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'sample-result.html'), 'utf8');
const registry = JSON.parse(fs.readFileSync(path.join(root, 'docs', 'feature-status.json'), 'utf8'));
const text = value => value.replaceAll('&quot;', '"').replaceAll('&amp;', '&').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
test('the page is labelled as a fictional example before anything else', () => {
    const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/)[1];
    expect(main.trim()).toMatch(/^<p class="sample-result-banner"><strong>Example only — fictional business\.<\/strong>/);
    expect(html).toContain('Harbourview Logistics');
});

test('figures and top five gaps match the real result view for the same answers', () => {
    const { gaps, result } = sampleResult();
    expect(text(html)).toContain('Reported implementation ' + result.attainment);
    expect(text(html)).toContain(result.completed + ' of ' + result.total + ' questions');
    const table = html.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/)[1];
    const rows = [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(row => text(row[1]));
    // Phones show label/value rows (F1-R05); explicit roles keep the table relationships.
    expect(html).toMatch(/<table class="sample-result-table" role="table">/);
    expect([...table.matchAll(/<td role="cell" data-label="(Reported implementation|Questions)">/g)]).toHaveLength(rows.length * 2);
    expect([...table.matchAll(/<th scope="row" role="rowheader">/g)]).toHaveLength(rows.length);
    expect(rows).toEqual(result.domains.map(domain => `${domain.title} ${domain.attainment} ${domain.total}`));
    expect(gaps).toHaveLength(5);
    const items = [...html.matchAll(/<li data-gap-item="([^"]+)">([\s\S]*?)<\/li>/g)];
    expect(items.map(item => item[1])).toEqual(gaps.map(gap => gap.itemId));
    items.forEach((item, index) => {
        const gap = gaps[index];
        expect(text(item[2])).toBe(`${gap.title} Answer: ${gap.answer} Why it matters: ${gap.why} What to do next: ${gap.firstCheck}`);
    });
});

test('it ends with the sign-up and contact paths and claims only live capabilities', () => {
    const next = html.match(/<section class="sample-result-next"[\s\S]*?<\/section>/)[0];
    expect([...next.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/g)].map(match => [match[1], match[2]]))
        .toEqual([['/login?intent=create', 'Start your free assessment'], ['/contact.html', 'Talk to us']]);
    expect(html).not.toMatch(/\sstyle=|fonts\.googleapis|https?:\/\/(?!nofries\.nz\/)/);
    const visible = text(html.replace(/<(script|style)\b[\s\S]*?<\/\1>/g, ' '));
    for (const item of registry.capabilities.filter(entry => entry.status !== 'live')) {
        for (const claim of item.availabilityClaims) {
            expect([item.id, visible.match(new RegExp(claim, 'i'))?.[0] || null]).toEqual([item.id, null]);
        }
    }
});

test('the sample captures the first campaign before its links become interactive', () => {
    const campaignScript = '<script src="/js/enquiry-availability.js"></script>';
    const head = html.slice(0, html.indexOf('</head>'));
    expect(head).toContain(campaignScript);
    expect(head).toContain('<meta name="referrer" content="no-referrer">');
    expect(html.replace(campaignScript, '')).not.toMatch(/<script\b|\son\w+=/i);
});

test('NCSC is spelled out at first use and the example figure is explained from the answers', () => {
    for (const page of [html, fs.readFileSync(path.join(root, 'index.html'), 'utf8')]) {
        const body = text(page.match(/<body\b[\s\S]*<\/body>/)[0]);
        expect(body.indexOf('NCSC')).toBe(body.indexOf('New Zealand’s National Cyber Security Centre (NCSC)') + 'New Zealand’s National Cyber Security Centre ('.length);
    }
    const { result, detail, metadata } = sampleResult();
    expect(result.total).toBe(16);
    expect(result.lowerDisplay).not.toBe(result.upperDisplay);
    expect(html).toContain('stroke-dasharray="' + parseFloat(result.lowerDisplay) + ' 100"');
    for (const option of metadata.responseOptions) {
        const n = detail.responses.filter(row => row.optionId === option.id).length;
        if (n) expect(text(html)).toContain(option.label + ': ' + n);
    }
    expect(update(html)).toBe(html);
    expect(html).not.toMatch(/earlier version of the check|top three gaps|This assessment does not ask for this detail/i);
    expect(text(html)).toContain('Guide and Govern is about leadership, priorities and everyday guidance');
});

test('on phones a figure never breaks across lines, and the header reads as one column (#716)', () => {
    const css = require('node:fs').readFileSync(require('node:path').join(__dirname, '../home.css'), 'utf8');
    const phone = css.match(/@media \(max-width: 40rem\) \{\s*\.sample-result-table thead[\s\S]*?\n\}/)[0];
    expect(phone).toMatch(/\.sample-result-table \{ overflow-wrap: normal; \}/);
    expect(phone).toMatch(/\.sample-result-table td \{ display: grid; grid-template-columns: minmax\(0, 1fr\) auto;[^}]*white-space: nowrap;/);
    expect(phone).toMatch(/\.sample-result-table td::before \{[^}]*white-space: normal; \}/);
    expect(phone).toMatch(/\.sample-result-table td > \.sample-bar \{ grid-column: 1 \/ -1; \}/);
    // The roadmap's two-column intro must not split this page's eyebrow, name and lead.
    expect(css).toMatch(/\.sample-result \.public-roadmap-intro \{ display: block; max-width: 780px; \}/);
    expect(css.indexOf('.sample-result .public-roadmap-intro { display: block')).toBeGreaterThan(css.indexOf('.public-roadmap-intro { display: grid;'));
});
