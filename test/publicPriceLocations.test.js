'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { PUBLIC_ROOT_FILES, PUBLIC_SCRIPT_FILES } = require('../lib/publicAssets');
const { readPublicPaidPricing } = require('../api/shared/publicPaidPricing');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const pricePattern = /\$\s*\d/;
const price = 'NZ$99 + GST per organisation per month or NZ$990 + GST per year (two months free).';

// Uses the public ship lists, plus the separately generated /try document.
// Staff-only quotes, data fixtures, styles, API responses and dynamically
// concatenated numbers are outside this literal source check.
test('price literals are absent from public page and script sources outside Pricing', () => {
    const files = [...PUBLIC_ROOT_FILES.filter(f => f.endsWith('.html') && f !== 'pricing.html'),
        ...PUBLIC_SCRIPT_FILES.map(f => 'js/' + f), 'demo/try/document.js'];
    for (const file of files) {
        const normalized = read(file).replace(/&dollar;|&#(?:36|x24);/gi, '$').replace(/&nbsp;/g, ' ');
        expect([file, pricePattern.test(normalized)]).toEqual([file, false]);
    }
});

test('the protected consumer dashboard contains prices only in its flagged paid card and terms', () => {
    const shell = read('api/shared/protectedAssets/dashboardShell.js');
    const paidPriceLines = shell.split('\n').filter(line => pricePattern.test(line));
    expect(paidPriceLines).toHaveLength(2);
    expect(paidPriceLines[0]).toContain("card.append(element('p', '', '" + price);
    expect(paidPriceLines[1]).toContain("const terms = element('p', '', '" + price);
    expect(read('api/shared/protectedAssets/ncscQuestionnaire.js')).not.toMatch(pricePattern);
});

test.each([undefined, 'false', 'TRUE', 'true'])('pricing only returns a rate when enabled: %s', flag => {
    const result = readPublicPaidPricing({ NOFRIES_PAID_FRAMEWORKS_ENABLED: flag });
    expect(result.status).toBe(200);
    expect(result.headers['Cache-Control']).toBe('no-store');
    expect(result.body).toEqual(flag === 'true' ? { price } : {});
});

test.each(['ok', 'disabled', 'bad-json', 'not-ok', 'offline'])('browser leaves the static fallback unless a rate is returned: %s', mode => {
    const target = { textContent: 'Ask us for current pricing.' };
    const fetch = jest.fn(async () => {
        if (mode === 'offline') throw new Error('offline');
        return { ok: mode !== 'not-ok', json: async () => {
            if (mode === 'bad-json') throw new Error('bad JSON');
            return mode === 'disabled' ? {} : { price };
        } };
    });
    vm.runInNewContext(read('js/pricing.js'), { fetch, document: { getElementById: () => target } });
    return new Promise(resolve => setImmediate(resolve)).then(() => {
        expect(fetch).toHaveBeenCalledWith('/api/pricing/paid', expect.objectContaining({ cache: 'no-store', credentials: 'omit' }));
        expect(target.textContent).toBe(mode === 'ok' ? price : 'Ask us for current pricing.');
    });
});

test('the real standalone and SWA route aliases precede catch-alls and use the same gate', async () => {
    const request = require('supertest');
    const site = read('server.js');
    expect(site.indexOf("app.get('/api/pricing/paid'")).toBeLessThan(site.indexOf("app.all('/api/{*splat}'"));
    const standalone = require('../server');
    const routes = JSON.parse(read('staticwebapp.config.json')).routes;
    expect(routes.find(r => r.route === '/pricing')?.rewrite).toBe('/pricing.html');
    const edge = routes.findIndex(r => r.route === '/api/pricing/paid');
    expect(edge).toBeGreaterThanOrEqual(0);
    expect(edge).toBeLessThan(routes.findIndex(r => r.route === '/api/*'));
    expect(routes[edge]).toMatchObject({ methods: ['GET'], allowedRoles: ['anonymous'] });
    expect(await request(standalone).get('/pricing').then(r => r.status)).toBe(200);
    expect(await request(standalone).get('/pricing.html').then(r => r.status)).toBe(200);
    expect(await request(standalone).get('/api/pricing/paid').then(r => [r.status, r.headers['cache-control'], r.body]))
        .toEqual([200, 'no-store', readPublicPaidPricing().body]);
});
