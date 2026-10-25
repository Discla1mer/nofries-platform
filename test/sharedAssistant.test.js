'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const clientSource = fs.readFileSync(path.join(__dirname, '../js/prospect-assistant.js'), 'utf8');
const sharedSource = fs.readFileSync(path.join(__dirname, '../js/shared-assistant.js'), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));

function harness({ page = 'managed-it', transport = 'same-origin', helpOnly = ['home', 'dashboard'].includes(page), session, chat, layout = false } = {}) {
    let document;
    function element() {
        const handlers = {}, attrs = {}, properties = {};
        let content = '';
        return {
            handlers, attrs, properties, dataset: {}, disabled: false, hidden: false, value: '', textContent: '',
            get textContent() { return this.children.length ? this.children.map(child => child.textContent).join('') : content; },
            set textContent(value) { content = String(value); this.children = []; },
            children: [], scrollTop: 0, scrollHeight: 0, classList: { add() {}, remove() {} },
            addEventListener(type, fn) { (handlers[type] ||= []).push(fn); },
            removeEventListener(type, fn) { handlers[type] = (handlers[type] || []).filter(listener => listener !== fn); },
            fire(type, event = {}) { (handlers[type] || []).forEach(fn => fn({ target: this, ...event })); },
            setAttribute(name, value) { attrs[name] = String(value); },
            getAttribute(name) { return attrs[name] || null; },
            append(...items) { this.children.push(...items); },
            replaceChildren(...items) { content = ''; this.children = items; },
            removeChild(item) { this.children.splice(this.children.indexOf(item), 1); },
            focus() { document.activeElement = this; this.fire('focus'); document.fire('focusin', { target: this }); },
            closest() { return null; },
            style: { setProperty(name, value) { properties[name] = value; } }
        };
    }
    const root = element();
    root.dataset = { assistantPage: page, assistantTransport: transport, assistantHelpOnly: String(helpOnly) };
    const elements = new Map(['prospect-assistant', 'assistant-form', 'assistant-input', 'assistant-messages',
        'assistant-prompts', 'assistant-runtime', 'assistant-progress', 'assistant-stop', 'assistant-retry', 'assistant-reset', 'nofries-assistant-dialog'].map(id => [id, element()]));
    const launcher = element(), closeButton = element(), submit = element(), composer = element(), header = element();
    header.height = 56;
    header.getBoundingClientRect = () => ({ height: header.height });
    composer.querySelector = () => submit;
    composer.contains = target => [elements.get('assistant-input'), submit].includes(target);
    composer.scrolls = [];
    composer.scrollIntoView = options => composer.scrolls.push(options);
    const starters = ['home', 'dashboard', 'managed-it', 'sales-agency', 'news', 'roadmap', 'luna'].map(topic => {
        const button = element(); button.dataset = { assistantStarterTopic: topic, message: 'Fixed public ' + topic }; return button;
    });
    const dialog = elements.get('nofries-assistant-dialog');
    dialog.open = false;
    dialog.show = () => { dialog.open = true; };
    dialog.close = () => { dialog.open = false; queueMicrotask(() => dialog.fire('close')); };
    const owned = new Set([root, launcher, closeButton, submit, ...elements.values(), ...starters]);
    root.contains = target => owned.has(target);
    dialog.contains = target => owned.has(target) && ![root, launcher].includes(target);
    root.querySelector = selector => selector === '.nf-assistant-header' ? header : selector === '.nf-assistant-compose' ? composer : selector === '[data-assistant-launcher]' ? launcher
        : selector === '[data-assistant-close]' ? closeButton : elements.get(selector.slice(1)) || null;
    root.querySelectorAll = selector => selector === '[data-assistant-starter-topic]' ? starters : [];
    elements.get('prospect-assistant').closest = selector => selector === '[data-shared-assistant]' ? root : null;
    elements.get('assistant-form').querySelector = () => submit;
    elements.get('assistant-prompts').querySelectorAll = () => starters;
    const body = element();
    body.dataset = {};
    document = Object.assign(element(), {
        body, activeElement: body,
        getElementById(id) { return elements.get(id) || null; },
        querySelectorAll(selector) { return selector === '[data-shared-assistant]' ? [root] : []; },
        createElement(tag) { return Object.assign(element(), { tagName: tag.toUpperCase() }); },
        createTextNode(text) { const node = element(); node.textContent = text; return node; }
    });
    for (const privateProperty of ['cookie', 'URL', 'location']) {
        Object.defineProperty(document, privateProperty, { get() { throw new Error('Private page context was read'); } });
    }
    for (const control of [elements.get('assistant-input'), submit, ...starters]) {
        let disabled = false;
        Object.defineProperty(control, 'disabled', { get() { return disabled; }, set(value) {
            disabled = value;
            if (value && document.activeElement === control) document.activeElement = body;
        } });
        control.disabled = true; // Matches the renderer's initially disabled controls.
    }
    const calls = [];
    const payload = { assistant: { runtime: { mode: 'mock' }, pricing: {}, publicHelpOnly: helpOnly,
        publicHelpProtocol: helpOnly ? 'public-help-v1' : null },
        conversation: { messages: [] }, organisation: null };
    const fetch = async (url, options) => {
        calls.push({ url, options });
        if (url.startsWith('/api/prospect/session')) return session ? session() : { ok: true, json: async () => payload };
        if (url === '/api/prospect/chat') return chat ? chat() : { ok: true,
            text: async () => 'event: done\ndata: {"text":"Synthetic public reply","runtime":{"mode":"mock"}}\n\n' };
        throw new Error('Unexpected request');
    };
    const deadlines = [];
    const context = { document, fetch, TextDecoder, AbortController,
        setTimeout(fn, delay) { const timer = { fn, delay, cleared: false }; deadlines.push(timer); return timer; },
        clearTimeout(timer) { timer.cleared = true; }
    };
    const geometry = { navigation: null, resize: null, mutation: null, windowResize: null, observed: new Set(), composerResize: null, composerObserved: new Set() };
    const windowResizes = [];
    if (layout) {
        document.querySelector = selector => {
            if (selector !== '.dashboard-mobile-nav') throw new Error('Unexpected page content read');
            return geometry.navigation;
        };
        Object.assign(context, {
            innerHeight: 640,
            ResizeObserver: class {
                constructor(callback) { this.callback = callback; }
                observe(node) {
                    if ([header, dialog, composer].includes(node)) {
                        geometry.composerResize = this.callback; geometry.composerObserved.add(node);
                    } else { geometry.resize = this.callback; geometry.observed.add(node); }
                }
                unobserve(node) { geometry.observed.delete(node); geometry.composerObserved.delete(node); }
            },
            MutationObserver: class {
                constructor(callback) { geometry.mutation = callback; }
                observe() {}
            },
            addEventListener(type, callback) {
                if (type !== 'resize') throw new Error('Unexpected layout event');
                windowResizes.push(callback);
                geometry.windowResize = () => windowResizes.forEach(listener => listener());
            }
        });
    }
    vm.createContext(context);
    vm.runInContext(clientSource, context);
    vm.runInContext(sharedSource, context);
    function cta(topic = 'managed-it') {
        const node = element();
        node.dataset.assistantTopic = topic;
        node.closest = selector => selector === '[data-assistant-open]' ? node : null;
        node.focus();
        document.fire('click', { target: node, preventDefault() {} });
        return node;
    }
    function send(value) {
        elements.get('assistant-input').value = value;
        elements.get('assistant-form').fire('submit', { preventDefault() {} });
    }
    return { root, elements, launcher, closeButton, submit, composer, header, starters, dialog, document, calls, payload, context, element,
        cta, send, geometry, deadlines, controller: context.NoFriesSharedAssistant.mount(root) };
}

