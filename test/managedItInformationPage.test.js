'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const testCase = globalThis.test || require('node:test').test;
const { MANAGED_IT_POLICY } = require('../api/shared/managedItPolicy');

const html = fs.readFileSync(path.join(__dirname, '../managed-it.html'), 'utf8');
const home = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const existingScope = fs.readFileSync(path.join(__dirname, '../scope.html'), 'utf8');
const text = value => value.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

function policyItems(section, headings) {
    const match = html.match(new RegExp(`<(ol|ul)\\b[^>]*data-policy-section="${section}"[^>]*>([\\s\\S]*?)<\\/\\1>`));
    assert.ok(match, `missing ${section} policy summary`);
    const items = [...match[2].matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)];
    return items.map(item => text(headings ? item[1].match(/<h3>([\s\S]*?)<\/h3>/)[1] : item[1]));
}

testCase('the standalone Managed IT page is linked only from the compact homepage service section', () => {
    const mainNav = home.match(/<nav aria-label="Main navigation">([\s\S]*?)<\/nav>/)[1];
    assert.doesNotMatch(mainNav, /managed-it|Managed IT/);
    assert.match(home, /id="other-services"[\s\S]*href="\/managed-it\.html"/);
    assert.match(html, /<title>No Fries Managed IT<\/title>/);
    assert.match(html, /<link rel="canonical" href="https:\/\/nofries\.nz\/managed-it\.html">/);
    assert.match(html, /<body data-page="managed-it-information">/);
    assert.match(html, /href="#main-content">Skip to content/);
    assert.match(html, /<main[^>]*id="main-content"[^>]*tabindex="-1"/);
    assert.equal([...html.matchAll(/<h1\b/g)].length, 1);
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
    assert.equal(ids.length, new Set(ids).size, 'document identifiers must be unique');
    for (const [, id] of html.matchAll(/href="#([^"]+)"/g)) {
        assert.ok(ids.includes(id), `missing in-page destination ${id}`);
    }
});

testCase('the public included-service summary stays aligned with the effective policy', () => {
    assert.deepEqual(policyItems('included', true), MANAGED_IT_POLICY.includedServices);
    assert.match(text(html), /The agreed scope sets out your people, computers, tools and service coverage\./);
});

testCase('protection and backup remain explicitly optional and selected separately', () => {
    assert.deepEqual(policyItems('optional', true), MANAGED_IT_POLICY.optionalServices);
    assert.match(text(html), /Optional · selected separately Protect & Recover\./);
    assert.match(text(html), /These options are included only when selected in your agreed scope\./);
});

testCase('separately scoped extras retain every public policy exclusion', () => {
    assert.deepEqual(policyItems('excluded', false), MANAGED_IT_POLICY.exclusions);
    assert.match(text(html), /Agreed separately Large projects/);
    assert.match(text(html), /Additional needs are scoped and priced before acceptance\./);
});

testCase('separate service-page links survive the dashboard-focused homepage and removed Luna promotion', () => {
    assert.doesNotMatch(home, /Product and services|id="service-dialog"|id="discovery-dialog"|id="pricing-dialog"/);
    for (const href of ['https://news.nofries.nz/', '/roadmap.html', '/privacy.html', '/terms.html']) {
        assert.ok(home.includes(`href="${href}"`), `homepage footer lost ${href}`);
    }
    for (const href of ['/', 'https://news.nofries.nz/', 'https://sales.nofries.nz/', '/roadmap.html', '/portal', '/privacy.html', '/terms.html']) {
        assert.ok(html.includes(`href="${href}"`), `information page lost ${href}`);
    }
    assert.match(html, /href="\/managed-it\.html" aria-current="page"/);
    assert.match(html, /src="\/images\/nofrieslogo\.png" width="44" height="44" alt=""/);
    assert.doesNotMatch(html, /href="https:\/\/luna\.nofries\.nz\//);
});

testCase('the enquiry action reuses the click-only shared assistant and verified contact paths', () => {
    const buttons = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)];
    assert.equal(buttons.length, 2);
    for (const button of buttons) {
        assert.match(button[1], /type="button"/);
        assert.match(button[1], /\bdata-assistant-open\b/);
        assert.match(button[1], /data-assistant-topic="managed-it"/);
        assert.equal(text(button[2]), 'Ask about Managed IT →');
        assert.doesNotMatch(button[1], /data-message|onclick|formaction/);
    }
    assert.match(existingScope, /href="mailto:hello@nofries\.nz"/);
    assert.match(html, /href="mailto:hello@nofries\.nz">Email hello@nofries\.nz/);
    assert.match(html, /href="\/scoping">Staff scoping workspace <span aria-hidden="true">→<\/span><\/a>/);
    assert.match(text(html), /Ask about Managed IT or discuss your service needs\./);
    assert.match(text(html), /Indicative prices are confirmed with the service scope before acceptance\./);
});

testCase('pricing navigation describes the enquiry destination without promising a price list', () => {
    const navigation = html.match(/<nav aria-label="Product and services">([\s\S]*?)<\/nav>/)[1];
    assert.match(navigation, /<a href="#enquire">Discuss pricing<\/a>/);
    assert.match(html, /<section class="managed-it-enquiry" id="enquire" aria-labelledby="enquiry-title">/);
    assert.doesNotMatch(html, /Service pricing|Plan your managed service|Open the existing scoping workspace/);
});

testCase('dashboard access and planned automation are stated without new service commitments', () => {
    assert.match(text(html), /view results calculated from submitted answers\. Access depends on your organisation’s permissions\./);
    assert.match(text(html), /Managed IT is a separate, optional service\./);
    assert.match(text(html), /Automatic updates and connected data feeds are planned\./);
    assert.doesNotMatch(text(html), /NZ\$|\$\d|24\/7|guaranteed|unlimited|certified|response time|service-level agreement/i);
});

testCase('the source page allows only the optional aggregate script and no independent bot or form', () => {
    const analytics = '<script src="/js/website-analytics.js" defer></script>';
    assert.equal(html.split(analytics).length - 1, 1);
    const withoutAnalytics = html.replace(analytics, '');
    assert.doesNotMatch(withoutAnalytics, /<form\b|<script\b|<iframe\b|<dialog\b|\bon\w+=|data-start-discovery|id="prospect-assistant"/i);
    assert.doesNotMatch(withoutAnalytics, /\/api\/|\/scope\.html|api\/shared\/serviceScope|\bfetch\s*\(|localStorage|sessionStorage/);
    assert.match(html, /href="\/managed-it\.css"/);
    const styles = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map(match => match[1]);
    assert.deepEqual(styles, ['/style.css', '/home.css', '/managed-it.css']);
});
