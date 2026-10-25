'use strict';

// This source/provenance check is independent of registry advisory matching.
// The local identity does not inherit upstream adm-zip advisory records.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const ROOT = path.resolve(__dirname, '..');
const VENDOR = path.join(ROOT, 'vendor', 'adm-zip-memory-only');
const SOURCE = path.join(VENDOR, 'source');
const UPSTREAM_FILE = 'upstream-adm-zip-0.6.0.tgz';
const FORK_FILE = 'adm-zip-memory-only-0.6.0-memory-only.1.tgz';
const LOCAL_SPEC = `file:vendor/adm-zip-memory-only/${FORK_FILE}`;
const UPSTREAM_INTEGRITY = 'sha512-XleryMhbuksdKtofnWZ9Sk+4CUTbms4Mb/EU32SZwToAyZ5RgVos/ki8n+yr0LWHOGKuakbXTuuYNHLQjhddgg==';
const ADVISORY = 'https://github.com/advisories/GHSA-vwc7-r8mq-g2x9';
const FILES = Object.freeze([
    'LICENSE', 'README.md', 'adm-zip.js', 'headers/entryHeader.js',
    'headers/index.js', 'headers/mainHeader.js', 'methods/deflater.js',
    'methods/index.js', 'methods/inflater.js', 'methods/zipcrypto.js',
    'package.json', 'types.d.ts', 'util/constants.js', 'util/decoder.js',
    'util/errors.js', 'util/fattr.js', 'util/index.js', 'util/utils.js',
    'zipEntry.js', 'zipFile.js',
].sort());
const MODIFIED = Object.freeze(['README.md', 'adm-zip.js', 'package.json', 'types.d.ts', 'util/utils.js'].sort());
const digest = (buffer, algorithm = 'sha256', encoding = 'hex') => crypto.createHash(algorithm).update(buffer).digest(encoding);
const integrity = (buffer) => `sha512-${digest(buffer, 'sha512', 'base64')}`;
const fail = (message) => { throw new Error(`adm-zip-memory-only provenance: ${message}`); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function octal(header, start, length) {
    const value = header.subarray(start, start + length).toString('ascii').replace(/[\0 ]+$/g, '').replace(/^ +/, '');
    if (!/^[0-7]+$/.test(value)) fail('invalid tar numeric field');
    const result = Number.parseInt(value, 8);
    if (!Number.isSafeInteger(result)) fail('unsafe tar numeric field');
    return result;
}

function readTarGz(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length > 512 * 1024) fail('invalid or oversized tarball');
    const tar = zlib.gunzipSync(buffer, { maxOutputLength: 4 * 1024 * 1024 });
    const result = new Map();
    let offset = 0;
    while (offset + 512 <= tar.length) {
        const header = tar.subarray(offset, offset + 512);
        if (header.every((byte) => byte === 0)) {
            if (tar.length - offset < 1024 || !tar.subarray(offset).every((byte) => byte === 0)) fail('invalid tar trailer');
            return result;
        }
        const checksum = octal(header, 148, 8);
        let actual = 0;
        for (let i = 0; i < 512; i += 1) actual += i >= 148 && i < 156 ? 32 : header[i];
        if (checksum !== actual) fail('invalid tar checksum');
        if (header[156] !== 0 && header[156] !== 48) fail('only regular tar files are allowed');
        if (header.subarray(345, 500).some((byte) => byte !== 0)) fail('tar path prefixes are unsupported');
        const nameField = header.subarray(0, 100);
        const zero = nameField.indexOf(0);
        const name = nameField.subarray(0, zero < 0 ? nameField.length : zero).toString('utf8');
        if (!/^package\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(name) || name.split('/').some((part) => part === '.' || part === '..')) fail('invalid tar file path');
        const relative = name.slice('package/'.length);
        if (result.has(relative)) fail('duplicate tar path');
        if (octal(header, 100, 8) !== 0o644) fail('unexpected tar file mode');
        const size = octal(header, 124, 12);
        const start = offset + 512;
        if (size > 1024 * 1024 || start + size > tar.length) fail('invalid tar file length');
        result.set(relative, Buffer.from(tar.subarray(start, start + size)));
        offset = start + Math.ceil(size / 512) * 512;
    }
    fail('missing tar trailer');
}

function readSource() {
    const names = [];
    function visit(directory, prefix = '') {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const relative = prefix + entry.name;
            if (entry.isSymbolicLink()) fail('source symlinks are forbidden');
            if (entry.isDirectory()) visit(path.join(directory, entry.name), `${relative}/`);
            else if (entry.isFile()) names.push(relative);
            else fail('unexpected source file type');
        }
    }
    visit(SOURCE);
    if (!same(names.sort(), FILES)) fail('source inventory differs');
    return new Map(FILES.map((name) => [name, fs.readFileSync(path.join(SOURCE, name))]));
}

