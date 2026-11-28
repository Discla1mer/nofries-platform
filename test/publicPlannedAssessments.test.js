'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { PUBLIC_ROOT_FILES } = require('../lib/publicAssets');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const html = read('pricing.html');
const section = html.match(/<section aria-labelledby="pricing-assessments"[\s\S]*?<\/section>/)[0];
const text = section.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

// The public terms must match the dashboard terms word for word.
const APPROVED = [
    'NZ$99 + GST per organisation per month or NZ$990 + GST per year (two months free).',
    'One plan includes both the NIST CSF 2.0 and ISO 27001 readiness self-assessments. There is no per-framework charge.',
    'Both are included at no extra charge during the NZ$1,250 + GST 90-day engagement.',
    'We invoice manually, then our staff enable access. No payment card is needed.'
];
const ISO_LIMIT = 'The ISO 27001 readiness self-assessment is not certification. For accredited certification, use an accredited certification body.';

test('public paid assessment copy states the approved terms as an available add-on', () => {
    for (const sentence of [APPROVED[1], APPROVED[3]]) expect([sentence, text.includes(sentence)]).toEqual([sentence, true]);
    expect(text).not.toMatch(/Advisers pay/);
    expect(text).toMatch(/Both are included at no extra charge during the 90-day engagement/);
    expect(text).toContain('The NIST CSF 2.0 and ISO 27001 readiness self-assessments are available as a paid add-on.');
    expect(text).toContain(ISO_LIMIT);
    expect(text).not.toMatch(/planned|not available yet|will be published|\bquarters?\b|\bFY\d{2}\b/i);
    expect(text).not.toMatch(/\b(?:certified|compliant|audit)\b/i);
    expect(section).toContain('href="/contact.html"');
    expect(text).toContain('choose “Ask No Fries to set this up”');
    expect(html).toContain('id="pricing-future-assessments"');
});

test('the public terms are the same sentences the dashboard shows', () => {
    const dashboard = read('api/shared/protectedAssets/dashboardShell.js');
    const terms = dashboard.match(/const terms = element\('p', '', '([^']+)'\);/)[1];
    expect(terms).toBe(APPROVED.join(' '));
    expect(dashboard).toContain("'Ask No Fries to set this up'");
});

test('no public page still says the paid assessments are planned or unpriced', () => {
    for (const file of PUBLIC_ROOT_FILES.filter(name => name.endsWith('.html'))) {
        const page = read(file);
        expect([file, /readiness self-assessments are planned|Prices will be published|Planned paid assessments/i.test(page)]).toEqual([file, false]);
    }
    // Earlier links to the planned item still land on the now-Done paid item.
    expect(read('roadmap.html')).toMatch(/<article data-roadmap-item="paid-assessments" id="roadmap-planned"/);
});
