const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const VENDOR = path.resolve(__dirname, '../vendor/adm-zip-memory-only');
const DISABLED = 'ADM_ZIP_DISK_CAPABILITY_DISABLED';
const UPSTREAM_INTEGRITY = 'sha512-XleryMhbuksdKtofnWZ9Sk+4CUTbms4Mb/EU32SZwToAyZ5RgVos/ki8n+yr0LWHOGKuakbXTuuYNHLQjhddgg==';
const MUTATIONS = [
    'appendFile', 'appendFileSync', 'chmod', 'chmodSync', 'chown', 'chownSync',
    'copyFile', 'copyFileSync', 'cp', 'cpSync', 'fchmod', 'fchmodSync', 'fchown',
    'fchownSync', 'ftruncate', 'ftruncateSync', 'futimes', 'futimesSync', 'lchmod',
    'lchmodSync', 'lchown', 'lchownSync', 'link', 'linkSync', 'lutimes', 'lutimesSync',
    'mkdir', 'mkdirSync', 'mkdtemp', 'mkdtempSync', 'open', 'openSync', 'rename',
    'renameSync', 'rm', 'rmSync', 'rmdir', 'rmdirSync', 'symlink', 'symlinkSync',
    'truncate', 'truncateSync', 'unlink', 'unlinkSync', 'utimes', 'utimesSync',
    'write', 'writeSync', 'writeFile', 'writeFileSync', 'writev', 'writevSync',
    'createWriteStream'
];

let temporaryRoot;
let fixtureRoot;
let AdmZip;
let OriginalAdmZip;
let Utils;

function assertDisabled(error) {
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe(DISABLED);
    expect(error.message).toBe(DISABLED);
}

function captureThrow(invoke) {
    let caught;
    try {
        invoke();
    } catch (error) {
        caught = error;
    }
    assertDisabled(caught);
    return caught;
}

async function captureRejection(invoke) {
    const result = invoke();
    expect(result).toBeInstanceOf(Promise);
    let caught;
    try {
        await result;
    } catch (error) {
        caught = error;
    }
    assertDisabled(caught);
    return caught;
}

function captureCallback(invoke, trailing = []) {
    const callback = jest.fn();
    expect(invoke(callback)).toBeUndefined();
    expect(callback).toHaveBeenCalledTimes(1);
    const [error, ...rest] = callback.mock.calls[0];
    assertDisabled(error);
    expect(rest).toEqual(trailing);
    return error;
}

async function withoutMutations(invoke) {
    const spies = MUTATIONS.filter(name => typeof fs[name] === 'function')
        .map(name => jest.spyOn(fs, name).mockImplementation(() => {
            throw new Error(`Unexpected filesystem mutation: ${name}`);
        }));
    for (const name of MUTATIONS.filter(name => typeof fs.promises[name] === 'function')) {
        spies.push(jest.spyOn(fs.promises, name).mockImplementation(() => {
            throw new Error(`Unexpected promise filesystem mutation: ${name}`);
        }));
    }
    try {
        await invoke();
        for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
        for (const spy of spies) spy.mockRestore();
    }
}

function customFsTrap() {
    const calls = [];
    const trapped = { Stats: fs.Stats };
    for (const name of Object.keys(fs)) {
        if (typeof fs[name] !== 'function' || ['Stats', 'lstat', 'lstatSync'].includes(name)) continue;
        trapped[name] = (...args) => {
            calls.push({ name, arguments: args.length });
            throw new Error(`Unexpected custom filesystem access: ${name}`);
        };
    }
    return { fs: trapped, calls };
}

function snapshot(file) {
    const stat = fs.lstatSync(file, { bigint: true });
    return {
        bytes: stat.isFile() ? fs.readFileSync(file).toString('hex') : null,
        link: stat.isSymbolicLink() ? fs.readlinkSync(file) : null,
        inode: stat.ino.toString(),
        mode: stat.mode.toString(),
        size: stat.size.toString(),
        mtimeNs: stat.mtimeNs.toString(),
        ctimeNs: stat.ctimeNs.toString()
    };
}

