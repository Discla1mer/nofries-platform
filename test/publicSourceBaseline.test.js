'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { inventory, verify, manifestDigest } = require('../scripts/verify-public-source-baseline');
test.each(['addition', 'removal', 'content', 'empty-baseline', 'symlink', 'source-and-baseline'])('temporary source fence rejects %s', kind => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-public-source-'));
    try {
        fs.writeFileSync(path.join(root, 'auth.js'), 'reviewed');
        const expected = {schemaVersion:1,sourceHead:'34db76317b06973a238a2728b486d035193867cc',expiresAt:'2026-10-27T00:00:00Z',files:inventory(root)};
        const reviewedDigest = manifestDigest(expected);
        expect(() => verify(root,expected,reviewedDigest)).not.toThrow();
        if (kind === 'addition') fs.writeFileSync(path.join(root,'new.js'),'new');
        if (kind === 'removal') fs.unlinkSync(path.join(root,'auth.js'));
        if (kind === 'content') fs.writeFileSync(path.join(root,'auth.js'),'changed');
        if (kind === 'empty-baseline') expected.files = {};
        if (kind === 'symlink') fs.symlinkSync('auth.js',path.join(root,'extra.js'));
        if (kind === 'source-and-baseline') {
            fs.writeFileSync(path.join(root,'auth.js'),'changed');
            expected.files = inventory(root);
        }
        expect(() => verify(root,expected,reviewedDigest)).toThrow();
    } finally { fs.rmSync(root,{recursive:true,force:true}); }
});