const count = (h, suffix) => h.calls.filter(call => call.url.includes(suffix)).length;

test('mounting and ordinary page loads create no session, message or enquiry requests', async () => {
    for (const page of ['home', 'dashboard', 'managed-it', 'sales-agency', 'news', 'roadmap', 'luna']) {
        const h = harness({ page }); await settle();
        expect(h.calls).toHaveLength(0); expect(h.dialog.open).toBe(false);
        expect(h.elements.get('assistant-input').disabled).toBe(true);
        expect(h.context.NoFriesSharedAssistant.mount(h.root)).toBe(h.controller);
        expect(h.document.handlers.click).toHaveLength(1);
    }
});

test('an explicit open uses the same client once, without submitting any prompt or changing the transport origin', async () => {
    const h = harness(); h.launcher.fire('click'); await settle();
    expect(h.dialog.open).toBe(true); expect(h.launcher.attrs['aria-expanded']).toBe('true');
    expect(count(h, '/session')).toBe(1); expect(count(h, '/chat')).toBe(0);
    expect(h.calls[0].url).toBe('/api/prospect/session');
    expect(h.calls[0].options).toMatchObject({ method: 'GET', credentials: 'same-origin', headers: { Accept: 'application/json' } });
    expect(h.calls[0].options.signal).toBeInstanceOf(AbortSignal);
    expect(h.document.activeElement).toBe(h.elements.get('assistant-input'));
    h.send('  A public question  '); await settle();
    const chat = h.calls.find(call => call.url.endsWith('/chat'));
    expect(JSON.parse(chat.options.body)).toEqual({ message: 'A public question' });
    expect(chat.options.credentials).toBe('same-origin');
    expect(h.elements.get('assistant-messages').children.at(-1).children[1].textContent).toBe('Synthetic public reply');
});

