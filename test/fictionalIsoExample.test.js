'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { PUBLIC_ROOT_FILES } = require('../lib/publicAssets');

const root = path.join(__dirname, '..');
const filename = 'fictional-iso-example.html';
const html = fs.readFileSync(path.join(root, filename), 'utf8');

test('the unlisted example has three fictional views and no assessment or customer inputs', () => {
    expect(PUBLIC_ROOT_FILES).toContain(filename);
    expect(html).toContain('<meta name="robots" content="noindex">');
    expect(html).toContain('All the details are made up.');
    expect(Array.from(html.matchAll(/<h2[^>]*>([^<]+)<\/h2>/g), match => match[1]))
        .toEqual(['Readiness view', 'Statement of Applicability', 'Board summary']);
    expect(html).toContain('ISO 27001 readiness self-assessment');
    expect(html).toContain('href="/dashboard#cyber-security"');
    expect(html).not.toMatch(/<(?:script|form|iframe)\b|\/api\/|paidQuestionnaire|paidResults|[a-f\d]{64}|certif|conform|complianc|\baudit\b/i);
    for (const file of [...PUBLIC_ROOT_FILES.filter(name => name.endsWith('.html') && name !== filename), 'sitemap.xml']) {
        expect(fs.readFileSync(path.join(root, file), 'utf8')).not.toContain('/' + filename);
    }
});
