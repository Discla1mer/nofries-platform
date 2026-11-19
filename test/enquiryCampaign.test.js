'use strict';

// The landing page keeps only the ad campaign labels in sessionStorage until
// the visitor sends the contact form (privacy notice: "Website enquiries").
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../js/enquiry-availability.js'), 'utf8');

function land(search, stored = null, { blocked = false } = {}) {
    const store = new Map(stored === null ? [] : [['nofries-enquiry-campaign', stored]]);
    const sessionStorage = {
        getItem: key => { if (blocked) throw new Error('blocked'); return store.has(key) ? store.get(key) : null; },
        setItem: (key, value) => { if (blocked) throw new Error('blocked'); store.set(key, String(value)); },
        removeItem: key => { if (blocked) throw new Error('blocked'); store.delete(key); }
    };
    const window = { location: { search }, sessionStorage };
    vm.runInNewContext(source, { window, URLSearchParams, AbortController, setTimeout, clearTimeout, fetch: () => {} });
    return { tag: window.enquiryCampaign(), store, window };
}

test.each([
    ['?utm_source=Meta&utm_medium=paid&utm_campaign=nov-launch', 'meta/paid/nov-launch'],
    ['?utm_source=facebook', 'facebook//'],
    ['?fbclid=IwAR0abcdef', 'meta//'],
    ['?utm_source=google&fbclid=IwAR0abcdef', 'google//']
])('keeps campaign labels from %s', (search, tag) => {
    expect(land(search).tag).toBe(tag);
});

test('never stores the click ID itself', () => {
    const { store } = land('?fbclid=IwAR0secretvalue');
    expect([...store.values()].join('')).not.toContain('IwAR0');
});

test.each(['', '?utm_campaign=only-campaign', '?utm_source=<script>', '?utm_source=' + 'x'.repeat(41)])(
    'stores nothing for %p', (search) => {
        expect(land(search).tag).toBe('');
    });

test('keeps the first campaign in the tab instead of overwriting it', () => {
    expect(land('?utm_source=linkedin', 'meta/paid/nov-launch').tag).toBe('meta/paid/nov-launch');
});

test('login captures before the deferred setup script can navigate to signup', () => {
    const login = fs.readFileSync(path.join(__dirname, '../login.html'), 'utf8');
    expect(login.match(/<script src="[^"]+" defer><\/script>/g)).toEqual([
        '<script src="/js/enquiry-availability.js" defer></script>',
        '<script src="/js/organisation-setup.js" defer></script>'
    ]);
});

test('blocked storage gives no tag and does not throw', () => {
    expect(land('?utm_source=meta', null, { blocked: true }).tag).toBe('');
});

test('a confirmed send clears the tag, so a later campaign link can set a new one', () => {
    const { window, store } = land('?utm_source=meta&utm_medium=paid&utm_campaign=a');
    window.clearEnquiryCampaign();
    expect(store.size).toBe(0);
    expect(window.enquiryCampaign()).toBe('');
});

test('the contact form clears the tag only after a confirmed send', () => {
    const contact = fs.readFileSync(path.join(__dirname, '../js/contact.js'), 'utf8');
    const confirmed = contact.indexOf("payload.received !== true");
    const cleared = contact.indexOf('window.clearEnquiryCampaign()');
    expect(confirmed).toBeGreaterThan(0);
    expect(cleared).toBeGreaterThan(confirmed);
    expect(contact.indexOf('form.reset();')).toBeLessThan(cleared);
});

// A dashboard service card links to the contact form as ?service=<key>.
const registry = require('../api/shared/protectedAssets/dashboardRegistry');

test('the service topic list matches the dashboard service registry', () => {
    registry.services.forEach(service => {
        expect(land('?service=' + service.key).window.enquiryTopic()).toBe(service.label);
    });
});

test('the 90-day managed security offer has a fixed topic', () => {
    expect(land('?service=managed_security_90').window.enquiryTopic()).toBe('90-day managed security');
});

test.each([
    ['?service=not_a_service'],
    ['?service=%3Cscript%3Ealert(1)%3C%2Fscript%3E'],
    ['?service=__proto__'],
    ['?service=constructor'],
    ['']
])('an unknown service key %s gives no topic', search => {
    expect(land(search).window.enquiryTopic()).toBe('');
});

test('the contact form only prefills an empty message with the fixed service label', () => {
    const contact = fs.readFileSync(path.join(__dirname, '../js/contact.js'), 'utf8');
    expect(contact).toContain('window.enquiryTopic()');
    expect(contact).toContain('!messageField.value');
    expect(contact).not.toMatch(/location\.search|URLSearchParams/);
});
