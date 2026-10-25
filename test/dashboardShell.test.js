'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = global.test || require('node:test');
const registry = require('../api/shared/protectedAssets/dashboardRegistry');
const shell = require('../api/shared/protectedAssets/dashboardShell');
const { projectDashboard } = require('../api/shared/appLifecycle/dashboardProjection');
const { fixture, scenarios } = require('./fixtures/dashboardFixture');
const { createDom } = require('./fixtures/dashboardDom');
const clone = value => JSON.parse(JSON.stringify(value));
const view = options => projectDashboard(fixture(options));
const keys = value => value.modules.map(item => item.key);
const mount = (model = view(), options = {}) => { const dom = createDom(); return { ...dom, controller: shell.mount(dom.root, model, options) }; };
const buttons = dom => dom.root.querySelectorAll('button');

test('registry preserves approved eight-module order and canonical mobile groups', () => {
    assert.deepEqual(registry.modules.map(item => item.key), ['overview', 'ai_governance', 'cyber_security', 'it_optimisation', 'improvement_plan', 'evidence', 'board_reports', 'services']);
    assert.deepEqual(registry.groups, ['Home', 'Assess', 'Plan', 'Proof', 'More']);
    assert.ok(Object.isFrozen(registry.modules[0]));
});

test('connected picture preserves existing attention items and disposes before action detail', () => {
    const model = clone(view()); model.modules.find(item => item.key === 'cyber_security').state = 'ready';
    let disposed = 0;
    const dom = mount(model, { mountPicture: () => ({ destroy() { disposed++; }, requestLeave(commit) { commit(); return Promise.resolve(true); } }) });
    assert.match(dom.root.textContent, /Confirm backup restoration evidence/);
    dom.root.querySelector('[data-attention="0"]').click();
    assert.equal(disposed, 1);
    assert.match(dom.root.textContent, /Next action/);
});

test('server projection reuses product entitlement and permission policy without provider identifiers', () => {
    assert.equal(keys(view()).length, 8);
    const score = view({ tier: 'dashboard_score' });
    assert.ok(!keys(score).includes('ai_governance'));
    assert.ok(!keys(score).includes('it_optimisation'));
    assert.ok(score.services.every(item => item.operational === false));
    assert.equal(score.admissionGranted, false); assert.equal(score.providerAccessGranted, false);
});

test('viewer/board projection does not disclose assessment, evidence or action summaries', () => {
    const model = view({ role: 'viewer' });
    assert.deepEqual(keys(model), ['overview', 'board_reports', 'services']);
    assert.deepEqual(model.summary.attention, []); assert.deepEqual(model.summary.metrics, []);
    assert.equal(model.audience, 'Executive / board');
});

test('advisor projection requires exact assignment and shows only the permitted module', () => {
    const input = fixture({ role: 'fractional_advisor', service: 'fractional_advisory' });
    assert.deepEqual(keys(projectDashboard(input)), ['cyber_security']);
    input.advisorAssignments = {};
    assert.throws(() => projectDashboard(input), { code: 'dashboard_unavailable' });
});

test('advisor assignment from a different tenant never reveals a module', () => {
    const input = clone(fixture({ role: 'fractional_advisor', service: 'fractional_advisory' }));
    input.advisorAssignments.cyber_security.tenantId = 'other';
    assert.throws(() => projectDashboard(input), { code: 'dashboard_unavailable' });
});

for (const [name, mutate] of Object.entries({
    missing: input => { input.entitlementState.grants = input.entitlementState.grants.slice(0, 1); },
    disabled: input => { input.flags.enabled['service:fractional_advisory'] = false; },
    revoked: input => { input.entitlementState.grants[1].status = 'revoked'; },
    expired: input => { input.entitlementState.grants[1].validUntil = input.now; }
})) test(`advisor projection with ${name} advisory purchase reveals no module`, () => {
    const input = clone(fixture({ role: 'fractional_advisor', service: 'fractional_advisory' }));
    mutate(input);
    assert.throws(() => projectDashboard(input), { code: 'dashboard_unavailable' });
});

test('mixed viewer and advisor projection omits unpaid Cyber navigation and summaries', () => {
    const input = clone(fixture({ role: 'fractional_advisor' }));
    for (const row of [...input.membershipState.memberships, ...input.membershipState.invitations]) {
        row.roles = ['viewer', 'fractional_advisor'];
    }
    const model = projectDashboard(input);
    assert.deepEqual(keys(model), ['overview', 'board_reports', 'services']);
    assert.deepEqual(model.summary.attention, []);
    assert.deepEqual(model.summary.metrics, []);
    const dom = mount(model, { initialRoute: 'cyber-security' });
    assert.doesNotMatch(dom.root.textContent, /64%|Confirm backup restoration evidence/);
});

