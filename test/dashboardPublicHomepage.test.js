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
    assert.match(html, /<title>No Fries \| Dashboard\. Managed IT\.<\/title>/);
    assert.match(html, /data-product="dashboard"/);
    assert.match(html, /property="og:title" content="No Fries \| Dashboard\. Managed IT\."/);
    assert.equal((html.match(/<h1\b/g) || []).length, 1);
    assert.match(html, /<p class="homepage-lockup"><span class="lockup-row"><span class="lockup-word">No<\/span><img class="lockup-mark" src="\/images\/nofries-mark-large\.webp" width="640" height="640" alt=""><\/span> <span class="lockup-row"><span class="lockup-word">Fries<\/span> <span class="lockup-tagline">Dashboard\.<br>Managed IT\.<\/span><\/span><\/p>/);
    assert.match(html, /<h1 id="home-title" class="homepage-headline">Know where your business stands on cyber security in about 15 minutes\.<\/h1>/);
    assert.match(html, /A free check for New Zealand small businesses, based on NCSC guidance\./);
    assert.match(html, /Free to start · No card required/);
    assert.equal((html.match(/Understand your IT and cyber security and see where the gaps are\./g) || []).length, 2);
    assert.doesNotMatch(html, /in real time|continuous monitoring|automatically updated/i);
    assert.match(html, /An illustrative view of assessment topics, not a live result\./);
    assert.match(html, /Your results reflect the answers you provide\./);
    assert.doesNotMatch(html, /Built from the assessment answers you submit; update them as your IT changes\./);
    assert.doesNotMatch(html, /Automatic updates and connected data feeds are planned\. Managed IT and advisory services are optional\./);
});

test('release identifiers are available in a collapsed site-version disclosure', () => {
    for (const page of ['index.html', 'managed-it.html']) {
        const source = fs.readFileSync(path.join(root, page), 'utf8');
        assert.doesNotMatch(source, /About this site|<details class="site-details">/);
        assert.match(source, /<details class="site-release" id="site-version"><summary>Site version<\/summary><!-- FRONTEND_RELEASE_INFO --><\/details>/);
    }
});

