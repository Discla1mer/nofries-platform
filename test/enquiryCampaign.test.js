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
        setItem: (key, value) => { if (blocked) throw new Error('blocked'); store.set(key, String(value)); }
    };
    const window = { location: { search }, sessionStorage };
    vm.runInNewContext(source, { window, URLSearchParams, AbortController, setTimeout, clearTimeout, fetch: () => {} });
    return { tag: window.enquiryCampaign(), store };
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

test('blocked storage gives no tag and does not throw', () => {
    expect(land('?utm_source=meta', null, { blocked: true }).tag).toBe('');
});
