const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pages = [
    ['operator', 'app/operator.html', '/operator'],
    ['sales', 'app/mssp.html', '/scoping'],
    ['support', 'app/support.html', '/support']
];

function navigationLinks(html) {
    const nav = html.match(/<nav\b[^>]*aria-label=["']Private workspace navigation["'][^>]*>([\s\S]*?)<\/nav>/i);
    if (!nav) return [];
    return [...nav[1].matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)].map((match) => ({
        href: (match[1].match(/href=["']([^"']+)["']/i) || [])[1],
        className: (match[1].match(/class=["']([^"']+)["']/i) || [])[1] || '',
        current: /aria-current=["']page["']/i.test(match[1]),
        hidden: /(?:^|\s)hidden(?:\s|=|$)/i.test(match[1]),
        label: match[2].replace(/<[^>]+>/g, '').trim()
    }));
}

describe('protected workspace navigation', () => {
    test.each(pages)('%s keeps one area-based menu and marks the current page', (page, file, currentHref) => {
        const html = fs.readFileSync(path.join(root, file), 'utf8');
        const links = navigationLinks(html);

        expect(links.map(({ label, href, hidden }) => [label, href, hidden])).toEqual([
            ['Work', '/operator', false],
            ['Sales', '/scoping', false],
            ['Service desk', '/support', false],
            ...(page === 'operator' ? [['Dashboard administration', '/dashboard-admin/entry', true]] : [])
        ]);
        expect(links.filter((link) => link.current)).toEqual([
            expect.objectContaining({ href: currentHref })
        ]);
        expect(links.every((link) => !link.className.includes('button'))).toBe(true);
        expect(html).toMatch(/<form\b[^>]*action=["']\/api\/auth\/logout["'][^>]*method=["']post["'][^>]*>[\s\S]*?<input\b[^>]*name=["']returnTo["'][^>]*value=["']\/["'][^>]*>[\s\S]*?<button\b[^>]*type=["']submit["'][^>]*>Sign out<\/button>[\s\S]*?<\/form>/i);
        expect(html).toMatch(/class=["'][^"']*(?:brand|support-brand|operator-brand)[^"']*["'][^>]*href=["']\/operator["']|href=["']\/operator["'][^>]*class=["'][^"']*(?:brand|support-brand|operator-brand)/i);
    });

    test('uses anonymous edge transport while each BFF shell verifies its opaque session', () => {
        const config = JSON.parse(fs.readFileSync(path.join(root, 'staticwebapp.config.json'), 'utf8'));

        expect(config.responseOverrides['401']).toBeUndefined();
        expect(config.responseOverrides['403']).toBeUndefined();
        pages.forEach(([, , routePath]) => {
            expect(config.routes.find((route) => route.route === routePath)).toMatchObject({
                allowedRoles: ['anonymous']
            });
        });
        expect(JSON.stringify(config)).not.toContain('/.auth/');
    });
});