test('a service CTA opens the same assistant with local fixed prompts and returns focus to that CTA', async () => {
    const h = harness(); const source = h.cta(); await settle();
    expect(h.dialog.open).toBe(true); expect(count(h, '/session')).toBe(1); expect(count(h, '/chat')).toBe(0);
    expect(h.starters.filter(button => !button.hidden).map(button => button.dataset.assistantStarterTopic)).toEqual(['home', 'managed-it']);
    h.closeButton.fire('click'); await settle();
    expect(h.document.activeElement).toBe(source); expect(h.launcher.attrs['aria-expanded']).toBe('false');
});

test('unrecognised CTA context cannot become a prompt, API parameter or private page context', async () => {
    const h = harness({ page: 'home' }); h.cta('private-org-id?token=secret'); await settle();
    expect(h.starters.filter(button => !button.hidden).map(button => button.dataset.assistantStarterTopic)).toEqual(['home']);
    expect(h.calls).toHaveLength(1); expect(JSON.stringify(h.calls)).not.toMatch(/private-org|secret|context/);
});

test('a later explicit service CTA restores fixed topic choices without submitting another message', async () => {
    const h = harness(); h.launcher.fire('click'); await settle();
    h.send('A public question'); await settle();
    expect(h.elements.get('assistant-prompts').hidden).toBe(true);
    h.controller.close(); await settle(); h.cta('managed-it'); await settle();
    expect(h.elements.get('assistant-prompts').hidden).toBe(false);
    expect(count(h, '/chat')).toBe(1);
});

test('a CTA while help is already open changes local topic and becomes the focus return target', async () => {
    const h = harness(); h.launcher.fire('click'); await settle();
    const source = h.cta('managed-it'); await settle();
    expect(h.starters.filter(button => !button.hidden).map(button => button.dataset.assistantStarterTopic)).toEqual(['home', 'managed-it']);
    h.closeButton.focus(); h.closeButton.fire('click'); await settle();
    expect(h.document.activeElement).toBe(source); expect(count(h, '/session')).toBe(1); expect(count(h, '/chat')).toBe(0);
});

test('dashboard help opts into a fixed public-only server route and does not restore discovery history', async () => {
    const h = harness({ page: 'dashboard' });
    h.payload.conversation.messages = [{ role: 'assistant', text: 'Previous discovery content' }];
    h.payload.organisation = { discovery: { missingFields: [] } };
    h.launcher.fire('click'); await settle(); h.send('How do saved results work?'); await settle();
    expect(h.calls[0].url).toBe('/api/prospect/session?publicHelpOnly=true');
    expect(h.elements.get('assistant-runtime').textContent).toBe('Public help preview');
    expect(JSON.parse(h.calls.find(call => call.url.endsWith('/chat')).options.body)).toEqual({ publicHelpMessage: 'How do saved results work?', publicHelpOnly: true });
    expect(h.elements.get('assistant-messages').children.some(node => node.children[1].textContent.includes('Previous discovery'))).toBe(false);
    expect(h.elements.get('assistant-progress').textContent).toBe('Public help · no account or assessment changes');
    // A later DOM change cannot promote this mounted client into service discovery.
    h.root.dataset.assistantHelpOnly = 'false'; h.send('Another public question'); await settle();
    expect(JSON.parse(h.calls.filter(call => call.url.endsWith('/chat')).at(-1).options.body).publicHelpOnly).toBe(true);
});

test.each(['missing', 'unversioned', 'unknown', 'wrong-mode'])('help-only %s bootstrap capability cannot enable input or send a discovery request', async capability => {
    const h = harness({ page: 'dashboard' });
    if (capability === 'missing') { delete h.payload.assistant.publicHelpOnly; delete h.payload.assistant.publicHelpProtocol; }
    if (capability === 'unversioned') delete h.payload.assistant.publicHelpProtocol;
    if (capability === 'unknown') h.payload.assistant.publicHelpProtocol = 'public-help-unknown';
    if (capability === 'wrong-mode') h.payload.assistant.publicHelpOnly = false;
    h.payload.conversation.messages = [{ role: 'assistant', text: 'OLD_DISCOVERY_CONTEXT' }];
    h.launcher.fire('click'); await settle();
    expect(h.elements.get('assistant-input').disabled).toBe(true);
    h.send('Do not enter discovery'); await settle();
    expect(count(h, '/chat')).toBe(0); expect(count(h, '/session')).toBe(1);
    expect(h.elements.get('assistant-messages').children.some(node => node.textContent.includes('OLD_DISCOVERY_CONTEXT'))).toBe(false);
    // Recovery needs another explicit open, never a loop or replay.
    h.payload.assistant.publicHelpOnly = true; h.payload.assistant.publicHelpProtocol = 'public-help-v1';
    await h.controller.open(); await settle();
    expect(h.elements.get('assistant-input').disabled).toBe(false); expect(count(h, '/session')).toBe(2); expect(count(h, '/chat')).toBe(0);
});

