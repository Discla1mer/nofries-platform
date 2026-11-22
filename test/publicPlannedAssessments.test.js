'use strict';

const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'pricing.html'), 'utf8');
const paragraph = html.match(/<p id="pricing-future-assessments">([\s\S]*?)<\/p>/)[1];

test('public paid assessment copy remains explicitly planned without prices or delivery promises', () => {
    expect(paragraph).toContain('Paid NIST CSF 2.0 and ISO 27001 readiness self-assessments are planned and are not available yet.');
    expect(paragraph).toContain('Planned work has no confirmed dates. Prices will be published when these options become available.');
    expect(paragraph).not.toMatch(/\bquarters?\b|\bFY\d{2}\b/i);
    expect(paragraph).not.toMatch(/NZ\$|\$\d|\b(?:certified|compliant|audit)\b/i);
    expect(paragraph).toContain('href="/roadmap.html#roadmap-planned"');
    expect(fs.readFileSync(path.join(root, 'roadmap.html'), 'utf8')).toContain('id="roadmap-planned"');
});
