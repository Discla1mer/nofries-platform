'use strict';

// Self-contained fictional demo page (#29). Default-off: no production builder
// packages demo/, and server.js mounts it only for createNoFriesApp({ tryDemo: true }).
// The CSP forbids every network request, form submission, frame and image.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '../..');
const SOURCES = ['api/shared/protectedAssets/dashboardRegistry.js', 'api/shared/protectedAssets/dashboardShell.js', 'demo/try/try-demo.js'];
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const hash = value => "'sha256-" + crypto.createHash('sha256').update(value).digest('base64') + "'";

function buildTryDemoDocument() {
    const script = SOURCES.map(read).concat('NoFriesTryDemo.start(window);').join('\n');
    const style = read('app/dashboard.css') + '\n' + read('demo/try/try-demo.css');
    if (/<\/(?:script|style)/i.test(script + style)) throw new Error('try_demo_markup_token');
    const contentSecurityPolicy = ["default-src 'none'", 'script-src ' + hash(script), 'style-src ' + hash(style),
        "style-src-attr 'none'", "img-src 'none'", "connect-src 'none'", "form-action 'none'", "base-uri 'none'", "frame-ancestors 'none'"].join('; ');
    const html = '<!doctype html><html lang="en-NZ"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
        '<meta name="robots" content="noindex,nofollow"><title>Try No Fries · Interactive demo (fictional data)</title><style>' + style + '</style></head><body>' +
        '<section class="try-demo-banner" aria-label="About this demo"><div class="try-demo-copy"><strong>Interactive demo · fictional business</strong>' +
        '<p>Brightwater Joinery is made up. Everything stays in this browser: no account, no emails and nothing sent to No Fries.</p></div>' +
        '<div class="try-demo-controls"><button type="button" id="try-demo-reset">Reset demo</button><a href="/">No Fries home</a></div>' +
        '<p id="try-demo-status" class="try-demo-status" role="status"></p></section><div id="try-demo-dashboard"></div><script>' + script + '</script></body></html>';
    return Object.freeze({ html, contentSecurityPolicy });
}

module.exports = { buildTryDemoDocument, SOURCES };
