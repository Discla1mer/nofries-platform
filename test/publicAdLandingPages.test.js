'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { PUBLIC_ROOT_FILES, PUBLIC_SCRIPT_FILES } = require('../lib/publicAssets');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const pages = ['insurance.html', 'supplier-questionnaire.html', 'board.html', 'invoice-scams.html'];
const config = JSON.parse(read('staticwebapp.config.json'));
const visible = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test.each(pages)('%s gives the free check before the paid offer, without assurance promises', name => {
    const html = read(name), text = visible(html);
    expect(html).toContain('<html lang="en-NZ">');
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1.0">');
    expect(html).toContain(`<link rel="canonical" href="https://nofries.nz/${name}">`);
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html.match(/<section\b/g)).toHaveLength(2);
    expect(html.match(/<li>/g).length).toBeGreaterThanOrEqual(3);
    expect(html.match(/<li>/g).length).toBeLessThanOrEqual(4);
    expect(text).toMatch(/15 minutes.*free check.*top five gaps, ranked by how much each question counts.*summary for your board or insurer.*Results reflect your answers/);
    expect(html).toContain('href="/login?intent=create">Create a free account</a>');
    expect(text).toContain('See pricing and what’s included');
    expect(html).toContain('href="/pricing#pricing-pilot"');
    expect(html.indexOf('/login?intent=create')).toBeLessThan(html.indexOf('id="managed-title"'));
    expect(text).not.toMatch(/NCSC[- ]approved|certif(?:ied|ication)|guarantee|insur(?:er|ance) acceptance|\bpass(?:ing)?\b|24\/7/i);
    expect(html).not.toMatch(/\son\w+=|\sstyle=|<iframe|<form|facebook|pixel|analytics/i);
    expect([...html.matchAll(/<script\b[^>]*src="([^"]+)"[^>]*><\/script>/g)].map(match => match[1])).toEqual(['/js/home.js']);
    expect(html.match(/<script\b/g)).toHaveLength(1);
});

test.each(pages)('%s links only to public files, valid fragments or existing anonymous routes', name => {
    const html = read(name);
    expect(PUBLIC_ROOT_FILES).toContain(name);
    for (const [, attribute, href] of html.matchAll(/\b(href|src)="([^"]+)"/g)) {
        if (href.startsWith('#')) { expect(html).toContain(`id="${href.slice(1)}"`); continue; }
        const url = new URL(href, 'https://nofries.nz');
        // Primary-source figures link to the NCSC publication and open without passing the page.
        if (url.origin === 'https://www.ncsc.govt.nz') { expect(html).toContain(`href="${href}" rel="noopener"`); continue; }
        expect(url.origin).toBe('https://nofries.nz');
        const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        const rule = config.routes.find(entry => entry.route === url.pathname);
        if (rule) expect(rule.allowedRoles || ['anonymous']).toEqual(['anonymous']);
        const target = rule?.rewrite?.slice(1) || file;
        expect([name, attribute, href, fs.existsSync(path.join(root, target))]).toEqual([name, attribute, href, true]);
        expect(PUBLIC_ROOT_FILES.includes(target) || target.startsWith('images/') ||
            target.startsWith('js/') && PUBLIC_SCRIPT_FILES.includes(target.slice(3))).toBe(true);
    }
});

test('the sitemap contains every landing and only indexable public pages', () => {
    const locations = [...read('sitemap.xml').matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1]);
    expect(new Set(locations).size).toBe(locations.length);
    expect(locations).toEqual(expect.arrayContaining(pages.map(name => 'https://nofries.nz/' + name)));
    for (const location of locations) {
        const url = new URL(location), name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        expect(url.origin).toBe('https://nofries.nz');
        expect(url.search + url.hash).toBe('');
        expect(PUBLIC_ROOT_FILES).toContain(name === 'pricing' ? 'pricing.html' : name);
        expect(read(name === 'pricing' ? 'pricing.html' : name)).not.toMatch(/<meta[^>]+content="noindex/);
        expect(config.routes.find(rule => rule.route === url.pathname)?.headers?.['X-Robots-Tag'] || '').not.toMatch(/noindex|none/);
    }
    expect(PUBLIC_ROOT_FILES).toContain('sitemap.xml');
    expect(read('robots.txt')).toContain('Sitemap: https://nofries.nz/sitemap.xml');
});

function forwarded(search, page = 'ad-landing', hrefs = ['/login?intent=create', '/contact.html?service=managed_security_90#message', '/pricing.html?utm_source=old', '//elsewhere.example/path']) {
    const links = hrefs.map(href => ({ href, getAttribute() { return this.href; }, setAttribute(_name, value) { this.href = value; } }));
    const document = { body: { dataset: { page } }, addEventListener() {}, querySelectorAll: selector => selector === 'a[href^="/"]' ? links : [] };
    const location = new URL('https://nofries.nz/insurance.html' + search);
    // No storage or networking APIs supplied: the shared script must need neither.
    vm.runInNewContext(read('js/home.js'), { document, window: { location }, URL, URLSearchParams });
    return links.map(link => link.href);
}

