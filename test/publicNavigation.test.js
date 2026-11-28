'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Every public page offers the same header and footer, so visitors can move
// between Home, Pricing, Managed IT, Roadmap and Contact, and log in, anywhere.
// News was retired; no page links to it.
const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const hrefs = html => [...html.matchAll(/<a\b[^>]*href="([^"]+)"/g)].map(match => match[1]);
const labels = html => [...html.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/g)].map(match => match[1].replace(/<[^>]*>/g, '').trim());
const MAIN = ['/', '/pricing.html', '/managed-it.html', '/roadmap.html', '/contact.html', '/login?intent=login'];
const MAIN_LABELS = ['Home', 'Pricing', 'Managed IT', 'Roadmap', 'Contact', 'Log in'];
const FOOTER = ['/', '/pricing.html', '/managed-it.html', '/roadmap.html', '/contact.html', '/about.html', '/security.html', '/faq.html', '/privacy.html', '/terms.html'];
const FOOTER_LABELS = ['Home', 'Pricing', 'Managed IT', 'Roadmap', 'Contact', 'About', 'Security', 'FAQ', 'Privacy', 'Terms'];
const PAGES = ['index.html', 'changelog.html', 'roadmap.html', 'pricing.html', 'sample-result.html', 'managed-it.html', 'contact.html', 'privacy.html', 'terms.html', 'pilot-terms.html', '404.html', 'error.html', 'account-help.html', 'insurance.html', 'supplier-questionnaire.html', 'board.html', 'consultants.html', 'offer.html', 'about.html', 'security.html', 'faq.html', 'invoice-scams.html'];

test.each(PAGES)('%s uses the shared main and footer links', name => {
    const html = read(name);
    const main = html.match(/<nav aria-label="Main navigation">([\s\S]*?)<\/nav>/);
    expect(main).not.toBeNull();
    expect(hrefs(main[1])).toEqual(MAIN);
    expect(labels(main[1])).toEqual(MAIN_LABELS);
    const footer = html.match(/<footer class="home-footer">[\s\S]*?<nav aria-label="Footer links">([\s\S]*?)<\/nav>/);
    expect(footer).not.toBeNull();
    expect(hrefs(footer[1])).toEqual(FOOTER);
    expect(labels(footer[1])).toEqual(FOOTER_LABELS);
    // One header style: the shared header (the homepage gateway header gives the same layout) sits before main content.
    const header = html.match(/<header class="site-header shell( public-site-header)?">/);
    expect(header).not.toBeNull();
    if (name !== 'index.html') expect(header[1]).toBe(' public-site-header');
    expect(html.indexOf('<header class="site-header')).toBeLessThan(html.search(/<main\b|role="main"/));
    expect(html.search(/<main\b|role="main"/)).toBeGreaterThan(0);
    expect(main[1]).toMatch(/<a class="(?:site-login|homepage-login)" href="\/login\?intent=login">Log in<\/a><\/nav>|<a class="(?:site-login|homepage-login)" href="\/login\?intent=login">Log in<\/a>\s*$/);
    expect(html).not.toMatch(/class="public-header|class="login-brand/);
    // The logo's accessible name contains its visible text (WCAG 2.5.3) and
    // it opens that section's home: Managed IT for its own page, otherwise /.
    const brand = html.match(/<a class="(?:brand|login-brand)" href="([^"]+)" aria-label="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    expect(brand).not.toBeNull();
    const visible = brand[3].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    expect(brand[2]).toBe(visible + ' home');
    expect(brand[1]).toBe(visible === 'No Fries Managed IT' ? '/managed-it.html' : '/');
    expect(['No Fries Dashboard', 'No Fries Managed IT']).toContain(visible);
    // Staff sign-in is not offered in shared navigation.
    expect(main[1] + footer[1]).not.toMatch(/\/operator|\/portal|\/scoping|Staff/);
    expect(main[1]).not.toContain('↗');
});

test.each(PAGES)('%s marks at most one link as the current page in each navigation', name => {
    for (const nav of read(name).matchAll(/<nav aria-label="(?:Main navigation|Footer links)">([\s\S]*?)<\/nav>/g)) {
        expect((nav[1].match(/aria-current="page"/g) || []).length).toBeLessThanOrEqual(1);
    }
});

test('the shared header styles are defined once and keep links visible on phones', () => {
    const css = read('home.css');
    expect(css).toMatch(/body \.site-header\.public-site-header nav \{ display: flex;[^}]*justify-self: end;/);
    expect(css).toMatch(/body \.site-header\.public-site-header nav \.site-login \{[^}]*border: 1px solid var\(--line-strong\);/);
    expect(css).toMatch(/@media \(max-width: 980px\) \{\s*body \.site-header\.public-site-header \{ grid-template-columns: minmax\(0, 1fr\);/);
    // Only the public homepage can hide the duplicate small brand.
    expect(css).toMatch(/body\[data-page="dashboard-home"\]:has\(#gatewayPublic:not\(\[hidden\]\)\) \.site-header > \.brand \{ display: none; \}/);
    // Managed IT no longer restyles the shared header.
    expect(read('managed-it.css')).not.toMatch(/\.site-header/);
    for (const name of PAGES) expect([name, read(name).includes('href="/home.css"')]).toEqual([name, true]);
});

test('on phones the header shows every page link and Log in as 44px targets, and the footer lists them too (#670)', () => {
    const css = read('home.css');
    const phone = css.match(/@media \(max-width: 700px\) \{\s*body \.site-header:has\(> nav\[aria-label="Main navigation"\]\)[\s\S]*?\n\}/);
    expect(phone).not.toBeNull();
    // No rule may hide the main navigation or its links at phone width again.
    expect(phone[0]).not.toMatch(/nav\[aria-label="Main navigation"\][^{]*\{[^}]*display: none/);
    expect(phone[0]).toMatch(/nav\[aria-label="Main navigation"\] \{ display: flex; flex-wrap: wrap; grid-column: 1 \/ -1;/);
    expect(phone[0]).toMatch(/nav\[aria-label="Main navigation"\] > a \{ display: inline-flex; align-items: center; min-height: 44px; \}/);
    for (const name of PAGES) {
        const nav = read(name).match(/<nav aria-label="Main navigation">([\s\S]*?)<\/nav>/);
        if (!nav) continue;
        for (const href of ['/', '/pricing.html', '/managed-it.html', '/roadmap.html', '/contact.html'])
            expect([name, href, nav[1].includes(`href="${href}"`)]).toEqual([name, href, true]);
    }
    expect(phone[0]).toMatch(/body \.home-footer nav \{ display: grid;/);
    expect(phone[0]).toMatch(/min-height: 48px;/);
});

test('the roadmap keeps its header links visible on phones and no page links to the retired News site', () => {
    const html = read('roadmap.html');
    expect(html).toContain('<body data-page="product-roadmap" data-product="dashboard">');
    expect(read('home.css')).toMatch(/@media \(max-width: 980px\) \{\s*body\[data-product="dashboard"\] \.home-stage[^}]*\}\s*body\[data-product="dashboard"\] \.site-header \{ grid-template-columns: minmax\(0, 1fr\) auto; \}\s*body\[data-product="dashboard"\] \.site-header nav \{ display: flex;/);
    expect(html).not.toMatch(/Ready for release|roadmap-ready/);
    for (const name of [...PAGES, 'app/dashboard.html']) expect(read(name)).not.toContain('news.nofries.nz');
});
