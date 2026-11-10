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

testCase('the standalone Managed IT page is linked from the shared navigation and the compact homepage service section', () => {
    const mainNav = home.match(/<nav aria-label="Main navigation">([\s\S]*?)<\/nav>/)[1];
    assert.match(mainNav, /href="\/managed-it\.html" data-dashboard-leave>Managed IT</);
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

testCase('scale add-ons stay aligned with the effective policy and read as priced per use', () => {
    assert.deepEqual(policyItems('optional', true), MANAGED_IT_POLICY.optionalServices);
    assert.match(text(html), /Optional · priced per use Add-ons when you need them\./);
    assert.match(text(html), /These add-ons are priced on top of your per-user plan when your agreed scope needs them\./);
});

testCase('separately scoped extras retain every public policy exclusion', () => {
    assert.deepEqual(policyItems('excluded', false), MANAGED_IT_POLICY.exclusions);
    assert.match(text(html), /Agreed separately Large projects/);
    assert.match(text(html), /Additional needs are scoped and priced before acceptance\./);
});

testCase('separate service-page links survive the dashboard-focused homepage and removed Luna promotion', () => {
    assert.doesNotMatch(home, /Product and services|id="service-dialog"|id="discovery-dialog"|id="pricing-dialog"/);
    for (const href of ['/roadmap.html', '/privacy.html', '/terms.html']) {
        assert.ok(home.includes(`href="${href}"`), `homepage footer lost ${href}`);
    }
    for (const href of ['/', '/roadmap.html', '/contact.html', '/portal', '/privacy.html', '/terms.html']) {
        assert.ok(html.includes(`href="${href}"`), `information page lost ${href}`);
    }
    assert.match(html, /href="\/managed-it\.html" aria-current="page"/);
    assert.match(html, /src="\/images\/nofrieslogo\.png" width="44" height="44" alt=""/);
    assert.doesNotMatch(html, /href="https:\/\/luna\.nofries\.nz\//);
});

testCase('the enquiry action reuses the click-only shared assistant and verified contact paths', () => {
    const buttons = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)];
    // Two "Ask about Managed IT" launchers plus one CTA per pricing tier.
    assert.equal(buttons.length, 5);
    const tierButtons = [];
    for (const button of buttons) {
        assert.match(button[1], /type="button"/);
        assert.match(button[1], /\bdata-assistant-open\b/);
        assert.match(button[1], /data-assistant-topic="managed-it"/);
        assert.doesNotMatch(button[1], /data-message|onclick|formaction/);
        const tier = button[1].match(/data-managed-it-tier="([^"]+)"/);
        if (tier) tierButtons.push(tier[1]);
        else assert.equal(text(button[2]), 'Ask about Managed IT →');
    }
    assert.deepEqual(tierButtons, ['essentials', 'managed', 'secure']);
    assert.match(existingScope, /href="mailto:hello@nofries\.nz"/);
    assert.match(html, /href="mailto:hello@nofries\.nz">Email hello@nofries\.nz/);
    assert.match(html, /href="\/scoping">Staff scoping workspace <span aria-hidden="true">→<\/span><\/a>/);
    assert.match(text(html), /Ask about Managed IT or discuss your service needs\./);
    assert.match(text(html), /Indicative prices are confirmed with the service scope before acceptance\./);
});

testCase('pricing navigation describes the enquiry destination without promising a price list', () => {
    const navigation = html.match(/<nav aria-label="Main navigation">([\s\S]*?)<\/nav>/)[1];
    assert.match(navigation, /<a href="#enquire">Discuss pricing<\/a>/);
    assert.match(html, /<section class="managed-it-enquiry" id="enquire" aria-labelledby="enquiry-title">/);
    assert.doesNotMatch(html, /Service pricing|Plan your managed service|Open the existing scoping workspace/);
});

testCase('dashboard access and planned automation are stated without new service commitments', () => {
    assert.match(text(html), /view results calculated from submitted answers\. Access depends on your organisation’s permissions\./);
    assert.match(text(html), /Managed IT is a separate, optional service\./);
    assert.match(text(html), /Automatic updates and connected data feeds are planned\./);
    // The page must now show the real tier prices customers sign against (Fair
    // Trading), each carrying "+ GST", but still make no over-reaching claims.
    assert.doesNotMatch(text(html), /24\/7|guaranteed|unlimited|certified|response time|service-level agreement/i);
});

testCase('the plans and pricing section renders the three tiers with GST-inclusive copy and a recommended badge', () => {
    const plansText = text(html);
    const policyTiers = MANAGED_IT_POLICY.pricing.tiers;
    for (const tier of policyTiers) {
        assert.match(plansText, new RegExp(`NZ\\$${tier.perUserMonthly} \\+ GST`),
            `tier ${tier.id} price must render with + GST`);
        assert.ok(plansText.includes(tier.tagline), `tier ${tier.id} tagline must render`);
        for (const feature of tier.additionalFeatures) {
            assert.ok(plansText.includes(feature), `missing tier feature: ${feature}`);
        }
    }
    // Managed is the recommended tier and carries a visible badge.
    assert.match(html, /<li class="managed-it-tier is-recommended" data-tier="managed">/);
    assert.match(html, /class="managed-it-tier-badge">Recommended</);
    assert.match(html, /data-managed-it-tier="managed"/);
    // Managed and Secure inherit from the tier below them.
    assert.match(plansText, /Everything in Essentials, plus:/);
    assert.match(plansText, /Everything in Managed, plus:/);
    // Add-on note keeps every price GST-qualified.
    assert.match(plansText, /Set-up from NZ\$750 \+ GST\. Extra computers NZ\$20 \+ GST each per month, extra locations NZ\$125 \+ GST each per month\./);
    // Every NZ$ figure on the page is immediately followed by "+ GST".
    for (const match of html.matchAll(/NZ\$[\d,]+/g)) {
        const after = text(html.slice(match.index, match.index + match[0].length + 60));
        assert.match(after, /^NZ\$[\d,]+ \+ GST/, `price without + GST near: ${after.slice(0, 40)}`);
    }
});

testCase('viewing the source page introduces no form, independent bot or background side effect', () => {
    assert.doesNotMatch(html, /<form\b|<script\b|<iframe\b|<dialog\b|\bon\w+=|data-start-discovery|id="prospect-assistant"/i);
    assert.doesNotMatch(html, /\/api\/|\/scope\.html|api\/shared\/serviceScope|\bfetch\s*\(|localStorage|sessionStorage/);
    assert.match(html, /href="\/managed-it\.css"/);
    const styles = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map(match => match[1]);
    assert.deepEqual(styles, ['/style.css', '/home.css', '/managed-it.css']);
});
