'use strict';

const fs = require('node:fs');
const path = require('node:path');

const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const ids = html => [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
const PAGES = ['index.html', 'roadmap.html', 'pricing.html', 'sample-result.html', 'managed-it.html', 'contact.html', 'privacy.html', 'terms.html', 'pilot-terms.html', '404.html', 'error.html', 'login.html', 'scope.html', 'report.html'];

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
        'never turns into paid access automatically', 'Free dashboard; it doesn’t expire', 'give a new indemnity, warranty or personal guarantee',
        'Nothing in a dashboard assessment automatically sends a proposal or creates a CRM commitment'
    ]) expect(terms).toContain(text);
    expect(terms).toContain('href="/pilot-terms.html"');
    expect(terms).not.toContain('tenant-controlled endpoint');
    expect(pilot).toContain('configured tenant-controlled endpoint');
    expect(pilot).toContain('Nothing in a dashboard assessment automatically sends a proposal or creates a CRM commitment');
    expect(terms).toContain('New Zealand law governs these terms and your agreement.');
    expect(pilot).toContain('New Zealand law governs these pilot workspace terms');
    expect(pilot).toContain('does not create a production service commitment');
    expect(pilot).toContain('staff sales scoping workspace');
});

test('the privacy notice keeps operative disclosures and states facts plainly', () => {
    const privacy = read('privacy.html');
    for (const text of [
        'No Fries Limited', 'Privacy Act 2020', 'Information Privacy Principles', 'principle 12',
        'serious harm', 'as soon as practicable', '20 working days', 'Office of the Privacy Commissioner',
        'New Zealand North', 'Australia East', 'do not sell', 'use it to train AI',
        'manual assessment does not use AI', 'approximate cost', 'which model replied',
        'not to store response objects', 'fixed rules in the No Fries application',
        'cannot be read by website scripts', '90 days', '180 days', '365 days', '30 days',
        'no automatic deletion timer', 'Microsoft Entra', 'Resend', 'OpenAI', 'Power Automate',
        'No public subscription billing is active', 'one-way keyed identifier',
        'Privacy questions and requests go to', 'For our postal address, email us',
        'Your accepted agreement sets how long dashboard accounts, assessments and acceptance records are kept',
        'may process information outside New Zealand'
    ]) expect(privacy).toContain(text);
    // Customer pages state what is true, without public placeholders or a list of open gaps.
    for (const html of [privacy, read('terms.html')]) {
        expect(html).not.toContain('TODO');
        expect(html).not.toMatch(/still need to confirm|open point|not (?:yet )?(?:stated|published) on this page yet/i);
    }
    expect(privacy).not.toContain('id="open-points"');
    expect(privacy).not.toContain('HttpOnly');
    expect(privacy).not.toContain('deterministic application logic');
    expect(privacy).not.toContain('structured tool calls');
    expect(privacy).not.toContain('token count');
});

test('the privacy notice describes service emails and action-owner names as the code handles them', () => {
    const privacy = read('privacy.html');
    const section = privacy.match(/<section id="service-emails">([\s\S]*?)<\/section>/);
    expect(section).not.toBeNull();
    for (const text of ['four service emails', 'about 7 days later', 'about 90 days after', 'Resend delivers them',
        'do not greet you by name', 'do not contain your answers, gap titles, results or scores',
        'Resend’s message id', 'how many gaps it found', 'does not hold the text of the email or your email address',
        'stops that type of email', 'one-click unsubscribe', 'Unsubscribing is permanent']) expect(section[1]).toContain(text);
    expect(privacy).toContain('names you enter as action owners in your improvement plan');
    expect(privacy).toContain('cannot be an email address');
    expect(privacy).toContain('stay in the improvement plan’s history for as long as the plan record is kept');
    expect(privacy).toContain('Resend delivers signup codes and service emails');
    expect(privacy.indexOf('id="service-emails"')).toBeLessThan(privacy.indexOf('id="staff-workspaces"'));
});

test('the privacy notice keeps staff and service-workspace detail collapsed below the customer notice', () => {
    const privacy = read('privacy.html');
    const staff = privacy.match(/<details class="legal-staff" id="staff-workspaces">([\s\S]*?)<\/details>/);
    expect(staff).not.toBeNull();
    expect(staff[0]).not.toMatch(/<details[^>]*\sopen\b/);
    expect(staff[1]).toMatch(/^\s*<summary><h2>Staff and Managed IT service workspaces<\/h2><\/summary>/);
    // Internal tooling and prospect retention live only inside the collapsed section.
    for (const text of ['CRM handoff', 'Power Automate', 'raw prospect conversation messages', 'detailed AI observability events']) {
        expect(staff[1]).toContain(text);
        expect(privacy.replace(staff[0], '')).not.toContain(text);
    }
    // Every customer section comes first.
    for (const id of ['who', 'storage', 'sharing', 'retention', 'requests']) {
        expect(privacy.indexOf(`id="${id}"`)).toBeLessThan(privacy.indexOf('id="staff-workspaces"'));
    }
    expect(read('style.css')).toMatch(/body\.legal-page \.legal-staff > summary \{[^}]*min-height: 44px;/);
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
