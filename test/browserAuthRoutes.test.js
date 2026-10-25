const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const phaseOneRoutes = Object.freeze({
    '/api/auth/login': ['GET'],
    '/api/auth/callback': ['POST'],
    '/api/auth/logout': ['POST'],
    '/api/auth/session': ['GET']
});

const bffTransportRoutes = [
    '/api/sales/*',
    '/api/lifecycle/*',
    '/api/service-desk/*',
    '/api/datto-rmm/*'
];

describe.each([
    'staticwebapp.config.json',
    path.join('azure', 'staticwebapp.config.example.json')
])('phase-two browser auth boundary in %s', (relativePath) => {
    const config = JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));

    test('keeps method-constrained auth endpoints before the protected generic API wildcard', () => {
        const wildcardIndex = config.routes.findIndex((route) => route.route === '/api/*');
        expect(wildcardIndex).toBeGreaterThan(-1);
        expect(config.routes[wildcardIndex].allowedRoles).toEqual(['authenticated']);

        const declaredAuthRoutes = config.routes
            .filter((route) => String(route.route || '').startsWith('/api/auth/'))
            .map((route) => route.route);
        expect(declaredAuthRoutes).toEqual(Object.keys(phaseOneRoutes));
        expect(new Set(declaredAuthRoutes).size).toBe(declaredAuthRoutes.length);

        Object.entries(phaseOneRoutes).forEach(([routePath, methods]) => {
            const matches = config.routes.filter((route) => route.route === routePath);
            expect(matches).toHaveLength(1);
            const routeIndex = config.routes.indexOf(matches[0]);
            expect(routeIndex).toBeGreaterThan(-1);
            expect(routeIndex).toBeLessThan(wildcardIndex);
            expect(config.routes[routeIndex]).toMatchObject({
                route: routePath,
                methods,
                allowedRoles: ['anonymous'],
                headers: {
                    'Cache-Control': 'private, no-store, max-age=0',
                    'X-Robots-Tag': 'noindex, nofollow'
                }
            });
        });
    });

    test('opens only the three BFF shells and four exact API transport groups', () => {
        ['/scoping', '/support', '/operator'].forEach((routePath) => {
            expect(config.routes.find((route) => route.route === routePath).allowedRoles)
                .toEqual(['anonymous']);
        });

        const wildcardIndex = config.routes.findIndex((route) => route.route === '/api/*');
        bffTransportRoutes.forEach((routePath) => {
            const matches = config.routes.filter((route) => route.route === routePath);
            expect(matches).toHaveLength(1);
            expect(matches[0]).toMatchObject({
                route: routePath,
                allowedRoles: ['anonymous']
            });
            expect(config.routes.indexOf(matches[0])).toBeLessThan(wildcardIndex);
        });

        expect(config.routes[wildcardIndex].allowedRoles).toEqual(['authenticated']);
        expect(config.responseOverrides['401']).toBeUndefined();
        expect(config.responseOverrides['403']).toBeUndefined();
        expect(config.responseOverrides['404']).toEqual({ rewrite: '/404.html', statusCode: 404 });
        expect(JSON.stringify(config)).not.toContain('/.auth/');
    });
});
