'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const vm = require('node:vm');
// The repository uses Jest; the same focused tests also run without dependencies.
const test = typeof globalThis.test === 'function' ? globalThis.test : require('node:test');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'home.css'), 'utf8');
const controller = fs.readFileSync(path.join(root, 'js', 'home.js'), 'utf8');
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);

test('public identity and metadata lead with the standalone Dashboard', () => {
    assert.match(html, /<title>No Fries Dashboard \| Your IT position in real time\.<\/title>/);
    assert.match(html, /data-product="dashboard"/);
    assert.match(html, /property="og:title" content="No Fries Dashboard \| Your IT position in real time\."/);
    assert.equal((html.match(/<h1\b/g) || []).length, 1);
    assert.match(html, /id="home-title">Your IT position<br><em>in real time\.<\/em>/);
    assert.match(html, /Assess your IT, save your progress and view results in the No Fries Dashboard/);
    assert.doesNotMatch(html, /Built from the assessment answers you submit; update them as your IT changes\./);
    assert.doesNotMatch(html, /Automatic updates and connected data feeds are planned\. Managed IT and advisory services are optional\./);
});

test('account creation and login have distinct entries and availability is explicit', () => {
    assert.match(html, /id="dashboardSignIn" href="\/login" hidden>Sign up \/ Sign in/);
    assert.doesNotMatch(html, /id="organisation-form"/);
    const accountCard = html.slice(html.indexOf('id="create-organisation"'), html.indexOf('class="home-intro"'));
    assert.match(accountCard, /id="organisation-title">Assess your IT\. See where to improve\./);
    assert.match(accountCard, /For your company or your clients\./);
    assert.deepEqual([...accountCard.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)]
        .map(match => [match[1], match[2].trim()]), [['/login?intent=create', 'Create account'], ['/login?intent=login', 'Log in']]);
    assert.doesNotMatch(accountCard, /Create \/ Login|→/);
    assert.doesNotMatch(accountCard, /Start here\. Return here\.|Personal and work email|Already signed up\?/);
    assert.match(html, /one-time code sent to your inbox/);
    assert.match(html, /Choose Company for your own organisation, or Consultant to manage clients/);
    assert.match(html, /Confirm access and applicable terms before opening your dashboard/);
    assert.doesNotMatch(html, /restricted beta|two-user limit|fixed beta cohort/i);
});

test('existing account access and pending setup do not claim membership or consent', () => {
    assert.match(html, /Checking your current access/);
    assert.match(html, /Confirm access and applicable terms/);
    assert.doesNotMatch(html, /membership (?:is |has been )?granted|terms (?:are |have been )?accepted/i);
    const login = fs.readFileSync(path.join(root, 'login.html'), 'utf8');
    assert.match(login, /does not accept service terms or activate a subscription/);
    assert.doesNotMatch(login, /Operator account|Staff sign in/);
});

test('public customer links exclude the separate staff entry', () => {
    assert.doesNotMatch(html, /href="\/portal"|Managed-service portal/);
    assert.doesNotMatch(html, /href="\/operator(?:\/|[?#][^"]*)?"|Staff sign in/i);
    assert.match(html, /href="\/privacy\.html"/);
    assert.match(html, /href="\/terms\.html"/);
    const footer = html.match(/<footer\b[\s\S]*?<\/footer>/)[0];
    assert.deepEqual([...footer.matchAll(/<a\b[^>]*href="([^"]+)"/g)].map(match => match[1]),
        ['https://news.nofries.nz/', '/roadmap.html', '/privacy.html', '/terms.html']);
    const mainNav = html.match(/<nav aria-label="Main navigation">([\s\S]*?)<\/nav>/)[1];
    assert.deepEqual([...mainNav.matchAll(/href="([^"]+)"/g)].map(match => match[1]),
        ['https://news.nofries.nz/', '/roadmap.html']);
});