test('an initialized help-only client never downgrades or replays after a rollback-server rejection', async () => {
    const h = harness({ page: 'dashboard', chat: async () => ({ ok: false, status: 400,
        json: async () => ({ error: 'Provide a message.', code: 'message_required' }) }) });
    h.launcher.fire('click'); await settle(); h.send('What is the No Fries Dashboard?'); await settle();
    expect(count(h, '/session')).toBe(1); expect(count(h, '/chat')).toBe(1);
    const body = JSON.parse(h.calls.find(call => call.url.endsWith('/chat')).options.body);
    expect(body).toEqual({ publicHelpMessage: 'What is the No Fries Dashboard?', publicHelpOnly: true });
    expect(Object.prototype.hasOwnProperty.call(body, 'message')).toBe(false);
    expect(h.elements.get('assistant-messages').children.at(-1).children[1].textContent).toBe('The reply could not be completed. Retry last question when you are ready.');
    await settle(); expect(count(h, '/chat')).toBe(1);
});

test('concurrent opens share startup and never replay a message', async () => {
    let finish;
    const pending = new Promise(resolve => { finish = resolve; });
    const h = harness({ session: () => pending });
    h.controller.open(); h.controller.open(); h.cta();
    expect(count(h, '/session')).toBe(1);
    h.send('Do not send while starting'); expect(count(h, '/chat')).toBe(0);
    h.controller.close(); h.controller.open();
    finish({ ok: true, json: async () => h.payload }); await settle();
    expect(h.dialog.open).toBe(true); expect(h.launcher.attrs['aria-expanded']).toBe('true');
    expect(count(h, '/session')).toBe(1); expect(count(h, '/chat')).toBe(0);
});

test('failed startup retries only on another explicit open and cached disabled mode never retries itself', async () => {
    let attempt = 0;
    const h = harness({ session: async () => {
        if (++attempt === 1) throw new Error('Synthetic network failure');
        return { ok: true, json: async () => h.payload };
    } });
    h.launcher.fire('click'); await settle(); await settle();
    expect(count(h, '/session')).toBe(1); expect(h.elements.get('assistant-input').disabled).toBe(true);
    h.payload.assistant.runtime.mode = 'disabled'; h.controller.close(); await settle();
    h.launcher.fire('click'); await settle(); expect(count(h, '/session')).toBe(2);
    h.controller.close(); await settle(); h.launcher.fire('click'); await settle();
    expect(count(h, '/session')).toBe(2); expect(h.elements.get('assistant-input').disabled).toBe(true);
    expect(count(h, '/chat')).toBe(0);
});

for (const transition of ['closed', 'other control']) {
    test(`late readiness does not steal focus after ${transition}`, async () => {
        let finish;
        const pending = new Promise(resolve => { finish = resolve; });
        const h = harness({ session: () => pending }); h.launcher.fire('click');
        const other = h.element();
        if (transition === 'closed') { h.controller.close(); await settle(); }
        else other.focus();
        const expected = h.document.activeElement;
        finish({ ok: true, json: async () => h.payload }); await settle();
        expect(h.document.activeElement).toBe(expected); expect(count(h, '/chat')).toBe(0);
    });
}

test('Escape closes the non-modal dialog, returns focus and preserves an unsubmitted draft', async () => {
    const h = harness(); h.launcher.fire('click'); await settle();
    h.elements.get('assistant-input').value = 'Unsubmitted public draft';
    let prevented = false;
    h.dialog.fire('keydown', { key: 'Escape', preventDefault() { prevented = true; } }); await settle();
    expect(prevented).toBe(true); expect(h.dialog.open).toBe(false); expect(h.document.activeElement).toBe(h.launcher);
    h.launcher.fire('click'); await settle();
    expect(h.elements.get('assistant-input').value).toBe('Unsubmitted public draft');
    expect(count(h, '/session')).toBe(1); expect(count(h, '/chat')).toBe(0);
});

test('outside pointer dismissal preserves the page action focus and ignores drags out of the panel', async () => {
    const h = harness(); h.launcher.fire('click'); await settle(); const other = h.element();
    h.document.fire('pointerdown', { target: h.elements.get('assistant-input'), button: 0 });
    h.document.fire('click', { target: other, detail: 1 }); expect(h.dialog.open).toBe(true);
    h.document.fire('pointerdown', { target: other, button: 0 }); other.focus();
    h.document.fire('click', { target: other, detail: 1 }); await settle();
    expect(h.dialog.open).toBe(false); expect(h.document.activeElement).toBe(other);
});

test('a late reply cannot refocus a closed panel or steal a chosen page control', async () => {
    let finish;
    const pending = new Promise(resolve => { finish = resolve; });
    const h = harness({ chat: () => pending }); h.launcher.fire('click'); await settle();
    h.send('A public question'); h.controller.close(); await settle();
    const other = h.element(); other.focus();
    finish({ ok: true, text: async () => 'event: done\ndata: {"text":"Synthetic delayed reply"}\n\n' }); await settle();
    expect(h.document.activeElement).toBe(other); expect(h.dialog.open).toBe(false); expect(count(h, '/chat')).toBe(1);
});

