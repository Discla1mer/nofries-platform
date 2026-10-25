'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const test = typeof globalThis.test === 'function' ? globalThis.test : require('node:test');
const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'prospect-assistant.js'), 'utf8');

function node() {
    const handlers = {};
    return {
        disabled: false, hidden: false, value: '', textContent: '', className: '',
        dataset: {}, children: [], scrollTop: 0, scrollHeight: 0, handlers,
        classList: { add() {}, remove() {} },
        addEventListener(type, fn) { handlers[type] = fn; },
        append(...items) { this.children.push(...items); },
        replaceChildren(...items) { this.children = items; },
        focus() { this.focused = true; }
    };
}

function harness({ dashboard = true, session, chat, deferBlur = false } = {}) {
    const elements = new Map([
        'prospect-assistant', 'assistant-form', 'assistant-input', 'assistant-messages',
        'assistant-prompts', 'assistant-runtime', 'assistant-progress',
        'managed-it-per-user-price', 'managed-it-price-summary', 'managed-it-price-extras', 'discovery-dialog'
    ].map(id => [id, node()]));
    const submit = node();
    const starters = [node(), node(), node()];
    elements.get('assistant-form').querySelector = () => submit;
    elements.get('assistant-prompts').querySelectorAll = () => starters;
    const listeners = {};
    const calls = [];
    const payload = {
        assistant: { runtime: { mode: 'mock' }, pricing: {} },
        conversation: { messages: [] }, organisation: null
    };
    const document = {
        activeElement: node(),
        body: { dataset: dashboard ? { product: 'dashboard' } : {} },
        getElementById(id) { return elements.get(id) || null; },
        createElement() { return node(); },
        addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
        removeEventListener(type, fn) { listeners[type] = (listeners[type] || []).filter(listener => listener !== fn); }
    };
    const focus = target => {
        document.activeElement = target;
        for (const listener of listeners.focusin || []) listener({ target });
    };
    elements.get('discovery-dialog').open = true;
    elements.get('assistant-input').focus = function () { this.focused = true; focus(this); };
    elements.get('assistant-input').scrollIntoView = function () { this.scrolled = true; };
    for (const control of [elements.get('assistant-input'), submit, ...starters]) {
        let disabled = false;
        Object.defineProperty(control, 'disabled', {
            get() { return disabled; },
            set(value) {
                disabled = value;
                // Native blur leaves body active without focusing another control.
                if (disabled && document.activeElement === control) {
                    const blur = () => {
                        if (document.activeElement === control) document.activeElement = document.body;
                    };
                    if (deferBlur) queueMicrotask(blur);
                    else blur();
                }
            }
        });
    }
    const fetch = async (url, options) => {
        calls.push({ url, options });
        if (url === '/api/prospect/session') {
            return session ? session() : { ok: true, json: async () => payload };
        }
        if (url === '/api/prospect/chat') {
            return chat ? chat() : {
                ok: true,
                text: async () => 'event: done\ndata: {"text":"Synthetic reply","runtime":{"mode":"mock"}}\n\n'
            };
        }
        throw new Error('Unexpected request');
    };
    vm.runInNewContext(source, { document, fetch, TextDecoder, AbortController, setTimeout, clearTimeout });
    const click = id => (listeners.click || []).forEach(fn => fn({ target: {
        closest(selector) { return selector === '[data-dialog]' ? { dataset: { dialog: id } } : null; }
    } }));
    const start = () => elements.get('assistant-prompts').handlers.click({ target: {
        closest() { return { dataset: { message: 'Synthetic starter' } }; }
    } });
    const send = value => {
        elements.get('assistant-input').value = value;
        elements.get('assistant-form').handlers.submit({ preventDefault() {} });
    };
    return { elements, submit, starters, calls, click, start, send, payload, document, focus, listeners };
}

const settle = () => new Promise(resolve => setImmediate(resolve));
const count = (h, suffix) => h.calls.filter(call => call.url.endsWith(suffix)).length;

test('opening discovery focuses its input only after the service becomes ready', async () => {
    const h = harness(), input = h.elements.get('assistant-input');
    h.click('discovery-dialog');
    assert.equal(input.disabled, true); assert.equal(input.focused, undefined);
    await settle();
    assert.equal(input.disabled, false); assert.equal(h.document.activeElement, input);
    assert.equal(input.scrolled, true); assert.equal(count(h, '/chat'), 0);
});

for (const reason of ['closed', 'moved', 'disabled', 'pricing']) {
    test(`service readiness does not steal focus when ${reason}`, async () => {
        const h = harness();
        if (reason === 'disabled') h.payload.assistant.runtime.mode = 'disabled';
        h.click(reason === 'pricing' ? 'pricing-dialog' : 'discovery-dialog');
        if (reason === 'closed') h.elements.get('discovery-dialog').open = false;
        if (reason === 'moved') h.document.activeElement = node();
        const expected = h.document.activeElement;
        await settle();
        assert.equal(h.document.activeElement, expected);
        assert.equal(h.elements.get('assistant-input').focused, undefined);
        assert.equal(count(h, '/chat'), 0);
    });
}