function symlinkFixture(kind) {
    const target = path.join(fixtureRoot, 'target');
    const outside = path.join(fixtureRoot, 'outside');
    fs.mkdirSync(target);
    fs.mkdirSync(outside);
    const sentinel = path.join(outside, 'sentinel.txt');
    fs.writeFileSync(sentinel, 'original outside bytes', { mode: 0o640 });
    fs.utimesSync(sentinel, new Date('2020-01-02T03:04:05Z'), new Date('2020-01-02T03:04:05Z'));
    const link = path.join(target, kind === 'leaf' ? 'sentinel.txt' : 'nested');
    fs.symlinkSync(kind === 'leaf' ? sentinel : outside, link, kind === 'leaf' ? 'file' : 'dir');
    return {
        target, sentinel, link,
        entry: kind === 'leaf' ? 'sentinel.txt' : 'nested/sentinel.txt',
        payload: Buffer.from('archive attempted outside overwrite'),
        before: {
            sentinel: snapshot(sentinel), link: snapshot(link),
            target: snapshot(target), outside: snapshot(outside),
            children: fs.readdirSync(target), outsideChildren: fs.readdirSync(outside)
        }
    };
}

const EXTRACTIONS = [
    ['extractEntryTo', (zip, fixture) => zip.extractEntryTo(zip.getEntry(fixture.entry), fixture.target, true, true, true)],
    ['extractAllTo', (zip, fixture) => zip.extractAllTo(fixture.target, true, true)],
    ['extractAllToAsync callback in argument 2', (zip, fixture) => new Promise((resolve, reject) => {
        zip.extractAllToAsync(fixture.target, error => error ? reject(error) : resolve());
    })],
    ['extractAllToAsync callback in argument 3', (zip, fixture) => new Promise((resolve, reject) => {
        zip.extractAllToAsync(fixture.target, true, error => error ? reject(error) : resolve());
    })],
    ['extractAllToAsync callback in argument 4', (zip, fixture) => new Promise((resolve, reject) => {
        zip.extractAllToAsync(fixture.target, true, true, error => error ? reject(error) : resolve());
    })],
    ['extractAllToAsync Promise', (zip, fixture) => zip.extractAllToAsync(fixture.target, true, true)]
];

// The argument-2 callback form defaults overwrite=false, so it cannot overwrite
// an existing leaf. Its vulnerable parent-link control creates a previously
// absent outside file; the other forms prove actual outside sentinel overwrite.
function adaptNoOverwriteFixture(fixture, name) {
    if (name !== 'extractAllToAsync callback in argument 2') return;
    fixture.entry = fixture.entry.replace('sentinel.txt', 'new-outside.txt');
}

const PUBLIC_REFUSALS = [
    ['extractEntryTo', (zip, target) => captureThrow(() => zip.extractEntryTo('file.txt', target, true, true, true, 'renamed.txt'))],
    ['extractAllTo', (zip, target) => captureThrow(() => zip.extractAllTo(target, true, true))],
    ['extractAllToAsync callback 2', (zip, target) => captureCallback(callback => zip.extractAllToAsync(target, callback))],
    ['extractAllToAsync callback 3', (zip, target) => captureCallback(callback => zip.extractAllToAsync(target, true, callback))],
    ['extractAllToAsync callback 4', (zip, target) => captureCallback(callback => zip.extractAllToAsync(target, true, true, callback))],
    ['extractAllToAsync Promise', (zip, target) => captureRejection(() => zip.extractAllToAsync(target, true, true))],
    ['writeZip', (zip, target) => captureThrow(() => zip.writeZip(path.join(target, 'archive.zip')))],
    ['writeZip no arguments', zip => captureThrow(() => zip.writeZip())],
    ['writeZip callback 1', zip => captureCallback(callback => zip.writeZip(callback), [''])],
    ['writeZip callback 2', (zip, target) => captureCallback(callback => zip.writeZip(path.join(target, 'archive.zip'), callback), [''])],
    ['writeZipPromise', (zip, target) => captureRejection(() => zip.writeZipPromise(path.join(target, 'archive.zip'), { overwrite: true, perm: 0o777 }))],
    ['writeZipPromise no filename', zip => captureRejection(() => zip.writeZipPromise())]
];

beforeAll(() => {
    const { readTarGz, verifyVendor } = require('../scripts/verify-adm-zip-memory-only');
    verifyVendor();
    const upstream = fs.readFileSync(path.join(VENDOR, 'upstream-adm-zip-0.6.0.tgz'));
    expect(`sha512-${crypto.createHash('sha512').update(upstream).digest('base64')}`).toBe(UPSTREAM_INTEGRITY);
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-zip-memory-only-'));
    const originalPath = path.join(temporaryRoot, 'original');
    fs.mkdirSync(originalPath);
    for (const [name, bytes] of readTarGz(upstream)) {
        const destination = path.resolve(originalPath, name);
        if (!destination.startsWith(`${originalPath}${path.sep}`)) throw new Error('Invalid upstream fixture path');
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, bytes);
    }
    OriginalAdmZip = require(path.join(originalPath, 'adm-zip.js'));
    AdmZip = require(path.join(VENDOR, 'source/adm-zip.js'));
    Utils = require(path.join(VENDOR, 'source/util/utils.js'));
});

