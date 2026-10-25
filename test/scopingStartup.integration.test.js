const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { execFileSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');

describe('/scoping deployment startup contract', () => {
    beforeAll(() => {
        execFileSync(process.execPath, [path.join(rootDir, 'scripts', 'build-static.js')], {
            cwd: rootDir,
            stdio: 'pipe'
        });
    });

    test('ships one parser-executed inline loader and copy runtime', () => {
        const html = readDist('app/mssp.html');
        const css = readDist('assets/mssp.css');
        const loader = readSource('js/app-loader.js');
        const copy = readSource('js/scoping-copy.js');
        const scripts = inlineScriptsWithPublicHelp(html);
        const cssDigest = crypto.createHash('sha256').update(css).digest('hex').slice(0, 12);

        expect(scripts).toHaveLength(1);
        expect(scripts[0][1].trim()).toBe('id="scopingRuntime"');
        expect(scripts[0][1]).not.toMatch(/\bsrc\s*=/i);
        expect(scripts[0][1]).not.toMatch(/\bdefer\b/i);

        const runtime = scripts[0][2];
        const loaderIndex = runtime.indexOf(loader.trim());
        const copyIndex = runtime.indexOf(copy.trim());

        expect(loaderIndex).toBeGreaterThanOrEqual(0);
        expect(copyIndex).toBeGreaterThan(loaderIndex);
        expect(() => new Function(runtime)).not.toThrow();

        expect(html).toContain(`<link rel="stylesheet" href="/assets/mssp.css?v=${cssDigest}">`);
        expect(html).toContain('Opening Sales');
        expect(html).toContain('<small>Sales</small>');
        expect(runtime).not.toContain('window.NoFriesSales = { start };');
        expect(runtime.indexOf("requestJsonWithTimeout('/api/auth/session'")).toBeGreaterThan(-1);
        expect(runtime.indexOf("requestJsonWithTimeout('/api/auth/session'")).toBeLessThan(
            runtime.indexOf("requestJsonWithTimeout('/api/sales/bootstrap'")
        );
        expect(runtime).toContain("requestJsonWithTimeout('/api/sales/bootstrap'");
        expect(runtime).not.toContain('createObjectURL');
        expect(runtime).toContain("script.src = '/api/sales/app.js'");
    });

    test('pins the only inline runtime to its exact SHA-256 CSP hash', () => {
        const html = readDist('app/mssp.html');
        const config = JSON.parse(readDist('staticwebapp.config.json'));
        const scopingRoute = config.routes.find((route) => route.route === '/scoping');
        const scripts = inlineScriptsWithPublicHelp(html);

        expect(scripts).toHaveLength(1);
        const runtimeHash = crypto.createHash('sha256').update(scripts[0][2]).digest('base64');
        const csp = scopingRoute.headers['Content-Security-Policy'];
        const scriptDirective = csp.split(';')
            .map((directive) => directive.trim())
            .find((directive) => directive.startsWith('script-src '));

        expect(scriptDirective).toBe(`script-src 'self' 'sha256-${runtimeHash}'`);
        expect(scriptDirective).not.toContain("'unsafe-inline'");
        expect(scriptDirective).not.toContain('blob:');
        expect(csp).toContain("script-src-attr 'none'");
    });

    test('does not emit the former scoping JavaScript artifacts', () => {
        [
            'assets/scoping-app.js',
            'js/app-loader.js',
            'js/scoping-copy.js',
            'app/mssp.js'
        ].forEach((relativePath) => {
            expect(fs.existsSync(path.join(distDir, relativePath))).toBe(false);
        });

        const config = JSON.parse(readDist('staticwebapp.config.json'));
        const routePaths = config.routes.map((route) => route.route);
        expect(routePaths).not.toContain('/assets/scoping-app.js');
        expect(routePaths).not.toContain('/js/app-loader.js');
        expect(routePaths).not.toContain('/js/scoping-copy.js');
    });

    test('uses anonymous SWA transport while the BFF protects product APIs', () => {
        const config = JSON.parse(readDist('staticwebapp.config.json'));
        const scopingRoute = config.routes.find((route) => route.route === '/scoping');
        const salesRoute = config.routes.find((route) => route.route === '/api/sales/*');
        const apiRoute = config.routes.find((route) => route.route === '/api/*');

        expect(scopingRoute).toMatchObject({
            rewrite: '/app/mssp.html'
        });
        expect(scopingRoute.headers['Cache-Control']).toBe('no-store');
        expect(scopingRoute.allowedRoles ?? ['anonymous']).toEqual(['anonymous']);
        expect(salesRoute.allowedRoles ?? ['anonymous']).toEqual(['anonymous']);
        expect(config.routes.indexOf(salesRoute)).toBeLessThan(config.routes.indexOf(apiRoute));
        expect(apiRoute).toMatchObject({ allowedRoles: ['authenticated'] });
        expect(config.responseOverrides['401']).toBeUndefined();
        expect(config.responseOverrides['403']).toBeUndefined();
    });

    test('retains the loading boundary and corrected mobile header layout', () => {
        const css = readDist('assets/mssp.css');

        expect(css).toContain('body.app-loading .workspace-layout');
        expect(css).toContain('body.workspace-unavailable .workspace-layout');
        expect(css).toContain('grid-template-columns: minmax(0, 1fr)');
        const mobileCss = css.slice(css.indexOf('@media (max-width: 620px)'));
        expect(mobileCss).toContain('grid-template-columns: repeat(2, minmax(0, 1fr))');
        expect(mobileCss).toContain('.header-actions a');
        expect(mobileCss).not.toContain('.header-actions .button:last-child');
    });
});

function readDist(relativePath) {
    return fs.readFileSync(path.join(distDir, relativePath), 'utf8');
}

function inlineScriptsWithPublicHelp(html) {
    const all = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    const external = all.filter(script => /\bsrc\s*=/i.test(script[1]));
    expect(all).toHaveLength(3);
    expect(external.map(script => script[1].trim())).toEqual([
        'src="/js/prospect-assistant.js" defer', 'src="/js/shared-assistant.js" defer'
    ]);
    for (const script of external) expect(script[2]).toBe('');
    return all.filter(script => !/\bsrc\s*=/i.test(script[1]));
}

function readSource(relativePath) {
    return fs.readFileSync(path.join(rootDir, relativePath), 'utf8');
}
