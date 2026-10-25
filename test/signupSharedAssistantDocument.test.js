'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const request = require('supertest');
const { buildSignupDocument, buildHostedSignupDocument } = require('../lib/signupDocument');
const { withHashBoundSharedAssistantDocument } = require('../lib/withHashBoundSharedAssistantDocument');

const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const sources = () => ({ clientSource: read('api/shared/customerSignup/signupClient.js'),
    journeySource: read('api/shared/customerSignup/signupJourney.js') });
const helpers = () => ({ prospectSource: read('js/prospect-assistant.js'), sharedSource: read('js/shared-assistant.js') });
const hash = source => `'sha256-${crypto.createHash('sha256').update(source).digest('base64')}'`;
const scripts = html => [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]
    .map(match => ({ attributes: match[1], source: match[2] }));
const policy = value => value.split(';').map(directive => directive.trim());
const build = mode => mode === 'hosted' ? buildHostedSignupDocument(sources())
    : buildSignupDocument({ ...sources(), customerLogin: true,
        ...(mode === 'external' ? { customerTransport: 'external' } : {}) });

function assertBound(document, original) {
    const inventory = scripts(document.html);
    expect(inventory).toEqual([
        { attributes: '', source: original.runtime },
        { attributes: ' id="nofriesPublicHelpRuntime"', source: `${helpers().prospectSource}\n;\n${helpers().sharedSource}` }
    ]);
    expect(document.runtime).toBe(original.runtime);
    expect(document.publicHelpRuntime).toBe(inventory[1].source);
    expect(document.publicHelpScriptHash).toBe(hash(inventory[1].source));
    expect(document.contentSecurityPolicy).toBe(original.contentSecurityPolicy.replace(
        `script-src ${hash(original.runtime)}`, `script-src ${hash(original.runtime)} ${hash(inventory[1].source)}`));
    expect(policy(document.contentSecurityPolicy).filter(value => !value.startsWith('script-src ')))
        .toEqual(policy(original.contentSecurityPolicy).filter(value => !value.startsWith('script-src ')));
    expect(policy(document.contentSecurityPolicy).filter(value => value.startsWith('script-src ')))
        .toEqual([`script-src ${hash(original.runtime)} ${hash(inventory[1].source)}`]);
    expect(document.contentSecurityPolicy).not.toMatch(/unsafe-inline|unsafe-eval|script-src 'self'/);
    expect(document.html).not.toMatch(/<script\b[^>]*\bsrc=/);
    expect(document.html.match(/\bdata-shared-assistant(?:\s|>)/g)).toHaveLength(1);
    expect(document.html).toContain('data-assistant-help-only="true"');
    expect(document.html).toContain('</section>\n<script id="nofriesPublicHelpRuntime">');
}

test.each(['legacy', 'external', 'hosted'])('%s signup keeps its exact auth runtime/hash and pins one separate public bundle', mode => {
    const original = build(mode);
    const composed = withHashBoundSharedAssistantDocument(original, helpers());
    assertBound(composed, original);
    expect(() => withHashBoundSharedAssistantDocument(composed, helpers())).toThrow();
});

test('source insertion preserves literal replacement metacharacters in the hash-bound helper bytes', () => {
    const input = { prospectSource: "// literal $$ $& $` $'\n(() => {})();", sharedSource: '(() => {})();' };
    const composed = withHashBoundSharedAssistantDocument(build('legacy'), input);
    const expected = input.prospectSource + '\n;\n' + input.sharedSource;
    expect(scripts(composed.html)[1].source).toBe(expected);
    expect(composed.publicHelpScriptHash).toBe(hash(expected));
});

test.each([
    { prospectSource: '' }, { sharedSource: '  ' }, { prospectSource: undefined },
    { prospectSource: '</script><script>untrusted()</script>' }, { sharedSource: '</ScRiPt>' }
])('unusable or HTML-terminating helper input fails before composition: %j', change => {
    expect(() => withHashBoundSharedAssistantDocument(build('legacy'), { ...helpers(), ...change }))
        .toThrow('shared_assistant_hash_source_invalid');
});

test.each([
    original => ({ ...original, contentSecurityPolicy: original.contentSecurityPolicy.replace(hash(original.runtime), hash('changed')) }),
    original => ({ ...original, contentSecurityPolicy: original.contentSecurityPolicy.replace('script-src ', "script-src 'self' ") }),
    original => ({ ...original, contentSecurityPolicy: original.contentSecurityPolicy + '; script-src ' + hash(original.runtime) }),
    original => ({ ...original, html: original.html.replace(original.runtime, 'changed') }),
    original => ({ ...original, html: original.html.replace('</body>', '<script>' + original.runtime + '</script></body>') })
])('mismatched or ambiguous original policy/runtime is rejected', change => {
    expect(() => withHashBoundSharedAssistantDocument(change(build('external')), helpers()))
        .toThrow('shared_assistant_hash_binding_invalid');
});

test.each([
    ['/signup?provider=legacy', 'legacy'], ['/signup?provider=external', 'external'],
    ['/login?provider=legacy', 'legacy'], ['/login?provider=external', 'external']
])('real production composition serves the paired hash-only document at %s', async (route, mode) => {
    const { customerProductionHarness } = require('./helpers/customerProductionHarness');
    const h = customerProductionHarness({ external: true, organisationSetup: false });
    const result = await request(h.app).get(route);
    expect(result.status).toBe(200);
    const original = build(mode);
    const expected = withHashBoundSharedAssistantDocument(original, helpers());
    expect(result.text).toBe(expected.html);
    expect(result.headers['content-security-policy']).toBe(expected.contentSecurityPolicy);
    expect(result.headers['cache-control']).toContain('no-store');
    expect(result.headers['x-robots-tag']).toBe('noindex, nofollow');
    assertBound(expected, original);
    expect(h.pool.receipts.size).toBe(0);
    expect(h.pool.registrations.size).toBe(0);
    expect(h.state.delivered).toHaveLength(0);
    expect(h.state.authRequests).toHaveLength(0);
});

test('actual static signup HTML and route policy remain paired within the existing configuration size cap', () => {
    execFileSync(process.execPath, ['scripts/build-static.js'], { cwd: root, stdio: 'pipe' });
    const bytes = fs.readFileSync(path.join(root, 'dist/staticwebapp.config.json'));
    expect(bytes.length).toBeLessThanOrEqual(20000);
    const config = JSON.parse(bytes);
    const route = config.routes.find(value => value.route === '/signup');
    const original = build('hosted'), expected = withHashBoundSharedAssistantDocument(original, helpers());
    expect(route.rewrite).toBe('/app/signup.html');
    expect(read('dist/app/signup.html')).toBe(expected.html);
    expect(policy(route.headers['Content-Security-Policy'])).toEqual(policy(expected.contentSecurityPolicy));
    assertBound(expected, original);
});
