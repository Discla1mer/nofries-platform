const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

describe('public third-party script boundary', () => {
    const root = path.resolve(__dirname, '..');
    const dist = path.join(root, 'dist');

    beforeAll(() => {
        execFileSync(process.execPath, ['scripts/build-static.js'], { cwd: root });
    });

    test('ships no third-party visitor-tracking runtime', () => {
        const index = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
        const scope = fs.readFileSync(path.join(dist, 'scope.html'), 'utf8');
        const workspace = fs.readFileSync(path.join(dist, 'app', 'mssp.html'), 'utf8');

        expect(index).not.toContain('/js/apollo-tracker.js');
        expect(scope).not.toContain('/js/apollo-tracker.js');
        expect(workspace).not.toContain('/js/apollo-tracker.js');
        expect(fs.existsSync(path.join(dist, 'js', 'apollo-tracker.js'))).toBe(false);
    });

    test('allows only first-party public scripts and connections', () => {
        const config = JSON.parse(fs.readFileSync(path.join(root, 'staticwebapp.config.json'), 'utf8'));
        const policy = config.globalHeaders['Content-Security-Policy'];
        const localServer = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

        expect(policy).toContain("script-src 'self'");
        expect(policy).toContain("connect-src 'self'");
        expect(policy).not.toContain('assets.apollo.io');
        expect(policy).not.toContain('aplo-evnt.com');
        expect(policy).not.toContain("'unsafe-inline'");
        const scopeRoute = config.routes.find((route) => route.route === '/scope.html');
        const scopingRoute = config.routes.find((route) => route.route === '/scoping');
        expect(scopeRoute.headers['Content-Security-Policy']).toContain("script-src 'self'");
        expect(scopingRoute.headers['Content-Security-Policy']).toContain("script-src 'none'");
        [scopeRoute, scopingRoute].forEach((route) => {
            expect(route.headers['Content-Security-Policy']).not.toContain('assets.apollo.io');
            expect(route.headers['Content-Security-Policy']).not.toContain('aplo-evnt.com');
            expect(route.headers['Content-Security-Policy']).not.toContain("'unsafe-inline'");
        });
        expect(localServer).toContain("script-src 'self'");
        expect(localServer).toContain("connect-src 'self'");
        expect(localServer).not.toContain('assets.apollo.io');
        expect(localServer).not.toContain('aplo-evnt.com');
    });

    test('accurately discloses the tracker-free public page', () => {
        const privacy = fs.readFileSync(path.join(dist, 'privacy.html'), 'utf8');

        expect(privacy).toContain('Website visitor tracking');
        expect(privacy).toContain('does not load a third-party visitor-tracking script');
        expect(privacy).not.toContain('apollo.io');
        expect(privacy).toContain('Website assistant and prospect discovery');
        expect(privacy).toContain('Simply loading the website does not create a prospect record');
    });

    test('keeps signed prospect and BFF shell transport anonymous at the Static Web Apps boundary', () => {
        const config = JSON.parse(fs.readFileSync(path.join(root, 'staticwebapp.config.json'), 'utf8'));
        const routes = config.routes;
        const prospectSession = routes.find((route) => route.route === '/api/prospect/session');
        const prospectChat = routes.find((route) => route.route === '/api/prospect/chat');
        const operator = routes.find((route) => route.route === '/operator');
        const protectedApi = routes.find((route) => route.route === '/api/*');

        expect(prospectSession.allowedRoles).toEqual(['anonymous']);
        expect(prospectChat.allowedRoles).toEqual(['anonymous']);
        expect(operator.allowedRoles).toEqual(['anonymous']);
        expect(protectedApi.allowedRoles).toEqual(['authenticated']);
        expect(routes.indexOf(prospectSession)).toBeLessThan(routes.indexOf(protectedApi));
        expect(routes.indexOf(prospectChat)).toBeLessThan(routes.indexOf(protectedApi));
    });
});
