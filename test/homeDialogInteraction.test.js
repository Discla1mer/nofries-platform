'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const testCase = globalThis.test || require('node:test').test;
const source = fs.readFileSync(path.join(__dirname, '../js/home.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const actualDialogIds = [...html.matchAll(/<dialog\b[^>]*\bid="([^"]+)"/g)].map(match => match[1]);
// The Dashboard homepage no longer mounts legacy service modals. Keep the
// retained controller's interaction regressions on explicit synthetic fixtures.
const dialogIds = ['synthetic-information-dialog', 'synthetic-details-dialog'];

function fixture() {
    let click;
    const dialogs = new Map(dialogIds.map(id => {
        const listeners = new Map();
        return [id, { open: false, opens: 0, closes: 0, listeners,
            showModal() { this.open = true; this.opens += 1; },
            close() { this.open = false; this.closes += 1; },
            addEventListener(event, callback) { listeners.set(event, callback); },
            getBoundingClientRect() { return { left: 100, right: 300, top: 90, bottom: 260 }; }
        }];
    }));
    const document = {
        addEventListener(event, callback) { if (event === 'click') click = callback; },
        getElementById(id) { return dialogs.get(id); },
        querySelectorAll() { return [...dialogs.values()]; }
    };
    vm.runInNewContext(source, { document });
    const target = (selector, value) => ({ closest(query) { return query === selector ? value : null; } });
    function open(id) { click({ target: target('[data-dialog]', { dataset: { dialog: id } }) }); }
    function close(dialog) { click({ target: target('[data-close-dialog]', { closest() { return dialog; } }) }); }
    function surface(dialog, x, y, extra = {}) {
        if (dialog.listeners.has('pointerdown')) dialog.listeners.get('pointerdown')({ target: dialog, clientX: x, clientY: y, button: 0, ...extra });
        dialog.listeners.get('click')({ target: dialog, clientX: x, clientY: y, detail: 1, ...extra });
    }
    return { dialogs, click: event => click(event), open, close, surface };
}

testCase('the Dashboard homepage has no legacy service modal or opener', () => {
    assert.equal(actualDialogIds.length, 0);
    assert.doesNotMatch(html, /\bdata-dialog=|\bdata-detail-tab=/);
});
testCase('retained legacy dialogs support delegated opening and explicit closing', () => {
    assert.ok(dialogIds.length > 0);
    assert.equal(new Set(dialogIds).size, dialogIds.length);
    const f = fixture();
    for (const [id, dialog] of f.dialogs) {
        f.open(id); assert.equal(dialog.open, true, id);
        f.close(dialog); assert.equal(dialog.open, false, id);
    }
});
testCase('repeated opening does not call showModal again for the open dialog', () => {
    const f = fixture(), [id, dialog] = f.dialogs.entries().next().value;
    f.open(id); f.open(id); assert.equal(dialog.opens, 1);
    f.close(dialog); f.open(id); assert.equal(dialog.opens, 2);
});
testCase('unknown dialog references do not open another dialog', () => {
    const f = fixture(); f.open('missing-dialog');
    assert.ok([...f.dialogs.values()].every(dialog => !dialog.open));
});
testCase('document and absent click targets are ignored without throwing', () => {
    const f = fixture();
    for (const target of [null, undefined, {}, { nodeType: 3 }]) {
        assert.doesNotThrow(() => f.click({ target }));
    }
});
for (const [name, x, y] of [
    ['internal blank space', 150, 120], ['left border', 100, 120],
    ['right border', 300, 120], ['top border', 150, 90], ['bottom border', 150, 260]
]) testCase(`clicking ${name} does not dismiss the dialog`, () => {
    const f = fixture(), [id, dialog] = f.dialogs.entries().next().value;
    f.open(id); f.surface(dialog, x, y);
    assert.equal(dialog.open, true); assert.equal(dialog.closes, 0);
});
for (const [name, x, y] of [
    ['left', 99, 120], ['right', 301, 120], ['above', 150, 89], ['below', 150, 261]
]) testCase(`an explicit backdrop click ${name} still closes the dialog`, () => {
    const f = fixture(), [id, dialog] = f.dialogs.entries().next().value;
    f.open(id); f.surface(dialog, x, y);
    assert.equal(dialog.open, false); assert.equal(dialog.closes, 1);
});
testCase('keyboard or non-positional surface clicks do not dismiss the dialog', () => {
    const f = fixture(), [id, dialog] = f.dialogs.entries().next().value;
    f.open(id); f.surface(dialog, 0, 0, { detail: 0 });
    for (const [x, y] of [[undefined, undefined], [NaN, 120], [150, Infinity]]) f.surface(dialog, x, y);
    assert.equal(dialog.open, true); assert.equal(dialog.closes, 0);
});
testCase('clicks on a child control are not interpreted as backdrop clicks', () => {
    const f = fixture(), [id, dialog] = f.dialogs.entries().next().value;
    f.open(id); f.surface(dialog, 0, 0, { target: {} });
    assert.equal(dialog.open, true); assert.equal(dialog.closes, 0);
});
testCase('missing or invalid layout information never authorises dismissal', () => {
    const f = fixture(), [id, dialog] = f.dialogs.entries().next().value;
    f.open(id); delete dialog.getBoundingClientRect; f.surface(dialog, 0, 0);
    dialog.getBoundingClientRect = () => ({ left: 300, right: 100, top: 90, bottom: 260 });
    f.surface(dialog, 0, 0);
    dialog.getBoundingClientRect = () => ({ left: NaN, right: 300, top: 90, bottom: 260 });
    f.surface(dialog, 0, 0);
    assert.equal(dialog.open, true); assert.equal(dialog.closes, 0);
});
testCase('an already closed dialog ignores a stale surface click', () => {
    const f = fixture(), dialog = f.dialogs.values().next().value;
    f.surface(dialog, 0, 0);
    assert.equal(dialog.open, false); assert.equal(dialog.closes, 0);
});

function tabFixture() {
    const listeners = {};
    let focused;
    function element(dataset) {
        return { dataset, attributes: {}, classList: { toggle() {} },
            setAttribute(name, value) { this.attributes[name] = value; },
            getAttribute(name) { return this.attributes[name]; },
            closest(selector) { return selector === 'dialog' ? dialog : selector === '[data-detail-tab]' ? this : null; },
            focus() { focused = this; }
        };
    }
    const names = ['synthetic-included', 'synthetic-optional', 'synthetic-next'];
    const tabs = names.map(name => element({ detailTab: name }));
    const panels = names.map(name => element({ detailPanel: name }));
    tabs[0].setAttribute('aria-selected', 'true');
    const dialog = { id: 'process-dialog', open: false, addEventListener() {},
        showModal() { this.open = true; },
        querySelectorAll(selector) { return selector === '[data-detail-tab]' ? tabs : panels; }
    };
    const document = { addEventListener(name, callback) { listeners[name] = callback; },
        querySelectorAll() { return [dialog]; }, getElementById() { return dialog; }
    };
    vm.runInNewContext(source, { document });
    function open() { listeners.click({ target: { closest(selector) { return selector === '[data-dialog]' ? { dataset: { dialog: dialog.id } } : null; } } }); }
    function key(tab, key, extra = {}) {
        let prevented = false;
        listeners.keydown({ target: tab, key, preventDefault() { prevented = true; }, ...extra });
        return prevented;
    }
    open();
    return { tabs, panels, dialog, open, key, click: tab => listeners.click({ target: tab }), focused: () => focused };
}

function assertSelection(f, index) {
    f.tabs.forEach((tab, i) => {
        assert.equal(tab.getAttribute('aria-selected'), String(i === index));
        assert.equal(tab.tabIndex, i === index ? 0 : -1);
        assert.equal(f.panels[i].hidden, i !== index);
        assert.equal(tab.getAttribute('aria-controls'), f.panels[i].id);
        assert.equal(f.panels[i].getAttribute('aria-labelledby'), tab.id);
        assert.equal(f.panels[i].getAttribute('role'), 'tabpanel');
        assert.equal(f.panels[i].tabIndex, 0);
    });
}

testCase('opening service details links tabs and panels with one selected keyboard stop', () => {
    const f = tabFixture(); assertSelection(f, 0);
    assert.equal(new Set([...f.tabs, ...f.panels].map(item => item.id)).size, f.tabs.length * 2);
});
testCase('arrow keys wrap and move focus with the visible service panel', () => {
    const f = tabFixture(), last = f.tabs.length - 1;
    assert.equal(f.key(f.tabs[0], 'ArrowLeft'), true); assertSelection(f, last);
    assert.equal(f.focused(), f.tabs[last]);
    f.key(f.tabs[last], 'ArrowRight'); assertSelection(f, 0);
    f.key(f.tabs[0], 'ArrowRight'); assertSelection(f, 1); assert.equal(f.focused(), f.tabs[1]);
});
testCase('Home and End jump to the first and last service panels', () => {
    const f = tabFixture(), last = f.tabs.length - 1;
    f.key(f.tabs[0], 'End'); assertSelection(f, last); assert.equal(f.focused(), f.tabs[last]);
    f.key(f.tabs[last], 'Home'); assertSelection(f, 0); assert.equal(f.focused(), f.tabs[0]);
});
testCase('click selection and reopening preserve the selected tab and panel', () => {
    const f = tabFixture(); f.click(f.tabs[2]); assertSelection(f, 2);
    f.dialog.open = false; f.open(); assertSelection(f, 2);
});
testCase('disabled service tabs are skipped and cannot be clicked into selection', () => {
    const f = tabFixture(); f.tabs[1].disabled = true;
    f.click(f.tabs[1]); assertSelection(f, 0);
    f.key(f.tabs[0], 'ArrowRight'); assertSelection(f, 2);
});
testCase('unrelated keys, modified keys and non-tab targets preserve native behavior', () => {
    const f = tabFixture();
    for (const key of ['Tab', 'Escape', 'ArrowDown', 'a']) assert.equal(f.key(f.tabs[0], key), false);
    for (const modifier of ['ctrlKey', 'metaKey', 'altKey']) assert.equal(f.key(f.tabs[0], 'ArrowRight', { [modifier]: true }), false);
    for (const target of [null, {}, { closest() { return null; } }]) assert.equal(f.key(target, 'ArrowRight'), false);
    assertSelection(f, 0);
    f.dialog.open = false; assert.equal(f.key(f.tabs[0], 'ArrowRight'), false); assertSelection(f, 0);
});

function gesture(f, dialog, start, end) {
    const event = position => ({ target: dialog, clientX: position[0], clientY: position[1], button: 0, detail: 1 });
    if (dialog.listeners.has('pointerdown')) dialog.listeners.get('pointerdown')(event(start));
    dialog.listeners.get('click')(event(end));
}

testCase('dragging from dialog padding or content onto the backdrop does not dismiss it', () => {
    const f = fixture(), [id, dialog] = f.dialogs.entries().next().value;
    f.open(id);
    gesture(f, dialog, [150, 120], [99, 120]);
    assert.equal(dialog.open, true);
    if (dialog.listeners.has('pointerdown')) dialog.listeners.get('pointerdown')({ target: {}, clientX: 150, clientY: 120, button: 0 });
    dialog.listeners.get('click')({ target: dialog, clientX: 99, clientY: 120, detail: 1 });
    assert.equal(dialog.open, true);
});
testCase('a gesture beginning outside and ending inside does not dismiss the dialog', () => {
    const f = fixture(), [id, dialog] = f.dialogs.entries().next().value;
    f.open(id); gesture(f, dialog, [99, 120], [150, 120]);
    assert.equal(dialog.open, true);
});
for (const interruption of ['pointercancel', 'close']) testCase(`${interruption} clears a pending backdrop gesture`, () => {
    const f = fixture(), [id, dialog] = f.dialogs.entries().next().value;
    f.open(id);
    if (dialog.listeners.has('pointerdown')) dialog.listeners.get('pointerdown')({ target: dialog, clientX: 99, clientY: 120, button: 0 });
    if (dialog.listeners.has(interruption)) dialog.listeners.get(interruption)();
    dialog.listeners.get('click')({ target: dialog, clientX: 99, clientY: 120, detail: 1 });
    assert.equal(dialog.open, true);
});
testCase('an outside click without a pointer start does not dismiss the dialog', () => {
    const f = fixture(), [id, dialog] = f.dialogs.entries().next().value;
    f.open(id);
    dialog.listeners.get('click')({ target: dialog, clientX: 99, clientY: 120, detail: 1 });
    assert.equal(dialog.open, true);
});
testCase('secondary and non-primary pointers do not authorise backdrop dismissal', () => {
    for (const extra of [{ button: 2 }, { isPrimary: false }]) {
        const f = fixture(), [id, dialog] = f.dialogs.entries().next().value;
        f.open(id); f.surface(dialog, 99, 120, extra); assert.equal(dialog.open, true);
    }
});