function crc32(buffer) {
    let crc = 0xffffffff;
    for (const byte of buffer) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

// Fixed stored DEFLATE blocks avoid differences between compression-library versions.
function deterministicGzip(buffer) {
    const chunks = [Buffer.from([31, 139, 8, 0, 0, 0, 0, 0, 0, 255])];
    for (let offset = 0; offset < buffer.length; offset += 65535) {
        const size = Math.min(65535, buffer.length - offset);
        const header = Buffer.alloc(5);
        header[0] = offset + size === buffer.length ? 1 : 0;
        header.writeUInt16LE(size, 1);
        header.writeUInt16LE(size ^ 0xffff, 3);
        chunks.push(header, buffer.subarray(offset, offset + size));
    }
    const trailer = Buffer.alloc(8);
    trailer.writeUInt32LE(crc32(buffer), 0);
    trailer.writeUInt32LE(buffer.length >>> 0, 4);
    chunks.push(trailer);
    return Buffer.concat(chunks);
}

function buildTarGz(files) {
    const chunks = [];
    for (const name of FILES) {
        const content = files.get(name);
        const header = Buffer.alloc(512);
        const put = (value, offset, length) => {
            if (Buffer.byteLength(value) > length) fail('tar field too long');
            header.write(value, offset, length, 'ascii');
        };
        put(`package/${name}`, 0, 100);
        put('0000644\0', 100, 8);
        put('0000000\0', 108, 8);
        put('0000000\0', 116, 8);
        put(`${content.length.toString(8).padStart(11, '0')}\0`, 124, 12);
        put('00000000000\0', 136, 12);
        header.fill(32, 148, 156);
        header[156] = 48;
        put('ustar\0', 257, 6);
        put('00', 263, 2);
        const sum = header.reduce((total, value) => total + value, 0);
        put(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
        chunks.push(header, content, Buffer.alloc((512 - content.length % 512) % 512));
    }
    chunks.push(Buffer.alloc(1024));
    return deterministicGzip(Buffer.concat(chunks));
}

function inspectSource() {
    const originalTarball = fs.readFileSync(path.join(VENDOR, UPSTREAM_FILE));
    if (integrity(originalTarball) !== UPSTREAM_INTEGRITY) fail('upstream tarball integrity differs');
    const original = readTarGz(originalTarball);
    if (!same([...original.keys()].sort(), FILES)) fail('upstream inventory differs');
    const source = readSource();
    const changed = FILES.filter((name) => !source.get(name).equals(original.get(name)));
    if (!same(changed, MODIFIED)) fail('unapproved upstream source delta');
    const metadata = JSON.parse(source.get('package.json').toString('utf8'));
    if (metadata.name !== 'adm-zip-memory-only' || metadata.version !== '0.6.0-memory-only.1' || metadata.private !== true || metadata.license !== 'MIT' || metadata.scripts || metadata.dependencies || metadata.optionalDependencies || metadata.devDependencies) fail('fork identity or dependency contract differs');
    if (metadata.upstreamSource?.integrity !== UPSTREAM_INTEGRITY || metadata.upstreamSource?.advisory !== ADVISORY) fail('upstream/advisory linkage missing');
    const tarball = buildTarGz(source);
    const provenance = {
        schemaVersion: 1,
        capability: 'Disk extraction/archive writes retired; memory and filesystem reads retained.',
        upstream: { name: 'adm-zip', version: '0.6.0', tarball: 'https://registry.npmjs.org/adm-zip/-/adm-zip-0.6.0.tgz', artifact: UPSTREAM_FILE, integrity: UPSTREAM_INTEGRITY, advisory: ADVISORY },
        fork: { name: metadata.name, version: metadata.version, private: true, published: false, artifact: FORK_FILE, integrity: integrity(tarball), sha256: digest(tarball), bytes: tarball.length, registryAuditCoversUpstreamIdentity: false },
        sourceChanges: MODIFIED,
        files: FILES.map((name) => ({ path: name, upstreamSha256: digest(original.get(name)), forkSha256: digest(source.get(name)), upstreamBytes: original.get(name).length, forkBytes: source.get(name).length })),
    };
    return { source, tarball, provenance };
}

function verifyVendor() {
    const inspected = inspectSource();
    const recorded = JSON.parse(fs.readFileSync(path.join(VENDOR, 'provenance.json'), 'utf8'));
    if (!same(recorded, inspected.provenance)) fail('provenance manifest differs');
    const artifact = fs.readFileSync(path.join(VENDOR, FORK_FILE));
    if (!artifact.equals(inspected.tarball)) fail('fork artifact is not the deterministic source build');
    const packed = readTarGz(artifact);
    if (!same([...packed.keys()].sort(), FILES) || FILES.some((name) => !packed.get(name).equals(inspected.source.get(name)))) fail('fork tarball/source bytes differ');
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    if (manifest.overrides?.['@huggingface/transformers']?.['onnxruntime-node']?.['adm-zip'] !== LOCAL_SPEC) fail('nested override differs');
    if (manifest.devDependencies?.['adm-zip'] !== LOCAL_SPEC) fail('root development artifact reference differs');
    const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
    const nodes = Object.entries(lock.packages).filter(([name, entry]) => name.endsWith('/adm-zip') || entry.name === 'adm-zip-memory-only');
    if (nodes.length !== 1 || nodes[0][1].resolved !== LOCAL_SPEC || nodes[0][1].integrity !== integrity(artifact) || nodes[0][1].version !== '0.6.0-memory-only.1' || nodes[0][1].name !== 'adm-zip-memory-only' || nodes[0][1].dev !== true || nodes[0][1].optional === true) fail('effective locked fork differs');
    return { verified: true, sourceFiles: FILES.length, unchangedUpstreamFiles: FILES.length - MODIFIED.length, forkIntegrity: integrity(artifact), upstreamAdvisory: ADVISORY, upstreamAdvisoryRemediationRequiresCausalTests: true };
}

if (require.main === module) {
    try {
        if (process.argv.length === 3 && process.argv[2] === '--repack') {
            const inspected = inspectSource();
            fs.writeFileSync(path.join(VENDOR, FORK_FILE), inspected.tarball);
            fs.writeFileSync(path.join(VENDOR, 'provenance.json'), `${JSON.stringify(inspected.provenance, null, 2)}\n`);
            process.stdout.write('Repacked source/provenance; regenerate the lock and run verification before use.\n');
        } else if (process.argv.length === 2) {
            process.stdout.write(`${JSON.stringify(verifyVendor())}\n`);
        } else fail('unsupported arguments');
    } catch (error) {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    }
}

module.exports = Object.freeze({ readTarGz, verifyVendor });
