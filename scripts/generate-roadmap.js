'use strict';

const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const marker = /<!-- ROADMAP:START -->[\s\S]*?<!-- ROADMAP:END -->/;
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function readRoadmap() {
    return JSON.parse(fs.readFileSync(path.join(root, 'docs/roadmap.md'), 'utf8').match(/```json\n([\s\S]*?)\n```/)[1]);
}

function renderRoadmap(data = readRoadmap()) {
    const lines = ['<!-- ROADMAP:START -->', '<header class="public-roadmap-intro">',
        '<p class="eyebrow">The No Fries dashboard · NZ financial year</p>',
        `<h1>${escape(data.title)}</h1><p class="home-lead">${escape(data.lead)}</p>`,
        `<p>${escape(data.notice)}</p><p>What you can use depends on the access your organisation has agreed.</p>`,
        `<p>${escape(data.serviceNote)} <a href="/pricing.html#pricing-pilot">See service details</a>.</p>`, '</header>',
        '<nav class="roadmap-jump" aria-label="Roadmap quarters">'];
    for (const q of data.quarters) lines.push(`<a href="#${escape(q.id)}">${escape(q.label)}${q.id === data.currentQuarter ? ' (current)' : ''}</a>`);
    lines.push('</nav>', '<dl class="roadmap-legend">');
    for (const [lane, meaning] of Object.entries(data.lanes)) lines.push(`<div><dt>${escape(lane)}</dt><dd>${escape(meaning)}</dd></div>`);
    lines.push('</dl>', '<ol class="roadmap-timeline" aria-label="Quarterly product roadmap">');
    for (const q of data.quarters) {
        lines.push(`<li><section class="roadmap-quarter" aria-labelledby="${escape(q.id)}">`,
            `<h2 id="${escape(q.id)}" tabindex="-1">${escape(q.label)}<span>${escape(q.period)}</span>${q.state === 'current' ? '<strong>Current quarter</strong>' : ''}</h2>`);
        const entries = data.items.filter(item => item.quarter === q.id);
        for (const lane of Object.keys(data.lanes)) {
            const items = entries.filter(item => item.lane === lane);
            if (!items.length && !(q.state === 'historical' && lane === 'Done')) continue;
            const id = q.state === 'current' && lane === 'Done' ? 'roadmap-live' : q.state === 'current' && lane === 'In progress' ? 'roadmap-development' : `${q.id}-${lane.toLowerCase().replaceAll(' ', '-')}`;
            lines.push(`<section class="roadmap-lane" data-lane="${escape(lane)}" aria-labelledby="${id}"><h3 id="${id}">${escape(lane)}</h3>`);
            if (!items.length) lines.push(`<p>${escape(data.historicalNotice)}</p>`);
            for (const item of items) {
                lines.push(`<article data-roadmap-item="${escape(item.id)}"${item.id === 'paid-assessments' ? ' id="roadmap-planned" tabindex="-1"' : ''}>`,
                    `<h4>${escape(item.title)}</h4>${lane === 'Done' ? '' : '<p class="roadmap-status">Planned</p>'}<p>${escape(item.text)}</p>`);
                if (item.link) lines.push(`<p><a href="${escape(item.link.href)}">${escape(item.link.label)}</a></p>`);
                lines.push(`<details><summary>Sources for ${escape(item.title)}</summary><p>Source PRs: ${item.prs.map(pr => `<a href="https://github.com/Discla1mer/nofries-platform/pull/${pr}">#${pr}</a>`).join(', ')}.${item.release ? ` <a href="${escape(item.release)}">Release evidence</a>.` : ' Planned scope; these sources do not establish availability.'}</p></details></article>`);
            }
            lines.push('</section>');
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

module.exports = { readRoadmap, renderRoadmap, marker };
