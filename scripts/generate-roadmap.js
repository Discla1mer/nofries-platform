'use strict';

const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const marker = /<!-- ROADMAP:START -->[\s\S]*?<!-- ROADMAP:END -->/;
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
// Stable anchors: inbound links and tests rely on the Done and In progress ids.
const LANE_IDS = { 'Done': 'roadmap-live', 'In progress': 'roadmap-development', 'Next': 'roadmap-next', 'Later': 'roadmap-later' };

function readRoadmap() {
    return JSON.parse(fs.readFileSync(path.join(root, 'docs/roadmap.md'), 'utf8').match(/```json\n([\s\S]*?)\n```/)[1]);
}

// The source records the date of its last customer-facing change, so regeneration is deterministic.
function formatDate(iso) {
    const [year, month, day] = iso.split('-').map(Number);
    if (!year || !MONTHS[month - 1] || !day) throw new Error(`Invalid lastUpdated date: ${iso}`);
    return `${day} ${MONTHS[month - 1]} ${year}`;
}

function renderRoadmap(data = readRoadmap()) {
    const lines = ['<!-- ROADMAP:START -->', '<header class="public-roadmap-intro">',
        '<p class="eyebrow">The No Fries dashboard</p>',
        `<h1>${escape(data.title)}</h1><p class="home-lead">${escape(data.lead)}</p>`,
        `<p>Last updated <time datetime="${escape(data.lastUpdated)}">${formatDate(data.lastUpdated)}</time>.</p>`,
        `<p>${escape(data.notice)}</p><p>What you can use depends on the access your organisation has agreed.</p>`,
        `<p>${escape(data.serviceNote)} <a href="/pricing.html#pricing-pilot">See service details</a>.</p>`, '</header>',
        '<nav class="roadmap-jump" aria-label="Roadmap sections">'];
    for (const lane of Object.keys(data.lanes)) lines.push(`<a href="#${LANE_IDS[lane]}">${escape(lane)}</a>`);
    lines.push('</nav>', '<dl class="roadmap-legend">');
    for (const [lane, meaning] of Object.entries(data.lanes)) lines.push(`<div><dt>${escape(lane)}</dt><dd>${escape(meaning)}</dd></div>`);
    lines.push('</dl>', '<ol class="roadmap-timeline" aria-label="Product roadmap">');
    for (const lane of Object.keys(data.lanes)) {
        const id = LANE_IDS[lane];
        const items = data.items.filter(item => item.lane === lane);
        lines.push(`<li><section class="roadmap-lane" data-lane="${escape(lane)}" aria-labelledby="${id}">`,
            `<h2 id="${id}" tabindex="-1">${escape(lane)}</h2>`);
        // Only Done work carries a period; planned lanes are deliberately undated.
        let period;
        for (const item of items) {
            if (lane === 'Done' && item.period !== period) {
                period = item.period;
                lines.push(`<p class="roadmap-period">${escape(period)}</p>`);
            }
            const badge = lane === 'Done' ? '' : `<p class="roadmap-status">${lane === 'In progress' ? 'In progress' : 'Planned'}</p>`;
            lines.push(`<article data-roadmap-item="${escape(item.id)}"${item.id === 'paid-assessments' ? ' id="roadmap-planned" tabindex="-1"' : ''}>`,
                `<h3>${escape(item.title)}</h3>${badge}<p>${escape(item.text)}</p>`);
            if (item.link) lines.push(`<p><a href="${escape(item.link.href)}">${escape(item.link.label)}</a></p>`);
            // PR and release provenance belongs in review evidence, not the customer page.
            lines.push('</article>');
        }
        lines.push('</section></li>');
    }
    lines.push('</ol>', '<!-- ROADMAP:END -->');
    return lines.join('\n');
}

if (require.main === module) {
    const file = path.join(root, 'roadmap.html');
    const html = fs.readFileSync(file, 'utf8');
    if (!marker.test(html)) throw new Error('Missing roadmap generation markers');
    fs.writeFileSync(file, html.replace(marker, renderRoadmap()));
}

module.exports = { readRoadmap, renderRoadmap, formatDate, marker, LANE_IDS };
