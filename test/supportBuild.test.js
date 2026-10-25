const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');

describe('production support document build', () => {
    beforeAll(() => {
        execFileSync(process.execPath, ['scripts/build-static.js'], {
            cwd: root,
            stdio: 'pipe'
        });
    });

    test('embeds only the session-first loader and fetches the protected application afterward', () => {
        const html = fs.readFileSync(path.join(dist, 'app', 'support.html'), 'utf8');
        const config = JSON.parse(fs.readFileSync(path.join(dist, 'staticwebapp.config.json'), 'utf8'));
        const allScripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
        const external = allScripts.filter(script => /\bsrc\s*=/i.test(script[1]));
        const scripts = allScripts.filter(script => !/\bsrc\s*=/i.test(script[1]));
        expect(allScripts).toHaveLength(3);
        expect(external.map(script => script[1].trim())).toEqual([
            'src="/js/prospect-assistant.js" defer', 'src="/js/shared-assistant.js" defer'
        ]);
        for (const script of external) expect(script[2]).toBe('');

        expect(scripts).toHaveLength(1);
        expect(scripts[0][1]).toMatch(/\bid=["']supportRuntime["']/i);
        expect(scripts[0][1]).not.toMatch(/\bsrc\s*=/i);

        const runtime = scripts[0][2];
        expect(runtime).not.toContain('window.NoFriesSupport = { start };');
        expect(runtime).toContain("script.src = '/api/service-desk/app.js'");
        expect(runtime.indexOf("'/api/auth/session'")).toBeGreaterThan(-1);
        expect(runtime.indexOf("'/api/auth/session'")).toBeLessThan(
            runtime.indexOf("'/api/service-desk/bootstrap'")
        );
        expect(runtime).not.toContain('/.auth/');

        const digest = crypto.createHash('sha256').update(runtime, 'utf8').digest('base64');
        const route = config.routes.find((candidate) => candidate.route === '/support');
        const directive = route.headers['Content-Security-Policy']
            .split(';')
            .map((value) => value.trim())
            .find((value) => value.startsWith('script-src '));
        expect(directive).toBe(`script-src 'self' 'sha256-${digest}'`);
        expect(fs.existsSync(path.join(dist, 'js', 'support-loader.js'))).toBe(false);
    });
});
