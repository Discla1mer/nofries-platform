'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { PUBLIC_ROOT_FILES } = require('../lib/publicAssets');

const root = path.join(__dirname, '..');
const file = 'fictional-nist-example.html';
const html = fs.readFileSync(path.join(root, file), 'utf8');

test('the public NIST example is a fictional six-function snapshot with one restore action', () => {
    expect(PUBLIC_ROOT_FILES).toContain(file);
    expect(html).toContain('<meta name="robots" content="noindex">');
    expect(html).toContain('Fictional example');
    expect(html).toContain('volunteer costume library');
    expect([...html.matchAll(/<strong>(\w+)\.<\/strong>/g)].map(match => match[1]))
        .toEqual(['Govern', 'Identify', 'Protect', 'Detect', 'Respond', 'Recover']);
    expect(html).toContain('has never timed a restore');
    expect(html).toContain('Before the next committee meeting, Mere will restore a test copy');
    expect(html).toContain('record how long it takes and keep the dated result');
    expect(html).toContain('href="/dashboard#cyber-security"');
    expect(html).not.toMatch(/<(?:script|form|iframe)\b|\/api\/|paidQuestionnaire|paidResults/i);
});

test('public pages and the sitemap do not promote the locked-picker example', () => {
    for (const other of PUBLIC_ROOT_FILES.filter(name => name !== file && /\.html$|^sitemap\.xml$/.test(name))) {
        expect(fs.readFileSync(path.join(root, other), 'utf8')).not.toContain('/' + file);
    }
});
