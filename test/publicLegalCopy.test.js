'use strict';

const fs = require('node:fs');
const path = require('node:path');

const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const ids = html => [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
const PAGES = ['index.html', 'roadmap.html', 'managed-it.html', 'contact.html', 'privacy.html', 'terms.html', 'pilot-terms.html', '404.html', 'error.html', 'login.html', 'scope.html', 'report.html'];

test('customer terms stay separate from pilot terms and keep the operative limits', () => {
    const terms = read('terms.html');
    const pilot = read('pilot-terms.html');
    expect(terms).toMatch(/<h1>Dashboard terms<\/h1>/);
    expect(terms).toContain('Last updated: 11 November 2026');
    expect(terms).toContain('does not replace or vary them');
    for (const text of [
        'Consumer Guarantees Act 1993', 'section 43', 'fair and reasonable',
        'Fair Trading Act 1986', 'section 5D', 'sections 9, 12A and 13',
        'standard form small trade contracts', 'Contract and Commercial Law Act 2017',
        'Privacy Act 2020', 'earlier valid ISC grants', 'not an independent audit',
        'no automatic paid conversion', 'give a new indemnity, warranty or personal guarantee',
        'Nothing in a dashboard assessment automatically sends a proposal or creates a CRM commitment'
    ]) expect(terms).toContain(text);
    expect(terms).toContain('href="/pilot-terms.html"');
    expect(terms).not.toContain('tenant-controlled endpoint');
    expect(pilot).toContain('configured tenant-controlled endpoint');
    expect(pilot).toContain('Nothing in a dashboard assessment automatically sends a proposal or creates a CRM commitment');
    expect(pilot).toContain('New Zealand law governs these pilot workspace terms');
    expect(pilot).toContain('does not create a production service commitment');
    expect(pilot).toContain('staff sales scoping workspace');
});

test('the privacy notice keeps operative disclosures and marks unknown facts', () => {
    const privacy = read('privacy.html');
    for (const text of [
        'No Fries Limited', 'Privacy Act 2020', 'Information Privacy Principles', 'principle 12',
        'serious harm', 'as soon as practicable', '20 working days', 'Office of the Privacy Commissioner',
        'New Zealand North', 'Australia East', 'do not sell', 'use it to train AI',
        'manual assessment does not use AI', 'approximate cost', 'which model replied',
        'not to store response objects', 'fixed rules in the No Fries application',
        'cannot be read by website scripts', '90 days', '180 days', '365 days', '30 days',
        'no automatic deletion timer', 'Microsoft Entra', 'Resend', 'OpenAI', 'Power Automate',
        'No public subscription billing is active', 'one-way keyed identifier', 'TODO:'
    ]) expect(privacy).toContain(text);
    expect(privacy).not.toContain('HttpOnly');
    expect(privacy).not.toContain('deterministic application logic');
    expect(privacy).not.toContain('structured tool calls');
    expect(privacy).not.toContain('token count');
});

test('public Terms labels open the customer terms, and legal in-page links resolve', () => {
    for (const name of PAGES) {
        const html = read(name);
        for (const match of html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
            const text = match[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
            if (text === 'Terms') expect(match[1]).toBe('/terms.html');
        }
    }
    for (const name of ['privacy.html', 'terms.html', 'pilot-terms.html']) {
        const html = read(name);
        const anchors = ids(html);
        expect(new Set(anchors).size).toBe(anchors.length);
        expect(html.match(/<h1\b/g)).toHaveLength(1);
        for (const href of html.matchAll(/\bhref="#([^"]+)"/g)) expect(anchors).toContain(href[1]);
    }
});
