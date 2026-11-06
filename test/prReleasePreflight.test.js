'use strict';
const { spawnSync } = require('node:child_process');
const path = require('node:path');
test('PR release pre-flight regression suite', () => {
    const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'scripts/tests/pr-release-preflight.cjs'], {
        cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 30000
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).toContain('# fail 0');
});