test('link-only foreign-origin mode never mounts a client or makes API calls even when opened', async () => {
    const h = harness({ transport: 'link-only', page: 'luna' });
    h.launcher.fire('click'); await settle(); h.cta(); await settle();
    expect(h.dialog.open).toBe(true); expect(h.calls).toHaveLength(0);
    expect(h.elements.get('assistant-form').handlers.submit).toBeUndefined();
});

test('explicit numeric placement offsets support host controls without reading their DOM', () => {
    const h = harness(); h.controller.setPosition({ bottom: 72, right: 16 });
    expect(h.root.properties).toEqual({ '--nf-assistant-bottom-offset': '72px', '--nf-assistant-right-offset': '16px' });
    for (const value of [-1, Infinity, NaN, 401, '72', 'url(secret)']) {
        expect(() => h.controller.setPosition({ bottom: value })).toThrow('shared_assistant_position_invalid');
    }
});

test.each(['home', 'dashboard'])('%s reserves mounted, resized and removed dashboard taskbars without starting chat', page => {
    const h = harness({ page, layout: true });
    expect(h.root.properties['--nf-assistant-dashboard-bottom']).toBe('0px');
    let bounds = { width: 320, height: 65, top: 575 };
    const nav = { getBoundingClientRect: () => bounds };
    h.geometry.navigation = nav; h.geometry.mutation();
    expect(h.root.properties['--nf-assistant-dashboard-bottom']).toBe('65px');
    expect(h.geometry.observed.has(nav)).toBe(true);
    // Browser zoom/wrapping increases the actual reserved height.
    bounds = { width: 320, height: 121, top: 519 }; h.geometry.resize();
    expect(h.root.properties['--nf-assistant-dashboard-bottom']).toBe('121px');
    h.controller.setPosition({ bottom: 12, right: 8 });
    expect(h.root.properties['--nf-assistant-bottom-offset']).toBe('12px');
    expect(h.root.properties['--nf-assistant-dashboard-bottom']).toBe('121px');
    // The desktop breakpoint hides this same nav; sign-out removes it.
    bounds = { width: 0, height: 0, top: 0 }; h.geometry.windowResize();
    expect(h.root.properties['--nf-assistant-dashboard-bottom']).toBe('0px');
    h.geometry.navigation = null; h.geometry.mutation();
    expect(h.geometry.observed.size).toBe(0);
    expect(h.root.properties['--nf-assistant-dashboard-bottom']).toBe('0px');
    expect(h.calls).toHaveLength(0); expect(h.dialog.open).toBe(false);
});

test('foreign hosts and other public pages retain their explicit placement contract without inspecting dashboard layout', () => {
    for (const options of [{ page: 'luna', transport: 'link-only' }, { page: 'managed-it' }, { page: 'home', transport: 'link-only' }]) {
        const h = harness({ ...options, layout: true });
        expect(h.geometry.resize).toBeNull(); expect(h.geometry.mutation).toBeNull();
        expect(h.calls).toHaveLength(0);
    }
});

test('malformed or weakened dashboard mount configuration fails closed without creating a client', async () => {
    for (const options of [{ page: 'dashboard', helpOnly: false }, { transport: 'https://other.test/api' }]) {
        const h = harness(options); await settle();
        expect(h.controller).toBeNull(); h.launcher.fire('click');
        expect(h.calls).toHaveLength(0); expect(h.dialog.open).toBe(false);
    }
});

test('Enter submits once, while Shift+Enter and IME confirmation preserve composition', async () => {
    const h = harness({ page: 'home' }); h.launcher.fire('click'); await settle();
    const input = h.elements.get('assistant-input');
    input.value = 'A multiline\npublic question';
    for (const composition of [{ shiftKey: true }, { isComposing: true }, { keyCode: 229 }]) {
        input.fire('keydown', { key: 'Enter', ...composition, preventDefault() { throw new Error('Composition intercepted'); } });
    }
    expect(count(h, '/chat')).toBe(0);
    let prevented = false;
    input.fire('keydown', { key: 'Enter', preventDefault() { prevented = true; } }); await settle();
    expect(prevented).toBe(true); expect(count(h, '/chat')).toBe(1);
    expect(JSON.parse(h.calls.at(-1).options.body)).toEqual({ publicHelpMessage: 'A multiline\npublic question', publicHelpOnly: true });
});

test('the public composer keeps a new draft usable and never queues submissions during a reply', async () => {
    let finish;
    const h = harness({ page: 'dashboard', chat: () => new Promise(resolve => { finish = resolve; }) });
    h.launcher.fire('click'); await settle(); h.send('First question');
    const input = h.elements.get('assistant-input');
    expect(input.disabled).toBe(false); expect(h.submit.disabled).toBe(true);
    expect(h.starters.every(button => button.disabled)).toBe(true);
    h.send('Next drafted question');
    expect(count(h, '/chat')).toBe(1);
    finish({ ok: true, text: async () => 'event: done\ndata: {"text":"Completed first reply"}\n\n' }); await settle();
    expect(input.value).toBe('Next drafted question'); expect(h.submit.disabled).toBe(false);
    expect(count(h, '/chat')).toBe(1);
});