for (const role of ['admin', 'editor']) test(`${role} projection does not require an advisory purchase for independent permissions`, () => {
    const input = clone(fixture({ role: 'fractional_advisor' }));
    for (const row of [...input.membershipState.memberships, ...input.membershipState.invitations]) {
        row.roles = [role, 'fractional_advisor'];
    }
    input.advisorAssignments.cyber_security.status = 'revoked';
    const model = projectDashboard(input);
    assert.deepEqual(keys(model), registry.modules.map(item => item.key));
    assert.equal(model.summary.metrics.length, 4);
});

for (const role of ['end_user', 'customer_admin', 'operator']) test(`legacy/unmapped ${role} is not silently promoted to a dashboard role`, () => {
    const input = clone(fixture());
    input.membershipState.memberships[0].roles = [role]; input.membershipState.invitations[0].roles = [role];
    assert.throws(() => projectDashboard(input), { code: 'dashboard_unavailable' });
});

for (const mutate of [input => { input.scope.tenantId = 'other'; }, input => { input.scope.organisationId = 'other'; },
    input => { input.subjectKey = '10000000-0000-4000-8000-000000000000:10000000-0000-4000-8000-000000000002'; },
    input => { input.entitlementState.grants = []; }, input => { input.now = '2028-01-01T00:00:00.000Z'; },
    input => { input.membershipState.memberships[0].status = 'suspended'; }, input => { input.flags.enabled.dashboard = false; }]) {
    test('missing/currently unauthorised context fails closed with no record detail', () => {
        const input = clone(fixture()); mutate(input);
        assert.throws(() => projectDashboard(input), error => error.code === 'dashboard_unavailable' && !error.message.includes('synthetic'));
    });
}

test('disabled capability retains an honest module notice but removes its summaries', () => {
    const model = view({ enabled: { cyber_security: false } });
    assert.equal(model.modules.find(item => item.key === 'cyber_security').state, 'disabled');
    assert.equal(model.summary.metrics.length, 0); assert.equal(model.summary.attention.length, 0);
    const dom = mount(model, { initialRoute: 'cyber-security' });
    assert.match(dom.root.textContent, /temporarily unavailable/); assert.doesNotMatch(dom.root.textContent, /64%/);
});

test('service purchase is distinct from availability and never claims operational readiness', () => {
    const model = view({ service: 'managed_endpoint' });
    assert.equal(model.services.find(item => item.key === 'managed_endpoint').state, 'setup_required');
    assert.equal(view({ service: 'managed_endpoint', enabled: { 'service:managed_endpoint': false } }).services.find(item => item.key === 'managed_endpoint').state, 'disabled');
    assert.ok(model.services.every(item => !item.operational));
});

test('projection excludes agreements, grants, identities, provider bindings and raw extra fields', () => {
    const input = clone(fixture()); input.summary.attention[0].privateField = 'private-canary';
    const result = JSON.stringify(projectDashboard(input));
    for (const forbidden of ['agreementRef', 'grantId', 'subjectKey', 'providerBinding', 'private-canary', 'synthetic-private-order']) assert.ok(!result.includes(forbidden));
});

test('foreign summary is refused rather than relabelled for the current organisation', () => {
    const input = clone(fixture()); input.summary.organisationId = 'foreign';
    assert.throws(() => projectDashboard(input), { code: 'dashboard_unavailable' });
});

test('unpermitted summary modules cannot leak through overview', () => {
    const input = clone(fixture({ tier: 'dashboard_score' }));
    input.summary.attention.push({ module: 'ai_governance', title: 'private-AI-record' });
    assert.ok(!JSON.stringify(projectDashboard(input)).includes('private-AI-record'));
});

test('missing metrics are displayed as not assessed, never zero', () => {
    const dom = mount(view({ empty: true }));
    assert.equal(dom.root.querySelectorAll('.dashboard-metric-value').length, 4);
    assert.ok(dom.root.querySelectorAll('.dashboard-metric-value').every(item => item.textContent === 'Not assessed'));
    assert.match(dom.root.textContent, /Build your first baseline/);
});

test('Overview leads with attention and distinct versioned metrics', () => {
    const dom = mount();
    assert.equal(dom.root.querySelector('h1').textContent, 'Overview');
    assert.equal(dom.root.querySelectorAll('.dashboard-attention-item').length, 3);
    for (const text of ['Implementation attainment', 'Evidence confidence', 'Risk priority', 'Trend', 'Synthetic profile 1.0', 'Assessment revision 3', 'Sample evidence only']) assert.ok(dom.root.textContent.includes(text));
    assert.equal(dom.root.querySelectorAll('h1').length, 1);
});

