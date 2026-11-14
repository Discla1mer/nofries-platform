'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const testCase = globalThis.test || require('node:test').test;
const css = fs.readFileSync(path.join(__dirname, '../managed-it.css'), 'utf8');
const tokens = fs.readFileSync(path.join(__dirname, '../style.css'), 'utf8');
const pricing = css.slice(css.indexOf('/* Plans & pricing'));
const rule = selector => pricing.match(new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]+)\\}'))[1];

function rgb(token) {
    const hex = tokens.match(new RegExp('--' + token + ': #([a-f0-9]{6})'))[1];
    return hex.match(/../g).map(value => parseInt(value, 16) / 255);
}
function luminance(token) {
    return rgb(token).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
        .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
}
function contrast(a, b) {
    const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (values[0] + 0.05) / (values[1] + 0.05);
}

testCase('pricing cards and recommendation use the shared warm palette', () => {
    assert.match(rule('.managed-it-tier'), /background: var\(--paper\)/);
    assert.match(rule('.managed-it-tier'), /border-radius: var\(--radius\)/);
    assert.match(rule('.managed-it-tier.is-recommended'), /border-color: var\(--green\)/);
    assert.match(rule('.managed-it-main .managed-it-tier-badge'), /color: var\(--ink\)/);
    assert.match(rule('.managed-it-main .managed-it-tier-badge'), /background: var\(--yellow\)/);
    assert.doesNotMatch(pricing, /#(?:fff|1f6feb)\b|rgba\(15, 23, 42|rgba\(31, 111, 235|var\(--accent/);
});

testCase('pricing text and secondary actions remain readable on warm surfaces', () => {
    assert.match(rule('.managed-it-tier-basis'), /color: var\(--muted\)/);
    assert.match(rule('.managed-it-tier .button-secondary'), /color: var\(--ink\)/);
    assert.match(rule('.managed-it-tier .button-secondary:hover'), /background: var\(--yellow-soft\)/);
    for (const [foreground, background] of [['ink', 'yellow'], ['ink', 'paper'], ['ink', 'yellow-soft'], ['muted', 'paper']]) {
        assert.ok(contrast(foreground, background) >= 4.5, `${foreground}/${background} text contrast`);
    }
    assert.ok(contrast('control', 'paper') >= 3, 'secondary button border contrast');
    assert.ok(contrast('focus', 'paper') >= 3, 'shared keyboard focus contrast');
});