test('the homepage keeps only one compact MSP section below its Dashboard entry', () => {
    assert.doesNotMatch(html, /All services|Service pricing|Sales Agency|Luna game|Advisory|AI Governance|IT Optimisation|Datto/i);
    assert.doesNotMatch(html, /id="services"|data-start-discovery|id="discovery-dialog"|id="prospect-assistant"/);
    assert.doesNotMatch(html, /href="(?:https:\/\/(?:sales|luna)\.nofries\.nz\/|\/#services)"/);
    assert.equal(html.split('id="other-services"').length - 1, 1);
    const other = html.match(/<section class="gateway-other-services"[\s\S]*?<\/section>/)[0];
    assert.deepEqual([...other.matchAll(/href="([^"]+)"/g)].map(match => match[1]), ['/managed-it.html']);
    assert.match(other, /Protection and backup are selected separately/);
    assert.ok(other.length < 650, 'secondary service information stays compact');
    assert.ok(html.indexOf('id="other-services"') > html.indexOf('Create account'));
    assert.match(html, /aria-label="Dashboard benefits"/);
});

test('service pricing remains server-owned rather than embedded in the homepage', () => {
    assert.doesNotMatch(html, /managed-it-per-user-price|managed-it-price-summary|managed-it-price-extras|id="pricing-dialog"|NZ\$|\$\d/);
    const { MANAGED_IT_POLICY } = require('../api/shared/managedItPolicy');
    assert.equal(MANAGED_IT_POLICY.customerFacingServiceName, 'No Fries Managed IT');
    assert.ok(Number.isFinite(MANAGED_IT_POLICY.pricing.perUserMonthly));
    assert.ok(fs.existsSync(path.join(root, 'managed-it.html')));
});

test('gateway template includes only reviewed public scripts and a hash-bound loader marker', () => {
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    assert.equal(scripts.length, 3);
    assert.deepEqual(scripts.map(match => match[1].match(/src="([^"]+)"/)[1]),
        ['/js/organisation-setup.js', '/js/home.js', '/js/prospect-assistant.js']);
    assert.ok(scripts.every(match => match[2].trim() === ''));
    assert.doesNotMatch(html, /\bon(?:click|load|error|submit)\s*=/i);
    assert.doesNotMatch(html, /(?:src|href)="(?:\/api\/dashboard\/(?:app\.js|bootstrap)|\/test\/fixtures\/)/);
});

test('all identifiers are unique and every dialog opener names a real dialog', () => {
    assert.equal(new Set(ids).size, ids.length);
    const dialogs = new Set([...html.matchAll(/<dialog\b[^>]*\bid="([^"]+)"/g)].map(m => m[1]));
    for (const match of html.matchAll(/\bdata-dialog="([^"]+)"/g)) {
        assert.ok(dialogs.has(match[1]), `Missing dialog target ${match[1]}`);
    }
    for (const match of html.matchAll(/\baria-(?:labelledby|describedby)="([^"]+)"/g)) {
        for (const id of match[1].split(/\s+/)) assert.ok(ids.includes(id), `Missing ARIA target ${id}`);
    }
});

test('the reusable delegated controller still opens and closes independent service fixtures', () => {
    let clickHandler;
    const dialogs = new Map(['dashboard-access-dialog', 'dashboard-product-dialog', 'discovery-dialog']
        .map(id => [id, { open: false, showModal() { this.open = true; }, close() { this.open = false; },
            addEventListener() {} }]));
    const document = {
        addEventListener(event, fn) { if (event === 'click') clickHandler = fn; },
        getElementById(id) { return dialogs.get(id); },
        querySelectorAll() { return [...dialogs.values()]; }
    };
    vm.runInNewContext(controller, { document });
    for (const [id, dialog] of dialogs) {
        clickHandler({ target: { closest(selector) { return selector === '[data-dialog]' ? { dataset: { dialog: id } } : null; } } });
        assert.equal(dialog.open, true);
        clickHandler({ target: { closest(selector) { return selector === '[data-close-dialog]' ? { closest() { return dialog; } } : null; } } });
        assert.equal(dialog.open, false);
    }
});

test('responsive styles retain single-column narrow layouts and visible keyboard focus', () => {
    assert.match(css, /@media \(max-width: 980px\)/);
    assert.match(css, /@media \(max-width: 420px\)/);
    assert.match(css, /grid-template-columns: minmax\(0, 1fr\)/);
    assert.match(css, /:focus-visible/);
    assert.match(css, /min-height: 46px/);
    assert.match(css, /white-space: normal/);
});

test('the simplified homepage preserves all protected entry and integrity markers', () => {
    for (const id of ['dashboardEntry', 'dashboardStatusPanel', 'dashboardChooser', 'dashboardChoices', 'dashboardApp', 'gatewayPublic']) {
        assert.ok(ids.includes(id), `Missing protected entry marker ${id}`);
    }
    for (const marker of ['DASHBOARD_APP_INTEGRITY', 'DASHBOARD_STYLE_INTEGRITY', '<!-- DASHBOARD_RUNTIME -->']) {
        assert.equal(html.split(marker).length - 1, 1, marker);
    }
    assert.match(html, /data-dashboard-gateway="true"/);
});
