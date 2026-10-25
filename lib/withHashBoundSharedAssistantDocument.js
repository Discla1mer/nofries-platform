'use strict';

const { createHash } = require('node:crypto');
const { withSharedAssistantDocument } = require('./withSharedAssistantDocument');

const hashSource = source => `'sha256-${createHash('sha256').update(source).digest('base64')}'`;

// Signup deliberately permits exact hashes, not every same-origin script. Keep
// its original auth runtime untouched and bind the existing public helpers as a
// separate exact bundle, after their markup. HTML and policy travel together.
function withHashBoundSharedAssistantDocument(document, { prospectSource, sharedSource } = {}) {
    if (!document || typeof document.html !== 'string' || typeof document.runtime !== 'string' ||
        typeof document.contentSecurityPolicy !== 'string') {
        throw new TypeError('shared_assistant_hash_document_invalid');
    }
    for (const source of [prospectSource, sharedSource]) {
        if (typeof source !== 'string' || !source.trim() || /<\/script/i.test(source)) {
            throw new TypeError('shared_assistant_hash_source_invalid');
        }
    }
    const originalTag = `<script>${document.runtime}</script>`;
    const originalDirective = `script-src ${hashSource(document.runtime)}`;
    const scriptDirectives = document.contentSecurityPolicy.split(';').map(value => value.trim())
        .filter(value => /^script-src(?:\s|$)/.test(value));
    if (document.html.split(originalTag).length !== 2 || scriptDirectives.length !== 1 ||
        scriptDirectives[0] !== originalDirective) {
        throw new TypeError('shared_assistant_hash_binding_invalid');
    }
    let html = withSharedAssistantDocument(document.html);
    for (const source of ['/js/prospect-assistant.js', '/js/shared-assistant.js']) {
        const tag = `<script src="${source}" defer></script>\n`;
        if (html.split(tag).length !== 2) throw new TypeError('shared_assistant_hash_binding_invalid');
        html = html.replace(tag, '');
    }
    const publicHelpRuntime = `${prospectSource}\n;\n${sharedSource}`;
    const publicHelpScriptHash = hashSource(publicHelpRuntime);
    html = html.replace('</body>', () => `<script id="nofriesPublicHelpRuntime">${publicHelpRuntime}</script>\n</body>`);
    const contentSecurityPolicy = document.contentSecurityPolicy.replace(originalDirective,
        `${originalDirective} ${publicHelpScriptHash}`);
    return Object.freeze({ ...document, html, contentSecurityPolicy, publicHelpRuntime, publicHelpScriptHash });
}

module.exports = { withHashBoundSharedAssistantDocument };
