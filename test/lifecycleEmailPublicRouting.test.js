'use strict';

// Static Web Apps sits in front of /api and only lets anonymous requests
// through on routes it names; everything else falls to the /api/* rule that
// requires a signed-in SWA user. Email links are opened by people who are not
// signed in, so these routes must be named or every unsubscribe link fails.
const fs = require('node:fs');
const path = require('node:path');
const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../staticwebapp.config.json'), 'utf8'));
const { PATH: UNSUBSCRIBE_PATH } = require('../api/shared/lifecycleEmail/unsubscribeEndpoint');
const { PATH: SETTINGS_PATH } = require('../api/shared/lifecycleEmail/emailSettings');

// Resolve the checked-in ordered route table (not an Azure edge emulator).
function edgeRule(pathname, method) {
    return config.routes.find(rule => (!rule.methods || rule.methods.includes(method)) &&
        (rule.route === pathname || rule.route.endsWith('*') && pathname.startsWith(rule.route.slice(0, -1))));
}

describe('lifecycle email routes at the Static Web Apps edge', () => {
    test.each([
        ['GET', UNSUBSCRIBE_PATH], ['POST', UNSUBSCRIBE_PATH],
        ['GET', SETTINGS_PATH], ['POST', SETTINGS_PATH]
    ])('%s %s reaches App Service anonymously', (method, pathname) => {
        const rule = edgeRule(pathname, method);
        expect(rule.route).toBe(pathname);
        expect(rule.allowedRoles).toEqual(['anonymous']);
    });

    test('the edge adds no CSP that would block the pages\' own form posts', () => {
        // The App Service responses set form-action 'self'; the /api/* rule's
        // form-action 'none' must not apply to these HTML pages.
        for (const pathname of [UNSUBSCRIBE_PATH, SETTINGS_PATH]) {
            expect(edgeRule(pathname, 'GET').headers).toBeUndefined();
        }
    });

    test('the dispatcher builds unsubscribe links on the routed path', () => {
        const source = fs.readFileSync(path.join(__dirname, '../api/shared/lifecycleEmail/dispatcher.js'), 'utf8');
        expect(source).toContain(`const UNSUBSCRIBE_PATH = '${UNSUBSCRIBE_PATH}';`);
    });
});
