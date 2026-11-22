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
    expect(data.published.map(e => e.id)).toEqual(['fictional-readiness-examples', 'service-responsibilities', 'paid-assessments', 'adviser-paid-status', 'simpler-sign-up']);
    expect(data.published[0].release).toBe('942ea196c1bbfe8151ea0ad7971eff60cfee45ba');
    expect(data.published[1].release).toBe('99771994a1d94e6e777ae8673a6da90a8aec799e');
    // Activation of the paid-frameworks and deferred-details flags on 62a9702.
    for (const entry of data.published.slice(2)) expect(entry.release).toBe('https://github.com/Discla1mer/nofries-platform/issues/151#issuecomment-7084596099');
    expect(data.planned).toEqual([]);
    for (const entry of [...data.published, ...data.planned]) expect(entry.prs.length).toBeGreaterThan(0);
});

test('published entries state the approved paid terms, the ISO limit and the sign-up change exactly', () => {
    expect(data.published[0].text).toMatch(/fictional.*made-up/);
    expect(data.published[0].text).toContain('do not provide access');
    expect(data.published.find(e => e.id === 'paid-assessments').text).toBe('Paid NIST CSF 2.0 and ISO 27001 readiness self-assessments are now available. ' +
        'NZ$99 + GST per organisation per month or NZ$990 + GST per year (two months free). ' +
        'One plan includes both the NIST CSF 2.0 and ISO 27001 readiness self-assessments. There is no per-framework charge. ' +
        'Both are included at no extra charge during the NZ$1,250 + GST 90-day engagement. ' +
        'Advisers pay the same rate per client organisation and we invoice the adviser. ' +
        'We invoice manually, then our staff enable access. No payment card is needed. ' +
        'The ISO 27001 readiness self-assessment is not certification. For accredited certification, use an accredited certification body.');
    expect(data.published.find(e => e.id === 'adviser-paid-status').text).toBe('Advisers can see paid assessment status for the client organisations they are authorised to manage. They see status only, not answers or results.');
    expect(data.published.find(e => e.id === 'simpler-sign-up').text).toContain('We ask for your name, role and business address after your first result');
    expect(data.published.find(e => e.id === 'service-responsibilities').text).toBe('The pricing page now explains that, for each improvement, the agreed scope says whether No Fries, you or your IT provider makes the change, and that hands-on changes by No Fries must be agreed separately. The clarification preserves the agreed service scope and existing terms.');
    expect(html).not.toMatch(/readiness self-assessments are planned|Prices will be published|not available yet/i);
    expect(html).not.toMatch(/\b(?:certified|compliant|audit)\b|\b\d{4}-\d{2}-\d{2}\b/i);
    // Deliberate change: the paid assessments are available, and public pages are
    // not flag-gated, so the changelog may now name prices. Only the approved
    // NZ$99 / NZ$990 terms and the existing NZ$1,250 engagement may appear.
    expect([...html.matchAll(/NZ\$([\d,]+)/g)].map(m => m[1])).toEqual(['99', '990', '1,250']);
    expect(html).not.toMatch(/(?<!NZ)\$\s*\d/);
});

test('engineering evidence never appears in customer HTML', () => {
    expect(html).not.toMatch(/github\.com|issuecomment-|942ea19|9977199|NOFRIES_|flag|release receipt/i);
    const evidence = JSON.parse(JSON.stringify(data));
    for (const entry of [...evidence.published, ...evidence.planned]) { entry.prs = [999999]; entry.release = 'internal-evidence'; }
    expect(html).not.toMatch(/NOFRIES_|62a9702|12592b4/);
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
    // With no planned entries the planned section is not rendered at all.
    expect(headings.filter(([level]) => level === 2).map(([, text]) => text)).toEqual(['Published information and changes']);
    expect(headings.some(([, text]) => text === data.period)).toBe(false);
    const sections = Object.fromEntries([...generated.matchAll(/<section aria-labelledby="changelog-(\w+)">([\s\S]*?)<\/section>/g)].map(([, key, body]) => [key, body]));
    expect(sections.published).toContain(`<p class="changelog-period">${data.period}</p>`);
    expect(sections.planned).toBeUndefined();
    const planned = renderChangelog({ ...data, planned: [{ id: 'example', title: 'Example', text: 'Example planned work.', prs: [1] }] });
    const plannedSection = planned.match(/<section aria-labelledby="changelog-planned">([\s\S]*?)<\/section>/)[1];
    expect(plannedSection).toContain('<h2 id="changelog-planned">Planned — not available yet</h2>');
    expect(plannedSection).not.toContain('changelog-period');
    expect(plannedSection.replace(/<[^>]*>/g, ' ')).not.toMatch(/\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\b|\b20\d{2}\b|\bQ[1-4]\b/);
    expect(html).not.toMatch(/\bFY\d{2}\b|\bquarter(?:s|ly)?\b/i);
});
