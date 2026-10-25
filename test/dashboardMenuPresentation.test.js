'use strict';

const assert = require('node:assert/strict');
const test = global.test || require('node:test');
const registry = require('../api/shared/protectedAssets/dashboardRegistry');
const shell = require('../api/shared/protectedAssets/dashboardShell');
const { projectDashboard } = require('../api/shared/appLifecycle/dashboardProjection');
const { fixture } = require('./fixtures/dashboardFixture');
const { createDom } = require('./fixtures/dashboardDom');

const clone = value => JSON.parse(JSON.stringify(value));
const projection = options => projectDashboard(fixture(options));
const ready = () => {
    const model = clone(projection());
    model.modules.find(item => item.key === 'cyber_security').state = 'ready';
    return model;
};
const mount = (model = ready(), options = {}) => {
    const dom = createDom();
    return { ...dom, controller: shell.mount(dom.root, model, options) };
};
const menus = dom => [dom.root.querySelector('.dashboard-rail').querySelector('nav'),
    dom.root.querySelector('.dashboard-mobile-nav')];
const links = node => node ? node.querySelectorAll('[data-module]') : [];
const moduleKeys = node => links(node).map(item => item.dataset.module);
const primary = menu => menu.querySelector('.dashboard-menu-primary');
const other = menu => menu.querySelector('.dashboard-menu-other');
const linkFor = (menu, key) => links(menu).find(item => item.dataset.module === key);
const currentKeys = menu => menu.querySelectorAll('[aria-current="page"]').map(item => item.dataset.module);
const tick = () => new Promise(resolve => setImmediate(resolve));

test('ready workspace destinations lead both menus while other permitted routes use a native disclosure', () => {
    const dom = mount();
    for (const menu of menus(dom)) {
        assert.equal(primary(menu).querySelector('.dashboard-eyebrow').textContent, 'Workspace');
        assert.deepEqual(moduleKeys(primary(menu)), ['overview', 'cyber_security', 'services']);
        assert.equal(other(menu).tagName, 'DETAILS');
        assert.equal(other(menu).querySelector('summary').textContent, 'Other workspaces');
        assert.ok(!other(menu).open);
        assert.deepEqual(moduleKeys(other(menu)), ['ai_governance', 'it_optimisation', 'improvement_plan', 'evidence', 'board_reports']);
        assert.deepEqual(currentKeys(menu), ['overview']);
        assert.equal(menu.querySelectorAll('button').length, 0);
        assert.equal(menu.querySelectorAll('[role="menu"]').length, 0);
        assert.equal(menu.querySelectorAll('[role="menuitem"]').length, 0);
    }
});

for (const options of [{ role: 'viewer' }, { tier: 'dashboard_score' },
    { role: 'fractional_advisor', service: 'fractional_advisory' }]) {
    test(`grouping preserves the server permission subset for ${options.role || options.tier}`, () => {
        const model = projection(options), before = JSON.stringify(model);
        const dom = mount(model);
        const permitted = registry.modules.filter(item => model.modules.some(module => module.key === item.key));
        const expectedPrimary = permitted.filter(item => ['overview', 'cyber_security', 'services'].includes(item.key) &&
            model.modules.find(module => module.key === item.key).state === 'ready');
        for (const menu of menus(dom)) {
            assert.deepEqual(moduleKeys(primary(menu)), expectedPrimary.map(item => item.key));
            assert.deepEqual(moduleKeys(menu).slice().sort(), permitted.map(item => item.key).sort());
            for (const item of registry.modules) {
                assert.equal(links(menu).filter(link => link.dataset.module === item.key).length,
                    permitted.includes(item) ? 1 : 0);
            }
        }
        assert.equal(JSON.stringify(model), before);
    });
}

test('planned and disabled modules stay secondary with truthful state labels, including disabled Cyber', () => {
    const model = ready();
    model.modules.find(item => item.key === 'cyber_security').state = 'disabled';
    model.modules.find(item => item.key === 'board_reports').state = 'ready';
    model.summary = { state: 'empty', attention: [], metrics: [] };
    const dom = mount(model);
    for (const menu of menus(dom)) {
        assert.deepEqual(moduleKeys(primary(menu)), ['overview', 'services']);
        assert.match(linkFor(other(menu), 'cyber_security').textContent, /Cyber Security.*Unavailable/);
        assert.match(linkFor(other(menu), 'ai_governance').textContent, /AI Governance and Strategy.*Coming next/);
        assert.match(linkFor(other(menu), 'board_reports').textContent, /Board Reports.*Available/);
    }
    linkFor(menus(dom)[0], 'cyber_security').click();
    assert.match(dom.root.querySelector('main').textContent, /temporarily unavailable/);
    assert.equal(dom.root.querySelector('.ncsc-questionnaire'), null);
});