test('only permitted module links and mobile groups exist for viewer and advisor', () => {
    for (const model of [view({ role: 'viewer' }), view({ role: 'fractional_advisor', service: 'fractional_advisory' })]) {
        const dom = mount(model);
        assert.ok(dom.root.querySelectorAll('[data-module]').every(item => keys(model).includes(item.dataset.module)));
        assert.deepEqual(dom.root.querySelector('.dashboard-mobile-nav').querySelectorAll('[data-module]')
            .map(item => item.dataset.module).sort(), keys(model).slice().sort());
    }
});

for (const route of ['#ai-governance', '#cyber-security/foreign-record', '#evidence?organisation=foreign', '#%63yber-security', '#unknown', '#__proto__']) {
    test(`unpermitted or object route ${route} returns safely without echoing details`, () => {
        const dom = mount(view({ role: 'viewer' }), { initialRoute: route });
        assert.equal(dom.root.querySelector('h1').textContent, 'Overview');
        assert.match(dom.root.textContent, /That view is not available/);
        assert.ok(!dom.root.textContent.includes('foreign-record'));
    });
}

test('keyboard-compatible navigation updates title, route and current-link semantics', () => {
    const dom = mount(); dom.root.querySelectorAll('[data-module]').find(item => item.dataset.module === 'services').click();
    assert.equal(dom.window.location.hash, '#services');
    assert.equal(dom.document.activeElement.textContent, 'Services');
    assert.equal(dom.root.querySelector('.dashboard-rail').querySelector('[aria-current="page"]').dataset.module, 'services');
    dom.window.location.hash = '#cyber-security'; dom.window.dispatch('popstate');
    assert.equal(dom.root.querySelector('h1').textContent, 'Cyber Security');
});

test('attention drill-down has source, owner, next action and focus restoration', () => {
    const dom = mount(); dom.root.querySelector('[data-attention="0"]').click();
    assert.equal(dom.document.activeElement.tagName, 'H1');
    assert.match(dom.root.textContent, /Operations lead/); assert.match(dom.root.textContent, /Synthetic Cyber Security \/ Recovery/);
    buttons(dom).find(item => item.textContent === 'Back to Overview').click();
    assert.equal(dom.document.activeElement.dataset.attention, '0');
});

test('service scope control opens information without a purchase/write channel', () => {
    const dom = mount(view(), { initialRoute: 'services' });
    const control = buttons(dom).find(item => item.textContent === 'How to scope this service');
    control.click(); assert.equal(control.getAttribute('aria-expanded'), 'true');
    assert.match(dom.root.textContent, /No request, purchase, assignment or activation has been submitted/);
    control.click(); assert.equal(control.getAttribute('aria-expanded'), 'false');
    assert.equal(dom.root.querySelectorAll('form').length, 0);
});

test('disabled services explain policy availability rather than implying provider setup is sufficient', () => {
    const dom = mount(view({ service: 'managed_endpoint', enabled: { 'service:managed_endpoint': false } }), { initialRoute: 'services' });
    buttons(dom).find(item => item.textContent === 'About availability').click();
    assert.match(dom.root.textContent, /provider connection alone will not activate it/);
});

test('stale display is explicit and loading/denial clear old organisation content', () => {
    const dom = mount(view({ stale: true })); assert.match(dom.root.textContent, /snapshot needs a refresh/);
    shell.showState(dom.root, 'loading'); assert.doesNotMatch(dom.root.textContent, /Harbour Workshop/);
    assert.equal(dom.window.listenerCount('hashchange'), 0);
    shell.showState(dom.root, 'error'); assert.match(dom.root.textContent, /could not load/);
});

test('switching organisation clears selected detail and disposes old listeners/controller', () => {
    const dom = mount(); dom.root.querySelector('[data-attention="0"]').click();
    shell.mount(dom.root, view({ organisationId: 'other-org', name: 'Other synthetic organisation', empty: true }), { initialRoute: '' });
    assert.doesNotMatch(dom.root.textContent, /Harbour Workshop|Confirm backup restoration evidence/);
    assert.match(dom.root.textContent, /Other synthetic organisation/);
    assert.equal(dom.window.listenerCount('hashchange'), 1);
    dom.controller.navigate('services'); assert.equal(dom.root.querySelector('h1').textContent, 'Overview');
    dom.controller.destroy(); assert.equal(dom.root.querySelector('h1').textContent, 'Overview');
    assert.equal(dom.window.listenerCount('hashchange'), 1);
});

test('stale loading/error controller cannot destroy a replacement dashboard', () => {
    const dom = createDom(); const loading = shell.showState(dom.root, 'loading');
    shell.mount(dom.root, view()); loading.destroy(); loading.destroy();
    assert.equal(dom.root.querySelector('h1').textContent, 'Overview');
    assert.equal(dom.window.listenerCount('hashchange'), 1);
});

