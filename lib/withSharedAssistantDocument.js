'use strict';

const { renderSharedAssistant } = require('./sharedAssistantDocument');

const FRY_ASSET = '/images/fry-chat.png';

// Apply after existing document builders: their inline loader, integrity and
// CSP hashes remain exact. The new assets use the already permitted same origin.
function withSharedAssistantDocument(html, page = 'dashboard') {
    if (typeof html !== 'string' || (html.match(/<\/head>/g) || []).length !== 1 ||
        (html.match(/<\/body>/g) || []).length !== 1 ||
        /\bdata-shared-assistant\b|\bid=["'](?:prospect-assistant|nofries-assistant-dialog)["']/.test(html)) {
        throw new TypeError('shared_assistant_document_invalid');
    }
    const markup = renderSharedAssistant({ fryAssetPath: FRY_ASSET, page,
        helpOnly: page !== 'managed-it' });
    const clients = [...html.matchAll(/<script\b[^>]*\bsrc=["']\/js\/prospect-assistant\.js["'][^>]*>[\s\S]*?<\/script>/g)];
    if (clients.length > 1 || /\b(?:src|href)=["']\/(?:js\/shared-assistant\.js|shared-assistant\.css)["']/.test(html)) {
        throw new TypeError('shared_assistant_document_invalid');
    }
    const assets = '<link rel="stylesheet" href="/shared-assistant.css">\n' +
        (clients.length ? '' : '<script src="/js/prospect-assistant.js" defer></script>\n') +
        '<script src="/js/shared-assistant.js" defer></script>\n';
    return html.replace('</head>', assets + '</head>').replace('</body>', markup + '\n</body>');
}

function publicAssistantPage(fileName) {
    if (fileName === 'index.html') return 'home';
    if (fileName === 'managed-it.html') return 'managed-it';
    if (fileName === 'roadmap.html') return 'roadmap';
    return 'dashboard';
}

module.exports = { FRY_ASSET, publicAssistantPage, withSharedAssistantDocument };
