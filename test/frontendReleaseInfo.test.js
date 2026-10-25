'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = global.test || require('node:test');
const { FRONTEND_RELEASE_MARKER: marker, frontendReleaseInformation, withFrontendReleaseInformation } = require('../lib/frontendReleaseInfo');
const { buildDashboardDocument } = require('../lib/dashboardDocument');
const { PUBLIC_ROOT_FILES } = require('../lib/publicAssets');
const identity = { schemaVersion: 2, releaseSha: 'a'.repeat(40), runId: '12345' };
const options = { productVersion: '2.0.0', releaseIdentity: identity };

test('loaded frontend cue binds the canonical existing tuple without exposing execution identifiers', () => {
    const value = frontendReleaseInformation(options);
    assert.deepEqual(value, { productVersion: '2.0.0', frontendBuildCue: createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 12) });
    assert.ok(Object.isFrozen(value));
    const html = withFrontendReleaseInformation(marker, options);
    assert.match(html, /^<span class="frontend-release-info">Version 2\.0\.0 <span>· Build [a-f0-9]{12}<\/span><\/span>$/);
    assert.ok(!html.includes(identity.releaseSha));
    assert.ok(!html.includes(identity.runId));
    assert.doesNotMatch(html, /<time|Updated|deployed|fetch|script|href/);
});

test('canonical property order and normalised source identity produce the same cue', () => {
    assert.deepEqual(frontendReleaseInformation({ ...options, releaseIdentity: { runId: ' 12345 ', releaseSha: 'A'.repeat(40), schemaVersion: 2 } }), frontendReleaseInformation(options));
});

test('each source/run/attempt identity is distinct, including absent attempt versus explicit one', () => {
    const cues = [identity, { ...identity, releaseSha: 'b'.repeat(40) }, { ...identity, runId: '12346' },
        { ...identity, runAttempt: '1' }, { ...identity, runAttempt: '2' }]
        .map(releaseIdentity => frontendReleaseInformation({ ...options, releaseIdentity }).frontendBuildCue);
    assert.equal(new Set(cues).size, cues.length);
});

test('cached frontend A remains A when another release B is rendered', () => {
    const a = withFrontendReleaseInformation('before ' + marker + ' after', options);
    const expectedA = a;
    const b = withFrontendReleaseInformation(marker, { productVersion: '2.0.1', releaseIdentity: { ...identity, releaseSha: 'b'.repeat(40), runId: '54321' } });
    assert.notEqual(b, withFrontendReleaseInformation(marker, options));
    assert.equal(a, expectedA);
    assert.ok(!a.includes('2.0.1'));
    assert.equal(withFrontendReleaseInformation('before ' + marker + ' after', options), a);
});

for (const releaseIdentity of [null, {}, { ...identity, schemaVersion: 1 }, { ...identity, releaseSha: 'short' },
    { ...identity, runId: '' }, { ...identity, runAttempt: '0' }, { ...identity, runAttempt: '1<script>' }]) {
    test('missing or malformed release identity hides the cue without a fallback: ' + JSON.stringify(releaseIdentity), () => {
        assert.equal(frontendReleaseInformation({ ...options, releaseIdentity }), null);
        assert.equal(withFrontendReleaseInformation('before ' + marker + ' after', { ...options, releaseIdentity }), 'before  after');
    });
}

for (const productVersion of ['', '2', '02.0.0', '<script>alert(1)</script>', '2.0.0" onload="x', '2.0.0'.repeat(20)]) {
    test('unbounded or executable product-version text is never rendered: ' + productVersion.slice(0, 30), () => {
        assert.equal(frontendReleaseInformation({ ...options, productVersion }), null);
        assert.equal(withFrontendReleaseInformation(marker, { ...options, productVersion }), '');
    });
}

test('optional marker supports older templates and rejects ambiguous insertion', () => {
    assert.equal(withFrontendReleaseInformation('unchanged', options), 'unchanged');
    assert.throws(() => withFrontendReleaseInformation(marker + marker, options), /frontend_release_marker_ambiguous/);
    assert.throws(() => withFrontendReleaseInformation(null, options), /frontend_release_template_invalid/);
});

test('actual dedicated dashboard template removes the optional marker and preserves runtime integrity', () => {
    const root = path.resolve(__dirname, '..');
    const read = file => fs.readFileSync(path.join(root, file), 'utf8');
    const loaderSource = read('js/dashboard-loader.js');
    const result = buildDashboardDocument({ template: read('app/dashboard.html'), loaderSource,
        protectedAppSource: '/* synthetic protected app */', protectedStyleSource: '/* synthetic protected style */' });
    assert.ok(!result.html.includes(marker));
    assert.ok(result.html.includes('<script id="dashboardRuntime">' + loaderSource + '</script>'));
    assert.ok(result.contentSecurityPolicy.includes(result.scriptHash));
    assert.ok(PUBLIC_ROOT_FILES.includes('roadmap.html'));
    assert.ok(fs.existsSync(path.join(root, 'roadmap.html')));
});
