'use strict';

// Geometry-contract regression for COMBINED-UX-02. Native Tab/hit-testing is
// independently checked in Chromium; this fixture is not a layout engine.
const explanation = require('../api/shared/protectedAssets/assessmentExplanation');
const { createNcscQuestionnaireMetadata } = require('../api/shared/ncscQuestionnaireMetadata');
const { createDom } = require('./fixtures/dashboardDom');
const metadata = createNcscQuestionnaireMetadata();
const rect = (left, top, right, bottom) => ({ left, top, right, bottom, width: right - left, height: bottom - top });
const pause = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let reject; const promise = new Promise((_resolve, fail) => { reject = fail; }); return { promise, reject }; };

function setup(options = {}) {
    const dom = createDom(), create = dom.document.createElement, elements = [], frames = new Map(), observers = [];
    let frameId = 0;
    dom.window.requestAnimationFrame = jest.fn(callback => { frames.set(++frameId, callback); return frameId; });
    dom.window.cancelAnimationFrame = jest.fn(id => frames.delete(id));
    class ResizeObserver {
        constructor(callback) { this.callback = callback; this.targets = new Set(); this.disconnected = false; observers.push(this); }
        observe(target) { this.targets.add(target); }
        unobserve(target) { this.targets.delete(target); }
        disconnect() { this.targets.clear(); this.disconnected = true; }
    }
    if (options.withObserver !== false) dom.window.ResizeObserver = ResizeObserver;
    dom.window.innerHeight = 320; dom.window.innerWidth = 568;
    dom.window.scrollBy = jest.fn(({ top }) => {
        const element = dom.document.activeElement, current = element.rect;
        element.rect = rect(current.left, current.top - top, current.right, current.bottom - top);
    });
    dom.window.getComputedStyle = node => node.computedStyle || { display: 'block', visibility: 'visible', position: 'static' };
    dom.document.createElement = tag => {
        const element = create(tag); elements.push(element);
        element.getBoundingClientRect = () => element.rect || rect(0, 0, 0, 0);
        element.scrollIntoView = jest.fn(() => { element.rect = options.centeredRect || rect(16, 125, 180, 175); });
        element.focus = () => {
            dom.document.activeElement = element;
            for (const listener of element.events.focus || []) listener({ target: element, currentTarget: element });
        };
        return element;
    };
    const shell = dom.document.createElement('div'); shell.className = 'nofries-dashboard';
    const root = dom.document.createElement('section'), nav = dom.document.createElement('nav'); nav.className = 'dashboard-mobile-nav';
    nav.rect = options.navRect || rect(0, 255, 568, 320);
    nav.computedStyle = { display: 'flex', visibility: 'visible', position: 'fixed', ...options.navStyle };
    shell.append(root); if (options.withNav !== false) shell.append(nav);
    const client = { read: jest.fn() }, controller = explanation.mount(root, { metadata, client, organisationId: 'synthetic-org',
        resultModel: jest.fn(() => null), assessment: { assessmentId: 'synthetic-assessment', revision: 2, status: 'submitted',
            revisionSha256: 'a'.repeat(64), profileRef: metadata.profileRef } });
    const control = label => root.querySelectorAll('button').find(element => element.textContent === label);
    return { ...dom, root, shell, nav, client, controller, control, elements, observers, frames,
        reflow: () => observers.forEach(observer => observer.callback([])),
        flushFrames: () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback()); } };
}

test.each(['Saved range', 'Unresolved answers', 'Framework starting actions', 'Explain this saved result', 'Clear saved explanation'])
('keyboard focus clears fixed mobile navigation for the module’s own %s control', label => {
    const view = setup(), control = view.control(label); control.rect = rect(16, 270.19, 180, 320.16);
    try {
        control.focus();
        expect(control.scrollIntoView).toHaveBeenCalledTimes(1);
        expect(control.scrollIntoView).toHaveBeenCalledWith({ block: 'center', inline: 'nearest', behavior: 'instant' });
        expect(control.getBoundingClientRect().bottom).toBeLessThanOrEqual(view.nav.getBoundingClientRect().top);
        expect(view.document.activeElement).toBe(control); expect(view.client.read).not.toHaveBeenCalled();
    } finally { view.controller.destroy(); }
});

