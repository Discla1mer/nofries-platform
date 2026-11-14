'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const registry = JSON.parse(fs.readFileSync(path.join(root, 'docs', 'feature-status.json'), 'utf8'));
const { NOFRIES_PUBLIC_KNOWLEDGE } = require('../api/shared/agents/nofriesPublicKnowledge');

const LIVE_KNOWLEDGE = new Set(['available', 'existing_workflow']);

function readPage(name) {
    return fs.readFileSync(path.join(root, name), 'utf8');
}

// Text a visitor or search result would read: visible copy plus meta descriptions.
function publicText(html) {
    const meta = [...html.matchAll(/<meta\b[^>]*\bcontent="([^"]*)"/g)].map(match => match[1]);
    const body = html
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<(script|style)\b[\s\S]*?<\/\1>/g, ' ')
        .replace(/<[^>]+>/g, ' ');
    return `${meta.join(' ')} ${body}`.replace(/&nbsp;|\s+/g, ' ');
}

function sectionBody(html, headingId) {
    const match = html.match(new RegExp(`<section\\b[^>]*aria-labelledby="${headingId}"[^>]*>([\\s\\S]*?)</section>`));
    if (!match) throw new Error(`Missing section ${headingId}`);
    return match[1];
}

const notLive = registry.capabilities.filter(item => item.status !== 'live');

describe('public feature-status registry', () => {
    test('every capability has a known status and a unique id', () => {
        const ids = registry.capabilities.map(item => item.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const item of registry.capabilities) {
            expect(registry.statuses).toContain(item.status);
            expect(item.name).toEqual(expect.any(String));
        }
        expect(registry.capabilities.filter(item => item.status === 'live').map(item => item.id)).toEqual([
            'company-account', 'ncsc-assessment', 'ncsc-results', 'shareable-summary', 'change-over-time', 'improvement-plan'
        ]);
    });

    test('non-live capabilities name the wording that would present them as available', () => {
        for (const item of notLive) {
            expect(item.availabilityClaims && item.availabilityClaims.length).toBeGreaterThan(0);
        }
    });

    test('the public assistant knowledge agrees with the registry', () => {
        for (const item of registry.capabilities.filter(entry => entry.knowledgeKey)) {
            const knowledge = NOFRIES_PUBLIC_KNOWLEDGE.capabilities[item.knowledgeKey];
            expect(knowledge).toBeDefined();
            expect([item.id, LIVE_KNOWLEDGE.has(knowledge.availability)]).toEqual([item.id, item.status === 'live']);
        }
    });

    test('the home page does not present a non-live capability as available', () => {
        const text = publicText(readPage('index.html'));
        for (const item of notLive) {
            for (const claim of item.availabilityClaims) {
                expect([item.id, text.match(new RegExp(claim, 'i'))?.[0] || null]).toEqual([item.id, null]);
            }
        }
    });

    test('the roadmap lists only live capabilities under Live', () => {
        const live = publicText(sectionBody(readPage('roadmap.html'), 'roadmap-live'));
        for (const item of notLive) {
            if (item.roadmapTitle) expect([item.id, live.includes(item.roadmapTitle)]).toEqual([item.id, false]);
            for (const claim of item.availabilityClaims) {
                expect([item.id, live.match(new RegExp(claim, 'i'))?.[0] || null]).toEqual([item.id, null]);
            }
        }
    });

    test('the pricing page does not present a non-live capability as available', () => {
        const text = publicText(readPage('pricing.html'));
        for (const item of notLive) {
            for (const claim of item.availabilityClaims) {
                expect([item.id, text.match(new RegExp(claim, 'i'))?.[0] || null]).toEqual([item.id, null]);
            }
        }
    });

    test('every item in the free plan names a live capability', () => {
        const live = new Set(registry.capabilities.filter(item => item.status === 'live').map(item => item.id));
        const free = sectionBody(readPage('pricing.html'), 'pricing-free');
        const items = [...free.matchAll(/<li\b([^>]*)>/g)].map(match => match[1].match(/\bdata-feature="([^"]+)"/)?.[1] || null);
        expect(items.length).toBeGreaterThan(0);
        for (const id of items) expect([id, live.has(id)]).toEqual([id, true]);
    });

    test('every roadmap title named in the registry appears on the roadmap', () => {
        const roadmap = readPage('roadmap.html');
        for (const item of registry.capabilities.filter(entry => entry.roadmapTitle)) {
            expect([item.id, roadmap.includes(`<h3>${item.roadmapTitle}</h3>`)]).toEqual([item.id, true]);
        }
    });
});
