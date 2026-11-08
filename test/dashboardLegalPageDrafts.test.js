'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const request = require('supertest');
const { PUBLIC_ROOT_FILES } = require('../lib/publicAssets');
const root = path.join(__dirname, '..'), packet = 'docs/privacy/page-drafts/';
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const ids = html => [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
const archives = [
    ['privacy-2026-09-29.htm', 11522, '5022838d7397dd4816db8a568590ce2d1c1823e7b9634aaacc7387ec0833b711'],
    ['privacy-2026-09-30.htm', 13003, 'b9816c6c189b41104b12d3a9cbd5f6793398cec31c7084f4302ea28f870579fe']
];

test.each(archives)('%s retains exact historical source without private Git ancestry', (file, length, hash) => {
    const bytes = fs.readFileSync(path.join(root, packet, file));
    expect(bytes.length).toBe(length); expect(digest(bytes)).toBe(hash);
});

test('proposed links resolve against the proposed legal pages and existing public assets', () => {
    for (const file of ['terms.html', 'privacy.html']) {
        const html = read(packet + file), anchors = ids(html);
        expect(new Set(anchors).size).toBe(anchors.length);
        expect(html.match(/<h1\b/g)).toHaveLength(1);
        expect(html.indexOf('id="main-content"')).toBeGreaterThan(html.indexOf('</header>'));
        for (const [, href] of html.matchAll(/\bhref="([^"]+)"/g)) {
            const url = new URL(href, 'https://nofries.nz/' + file);
            if (url.origin !== 'https://nofries.nz') continue;
            if (url.pathname === '/login') { expect(['?intent=create', '?intent=login']).toContain(url.search); continue; }
            const name = url.pathname.slice(1) || 'index.html';
            const target = ['terms.html', 'privacy.html', ...archives.map(a => a[0])].includes(name) ? packet + name : name;
            expect(fs.existsSync(path.join(root, target))).toBe(true);
            if (url.hash) expect(ids(read(target))).toContain(url.hash.slice(1));
        }
    }
});

test('drafts preserve existing duties and rights without resolving publication decisions', () => {
    const terms = read(packet + 'terms.html'), privacy = read(packet + 'privacy.html');
    for (const html of [terms, privacy]) {
        expect(html).toContain('NOT AN OPERATIVE NOTICE OR AGREEMENT');
        expect(html).toContain('Approval is required before publication'); expect(html).toContain('[JOEL');
    }
    for (const text of ['does not replace or vary them', 'earlier valid ISC grants', 'third-party licences', 'not an independent audit']) expect(terms).toContain(text);
    for (const text of ['Website enquiries', 'do not themselves prove stored-record deletion', 'not a guarantee of zero provider retention', 'This notice alone does not establish', 'category-specific retention schedule']) expect(privacy).toContain(text);
    expect(privacy).not.toMatch(/are hosted in Microsoft Azure New Zealand North|Azure Storage in Australia East/);
});

test('review assets are excluded from both packages and anonymous application routes', async () => {
    for (const script of ['scripts/build-static.js', 'scripts/build-app-service.js']) execFileSync(process.execPath, [script], { cwd: root, stdio: 'pipe' });
    const app = require('../server').createNoFriesApp();
    for (const file of ['terms.html', 'privacy.html', ...archives.map(a => a[0])]) {
        expect(PUBLIC_ROOT_FILES).not.toContain(packet + file);
        for (const output of ['dist/', 'app-service-dist/']) expect(fs.existsSync(path.join(root, output, packet, file))).toBe(false);
        expect((await request(app).get('/' + packet + file)).status).toBe(404);
    }
    for (const file of ['terms.html', 'privacy.html']) expect(read('dist/' + file)).not.toContain('NOT AN OPERATIVE NOTICE OR AGREEMENT');
});
