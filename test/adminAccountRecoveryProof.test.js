'use strict';

const { execFileSync } = require('node:child_process');
const path = require('node:path');

test('bounded account recovery preserves unrelated members and rejects unproven history', () => {
    const script = path.join(__dirname, '..', 'scripts', 'tests', 'admin-account-recovery-proof.cjs');
    const output = execFileSync(process.execPath, [script], { encoding: 'utf8', timeout: 30000 });
    expect(output).toContain('fail 0');
    expect(output).toContain('128 intervening revisions qualify; 129 fail closed');
});
