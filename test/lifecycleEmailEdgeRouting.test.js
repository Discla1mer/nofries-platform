'use strict';

const fs = require('node:fs');
const path = require('node:path');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../staticwebapp.config.json'), 'utf8'));

// Resolve the checked-in ordered route table, as in dashboardAdminPublicRouting.test.js.
// This is not an Azure edge emulator; it checks rule order and method scoping only.
function edgeRule(url, method) {
    const pathname = new URL(url, 'https://synthetic.invalid').pathname;
    return config.routes.find(rule => (!rule.methods || rule.methods.includes(method)) &&
        (rule.route === pathname || rule.route.endsWith('*') && pathname.startsWith(rule.route.slice(0, -1))));
}

// The unsubscribe link (and the RFC 8058 one-click POST from mail providers) carries no
// session, and the signed-in email settings page authenticates with the app's own customer
// cookie, not an SWA role. Both must reach App Service instead of the authenticated catch-all.
const emailRoutes = ['/api/emailPreferences', '/api/account/email'];

test.each(emailRoutes)('%s bypasses the SWA authenticated catch-all', url => {
    const catchall = config.routes.findIndex(rule => rule.route === '/api/*');
    // No method list at the edge, to save SWA config bytes: both handlers already answer
    // anything other than GET/POST with 405 (unsubscribe also accepts the RFC 8058 POST).
    for (const method of ['GET', 'POST']) {
        const rule = edgeRule(`${url}?t=synthetic`, method);
        // No edge headers: the handlers set no-store, noindex and their own CSP via apiSecurityHeaders,
        // and the SWA config must stay inside its 20 KB budget.
        expect(rule).toEqual({ route: url, allowedRoles: ['anonymous'] });
        expect(config.routes.indexOf(rule)).toBeLessThan(catchall);
    }
});

test.each(emailRoutes)('%s neighbouring paths stay behind the catch-all', url => {
    for (const tail of ['/', '/other', '-other']) {
        expect(edgeRule(url + tail, 'GET')).toMatchObject({ route: '/api/*', allowedRoles: ['authenticated'] });
    }
});

test('the paths match the handlers and the link the sender writes', () => {
    const dispatcher = fs.readFileSync(path.join(__dirname, '../api/shared/lifecycleEmail/dispatcher.js'), 'utf8');
    const unsubscribe = fs.readFileSync(path.join(__dirname, '../api/shared/lifecycleEmail/unsubscribeEndpoint.js'), 'utf8');
    const settings = fs.readFileSync(path.join(__dirname, '../api/shared/lifecycleEmail/emailSettings.js'), 'utf8');
    expect(dispatcher).toContain("UNSUBSCRIBE_PATH = '/api/emailPreferences'");
    expect(unsubscribe).toContain("PATH = '/api/emailPreferences'");
    expect(settings).toContain("PATH = '/api/account/email'");
});
