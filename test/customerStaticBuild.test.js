'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');

test('the finalizer compacts only the exact closed no-store cache policy and retains every header', () => {
    const vm = require('node:vm');
    const script = fs.readFileSync(path.join(ROOT, 'scripts/build-static.js'), 'utf8');
    const finalizer = script.slice(script.indexOf('function finalizeStaticWebAppConfig()'), script.indexOf('function copyDirectory('));
    const policies = ['private, no-store, max-age=0', 'private,no-store,max-age=0',
        'private, no-store', 'no-store, max-age=0', 'private, max-age=0',
        'private, no-store, max-age=0, no-transform', 'private, no-store, max-age=0, must-understand',
        'private="X-Secret", no-store, max-age=0', 'private, no-store, max-age=1', 'public, max-age=3600'];
    const source = { routes: policies.map((value, index) => ({ route: '/api/synthetic/' + index, methods: ['GET'],
        allowedRoles: ['authenticated'], headers: { 'Cache-Control': value, 'X-Robots-Tag': 'noindex, nofollow',
            'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'", 'X-Synthetic': 'preserve' } })) };
    let output;
    vm.runInNewContext(finalizer + '\nfinalizeStaticWebAppConfig();', { path, distDir: '/synthetic', Buffer,
        MAX_STATIC_CONFIG_BYTES: 20000, fs: { readFileSync: () => JSON.stringify(source), writeFileSync: (_file, value) => { output = value; } } });
    const built = JSON.parse(output);
    expect(built.routes).toHaveLength(source.routes.length);
    built.routes.forEach((route, index) => {
        expect(route.headers['Cache-Control']).toBe(index < 2 ? 'no-store' : policies[index].replace(/, +/g, ','));
        expect(Object.keys(route.headers)).toEqual(Object.keys(source.routes[index].headers));
        expect(route.headers['X-Robots-Tag']).toBe('noindex,nofollow');
        expect(route.headers['Content-Security-Policy']).toBe("default-src 'none';frame-ancestors 'none'");
        expect(route.headers['X-Synthetic']).toBe('preserve');
        expect(route.allowedRoles).toEqual(['authenticated']); expect(route.methods).toEqual(['GET']);
    });
});

test('the customer entry builds within the SWA limit with API routes and security directives preserved', () => {
    execFileSync(process.execPath, ['scripts/build-static.js'], { cwd: ROOT, stdio: 'pipe' });
    const bytes = fs.readFileSync(path.join(ROOT, 'dist/staticwebapp.config.json'));
    expect(bytes.length).toBeLessThanOrEqual(20000);
    for (const file of ['dashboard-admin', 'api/dashboard-admin', 'js/dashboardAdmin.js',
        'js/dashboardAdminEntry.js', 'js/signupQueue.js']) expect(fs.existsSync(path.join(ROOT, 'dist', file))).toBe(false);
    const built = JSON.parse(bytes), source = JSON.parse(fs.readFileSync(path.join(ROOT, 'staticwebapp.config.json')));
    const effectiveRule = ({ headers, ...route }) => ({ ...route, allowedRoles: route.allowedRoles ?? ['anonymous'] });
    expect(built.routes.map(effectiveRule)).toEqual(source.routes.map(effectiveRule));
    const directives = (value, separator) => value.split(separator).map(d => d.trim());
    for (const original of source.routes.filter(route => route.route.startsWith('/api/'))) {
        const route = built.routes.find(candidate => candidate.route === original.route);
        expect(Object.keys(route.headers || {}).sort()).toEqual(Object.keys(original.headers || {}).sort());
        for (const [name, value] of Object.entries(original.headers || {})) {
            if (name === 'Content-Security-Policy') expect(directives(route.headers[name], ';')).toEqual(directives(value, ';'));
            else if (name === 'Cache-Control' && value === 'private, no-store, max-age=0') expect(route.headers[name]).toBe('no-store');
            else if (name === 'Cache-Control' || name === 'X-Robots-Tag') expect(directives(route.headers[name], ',')).toEqual(directives(value, ','));
            else expect(route.headers[name]).toBe(value);
        }
    }
    const login = built.routes.find(route => route.route === '/login');
    expect(login.rewrite).toBe('/login.html');
    expect(login.headers['Cache-Control']).toContain('no-store');
    const loginHtml = fs.readFileSync(path.join(ROOT, 'dist/login.html'), 'utf8');
    expect(loginHtml).toContain('Sign up / Sign in');
    expect(loginHtml).toMatch(/<label for="representative-registration">NZBN <span class="field-help">\(optional\)<\/span><\/label>/);
    const registration = loginHtml.match(/<input id="representative-registration"[^>]*>/)[0];
    expect(registration).toContain('name="registrationId"');
    expect(registration).toContain('maxlength="160"');
    expect(registration).toContain('aria-describedby="representative-nzbn-help"');
    expect(registration).not.toMatch(/\brequired\b|\bpattern=|type="number"/);
    expect(loginHtml).toContain('<p id="representative-nzbn-help" class="field-help">Your New Zealand Business Number, if you have one.</p>');
    for (const [file, route] of [['app/dashboard.html', '/dashboard'], ['index.html', '/']]) {
        const html = fs.readFileSync(path.join(ROOT, 'dist', file), 'utf8');
        expect(html.match(/<body\b[^>]*>/)[0]).toContain('data-customer-provider="auto"');
        expect(html).toContain('id="dashboardSignIn" href="/login"');
        if (file === 'index.html') {
            for (const [intent, label] of [['create', 'Create account'], ['login', 'Log in']]) {
                const links = [...html.matchAll(new RegExp('<a\\b[^>]*\\bhref="/login\\?intent=' + intent + '">([\\s\\S]*?)</a>', 'g'))];
                expect(links).toHaveLength(1);
                expect(links[0][1].replace(/<span aria-hidden="true">[^<]*<\/span>/g, '').trim()).toBe(label);
            }
        }
        const runtime = html.match(/<script id="dashboardRuntime">([\s\S]*?)<\/script>/)[1];
        const hash = "'sha256-" + crypto.createHash('sha256').update(runtime).digest('base64') + "'";
        expect(built.routes.find(rule => rule.route === route).headers['Content-Security-Policy']).toContain(hash);
    }
    expect(directives(built.globalHeaders['Content-Security-Policy'], ';')).toEqual(directives(source.globalHeaders['Content-Security-Policy'], ';'));
});
