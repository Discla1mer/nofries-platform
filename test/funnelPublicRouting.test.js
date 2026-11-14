'use strict';

// Static Web Apps sits in front of /api and only lets anonymous requests
// through on named routes; anything else hits the /api/* rule, which needs a
// signed-in SWA user. Browser funnel counts come from visitors who are not
// signed in, so the beacon route must be named.
const fs = require('node:fs');
const path = require('node:path');
const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../staticwebapp.config.json'), 'utf8'));

// Resolve the checked-in ordered route table (not an Azure edge emulator).
function edgeRule(pathname, method) {
    return config.routes.find(rule => (!rule.methods || rule.methods.includes(method)) &&
        (rule.route === pathname || rule.route.endsWith('*') && pathname.startsWith(rule.route.slice(0, -1))));
}

test('POST /api/telemetry reaches App Service anonymously', () => {
    const rule = edgeRule('/api/telemetry', 'POST');
    expect(rule.route).toBe('/api/telemetry');
    expect(rule.allowedRoles).toEqual(['anonymous']);
});

test('GET /api/telemetry still needs an SWA user at the edge', () => {
    expect(edgeRule('/api/telemetry', 'GET').route).toBe('/api/*');
});
