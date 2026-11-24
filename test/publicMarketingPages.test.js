'use strict';

const fs = require('node:fs');
const path = require('node:path');

const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const roadmap = read('roadmap.html');
const css = read('home.css');
const visible = html => html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('the homepage reassurance matches the page sans text', () => {
    const block = css.slice(css.indexOf('.homepage-reassurance {'), css.indexOf('}', css.indexOf('.homepage-reassurance {')));
    expect(block).toContain('font-family: var(--font-sans)');
    expect(block).toContain('font-size: 1rem');
    expect(block).toContain('color: var(--ink)');
    expect(block).not.toMatch(/font-serif|italic/);
    const reading = css.slice(css.indexOf('.homepage-reassurance, .homepage-assessment-note'));
    expect(reading.slice(0, reading.indexOf('}'))).toContain('font-size: 1rem');
});

test('the roadmap keeps service summaries distinct from planned reports', () => {
    expect(roadmap).toContain('90-day managed security includes a written summary you can give your board or insurer now.');
    expect(roadmap).toContain('Managed IT is the separate day-to-day service.');
    expect(roadmap).toContain('We work through three improvements with you.');
    expect(roadmap).toContain('the agreed scope needs to say whether No Fries, you or your IT provider makes the change.');
    expect(roadmap).toContain('Hands-on changes by No Fries need to be separately agreed in that scope.');
    expect(roadmap).not.toMatch(/fix three gaps with you|three improvements we own/i);
    expect(roadmap).toContain('a report you can download yourself are not available yet.');
    expect(roadmap).toContain('href="/pricing.html#pricing-pilot"');
    expect(roadmap).not.toMatch(/audit-ready|SOC 2 audit/);
});
