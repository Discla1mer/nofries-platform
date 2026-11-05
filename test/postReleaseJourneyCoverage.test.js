'use strict';

// Keeps the journey checklist honest: every automated test it cites must still
// exist under the cited title, and every journey step must cite at least one.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const doc = fs.readFileSync(path.join(ROOT, 'docs/post-release-journey-check.md'), 'utf8');
const section = doc.split('## 1. Application tests (CI)')[1].split('\n## ')[0];
const STEPS = ['Fresh signup', 'Correct organisation', 'Assessment', 'Save', 'Sign out', 'Return', 'Results'];
const CITATION = /`(test\/[A-Za-z0-9]+\.test\.js)` — "([^"]+)"/g;

const rows = Object.fromEntries(section.split('\n')
    .map(line => line.match(/^\| ([^|]+) \| (.+) \|$/))
    .filter(match => match && STEPS.includes(match[1].trim()))
    .map(match => [match[1].trim(), [...match[2].matchAll(CITATION)].map(([, file, title]) => ({ file, title }))]));

test('every journey step cites at least one automated test', () => {
    expect(Object.keys(rows)).toEqual(STEPS);
    for (const step of STEPS) expect([step, rows[step].length > 0]).toEqual([step, true]);
});

test.each(Object.values(rows).flat().map(c => [c.file, c.title]))('%s still contains "%s"', (file, title) => {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    expect(source.includes(`'${title}'`) || source.includes(`\`${title}`)).toBe(true);
});
