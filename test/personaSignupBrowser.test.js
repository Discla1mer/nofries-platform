'use strict';
// Required in the existing full application suite. Missing Chromium fails;
// there is no skip, package install or workflow dispatch fallback.
const { execFileSync } = require('node:child_process');
test('Chromium signup journey at 1280/320px and 100%/200% text', () => {
    const output = execFileSync(process.execPath, ['scripts/tests/persona-signup-browser.cjs'],
        { cwd: require('node:path').join(__dirname, '..'), encoding: 'utf8', timeout: 180000, maxBuffer: 1024 * 1024 });
    const result = JSON.parse(output); expect(result.measurements).toHaveLength(4);
    console.log('Persona signup Chromium evidence: ' + JSON.stringify(result));
}, 190000);