test('opening discovery after cached pricing readiness focuses without another request', async () => {
    const h = harness(); h.click('pricing-dialog'); await settle();
    h.click('discovery-dialog'); await settle();
    assert.equal(h.document.activeElement, h.elements.get('assistant-input'));
    assert.equal(count(h, '/session'), 1);
});

function assertDisabled(h, disabled) {
    assert.equal(h.elements.get('assistant-input').disabled, disabled);
    assert.equal(h.submit.disabled, disabled);
    assert.ok(h.starters.every(button => button.disabled === disabled));
}

test('dashboard-only visits do not initialise the optional managed-service session', async () => {
    const h = harness();
    await settle();
    assert.equal(h.calls.length, 0);
    assertDisabled(h, true);
    for (const id of ['dashboard-access-dialog', 'dashboard-product-dialog', 'service-dialog']) h.click(id);
    await settle();
    assert.equal(h.calls.length, 0);
});

test('opening discovery initialises once with the unchanged same-origin request contract', async () => {
    const h = harness();
    h.click('discovery-dialog');
    await settle();
    assert.equal(count(h, '/session'), 1);
    assert.equal(h.calls[0].options.method, 'GET');
    assert.equal(h.calls[0].options.credentials, 'same-origin');
    assert.equal(h.calls[0].options.headers.Accept, 'application/json');
    assertDisabled(h, false);
});

test('opening pricing loads server-owned pricing without opening chat or submitting a message', async () => {
    const h = harness();
    h.payload.assistant.pricing = { perUserMonthly: 7, onboardingFrom: 11, gstExclusive: true, policyId: 'synthetic-policy' };
    h.click('pricing-dialog');
    await settle();
    assert.equal(count(h, '/session'), 1);
    assert.equal(count(h, '/chat'), 0);
    assert.equal(h.elements.get('managed-it-per-user-price').dataset.policyId, 'synthetic-policy');
    assert.equal(h.elements.get('managed-it-per-user-price').textContent, 'NZ$7 + GST');
});

test('concurrent and repeated dialog openings do not create repeated initialisation requests', async () => {
    let finish;
    const pending = new Promise(resolve => { finish = resolve; });
    const h = harness({ session: () => pending });
    h.click('discovery-dialog');h.click('pricing-dialog');h.click('discovery-dialog');
    assert.equal(count(h, '/session'), 1);
    assertDisabled(h, true);
    finish({ ok: true, json: async () => h.payload });
    await settle();
    h.click('pricing-dialog');h.click('discovery-dialog');
    await settle();
    assert.equal(count(h, '/session'), 1);
    assertDisabled(h, false);
});

test('form and starter events cannot submit before session initialisation', async () => {
    const h = harness();
    h.start();h.send('Synthetic message');
    await settle();
    assert.equal(count(h, '/chat'), 0);
    assert.equal(count(h, '/session'), 0);
});

test('a failed initialisation leaves inputs and starters unavailable and sends nothing', async () => {
    const h = harness({ session: async () => { throw new Error('Synthetic failure'); } });
    h.click('discovery-dialog');await settle();
    assertDisabled(h, true);
    assert.equal(h.elements.get('assistant-runtime').textContent, 'Unavailable');
    h.start();h.send('Synthetic message');h.click('pricing-dialog');await settle();
    assert.equal(count(h, '/chat'), 0);
    // The explicit pricing opening retries once; failure never enables sending.
    assert.equal(count(h, '/session'), 2);
    assertDisabled(h, true);
});

test('a server-disabled service never enables starters or accepts form submissions', async () => {
    const h = harness();h.payload.assistant.runtime.mode = 'disabled';
    h.click('discovery-dialog');await settle();
    assertDisabled(h, true);h.start();h.send('Synthetic message');await settle();
    assert.equal(count(h, '/chat'), 0);
});

test('legacy managed-service pages still initialise immediately', async () => {
    const h = harness({ dashboard: false });await settle();
    assert.equal(count(h, '/session'), 1);assertDisabled(h, false);
});

test('authorised ready chat still submits the existing JSON contract and renders its response', async () => {
    const h = harness();h.click('discovery-dialog');await settle();
    h.send('  Synthetic message  ');await settle();
    assert.equal(count(h, '/chat'), 1);
    const request = h.calls.find(call => call.url.endsWith('/chat'));
    assert.equal(request.options.method, 'POST');
    assert.equal(request.options.credentials, 'same-origin');
    assert.deepEqual(JSON.parse(request.options.body), { message: 'Synthetic message' });
    const nodes = h.elements.get('assistant-messages').children;
    assert.equal(nodes[nodes.length - 1].children[1].textContent, 'Synthetic reply');
    assertDisabled(h, false);
});

