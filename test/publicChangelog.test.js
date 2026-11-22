'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { readChangelog, renderChangelog, marker } = require('../scripts/generate-changelog');
const { PUBLIC_ROOT_FILES } = require('../lib/publicAssets');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const data = readChangelog(), html = read('changelog.html');

test('the customer changelog has strict parity with its editorial source', () => {
    expect(html.match(marker)?.[0]).toBe(renderChangelog(data));
    expect(data.period).toBe('Oct–Dec 2026');
    expect(data.published.map(e => e.id)).toEqual(['planned-assessment-information', 'fictional-readiness-examples', 'service-responsibilities']);
    expect(data.published.slice(0, 2).every(e => e.release === '942ea196c1bbfe8151ea0ad7971eff60cfee45ba')).toBe(true);
    expect(data.published[2].release).toBe('99771994a1d94e6e777ae8673a6da90a8aec799e');
    for (const entry of [...data.published, ...data.planned]) expect(entry.prs.length).toBeGreaterThan(0);
});

test('published information does not claim paid or deferred functionality is available', () => {
    expect(data.published[0].text).toContain('not available yet');
    expect(data.published[1].text).toMatch(/fictional.*made-up/);
    expect(data.published[1].text).toContain('do not provide access');
    for (const entry of data.planned) expect(entry.text).toContain('not available yet');
    expect(data.planned.find(e => e.id === 'paid-assessments').text).toContain('Prices will be published when these options become available.');
    expect(data.published.find(e => e.id === 'service-responsibilities').text).toBe('The pricing page now explains that, for each improvement, the agreed scope says whether No Fries, you or your IT provider makes the change, and that hands-on changes by No Fries must be agreed separately. The clarification preserves the agreed service scope and existing terms.');
    expect(html).not.toMatch(/\b(?:certified|compliant|audit)\b|NZ\$|\$\s*\d|\b\d{4}-\d{2}-\d{2}\b/i);
});

test('engineering evidence never appears in customer HTML', () => {
    expect(html).not.toMatch(/github\.com|issuecomment-|942ea19|9977199|NOFRIES_|flag|release receipt/i);
    const evidence = JSON.parse(JSON.stringify(data));
    for (const entry of [...evidence.published, ...evidence.planned]) { entry.prs = [999999]; entry.release = 'internal-evidence'; }
    expect(renderChangelog(evidence)).toBe(renderChangelog(data));
});

test('the new page is registered, discoverable and keeps News retired and examples unlisted', () => {
    expect(PUBLIC_ROOT_FILES).toEqual(expect.arrayContaining(['changelog.html', 'changelog.css']));
    expect(read('index.html')).toContain('href="/changelog.html">product changelog</a>');
    expect(read('sitemap.xml')).toContain('<loc>https://nofries.nz/changelog.html</loc>');
    expect(html).not.toMatch(/news\.nofries\.nz|href="\/fictional-(?:nist|iso)-example/);
    expect(read('sitemap.xml')).not.toMatch(/fictional-(?:nist|iso)-example/);
    for (const name of ['fictional-iso-example.html', 'fictional-nist-example.html']) expect(read(name)).toContain('content="noindex"');
});

test('every changelog customer link resolves including its fragment', () => {
    for (const [, href] of html.matchAll(/<a\b[^>]*href="([^"]+)"/g)) {
        const url = new URL(href, 'https://nofries.nz/changelog.html');
        expect(url.origin).toBe('https://nofries.nz');
        if (url.pathname === '/login') continue;
        const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        expect(fs.existsSync(path.join(root, file))).toBe(true);
        if (url.hash) expect(read(file)).toContain(`id="${url.hash.slice(1)}"`);
    }
});

test('headings run h1, section h2, entry h3 with no empty heading; only published work has a period', () => {
    const generated = html.match(marker)[0];
    const headings = [...generated.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/g)].map(([, level, text]) => [Number(level), text.replace(/<[^>]*>/g, '').trim()]);
    for (const [, text] of headings) expect(text).not.toBe('');
    expect(headings[0][0]).toBe(1);
    for (let i = 1; i < headings.length; i++) expect(headings[i][0] - headings[i - 1][0]).toBeLessThanOrEqual(1);
    expect(headings.filter(([level]) => level === 2).map(([, text]) => text)).toEqual(['Published information and changes', 'Planned — not available yet']);
    expect(headings.some(([, text]) => text === data.period)).toBe(false);
    const sections = Object.fromEntries([...generated.matchAll(/<section aria-labelledby="changelog-(\w+)">([\s\S]*?)<\/section>/g)].map(([, key, body]) => [key, body]));
    expect(sections.published).toContain(`<p class="changelog-period">${data.period}</p>`);
    expect(sections.planned).not.toContain('changelog-period');
    expect(sections.planned.replace(/<[^>]*>/g, ' ')).not.toMatch(/\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\b|\b20\d{2}\b|\bQ[1-4]\b/);
    expect(html).not.toMatch(/\bFY\d{2}\b|\bquarter(?:s|ly)?\b/i);
});