test('focus uses the current nav geometry, including a taller wrapped or safe-area nav', () => {
    const view = setup({ navRect: rect(0, 210, 568, 320) }), control = view.control('Saved range');
    try {
        control.rect = rect(16, 220, 180, 250); control.focus(); expect(control.scrollIntoView).toHaveBeenCalledTimes(1);
        view.nav.rect = rect(0, 280, 568, 320); control.rect = rect(16, 220, 180, 250); control.focus();
        expect(control.scrollIntoView).toHaveBeenCalledTimes(1);
    } finally { view.controller.destroy(); }
});


test('a tall visible nav clears residual overlap after viewport centering', () => {
    const view = setup({ navRect: rect(0, 403, 320, 740), centeredRect: rect(16, 320, 180, 420) });
    view.window.innerHeight = 740; view.window.innerWidth = 320;
    const control = view.control('Saved range'); control.rect = rect(16, 600, 180, 700);
    try {
        control.focus(); expect(control.scrollIntoView).toHaveBeenCalledTimes(1);
        expect(view.window.scrollBy).toHaveBeenCalledWith({ top: 17, behavior: 'instant' });
        expect(control.getBoundingClientRect().bottom).toBe(403);
        expect(view.document.activeElement).toBe(control); expect(view.client.read).not.toHaveBeenCalled();
    } finally { view.controller.destroy(); }
});

test.each([
    ['no navigation', { withNav: false }],
    ['desktop hidden navigation', { navStyle: { display: 'none' } }],
    ['invisible navigation', { navStyle: { visibility: 'hidden' } }],
    ['non-fixed navigation', { navStyle: { position: 'static' } }],
    ['zero-size navigation', { navRect: rect(0, 255, 0, 255) }],
    ['navigation outside the viewport', { navRect: rect(0, 330, 568, 395) }],
    ['no horizontal intersection', { navRect: rect(400, 255, 568, 320) }]
])('%s does not cause a focus scroll', (_name, options) => {
    const view = setup(options), control = view.control('Saved range'); control.rect = rect(16, 270.19, 180, 320.16);
    try { control.focus(); expect(control.scrollIntoView).not.toHaveBeenCalled(); }
    finally { view.controller.destroy(); }
});

test('already clear controls and focus outside the module do not scroll or start a read', () => {
    const view = setup(), control = view.control('Saved range'), outside = view.document.createElement('button');
    try {
        control.rect = rect(16, 180, 180, 230); control.focus(); expect(control.scrollIntoView).not.toHaveBeenCalled();
        outside.rect = rect(16, 270, 180, 320); view.shell.append(outside); outside.focus();
        expect(outside.scrollIntoView).not.toHaveBeenCalled(); expect(view.document.activeElement).toBe(outside);
        expect(view.client.read).not.toHaveBeenCalled();
    } finally { view.controller.destroy(); }
});

test('a navigation from another dashboard shell cannot cause a scroll', () => {
    const view = setup({ withNav: false }), other = view.document.createElement('div'); other.className = 'nofries-dashboard';
    other.append(view.nav); const control = view.control('Saved range'); control.rect = rect(16, 270, 180, 320);
    try { control.focus(); expect(control.scrollIntoView).not.toHaveBeenCalled(); }
    finally { view.controller.destroy(); }
});

test.each(['rerender', 'destroy'])('a detached old control cannot scroll after %s', action => {
    const view = setup(), control = view.control('Saved range'); control.rect = rect(16, 270, 180, 320);
    if (action === 'destroy') view.controller.destroy();
    else view.control('Unresolved answers').click();
    try { control.focus(); expect(control.scrollIntoView).not.toHaveBeenCalled(); }
    finally { view.controller.destroy(); }
});

test('pending read completion preserves outside focus and never scrolls its replacement controls', async () => {
    const view = setup(), pending = deferred(), outside = view.document.createElement('button');
    view.client.read.mockReturnValue(pending.promise);
    try {
        const load = view.control('Explain this saved result'); load.rect = rect(16, 270, 180, 320); load.focus(); load.click();
        outside.rect = rect(16, 270, 180, 320); view.shell.append(outside); outside.focus();
        const before = view.elements.reduce((count, node) => count + node.scrollIntoView.mock.calls.length, 0);
        pending.reject(new Error('synthetic read failure')); await pause();
        expect(view.document.activeElement).toBe(outside);
        expect(view.elements.reduce((count, node) => count + node.scrollIntoView.mock.calls.length, 0)).toBe(before);
    } finally { view.controller.destroy(); }
});


