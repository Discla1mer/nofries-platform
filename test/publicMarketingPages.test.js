'use strict';

const fs = require('node:fs');
const path = require('node:path');

const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const home = read('index.html');
const roadmap = read('roadmap.html');
const css = read('home.css');
const visible = html => html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('the homepage names the published 90-day managed security offer', () => {
    expect(home).toContain('class="homepage-offer"');
    expect(home).toContain('>90-day managed security</a> is NZ$1,250 + GST.');
    expect(home).toContain('fix three gaps with you, review progress at two month-ends and give you a written summary for your board or insurer.');
    expect(home).toContain('ask No Fries about <a href="/pricing.html#pricing-pilot">90-day managed security</a>');
    expect(home).not.toMatch(/fix your top gaps with you in 90 days|we own with you|Managed IT is NZ\$/i);
    expect((home.match(/href="\/pricing\.html#pricing-pilot"/g) || []).length).toBe(2);
});

test('the homepage reassurance matches the page sans text', () => {
    const block = css.slice(css.indexOf('.homepage-reassurance {'), css.indexOf('}', css.indexOf('.homepage-reassurance {')));
    expect(block).toContain('font-family: var(--font-sans)');
    expect(block).toContain('font-size: 1rem');
    expect(block).toContain('color: var(--ink)');
    expect(block).not.toMatch(/font-serif|italic/);
    const reading = css.slice(css.indexOf('.homepage-reassurance, .homepage-offer, .homepage-assessment-note'));
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

test('public header links already keep a 44px target', () => {
    expect(css).toMatch(/body \.site-header\.public-site-header nav a \{[^}]*min-height: 44px;/);
    expect(css).toMatch(/body:is\(\[data-page="dashboard-home"\], \[data-page="managed-it-information"\], \[data-page="product-roadmap"\]\) \.site-header nav a \{[^}]*min-height: 44px;/);
    const phone = css.match(/@media \(max-width: 700px\) \{\s*body \.site-header:has\(> nav\[aria-label="Main navigation"\]\)[\s\S]*?\n\}/);
    expect(phone[0]).toMatch(/min-height: 48px;/);
});