test('UTMs survive every internal link without replacing intent, service or fragments or forwarding click IDs', () => {
    const query = '?utm_source=meta&utm_medium=paid_social&utm_campaign=insurance_NZ&utm_term=board%20%26%20team&utm_content=%3Cimg%3E&utm_id=7&utm_id=8&fbclid=private&gclid=private&intent=login&service=other';
    const links = forwarded(query), expected = [...new URLSearchParams(query)].filter(([key]) => key.startsWith('utm_'));
    for (const href of links.slice(0, 3)) {
        const url = new URL(href, 'https://nofries.nz');
        expect([...url.searchParams].filter(([key]) => key.startsWith('utm_'))).toEqual(expected);
        for (const key of ['fbclid', 'gclid']) expect(url.searchParams.has(key)).toBe(false);
    }
    expect(new URL(links[0], 'https://nofries.nz').searchParams.get('intent')).toBe('create');
    expect(new URL(links[1], 'https://nofries.nz').searchParams.get('service')).toBe('managed_security_90');
    expect(links[1]).toMatch(/#message$/);
    expect(links[3]).toBe('//elsewhere.example/path');
});

test('an untagged landing and other public pages keep their original URLs', () => {
    expect(forwarded('')).toEqual(forwarded('?fbclid=ignored'));
    expect(forwarded('?utm_source=meta', 'dashboard-pricing')).toEqual(forwarded(''));
});


test('the campaign hop keeps the validated same-tab tag through the anchored Contact CTA', () => {
    const ad = read('insurance.html').match(/class="ad-contact" href="([^"]+)"/)[1];
    const [pricing] = forwarded('?utm_source=Meta&utm_medium=paid&utm_campaign=Cover-2026&utm_term=other&fbclid=private', 'ad-landing', [ad]);
    const pricingUrl = new URL(pricing, 'https://nofries.nz');
    expect(pricingUrl.pathname + pricingUrl.hash).toBe('/pricing#pricing-pilot');
    const pilotArticle = read('pricing.html').match(/<section aria-labelledby="pricing-pilot"[\s\S]*?<\/section>/)[0];
    const href = pilotArticle.match(/id="pricing-pilot-enquiry" href="([^"]+)"/)[1];
    const stored = new Map();
    const sessionStorage = { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value) };
    vm.runInNewContext(read('js/enquiry-availability.js'), {
        window: { location: pricingUrl, sessionStorage }, URLSearchParams
    });
    const contact = new URL(href, 'https://nofries.nz');
    expect(contact.pathname).toBe('/contact.html');
    expect(Object.fromEntries(contact.searchParams)).toEqual({ service: 'managed_security_90' });
    const window = { location: contact, sessionStorage };
    vm.runInNewContext(read('js/enquiry-availability.js'), {
        window, document: { currentScript: { dataset: { enquiryForm: 'true' } } }, URLSearchParams
    });
    expect(window.enquiryTopic()).toBe('90-day managed security');
    expect(window.enquiryCampaign()).toBe('meta/paid/cover-2026');
});

test('short scam addresses redirect to the invoice-scam page (#697)', () => {
    for (const route of ['/scams', '/scam', '/scams.html', '/scam.html'])
        expect(config.routes.find(item => item.route === route)).toEqual({ route, redirect: '/invoice-scams', statusCode: 301 });
});

// #727: public pages state the same count and ranking as the v2 results heading.
test('no public page still promises a fixed "top three gaps" order', () => {
    const fs = require('fs'), path = require('path');
    for (const page of ['index.html', 'board.html', 'insurance.html', 'supplier-questionnaire.html', 'invoice-scams.html', 'pricing.html', 'roadmap.html']) {
        const html = fs.readFileSync(path.join(__dirname, '..', page), 'utf8');
        expect(html).not.toMatch(/top three gaps/i);
        expect(html).not.toMatch(/patching, backups and payment-change checks come first/i);
    }
    const client = fs.readFileSync(path.join(__dirname, '../api/shared/protectedAssets/ncscQuestionnaire.js'), 'utf8');
    expect(client).toMatch(/V2_GAP_LIMIT = 5\b/);
});

// #673: each campaign page shows the priced next step, matching the pricing page.
test('every campaign page shows the 90-day price next to the offer', () => {
    const fs = require('fs'), path = require('path');
    const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
    expect(read('pricing.html')).toContain('NZ$1,250 + GST for 90 days');
    for (const page of ['insurance.html', 'supplier-questionnaire.html', 'board.html', 'invoice-scams.html']) {
        const block = read(page).match(/<section class="ad-managed"[\s\S]*?<\/section>/)[0];
        expect(block).toContain('<p class="ad-price">NZ$1,250 + GST for 90 days</p>');
        expect(block).toContain('href="/pricing#pricing-pilot"');
        // Time, output and a sample stay on the page too.
        expect(read(page)).toMatch(/about 15 minutes/i);
        expect(read(page)).toContain('href="/sample-result.html#');
    }
    expect(read('pricing.html')).toContain('File exports, such as PDF or spreadsheet downloads, are not included.');
});
