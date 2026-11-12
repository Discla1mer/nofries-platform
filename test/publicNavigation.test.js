'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Every public page offers the same places in the same order, so visitors can
// move between the Dashboard, Pricing, Managed IT, Roadmap and Contact anywhere.
// News was retired; no page links to it.
const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const hrefs = html => [...html.matchAll(/<a\b[^>]*href="([^"]+)"/g)].map(match => match[1]);
const MAIN = ['/', '/pricing.html', '/managed-it.html', '/roadmap.html', '/contact.html', '/login?intent=login'];
const FOOTER = ['/', '/pricing.html', '/managed-it.html', '/roadmap.html', '/contact.html', '/privacy.html', '/terms.html'];
const PAGES = ['index.html', 'roadmap.html', 'pricing.html', 'managed-it.html', 'contact.html', 'privacy.html', 'terms.html', 'pilot-terms.html', '404.html', 'error.html'];

test.each(PAGES)('%s uses the shared main and footer links', name => {
    const html = read(name);
    const main = html.match(/<nav aria-label="Main navigation">([\s\S]*?)<\/nav>/);
    expect(main).not.toBeNull();
    // Managed IT keeps its own in-page pricing action after the shared links.
    expect(hrefs(main[1]).filter(href => !href.startsWith('#'))).toEqual(MAIN);
    const footer = html.match(/<nav aria-label="Footer links">([\s\S]*?)<\/nav>/);
    expect(footer).not.toBeNull();
    expect(hrefs(footer[1]).filter(href => !href.startsWith('mailto:'))).toEqual(FOOTER);
    // The logo's accessible name contains its visible text (WCAG 2.5.3) and
    // it opens that section's home: Managed IT for its own page, otherwise /.
    const brand = html.match(/<a class="(?:brand|login-brand)" href="([^"]+)" aria-label="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    expect(brand).not.toBeNull();
    const visible = brand[3].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    expect(brand[2]).toBe(visible + ' home');
    expect(brand[1]).toBe(visible === 'No Fries Managed IT' ? '/managed-it.html' : '/');
    // Staff sign-in is not offered in shared navigation.
    expect(main[1] + footer[1]).not.toMatch(/\/operator|\/portal|\/scoping|Staff/);
    expect(main[1]).not.toContain('↗');
});

test.each(PAGES)('%s marks at most one link as the current page in each navigation', name => {
    for (const nav of read(name).matchAll(/<nav aria-label="(?:Main navigation|Footer links)">([\s\S]*?)<\/nav>/g)) {
        expect((nav[1].match(/aria-current="page"/g) || []).length).toBeLessThanOrEqual(1);
    }
});

test('the roadmap keeps its header links visible on phones and no page links to the retired News site', () => {
    const html = read('roadmap.html');
    expect(html).toContain('<body data-page="product-roadmap" data-product="dashboard">');
    expect(read('home.css')).toMatch(/@media \(max-width: 980px\) \{\s*body\[data-product="dashboard"\] \.home-stage[^}]*\}\s*body\[data-product="dashboard"\] \.site-header \{ grid-template-columns: minmax\(0, 1fr\) auto; \}\s*body\[data-product="dashboard"\] \.site-header nav \{ display: flex;/);
    expect(html).not.toMatch(/Ready for release|roadmap-ready/);
    for (const name of [...PAGES, 'app/dashboard.html']) expect(read(name)).not.toContain('news.nofries.nz');
});