test('Stop aborts the request, ignores its late response and Retry requires a click without replacing a new draft', async () => {
    let finish, attempts = 0;
    const h = harness({ page: 'dashboard', chat: () => ++attempts === 1
        ? new Promise(resolve => { finish = resolve; })
        : { ok: true, text: async () => 'event: done\ndata: {"text":"Explicit retry reply"}\n\n' } });
    h.launcher.fire('click'); await settle(); h.send('Original question');
    h.elements.get('assistant-input').value = 'A new draft';
    h.elements.get('assistant-stop').fire('click'); await settle();
    expect(h.calls.at(-1).options.signal.aborted).toBe(true);
    expect(h.submit.disabled).toBe(false); expect(h.elements.get('assistant-retry').hidden).toBe(false);
    expect(h.elements.get('assistant-messages').textContent).toContain('Response stopped');
    finish({ ok: true, text: async () => 'event: done\ndata: {"text":"STALE REPLY"}\n\n' }); await settle();
    expect(h.elements.get('assistant-messages').textContent).not.toContain('STALE REPLY');
    expect(count(h, '/chat')).toBe(1);
    h.elements.get('assistant-retry').fire('click'); await settle();
    expect(count(h, '/chat')).toBe(2);
    expect(JSON.parse(h.calls.at(-1).options.body).publicHelpMessage).toBe('Original question');
    expect(h.elements.get('assistant-input').value).toBe('A new draft');
    expect(h.elements.get('assistant-messages').textContent).toContain('Explicit retry reply');
    expect(h.elements.get('assistant-retry').hidden).toBe(true);
});

test('Clear chat resets only the mounted view and an old request cannot repopulate or unlock a newer turn', async () => {
    const finishes = [];
    const h = harness({ page: 'home', chat: () => new Promise(resolve => finishes.push(resolve)) });
    h.launcher.fire('click'); await settle(); h.send('Cleared question');
    const firstSignal = h.calls.at(-1).options.signal;
    h.elements.get('assistant-input').value = 'Cleared draft';
    h.elements.get('assistant-reset').fire('click'); await settle();
    expect(firstSignal.aborted).toBe(true); expect(h.elements.get('assistant-input').value).toBe('');
    expect(h.elements.get('assistant-messages').textContent).not.toContain('Cleared question');
    expect(h.elements.get('assistant-messages').textContent).toContain('How can I help?');
    expect(h.elements.get('assistant-prompts').hidden).toBe(false);
    h.send('New question');
    finishes[0]({ ok: true, text: async () => 'event: done\ndata: {"text":"STALE RESET REPLY"}\n\n' }); await settle();
    expect(h.submit.disabled).toBe(true);
    expect(h.elements.get('assistant-messages').textContent).not.toContain('STALE RESET REPLY');
    finishes[1]({ ok: true, text: async () => 'event: done\ndata: {"text":"New reply"}\n\n' }); await settle();
    expect(h.submit.disabled).toBe(false); expect(h.elements.get('assistant-messages').textContent).toContain('New reply');
    expect(count(h, '/session')).toBe(1); expect(count(h, '/chat')).toBe(2);
});

test('cleared startup cannot cache an old result or invalidate a newer single-flight initialization', async () => {
    const finishes = [];
    const h = harness({ page: 'home', session: () => new Promise(resolve => finishes.push(resolve)) });
    h.launcher.fire('click');
    h.elements.get('assistant-reset').fire('click');
    h.elements.get('assistant-retry').fire('click');
    await settle();
    expect(count(h, '/session')).toBe(2);
    finishes[0]({ ok: true, json: async () => h.payload }); await settle();
    expect(h.elements.get('assistant-input').disabled).toBe(true);
    h.controller.open(); expect(count(h, '/session')).toBe(2);
    finishes[1]({ ok: true, json: async () => h.payload }); await settle();
    expect(h.elements.get('assistant-input').disabled).toBe(false);
    expect(count(h, '/chat')).toBe(0);
});

test('startup deadline bounds a stalled JSON body and only explicit Retry makes another GET', async () => {
    let finish;
    const h = harness({ page: 'home', session: async () => ({ ok: true,
        json: () => new Promise(resolve => { finish = resolve; }) }) });
    h.launcher.fire('click'); await settle();
    h.deadlines.find(timer => timer.delay === 15000 && !timer.cleared).fn(); await settle();
    expect(h.calls[0].options.signal.aborted).toBe(true);
    expect(h.elements.get('assistant-input').disabled).toBe(true);
    expect(h.elements.get('assistant-progress').textContent).toContain('timed out');
    expect(h.elements.get('assistant-retry').hidden).toBe(false); expect(count(h, '/session')).toBe(1);
    finish(h.payload); await settle(); expect(h.elements.get('assistant-input').disabled).toBe(true);
    h.elements.get('assistant-retry').fire('click'); expect(count(h, '/session')).toBe(2);
    h.elements.get('assistant-stop').fire('click'); await settle();
});

