'use strict';

// Run this launcher from the clean, independently reviewed checkout. The expected
// digest must come from that reviewed Git blob, not from an unreviewed local file.
// Hash and compile the SAME immutable string before any candidate inspection.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const SOURCE = path.join(__dirname, 'dashboard-conditional-access-candidate.js');
function loadVerified(source, expectedDigest) {
    if (typeof source !== 'string' || !/^[a-f0-9]{64}$/.test(expectedDigest || '')) throw new Error('candidate_source_invalid');
    const digest = crypto.createHash('sha256').update(source, 'utf8').digest('hex');
    if (digest !== expectedDigest) throw new Error('candidate_source_invalid');
    const compiled = new Module(SOURCE, module);
    compiled.filename = SOURCE;
    compiled.paths = module.paths;
    compiled._compile(source, SOURCE);
    return Object.freeze({ inspect: (directory, state) => ({ ...compiled.exports.inspect(directory, state), validatorSha256: digest }) });
}
function run(directory, state, expectedDigest) {
    const bytes = fs.readFileSync(SOURCE);
    const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    // Ensure the digest identifies exact source bytes, including any BOM.
    if (!Buffer.from(source, 'utf8').equals(bytes)) throw new Error('candidate_source_invalid');
    return loadVerified(source, expectedDigest).inspect(directory, state);
}
if (require.main === module) {
    try {
        if (process.argv.length !== 5) throw new Error();
        const result = run(process.argv[2], process.argv[3], process.argv[4]);
        process.stdout.write(JSON.stringify(result) + '\n');
        process.exitCode = result.passed ? 0 : 1;
    } catch (_) {
        process.stderr.write('{"code":"candidate_source_arguments_or_read_failed"}\n');
        process.exitCode = 1;
    }
}
module.exports = { loadVerified, run };
