'use strict';

// F1-R08/R06 (#151): one primary-button treatment and one result-card surface
// across the public pages and the dashboard. Source-level evidence only.
const fs = require('node:fs');
const path = require('node:path');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const style = read('style.css'), home = read('home.css'), dashboard = read('app/dashboard.css');
const rule = (css, selector) => {
    const match = new RegExp('(^|\\n)' + selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\{').exec(css);
    const start = match ? match.index : -1;
    expect(start).toBeGreaterThanOrEqual(0);
    return css.slice(start, css.indexOf('}', start));
};

test('style.css defines the shared button and result-card tokens', () => {
    for (const token of ['--button-font: var(--font-sans)', '--button-weight: 600', '--button-radius: 999px',
        '--button-fill: var(--yellow)', '--button-focus-ring: 3px solid var(--focus)', '--result-card-surface: var(--paper)',
        '--result-card-shadow:']) expect(style).toContain(token);
});

test('public, homepage and dashboard primary buttons all use the shared tokens', () => {
    const publicButton = rule(style, '.button');
    for (const token of ['--button-radius', '--button-fill', '--button-font', '--button-size', '--button-weight']) expect(publicButton).toContain(`var(${token})`);
    const homepage = rule(home, '#gatewayPublic .homepage-primary');
    for (const token of ['--button-radius', '--button-fill', '--button-font', '--button-size-large', '--button-weight']) expect(homepage).toContain(`var(${token})`);
    expect(homepage).not.toMatch(/border-radius: 10px|font-weight: 700/);
    expect(dashboard).toContain('.dashboard-button:not(.dashboard-button-secondary) { border-color: var(--button-fill, #dbb157); background: var(--button-fill, #dbb157)');
    expect(dashboard).toContain('font-weight: var(--button-weight, 600) !important');
    const firstUse = rule(dashboard, '.picture-first-use-action');
    expect(firstUse).toContain('var(--button-font');
    expect(firstUse).not.toContain('--font-serif');
});

test('the public example reuses the saved-result card surface and keeps its notice prominent', () => {
    const cards = rule(home, '.sample-result :is(.public-roadmap-grid > article, .sample-result-gaps > li)');
    for (const token of ['--result-card-surface', '--result-card-shadow', '--result-card-radius']) expect(cards).toContain(`var(${token})`);
    expect(dashboard).toContain('box-shadow: var(--result-card-shadow,');
    expect(read('sample-result.html')).toContain('<p class="sample-result-banner"><strong>Example only — fictional business.</strong>');
});
