'use strict';

const fs = require('node:fs');
const { createHash } = require('node:crypto');
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

test('each questionnaire serves only the reviewed bytes for its exact tuple', async () => {
    const [nist, iso] = paidFrameworks;
    const nistAsset = parse(assetPath(nist, 'questionnaire', generation));
    const isoAsset = parse(assetPath(iso, 'questionnaire', generation));
    const shared = fs.readFileSync(require.resolve('../api/shared/protectedAssets/paidQuestionnaire.js'));
    const terms = fs.readFileSync(require.resolve('../api/shared/protectedAssets/isoQuestionnaireGlossary.js'));
    for (const [asset, expected, size, sri] of [
        [nistAsset, shared, 17393, 'sha256-7uNUdqKXH144EUyS7+mbScmoiVmc9L1M/sKupp61s8s='],
        [isoAsset, Buffer.concat([shared, terms]), 21287, 'sha256-uPXUYG6kI9hkxxxowe6STXrIfyu7LJR4+9rvNezqZHg=']
    ]) {
        const response = packagedAsset(asset);
        expect(response.status).toBe(200);
        expect(response.headers['Cache-Control']).toMatch(/private, no-store/);
        const body = Buffer.from(response.body);
        expect(body).toEqual(expected);
        expect(body.length).toBe(size);
        expect('sha256-' + createHash('sha256').update(body).digest('base64')).toBe(sri);
        expect(asset.integrity).toBe(sri);
    }
    expect(parse(assetPath(nist, 'questionnaire', generation).replace(nist.profileId + '/' + nist.version,
        iso.profileId + '/' + iso.version))).toBeNull();
    expect(parse(assetPath(iso, 'questionnaire', generation).replace(iso.profileId + '/' + iso.version,
        nist.profileId + '/' + nist.version))).toBeNull();
    expect(packagedAsset({ ...isoAsset, ref: { ...iso, version: 'other' } })).toBeNull();
    expect(packagedAsset({ ...isoAsset, ref: nist })).toBeNull();
    const { createDashboardService } = require('../api/shared/dashboardService');
    const { admissionFixture } = require('./fixtures/dashboardAdmissionFixture');
    const free = await createDashboardService(admissionFixture().adapters).handleRequest({ method: 'GET' }, 'app.js');
    expect(free.status).toBe(200);
    expect(free.body).not.toContain(terms.toString());
    expect(free.body).not.toContain(shared.toString());
});

test('the host serves the exact reviewed NIST board reader', () => {
    const nist = paidFrameworks.find(ref => ref.profileId === 'nf-nist-csf-2-0-core');
    const asset = parse(assetPath(nist, 'results', generation));
    const response = packagedAsset(asset);
    expect(response?.status).toBe(200);
    expect(response.headers['Cache-Control']).toMatch(/no-store/);
    // SHA-256 of the reviewed reader at #521, independent of the host registry.
    expect(createHash('sha256').update(response.body).digest('hex'))
        .toBe('3e5611cb3f4a23494713b3f118cedc95f951912f4b879cdb072156325b379967');
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
