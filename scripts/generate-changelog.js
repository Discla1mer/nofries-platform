'use strict';

const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const marker = /<!-- CHANGELOG:START -->[\s\S]*?<!-- CHANGELOG:END -->/;
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function readChangelog() {
    return JSON.parse(fs.readFileSync(path.join(root, 'docs/changelog.md'), 'utf8').match(/```json\n([\s\S]*?)\n```/)[1]);
}
function renderChangelog(data = readChangelog()) {
    const lines = ['<!-- CHANGELOG:START -->', '<header class="public-roadmap-intro">',
        '<p class="eyebrow">Product changelog</p>', `<h1>${escape(data.title)}</h1>`,
        `<p class="home-lead">${escape(data.lead)}</p><p>${escape(data.notice)}</p>`,
        '<p><a href="/roadmap.html">Explore the roadmap</a>.</p></header>'];
    for (const [key, label] of [['published', 'Published information and changes'], ['planned', 'Planned — not available yet']]) {
        // An empty planned list renders no section: planned work then lives only on the roadmap.
        if (key === 'planned' && !(data.planned || []).length) continue;
        lines.push(`<section aria-labelledby="changelog-${key}"><h2 id="changelog-${key}">${label}</h2>`);
        // The period labels published entries only; planned work stays undated.
        if (key === 'published') lines.push(`<p class="changelog-period">${escape(data.period)}</p>`);
        lines.push('<div class="public-roadmap-grid">');
        for (const entry of data[key]) {
            lines.push(`<article data-changelog-entry="${escape(entry.id)}"><h3>${escape(entry.title)}</h3>`,
                `<p class="roadmap-status">${key === 'published' ? 'Published' : 'Planned'}</p><p>${escape(entry.text)}</p>`);
            if (entry.link) lines.push(`<p><a href="${escape(entry.link.href)}">${escape(entry.link.label)}</a></p>`);
            // Render only customer copy. PRs, commits and receipts stay in review evidence.
            lines.push('</article>');
        }
        lines.push('</div></section>');
    }
    return [...lines, '<!-- CHANGELOG:END -->'].join('\n');
}
if (require.main === module) {
    const file = path.join(root, 'changelog.html');
    const html = fs.readFileSync(file, 'utf8');
    if (!marker.test(html)) throw new Error('Missing changelog generation markers');
    fs.writeFileSync(file, html.replace(marker, renderChangelog()));
}
module.exports = { readChangelog, renderChangelog, marker };