test('chat deadline bounds a stalled response body, aborts and preserves a separately typed draft', async () => {
    const h = harness({ page: 'home', chat: async () => ({ ok: true, text: () => new Promise(() => {}) }) });
    h.launcher.fire('click'); await settle(); h.send('Question that stalls'); await settle();
    h.elements.get('assistant-input').value = 'Draft for later';
    h.deadlines.find(timer => timer.delay === 45000 && !timer.cleared).fn(); await settle();
    expect(h.calls.at(-1).options.signal.aborted).toBe(true); expect(h.submit.disabled).toBe(false);
    expect(h.elements.get('assistant-input').value).toBe('Draft for later');
    expect(h.elements.get('assistant-messages').textContent).toContain('timed out');
    expect(count(h, '/chat')).toBe(1);
});

test.each([
    'event: delta\ndata: {"delta":"Incomplete partial answer"}\n\n',
    'event: done\ndata: not-json\n\n',
    'event: done\ndata: {"text":""}\n\n',
    'event: delta\ndata: {"delta":{"untrusted":"value"}}\n\n',
    'event: done\ndata: []\n\n',
    'event: error\ndata: {"error":"untrusted server detail"}\n\n',
    'event: unexpected\ndata: {}\n\n',
    'event: done\ndata: {"text":"premature"}\n\nevent: delta\ndata: {"delta":"after terminal"}\n\n',
    'x'.repeat(100001)
])('an invalid or incomplete SSE response exposes recovery without presenting partial content: case %#', async text => {
    const h = harness({ page: 'home', chat: async () => ({ ok: true, text: async () => text }) });
    h.launcher.fire('click'); await settle(); h.send('Public question'); await settle();
    expect(h.elements.get('assistant-messages').children.at(-1).textContent).toBe('No FriesThe reply could not be completed. Retry last question when you are ready.');
    expect(h.elements.get('assistant-retry').hidden).toBe(false); expect(h.submit.disabled).toBe(false);
    await settle(); expect(count(h, '/chat')).toBe(1);
});

test('done completes and cancels a streaming reader without waiting for connection EOF', async () => {
    let reads = 0, cancellations = 0;
    const h = harness({ page: 'home', chat: async () => ({ ok: true, body: { getReader: () => ({
        read: () => ++reads === 1 ? Promise.resolve({ done: false, value: new TextEncoder().encode('event: done\ndata: {"text":"Terminal reply"}\n\n') }) : new Promise(() => {}),
        cancel: () => { cancellations++; return Promise.resolve(); }
    }) } }) });
    h.launcher.fire('click'); await settle(); h.send('Public question'); await settle();
    expect(reads).toBe(1); expect(cancellations).toBe(1); expect(h.submit.disabled).toBe(false);
    expect(h.elements.get('assistant-messages').textContent).toContain('Terminal reply');
    expect(h.deadlines.filter(timer => !timer.cleared)).toHaveLength(0);
});

test('chunked UTF-8 and CRLF stream frames produce one complete answer', async () => {
    const bytes = new TextEncoder().encode('event: delta\r\ndata: {"delta":"Kia ora —"}\r\n\r\nevent: done\r\ndata: {"text":"Kia ora — public help"}\r\n\r\n');
    let offset = 0;
    const h = harness({ page: 'home', chat: async () => ({ ok: true, body: { getReader: () => ({
        read: async () => offset < bytes.length ? { done: false, value: bytes.slice(offset, ++offset) } : { done: true },
        cancel: async () => {}
    }) } }) });
    h.launcher.fire('click'); await settle(); h.send('Public question'); await settle();
    expect(h.elements.get('assistant-messages').textContent).toContain('Kia ora — public help');
    expect(h.elements.get('assistant-retry').hidden).toBe(true);
});

test('only exact verified destinations become anchors; queries, fragments, lookalikes and HTML remain text', async () => {
    const text = 'Use https://nofries.nz/login. Then https://nofries.nz/dashboard and https://nofries.nz/privacy.html\n' +
        'https://nofries.nz/login?token=secret https://nofries.nz/login#private https://nofries.nz/login/evil ' +
        'https://nofries.nz.evil.test/login https://nofries.nz@evil.test/ javascript:alert(1) <img src=x onerror=alert(1)> https://arbitrary.test/';
    const h = harness({ page: 'home', chat: async () => ({ ok: true,
        text: async () => 'event: done\ndata: ' + JSON.stringify({ text }) + '\n\n' }) });
    h.launcher.fire('click'); await settle(); h.send('Public question'); await settle();
    const paragraph = h.elements.get('assistant-messages').children.at(-1).children[1];
    expect(paragraph.textContent).toBe(text);
    const anchors = paragraph.children.filter(child => child.tagName === 'A');
    expect(anchors.map(anchor => anchor.attrs.href)).toEqual(['https://nofries.nz/login', 'https://nofries.nz/dashboard', 'https://nofries.nz/privacy.html']);
    expect(anchors.every(anchor => anchor.attrs.target === undefined)).toBe(true);
    expect(paragraph.children.filter(child => child.tagName && child.tagName !== 'A')).toHaveLength(0);
});

