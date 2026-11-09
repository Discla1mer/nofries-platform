const fs = require('node:fs');
const path = require('node:path');

const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');

test('service guide home and overview links return to Managed IT', () => {
    const html = read('scope.html');
    expect(html.match(/href="\/managed-it\.html"/g)).toHaveLength(3);
    expect(html.match(/href="\/managed-it\.html" aria-label="No Fries Managed IT home"/g)).toHaveLength(2);
    expect(html).toContain('href="/managed-it.html">Back to overview</a>');
    expect(html).not.toContain('href="/"');
});

test.each(['scope.html', 'report.html'])('%s footer offers named Privacy and Terms links to existing pages', name => {
    const footer = read(name).match(/<footer\b[^>]*>([\s\S]*?)<\/footer>/)[1];
    expect(footer.match(/href="\/terms\.html"/g)).toHaveLength(1);
    expect(footer).toMatch(/<a href="\/privacy\.html">Privacy<\/a>\s+<a href="\/terms\.html">Terms<\/a>/);
    for (const page of ['privacy.html', 'terms.html', 'managed-it.html']) {
        expect(fs.existsSync(path.join(__dirname, '..', page))).toBe(true);
    }
});

test.each([
    ['style.css', '.scope-page .site-footer > div:last-child'],
    ['customer-report.css', 'body[data-page="customer-report"] .report-footer']
])('%s allows the scoped footer links to wrap at narrow widths', (file, selector) => {
    const rules = [...read(file).matchAll(/([^{}]+)\{([^{}]*)\}/g)];
    const declarations = rules.filter(([, selectors]) => selectors.trim() === selector)
        .map(([, , body]) => body).join(' ');
    expect(declarations).toMatch(/flex-wrap:\s*wrap\s*;/);
});