for (const instant of [1, null, '2026-09-06T08:30:00-12:00', '2026-09-06', '2026-02-30T09:00:00.000Z', '2026-09-06T09:00:01.000Z']) {
    test(`metric timestamp ${instant} cannot cause a crash or masquerade as current`, () => {
        const input = clone(fixture()); input.summary.metrics[0].asAt = instant;
        assert.throws(() => projectDashboard(input), { code: 'dashboard_unavailable' });
        const model = clone(view()); model.summary.metrics[0].asAt = instant;
        assert.throws(() => shell.validate(model));
    });
}

test('projection generation time must be a canonical string in the browser contract', () => {
    const model = clone(view()); model.generatedAt = 1; assert.throws(() => shell.validate(model));
});

test('malformed replacement clears previous data before failing closed', () => {
    const dom = mount(); shell.mount(dom.root, { schemaVersion: 999 });
    assert.match(dom.root.textContent, /not available/); assert.doesNotMatch(dom.root.textContent, /Harbour Workshop/);
    assert.equal(dom.window.listenerCount('hashchange'), 0);
});

test('customer-supplied text is text content, never HTML or a navigable URL', () => {
    const model = clone(view()); model.context.displayName = '<img src=x onerror=alert(1)>';
    model.summary.attention[0].title = '<script>alert(1)</script>';
    const dom = mount(model); assert.match(dom.root.textContent, /<img/);
    assert.equal(dom.root.querySelectorAll('img').length, 0); assert.equal(dom.root.querySelectorAll('script').length, 0);
});

for (const mutate of [model => model.modules.push(model.modules[0]), model => { model.modules[0].key = 'foreign'; },
    model => { model.services[0].operational = true; }, model => { model.summary.metrics[0].asAt = '2099-01-01T00:00:00.000Z'; },
    model => { model.summary.attention[0].module = 'unknown'; }, model => { model.admissionGranted = true; }]) {
    test('invalid display contract fails closed', () => {
        const model = clone(view()); mutate(model); assert.throws(() => shell.validate(model));
    });
}

test('all development scenarios use the actual server projection and renderer contract', () => {
    for (const model of Object.values(scenarios())) assert.doesNotThrow(() => shell.validate(model));
});

