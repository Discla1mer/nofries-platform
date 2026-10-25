'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { build, readArchive } = require('../vendor/node-forge-rsa-validated/build-package');

const root = path.join(__dirname, '..');
const vendor = path.join(root, 'vendor/node-forge-rsa-validated');
const provenance = JSON.parse(fs.readFileSync(path.join(vendor, 'PROVENANCE.json')));
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const integrity = bytes => 'sha512-' + crypto.createHash('sha512').update(bytes).digest('base64');
const baselineBytes = fs.readFileSync(path.join(vendor, provenance.upstreamArchive));
const artifactBytes = fs.readFileSync(path.join(vendor, provenance.artifact));
const upstream = readArchive(baselineBytes);
const packaged = readArchive(artifactBytes);
const ORIGINAL_INTEGRITY = 'sha512-LarFH0+6VfriEhqMMcLX2F7SwSXeWwnEAJEsYm5QKWchiVYVvJyV9v7UDvUv+w5HO23ZpQTXDv/GxdDdMyOuoQ==';

test('pins the authentic upstream baseline and exact proposed RSA source patch', () => {
    expect(integrity(baselineBytes)).toBe(ORIGINAL_INTEGRITY);
    expect(provenance.upstreamIntegrity).toBe(ORIGINAL_INTEGRITY);
    expect(provenance.upstreamProposals.map(proposal => proposal.commit)).toEqual([
        'ceba34402e329f0365134f23fe19898756527d65',
        '683ab3344899cc08a581e4d5675a33e87aff7b04'
    ]);
    expect(sha256(upstream.get('package/lib/rsa.js'))).toBe('fd4740238145ec26470eb3f06a627c72039538ce1307dbdce40521f94dfd0a50');
    expect(sha256(packaged.get('package/lib/rsa.js'))).toBe('22cdfb3220439533211cf00ff7c7e6605607761d77a2c3c263411d4c70798c4f');
    expect(sha256(fs.readFileSync(path.join(vendor, 'rsa-digest-validation.patch')))).toBe('2f0f3be76c7a0502b8579e71f32b7df98954a90a7e448084ac08dd86bd55286d');
});

test('ships only Node source, unchanged libraries and the original license', () => {
    const libNames = [...upstream.keys()].filter(name => name.startsWith('package/lib/')).sort();
    expect(libNames).toHaveLength(49);
    expect([...packaged.keys()].sort()).toEqual([...libNames,
        'package/LICENSE', 'package/README.md', 'package/PROVENANCE.json', 'package/package.json'].sort());
    for (const name of libNames) {
        expect(sha256(packaged.get(name))).toBe(provenance.packagedLibSha256[name.slice(8)]);
        if (name !== 'package/lib/rsa.js') expect(packaged.get(name)).toEqual(upstream.get(name));
    }
    expect(packaged.get('package/LICENSE')).toEqual(upstream.get('package/LICENSE'));
    expect(packaged.get('package/LICENSE')).toEqual(fs.readFileSync(path.join(vendor, 'LICENSE')));
    const manifest = JSON.parse(packaged.get('package/package.json'));
    expect(manifest.name).toBe('@nofries/node-forge-rsa-validated');
    expect(manifest.version).toBe('1.4.0-nofries.1');
    expect(manifest.private).toBe(true);
    expect(manifest.main).toBe('lib/index.js');
    expect(manifest.scripts).toBeUndefined();
    expect(manifest.dependencies).toBeUndefined();
    expect(manifest.browser).toBeUndefined();
});

test('the installed node-forge alias contains exactly the authenticated backport bytes', () => {
    const installed = path.dirname(require.resolve('node-forge/package.json'));
    for (const [name, bytes] of packaged) {
        expect(fs.readFileSync(path.join(installed, name.slice(8)))).toEqual(bytes);
    }
    expect(require.resolve('node-forge')).toBe(path.join(installed, 'lib/index.js'));
});

test('the generated lock pins the installed alias and complete jks-js closure to the local archive', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json')));
    const fileReference = 'file:vendor/node-forge-rsa-validated/' + provenance.artifact;
    expect(manifest.devDependencies['node-forge']).toBe(fileReference);
    expect(manifest.overrides['jks-js']['node-forge']).toBe(fileReference);
    const forgeEntries = Object.entries(lock.packages).filter(([name]) => name.endsWith('/node-forge'));
    expect(forgeEntries).toHaveLength(1);
    expect(forgeEntries[0][0]).toBe('node_modules/node-forge');
    expect(forgeEntries[0][1]).toMatchObject({ name: '@nofries/node-forge-rsa-validated',
        version: '1.4.0-nofries.1', resolved: fileReference, integrity: integrity(artifactBytes), dev: true });
    expect(forgeEntries[0][1].optional).toBeUndefined();
    expect(Object.keys(lock.packages).some(name => name.endsWith('/braces') || name.endsWith('/micromatch'))).toBe(false);
});

test('the committed package reproduces from its pinned baseline and exact patch without install scripts', () => {
    expect(build({ check: true })).toMatchObject({ artifact: provenance.artifact,
        sha256: sha256(artifactBytes), integrity: integrity(artifactBytes), files: 53 });
});
