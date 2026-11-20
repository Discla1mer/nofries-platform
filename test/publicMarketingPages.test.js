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

test('the roadmap leads with a plain summary and keeps the board summary consistent', () => {
    expect(roadmap).toContain('<h2 id="roadmap-for-you">What’s coming for you</h2>');
    expect(roadmap).toContain('90-day managed security</a> is NZ$1,250 + GST.');
    expect(roadmap).toContain('Managed IT is the separate day-to-day service.');
    expect(roadmap).toContain('a report you can download yourself. That report is not available yet');
    expect(roadmap).toContain('includes a written summary you can give your board or insurer now.');
    expect(roadmap).not.toMatch(/one-page summary for boards and insurers is the first report planned/);
    expect(roadmap).toContain('<summary>For IT providers</summary>');
    expect(roadmap).toContain('<h2 id="roadmap-planned"><span class="roadmap-status">Planned</span> Later work</h2>');
    const providers = roadmap.match(/<details class="public-roadmap-providers">([\s\S]*?)<\/details>/);
    expect(providers).not.toBeNull();
    for (const term of ['Datto RMM', 'MDR', 'SOC 2 Type I', 'subprocessor', 'SMB1001']) {
        expect(providers[1]).toContain(term);
        expect(visible(roadmap.slice(0, roadmap.indexOf('<details class="public-roadmap-providers">')))).not.toContain(term);
    }
});
