'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { readRoadmap, renderRoadmap, marker } = require('../scripts/generate-roadmap');
const { PUBLIC_ROOT_FILES } = require('../lib/publicAssets');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const data = readRoadmap();
const html = read('roadmap.html');

test('the published timeline is exactly generated from the source of truth', () => {
    expect(html.match(marker)?.[0]).toBe(renderRoadmap(data));
    expect(data.quarters.map(q => [q.label, q.period, q.state])).toEqual([
        ['FY26 Q4', 'Apr–Jun 2026', 'historical'], ['FY27 Q1', 'Jul–Sep 2026', 'historical'],
        ['FY27 Q2', 'Oct–Dec 2026', 'current'], ['FY27 Q3', 'Jan–Mar 2027', 'planned'],
        ['FY27 Q4', 'Apr–Jun 2027', 'planned']
    ]);
    expect(data.currentQuarter).toBe('fy27-q2');
    expect(Object.keys(data.lanes)).toEqual(['Done', 'In progress', 'Next', 'Later']);
    expect(new Set(data.items.map(i => i.id)).size).toBe(data.items.length);
    expect(data.notice).toContain('not delivery commitments');
});

test('every item has source PRs; Done has release proof and only historical Done may precede the current quarter', () => {
    const source = read('docs/roadmap.md');
    for (const item of data.items) {
        const quarter = data.quarters.find(q => q.id === item.quarter);
        expect(quarter).toBeDefined();
        expect(Object.keys(data.lanes)).toContain(item.lane);
        expect(item.prs.length).toBeGreaterThan(0);
        for (const pr of item.prs) expect(Number.isSafeInteger(pr) && pr > 0).toBe(true);
        if (quarter.state === 'historical') expect(item.lane).toBe('Done');
        if (item.lane === 'Done') {
            expect(quarter.state).not.toBe('planned');
            expect(item.release).toBe('https://github.com/Discla1mer/nofries-platform/issues/151#issuecomment-7074953928');
            for (const pr of item.prs) expect(source).toMatch(new RegExp(`\\| \\[#${pr}\\]\\([^\\n]+\\| \\x60[a-f0-9]{40}\\x60 \\|`));
        } else expect(item.release).toBeUndefined();
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

test('planned paid work, copy limits and quarter precision cannot be lost', () => {
    const copy = html.match(marker)[0].replace(/<[^>]*>/g, ' ');
    expect(copy).not.toMatch(/\b(?:certified|compliant|audit)\b|NZ\$|\$\d|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2} (?:January|February|March|April|May|June|July|August|September|October|November|December)\b/i);
    const paid = data.items.find(i => i.id === 'paid-assessments');
    expect(paid.lane).not.toBe('Done');
    expect(paid.text).toContain('Paid NIST CSF 2.0 and ISO 27001 readiness self-assessments are planned and are not available yet');
    for (const item of data.items.filter(i => i.lane !== 'Done')) {
        const article = html.match(new RegExp(`<article data-roadmap-item="${item.id}"[\\s\\S]*?</article>`))[0];
        expect(article).toContain('<p class="roadmap-status">Planned</p>');
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
