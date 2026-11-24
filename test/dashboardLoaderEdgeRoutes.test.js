'use strict';

// Regression for #561: a loader request with no explicit Static Web Apps route
// falls through to the authenticated /api/* catch-all, and the edge answers 401
// before the app runs. Every dashboard API path the loader calls needs its own
// anonymous route; the app still enforces the session itself.
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const loader = fs.readFileSync(path.join(root, 'js', 'dashboard-loader.js'), 'utf8');
const paths = [...new Set([...loader.matchAll(/'(\/api\/dashboard\/[a-z0-9_\-/]+)['?]/g)].map(match => match[1].endsWith('/') ? match[1] + 'item' : match[1]))];

function covered(routes, target) {
    for (const route of routes) {
        if (route.route === '/api/*') return false;
        const prefix = route.route.endsWith('/*') ? route.route.slice(0, -1) : null;
        if (route.route === target || (prefix && target.startsWith(prefix))) return route.allowedRoles?.includes('anonymous');
    }
    return false;
}

test('the details read is a GET, so its edge route admits GET and POST', () => {
    for (const file of ['staticwebapp.config.json', 'azure/staticwebapp.config.example.json']) {
        const rule = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')).routes.find(route => route.route === '/api/dashboard/representative-details');
        expect(rule.methods).toEqual(['GET', 'POST']);
    }
});

describe.each(['staticwebapp.config.json', 'azure/staticwebapp.config.example.json'])('%s', file => {
    const routes = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')).routes;
    test('finds the loader API paths', () => {
        expect(paths).toContain('/api/dashboard/organisations/paid-framework-status');
        expect(paths.length).toBeGreaterThan(5);
    });
    test.each(paths)('%s has an explicit route before the authenticated catch-all', target => {
        expect(covered(routes, target)).toBe(true);
    });
});
