'use strict';

// Every document that carries a native sign-out form uses an origin-only
// referrer policy. Under no-referrer a navigate-mode form POST sends
// `Origin: null`; browsers without Fetch Metadata (Safari < 16.4, Firefox < 90)
// then send no Sec-Fetch-Site either, and the logout handler refuses them.
const fs = require('node:fs');
const path = require('node:path');
const { buildScopingDocument } = require('../lib/scopingDocument');
const { buildSupportDocument } = require('../lib/supportDocument');
const { buildPortalDocument } = require('../lib/portalDocument');
const { buildDashboardAdminDocument, contentSecurityPolicy: dashboardAdminCsp } = require('../lib/dashboardAdminDocument');
const { buildDashboardAdminEntryDocument } = require('../lib/dashboardAdminEntryDocument');
const { buildRetainedTrialReadDocument, contentSecurityPolicy: retainedCsp } = require('../lib/retainedTrialReadDocument');
const { buildSignupDocument, buildHostedSignupDocument } = require('../lib/signupDocument');
const { createRetainedTrialAssessmentReader } = require('../api/shared/customerSignup/retainedTrialAssessmentReader');
const { retainedTrialFixture } = require('./fixtures/retainedTrialReadFixture');
const { createAuthLogoutFunction } = require('../api/authLogout');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const swa = JSON.parse(read('staticwebapp.config.json'));
const swaRoute = route => swa.routes.find(rule => rule.route === route);
const PUBLIC_ORIGIN = 'https://nofries.nz';
const VALID = new Set(['no-referrer', 'no-referrer-when-downgrade', 'same-origin', 'origin', 'strict-origin',
    'origin-when-cross-origin', 'strict-origin-when-cross-origin', 'unsafe-url']);

