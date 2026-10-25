'use strict';

// Local-only fixture generation. Neither release builder copies this output.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { scenarios } = require('../test/fixtures/dashboardFixture');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'test/fixtures/dashboard-preview.html');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const json = JSON.stringify(scenarios()).replace(/</g, '\\u003c');
const script = [read('api/shared/protectedAssets/dashboardRegistry.js'), read('api/shared/protectedAssets/dashboardShell.js'),
    `const fixtures = ${json};`, `
const selector = document.getElementById('scenario');
Object.keys(fixtures).forEach(function (name) { const option = document.createElement('option'); option.textContent = name; option.value = name; selector.append(option); });
function select() { NoFriesDashboard.mount(document.getElementById('dashboard'), fixtures[selector.value], { initialRoute: '' }); }
selector.addEventListener('change', select); select();
`].join('\n');
if (/<\/script/i.test(script)) throw new Error('Preview script contains a closing-script token');
const style = read('app/dashboard.css') + '\nbody { margin: 0; } .fixture-banner { font: 1rem/1.5 system-ui; padding: 1rem; background: #fff2b8; color: #102a43; display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; } .fixture-banner p { margin: 0; } .fixture-banner select { font: inherit; padding: .5rem; max-width: 100%; }';
const hash = value => 'sha256-' + crypto.createHash('sha256').update(value).digest('base64');
const csp = `default-src 'none'; script-src '${hash(script)}'; style-src '${hash(style)}'; base-uri 'none'; form-action 'none'; connect-src 'none'`;
const html = `<!doctype html><html lang="en-NZ"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta http-equiv="Content-Security-Policy" content="${csp}"><title>No Fries · Synthetic dashboard preview</title><style>${style}</style></head><body><header class="fixture-banner"><div><strong>Synthetic development preview</strong><p>No live customer data. Nothing here submits, purchases or activates a service.</p></div><label for="scenario">View scenario</label><select id="scenario"></select></header><div id="dashboard"></div><script>${script}</script></body></html>`;
fs.writeFileSync(output, html);
console.log('Built synthetic development preview: test/fixtures/dashboard-preview.html');
