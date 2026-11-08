'use strict';

// Synthetic fixture generation. Neither production builder copies this output.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { scenarios } = require('../test/fixtures/dashboardFixture');
const { buildJourney, previewApplication, createSyntheticTransport } = require('./dashboard-preview-journey');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'test/fixtures/dashboard-preview.html');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
function renderPreview(revision = 'local') {
    if (!/^(?:local|[a-f0-9]{40}(?:-dirty)?)$/.test(revision)) throw new Error('Invalid preview revision');
    const json = value => JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    const script = ['dashboardRegistry', 'dashboardShell', 'ncscAssessmentClient', 'ncscQuestionnaire',
        'assessmentExplanation', 'organisationPicture', 'improvementActionPlanView']
        .map(name => read('api/shared/protectedAssets/' + name + '.js')).join('\n') + '\n' +
        `(${previewApplication.toString()})(${json(scenarios())}, ${json(buildJourney())}, ${createSyntheticTransport.toString()});`;
    if (/<\/script/i.test(script)) throw new Error('Preview script contains a closing-script token');
    const style = read('app/dashboard.css') + '\nbody { margin: 0; } .fixture-banner { font: 1rem/1.5 system-ui; padding: 1rem; background: #fff2b8; color: #102a43; display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; } .fixture-banner p { margin: 0; } .fixture-banner code { overflow-wrap: anywhere; } .fixture-banner select, .fixture-banner button { font: inherit; padding: .5rem; max-width: 100%; min-height: 44px; } .fixture-banner :focus-visible { outline: 3px solid #0069bc; outline-offset: 3px; }';
    const previewStyle = style + '\n.dashboard-cyber-workspace > button, .dashboard-picture-workspace > button, .dashboard-improvement-workspace > button { margin: .25rem .5rem .5rem 0; }';
    const hash = value => 'sha256-' + crypto.createHash('sha256').update(value).digest('base64');
    const csp = `default-src 'none'; script-src '${hash(script)}'; style-src '${hash(previewStyle)}'; base-uri 'none'; form-action 'none'; connect-src 'none'`;
    const html = `<!doctype html><html lang="en-NZ"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta http-equiv="Content-Security-Policy" content="${csp}"><title>No Fries · Synthetic dashboard preview</title><style>${previewStyle}</style></head><body><header class="fixture-banner"><div><strong>DEV / synthetic data</strong><p>Synthetic development preview. No live customer data. Nothing here submits, purchases or activates a real service.</p><p>Practice saves last only in this tab. Reload, Reset or changing scenario discards all practice work. Seeded results and plans are separate examples, unrelated to entered answers.</p><p>Commit: <code id="preview-revision">${revision}</code></p></div><label for="scenario">View scenario</label><select id="scenario"></select><button id="reset" type="button">Reset preview</button><p id="preview-status" role="status"></p></header><div id="dashboard"></div><script>${script}</script></body></html>`;
    return { html, contentSecurityPolicy: csp };
}

if (require.main === module) {
    fs.writeFileSync(output, renderPreview().html);
    console.log('Built synthetic development preview: test/fixtures/dashboard-preview.html');
}
module.exports = { renderPreview };