test('busy submissions remain single-flight after deferred initialisation', async () => {
    let finish;
    const pending = new Promise(resolve => { finish = resolve; });
    const h = harness({ chat: () => pending });h.click('discovery-dialog');await settle();
    h.send('Synthetic message');h.start();h.send('Another synthetic message');
    assert.equal(count(h, '/chat'), 1);assertDisabled(h, true);
    finish({ ok: true, text: async () => 'event: done\ndata: {"text":"Synthetic reply"}\n\n' });
    await settle();assertDisabled(h, false);
});

function pendingReply(options) {
    let finish, fail;
    const pending = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
    const h = harness({ ...options, chat: () => pending });
    return { ...h, finish, fail };
}

const successfulReply = () => ({ ok: true,
    text: async () => 'event: done\ndata: {"text":"Synthetic reply"}\n\n' });

for (const entry of ['message', 'starter', 'legacy', 'delayed blur']) {
    test(`${entry} reply restores the input when focus has not moved`, async () => {
        const h = pendingReply({ dashboard: entry !== 'legacy', deferBlur: entry === 'delayed blur' });
        if (entry === 'legacy') h.elements.delete('discovery-dialog');
        else h.click('discovery-dialog');
        await settle();
        const input = h.elements.get('assistant-input');
        if (entry === 'starter') {
            h.focus(h.starters[0]);
            h.start();
        } else {
            input.focus();
            h.send('Synthetic message');
        }
        await settle();
        assert.equal(h.document.activeElement, h.document.body);
        assertDisabled(h, true);
        h.finish(successfulReply());await settle();
        assert.equal(h.document.activeElement, input);
        assertDisabled(h, false);
        assert.equal(count(h, '/chat'), 1);
        assert.equal(h.listeners.focusin.length, 0);
    });
}

for (const outcome of ['success', 'rate limit', 'network failure']) {
    test(`${outcome} reply preserves focus chosen while the response is pending`, async () => {
        const h = pendingReply();h.click('discovery-dialog');await settle();
        h.send('Synthetic message');
        const privacyLink = node();
        h.focus(privacyLink);
        if (outcome === 'network failure') h.fail(new Error('Synthetic network failure'));
        else if (outcome === 'rate limit') h.finish({ ok: false, status: 429,
            json: async () => ({ error: 'Synthetic rate limit' }) });
        else h.finish(successfulReply());
        await settle();
        assert.equal(h.document.activeElement, privacyLink);
        assertDisabled(h, false);
        assert.equal(h.elements.get('assistant-input').value, outcome === 'rate limit' ? 'Synthetic message' : '');
        const messages = h.elements.get('assistant-messages').children;
        const expected = outcome === 'success' ? 'Synthetic reply' : outcome === 'rate limit'
            ? 'Synthetic rate limit Your message is still in the box.' : 'Synthetic network failure';
        assert.equal(messages[messages.length - 1].children[1].textContent, expected);
        assert.equal(count(h, '/chat'), 1);
        assert.equal(h.listeners.focusin.length, 0);
    });
}

test('a reply cannot focus the input after its discovery dialog closes', async () => {
    const h = pendingReply();h.click('discovery-dialog');await settle();
    h.send('Synthetic message');
    h.elements.get('discovery-dialog').open = false;
    const expected = h.document.activeElement;
    h.finish(successfulReply());await settle();
    assert.equal(h.document.activeElement, expected);
    assertDisabled(h, false);
    assert.equal(count(h, '/chat'), 1);
});

test('closing and reopening during a reply preserves the newly focused control without replay', async () => {
    const h = pendingReply();h.click('discovery-dialog');await settle();
    h.send('Synthetic message');
    h.elements.get('discovery-dialog').open = false;
    h.focus(node()); // Native close restores the page opener.
    h.elements.get('discovery-dialog').open = true;
    const closeButton = node();
    h.focus(closeButton);
    h.click('discovery-dialog');await settle();
    assertDisabled(h, true);
    assert.equal(h.document.activeElement, closeButton);
    h.finish(successfulReply());await settle();
    assert.equal(h.document.activeElement, closeButton);
    assertDisabled(h, false);
    assert.equal(count(h, '/session'), 1);
    assert.equal(count(h, '/chat'), 1);
});

