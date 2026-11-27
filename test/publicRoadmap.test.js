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
                'https://github.com/Discla1mer/nofries-platform/issues/500#issuecomment-7074327704',
                // Activation of the paid-frameworks and deferred-details flags on 62a9702.
                'https://github.com/Discla1mer/nofries-platform/issues/151#issuecomment-7084596099',
                'https://github.com/Discla1mer/nofries-platform/issues/151#issuecomment-7122999986',
                // Scoring v2 switched on in production with release 8377e3c.
                'https://github.com/Discla1mer/nofries-platform/issues/151#issuecomment-7204359198'
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

test('paid work is Done without prices, copy limits and undated planned lanes cannot be lost', () => {
    const generated = html.match(marker)[0];
    const copy = generated.replace(/<p>Last updated <time[^>]*>[^<]*<\/time>\.<\/p>/, ' ').replace(/<[^>]*>/g, ' ');
    expect(copy).not.toMatch(/\b(?:certified|compliant|audit)\b|NZ\$|\$\d|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2} (?:January|February|March|April|May|June|July|August|September|October|November|December)\b/i);
    expect(html).not.toMatch(/\bFY\d{2}\b|\bquarters?\b|financial year|No verified releases recorded/i);
    const paid = data.items.find(i => i.id === 'paid-assessments');
    expect(paid.lane).toBe('Done');
    expect(paid.text).toContain('NIST CSF 2.0 and ISO 27001 readiness self-assessments are available as a paid add-on.');
    expect(paid.text).not.toMatch(/invoice|price/);
    expect(paid.text).toContain('The ISO 27001 readiness self-assessment is not certification. For accredited certification, use an accredited certification body.');
    expect(paid.link).toEqual({ href: '/pricing.html#pricing-assessments', label: 'See pricing and how to get access' });
    expect(data.items.find(i => i.id === 'adviser-paid-status')).toMatchObject({ lane: 'Done',
        text: 'Advisers can see paid assessment status for the client organisations they are authorised to manage. They see status only, not answers or results.' });
    expect(data.items.find(i => i.id === 'simpler-signin')).toMatchObject({ lane: 'Done', title: 'Simpler sign-up' });
    expect(data.items.find(i => i.id === 'simpler-signin').text).toContain('We ask for your name, role and business address after your first result');
    expect(data.items.find(i => i.id === 'signup-return').lane).toBe('In progress');
    expect(generated).not.toMatch(/readiness self-assessments are planned|Prices will be published|not available yet and their prices/i);
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
        // Primary sources for the figures and frameworks are the only external links.
        if (url.origin !== 'https://nofries.nz') {
            expect(['https://www.ncsc.govt.nz', 'https://www.nist.gov', 'https://www.iso.org', 'https://www.cisecurity.org']).toContain(url.origin);
            expect(html).toContain(`href="${match[1]}" rel="noopener"`);
            continue;
        }
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

// 942ea19 published the fictional examples; the activation receipt makes the paid, adviser and sign-up items Done.
test('942ea19 examples and the activated items are Done in Oct–Dec 2026', () => {
    const examples = data.items.find(item => item.id === 'fictional-readiness-examples');
    expect(examples).toMatchObject({ period: 'Oct–Dec 2026', lane: 'Done', release: 'https://github.com/Discla1mer/nofries-platform/issues/500#issuecomment-7074327704' });
    expect(examples.text).toMatch(/fictional.*made-up/);
    expect(data.items.find(item => item.id === 'planned-assessment-information')).toBeUndefined();
    for (const id of ['paid-assessments', 'adviser-paid-status', 'simpler-signin']) {
        expect(data.items.find(item => item.id === id)).toMatchObject({ period: 'Oct–Dec 2026', lane: 'Done',
            release: 'https://github.com/Discla1mer/nofries-platform/issues/151#issuecomment-7084596099' });
    }
    expect(data.lastUpdated).toBe('2026-11-28');
    expect(data.items.filter(item => item.lane === 'Done' && item.period !== 'Oct–Dec 2026')).toEqual([]);
});

test('consultant landing and limited dashboard support references have release evidence', () => {
    const release = 'https://github.com/Discla1mer/nofries-platform/issues/151#issuecomment-7122999986';
    for (const [id, pr] of [['consultant-dashboard', 567], ['dashboard-support-reference', 563]]) {
        expect(data.items.find(item => item.id === id)).toMatchObject({ lane: 'Done', prs: [pr], release });
    }
    expect(data.items.find(item => item.id === 'dashboard-support-reference').text).toMatch(/^Some temporary problems loading your dashboard/);
});

test('every item belongs to one line of work with a short map label', () => {
    const { THEMES } = require('../scripts/generate-roadmap');
    for (const item of data.items) {
        expect(Object.keys(THEMES)).toContain(item.theme);
        expect(item.short.length).toBeGreaterThan(0);
        expect(item.short.length).toBeLessThanOrEqual(20);
        expect(html).toMatch(new RegExp(`data-roadmap-item="${item.id}"[^>]* data-theme="${item.theme}" data-short="[^"]+">`));
    }
    expect(html).toContain('<script src="/js/roadmap.js" defer></script>');
    expect(html).not.toMatch(/ style="/);
});

test('NCSC figures: latest quarter charted, survey population stated exactly, framework not credited with a question count (#672)', () => {
    const text = name => read(name).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    const roadmap = read('roadmap.html');
    const chart = roadmap.match(/aria-label="Reported direct financial loss: ([^"]+)"/)[1].split(', ');
    // A rolling two years of NCSC quarterly reports, newest last. Add each new quarter here and in the chart.
    expect(chart).toEqual(['Q4 24 NZ$6.8 million', 'Q1 25 NZ$7.8 million', 'Q2 25 NZ$5.7 million', 'Q3 25 NZ$12.4 million',
        'Q4 25 NZ$3.2 million', 'Q1 26 NZ$5.6 million', 'Q2 26 NZ$2.7 million', 'Q3 26 NZ$5.9 million']);
    expect(roadmap.match(/class="roadmap-bar-hi"[^>]*\/><text[^>]*>([^<]+)</)[1]).toBe('$5.9m');
    expect(roadmap).toContain('href="https://www.ncsc.govt.nz/insights-and-research/insights-reports/"');
    expect(text('roadmap.html')).toContain('quarterly reports for Oct–Dec 2024 to Jul–Sep 2026');
    for (const name of ['roadmap.html', 'board.html', 'invoice-scams.html']) {
        const page = text(name);
        expect([name, /373 businesses/.test(page)]).toEqual([name, false]);
        expect([name, /373 (?:SME )?IT or operational decision makers/.test(page)]).toEqual([name, true]);
        // The Tracker's unit is full-time equivalents (p. 4), not a headcount of full-time staff.
        expect([name, /0–49 full-time equivalents \(FTEs\)/.test(page)]).toEqual([name, true]);
        expect([name, /full-time staff|\d+ (?:to|–) ?\d+ staff\b/.test(page)]).toEqual([name, false]);
        expect([name, /small businesses (?:say|that say)|small businesses, 2026/.test(page)]).toEqual([name, false]);
    }
    expect(text('roadmap.html')).toContain('76% of firms with 20–49 FTEs');
    for (const name of ['roadmap.html', 'index.html', 'pricing.html', 'sample-result.html'])
        expect([name, /Framework\s*:\s*five functions, \d+ questions/.test(text(name))]).toEqual([name, false]);
});

test('no planned item describes a question count that Done or the homepage already claims (#683)', () => {
    const count = /\b(\d+)[- ]question/g, counts = text => new Set([...text.matchAll(count)].map(match => match[1]));
    const live = counts(data.items.filter(item => item.lane === 'Done').map(item => item.text).join(' '));
    for (const number of counts(read('index.html').replace(/<[^>]+>/g, ' ').replace(/(\d+) questions/g, '$1-question'))) live.add(number);
    expect(live.has('16')).toBe(true);
    for (const item of data.items.filter(item => item.lane !== 'Done'))
        for (const number of counts(item.text)) expect([item.id, live.has(number)]).toEqual([item.id, false]);
    expect(data.items.find(item => item.id === 'weighted-assessment').lane).toBe('Done');
});
