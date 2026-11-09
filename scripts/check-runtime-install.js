'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');

function inside(root, file) {
    const relative = path.relative(root, file);
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

// This runs in a fresh child process with no credentials or Node lookup overrides.
function loadPackage(directory, kind) {
    if (!['app-service', 'api'].includes(kind)) throw new Error('Unknown runtime package');
    const root = fs.realpathSync(directory);
    const load = createRequire(path.join(root, 'package.json'));
    const manifest = load('./package.json');
    for (const name of Object.keys(manifest.dependencies || {})) {
        const resolved = fs.realpathSync(load.resolve(name));
        if (!inside(path.join(root, 'node_modules'), resolved)) {
            throw new Error(`Dependency resolved outside the installed package: ${name}`);
        }
        load(name);
    }
    if (kind === 'app-service') {
        const { createProductionApplication } = load('./lib/productionApplication.js');
        if (typeof createProductionApplication !== 'function') throw new Error('Production composition missing');
        // Loading the composition/HTTP host proves module availability, not live
        // authentication, cloud configuration or customer-journey acceptance.
        if (typeof load('./server.js').createNoFriesApp !== 'function') throw new Error('HTTP factory missing');
    } else {
        if (typeof load('./health/index.js') !== 'function') throw new Error('API health handler missing');
        if (typeof load('./shared/database/postgres.js').createPostgresDatabase !== 'function') {
            throw new Error('API database factory missing');
        }
    }
    for (const file of Object.keys(require.cache)) {
        if (file !== __filename && !inside(root, fs.realpathSync(file))) {
            throw new Error('Runtime imported a module from outside its isolated package');
        }
    }
    console.log(`${kind}: installed dependencies and runtime modules loaded in isolation`);
}

function verifyRuntimeInstall(root = path.resolve(__dirname, '..')) {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-runtime-install-'));
    try {
        for (const [kind, source, omitOptional] of [
            ['app-service', path.join(root, 'app-service-dist'), true],
            ['api', path.join(root, 'api'), false]
        ]) {
            const directory = path.join(temporary, kind);
            fs.cpSync(source, directory, { recursive: true,
                filter: file => !path.relative(source, file).split(path.sep).includes('node_modules') });
            // These two install profiles match the existing private package build.
            const args = ['ci', '--ignore-scripts', '--omit=dev', '--audit=false', '--fund=false'];
            if (omitOptional) args.push('--omit=optional');
            else args.push('--include=optional');
            execFileSync('npm', args, { cwd: directory, stdio: 'inherit', timeout: 180000 });
            execFileSync(process.execPath, ['--no-global-search-paths', __filename, '--load', directory, kind], {
                cwd: directory, stdio: 'inherit', timeout: 30000,
                env: { PATH: process.env.PATH, NODE_ENV: 'production', TMPDIR: directory }
            });
        }
    } finally {
        fs.rmSync(temporary, { recursive: true, force: true });
    }
}

if (require.main === module) {
    if (process.argv[2] === '--load') loadPackage(process.argv[3], process.argv[4]);
    else verifyRuntimeInstall();
}
module.exports = { verifyRuntimeInstall };
