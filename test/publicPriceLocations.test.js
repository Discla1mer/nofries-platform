'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { readPublicPaidPricing } = require('../api/shared/publicPaidPricing');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const price = 'NZ$99 + GST per organisation per month or NZ$990 + GST per year (two months free).';

// Dollar figures may appear on any page where they help (owner decision, 26 Nov 2026);
// pricing is grouped by section, not banned elsewhere. The paid rate still only
// comes back from the API when the paid-frameworks flag is on.
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
