'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');

const hash = (bytes, algorithm = 'sha256', encoding = 'hex') =>
  crypto.createHash(algorithm).update(bytes).digest(encoding);
const invariant = (condition, message) => { if (!condition) throw new Error(message); };

// These two authenticated npm archives contain ordinary regular-file entries.
// Reject links, extensions, traversal, duplicate paths and malformed headers.
function readArchive(bytes) {
  const tar = zlib.gunzipSync(bytes, { maxOutputLength: 8 * 1024 * 1024 });
  const files = new Map();
  let offset = 0;
  const field = (header, start, end) => header.subarray(start, end).toString('utf8').split('\0')[0];
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      invariant(tar.subarray(offset).every(byte => byte === 0), 'unexpected data after tar terminator');
      return files;
    }
    const number = (start, end) => {
      const value = field(header, start, end).trim();
      invariant(/^[0-7]+$/.test(value), 'invalid tar numeric field');
      return parseInt(value, 8);
    };
    const expectedChecksum = number(148, 156);
    const checksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    invariant(checksum === expectedChecksum, 'invalid tar checksum');
    const name = field(header, 0, 100);
    invariant(field(header, 345, 500) === '', 'tar prefixes are not supported');
    invariant(/^package\/[A-Za-z0-9._/-]+$/.test(name) && !name.split('/').some(part => !part || part === '.' || part === '..'), 'invalid tar path');
    invariant(header[156] === 0 || header[156] === 48, 'tar entry must be a regular file');
    invariant(!files.has(name), 'duplicate tar path');
    const size = number(124, 136);
    invariant(Number.isSafeInteger(size) && offset + 512 + size <= tar.length, 'invalid tar size');
    files.set(name, Buffer.from(tar.subarray(offset + 512, offset + 512 + size)));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error('missing tar terminator');
}

function build({ check = false } = {}) {
  const root = __dirname;
  const provenanceBytes = fs.readFileSync(path.join(root, 'PROVENANCE.json'));
  const provenance = JSON.parse(provenanceBytes);
  const upstreamBytes = fs.readFileSync(path.join(root, provenance.upstreamArchive));
  invariant(`sha512-${hash(upstreamBytes, 'sha512', 'base64')}` === provenance.upstreamIntegrity, 'upstream archive integrity mismatch');
  const upstream = readArchive(upstreamBytes);
  invariant(hash(upstream.get('package/lib/rsa.js')) === provenance.originalRsaSha256, 'upstream RSA source mismatch');
  invariant(hash(upstream.get('package/LICENSE')) === provenance.licenseSha256, 'upstream license mismatch');
  invariant(fs.readFileSync(path.join(root, 'LICENSE')).equals(upstream.get('package/LICENSE')), 'retained license differs');
  const patchBytes = fs.readFileSync(path.join(root, 'rsa-digest-validation.patch'));
  invariant(hash(patchBytes) === provenance.patchSha256, 'patch hash mismatch');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-forge-build-'));
  try {
    const packageDirectory = path.join(temporary, 'package');
    fs.mkdirSync(packageDirectory);
    const libNames = [...upstream.keys()].filter(name => name.startsWith('package/lib/')).map(name => name.slice(8)).sort();
    invariant(JSON.stringify(libNames) === JSON.stringify(Object.keys(provenance.packagedLibSha256).sort()), 'library inventory mismatch');
    for (const name of libNames) {
      const destination = path.join(packageDirectory, name);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, upstream.get(`package/${name}`));
    }
    fs.writeFileSync(path.join(packageDirectory, 'LICENSE'), upstream.get('package/LICENSE'));
    fs.writeFileSync(path.join(packageDirectory, 'package.json'), fs.readFileSync(path.join(root, 'package-manifest.json')));
    fs.writeFileSync(path.join(packageDirectory, 'README.md'), fs.readFileSync(path.join(root, 'README.md')));
    fs.writeFileSync(path.join(packageDirectory, 'PROVENANCE.json'), provenanceBytes);
    execFileSync('patch', ['--batch', '--fuzz=0', '-p1', '--input', path.join(root, 'rsa-digest-validation.patch')], { cwd: packageDirectory, stdio: 'pipe' });
    for (const name of libNames) {
      const bytes = fs.readFileSync(path.join(packageDirectory, name));
      invariant(hash(bytes) === provenance.packagedLibSha256[name], `patched library hash mismatch: ${name}`);
      if (name !== 'lib/rsa.js') invariant(bytes.equals(upstream.get(`package/${name}`)), `unexpected source change: ${name}`);
    }
    invariant(hash(fs.readFileSync(path.join(packageDirectory, 'lib/rsa.js'))) === provenance.patchedRsaSha256, 'patched RSA source mismatch');
    const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary], { cwd: packageDirectory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    invariant(packed.length === 1 && packed[0].filename === provenance.artifact, 'unexpected package identity');
    let artifact = fs.readFileSync(path.join(temporary, provenance.artifact));
    const entries = readArchive(artifact);
    const expectedNames = [...libNames.map(name => `package/${name}`), 'package/LICENSE', 'package/package.json', 'package/README.md', 'package/PROVENANCE.json'].sort();
    invariant(JSON.stringify([...entries.keys()].sort()) === JSON.stringify(expectedNames), 'unexpected packaged files');
    for (const name of expectedNames) invariant(entries.get(name).equals(fs.readFileSync(path.join(packageDirectory, name.slice(8)))), `packaged bytes differ: ${name}`);
    const destination = path.join(root, provenance.artifact);
    if (check) {
      // npm/zlib versions may encode identical content differently. Authenticate
      // committed container bytes through the lock; compare every member here.
      artifact = fs.readFileSync(destination);
      const committed = readArchive(artifact);
      invariant(JSON.stringify([...committed.keys()].sort()) === JSON.stringify(expectedNames), 'committed package inventory differs');
      for (const name of expectedNames) invariant(committed.get(name).equals(entries.get(name)), `committed package bytes differ: ${name}`);
    } else fs.writeFileSync(destination, artifact);
    return { artifact: provenance.artifact, sha256: hash(artifact), integrity: `sha512-${hash(artifact, 'sha512', 'base64')}`, files: entries.size };
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

if (require.main === module) {
  invariant(process.argv.slice(2).every(arg => arg === '--check'), 'only --check is supported');
  console.log(JSON.stringify(build({ check: process.argv.includes('--check') })));
}

module.exports = { build, readArchive };
