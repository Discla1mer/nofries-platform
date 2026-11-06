'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

test('isolated production-install regressions', () => {
    const result = spawnSync(process.execPath,
        ['--test', '--test-reporter=tap', 'scripts/tests/check-runtime-install.cjs'],
        { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 30000 });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/# fail 0/);
}, 35000);
