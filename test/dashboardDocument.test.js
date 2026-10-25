'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = global.test || require('node:test');
const { buildDashboardDocument, withCustomerProvider, DASHBOARD_RUNTIME_MARKER } = require('../lib/dashboardDocument');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const digest = source => `sha256-${crypto.createHash('sha256').update(source, 'utf8').digest('base64')}`;
function inputs() {
    return {
        template: read('app/dashboard.html'),
        loaderSource: read('js/dashboard-loader.js'),
        protectedAppSource: ['dashboardRegistry.js', 'dashboardShell.js', 'ncscAssessmentClient.js', 'ncscQuestionnaire.js', 'assessmentExplanation.js', 'organisationPicture.js', 'improvementActionPlanView.js', 'improvementActionPlanClient.js']
            .map(file => read('api/shared/protectedAssets/' + file)).join('\n'),
        protectedStyleSource: read('app/dashboard.css')
    };
}

test('external customer documents retain fixed reentry links and hash the emitted runtime', () => {
    const built = buildDashboardDocument({ ...inputs(), customerLogin: true, customerTransport: 'external' });
    assert.match(built.html, /<body data-page="operator-dashboard" data-customer-provider="external">/);
    assert.match(built.html, /id="dashboardSignIn" href="\/login\?provider=external"/);
    const runtime = built.html.match(/<script id="dashboardRuntime">([\s\S]*?)<\/script>/)[1];
    assert.equal(built.scriptHash, `'${digest(runtime)}'`);
    assert.ok(built.contentSecurityPolicy.includes(built.scriptHash));
    assert.throws(() => buildDashboardDocument({ ...inputs(), customerTransport: 'external' }), /dashboard_customer_transport_invalid/);
    assert.throws(() => buildDashboardDocument({ ...inputs(), customerLogin: true, customerTransport: 'https:\/\/invalid.test' }), /dashboard_customer_transport_invalid/);
});

for (const [options, provider, href] of [
    [{ customerLogin: true, customerTransport: 'auto' }, 'auto', '/login'],
    [{ customerLogin: true }, 'legacy', '/login?provider=legacy'],
    [{}, 'staff', '/api/auth/login?returnTo=%2Fdashboard']
]) {
    test(`document distinguishes ${provider} entry and preserves emitted runtime integrity`, () => {
        const built = buildDashboardDocument({ ...inputs(), ...options });
        assert.match(built.html, new RegExp(`data-customer-provider="${provider}"`));
        assert.ok(built.html.includes(`id="dashboardSignIn" href="${href}"`));
        const runtime = built.html.match(/<script id="dashboardRuntime">([\s\S]*?)<\/script>/)[1];
        assert.equal(built.scriptHash, `'${digest(runtime)}'`);
        assert.ok(built.contentSecurityPolicy.includes(built.scriptHash));
    });
}

test('provider marking preserves login classes, is idempotent and rejects conflicting or duplicate body markers', () => {
    const source = read('login.html');
    const marked = withCustomerProvider(source, 'external');
    assert.match(marked, /<body class="access-page login-page" data-customer-provider="external">/);
    assert.equal(withCustomerProvider(marked, 'external'), marked);
    for (const invalid of [
        source.replace('<body ', '<body data-customer-provider="legacy" '),
        source.replace('<body ', '<body data-customer-provider="external" data-customer-provider="external" '),
        source.replace('<body ', '<body data-customer-provider '),
        source + '<body>', source.replace(/<body\b[^>]*>/, '')
    ]) assert.throws(() => withCustomerProvider(invalid, 'external'), /customer_provider_invalid/);
    assert.throws(() => withCustomerProvider(source, 'https://untrusted.test'), /customer_provider_invalid/);
});

