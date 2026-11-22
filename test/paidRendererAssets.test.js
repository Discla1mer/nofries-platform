'use strict';

const fs = require('node:fs');
const { paidFrameworks } = require('../api/shared/protectedAssets/dashboardRegistry');
const { parseAsset, matchesSelection, packagedAsset } = require('../api/shared/paidRendererAssets');
const { assetPath } = require('../scripts/tests/paid-renderer-browser.cjs');

const generation = 'a'.repeat(64);
function parse(url) {
    const [route, query] = url.slice('/api/dashboard/'.length).split('?');
    return parseAsset(route, query);
}

test.each(paidFrameworks)('fixed renderer URLs bind $label, its generation and its bytes', ref => {
    const url = assetPath(ref, 'questionnaire', generation);
    const asset = parse(url);
    const next = parse(assetPath(ref, 'questionnaire', generation));
    expect(next.nonce).not.toBe(asset.nonce);
    expect(next.fingerprint).not.toBe(asset.fingerprint);
    expect(matchesSelection(next, generation)).toBe(true);
    expect(matchesSelection({ ...asset, nonce: next.nonce }, generation)).toBe(false);
    expect(parse(url.replace(asset.nonce + '.', ''))).toBeNull();
    expect(matchesSelection(asset, generation)).toBe(true);
    expect(matchesSelection(asset, 'b'.repeat(64))).toBe(false);
    expect(matchesSelection({ ...asset, ref: paidFrameworks.find(row => row !== ref) }, generation)).toBe(false);
    expect(matchesSelection({ ...asset, name: 'results' }, generation)).toBe(false);
    expect(url).not.toContain(generation);
    for (const wrong of [url + '&s=0', url.replace('questionnaire.js', 'other.js'),
        url.replace('/assets/', '/assets/../assets/'), url.replace(ref.version, 'other'), url.replace('?v=', '?v=x')]) {
        expect(parse(wrong)).toBeNull();
    }
    const read = jest.spyOn(fs, 'readFileSync').mockReturnValueOnce(Buffer.from('different file'));
    try { expect(packagedAsset(asset)).toBeNull(); }
    finally { read.mockRestore(); }
});

test('the collection screen is a separate pinned script, absent from the free bundle', async () => {
    const { createDashboardService } = require('../api/shared/dashboardService');
    const { admissionFixture } = require('./fixtures/dashboardAdmissionFixture');
    const app = await createDashboardService(admissionFixture().adapters).handleRequest({ method: 'GET' }, 'app.js');
    const collection = packagedAsset(parse(assetPath(paidFrameworks[0], 'collection', generation)));
    expect(app.status).toBe(200); expect(collection.status).toBe(200);
    expect(collection.headers['Cache-Control']).toMatch(/no-store/);
    expect(collection.body).toContain('The start could not be confirmed.');
    expect(app.body).not.toContain('The start could not be confirmed.');
    expect(app.body).not.toContain(collection.body);
});
