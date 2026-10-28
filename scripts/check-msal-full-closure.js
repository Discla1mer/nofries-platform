'use strict';
// Required supplemental remediation evidence: run after full exact-lock root
// and API installs. Public CI's ordinary --omit=optional install is separate.
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
execFileSync(process.execPath, [path.join(root, 'node_modules/jest/bin/jest.js'),
    '--runInBand', 'test/msalRemediationCompatibility.test.js'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, NOFRIES_FULL_MSAL_CLOSURE: 'true' }
});