test('a later explicit service opening recovers from a failed startup without replaying a message', async () => {
    let attempt = 0;
    const h = harness({ session: async () => {
        if (++attempt === 1) throw new Error('Synthetic network failure');
        return { ok: true, json: async () => h.payload };
    } });
    h.click('discovery-dialog');await settle();
    assertDisabled(h, true);h.send('Do not replay this message');
    assert.equal(count(h, '/chat'), 0);
    h.click('pricing-dialog');await settle();
    assert.equal(count(h, '/session'), 2);assertDisabled(h, false);
    assert.equal(count(h, '/chat'), 0);
    assert.equal(h.elements.get('assistant-input').value, 'Do not replay this message');
    assert.equal(h.elements.get('assistant-runtime').textContent, 'Preview');
    assert.equal(h.elements.get('assistant-progress').textContent, 'Indicative pricing · no commitment');
    h.send('A new explicit message');await settle();
    assert.equal(count(h, '/chat'), 1);
    assert.deepEqual(JSON.parse(h.calls.find(call => call.url.endsWith('/chat')).options.body),
        { message: 'A new explicit message' });
});

test('failed startup does not retry by itself or when only product and account information is opened', async () => {
    const h = harness({ session: async () => { throw new Error('Synthetic network failure'); } });
    h.click('discovery-dialog');await settle();await settle();
    h.click('dashboard-access-dialog');h.click('dashboard-product-dialog');h.click('service-dialog');
    h.start();h.send('Do not send');await settle();
    assert.equal(count(h, '/session'), 1);assert.equal(count(h, '/chat'), 0);
    assertDisabled(h, true);
});

test('a manual retry is single-flight and successful recovery is cached', async () => {
    let attempt = 0, finish;
    const pending = new Promise(resolve => { finish = resolve; });
    const h = harness({ session: async () => {
        if (++attempt === 1) throw new Error('Synthetic failure');
        return pending;
    } });
    h.click('discovery-dialog');await settle();
    h.click('pricing-dialog');h.click('discovery-dialog');h.click('pricing-dialog');
    assert.equal(count(h, '/session'), 2);assertDisabled(h, true);
    h.start();h.send('Do not send while retrying');assert.equal(count(h, '/chat'), 0);
    finish({ ok: true, json: async () => h.payload });await settle();
    h.click('discovery-dialog');h.click('pricing-dialog');await settle();
    assert.equal(count(h, '/session'), 2);assertDisabled(h, false);
});

test('a failed HTTP response can recover through an explicit retry using server-owned pricing', async () => {
    let attempt = 0;
    const h = harness({ session: async () => ++attempt === 1
        ? { ok: false, status: 503, json: async () => ({ error: 'Synthetic outage' }) }
        : { ok: true, json: async () => h.payload } });
    h.payload.assistant.pricing = { perUserMonthly: 7, onboardingFrom: 11,
        gstExclusive: true, policyId: 'synthetic-recovery-policy' };
    h.click('pricing-dialog');await settle();assertDisabled(h, true);
    h.click('pricing-dialog');await settle();
    assert.equal(count(h, '/session'), 2);assertDisabled(h, false);
    assert.equal(h.elements.get('managed-it-per-user-price').dataset.policyId, 'synthetic-recovery-policy');
    assert.equal(h.elements.get('managed-it-per-user-price').textContent, 'NZ$7 + GST');
    assert.ok(h.calls.every(call => call.options.method === 'GET' && call.options.credentials === 'same-origin'));
});

test('a malformed successful response cannot enable chat but a later valid response can recover', async () => {
    let attempt = 0;
    const h = harness({ session: async () => ({ ok: true,
        json: async () => ++attempt === 1 ? {} : h.payload }) });
    h.click('discovery-dialog');await settle();assertDisabled(h, true);
    h.start();assert.equal(count(h, '/chat'), 0);
    h.click('discovery-dialog');await settle();
    assert.equal(count(h, '/session'), 2);assertDisabled(h, false);
});

test('explicit server-disabled status is cached rather than treated as a transport failure', async () => {
    const h = harness();h.payload.assistant.runtime.mode = 'disabled';
    h.click('discovery-dialog');await settle();
    h.click('pricing-dialog');h.click('discovery-dialog');await settle();
    assert.equal(count(h, '/session'), 1);assertDisabled(h, true);
    h.start();h.send('Do not send');await settle();assert.equal(count(h, '/chat'), 0);
});

test('a recovered disabled response remains unavailable and does not keep retrying', async () => {
    let attempt = 0;
    const h = harness({ session: async () => {
        if (++attempt === 1) throw new Error('Synthetic failure');
        return { ok: true, json: async () => h.payload };
    } });
    h.payload.assistant.runtime.mode = 'disabled';
    h.click('discovery-dialog');await settle();
    h.click('pricing-dialog');await settle();
    h.click('discovery-dialog');await settle();
    assert.equal(count(h, '/session'), 2);assertDisabled(h, true);
    h.start();assert.equal(count(h, '/chat'), 0);
});
