const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

describe('retired staff workspace pages', () => {
    test('the staff sign-in page has no staff area menu, only sign out', () => {
        const html = fs.readFileSync(path.join(root, 'app/operator.html'), 'utf8');
        expect(html).not.toMatch(/aria-label=["']Private workspace navigation["']/i);
        expect(html).not.toMatch(/href=["']\/(?:scoping|support)["']/);
        expect(html).toMatch(/<form\b[^>]*action=["']\/api\/auth\/logout["'][^>]*method=["']post["'][^>]*>[\s\S]*?<input\b[^>]*name=["']returnTo["'][^>]*value=["']\/["'][^>]*>[\s\S]*?<button\b[^>]*type=["']submit["'][^>]*>Sign out<\/button>[\s\S]*?<\/form>/i);
    });

    test('uses anonymous edge transport for the staff sign-in shell and redirects retired pages to the dashboard', () => {
        const config = JSON.parse(fs.readFileSync(path.join(root, 'staticwebapp.config.json'), 'utf8'));

        expect(config.responseOverrides['401']).toBeUndefined();
        expect(config.responseOverrides['403']).toBeUndefined();
        expect(config.routes.find((route) => route.route === '/operator')).toMatchObject({ allowedRoles: ['anonymous'] });
        ['/scoping', '/support'].forEach((routePath) => {
            expect(config.routes.find((route) => route.route === routePath)).toMatchObject({ redirect: '/dashboard', statusCode: 302 });
        });
        expect(JSON.stringify(config)).not.toContain('/.auth/');
    });
});
