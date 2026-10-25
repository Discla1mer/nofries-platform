'use strict';

const fs = require('fs');
const path = require('path');
const { PUBLIC_ROOT_FILES } = require('../lib/publicAssets');

const rootDir = path.resolve(__dirname, '..');
const outputDir = path.join(rootDir, 'app-service-dist');
const runtimeFiles = [
    'app-service.js',
    'server.js',
    'package-lock.json',
    'app/mssp.css',
    'app/mssp.html',
    'app/operator.css',
    'app/operator.html',
    'app/portal.css',
    'app/portal.html',
    'app/dashboard.css',
    'app/dashboard.html',
    'app/support.css',
    'app/support.html'
];
const runtimeDirectories = [
    'api',
    'assets',
    'images',
    'js',
    'lib'
];

fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(outputDir, { recursive: true });

for (const relativePath of [...runtimeFiles, ...PUBLIC_ROOT_FILES]) {
    copyPath(relativePath);
}
for (const relativePath of runtimeDirectories) {
    copyPath(relativePath);
}
writeRuntimeManifest();

function copyPath(relativePath) {
    const source = path.join(rootDir, relativePath);
    const destination = path.join(outputDir, relativePath);
    if (!fs.existsSync(source)) {
        throw new Error(`Required App Service runtime path is missing: ${relativePath}`);
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(source, destination, { recursive: true });
}

function writeRuntimeManifest() {
    const sourceManifest = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
    const runtimeManifest = {
        name: sourceManifest.name,
        version: sourceManifest.version,
        description: sourceManifest.description,
        private: true,
        main: 'app-service.js',
        license: sourceManifest.license,
        engines: sourceManifest.engines,
        dependencies: sourceManifest.dependencies,
        overrides: sourceManifest.overrides,
        scripts: {
            start: 'node app-service.js',
            'start:app-service': 'node app-service.js'
        }
    };
    fs.writeFileSync(
        path.join(outputDir, 'package.json'),
        `${JSON.stringify(runtimeManifest, null, 2)}\n`,
        { mode: 0o644 }
    );
}
