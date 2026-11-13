'use strict';

// Self-contained fictional demo page (#29). It runs the real dashboard shell,
// questionnaire and results, scored by the real evaluator, against
// an in-memory assessment store. The CSP forbids every network request,
// form submission, frame and image. server.js serves it only for
// createNoFriesApp({ tryDemo: true }); the static build publishes it at /try.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '../..');
// The same protected assets the signed-in dashboard loads (scripts/build-static.js gateway bundle).
const SOURCES = ['api/shared/protectedAssets/dashboardRegistry.js', 'api/shared/protectedAssets/dashboardShell.js',
    'api/shared/protectedAssets/ncscAssessmentClient.js', 'api/shared/protectedAssets/ncscQuestionnaire.js',
    'demo/try/node-shims.js', 'demo/try/try-demo.js'];
// Server modules bundled unchanged so the page scores with the real rules.
const ENGINE_ENTRIES = ['api/shared/assessmentEngine/ncscAssessmentEvaluator.js', 'api/shared/assessmentEngine/assessmentEvaluator.js',
    'api/shared/ncscQuestionnaireMetadata.js'];
const BUILT_INS = { crypto: 'crypto', 'node:crypto': 'crypto', util: 'util', 'node:util': 'util' };
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const hash = value => "'sha256-" + crypto.createHash('sha256').update(value).digest('base64') + "'";

function engineModules() {
    const modules = new Map();
    function visit(file) {
        if (modules.has(file)) return;
        const source = read(file), requires = {};
        modules.set(file, { source, requires });
        for (const [, request] of source.matchAll(/require\('([^']+)'\)/g)) {
            if (Object.hasOwn(BUILT_INS, request)) { requires[request] = BUILT_INS[request]; continue; }
            if (!request.startsWith('.')) throw new Error('try_demo_engine_dependency');
            const target = path.posix.join(path.posix.dirname(file), request + (request.endsWith('.js') ? '' : '.js'));
            requires[request] = target; visit(target);
        }
    }
    ENGINE_ENTRIES.forEach(visit);
    return modules;
}

function engineBundle() {
    const definitions = [...engineModules()].map(([file, module]) => JSON.stringify(file) + ': [' + JSON.stringify(module.requires) +
        ', function (module, exports, require, Buffer) {\n' + module.source + '\n}]').join(',\n');
    return '(function (root) {\n"use strict";\nconst definitions = {\n' + definitions + '\n};\n' +
        'const shims = root.NoFriesTryNodeShims, cache = {};\n' +
        'function load(file) {\n    if (cache[file]) return cache[file].exports;\n    const module = { exports: {} }; cache[file] = module;\n' +
        '    const entry = definitions[file];\n    entry[1].call(module.exports, module, module.exports, function (request) {\n' +
        '        const target = entry[0][request];\n        return target === "crypto" || target === "util" ? shims[target] : load(target);\n' +
        '    }, shims.Buffer);\n    return module.exports;\n}\n' +
        'root.NoFriesTryEngine = function () {\n    return { evaluator: load(' + JSON.stringify(ENGINE_ENTRIES[0]) + '), core: load(' +
        JSON.stringify(ENGINE_ENTRIES[1]) + '),\n        metadata: load(' + JSON.stringify(ENGINE_ENTRIES[2]) + ').createNcscQuestionnaireMetadata(),\n' +
        '        sha256: function (text) { return shims.crypto.createHash("sha256").update(text, "utf8").digest("hex"); } };\n};\n' +
        '}(globalThis));';
}

function buildTryDemoDocument() {
    const script = SOURCES.map(read).concat(engineBundle(), 'NoFriesTryDemo.start(window);').join('\n');
    const style = read('app/dashboard.css') + '\n' + read('demo/try/try-demo.css');
    if (/<\/(?:script|style)/i.test(script + style)) throw new Error('try_demo_markup_token');
    const contentSecurityPolicy = ["default-src 'none'", 'script-src ' + hash(script), 'style-src ' + hash(style),
        "style-src-attr 'none'", "img-src 'none'", "connect-src 'none'", "form-action 'none'", "base-uri 'none'", "frame-ancestors 'none'"].join('; ');
    const html = '<!doctype html><html lang="en-NZ"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
        '<meta name="robots" content="noindex,nofollow"><title>Try No Fries · Interactive demo (fictional data)</title><style>' + style + '</style></head><body>' +
        '<section class="try-demo-banner" aria-label="About this demo"><div class="try-demo-copy"><strong>Interactive demo · fictional business</strong>' +
        '<p>Brightwater Joinery is made up. This is the real dashboard and the full assessment, but everything stays in this browser: no account, no emails and nothing sent to No Fries.</p></div>' +
        '<div class="try-demo-controls"><button type="button" id="try-demo-reset">Reset demo</button><a class="try-demo-cta" href="/login?intent=create">Create your account</a>' +
        '<a href="/contact.html">Talk to No Fries</a><a href="/">No Fries home</a></div>' +
        '<p id="try-demo-status" class="try-demo-status" role="status"></p></section><div id="try-demo-dashboard"></div><script>' + script + '</script></body></html>';
    return Object.freeze({ html, contentSecurityPolicy });
}

module.exports = { buildTryDemoDocument, SOURCES, ENGINE_ENTRIES, engineModules, engineBundle };