test.each(['window resize', 'root text reflow'])('%s clears an already focused control without refocusing or reading', trigger => {
    const view = setup(), control = view.control('Saved range'); control.rect = rect(16, 135, 180, 185); control.focus();
    try {
        control.rect = rect(16, 1146, 180, 1196);
        if (trigger === 'window resize') view.window.dispatch('resize');
        else view.reflow();
        view.flushFrames();
        expect(control.scrollIntoView).toHaveBeenCalledTimes(1);
        expect(control.getBoundingClientRect().bottom).toBeLessThanOrEqual(view.nav.rect.top);
        expect(view.document.activeElement).toBe(control); expect(view.client.read).not.toHaveBeenCalled();
    } finally { view.controller.destroy(); }
});

test('growing fixed navigation after focus triggers clearance through the local observer', () => {
    const view = setup(), control = view.control('Unresolved answers'); control.rect = rect(16, 180, 180, 230); control.focus();
    try {
        view.nav.rect = rect(0, 210, 568, 320); view.reflow(); view.flushFrames();
        expect(control.scrollIntoView).toHaveBeenCalledTimes(1); expect(view.document.activeElement).toBe(control);
        expect(view.observers[0].targets.has(view.root)).toBe(true); expect(view.observers[0].targets.has(view.nav)).toBe(true);
    } finally { view.controller.destroy(); }
});

test('desktop reflow and a resize without ResizeObserver keep owned focus inside the viewport', () => {
    const view = setup({ navStyle: { display: 'none' }, withObserver: false }), control = view.control('Saved range');
    control.rect = rect(16, 135, 180, 185); control.focus();
    try {
        control.rect = rect(16, -100, 180, -50); view.window.dispatch('resize'); view.flushFrames();
        expect(control.scrollIntoView).toHaveBeenCalledTimes(1); expect(view.document.activeElement).toBe(control);
    } finally { view.controller.destroy(); }
});

test('resize and observer notifications coalesce, then settled geometry causes no scroll loop', () => {
    const view = setup(), control = view.control('Saved range'); control.rect = rect(16, 135, 180, 185); control.focus();
    try {
        control.rect = rect(16, 5796, 180, 5846);
        for (let i = 0; i < 8; i++) { view.reflow(); view.window.dispatch('resize'); }
        expect(view.frames.size).toBe(1); view.flushFrames(); expect(control.scrollIntoView).toHaveBeenCalledTimes(1);
        view.reflow(); view.flushFrames(); expect(control.scrollIntoView).toHaveBeenCalledTimes(1);
        expect(view.client.read).not.toHaveBeenCalled();
    } finally { view.controller.destroy(); }
});

test('focus moved outside before a queued reflow check prevents all scrolling', () => {
    const view = setup(), control = view.control('Saved range'), outside = view.document.createElement('button');
    control.rect = rect(16, 135, 180, 185); control.focus();
    try {
        control.rect = rect(16, 1146, 180, 1196); view.reflow(); outside.focus(); view.flushFrames();
        expect(control.scrollIntoView).not.toHaveBeenCalled(); expect(outside.scrollIntoView).not.toHaveBeenCalled();
        expect(view.document.activeElement).toBe(outside); expect(view.client.read).not.toHaveBeenCalled();
    } finally { view.controller.destroy(); }
});

test('destroy disconnects local observation, removes resize listeners and cancels pending clearance', () => {
    const view = setup(), control = view.control('Saved range'); control.rect = rect(16, 135, 180, 185); control.focus();
    control.rect = rect(16, 1146, 180, 1196); view.window.dispatch('resize');
    const stale = [...view.frames.values()][0]; view.controller.destroy();
    expect(view.window.listenerCount('resize')).toBe(0);
    expect(view.observers[0].disconnected).toBe(true); expect(view.frames.size).toBe(0);
    if (stale) stale(); view.reflow(); view.window.dispatch('resize'); view.flushFrames();
    expect(control.scrollIntoView).not.toHaveBeenCalled(); expect(view.frames.size).toBe(0);
});