test('CSS encodes responsive layout, text labels, focus and comfortable targets without inline styles', () => {
    const css = fs.readFileSync(path.join(__dirname, '../app/dashboard.css'), 'utf8');
    assert.match(css, /max-width: 48rem/); assert.match(css, /max-width: 25rem/);
    assert.match(css, /:focus-visible/); assert.match(css, /min-height: 2\.875rem/);
    assert.match(css, /safe-area-inset-bottom/); assert.match(css, /prefers-reduced-motion/);
    const source = fs.readFileSync(path.join(__dirname, '../api/shared/protectedAssets/dashboardShell.js'), 'utf8');
    assert.doesNotMatch(source, /\.innerHTML|\.style\.|\bfetch\s*\(|localStorage|sessionStorage|window\.open/);
    const dom = mount(); dom.root.querySelector('.dashboard-skip').click(); assert.equal(dom.document.activeElement.id, 'dashboard-content');
});

// The optional module adapter is synthetic presentation, never a readiness or
// permission grant. Keep this projection change local to these tests.
const readyCyber = () => { const model = clone(view()); model.modules.find(item => item.key === 'cyber_security').state = 'ready'; return model; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const pendingDecision = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function syntheticChild() {
    const child = { mounts: [], destroys: 0, requests: 0, decision: null, firstCommit: null };
    child.adapter = (root, options) => {
        const input = root.ownerDocument.createElement('input'); input.value = 'unsaved synthetic text'; root.append(input);
        child.mounts.push({ root, options, input });
        let destroyed = false;
        return {
            requestLeave(commit) {
                child.requests += 1;
                if (!child.decision) { child.decision = pendingDecision(); child.firstCommit = commit; }
                return child.decision.promise.then(allowed => { if (allowed && !destroyed && child.firstCommit === commit) commit?.(); return allowed && !destroyed; });
            },
            destroy() { if (!destroyed) { destroyed = true; child.destroys += 1; } }
        };
    };
    return child;
}

test('Overview carries the exact selected source through the accepted Improvement transition only', async () => {
    const model = readyCyber(); model.modules.find(item => item.key === 'improvement_plan').state = 'ready';
    const source = Object.freeze({ assessmentId: 'assessment-selected', revision: 2, revisionSha256: 'a'.repeat(64),
        profileRef: Object.freeze({ profileId: 'selected-profile' }), outputSha256: 'b'.repeat(64) });
    const picture = syntheticChild(), improvement = syntheticChild();
    const dom = mount(model, { initialRoute: 'overview', mountPicture: picture.adapter, mountImprovement: improvement.adapter });
    const open = picture.mounts[0].options.openImprovement;
    const navigation = open(source); assert.equal(improvement.mounts.length, 0);
    picture.decision.resolve(true); assert.equal(await navigation, true);
    assert.equal(picture.destroys, 1); assert.equal(improvement.mounts.length, 1);
    assert.equal(improvement.mounts[0].options.sourceAssessment, source);
    assert.equal(improvement.mounts[0].options.generation, picture.mounts[0].options.generation);
    assert.equal(dom.window.location.hash, '#improvement-plan');
    assert.equal(await open(source), false);
    assert.ok(!JSON.stringify(dom.window.history.state ?? null).includes('assessment-selected'));
    const leaving = dom.controller.navigate('services'); improvement.decision.resolve(true); await leaving;
    await dom.controller.navigate('improvement-plan');
    assert.equal(improvement.mounts.length, 2);
    assert.equal(Object.hasOwn(improvement.mounts[1].options, 'sourceAssessment'), false);
    dom.controller.destroy(); assert.equal(improvement.destroys, 2);
});

for (const state of ['planned', 'disabled']) test(`Improvement ${state} cannot expose a picture callback or mount`, async () => {
    const model = readyCyber(); model.modules.find(item => item.key === 'improvement_plan').state = state;
    const picture = syntheticChild(), improvement = syntheticChild();
    const dom = mount(model, { mountPicture: picture.adapter, mountImprovement: improvement.adapter });
    assert.equal(typeof picture.mounts[0].options.openImprovement, 'undefined');
    const navigation = dom.controller.navigate('improvement-plan'); picture.decision.resolve(true); await navigation;
    assert.equal(improvement.mounts.length, 0); dom.controller.destroy();
});

test('an unavailable Improvement adapter does not expose planning and a destroyed shell cannot replay it', async () => {
    const model = readyCyber(); model.modules.find(item => item.key === 'improvement_plan').state = 'ready';
    const picture = syntheticChild();
    const dom = mount(model, { mountPicture: picture.adapter });
    assert.equal(typeof picture.mounts[0].options.openImprovement, 'undefined');
    const improvement = syntheticChild(), nextPicture = syntheticChild();
    shell.mount(dom.root, model, { mountPicture: nextPicture.adapter, mountImprovement: improvement.adapter });
    const open = nextPicture.mounts[0].options.openImprovement;
    dom.controller.destroy(); // The already-replaced controller cannot destroy the new mount.
    shell.mount(dom.root, model, {});
    assert.equal(await open({ assessmentId: 'stale' }), false); assert.equal(improvement.mounts.length, 0);
});

test('Overview passes the selected read target only through its accepted transition and not into history or later ordinary navigation', async () => {
    const picture = syntheticChild(), cyber = syntheticChild();
    const dom = mount(readyCyber(), { initialRoute: 'overview', mountPicture: picture.adapter, mountCyber: cyber.adapter });
    const open = picture.mounts[0].options.openCyber;
    const navigation = open('assessment-selected');
    assert.equal(cyber.mounts.length, 0);
    picture.decision.resolve(true); assert.equal(await navigation, true);
    assert.equal(picture.destroys, 1); assert.equal(cyber.mounts.length, 1);
    assert.equal(cyber.mounts[0].options.initialAssessmentId, 'assessment-selected');
    assert.equal(cyber.mounts[0].options.generation, picture.mounts[0].options.generation);
    assert.equal(dom.window.location.hash, '#cyber-security');
    assert.equal(await open('assessment-stale'), false);
    const leaving = dom.controller.navigate('services'); cyber.decision.resolve(true); await leaving;
    await dom.controller.navigate('cyber-security');
    assert.equal(cyber.mounts.length, 2);
    assert.equal(Object.hasOwn(cyber.mounts[1].options, 'initialAssessmentId'), false);
    dom.controller.destroy();
});

test('cancelled Overview navigation and a replaced shell cannot retain or replay a selected target', async () => {
    let presentation, allow = false;
    const cyber = syntheticChild();
    const picture = () => ({ destroy() {}, requestLeave(commit) { if (allow) commit(); return Promise.resolve(allow); } });
    const dom = mount(readyCyber(), { initialRoute: 'overview', mountPicture: (_root, options) => {
        presentation = options; return picture();
    }, mountCyber: cyber.adapter });
    const oldOpen = presentation.openCyber;
    assert.equal(await oldOpen('assessment-cancelled'), false);
    assert.equal(cyber.mounts.length, 0); assert.equal(dom.root.querySelector('h1').textContent, 'Overview');
    allow = true; await dom.controller.navigate('cyber-security');
    assert.equal(cyber.mounts.length, 1);
    assert.equal(Object.hasOwn(cyber.mounts[0].options, 'initialAssessmentId'), false);
    shell.mount(dom.root, readyCyber(), { initialRoute: 'overview' });
    const stable = dom.root.textContent;
    assert.equal(await oldOpen('assessment-foreign-shell'), false);
    assert.equal(dom.root.textContent, stable); assert.equal(cyber.mounts.length, 1);
});

for (const state of ['planned', 'disabled']) test(`optional Cyber adapter never mounts a ${state} module`, () => {
    const child = syntheticChild(), model = clone(view()); model.modules.find(item => item.key === 'cyber_security').state = state;
    mount(model, { initialRoute: 'cyber-security', mountCyber: child.adapter });
    assert.equal(child.mounts.length, 0);
});

test('Cyber ready without an explicit adapter retains the original honest placeholder', () => {
    const dom = mount(readyCyber(), { initialRoute: 'cyber-security' });
    assert.equal(dom.root.querySelector('h1').textContent, 'Cyber Security');
    assert.equal(dom.root.querySelectorAll('input').length, 0);
});

test('an unpermitted Cyber route never invokes the supplied adapter', () => {
    const child = syntheticChild(); mount(view({ role: 'viewer' }), { initialRoute: 'cyber-security', mountCyber: child.adapter });
    assert.equal(child.mounts.length, 0);
});

test('explicit ready Cyber receives an opaque generation and is destroyed exactly once before replacement', async () => {
    const child = syntheticChild(), dom = mount(readyCyber(), { initialRoute: 'cyber-security', mountCyber: child.adapter });
    assert.equal(child.mounts.length, 1); assert.ok(child.mounts[0].options.generation);
    const navigation = dom.controller.navigate('services'); await tick();
    assert.equal(child.destroys, 0); assert.equal(dom.root.querySelector('h1').textContent, 'Cyber Security');
    child.decision.resolve(true); await navigation; await tick();
    assert.equal(child.destroys, 1); assert.equal(dom.root.querySelector('h1').textContent, 'Services');
    dom.controller.destroy(); assert.equal(child.destroys, 1);
});

test('Stay preserves the editor, focused control, fragment and current module link', async () => {
    const child = syntheticChild(), dom = mount(readyCyber(), { initialRoute: 'cyber-security', mountCyber: child.adapter });
    dom.window.location.hash = '#cyber-security'; child.mounts[0].input.focus();
    const navigation = dom.controller.navigate('services'); await tick(); child.decision.resolve(false); await navigation; await tick();
    assert.equal(child.destroys, 0); assert.equal(dom.root.querySelector('h1').textContent, 'Cyber Security');
    assert.equal(dom.window.location.hash, '#cyber-security');
    assert.equal(dom.document.activeElement, child.mounts[0].input);
    assert.equal(dom.root.querySelector('.dashboard-rail').querySelector('[aria-current="page"]').dataset.module, 'cyber_security');
});

test('refused mobile navigation preserves the focused control and allows a later retry', async () => {
    let allowLeave = false, destroys = 0;
    const dom = mount(readyCyber(), { initialRoute: 'cyber-security', mountCyber: () => ({
        requestLeave(commit) { if (allowLeave) commit(); return Promise.resolve(allowLeave); },
        destroy() { destroys++; }
    }) });
    dom.window.location.hash = '#cyber-security';
    const navigation = dom.root.querySelector('.dashboard-mobile-nav');
    const home = navigation.querySelectorAll('[data-module]').find(item => item.dataset.module === 'overview');
    home.focus(); home.click(); await tick();
    assert.equal(navigation.querySelectorAll('[data-module]').find(item => item.dataset.module === 'overview'), home);
    assert.equal(home.closest('nav'), navigation);
    assert.equal(dom.document.activeElement, home);
    assert.equal(dom.root.querySelector('h1').textContent, 'Cyber Security');
    assert.equal(dom.window.location.hash, '#cyber-security');
    assert.equal(navigation.querySelector('[aria-current="page"]').dataset.module, 'cyber_security');
    assert.equal(destroys, 0);

    allowLeave = true; home.click(); await tick();
    assert.equal(dom.root.querySelector('h1').textContent, 'Overview');
    assert.equal(dom.window.location.hash, '#overview');
    assert.equal(dom.document.activeElement.tagName, 'H1');
    assert.equal(navigation.querySelector('[aria-current="page"]').dataset.module, 'overview');
    assert.equal(destroys, 1);
});

test('repeated module destinations retain only the first accepted target', async () => {
    const child = syntheticChild(), dom = mount(readyCyber(), { initialRoute: 'cyber-security', mountCyber: child.adapter });
    const first = dom.controller.navigate('services'), second = dom.controller.navigate('overview');
    await tick(); child.decision.resolve(true); await Promise.all([first, second]); await tick();
    assert.equal(dom.root.querySelector('h1').textContent, 'Services');
    assert.equal(dom.window.location.hash, '#services'); assert.equal(child.destroys, 1);
});

test('forced tenant replacement destroys a pending child and invalidates its later navigation callback', async () => {
    const child = syntheticChild(), dom = mount(readyCyber(), { initialRoute: 'cyber-security', mountCyber: child.adapter });
    const priorGeneration = child.mounts[0].options.generation;
    const navigation = dom.controller.navigate('services'); await tick();
    const next = syntheticChild(); shell.mount(dom.root, readyCyber(), { initialRoute: 'cyber-security', mountCyber: next.adapter });
    assert.equal(child.destroys, 1); assert.notEqual(next.mounts[0].options.generation, priorGeneration);
    const stable = dom.root.textContent, focus = dom.document.activeElement, hash = dom.window.location.hash;
    child.decision.resolve(true); await navigation; await tick(); dom.controller.destroy();
    assert.equal(dom.root.textContent, stable); assert.equal(dom.document.activeElement, focus); assert.equal(dom.window.location.hash, hash);
    assert.equal(next.destroys, 0);
});

// A local deterministic history model can assert cursor/branch invariants. Real
// popstate/hashchange ordering and native browser acceptance remain separate.
function historyDom(options = {}) {
    const dom = createDom(), { window } = dom;
    const listeners = new Map();
    window.addEventListener = (name, handler) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(handler); };
    window.removeEventListener = (name, handler) => listeners.get(name)?.delete(handler);
    window.dispatch = name => { for (const handler of listeners.get(name) || []) handler({ type: name, state: window.history.state }); };
    window.listenerCount = name => listeners.get(name)?.size || 0;
    let cursor = 0, hash = '', entries = [{ state: { host: 'preserved' }, hash: '' }];
    const calls = [], pendingMoves = [];
    const emit = () => queueMicrotask(() => {
        window.dispatch('popstate');
        if (options.splitEvents) setImmediate(() => window.dispatch('hashchange'));
        else window.dispatch('hashchange');
    });
    const move = delta => { const next = cursor + delta; if (next < 0 || next >= entries.length) return; cursor = next; hash = entries[cursor].hash; emit(); };
    const push = (state, nextHash) => { entries = entries.slice(0, cursor + 1); entries.push({ state, hash: nextHash }); cursor += 1; hash = nextHash; };
    Object.defineProperty(window.location, 'hash', { get: () => hash, set: value => { if (value !== hash) { push(null, String(value)); queueMicrotask(() => window.dispatch('hashchange')); } } });
    window.history = {
        get state() { return entries[cursor].state; }, get length() { return entries.length; },
        pushState(state, _title, nextHash) { calls.push(['push', nextHash]); push(state, nextHash); },
        replaceState(state, _title, nextHash) { calls.push(['replace', nextHash]); hash = nextHash; entries[cursor] = { state, hash }; },
        go(delta) { calls.push(['go', delta]); if (options.deferGo) pendingMoves.push(delta); else move(delta); },
        back() { this.go(-1); }, forward() { this.go(1); }
    };
    return { ...dom, flushGo: () => { if (pendingMoves.length) move(pendingMoves.shift()); },
        historyState: () => ({ cursor, entries: clone(entries), calls: clone(calls), pendingMoves: [...pendingMoves] }) };
}

test('owned Back cancellation restores the cursor and preserves the original forward branch', async () => {
    const dom = historyDom(), child = syntheticChild();
    const controller = shell.mount(dom.root, readyCyber(), { initialRoute: 'overview', mountCyber: child.adapter });
    await controller.navigate('cyber-security'); await tick(); child.mounts[0].input.focus();
    const before = dom.historyState(); assert.equal(before.cursor, 1);
    dom.window.history.back(); await tick(); assert.equal(dom.root.querySelector('h1').textContent, 'Cyber Security');
    child.decision.resolve(false); await tick(); await tick();
    const after = dom.historyState();
    assert.equal(after.cursor, before.cursor); assert.deepEqual(after.entries, before.entries);
    assert.equal(dom.window.location.hash, '#cyber-security'); assert.equal(dom.document.activeElement, child.mounts[0].input);
    assert.equal(after.calls.filter(call => call[0] === 'push').length, before.calls.filter(call => call[0] === 'push').length);
});

test('owned Back acceptance navigates without adding or overwriting history entries', async () => {
    const dom = historyDom(), child = syntheticChild();
    const controller = shell.mount(dom.root, readyCyber(), { initialRoute: 'overview', mountCyber: child.adapter });
    await controller.navigate('cyber-security'); await tick(); const before = dom.historyState();
    dom.window.history.back(); await tick(); child.decision.resolve(true); await tick(); await tick();
    const after = dom.historyState(); assert.equal(after.cursor, 0); assert.deepEqual(after.entries, before.entries);
    assert.equal(dom.root.querySelector('h1').textContent, 'Overview'); assert.equal(child.destroys, 1);
    dom.window.history.forward(); await tick(); assert.equal(dom.root.querySelector('h1').textContent, 'Cyber Security');
    assert.equal(child.mounts.length, 2);
});

test('split-task history pairs schedule only one deferred compensation and preserve the history cursor', async () => {
    const dom = historyDom({ splitEvents: true, deferGo: true }), child = syntheticChild();
    const controller = shell.mount(dom.root, readyCyber(), { initialRoute: 'overview', mountCyber: child.adapter });
    await controller.navigate('cyber-security'); await tick();
    const before = dom.historyState(); dom.window.history.back(); dom.flushGo();
    await tick(); await tick();
    assert.deepEqual(dom.historyState().pendingMoves, [1]);
    dom.flushGo(); await tick(); await tick();
    child.decision.resolve(false); await tick(); await tick();
    assert.deepEqual(dom.historyState().pendingMoves, []); assert.equal(dom.historyState().cursor, 1);
    assert.deepEqual(dom.historyState().entries, before.entries); assert.equal(child.destroys, 0);
});

test('foreign popstate followed in a later task by hashchange never tags the foreign entry as owned', async () => {
    const dom = historyDom({ splitEvents: true }), child = syntheticChild();
    const controller = shell.mount(dom.root, readyCyber(), { initialRoute: 'overview', mountCyber: child.adapter });
    await controller.navigate('cyber-security'); await tick();
    const foreign = { externalOwner: 'different-host-session' };
    dom.window.history.pushState(foreign, '', '#services'); dom.window.dispatch('popstate'); await tick();
    const goCount = dom.historyState().calls.filter(call => call[0] === 'go').length;
    dom.window.dispatch('hashchange'); await tick();
    assert.deepEqual(dom.window.history.state, foreign);
    assert.equal(dom.historyState().calls.filter(call => call[0] === 'go').length, goCount);
});


test('first baseline skips planned AI and opens the ready authorized Cyber module', () => {
    const model = clone(view({ empty: true }));
    model.modules.find(item => item.key === 'cyber_security').state = 'ready';
    let opened = 0;
    const dom = mount(model, { mountCyber: () => { opened++; return { destroy() {}, requestLeave(commit) { commit(); return Promise.resolve(true); } }; } });
    const baseline = buttons(dom).find(item => item.textContent === 'View Cyber Security');
    assert.ok(baseline); assert.ok(!buttons(dom).some(item => item.textContent === 'View AI Governance'));
    baseline.click(); assert.equal(opened, 1);
    assert.equal(dom.root.querySelector('h1').textContent, 'Cyber Security');
});

test('first baseline has no action into planned or disabled assessment modules', () => {
    const dom = mount(view({ empty: true }));
    assert.ok(!buttons(dom).some(item => /^View (AI Governance|Cyber Security|IT Optimisation)$/.test(item.textContent)));
    assert.match(dom.root.textContent, /administrator can confirm your assessment scope/);
});


test('Overview uses the main navigation without duplicate module call-to-action cards', () => {
    const dom = mount(view({ empty: true }));
    assert.equal(dom.root.querySelectorAll('.dashboard-module-card').length, 0);
    assert.equal(dom.root.querySelector('.dashboard-availability').querySelectorAll('a').length, 0);
});

test('mobile Workspace opens the ready authorized Cyber module ahead of planned AI', () => {
    const model = clone(view({ empty: true })); model.modules.find(item => item.key === 'cyber_security').state = 'ready';
    let opened = 0;
    const dom = mount(model, { mountCyber: () => { opened++; return { destroy() {}, requestLeave(commit) { commit(); return Promise.resolve(true); } }; } });
    dom.root.querySelector('.dashboard-mobile-nav').querySelectorAll('[data-module]').find(item => item.dataset.module === 'cyber_security').click();
    assert.equal(opened, 1); assert.equal(dom.root.querySelector('h1').textContent, 'Cyber Security');
});


test('disabled Board Reports keeps the disabled label even when Cyber picture is available', () => {
    const model = clone(view()); model.modules.find(item => item.key === 'cyber_security').state = 'ready';
    model.modules.find(item => item.key === 'board_reports').state = 'disabled';
    const options = { mountPicture: () => ({ destroy() {}, requestLeave(commit) { commit(); return Promise.resolve(true); } }) };
    const overview = mount(model, options);
    assert.doesNotMatch(overview.root.querySelector('.dashboard-availability').textContent, /Draft assessment snapshot/);
    const board = mount(model, { ...options, initialRoute: 'board-reports' });
    assert.doesNotMatch(board.root.textContent, /Draft assessment snapshot/);
    assert.match(board.root.textContent, /temporarily unavailable/);
});