test('dashboard document binds its sole emitted loader and both actual protected asset byte streams', () => {
    const options = inputs();
    const built = buildDashboardDocument(options);
    const scripts = [...built.html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
    assert.equal(scripts.length, 1);
    assert.equal(scripts[0][0], `<script id="dashboardRuntime">${options.loaderSource}</script>`);
    assert.equal(built.runtime, options.loaderSource);
    assert.equal(built.scriptHash, `'${digest(scripts[0][1])}'`);
    assert.equal(built.appIntegrity, digest(options.protectedAppSource));
    assert.equal(built.styleIntegrity, digest(options.protectedStyleSource));
    assert.ok(built.html.includes(`<meta id="dashboardApplicationIntegrity" content="${built.appIntegrity}">`));
    assert.ok(built.html.includes(`<meta id="dashboardStyleIntegrity" content="${built.styleIntegrity}">`));
    assert.doesNotMatch(built.html, /DASHBOARD_(?:RUNTIME|APP_INTEGRITY|STYLE_INTEGRITY)/);
    assert.match(built.contentSecurityPolicy, new RegExp(`script-src 'self' ${built.scriptHash.replace(/[+]/g, '\\+')}(?:;|$)`));
});

for (const [field, resultField] of [['loaderSource', 'scriptHash'], ['protectedAppSource', 'appIntegrity'], ['protectedStyleSource', 'styleIntegrity']]) {
    test(`one changed ${field} byte changes only its associated digest`, () => {
        const original = inputs();
        const before = buildDashboardDocument(original);
        const after = buildDashboardDocument({ ...original, [field]: original[field] + '\n' });
        assert.notEqual(after[resultField], before[resultField]);
        for (const other of ['scriptHash', 'appIntegrity', 'styleIntegrity'].filter(name => name !== resultField)) {
            assert.equal(after[other], before[other]);
        }
        assert.equal(after.contentSecurityPolicy === before.contentSecurityPolicy, field !== 'loaderSource');
        assert.notEqual(after.html, before.html);
    });
}

test('protected application ordering and joining LF are part of the application integrity', () => {
    const options = inputs();
    const registry = read('api/shared/protectedAssets/dashboardRegistry.js');
    const shell = read('api/shared/protectedAssets/dashboardShell.js');
    const client = read('api/shared/protectedAssets/ncscAssessmentClient.js');
    const questionnaire = read('api/shared/protectedAssets/ncscQuestionnaire.js');
    const explanation = read('api/shared/protectedAssets/assessmentExplanation.js');
    const picture = read('api/shared/protectedAssets/organisationPicture.js');
    const improvementView = read('api/shared/protectedAssets/improvementActionPlanView.js');
    const improvementClient = read('api/shared/protectedAssets/improvementActionPlanClient.js');
    const built = buildDashboardDocument(options);
    assert.equal(built.appIntegrity, digest([registry, shell, client, questionnaire, explanation, picture, improvementView, improvementClient].join('\n')));
    assert.notEqual(built.appIntegrity, digest([registry, shell, client, questionnaire, explanation, picture, improvementView, improvementClient].join('')));
    assert.notEqual(built.appIntegrity, digest([shell, registry, client, questionnaire, explanation, picture, improvementView, improvementClient].join('\n')));
});

test('loader replacement preserves literal replacement tokens and Unicode bytes', () => {
    const options = { ...inputs(), loaderSource: 'window.example = "$& $` $\' —";' };
    const built = buildDashboardDocument(options);
    assert.ok(built.html.includes(`<script id="dashboardRuntime">${options.loaderSource}</script>`));
    assert.equal(built.scriptHash, `'${digest(options.loaderSource)}'`);
});

for (const name of ['template', 'loaderSource', 'protectedAppSource', 'protectedStyleSource']) {
    for (const value of ['', ' \n\t', null, undefined, Buffer.from('bytes')]) {
        test(`dashboard builder rejects an invalid ${name}: ${String(value)}`, () => {
            assert.throws(() => buildDashboardDocument({ ...inputs(), [name]: value }), new RegExp(name + ' was empty'));
        });
    }
}

for (const marker of [DASHBOARD_RUNTIME_MARKER, 'DASHBOARD_APP_INTEGRITY', 'DASHBOARD_STYLE_INTEGRITY']) {
    for (const replacement of ['', marker + marker]) {
        test(`dashboard builder rejects ${replacement ? 'duplicate' : 'missing'} ${marker}`, () => {
            const options = inputs();
            options.template = options.template.replace(marker, replacement);
            assert.throws(() => buildDashboardDocument(options), /must contain exactly one/);
        });
    }
}

for (const closing of ['</script>', '</SCRIPT >', '</scripture>']) {
    test(`dashboard builder rejects an HTML parser closing-script token ${closing}`, () => {
        assert.throws(() => buildDashboardDocument({ ...inputs(), loaderSource: `/* ${closing} */` }), /forbidden closing script token/);
    });
}

test('a template cannot add a second inline or external script', () => {
    for (const script of ['<script>alert(1)</script>', '<SCRIPT src="/extra.js"></SCRIPT>']) {
        assert.throws(() => buildDashboardDocument({ ...inputs(), template: inputs().template + script }), /must not contain another script/);
    }
});

test('generic document does not inline protected content or add a permissive executable channel', () => {
    const options = inputs();
    const built = buildDashboardDocument(options);
    assert.ok(!built.html.includes(options.protectedAppSource));
    assert.ok(!built.html.includes(read('api/shared/protectedAssets/dashboardRegistry.js')));
    assert.ok(!built.html.includes(read('api/shared/protectedAssets/dashboardShell.js')));
    assert.ok(!built.html.includes(options.protectedStyleSource));
    const generic = built.html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
    assert.doesNotMatch(generic, /<style\b|<iframe\b|<object\b|<embed\b|\bon\w+=|\bnonce=|dashboardFixture|Synthetic customer|tenantId|selectedBindingId|generation/i);
    assert.doesNotMatch(generic, /href="\/api\/dashboard\/dashboard\.css"|src="\/api\/dashboard\/app\.js"/);
    assert.match(generic, /href="\/style\.css"/);
    assert.doesNotMatch(built.contentSecurityPolicy, /unsafe-inline|unsafe-eval|nonce-|blob:|\*/);
    const directives = new Map(built.contentSecurityPolicy.split('; ').map(value => {
        const split = value.indexOf(' ');
        return split < 0 ? [value, ''] : [value.slice(0, split), value.slice(split + 1)];
    }));
    assert.equal(directives.get('script-src'), `'self' ${built.scriptHash}`);
    for (const directive of ['default-src', 'base-uri', 'object-src', 'frame-src', 'frame-ancestors', 'worker-src', 'script-src-attr', 'style-src-attr']) {
        assert.equal(directives.get(directive), "'none'");
    }
    assert.equal(directives.get('style-src'), "'self'");
    assert.equal(directives.get('connect-src'), "'self'");
});

test('generic document provides labelled keyboard controls and an empty hidden protected mount', () => {
    const template = inputs().template;
    assert.match(template, /<body data-page="operator-dashboard">/);
    assert.match(template, /<div class="shell" id="dashboardEntry" role="main">/);
    assert.doesNotMatch(template, /<main\b/);
    assert.match(template, /id="dashboardHeading" tabindex="-1"/);
    assert.match(template, /id="dashboardStatus" role="status" aria-live="polite"/);
    assert.match(template, /id="dashboardChooser" aria-labelledby="dashboardChooserHeading" hidden/);
    assert.match(template, /id="dashboardChoices" role="group" aria-label="Available organisations"/);
    for (const id of ['dashboardRetry', 'dashboardSignOut', 'dashboardMore']) {
        assert.match(template, new RegExp(`<button[^>]*id="${id}"[^>]*type="button"[^>]*hidden`));
    }
    assert.match(template, /id="dashboardSignIn" href="\/api\/auth\/login\?returnTo=%2Fdashboard" hidden/);
    assert.match(template, /<div id="dashboardApp" hidden><\/div>/);
});
