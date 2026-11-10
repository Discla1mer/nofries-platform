'use strict';
// Independent policy expansion used to compare every effective fetch rule,
// including rules with longer CSP fallback chains that the builder never edits.
module.exports = function effectiveCsp(policy) {
    const values = {};
    for (const part of policy.split(';').map(value => value.trim()).filter(Boolean)) {
        const [key, ...tokens] = part.split(/\s+/); if (!Object.hasOwn(values, key)) values[key] = tokens.join(' ');
    }
    const chains = { 'child-src': ['default-src'], 'object-src': ['default-src'], 'connect-src': ['default-src'],
        'img-src': ['default-src'], 'font-src': ['default-src'], 'media-src': ['default-src'], 'manifest-src': ['default-src'],
        'script-src': ['default-src'], 'style-src': ['default-src'], 'frame-src': ['child-src', 'default-src'],
        'worker-src': ['child-src', 'script-src', 'default-src'], 'script-src-attr': ['script-src', 'default-src'],
        'script-src-elem': ['script-src', 'default-src'], 'style-src-attr': ['style-src', 'default-src'], 'style-src-elem': ['style-src', 'default-src'] };
    const expanded = { ...values };
    for (const [key, fallback] of Object.entries(chains)) {
        const selected = [key, ...fallback].find(name => Object.hasOwn(values, name)); expanded[key] = selected ? values[selected] : null;
    }
    return Object.fromEntries(Object.entries(expanded).sort(([a], [b]) => a.localeCompare(b)));
};
