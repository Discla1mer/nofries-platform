'use strict';
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const script = fs.readFileSync(path.join(__dirname, '../js/home.js'), 'utf8');
const DEFAULT_TITLE = 'Need to answer a cyber security question today?';

function land(search, page = 'dashboard-home') {
    const title = { textContent: DEFAULT_TITLE }, lead = { textContent: 'default lead', classList: { add() {} } };
    const document = {
        body: { dataset: { page } },
        addEventListener() {}, querySelectorAll: () => [],
        getElementById: id => id === 'home-title' ? title : id === 'homepageLead' ? lead : null
    };
    vm.runInNewContext(script, { document, window: { location: { search } }, URLSearchParams });
    return { title: title.textContent, lead: lead.textContent };
}

test('the static page keeps the default headline and names the lead', () => {
    expect(html).toContain('<h1 id="home-title" class="homepage-headline">' + DEFAULT_TITLE + '</h1>');
    expect(html).toContain('<p class="homepage-lead" id="homepageLead">');
});

test.each([
    ['?utm_source=meta&utm_campaign=insurance', /cyber insurance form/],
    ['?utm_campaign=Insurance-Nov', /cyber insurance form/],
    ['?utm_campaign=supplier_q4', /security questionnaire/],
    ['?utm_campaign=board', /board asked about cyber security/],
    ['?utm_campaign=scam', /fake invoice/]
])('campaign %s gets its fixed headline', (search, pattern) => {
    const page = land(search);
    expect(page.title).toMatch(pattern);
    expect(page.lead).toMatch(/NCSC/);
});

test.each([
    [''], ['?utm_campaign=fix90'], ['?utm_campaign=%3Cimg%20src%3Dx%3E'], ['?utm_campaign=__proto__'],
    ['?utm_campaign=constructor'], ['?utm_campaign=toString'], ['?utm_source=meta']
])('anything else (%s) leaves the page unchanged', search => {
    expect(land(search)).toEqual({ title: DEFAULT_TITLE, lead: 'default lead' });
});

test('other pages are never changed', () => {
    expect(land('?utm_campaign=insurance', 'pricing')).toEqual({ title: DEFAULT_TITLE, lead: 'default lead' });
});

test('the preview explains how to discuss results and keeps the service offer on pricing', () => {
    expect(html).toContain('Use your results to decide what to discuss with your IT provider.');
    expect(html).toContain('about 15 minutes');
    expect(html).toContain('href="/pricing#pricing-pilot">No Fries can fix these with you</a>');
    expect(html).toContain('href="/pricing#pricing-pilot"');
    expect(html).not.toContain('Take your results to your IT provider.');
});
