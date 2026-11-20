'use strict';

// API route rules in the built Static Web Apps config that no longer set a
// Content-Security-Policy rely on App Service for it. Every method those rules
// admit must reach the hosted application and come back with the API policy
// and robots directive, whatever the status. This is the backend half of
// scripts/tests/swa-api-headers.cjs, without the emulator.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const request = require('supertest');
const { API_SECURITY_HEADERS } = require('../api/shared/securityHeaders');

const ROOT = path.resolve(__dirname, '..');
let rules, app;

beforeAll(() => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-swa-api-headers-'));
    const { PUBLIC_ROOT_FILES } = require('../lib/publicAssets');
    for (const file of ['package.json', 'scripts/build-static.js', 'staticwebapp.config.json', ...PUBLIC_ROOT_FILES]) {
        fs.mkdirSync(path.dirname(path.join(temporary, file)), { recursive: true });
        fs.copyFileSync(path.join(ROOT, file), path.join(temporary, file));
    }
    for (const name of ['api', 'app', 'assets', 'demo', 'images', 'js', 'lib', 'azure']) {
        fs.cpSync(path.join(ROOT, name), path.join(temporary, name), { recursive: true,
            filter: source => !path.relative(ROOT, source).split(path.sep).includes('node_modules') });
    }
    execFileSync(process.execPath, [path.join(temporary, 'scripts/build-static.js')], { cwd: temporary, stdio: 'pipe' });
    const built = JSON.parse(fs.readFileSync(path.join(temporary, 'dist/staticwebapp.config.json'), 'utf8'));
    fs.rmSync(temporary, { recursive: true, force: true });
    rules = built.routes.filter(rule => rule.route.startsWith('/api/') &&
        !Object.keys(rule.headers || {}).some(name => name.toLowerCase() === 'content-security-policy'));
    const { createProductionApplication } = require('../lib/productionApplication');
    app = createProductionApplication({});
}, 120000);

test('every API rule without an edge CSP gets the API CSP and robots directive from App Service', async () => {
    expect(rules.length).toBeGreaterThan(30);
    let cases = 0;
    for (const rule of rules) {
        const endpoint = rule.route.replace('*', 'header-check');
        for (const method of rule.methods || ['GET', 'HEAD', 'POST', 'OPTIONS']) {
            const response = await request(app)[method.toLowerCase()](endpoint)
                .set('X-Forwarded-For', '192.0.2.' + (cases % 250 + 1));
            const label = method + ' ' + endpoint + ' -> ' + response.status;
            expect({ label, csp: response.headers['content-security-policy'] })
                .toEqual({ label, csp: API_SECURITY_HEADERS['Content-Security-Policy'] });
            expect({ label, robots: response.headers['x-robots-tag'] }).toEqual({ label, robots: 'noindex, nofollow' });
            cases++;
        }
    }
    expect(cases).toBeGreaterThanOrEqual(rules.length);
}, 120000);

test('a blocked user agent gets the API headers on API paths and the site policy elsewhere', async () => {
    const blocked = await request(app).get('/api/organisation-setup/state').set('User-Agent', 'sqlmap/1.8');
    expect(blocked.status).toBe(403);
    expect(blocked.body).toEqual({ error: 'Request blocked' });
    for (const [name, value] of Object.entries(API_SECURITY_HEADERS)) expect(blocked.headers[name.toLowerCase()]).toBe(value);
    const page = await request(app).get('/index.html').set('User-Agent', 'sqlmap/1.8');
    expect(page.status).toBe(403);
    expect(page.headers['content-security-policy']).not.toBe(API_SECURITY_HEADERS['Content-Security-Policy']);
});