beforeEach(() => {
    fixtureRoot = fs.mkdtempSync(path.join(temporaryRoot, 'fixture-'));
});

afterEach(() => {
    jest.restoreAllMocks();
    if (fixtureRoot) fs.rmSync(fixtureRoot, { recursive: true, force: true });
    fixtureRoot = undefined;
});

afterAll(() => {
    if (temporaryRoot) fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

describe.each(['leaf', 'parent'])('published upstream causal %s symlink control', kind => {
    test.each(EXTRACTIONS.filter(([name]) => name !== 'extractAllToAsync callback in argument 2'))('%s actually overwrites outside bytes in published 0.6.0', async (name, invoke) => {
        const fixture = symlinkFixture(kind);
        const zip = new OriginalAdmZip();
        zip.addFile(fixture.entry, fixture.payload, '', 0o600);
        await invoke(zip, fixture);
        expect(fs.readFileSync(fixture.sentinel)).toEqual(fixture.payload);
        expect(fs.lstatSync(fixture.link).isSymbolicLink()).toBe(true);
    });

    test.each(EXTRACTIONS)('%s refuses the same symlink surface before any mutation', async (name, invoke) => {
        const fixture = symlinkFixture(kind);
        const zip = new AdmZip();
        zip.addFile(fixture.entry, fixture.payload, '', 0o600);
        await withoutMutations(async () => {
            let caught;
            try {
                await invoke(zip, fixture);
            } catch (error) {
                caught = error;
            }
            assertDisabled(caught);
        });
        expect(snapshot(fixture.sentinel)).toEqual(fixture.before.sentinel);
        expect(snapshot(fixture.link)).toEqual(fixture.before.link);
        expect(snapshot(fixture.target)).toEqual(fixture.before.target);
        expect(snapshot(path.join(fixtureRoot, 'outside'))).toEqual(fixture.before.outside);
        expect(fs.readdirSync(fixture.target)).toEqual(fixture.before.children);
        expect(fs.readdirSync(path.join(fixtureRoot, 'outside'))).toEqual(fixture.before.outsideChildren);
        expect(fs.existsSync(path.join(fixtureRoot, 'outside/new-outside.txt'))).toBe(false);
    });
});

test('published callback-2 extraction creates a real outside file through a parent symlink', async () => {
    const fixture = symlinkFixture('parent');
    adaptNoOverwriteFixture(fixture, 'extractAllToAsync callback in argument 2');
    const zip = new OriginalAdmZip();
    zip.addFile(fixture.entry, fixture.payload);
    await EXTRACTIONS[2][1](zip, fixture);
    expect(fs.readFileSync(path.join(fixtureRoot, 'outside/new-outside.txt'))).toEqual(fixture.payload);
    expect(fs.readFileSync(fixture.sentinel, 'utf8')).toBe('original outside bytes');
});

describe.each([false, true])('all public disk capabilities, empty archive=%s', empty => {
    describe.each(['default', 'custom without lstat'])('%s filesystem', filesystem => {
        test.each(PUBLIC_REFUSALS)('%s reports explicit failure on an ordinary target', async (name, invoke) => {
            const trap = filesystem === 'default' ? null : customFsTrap();
            const zip = new AdmZip(trap ? { fs: trap.fs } : undefined);
            if (!empty) {
                zip.addFile('directory/', Buffer.alloc(0), '', 0o500);
                zip.addFile('file.txt', Buffer.from('memory content'));
            }
            const target = path.join(fixtureRoot, 'not-created');
            await withoutMutations(() => invoke(zip, target));
            if (trap) expect(trap.calls).toEqual([]);
            expect(fs.existsSync(target)).toBe(false);
            expect(fs.readdirSync(fixtureRoot)).toEqual([]);
        });
    });
});

describe.each(['default', 'custom without lstat'])('deep Utils import with %s filesystem', filesystem => {
    test.each([
        ['makeDir', (utils, target) => captureThrow(() => utils.makeDir(target))],
        ['writeFileTo', (utils, target) => captureThrow(() => utils.writeFileTo(target, Buffer.from('content'), true, 0o777))],
        ['writeFileToAsync callback 4', (utils, target) => {
            const callback = jest.fn();
            expect(utils.writeFileToAsync(target, Buffer.from('content'), true, callback)).toBeUndefined();
            expect(callback.mock.calls).toEqual([[false]]);
        }],
        ['writeFileToAsync callback 5', (utils, target) => {
            const callback = jest.fn();
            expect(utils.writeFileToAsync(target, Buffer.from('content'), true, 0o777, callback)).toBeUndefined();
            expect(callback.mock.calls).toEqual([[false]]);
        }],
        ['writeFileToAsync missing callback', (utils, target) => captureThrow(() => utils.writeFileToAsync(target, Buffer.from('content'), true, 0o777))]
    ])('%s cannot create a directory, write bytes or change permissions', async (name, invoke) => {
        const trap = filesystem === 'default' ? null : customFsTrap();
        const utils = new Utils(trap ? { fs: trap.fs } : undefined);
        const target = path.join(fixtureRoot, 'new-directory/file.txt');
        await withoutMutations(() => invoke(utils, target));
        if (trap) expect(trap.calls).toEqual([]);
        expect(fs.readdirSync(fixtureRoot)).toEqual([]);
    });
});

test('refusal precedes archive serialization and property evaluation, and produces fresh errors', async () => {
    const zip = new AdmZip();
    zip.toBufferPromise = jest.fn(() => { throw new Error('must not serialize'); });
    const props = { get overwrite() { throw new Error('must not inspect options'); } };
    const first = captureThrow(() => zip.extractEntryTo(null, null));
    const second = captureThrow(() => zip.extractAllTo(null));
    expect(first).not.toBe(second);
    await captureRejection(() => zip.writeZipPromise(null, props));
    expect(zip.toBufferPromise).not.toHaveBeenCalled();
});

test('callback exceptions propagate once without enabling writes or a success completion', async () => {
    const zip = new AdmZip();
    const utils = new Utils();
    const thrown = new Error('caller callback error');
    for (const invoke of [
        callback => zip.extractAllToAsync(fixtureRoot, callback),
        callback => zip.writeZip(callback),
        callback => utils.writeFileToAsync(fixtureRoot, Buffer.alloc(0), true, callback)
    ]) {
        const callback = jest.fn(() => { throw thrown; });
        await withoutMutations(() => {
            expect(() => invoke(callback)).toThrow(thrown);
            expect(callback).toHaveBeenCalledTimes(1);
        });
    }
});

test('in-memory create, update, delete, lookup, buffer round-trip and sync/async reads stay usable', async () => {
    const trap = customFsTrap();
    const zip = new AdmZip({ fs: trap.fs });
    zip.addFile('directory/', Buffer.alloc(0));
    zip.addFile('directory/value.txt', Buffer.from('before'));
    zip.addFile('remove.txt', Buffer.from('remove'));
    zip.updateFile('directory/value.txt', Buffer.from('after — memory only'));
    zip.deleteEntry('remove.txt');
    expect(zip.getEntry('remove.txt')).toBeNull();
    const buffer = zip.toBuffer();
    expect(Buffer.isBuffer(buffer)).toBe(true);
    const reopened = new AdmZip(buffer, { fs: trap.fs });
    expect(reopened.getEntries().map(entry => entry.entryName)).toEqual(['directory/', 'directory/value.txt']);
    const expected = Buffer.from('after — memory only');
    expect(reopened.readFile(reopened.getEntry('directory/value.txt'))).toEqual(expected);
    expect(reopened.readAsText('directory/value.txt')).toBe(expected.toString());
    const read = await new Promise((resolve, reject) => reopened.readFileAsync('directory/value.txt', (bytes, error) => error ? reject(error) : resolve(bytes)));
    expect(read).toEqual(expected);
    const text = await new Promise((resolve, reject) => reopened.readAsTextAsync('directory/value.txt', (value, error) => error ? reject(error) : resolve(value)));
    expect(text).toBe(expected.toString());
    const asyncBuffer = await reopened.toBufferPromise();
    expect(new AdmZip(asyncBuffer).readFile('directory/value.txt')).toEqual(expected);
    const callbackBuffer = await new Promise((resolve, reject) => reopened.toBuffer(resolve, reject));
    expect(new AdmZip(callbackBuffer).readFile('directory/value.txt')).toEqual(expected);
    expect(trap.calls).toEqual([]);
});

test('read-only construction from a local archive remains usable while overwriting that filename is disabled', async () => {
    const zip = new AdmZip();
    zip.addFile('file.txt', Buffer.from('local read'));
    const archive = path.join(fixtureRoot, 'read-only.zip');
    fs.writeFileSync(archive, zip.toBuffer());
    const before = snapshot(archive);
    const reopened = new AdmZip(archive);
    expect(reopened.readAsText('file.txt')).toBe('local read');
    await withoutMutations(async () => {
        captureThrow(() => reopened.writeZip());
        captureCallback(callback => reopened.writeZip(callback), ['']);
        await captureRejection(() => reopened.writeZipPromise());
    });
    expect(snapshot(archive)).toEqual(before);
});
