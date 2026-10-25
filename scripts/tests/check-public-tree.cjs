'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');
const guard = path.resolve(__dirname, '../check-public-tree.js');
for (const [name,allowed] of [['.env',false],['.env.local',false],['.env.production',false],
    ['api/.env.staging',false],['node_modules/example/index.js',false],['.env.example',true],['source.js',true]]) {
    test(`tracked ${name} is ${allowed ? 'allowed' : 'rejected'}`, () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(),'nofries-public-tree-'));
        try {
            execFileSync('git',['init','--quiet'],{cwd:root});
            fs.mkdirSync(path.dirname(path.join(root,name)),{recursive:true});
            fs.writeFileSync(path.join(root,name),'synthetic fixture');
            execFileSync('git',['add','--',name],{cwd:root});
            const result = spawnSync(process.execPath,[guard],{cwd:root,encoding:'utf8'});
            assert.equal(result.status,allowed ? 0 : 1);
        } finally { fs.rmSync(root,{recursive:true,force:true}); }
    });
}
