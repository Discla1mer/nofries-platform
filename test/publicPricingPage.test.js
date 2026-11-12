'use strict';

const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'pricing.html'), 'utf8');
const text = html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|\s+/g, ' ');
const headings = [...html.matchAll(/<h2 id="([^"]+)"/g)].map(match => match[1]);

test('the pricing page shows the plans in the agreed order', () => {
    expect(headings).toEqual(['pricing-free', 'pricing-pilot', 'pricing-assisted', 'pricing-support', 'pricing-managed-it', 'pricing-start']);
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html).toContain('<link rel="canonical" href="https://nofries.nz/pricing.html">');
    expect(html).toContain('<a class="skip-link" href="#main-content">Skip to content</a>');
});

test('every non-zero price says + GST', () => {
    const prices = [...text.matchAll(/NZ\$([\d,]+)(.{0,6})/g)];
    expect(prices.map(match => match[1])).toEqual(['0', '1,250', '2,000', '350']);
    for (const [whole, amount, after] of prices) {
        if (amount !== '0') expect([whole, after.startsWith(' + GST')]).toEqual([whole, true]);
    }
    expect(text).toContain('No card needed.');
});

test('the founding pilot and assisted plan carry their agreed terms', () => {
    for (const phrase of ['Normally NZ$2,000 + GST', 'first three customers', 'Invoiced upfront', 'Places are limited', 'Starts are staggered',
        'An assisted baseline', 'Three improvements we own with you', 'Two month-end reviews', 'give your board or insurer',
        'feedback, a case study and a reference', 'From NZ$350 + GST a month', 'A quarterly review', 'Up to 1 hour of help a month',
        'pilot fee is credited', 'no automatic renewal', 'New Zealand business hours', 'within two business days',
        'does not include incident response', 'Managed IT is priced separately']) {
        expect([phrase, text.toLowerCase().includes(phrase.toLowerCase())]).toEqual([phrase, true]);
    }
});

test('the page offers no self-serve plan and makes no round-the-clock or certification claims', () => {
    expect(text).not.toMatch(/NZ\$99|self[- ]serve|self-service plan/i);
    expect(text).not.toMatch(/24\s*\/\s*7|24 hours|around the clock|round the clock/i);
    expect(text).not.toMatch(/\bcertified\b|\bcompliant\b|guarantee|\bfounder\b/i);
    expect(text).not.toContain('!');
});

test('the calls to action and Managed IT link go to existing pages', () => {
    const links = [...html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([^<]*)<\/a>/g)].map(match => [match[2].trim(), match[1]]);
    expect(links).toEqual(expect.arrayContaining([
        ['Create a free account', '/login?intent=create'],
        ['Ask about the Founding Pilot', '/contact.html'],
        ['Managed IT', '/managed-it.html']
    ]));
    expect(html).not.toMatch(/href="\/share|\/api\//);
});