test('even ordinary public discovery never restores server history into the shared page view', async () => {
    const h = harness({ page: 'managed-it' });
    h.payload.conversation.messages = [{ role: 'assistant', text: 'OLD DISCOVERY CONTENT' }];
    h.launcher.fire('click'); await settle();
    expect(h.elements.get('assistant-messages').textContent).not.toContain('OLD DISCOVERY CONTENT');
});

test('the mounted view bounds old turns and never emits a persistence request on clear', async () => {
    const h = harness({ page: 'home' }); h.launcher.fire('click'); await settle();
    for (let i = 0; i < 22; i++) { h.send('Public question ' + i); await settle(); }
    expect(h.elements.get('assistant-messages').children).toHaveLength(40);
    expect(h.elements.get('assistant-messages').textContent).not.toContain('Public question 0No Fries');
    const before = h.calls.length;
    h.elements.get('assistant-reset').fire('click'); await settle();
    expect(h.elements.get('assistant-messages').children).toHaveLength(1);
    expect(h.calls).toHaveLength(before);
});


test('focusing the open input reveals the whole composer so Send stays visible on short screens', async () => {
    const h = harness({ page: 'dashboard' });
    h.elements.get('assistant-input').focus();
    expect(h.composer.scrolls).toHaveLength(0);
    h.launcher.fire('click'); await settle();
    expect(h.composer.scrolls).toEqual([{ block: 'nearest', inline: 'nearest', behavior: 'auto' }]);
    h.closeButton.focus();
    h.elements.get('assistant-input').focus();
    expect(h.composer.scrolls).toHaveLength(2);
    h.controller.close(); await settle();
    h.elements.get('assistant-input').focus();
    expect(h.composer.scrolls).toHaveLength(2);
});


test('composer clearance follows the rendered enlarged header before opening', async () => {
    const h = harness({ page: 'dashboard', layout: true });
    h.header.height = 97.2;
    h.launcher.fire('click'); await settle();
    expect(h.root.properties['--nf-assistant-header-height']).toBe('98px');
    expect(h.composer.scrolls).toHaveLength(1);
    expect(h.geometry.composerObserved).toEqual(new Set([h.header, h.dialog, h.composer]));
    // Native Tab from the textarea to Send reveals the whole composer again.
    h.submit.focus();
    expect(h.composer.scrolls).toHaveLength(2);
    expect(h.document.activeElement).toBe(h.submit);
});

test('header and viewport reflow keep the focused composer visible without moving focus', async () => {
    const h = harness({ page: 'dashboard', layout: true });
    h.launcher.fire('click'); await settle();
    const input = h.elements.get('assistant-input');
    h.header.height = 118;
    h.geometry.composerResize();
    expect(h.root.properties['--nf-assistant-header-height']).toBe('118px');
    expect(h.composer.scrolls).toHaveLength(2);
    expect(h.document.activeElement).toBe(input);
    h.submit.focus();
    h.header.height = 131;
    h.geometry.windowResize();
    expect(h.root.properties['--nf-assistant-header-height']).toBe('131px');
    expect(h.composer.scrolls).toHaveLength(4);
    expect(h.document.activeElement).toBe(h.submit);
});

test('resize never scrolls or focuses the composer when another control is active or the dialog is closed', async () => {
    const h = harness({ page: 'dashboard', layout: true });
    h.launcher.fire('click'); await settle();
    h.closeButton.focus();
    const countBefore = h.composer.scrolls.length;
    h.header.height = 101;
    h.geometry.composerResize(); h.geometry.windowResize();
    expect(h.root.properties['--nf-assistant-header-height']).toBe('101px');
    expect(h.composer.scrolls).toHaveLength(countBefore);
    expect(h.document.activeElement).toBe(h.closeButton);
    const other = h.element(); other.focus();
    h.geometry.composerResize(); h.geometry.windowResize();
    expect(h.composer.scrolls).toHaveLength(countBefore);
    expect(h.document.activeElement).toBe(other);
    h.closeButton.focus(); h.controller.close(); await settle();
    h.header.height = 0;
    h.geometry.composerResize(); h.geometry.windowResize();
    expect(h.root.properties['--nf-assistant-header-height']).toBe('101px');
    expect(h.composer.scrolls).toHaveLength(countBefore);
    expect(h.document.activeElement).toBe(h.launcher);
    expect(count(h, '/chat')).toBe(0);
});
