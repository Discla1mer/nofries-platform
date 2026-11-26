'use strict';

const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const request = require('supertest');
const app = require('../server');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const key = 'NOFRIES_NCSC_PROFILE_V2';
let prior;
beforeEach(() => { prior = process.env[key]; });
afterEach(() => { if (prior === undefined) delete process.env[key]; else process.env[key] = prior; });

test.each(['true', 'false', 'TRUE', undefined])('three public current-check counts reflect the server flag: %s', async flag => {
    if (flag === undefined) delete process.env[key]; else process.env[key] = flag;
    const reply = await request(app).get('/api/pricing/paid').expect(200).expect('Cache-Control', 'no-store');
    for (const file of ['index.html', 'roadmap.html', 'sample-result.html']) {
        const html = read(file);
        expect(html).toContain('<script src="/js/free-check-count.js" defer></script>');
        const isHome = file === 'index.html';
        if (isHome) expect(html).toMatch(/id="homepageLead"[^>]*>[^<]*14 questions/);
        else expect(html.match(/<span data-free-check-count>14 questions<\/span>/g)).toHaveLength(1);
        const nodes = [{ nodeType: 3, data: 'Answer 14 questions.' }, { nodeType: 3, data: 'Answer 14 questions about how your business works today.' },
            { nodeType: 3, data: 'Check payment changes with a known number.' }];
        const count = { textContent: '14 questions' };
        const fetch = jest.fn(async () => ({ ok: true, json: async () => reply.body }));
        vm.runInNewContext(read('js/free-check-count.js'), { fetch, document: {
            querySelectorAll: selector => selector === '[data-free-check-count]' ? (isHome ? [] : [count])
                : (isHome ? nodes.map(text => ({ childNodes: [text] })) : []) } });
        await new Promise(resolve => setImmediate(resolve));
        expect(fetch).toHaveBeenCalledWith('/api/pricing/paid', expect.objectContaining({ credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' }));
        const expected = flag === 'true' ? '14 questions (16 if your organisation uses the updated check)' : '14 questions';
        if (isHome) {
            expect(nodes[0].data).toBe('Answer ' + expected + '.');
            expect(nodes[1].data).toBe('Answer ' + expected + ' about how your business works today.');
            expect(nodes[2].data).toBe('Check payment changes with a known number.');
        } else expect(count.textContent).toBe(expected);
    }
    expect(read('sample-result.html')).toContain('Harbourview Logistics answered all 14 questions.');
});