// The HTML rule: the last valid token of the header sets the document policy,
// and a later <meta name="referrer"> with a valid value replaces it.
function effectivePolicy(html, header) {
    let policy = String(header || '').split(',').map(token => token.trim().toLowerCase()).filter(token => VALID.has(token)).pop() || '';
    for (const [, content] of html.matchAll(/<meta\s+name="referrer"\s+content="([^"]*)"\s*\/?>/gi)) {
        if (VALID.has(content.trim().toLowerCase())) policy = content.trim().toLowerCase();
    }
    return policy;
}
const attributes = tag => Object.fromEntries([...tag.matchAll(/\s([a-z-]+)="([^"]*)"/gi)].map(([, name, value]) => [name.toLowerCase(), value]));
const sameOriginUrl = value => /^(?:\/(?!\/)|#|\?|$)/.test(value) || value.startsWith('${');

const sources = { clientSource: read('api/shared/customerSignup/signupClient.js'), journeySource: read('api/shared/customerSignup/signupJourney.js') };
const globalPolicy = swa.globalHeaders['Referrer-Policy'];

async function documents() {
    const f = await retainedTrialFixture();
    const result = await createRetainedTrialAssessmentReader(f.options).read({}, f.input);
    const hosted = buildHostedSignupDocument(sources);
    return [
        { name: 'app/operator.html', html: read('app/operator.html'), route: '/operator', action: '/api/auth/logout',
            csp: swaRoute('/operator').headers['Content-Security-Policy'] },
        { name: 'app/mssp.html', route: '/scoping', action: '/api/auth/logout', ...buildScopingDocument({ template: read('app/mssp.html'),
            loaderSource: read('js/app-loader.js'), copySource: read('js/scoping-copy.js') }) },
        { name: 'app/portal.html', route: '/portal', action: '/api/auth/logout',
            ...buildPortalDocument({ template: read('app/portal.html'), loaderSource: read('js/portal-loader.js') }) },
        { name: 'app/support.html', route: '/support', action: '/api/auth/logout',
            ...buildSupportDocument({ template: read('app/support.html'), loaderSource: read('js/support-loader.js') }) },
        { name: 'lib/dashboardAdminDocument.js', html: buildDashboardAdminDocument({ funnel: true }), action: '/api/auth/logout',
            header: 'strict-origin', csp: dashboardAdminCsp },
        { name: 'lib/dashboardAdminEntryDocument.js', html: buildDashboardAdminEntryDocument(), action: '/api/auth/logout',
            header: 'strict-origin', csp: dashboardAdminCsp },
        { name: 'lib/retainedTrialReadDocument.js', html: buildRetainedTrialReadDocument({ selection: f.input, result, status: 'result' }),
            action: '/api/retained-results', header: 'strict-origin', csp: retainedCsp },
        { name: 'signup (hosted)', route: '/signup', action: '/api/external-customer-auth/logout', ...hosted },
        { name: 'signup (external)', action: '/api/external-customer-auth/logout', header: 'strict-origin',
            ...buildSignupDocument({ ...sources, customerLogin: true, customerTransport: 'external' }) }
    ].map(doc => ({ ...doc, csp: doc.csp || doc.contentSecurityPolicy,
        header: doc.header || (doc.route ? swaRoute(doc.route).headers['Referrer-Policy'] : undefined) }));
}

let docs;
beforeAll(async () => { docs = await documents(); });

test('the site default stays no-referrer; only sign-out documents opt in', () => {
    expect(globalPolicy).toBe('no-referrer');
    expect(read('server.js')).toMatch(/'Referrer-Policy': 'no-referrer',/);
    for (const rule of swa.routes.filter(item => item.headers && item.headers['Referrer-Policy'])) {
        expect(['/operator', '/scoping', '/support', '/portal', '/signup']).toContain(rule.route);
        expect(rule.headers['Referrer-Policy']).toBe('strict-origin');
    }
});

test('each sign-out document has exactly one strict-origin referrer meta and that effective policy on every host', () => {
    expect(docs).toHaveLength(9);
    for (const doc of docs) {
        const metas = [...doc.html.matchAll(/<meta\s+name="referrer"[^>]*>/gi)];
        expect([doc.name, metas.length]).toEqual([doc.name, 1]);
        expect([doc.name, metas[0][0]]).toEqual([doc.name, '<meta name="referrer" content="strict-origin">']);
        // The meta must sit in <head>, before any script or stylesheet request.
        const head = doc.html.slice(0, doc.html.search(/<\/head>/i));
        expect(head.indexOf(metas[0][0])).toBeGreaterThan(-1);
        expect(head.indexOf(metas[0][0])).toBeLessThan(head.search(/<(?:link|script)\b/i));
        // Under the global header alone, under its own route header, and under both (a proxy appending the global value).
        for (const header of [globalPolicy, doc.header, `${doc.header}, ${globalPolicy}`]) {
            expect([doc.name, header, effectivePolicy(doc.html, header)]).toEqual([doc.name, header, 'strict-origin']);
        }
        expect([doc.name, doc.header]).toEqual([doc.name, 'strict-origin']);
    }
});

test('each document still posts its sign-out form natively to the expected logout route', () => {
    for (const doc of docs) {
        if (doc.name.startsWith('signup')) {
            // The setup journey builds this form at runtime.
            expect(doc.html).toContain(`form.method = 'post'; form.action = '${doc.action}';`);
            continue;
        }
        const forms = [...doc.html.matchAll(/<form\b[^>]*>/gi)].map(([tag]) => attributes(tag)).filter(form => form.method === 'post');
        expect([doc.name, forms.map(form => form.action)]).toEqual([doc.name, [doc.action]]);
    }
});

test('strict-origin exposes nothing new to third parties from these documents', () => {
    for (const doc of docs) {
        // Sub-resources, fetches and form targets are first-party only, so the
        // origin-only Referer reaches no other site.
        for (const directive of ['img-src', 'script-src', 'style-src', 'connect-src', 'form-action']) {
            const value = doc.csp.split(';').map(item => item.trim()).find(item => item.startsWith(directive + ' ')) ||
                doc.csp.split(';').map(item => item.trim()).find(item => item.startsWith('default-src '));
            const sourcesList = value.split(/\s+/).slice(1);
            expect([doc.name, directive, sourcesList.filter(token => !["'self'", "'none'", 'data:'].includes(token) && !token.startsWith("'sha256-"))])
                .toEqual([doc.name, directive, []]);
        }
        // Every static link, source and form target is same-origin, or keeps no-referrer for itself.
        for (const [tag] of doc.html.matchAll(/<(?:a|link|script|img|form|iframe|area)\b[^>]*>/gi)) {
            const attrs = attributes(tag);
            for (const name of ['href', 'src', 'action']) {
                if (attrs[name] === undefined || sameOriginUrl(attrs[name]) || attrs[name].startsWith('mailto:')) continue;
                expect([doc.name, tag, /\bnoreferrer\b/.test(attrs.rel || '') || attrs.referrerpolicy === 'no-referrer'])
                    .toEqual([doc.name, tag, true]);
            }
        }
    }
});

test('third-party links the staff workspace builds at runtime keep rel="noreferrer"', () => {
    const operator = read('api/shared/protectedAssets/operator.js');
    // The only off-site links on /operator are vendor installer and documentation links.
    const external = [...operator.matchAll(/href: (downloadUrl|documentationUrl),\s*target: '_blank',\s*rel: '([^']+)'/g)];
    expect(external.map(([, name, rel]) => [name, rel])).toEqual([
        ['downloadUrl', 'noopener noreferrer'], ['documentationUrl', 'noopener noreferrer']
    ]);
    expect((operator.match(/safeHttpsUrl\(/g) || []).length).toBe(3); // the definition and those two links
    // The other runtime navigations are first-party paths.
    for (const source of ['operator.js', 'mssp.js', 'support.js', 'portal.js', 'portalPending.js', 'dashboardAdmin.js',
        'signupQueue.js', 'funnelCountsView.js', 'dashboardAdminEntry.js', 'frameworkActions.js', 'accountActions.js', 'accountWipe.js']) {
        const text = read('api/shared/protectedAssets/' + source);
        expect([source, text.match(/https?:\/\/(?!www\.w3\.org\/)[^\s'"`]+/g)]).toEqual([source, null]);
    }
    expect(read('api/shared/customerSignup/signupJourney.js')).not.toMatch(/https?:\/\/(?!www\.w3\.org\/)/);
});

describe('logout handler with the Origin these documents now send', () => {
    const env = { NODE_ENV: 'production', NOFRIES_PUBLIC_URL: PUBLIC_ORIGIN + '/' };
    const context = () => ({ log: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } });
    const post = headers => ({ method: 'POST', body: 'returnTo=%2F',
        headers: { host: 'nofries.nz', 'user-agent': 'Synthetic Browser', 'x-forwarded-for': '203.0.113.9', ...headers } });

    test.each(['/api/auth/logout', '/api/external-customer-auth/logout', '/api/retained-results'])(
        'a form POST to %s from an older browser (real Origin, no Fetch Metadata) signs out', async () => {
            const logout = jest.fn(async () => ({ location: '/', cookie: '__Host-nofries-auth=; Path=/; Max-Age=0' }));
            const handler = createAuthLogoutFunction({ env, service: { logout } });
            for (const headers of [{ origin: PUBLIC_ORIGIN }, { origin: PUBLIC_ORIGIN, 'sec-fetch-site': 'same-origin' }]) {
                const ctx = context();
                await handler(ctx, post(headers));
                expect(ctx.res.status).toBe(303);
                expect(ctx.res.headers.Location).toBe('/');
                // The redirect itself still carries no referrer onward.
                expect(ctx.res.headers['Referrer-Policy']).toBe('no-referrer');
            }
            expect(logout).toHaveBeenCalledTimes(2);
        });

    test('the handler checks are unchanged: Origin null still needs Sec-Fetch-Site same-origin, and foreign origins are refused', async () => {
        const logout = jest.fn(async () => ({ location: '/', cookie: '__Host-nofries-auth=; Path=/; Max-Age=0' }));
        const handler = createAuthLogoutFunction({ env, service: { logout } });
        const outcomes = [];
        for (const headers of [{ origin: 'null' }, {}, { origin: 'null', 'sec-fetch-site': 'same-origin' },
            { origin: 'https://attacker.invalid' }, { origin: PUBLIC_ORIGIN, 'sec-fetch-site': 'cross-site' }]) {
            const ctx = context(); await handler(ctx, post(headers)); outcomes.push(ctx.res.status);
        }
        expect(outcomes).toEqual([403, 403, 303, 403, 403]);
    });
});
