'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { readRoadmap, renderRoadmap, formatDate, marker, LANE_IDS } = require('../scripts/generate-roadmap');
const { PUBLIC_ROOT_FILES } = require('../lib/publicAssets');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const data = readRoadmap();
const html = read('roadmap.html');

test('the published roadmap is exactly generated from the source of truth', () => {
    expect(html.match(marker)?.[0]).toBe(renderRoadmap(data));
    expect(Object.keys(data.lanes)).toEqual(['Done', 'In progress', 'Next', 'Later']);
    expect(new Set(data.items.map(i => i.id)).size).toBe(data.items.length);
    expect(data.notice).toBe('Planned work has no confirmed dates. Scope, order and availability may change, and planned work does not promise subscription inclusion.');
    expect(data.lastUpdated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(html).toContain(`<p>Last updated <time datetime="${data.lastUpdated}">${formatDate(data.lastUpdated)}</time>.</p>`);
    expect(html).toContain('<meta name="description" content="The No Fries product roadmap: what you can use today, what is being built and what is planned. Planned work has no confirmed dates.">');
    for (const [lane, id] of Object.entries(LANE_IDS)) expect(html).toContain(`<h2 id="${id}" tabindex="-1">${lane}</h2>`);
});

test('every item has source PRs; only Done has release proof and a period', () => {
    const source = read('docs/roadmap.md');
    for (const item of data.items) {
        expect(Object.keys(data.lanes)).toContain(item.lane);
        expect(item.quarter).toBeUndefined();
        expect(item.prs.length).toBeGreaterThan(0);
        for (const pr of item.prs) expect(Number.isSafeInteger(pr) && pr > 0).toBe(true);
        if (item.lane === 'Done') {
            expect(item.period).toMatch(/^(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)–(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4}$/);
            expect([
                'https://github.com/Discla1mer/nofries-platform/issues/151#issuecomment-7074953928',
                'https://github.com/Discla1mer/nofries-platform/issues/500#issuecomment-7074327704'
            ]).toContain(item.release);
            for (const pr of item.prs) expect(source).toMatch(new RegExp(`\\| \\[#${pr}\\]\\([^\\n]+\\| \\x60[a-f0-9]{40}\\x60 \\|`));
        } else {
            expect(item.release).toBeUndefined();
            expect(item.period).toBeUndefined();
        }
    }
});

test('engineering provenance remains in review sources and cannot enter customer HTML', () => {
    expect(html).not.toMatch(/github\.com|issuecomment-|Release evidence|Source PRs|Sources for/);
    const evidenceOnlyChange = JSON.parse(JSON.stringify(data));
    for (const item of evidenceOnlyChange.items) {
        item.prs = [999999];
        item.release = 'https://github.com/Discla1mer/nofries-platform/issues/999#issuecomment-999';
    }
    expect(renderRoadmap(evidenceOnlyChange)).toBe(renderRoadmap(data));
});

test('planned paid work, copy limits and undated planned lanes cannot be lost', () => {
    const generated = html.match(marker)[0];
    const copy = generated.replace(/<p>Last updated <time[^>]*>[^<]*<\/time>\.<\/p>/, ' ').replace(/<[^>]*>/g, ' ');
    expect(copy).not.toMatch(/\b(?:certified|compliant|audit)\b|NZ\$|\$\d|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2} (?:January|February|March|April|May|June|July|August|September|October|November|December)\b/i);
    expect(html).not.toMatch(/\bFY\d{2}\b|\bquarters?\b|financial year|No verified releases recorded/i);
    const paid = data.items.find(i => i.id === 'paid-assessments');
    expect(paid.lane).not.toBe('Done');
    expect(paid.text).toContain('Paid NIST CSF 2.0 and ISO 27001 readiness self-assessments are planned and are not available yet');
    expect(paid.text).toContain('Prices will be published when these options become available.');
    expect(data.items.find(i => i.id === 'consultant-services').text).toContain('Consultants will see paid assessment status for the client organisations they are authorised to manage.');
    for (const item of data.items.filter(i => i.lane !== 'Done')) {
        const article = html.match(new RegExp(`<article data-roadmap-item="${item.id}"[\\s\\S]*?</article>`))[0];
        expect(article).toContain(`<p class="roadmap-status">${item.lane === 'In progress' ? 'In progress' : 'Planned'}</p>`);
        // Planned work carries no period, month or year.
        expect(article.replace(/<[^>]*>/g, ' ')).not.toMatch(/\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\b|\b20\d{2}\b|\bQ[1-4]\b/);
    }
    for (const lane of ['Next', 'Later', 'In progress']) {
        const section = generated.match(new RegExp(`<section class="roadmap-lane" data-lane="${lane}"[\\s\\S]*?</section>`))[0];
        expect(section).not.toContain('roadmap-period');
    }
});

test('roadmap links and inbound public fragments resolve without changing unlisted previews', () => {
    for (const match of html.matchAll(/href="([^"]+)"/g)) {
        const url = new URL(match[1], 'https://nofries.nz/roadmap.html');
        expect(url.origin).toBe('https://nofries.nz');
        const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        if (['login', 'try'].includes(file)) continue; // Existing routed entry points.
        expect(fs.existsSync(path.join(root, file))).toBe(true);
        if (url.hash) expect(read(file)).toContain(`id="${url.hash.slice(1)}"`);
    }
    for (const file of PUBLIC_ROOT_FILES.filter(f => f.endsWith('.html'))) {
        expect(read('docs/review/stream-h/inventory.md')).toContain('`' + file + '`');
        for (const match of read(file).matchAll(/href="\/roadmap.html#([^"]+)"/g)) expect(html).toContain(`id="${match[1]}"`);
    }
    expect(html).not.toMatch(/href="\/fictional-(?:iso|nist)-example.html/);
});

// The release published information, not access to the disabled assessments.
test('942ea19 information is Done while the paid capability remains planned', () => {
    const information = ['planned-assessment-information', 'fictional-readiness-examples'].map(id => data.items.find(item => item.id === id));
    for (const item of information) {
        expect(item).toMatchObject({ period: 'Oct–Dec 2026', lane: 'Done', release: 'https://github.com/Discla1mer/nofries-platform/issues/500#issuecomment-7074327704' });
        expect(item.text).toContain('not available yet');
    }
    expect(information[1].text).toMatch(/fictional.*made-up/);
    expect(data.items.find(item => item.id === 'paid-assessments').lane).toBe('In progress');
    expect(data.items.filter(item => item.lane === 'Done' && item.period !== 'Oct–Dec 2026')).toEqual([]);
});
