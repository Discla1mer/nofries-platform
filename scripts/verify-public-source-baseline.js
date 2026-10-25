'use strict';

// The temporary dependency disposition permits exactly the exported source,
// dependency closure and authentication exposure. A new Git history cannot use
// private commit ancestry, so any source addition, removal or byte change fails.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');
const BASELINE = 'security/public-source-baseline.json';
// Filled once after final verification; changing this value requires the same
// bounded security review as changing the dependency-policy implementation.
const REVIEWED_MANIFEST_SHA256 = '9eb8ec642aae5c6fcbc95c5faec778bc729d9abe8ddd13a51c6828e2a6b97fbd';
const VERIFIER = 'scripts/verify-public-source-baseline.js';
const IGNORED = new Set(['.git', 'node_modules', 'dist', 'app-service-dist', 'coverage', 'eval-results']);
function inventory(root) {
    const result = {};
    function visit(relative) {
        for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
            if (!relative && IGNORED.has(entry.name)) continue;
            const name = relative ? relative + '/' + entry.name : entry.name;
            if (name === BASELINE || name === VERIFIER) continue;
            if (entry.isSymbolicLink()) throw new Error('public_source_symlink_forbidden');
            if (entry.isDirectory()) visit(name);
            else if (entry.isFile()) result[name] = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex');
            else throw new Error('public_source_type_forbidden');
        }
    }
    visit('');
    return Object.fromEntries(Object.entries(result).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0));
}
function manifestDigest(expected) {
    return crypto.createHash('sha256').update(JSON.stringify(expected)).digest('hex');
}
function verify(root = ROOT, expected = JSON.parse(fs.readFileSync(path.join(root, BASELINE))), reviewedDigest = REVIEWED_MANIFEST_SHA256) {
    if (manifestDigest(expected) !== reviewedDigest) throw new Error('public_source_baseline_not_reviewed');
    if (expected.schemaVersion !== 1 || expected.sourceHead !== 'a32e1e87be666d5d58b6aba3849f4488de81b821' ||
        expected.expiresAt !== '2026-10-27T00:00:00Z' || !expected.files || !Object.keys(expected.files).length)
        throw new Error('public_source_baseline_invalid');
    if (JSON.stringify(inventory(root)) !== JSON.stringify(expected.files))
        throw new Error('temporary MSAL exception source exposure changed from the exact public export');
}
if (require.main === module) verify();
module.exports = { inventory, verify, manifestDigest };
