'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { buildDevSite } = require('../scripts/build-dashboard-dev-site');
const { renderPreview } = require('../scripts/build-dashboard-preview');
const root = path.resolve(__dirname, '..');
let directory;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-dev-test-')); });
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

test('packages only the existing synthetic UI and binds every served byte to a commit manifest', () => {
    const built = buildDevSite(path.join(directory, 'site'));
    const read = name => fs.readFileSync(path.join(built.output, name), 'utf8');
    expect(fs.readdirSync(built.output).sort()).toEqual(['index.html', 'preview-manifest.json', 'staticwebapp.config.json']);
    expect(built.commit).toMatch(/^[a-f0-9]{40}$/);
    const html = read('index.html');
    for (const file of ['api/shared/protectedAssets/dashboardShell.js', 'api/shared/protectedAssets/dashboardRegistry.js', 'app/dashboard.css']) {
        expect(html).toContain(fs.readFileSync(path.join(root, file), 'utf8'));
    }
    expect(html).toContain('DEV / synthetic data');
    expect(html).toContain(built.commit + (built.dirty ? '-dirty' : ''));
    expect(html).not.toMatch(/https?:\/\/|\/api\/|\.auth\/|localStorage|sessionStorage|document\.cookie/);
    for (const [file, digest] of Object.entries(built.files)) {
        expect(createHash('sha256').update(read(file)).digest('hex')).toBe(digest);
    }
    expect(buildDevSite(path.join(directory, 'repeat')).files).toEqual(built.files);
});

test('restricts all content and metadata to an invited role, with no API or fallback bypass', () => {
    const built = buildDevSite(path.join(directory, 'site'));
    const config = JSON.parse(fs.readFileSync(path.join(built.output, 'staticwebapp.config.json')));
    expect(config.routes).toEqual([
        { route: '/.auth/login/aad', statusCode: 404 },
        { route: '/.auth/login/aad/*', statusCode: 404 },
        { route: '/.auth/*', allowedRoles: ['anonymous'] },
        { route: '/api/*', statusCode: 404 },
        { route: '/*', allowedRoles: ['preview_reviewer'] }
    ]);
    expect(config).not.toHaveProperty('navigationFallback');
    expect(config).not.toHaveProperty('auth');
    const { html, contentSecurityPolicy } = renderPreview();
    for (const directive of ["default-src 'none'", "connect-src 'none'", "form-action 'none'", "base-uri 'none'"]) {
        expect(contentSecurityPolicy).toContain(directive);
    }
    for (const tag of ['script', 'style']) {
        const body = html.match(new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>'))[1];
        expect(contentSecurityPolicy).toContain("'sha256-" + createHash('sha256').update(body).digest('base64') + "'");
    }
    expect(config.globalHeaders['Content-Security-Policy']).toContain("frame-ancestors 'none'");
    expect(config.globalHeaders['Cache-Control']).toBe('private, no-store');
});

test('refuses to overwrite files, use production directories or traverse a symlink into the repository', () => {
    expect(() => buildDevSite('dist')).toThrow();
    expect(() => buildDevSite(root)).toThrow();
    expect(() => buildDevSite(path.join(root, 'dist'))).toThrow();
    fs.symlinkSync(root, path.join(directory, 'alias'), 'dir');
    expect(() => buildDevSite(path.join(directory, 'alias', 'dev-site'))).toThrow();
    fs.writeFileSync(path.join(directory, 'occupied'), 'keep');
    expect(() => buildDevSite(path.join(directory, 'occupied'))).toThrow();
    expect(fs.readFileSync(path.join(directory, 'occupied'), 'utf8')).toBe('keep');
    expect(() => renderPreview('<script>')).toThrow();
});
