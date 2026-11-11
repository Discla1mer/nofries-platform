'use strict';
const fs = require('node:fs');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '../roadmap.html'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../home.css'), 'utf8');
const section = name => html.match(new RegExp('<section aria-labelledby="roadmap-' + name + '">([\\s\\S]*?)</section>'))[1];
const themes = name => [...section(name).matchAll(/<details class="roadmap-theme">([\s\S]*?)<\/details>/g)].map(match => match[1]);

test('available capabilities are visible before three development and five planned themes', () => {
    expect(section('live')).not.toContain('<details');
    expect((section('live').match(/<article>/g) || [])).toHaveLength(2);
    expect(themes('development')).toHaveLength(3);
    expect(themes('planned')).toHaveLength(5);
    expect(html.indexOf('id="roadmap-live"')).toBeLessThan(html.indexOf('id="roadmap-development"'));
    expect(html.indexOf('id="roadmap-development"')).toBeLessThan(html.indexOf('id="roadmap-planned"'));
    expect(section('development')).toContain('not release commitments or a delivery order');
});

test.each(['development', 'planned'])('%s disclosures work natively and expose status before opening', name => {
    for (const theme of themes(name)) {
        expect(theme).toMatch(/^\s*<summary>/);
        const summary = theme.match(/<summary>([\s\S]*?)<\/summary>/)[1];
        expect(summary).toContain(name === 'development' ? 'In development' : 'Planned');
        expect(summary).toMatch(/class="roadmap-theme-title">[^<]+</);
        expect(summary).not.toMatch(/<button|<a\b|tabindex|role=/);
        expect(theme).toContain('<article>');
    }
    expect(html).not.toMatch(/<details[^>]*\bopen\b|onclick=|<script/);
});

test('every existing capability stays in its original availability group exactly once', () => {
    const expected = {
        development: ['Faster sign-up and sign-in', 'Update answers and compare results', 'Assess against your own requirements', 'Improvement actions', 'Evidence and board reporting', 'Evidence references and recurring reviews', 'Separate assessment types'],
        planned: ['Reuse controls across frameworks', 'Evidence you can trace and review', 'Connected evidence and continuous checks', 'Risk and exceptions', 'Policies and approvals', 'Assets, identities and devices', 'Supplier and personnel security', 'Recovery and incident readiness', 'Technical assurance', 'Customer questionnaires and audit-ready reporting', 'Prepare for an independent SOC 2 audit', 'Privacy and data responsibilities', 'Accounts that stay open', 'AI governance and IT optimisation']
    };
    for (const [name, titles] of Object.entries(expected)) {
        expect([...section(name).matchAll(/<h3>([^<]+)<\/h3>/g)].map(match => match[1]).sort()).toEqual(titles.sort());
    }
});

test('limits remain with their capabilities and the general caveat stays visible', () => {
    for (const phrase of ['Customer uploads, evidence validation and downloadable reports are not available yet.', 'The existing NCSC assessment remains available as described above.']) expect(section('development')).toContain(phrase);
    for (const phrase of ['not active integrations or included subscription services', 'No Fries does not self-certify or issue the auditor’s opinion.', 'Existing agreed three-month pilot offers and their terms remain unchanged.']) expect(section('planned')).toContain(phrase);
    expect(html).toMatch(/<p class="public-roadmap-note">[^<]*Planned capabilities are not a promise of delivery or subscription inclusion\.<\/p>/);
});

test('disclosure styles are scoped to the roadmap, with visible focus and wrapping layout', () => {
    expect(css).toContain('.public-roadmap .roadmap-theme > summary:focus-visible');
    expect(css).toContain('min-height: 44px; padding: 18px 20px;');
    expect(css).toContain('.public-roadmap .roadmap-theme { min-width: 0;');
    expect(css).toContain('.public-roadmap .roadmap-theme-content > article { max-width: 68ch;');
});
