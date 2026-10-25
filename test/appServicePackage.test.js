const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'app-service-dist');

describe('App Service runtime package', () => {
    beforeAll(() => {
        execFileSync(process.execPath, ['scripts/build-app-service.js'], {
            cwd: root,
            stdio: 'pipe'
        });
    });

    test.each([
        'app-service.js',
        'server.js',
        'package.json',
        'package-lock.json',
        'api/health/index.js',
        'api/shared/database/postgres.js',
        'api/shared/releaseManifest.json',
        'lib/hostStartup.js',
        'lib/publicAssets.js',
        'app/mssp.html',
        'js/prospect-assistant.js',
        'images/nofrieslogo.png',
        '.well-known/security.txt'
    ])('contains required runtime path %s', (relativePath) => {
        expect(fs.existsSync(path.join(output, relativePath))).toBe(true);
    });

    test.each([
        '.env',
        '.env.example',
        '.git',
        '.github',
        '.agent',
        'AGENTS.md',
        'CONTRIBUTING.md',
        'database',
        'docs',
        'evals',
        'examples',
        'infra',
        'release',
        'scripts',
        'test',
        'connector-functions',
        'staticwebapp.config.json',
        'app/assets',
        'app/design-tokens.json',
        'app/mssp.js',
        'app/nofries-theme.css',
        'app/nofries-ui.js'
    ])('excludes non-runtime or operational path %s', (relativePath) => {
        expect(fs.existsSync(path.join(output, relativePath))).toBe(false);
    });

    test('emits a runtime-only manifest that cannot invoke omitted build, migration, test or evaluation files', () => {
        const packageManifest = JSON.parse(fs.readFileSync(path.join(output, 'package.json'), 'utf8'));
        expect(packageManifest.private).toBe(true);
        expect(packageManifest.main).toBe('app-service.js');
        expect(packageManifest.devDependencies).toBeUndefined();
        expect(packageManifest.scripts).toEqual({
            start: 'node app-service.js',
            'start:app-service': 'node app-service.js'
        });
        expect(packageManifest.dependencies).toEqual(require('../package.json').dependencies);
    });

    test('keeps a compile-only CI install check for the generated runtime manifest and lock', () => {
        const workflow = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
        expect(workflow).toContain('cd app-service-dist');
        expect(workflow).toContain('npm ci --ignore-scripts --omit=dev --omit=optional --dry-run --offline');
    });
});