test('menu links retain canonical fragments and native anchor and disclosure semantics', () => {
    const dom = mount();
    for (const menu of menus(dom)) {
        for (const link of links(menu)) {
            const item = registry.modules.find(module => module.key === link.dataset.module);
            assert.equal(link.tagName, 'A');
            assert.equal(link.href, '#' + item.route);
            assert.equal(link.getAttribute('role'), null);
            assert.equal(link.getAttribute('tabindex'), null);
        }
        const disclosure = other(menu);
        assert.equal(disclosure.getAttribute('role'), null);
        assert.equal(disclosure.querySelector('summary').getAttribute('role'), null);
        assert.doesNotMatch(menu.textContent, /Settings|Billing|Users/);
    }
});

test('secondary deep links expose the current route and accepted navigation preserves user disclosure choices', async () => {
    const dom = mount(ready(), { initialRoute: '#board-reports' });
    for (const menu of menus(dom)) {
        assert.equal(other(menu).open, true);
        assert.deepEqual(currentKeys(menu), ['board_reports']);
        other(menu).open = false;
    }
    await dom.controller.navigate('services', true);
    for (const menu of menus(dom)) {
        assert.ok(!other(menu).open);
        assert.deepEqual(currentKeys(menu), ['services']);
    }
    await dom.controller.navigate('evidence', true);
    for (const menu of menus(dom)) {
        assert.equal(other(menu).open, true);
        assert.deepEqual(currentKeys(menu), ['evidence']);
    }
    assert.equal(dom.window.location.hash, '#evidence');
    assert.equal(dom.document.activeElement.textContent, 'Evidence');
});

test('ready Cyber has no duplicate planned sibling links above the assessment workspace', () => {
    const dom = mount(ready(), { initialRoute: '#cyber-security' });
    assert.equal(dom.root.querySelector('main').querySelector('.dashboard-group-links'), null);
    for (const menu of menus(dom)) assert.ok(linkFor(other(menu), 'ai_governance'));
});

test('secondary links retain the existing leave guard through Stay, repeated clicks and a later accepted route', async () => {
    let resolveDecision, pendingCommit, requests = 0, destroys = 0, input;
    const dom = mount(ready(), { initialRoute: '#cyber-security', mountCyber(root) {
        input = root.ownerDocument.createElement('input');
        input.value = 'Synthetic unsaved assessment'; root.append(input);
        return { destroy() { destroys++; }, requestLeave(commit) {
            requests++; pendingCommit = commit;
            return new Promise(resolve => { resolveDecision = allowed => { if (allowed) pendingCommit(); resolve(allowed); }; });
        } };
    } });
    dom.window.location.hash = '#cyber-security';
    const menu = menus(dom)[1], disclosure = other(menu), evidence = linkFor(menu, 'evidence');
    disclosure.open = true;
    evidence.focus(); evidence.click(); linkFor(menu, 'services').click(); await tick();
    assert.equal(requests, 1);
    assert.equal(disclosure.open, true);
    assert.deepEqual(currentKeys(menu), ['cyber_security']);
    assert.equal(dom.root.querySelector('h1').textContent, 'Cyber Security');
    resolveDecision(false); await tick();
    assert.equal(destroys, 0);
    assert.equal(input.value, 'Synthetic unsaved assessment');
    assert.ok(input.parentElement);
    assert.equal(dom.document.activeElement, evidence);
    assert.equal(dom.window.location.hash, '#cyber-security');
    assert.equal(other(menu), disclosure);
    assert.equal(linkFor(menu, 'evidence'), evidence);
    evidence.click(); await tick(); resolveDecision(true); await tick();
    assert.equal(requests, 2); assert.equal(destroys, 1);
    assert.equal(dom.root.querySelector('h1').textContent, 'Evidence');
    assert.equal(dom.window.location.hash, '#evidence');
    assert.equal(dom.document.activeElement.textContent, 'Evidence');
    assert.equal(other(menu).open, true);
    assert.deepEqual(currentKeys(menu), ['evidence']);
});
