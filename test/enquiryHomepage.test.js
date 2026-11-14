'use strict';
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const script = fs.readFileSync(path.join(__dirname, '../js/enquiry-home.js'), 'utf8');
const availabilityScript = fs.readFileSync(path.join(__dirname, '../js/enquiry-availability.js'), 'utf8');

function browser(availability) {
    const link = {
        href: '/login?intent=create', firstChild: { nodeType: 3, nodeValue: 'Create account ' },
        getAttribute(name) { return this[name]; },
        setAttribute(name, value) { this[name] = value; }
    };
    const enquiry = { hidden: true };
    const document = { body: { dataset: { page: 'dashboard-home' } }, getElementById: id => id === 'homepagePrimary' ? link : id === 'homepageEnquiry' ? enquiry : null };
    const context = { document, window: { enquiryAvailability: availability }, AbortController, setTimeout, clearTimeout };
    return { link, enquiry, context, run: () => vm.runInNewContext(script, context) };
}
function expectSignup(page) {
    expect(page.link.href).toBe('/login?intent=create');
    expect(page.link.firstChild.nodeValue).toBe('Create account ');
}

test('static and no-JavaScript entry preserve signup, login and the arrow', () => {
    expect(html).toMatch(/id="homepagePrimary"[^>]*href="\/login\?intent=create">Create account <span aria-hidden="true">→<\/span>/);
    expect(html).toContain('class="homepage-login" href="/login?intent=login"');
    expect(html).not.toContain('>Get early access');
    expect(html.indexOf('/js/enquiry-availability.js')).toBeLessThan(html.indexOf('/js/enquiry-home.js'));
    expect(require('../lib/publicAssets').PUBLIC_SCRIPT_FILES).toEqual(expect.arrayContaining(['enquiry-availability.js', 'enquiry-home.js']));
});

test.each([
    { available: false, promote: false }, { available: true, promote: false },
    { available: false, promote: true }, { available: true, promote: 'true' }, null
])('keeps signup unless configuration and delivery verification both pass (%#)', async status => {
    const page = browser(async () => status);
    await page.run();
    expectSignup(page);
});

test.each(['missing', 'rejected'])('keeps signup when the availability check is %s', async mode => {
    const page = browser(mode === 'missing' ? undefined : async () => { throw Error('unavailable'); });
    await page.run();
    expectSignup(page);
});

test('promotes only after the read finishes with explicit success', async () => {
    let resolve;
    const page = browser(() => new Promise(r => { resolve = r; }));
    const result = page.run();
    expectSignup(page);
    resolve({ available: true, promote: true });
    await result;
    expectSignup(page);
    expect(page.enquiry.hidden).toBe(false);
});

test('a stalled real availability client times out and late success cannot switch the CTA', async () => {
    jest.useFakeTimers();
    try {
        const page = browser();
        let resolve;
        page.context.fetch = jest.fn(() => new Promise(r => { resolve = r; }));
        vm.runInNewContext(availabilityScript, page.context);
        const result = page.run();
        await jest.advanceTimersByTimeAsync(5000);
        await result;
        expectSignup(page);
        resolve(Response.json({ available: true, promote: true }));
        await jest.advanceTimersByTimeAsync(0);
        expectSignup(page);
        expect(jest.getTimerCount()).toBe(0);
    } finally { jest.useRealTimers(); }
});

test('does not overwrite another entry destination or run on unrelated pages', async () => {
    const availability = jest.fn(async () => ({ available: true, promote: true }));
    const page = browser(availability);
    page.context.document.body.dataset.page = 'contact';
    page.link.href = '/another-entry';
    await page.run();
    expect(page.link.href).toBe('/another-entry');
    page.context.document.body.dataset.page = 'contact';
    await page.run();
    expect(availability).not.toHaveBeenCalled();
});
