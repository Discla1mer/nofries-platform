'use strict';
// Explicit source-only qualification; never discovers credentials or endpoints.
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const root = path.resolve(__dirname, '../..');
const file = path.join(root, 'test/integration/consultantReaderCompatibilityPostgres.js');
const writerIndex = args.indexOf('--writer-root');
const writerRoot = writerIndex < 0 ? null : args[writerIndex + 1];
const readerIndex = args.indexOf('--reader-root');
const readerRoot = readerIndex < 0 ? root : args[readerIndex + 1];
if (args.includes('--generate')) {
    require(file).generateFrozenFixtures(writerRoot).then(result => console.log(JSON.stringify(result)))
        .catch(error => { console.error(error); process.exitCode = 1; });
} else {
    const child = spawnSync(process.execPath, ['--test', file], { cwd: root, stdio: 'inherit',
        env: { ...process.env, NOFRIES_COMPAT_READER_ROOT: readerRoot,
            ...(writerRoot ? { NOFRIES_COMPAT_WRITER_ROOT: writerRoot } : {}) } });
    process.exitCode = child.status ?? 1;
}
