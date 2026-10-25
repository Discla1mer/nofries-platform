'use strict';

// Minimal DOM contract for deterministic renderer tests; not a browser/layout engine.
function createDom() {
    const document = { activeElement: null };
    class Element {
        constructor(tag) {
            this.tagName = tag.toUpperCase(); this.ownerDocument = document; this.children = [];
            this.style = { setProperty(name, value) { this[name] = String(value); }, getPropertyValue(name) { return this[name] || ''; } };
            this.dataset = {}; this.attributes = {}; this.events = {}; this.hidden = false; this.className = ''; this._text = '';
            this.classList = { add: value => { if (!this.classList.contains(value)) this.className = (this.className + ' ' + value).trim(); },
                remove: value => { this.className = this.className.split(' ').filter(item => item !== value).join(' '); },
                contains: value => this.className.split(' ').includes(value) };
        }
        set textContent(value) { this._text = String(value); this.children = []; }
        get textContent() { return this._text + this.children.map(child => child.textContent).join(' '); }
        append(...children) { children.forEach(child => { child.parentElement = this; this.children.push(child); }); }
        prepend(...children) { children.forEach(child => { child.parentElement = this; }); this.children.unshift(...children); }
        remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; }
        replaceChildren(...children) { this.children.forEach(child => { child.parentElement = null; }); this.children = []; this._text = ''; this.append(...children); }
        setAttribute(key, value) { this.attributes[key] = String(value); }
        getAttribute(key) { return Object.prototype.hasOwnProperty.call(this.attributes, key) ? this.attributes[key] : null; }
        removeAttribute(key) { delete this.attributes[key]; }
        setCustomValidity(message) { this.validationMessage = String(message); }
        addEventListener(key, fn) { (this.events[key] ||= new Set()).add(fn); }
        removeEventListener(key, fn) { this.events[key]?.delete(fn); }
        click() { for (const fn of this.events.click || []) fn({ currentTarget: this, preventDefault() {} }); }
        focus() { document.activeElement = this; }
        matches(selector) {
            if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
            if (selector.startsWith('[')) {
                const [, attr, value] = selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
                const found = attr.startsWith('data-') ? this.dataset[attr.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] : this.getAttribute(attr);
                return value === undefined ? found != null : found === value;
            }
            return this.tagName.toLowerCase() === selector.toLowerCase();
        }
        querySelectorAll(selector) { return this.children.flatMap(child => [...child.matches(selector) ? [child] : [], ...child.querySelectorAll(selector)]); }
        querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
        closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
    }
    document.createElement = tag => new Element(tag);
    const listeners = {};
    const window = { location: { hash: '' }, history: { pushState(_state, _title, hash) { window.location.hash = hash; },
            replaceState(_state, _title, hash) { window.location.hash = hash; } },
        addEventListener(name, fn) { (listeners[name] ||= new Set()).add(fn); },
        removeEventListener(name, fn) { listeners[name]?.delete(fn); },
        dispatch(name) { for (const fn of listeners[name] || []) fn(); },
        listenerCount(name) { return listeners[name]?.size || 0; } };
    document.defaultView = window;
    return { document, window, root: document.createElement('div') };
}
module.exports = { createDom };
