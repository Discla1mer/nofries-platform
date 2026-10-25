'use strict';
// Verify the isolated presentation-owner handoff against its immutable basis.
// This applies only to a private temporary copy, never another owner's worktree.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const basis = 'ac4bf5339f8caabfca37f8577489224a42382373';
const file = 'api/shared/customerSignup/signupJourney.js';
const patch = path.join(root, 'docs/patches/signup-support-reference-style419.patch');
const source = execFileSync('git', ['show', basis + ':' + file], { cwd: root });
const hash = value => createHash('sha256').update(value).digest('hex');
assert.equal(hash(source), '3479aa8a3a1c987e47643392d57ba4a3a1ef086fdb9d8473275c90865baca157');
const artifacts = fs.mkdtempSync('/tmp/nofries-support-link-'); fs.chmodSync(artifacts, 0o700);
const target = path.join(artifacts, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, source);
execFileSync('git', ['apply', '--check', patch], { cwd: artifacts });
execFileSync('git', ['apply', patch], { cwd: artifacts });
const { mountSignupJourney } = require(target);
const { createSignupClient } = require(path.join(root, 'api/shared/customerSignup/signupClient'));
const { createDom } = require(path.join(root, 'test/fixtures/dashboardDom'));
const reference = 'NF-0123456789ABCDEF', sha = 'a'.repeat(40), runId = '38380759572';
const safe = { supportReference: reference, apiReleaseSha: sha, apiReleaseRunId: runId };
const headers = () => new Headers({ 'content-type': 'application/json', 'X-NoFries-Support-Reference': reference,
    'X-NoFries-Release-Sha': sha, 'X-NoFries-Release-Run-Id': runId });
const response = (status, body, hdr = headers()) => new Response(JSON.stringify(body), { status, headers: hdr });
const flush = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };
const results = [];
async function mount(client) {
    const dom = createDom(), create = dom.document.createElement;
    dom.document.createElement = tag => Object.assign(create(tag), { style: {} });
    const view = mountSignupJourney(dom.root, client, { customerTransport: 'external' });
    await view.ready;
    return { ...dom, view };
}
function reportLink(dom) {
    const link = dom.root.querySelectorAll('a').find(node => node.textContent === 'Report this problem');
    assert.ok(link); assert.equal(link.target, '_blank'); assert.equal(link.rel, 'noopener noreferrer');
    assert.equal(link.getAttribute('aria-label'), 'Report this problem (opens in a new tab)');
    assert.equal(dom.document.activeElement.tagName, 'H1'); assert.equal(dom.root.getAttribute('aria-busy'), 'false');
    const params = new URLSearchParams(link.href.split('#')[1]);
    assert.equal(params.get('kind'), 'error'); assert.equal(params.get('screen'), 'signup');
    assert.equal(params.get('code'), 'signup_unavailable'); assert.equal(params.has('step'), false);
    return params;
}
(async () => {
    for (const [label, res] of [['original503', response(503, { error: 'Signup is unavailable' })],
        ['original200unavailable', response(200, { state: { status: 'unavailable' } })]]) {
        let current = res, calls = 0;
        const client = createSignupClient({ fetch: async () => { calls++; return current; }, createAccount: async () => {}, customerTransport: 'external' });
        const dom = await mount(client), params = reportLink(dom);
        assert.equal(params.get('reference'), reference); assert.equal(params.get('apiReleaseSha'), sha);
        assert.equal(params.get('apiReleaseRunId'), runId); assert.equal(calls, 1);
        current = response(503, {}, new Headers()); dom.root.querySelector('button').click(); await flush();
        const recheck = reportLink(dom); assert.equal(recheck.has('reference'), false); assert.equal(recheck.has('apiReleaseSha'), false);
        assert.equal(calls, 2); dom.view.dispose(); results.push(label + '_and_fresh_recheck');
    }
    const forged = Object.assign(new Error('private-provider-token'), safe);
    const providerClient = createSignupClient({ fetch: async () => { throw forged; }, createAccount: async () => { throw forged; } });
    const provider = await mount(providerClient);
    assert.equal(reportLink(provider).has('reference'), false); assert.ok(!provider.root.textContent.includes('private'));
    provider.view.dispose(); results.push('provider_error_not_a_reference');
    for (const [label, diagnostic] of [['missing_port', undefined], ['throwing_port', () => { throw forged; }],
        ['malformed_port', () => ({ supportReference: reference + '\n', apiReleaseSha: sha, apiReleaseRunId: '01', token: 'private' })]]) {
        const dom = await mount({ load: async () => ({ status: 'unavailable', ...safe }), createAccount() {}, acceptTerms() {}, diagnostic });
        const params = reportLink(dom); assert.equal(params.has('reference'), false); assert.equal(params.has('apiReleaseSha'), false);
        assert.ok(!params.toString().includes('private')); dom.view.dispose(); results.push(label);
    }
    let finish;
    const dom = createDom(), client = { load: () => new Promise(resolve => { finish = resolve; }),
        createAccount() {}, acceptTerms() {}, diagnostic: () => safe };
    const view = mountSignupJourney(dom.root, client, { customerTransport: 'external' });
    view.dispose(); await view.ready; finish({ status: 'unavailable' }); await flush();
    assert.equal(dom.root.children.length, 0); results.push('disposed_late_result_ignored');
    const receipt = { basis, basisSha256: hash(source), patchSha256: hash(fs.readFileSync(patch)),
        patchedSha256: hash(fs.readFileSync(target)), clientSha256: hash(fs.readFileSync(path.join(root, 'api/shared/customerSignup/signupClient.js'))),
        results, sourceOnly: true, ownerWorktreeModified: false, emailSent: false };
    fs.writeFileSync(path.join(artifacts, 'patch-results.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ passed: results.length, artifacts, patchSha256: receipt.patchSha256 }));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