test('how it works states the real question count, free starter access and live result features', () => {
    const how = html.match(/<section class="homepage-how"[\s\S]*?<\/section>/)[0];
    assert.match(how, /id="how-it-works" aria-labelledby="how-title"/);
    // The count must match the questionnaire profile the dashboard serves.
    const { createNcscQuestionnaireMetadata } = require('../api/shared/ncscQuestionnaireMetadata');
    const questionCount = createNcscQuestionnaireMetadata().questions.length;
    assert.equal(questionCount, 14);
    assert.match(how, new RegExp(`From ${questionCount} questions`));
    assert.match(how, new RegExp(`Answer ${questionCount} questions\\.`));
    // Free wording mirrors the public terms; no price, duration or time estimate is invented.
    assert.match(how, /Starter access is free and needs no card\. You see the access period and allowance before you accept\./);
    assert.match(fs.readFileSync(path.join(root, 'terms.html'), 'utf8'), /Complimentary starter access costs nothing, needs no card/);
    assert.doesNotMatch(how, /\$\d|NZ\$|\bminutes?\b|\bhours?\b|unlimited/i);
    // Every result feature named here is rendered by the live results views.
    const questionnaire = fs.readFileSync(path.join(root, 'api', 'shared', 'protectedAssets', 'ncscQuestionnaire.js'), 'utf8');
    const picture = fs.readFileSync(path.join(root, 'api', 'shared', 'protectedAssets', 'organisationPicture.js'), 'utf8');
    assert.match(how, /reported implementation range/);
    assert.match(questionnaire, /metric\('Reported implementation'/);
    assert.match(how, /grouped by your answer: No, then Partial, then Unknown, then Not applicable\. The list is not ranked by risk\./);
    assert.match(questionnaire, /grouped by your answer \(No, then Partial, then Unknown, then Not applicable\)\. It is not ranked by risk/);
    assert.match(how, /Copy or print a summary for your IT provider\./);
    assert.match(questionnaire, /button\('Copy summary'/);
    assert.match(questionnaire, /button\('Print these results'/);
    assert.match(how, /compare it with your previous results/);
    assert.match(picture, /'Compare with previous assessment'/);
    // The demo stays unlinked until the owner decides to publish it.
    assert.doesNotMatch(html, /href="\/try/);
});

test('the example results are labelled, internally consistent and not presented as a live result', () => {
    const sample = html.match(/<figure class="homepage-sample"[\s\S]*?<\/figure>/)[0];
    assert.match(sample, /<span class="preview-example">Example<\/span>/);
    assert.match(sample, /<figcaption id="sample-caption">Example results from made-up answers, laid out like the results page\. Not a real organisation’s result\.<\/figcaption>/);
    assert.match(sample, /Gap indicators, not an audit or certification\./);
    assert.doesNotMatch(sample, /<h[1-6]\b/);
    // 6 Yes, 3 Partial, 2 No, 3 Unknown, scored with the published No Fries formula.
    const counts = { yes: 6, partial: 3, no: 2, unknown: 3 };
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    assert.equal(total, 14);
    const lower = ((counts.yes + counts.partial / 2) / total * 100).toFixed(1);
    const upper = ((counts.yes + counts.partial / 2 + counts.unknown) / total * 100).toFixed(1);
    assert.ok(sample.includes(`<dd>${lower}%–${upper}%</dd>`));
    assert.ok(sample.includes(`<dd>${counts.yes + counts.partial + counts.no} of ${total}</dd>`));
    assert.match(sample, new RegExp(`You have ${counts.no + counts.partial} gaps to fix and ${counts.unknown} answers to check\\. Start with the first three below\\.`));
    const gaps = [...sample.matchAll(/<li>([^<]+)<\/li>/g)].map(match => match[1].split(' — '));
    assert.deepEqual(gaps.map(gap => gap[1]), ['No', 'No', 'Partial']);
    const { createNcscQuestionnaireMetadata } = require('../api/shared/ncscQuestionnaireMetadata');
    const titles = createNcscQuestionnaireMetadata().controls.map(control => control.title);
    for (const [title] of gaps) assert.ok(titles.includes(title), `Unknown control title ${title}`);
});

test('account creation and login have distinct entries and availability is explicit', () => {
    assert.match(html, /id="dashboardSignIn" href="\/login" hidden>Sign up \/ Sign in/);
    assert.doesNotMatch(html, /id="organisation-form"/);
    const accountCard = html.match(/<div class="homepage-actions"[\s\S]*?<\/div>/)[0];
    assert.match(accountCard, /id="create-organisation"/);
    assert.doesNotMatch(accountCard, /For your company or your clients\./);
    assert.doesNotMatch(html, /<ol\b[^>]*\bclass="gateway-steps"/);
    assert.deepEqual([...accountCard.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)]
        .map(match => [match[1], match[2].replace(/<span[\s\S]*?<\/span>/g, '').trim()]), [['/login?intent=create', 'Create account'], ['/sample-result.html', 'See an example result'], ['#dashboard-benefits', 'How it works']]);
    assert.match(html, /class="homepage-login" href="\/login\?intent=login"/);
    assert.equal((html.match(/href="\/login\?intent=create"/g) || []).length, 1);
    assert.match(html, /id="dashboard-benefits"/);
    assert.doesNotMatch(accountCard, /Create \/ Login/);
    assert.doesNotMatch(accountCard, /Start here\. Return here\.|Personal and work email|Already signed up\?/);
    assert.doesNotMatch(html, /one-time code sent to your inbox/);
    assert.doesNotMatch(html, /Choose Company for your own organisation, or Consultant to manage clients/);
    assert.doesNotMatch(html, /Confirm access and applicable terms before opening your dashboard/);
    assert.doesNotMatch(html, /restricted beta|two-user limit|fixed beta cohort/i);
});

test('existing account access and pending setup do not claim membership or consent', () => {
    assert.match(html, /Checking your current access/);
    assert.doesNotMatch(html, /Confirm access and applicable terms/);
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
        ['/', '/pricing.html', '/managed-it.html', '/roadmap.html', '/contact.html', '/privacy.html', '/terms.html']);
    const mainNav = html.match(/<nav aria-label="Main navigation">([\s\S]*?)<\/nav>/)[1];
    assert.deepEqual([...mainNav.matchAll(/href="([^"]+)"/g)].map(match => match[1]),
        ['/', '/pricing.html', '/managed-it.html', '/roadmap.html', '/contact.html', '/login?intent=login']);
});

test('the homepage keeps only one compact MSP section below its Dashboard entry', () => {
    assert.doesNotMatch(html, /All services|Service pricing|Sales Agency|Luna game|Advisory|AI Governance|IT Optimisation|Datto/i);
    assert.doesNotMatch(html, /id="services"|data-start-discovery|id="discovery-dialog"|id="prospect-assistant"/);
    assert.doesNotMatch(html, /href="(?:https:\/\/(?:sales|luna)\.nofries\.nz\/|\/#services)"/);
    assert.equal(html.split('id="other-services"').length - 1, 1);
    const other = html.match(/<section class="gateway-other-services"[\s\S]*?<\/section>/)[0];
    assert.deepEqual([...other.matchAll(/href="([^"]+)"/g)].map(match => match[1]), ['/managed-it.html']);
    assert.match(other, /Microsoft 365 backup is included from the Managed tier/);
    assert.match(other, /Security hardening and alert review are included in Secure/);
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
    assert.equal(scripts.length, 4);
    assert.deepEqual(scripts.map(match => match[1].match(/src="([^"]+)"/)[1]),
        ['/js/organisation-setup.js', '/js/home.js', '/js/enquiry-availability.js', '/js/enquiry-home.js']);
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
