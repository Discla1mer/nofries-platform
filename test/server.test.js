const request = require('supertest');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

process.env.NOFRIES_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-sales-test-'));
process.env.NOFRIES_REQUIRE_AUTH = 'false';
process.env.NOFRIES_BROWSER_AUTH_MODE = 'swa';
process.env.NOFRIES_DEV_EMAIL = 'admin@example.com';
process.env.NOFRIES_ALLOWED_EMAILS = 'admin@example.com,consultant@example.com';
process.env.NOFRIES_ADMIN_EMAILS = 'admin@example.com';
process.env.NOFRIES_SERVICE_OWNER_EMAILS = 'owner@example.com';
process.env.NOFRIES_TENANT_NAME = 'Test tenant';
process.env.NOFRIES_SCOPE_STORAGE_PROVIDER = 'memory';
process.env.NOFRIES_SCOPE_SIGNING_SECRET = 'test-scope-signing-secret-with-at-least-thirty-two-characters';
process.env.NOFRIES_SCOPE_EMAIL_FROM = 'No Fries <scope@example.invalid>';
process.env.RESEND_API_KEY = 'test-resend-key';
delete process.env.NOFRIES_DEFAULT_TENANT_ID;
delete process.env.NOFRIES_ALLOWED_TENANT_IDS;
delete process.env.NOFRIES_DYNAMICS_FLOW_URL;
delete process.env.NOFRIES_DYNAMICS_WRITE_ENABLED;

const app = require('../server');
const { handlers, runFunction } = require('../api/shared/apiRuntime');
const {
    CATALOGUE_COLUMNS,
    matchServices,
    runSalesFunction,
    validateCatalogueCsv
} = require('../api/shared/salesRuntime');
const { getAssessmentBlueprint } = require('../api/shared/salesBlueprint');
const {
    CATALOGUE_VERSION_ID,
    NOFRIES_SERVICE_COUNT,
    createNoFriesCatalogueState,
    upgradeNoFriesCatalogueState
} = require('../api/shared/nofriesCatalogue');
const { parseStaticWebAppsPrincipal } = require('../api/shared/identity');
const { assertSameOriginForMutation } = require('../api/shared/securityHeaders');
const { getClientKeyFromHeaders } = require('../api/shared/abuseProtection');
const salesBootstrapFunction = require('../api/salesBootstrap');

function principal(email, tenantId = 'tenant-one', name = 'Test User') {
    return Buffer.from(JSON.stringify({
        identityProvider: 'aad',
        userId: `principal-${email}`,
        userDetails: email,
        claims: [
            { typ: 'name', val: name },
            { typ: 'http://schemas.microsoft.com/identity/claims/tenantid', val: tenantId }
        ]
    })).toString('base64');
}

function functionContext(pathValue = '') {
    return {
        bindingData: { path: pathValue },
        log: {
            error: jest.fn(),
            info: jest.fn(),
            warn: jest.fn()
        }
    };
}

function catalogueCsv() {
    const rows = [
        CATALOGUE_COLUMNS,
        [
            'managed-security',
            'Managed endpoint security',
            'Security',
            'Consistent endpoint protection with managed alert response',
            'Organisations that need stronger endpoint monitoring and response',
            'No formal monitoring||Business-hours response only',
            'Supported endpoint estate',
            'Existing equivalent managed service',
            'Confirm endpoint coverage and response authority',
            'Endpoint inventory||Current security tooling',
            'technology-review',
            'No Fries',
            'Approved MSP service brief v1',
            'restricted',
            'security.monitoring=absent|business_hours',
            'security.endpoint=partial',
            'estate.endpoints=25_49|50_99|100_249|250_plus',
            'security.monitoring=24x7_managed'
        ],
        [
            'technology-review',
            'Monthly technology review',
            'Reporting and advice',
            'A practical monthly evidence and action review',
            'Organisations that want visibility of service activity and recurring issues',
            'Poor visibility||Recurring issues',
            '',
            '',
            'Agree the reporting baseline',
            'Current service report',
            'managed-security',
            'No Fries',
            'Approved MSP review brief v1',
            'internal',
            'support.frustrations=visibility|recurring',
            'business.priorities=ownership|cost',
            '',
            ''
        ]
    ];
    return rows.map((row) => row.map(csvCell).join(',')).join('\n');
}

function csvCell(value) {
    const text = String(value == null ? '' : value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function answerSet() {
    return {
        'business.priorities': answer(['security', 'resilience']),
        'business.concerns': answer(['cyber_risk', 'backup_risk']),
        'business.constraints': answer(['internal_capacity']),
        'estate.users': answer('50_99'),
        'estate.endpoints': answer('50_99'),
        'estate.locations': answer('two_three'),
        'productivity.platform': answer('microsoft_365'),
        'applications.critical': answer('Customer portal and warehouse operations'),
        'support.model': answer('managed_provider'),
        'support.frustrations': answer(['slow_response', 'recurring', 'visibility']),
        'support.hours': answer('business_hours'),
        'support.delivery': answer('remote_first'),
        'security.monitoring': answer('business_hours'),
        'security.endpoint': answer('partial'),
        'security.tools': answer('Microsoft Defender'),
        'resilience.backups': answer('partial'),
        'operations.suppliers': answer('three_plus'),
        'operations.ownership': answer('fragmented'),
        'operations.incumbent_handover': answer('yes'),
        'priorities.timeframe': answer('now'),
        'priorities.procurement': answer('active'),
        'priorities.next_step': answer('proposal')
    };
}

function answer(value) {
    return {
        value,
        notes: '',
        evidence: '',
        importance: 'medium',
        confidence: 'high',
        internalNotes: ''
    };
}

function privateDocumentInlineScripts(html) {
    const scripts = [...String(html).matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    expect(scripts).toHaveLength(3);
    const external = scripts.filter(script => /\bsrc\s*=/.test(script[1]));
    expect(external.map(script => script[1])).toEqual([
        ' src="/js/prospect-assistant.js" defer', ' src="/js/shared-assistant.js" defer'
    ]);
    expect(external.every(script => script[2] === '')).toBe(true);
    const inline = scripts.filter(script => !/\bsrc\s*=/.test(script[1]));
    expect(inline).toHaveLength(1);
    return inline;
}

function extractScopingRuntime(html) {
    const scripts = privateDocumentInlineScripts(html);
    expect(scripts[0][1]).toMatch(/\bid=["']scopingRuntime["']/i);
    expect(scripts[0][1]).not.toMatch(/\bsrc\s*=/i);
    return scripts[0][2];
}

function extractSupportRuntime(html) {
    const scripts = privateDocumentInlineScripts(html);
    expect(scripts[0][1]).toMatch(/\bid=["']supportRuntime["']/i);
    expect(scripts[0][1]).not.toMatch(/\bsrc\s*=/i);
    return scripts[0][2];
}

function scriptSourceHash(source) {
    return `'sha256-${crypto.createHash('sha256').update(source, 'utf8').digest('base64')}'`;
}

function restoreEnv(name, value) {
    if (value == null) {
        delete process.env[name];
    } else {
        process.env[name] = value;
    }
}

function scriptSourceDirective(contentSecurityPolicy) {
    return String(contentSecurityPolicy)
        .split(';')
        .map((directive) => directive.trim())
        .find((directive) => directive.startsWith('script-src '));
}

describe('dormant dashboard document', () => {
    test('dashboard document serves the same generic hash-bound entry at both aliases without activating APIs', async () => {
        const first = await request(app).get('/dashboard?organisationId=untrusted-record');
        expect(first.status).toBe(200);
        const alias = await request(app).get('/dashboard/');
        expect(alias.status).toBe(200);
        expect(alias.text).toBe(first.text);
        expect(first.headers['cache-control']).toBe('private, no-store, max-age=0');
        expect(first.headers['x-robots-tag']).toBe('noindex, nofollow');
        expect(first.headers['x-content-type-options']).toBe('nosniff');
        expect(first.headers['content-type']).toMatch(/^text\/html;/);
        const scripts = privateDocumentInlineScripts(first.text);
        expect(scripts[0][1]).toMatch(/\bid="dashboardRuntime"/);
        expect(scripts[0][1]).not.toMatch(/\bsrc\s*=/);
        const loader = fs.readFileSync(path.resolve(__dirname, '../js/dashboard-loader.js'), 'utf8');
        expect(first.text).toMatch(/<body data-page="operator-dashboard" data-customer-provider="legacy">/);
        expect(first.text).toContain('id="dashboardSignIn" href="/login?provider=legacy"');
        expect(scripts[0][2]).toBe(loader);
        const protectedApplication = ['dashboardRegistry.js', 'dashboardShell.js', 'ncscAssessmentClient.js', 'ncscQuestionnaire.js', 'assessmentExplanation.js', 'organisationPicture.js', 'improvementActionPlanView.js', 'improvementActionPlanClient.js']
            .map(file => fs.readFileSync(path.resolve(__dirname, '../api/shared/protectedAssets', file), 'utf8')).join('\n');
        const protectedStyle = fs.readFileSync(path.resolve(__dirname, '../app/dashboard.css'), 'utf8');
        for (const [id, source] of [['dashboardApplicationIntegrity', protectedApplication], ['dashboardStyleIntegrity', protectedStyle]]) {
            const expected = `sha256-${crypto.createHash('sha256').update(source, 'utf8').digest('base64')}`;
            expect(first.text).toContain(`<meta id="${id}" content="${expected}">`);
            expect(first.text).not.toContain(source);
        }
        expect(scriptSourceDirective(first.headers['content-security-policy'])).toBe(`script-src 'self' ${scriptSourceHash(loader)}`);
        expect(alias.headers['content-security-policy']).toBe(first.headers['content-security-policy']);
        expect(first.text).not.toContain('untrusted-record');
        for (const route of ['/api/dashboard/session', '/api/dashboard/bootstrap', '/api/dashboard/app.js', '/api/dashboard/dashboard.css']) {
            const unavailable = await request(app).get(route);
            expect(unavailable.status).toBe(410);
            expect(unavailable.body.code).toBe('legacy_workspace_retired');
            expect(unavailable.headers['cache-control']).toContain('no-store');
        }
    });

    test('generic dashboard entry does not expose private runtime sources through public file routes', async () => {
        for (const route of ['/js/dashboard-loader.js', '/app/dashboard.html', '/app/dashboard.css', '/assets/dashboard.css',
            '/assets/dashboard-app.js', '/api/shared/protectedAssets/dashboardShell.js', '/lib/dashboardDocument.js']) {
            const hidden = await request(app).get(route);
            expect(hidden.status).toBe(route.startsWith('/api/') ? 410 : 404);
            expect(hidden.text).not.toContain('NoFriesDashboard = factory');
            expect(hidden.text).not.toContain('data-page="operator-dashboard"');
        }
    });

    test.each(['staticwebapp.config.json', 'azure/staticwebapp.config.example.json'])('%s admits only the exact dashboard API methods through the BFF cookie boundary', (filename) => {
        const config = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', filename), 'utf8'));
        const methods = {
            login: ['GET'], 'ncsc/assessments': ['GET', 'POST'], 'ncsc/assessments/*': ['GET', 'POST'],
            'improvement/*': ['GET', 'POST'],
            session: ['GET', 'POST'], organisations: ['GET'], selection: ['POST'], logout: ['POST'],
            bootstrap: ['GET'], 'app.js': ['GET'], 'dashboard.css': ['GET'],
            'modules/overview': ['GET'], 'modules/ai_governance': ['GET'], 'modules/cyber_security': ['GET'],
            'modules/it_optimisation': ['GET'], 'modules/improvement_plan': ['GET'], 'modules/evidence': ['GET'],
            'modules/board_reports': ['GET'], 'modules/services': ['GET']
        };
        const catchall = config.routes.findIndex(route => route.route === '/api/*');
        expect(catchall).toBeGreaterThan(0);
        expect(config.routes[catchall].allowedRoles).toEqual(['authenticated']);
        // Reject bare/wildcard/lookalike dashboard routes as before. The exact
        // admin namespace has its own complete method/path boundary tests.
        expect(config.routes.filter(route => route.route.startsWith('/api/dashboard') &&
            !route.route.startsWith('/api/dashboard/') && route.route !== '/api/dashboard-admin' &&
            !route.route.startsWith('/api/dashboard-admin/'))).toEqual([]);
        const rules = config.routes.filter(route => route.route.startsWith('/api/dashboard/'));
        expect(rules.map(route => route.route).sort()).toEqual(Object.keys(methods).map(route => '/api/dashboard/' + route).sort());
        for (const rule of rules) {
            expect(config.routes.indexOf(rule)).toBeLessThan(catchall);
            expect(rule.methods).toEqual(methods[rule.route.slice('/api/dashboard/'.length)]);
            expect(rule.allowedRoles).toEqual(['anonymous']);
            expect(rule.headers).toEqual(rule.route === '/api/dashboard/improvement/*' ? { 'Cache-Control': 'no-store' }
                : { 'Cache-Control': 'private, no-store, max-age=0', 'X-Robots-Tag': 'noindex, nofollow',
                    'Content-Security-Policy': "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" });
        }
        expect(config.routes.some(route => route.route === '/dashboard/')).toBe(false);
        for (const alias of ['/dashboard']) {
            const docs = config.routes.filter(route => route.route === alias);
            expect(docs).toHaveLength(1);
            expect(docs[0]).toMatchObject({ rewrite: '/app/dashboard.html', allowedRoles: ['anonymous'], headers: {
                'Cache-Control': 'private, no-store, max-age=0', 'X-Robots-Tag': 'noindex, nofollow'
            } });
            expect(docs[0].headers['Content-Security-Policy']).toContain("script-src 'none'");
        }
        expect(config.responseOverrides['401']).toBeUndefined();
        expect(config.responseOverrides['403']).toBeUndefined();
    });
});

describe('No Fries MSP discovery-to-onboarding workspace', () => {
    afterAll(() => {
        fs.rmSync(process.env.NOFRIES_DATA_DIR, { recursive: true, force: true });
    });

    test('same-domain browser auth tolerates linked-proxy host rewriting and fails closed without a session', async () => {
        const previous = {
            publicUrl: process.env.NOFRIES_PUBLIC_URL,
            tenantId: process.env.NOFRIES_ENTRA_TENANT_ID,
            clientId: process.env.NOFRIES_ENTRA_CLIENT_ID,
            clientSecret: process.env.NOFRIES_ENTRA_CLIENT_SECRET
        };
        process.env.NOFRIES_PUBLIC_URL = 'https://nofries.nz';
        process.env.NOFRIES_ENTRA_TENANT_ID = '947787df-88fd-4417-b6b2-99c13d8410ba';
        process.env.NOFRIES_ENTRA_CLIENT_ID = 'd414ee2d-73e5-4e5b-bb16-03ef55fea597';
        process.env.NOFRIES_ENTRA_CLIENT_SECRET = 'test-only-client-secret-with-sufficient-length';

        try {
            const missing = await request(app)
                .get('/api/auth/session')
                .set('Host', 'nofries.nz');
            expect(missing.status).toBe(401);
            expect(missing.body).toMatchObject({
                authenticated: false,
                code: 'authentication_required'
            });
            expect(missing.headers['cache-control']).toContain('no-store');

            const alternateHost = await request(app)
                .get('/api/auth/session')
                .set('Host', 'nofries-web-api-flex.azurewebsites.net');
            expect(alternateHost.status).toBe(401);
            expect(alternateHost.body.code).toBe('authentication_required');

            const signedOut = await request(app)
                .post('/api/auth/logout')
                .set('Host', 'nofries.nz')
                .set('Origin', 'https://nofries.nz')
                .set('Sec-Fetch-Site', 'same-origin')
                .type('form')
                .send({ returnTo: '/' });
            expect(signedOut.status).toBe(303);
            expect(signedOut.headers.location).toBe('/');
            expect(signedOut.headers['set-cookie'][0]).toContain('__Host-nofries-auth=;');
            expect(signedOut.headers['set-cookie'][0]).toContain('Max-Age=0');
        } finally {
            restoreEnv('NOFRIES_PUBLIC_URL', previous.publicUrl);
            restoreEnv('NOFRIES_ENTRA_TENANT_ID', previous.tenantId);
            restoreEnv('NOFRIES_ENTRA_CLIENT_ID', previous.clientId);
            restoreEnv('NOFRIES_ENTRA_CLIENT_SECRET', previous.clientSecret);
        }
    });

    test('public root presents the dashboard and optional managed IT without exposing protected workspace material', async () => {
        const response = await request(app).get('/');
        expect(response.status).toBe(200);
        expect(response.text).toContain('href="/login?intent=create">Create account</a>');
        expect(response.text).toContain('href="/login?intent=login">Log in</a>');
        expect(response.text).toContain('Other services');
        expect(response.text).toContain('Public help only. No access to your organisation, forms or assessments. Keep private information out.');
        expect(response.text).not.toContain('Tell us about your people, devices and current set-up.');
        expect(response.text).not.toContain('one useful question at a time');
        expect(response.text).not.toContain('Plan your Lean Managed IT service.');
        expect(response.text).toContain('Protection and backup are selected separately.');
        expect(response.text).not.toContain('id="managed-it-per-user-price"');
        expect(response.text).toContain('Your IT position in real time.');
        expect(response.text).not.toContain('Automatic updates and connected data feeds are planned');
        expect(response.text).toContain('data-assistant-help-only="true"');
        expect(response.text).not.toContain('NZ$119 + GST');
        expect(response.text).not.toContain('Initial set-up starts at NZ$750 + GST');
        expect(response.text).not.toContain('NZ$895');
        expect(response.text).not.toContain('up to 10 users');
        expect(response.text).toContain('No Fries Managed IT covers agreed user support, work computers and business tools.');
        expect(response.text).not.toContain('Sales Agency');
        expect(response.text).not.toContain('luna.nofries.nz');
        expect(response.text).not.toContain('up to two typical computers');
        expect(response.text).not.toContain('Datto RMM');
        expect(response.text).not.toContain('AI service desk');
        expect(response.text).not.toContain('/operator');
        expect(response.text).not.toContain('Staff sign in');
        expect(response.text).toContain('/js/home.js');
        expect(response.text).toContain('/js/prospect-assistant.js');
        expect(response.text).not.toContain('Sales Discovery Workspace');
        expect(response.text).not.toContain('security.monitoring=absent');
        expect(response.text).not.toContain('lead-form.js');
        expect(response.headers['content-security-policy']).toContain("connect-src 'self'");
        expect(response.headers['content-security-policy']).not.toContain('plausible.io');
        expect(response.headers['x-robots-tag']).toBeUndefined();
        expect(response.headers['referrer-policy']).toBe('no-referrer');
        expect(response.headers['content-security-policy']).toContain("script-src 'self'");
        expect(response.headers['content-security-policy']).not.toContain('assets.apollo.io');
        expect(response.headers['content-security-policy']).not.toContain('aplo-evnt.com');
        expect(response.headers['x-content-type-options']).toBe('nosniff');
    });

    test('anonymous prospect chat persists structured discovery behind a signed session', async () => {
        const session = await request(app)
            .get('/api/prospect/session')
            .set('x-forwarded-for', '192.0.2.88');
        expect(session.status).toBe(200);
        expect(session.body.assistant).toMatchObject({
            agent: 'prospect_agent',
            runtime: { mode: 'mock', label: 'Structured preview' },
            streaming: true,
            pricing: {
                currency: 'NZD',
                perUserMonthly: 119,
                includedEndpointsPerUser: 1,
                onboardingFrom: 750,
                gstExclusive: true
            }
        });
        expect(session.body.organisation.context.productivity.platform).toBe('unknown');
        expect(session.body.conversation.status).toBe('not_started');
        expect(session.headers['set-cookie'][0]).toContain('HttpOnly');
        expect(session.headers['set-cookie'][0]).toContain('SameSite=Strict');
        const cookie = session.headers['set-cookie'][0].split(';')[0];

        const sensitive = await request(app)
            .post('/api/prospect/chat')
            .set('Cookie', cookie)
            .set('x-forwarded-for', '192.0.2.90')
            .send({ message: 'My password is ShouldNotBeStored!' });
        expect(sensitive.status).toBe(400);
        expect(sensitive.body.code).toBe('sensitive_data_blocked');

        const beforeChat = await request(app).get('/api/lifecycle/bootstrap');
        expect(beforeChat.body.organisations).toEqual([]);

        const crossSite = await request(app)
            .post('/api/prospect/chat')
            .set('Cookie', cookie)
            .set('Origin', 'https://attacker.example')
            .set('x-forwarded-for', '192.0.2.89')
            .send({ message: 'We need better support.' });
        expect(crossSite.status).toBe(403);
        expect(crossSite.body.code).toBe('same_origin_required');

        const chat = await request(app)
            .post('/api/prospect/chat')
            .set('Cookie', cookie)
            .set('x-forwarded-for', '192.0.2.88')
            .send({
                message: 'My name is Jamie and I work at Alpine Studio, and we are considering a change because support is slow. We have 12 staff using Microsoft 365.'
            });
        expect(chat.status).toBe(200);
        expect(chat.headers['content-type']).toContain('text/event-stream');
        expect(chat.headers['cache-control']).toContain('no-store');
        expect(chat.text).toContain('event: ready');
        expect(chat.text).toContain('event: delta');
        expect(chat.text).toContain('event: done');
        expect(chat.text).toContain('Alpine Studio');

        const operator = await request(app).get('/api/lifecycle/bootstrap');
        expect(operator.status).toBe(200);
        expect(operator.body.organisations).toEqual(expect.arrayContaining([
            expect.objectContaining({
                displayName: 'Alpine Studio',
                lifecycleState: 'discovery'
            })
        ]));

        const operatorShell = await request(app).get('/operator');
        expect(operatorShell.status).toBe(200);
        expect(operatorShell.headers['cache-control']).toContain('no-store');
        expect(operatorShell.text).toContain('Loading work that needs attention');
        expect(operatorShell.text).toContain('>Work</a>');
        expect(operatorShell.text).toContain('>Sales</a>');
        expect(operatorShell.text).toContain('>Service desk</a>');
        expect(operatorShell.text).toContain('/js/operator-loader.js');
        expect(operatorShell.text).not.toContain('/api/lifecycle/app.js');
    });

    test('email verification unlocks the server-side standard scope once', async () => {
        const previousFetch = global.fetch;
        const sent = [];
        global.fetch = jest.fn(async (url, options) => {
            sent.push({ url, options });
            return { ok: true, status: 200 };
        });

        try {
            const requested = await request(app)
                .post('/api/scope/request')
                .set('x-forwarded-for', '192.0.2.50')
                .send({ email: 'scope-reader@example.co.nz', website: '' });
            expect(requested.status).toBe(200);
            expect(requested.body.challengeId).toBeTruthy();
            expect(requested.body.code).toBeUndefined();
            expect(sent).toHaveLength(1);

            const emailPayload = JSON.parse(sent[0].options.body);
            const code = emailPayload.text.match(/Verification code: (\d{6})/)[1];
            const verified = await request(app)
                .post('/api/scope/verify')
                .set('x-forwarded-for', '192.0.2.50')
                .send({ challengeId: requested.body.challengeId, code });
            expect(verified.status).toBe(200);
            expect(verified.headers['set-cookie'][0]).toContain('HttpOnly');
            expect(verified.headers['set-cookie'][0]).toContain('SameSite=Strict');

            const cookie = verified.headers['set-cookie'][0].split(';')[0];
            const scope = await request(app)
                .get('/api/scope/content')
                .set('Cookie', cookie)
                .set('x-forwarded-for', '192.0.2.50');
            expect(scope.status).toBe(200);
            expect(scope.body.scope.title).toContain('standard service guide');
            expect(scope.body.scope.sections).toHaveLength(7);
            expect(scope.body.scope.offerStructure).toHaveLength(3);
            expect(scope.body.scope.serviceHours.aiIntake).toContain('Requests can be logged by phone, chat or email');
            expect(JSON.stringify(scope.body.scope)).toContain('Google Workspace administration');
            expect(JSON.stringify(scope.body.scope)).toContain('Proof every month');
            expect(JSON.stringify(scope.body.scope)).not.toContain('MDR/SOC');

            const replay = await request(app)
                .post('/api/scope/verify')
                .set('x-forwarded-for', '192.0.2.50')
                .send({ challengeId: requested.body.challengeId, code });
            expect(replay.status).toBe(404);
            expect(replay.body.code).toBe('challenge_missing');
        } finally {
            global.fetch = previousFetch;
        }
    });

    test('workspace shell embeds only a CSP-authorised loader before the protected sales runtime', async () => {
        const response = await request(app).get('/scoping');
        expect(response.status).toBe(200);
        expect(response.headers['x-robots-tag']).toBe('noindex, nofollow');
        const contentSecurityPolicy = response.headers['content-security-policy'];
        expect(contentSecurityPolicy).not.toContain('assets.apollo.io');
        expect(contentSecurityPolicy).not.toContain("'unsafe-inline'");
        expect(contentSecurityPolicy).not.toContain('blob:');
        expect(response.text).toContain('<small>Sales</small>');
        expect(response.text).toContain('Service review');
        expect(response.text).toContain('Service plan');
        expect(response.text).toContain('Proposals');
        expect(response.text).toContain('Service catalogue');
        expect(response.text).toContain('>Work</a>');
        expect(response.text).toContain('>Sales</a>');
        expect(response.text).toContain('>Service desk</a>');
        const runtime = extractScopingRuntime(response.text);
        const expectedHash = scriptSourceHash(runtime);
        expect(scriptSourceDirective(contentSecurityPolicy)).toBe(`script-src 'self' ${expectedHash}`);
        expect(runtime).not.toContain('window.NoFriesSales = { start };');
        expect(runtime).toContain('bootstrap_request');
        expect(runtime).toContain('MutationObserver');
        expect(runtime).toContain('/api/sales/app.js');
        expect(response.text).not.toContain('/assets/scoping-app.js');
        expect(response.text).not.toContain('/js/app-loader.js');
        expect(response.text).not.toContain('/js/scoping-copy.js');
        expect(response.text).not.toContain('/app/mssp.js');
        expect(response.text).not.toContain('security.monitoring');
        expect(response.text).not.toContain('Stripe');

        const staticApp = await request(app).get('/assets/scoping-app.js');
        expect(staticApp.status).toBe(404);

        const protectedApp = await request(app).get('/api/sales/app.js');
        expect(protectedApp.status).toBe(200);
        expect(protectedApp.headers['content-type']).toContain('application/javascript');
        expect(protectedApp.text).toContain("pageHeading('Sales'");
        expect(protectedApp.text).toContain('Customer review and set-up workflow');
        expect(protectedApp.text).toContain('NO FRIES FICTIONAL DEMO');
        expect(protectedApp.text).toContain('prepare-demo-customer');

        const bootstrapWithoutApplication = await request(app).get('/api/sales/bootstrap');
        expect(bootstrapWithoutApplication.status).toBe(200);
        expect(bootstrapWithoutApplication.body.application).toBeUndefined();

        const legacy = await request(app).get('/mssp');
        expect(legacy.status).toBe(302);
        expect(legacy.headers.location).toBe('/scoping');
    });

    test('support shell embeds only a CSP-authorised loader before the protected runtime', async () => {
        const response = await request(app).get('/support');
        expect(response.status).toBe(200);
        expect(response.headers['cache-control']).toContain('no-store');
        expect(response.headers['x-robots-tag']).toBe('noindex, nofollow');
        const runtime = extractSupportRuntime(response.text);
        expect(scriptSourceDirective(response.headers['content-security-policy'])).toBe(
            `script-src 'self' ${scriptSourceHash(runtime)}`
        );
        expect(runtime).not.toContain('window.NoFriesSupport = { start };');
        expect(runtime).toContain('support_timeout');
        expect(response.text).toContain('/api/service-desk/app.js');
        expect((await request(app).get('/js/support-loader.js')).status).toBe(404);
    });

    test('operator can create a variable representative internal customer with approval-bound agentic onboarding', async () => {
        const lifecycleBootstrap = await request(app).get('/api/lifecycle/bootstrap');
        const injectedCustomer = await request(app)
            .post('/api/lifecycle/organisations')
            .send({
                expectedRevision: lifecycleBootstrap.body.revision,
                displayName: 'Injected Active Customer',
                recordType: 'customer',
                lifecycleState: 'active'
            });
        expect(injectedCustomer.status).toBe(409);
        expect(injectedCustomer.body.code).toBe('dedicated_flow_required');

        const rejected = await request(app)
            .post('/api/lifecycle/organisations/pilot')
            .send({
                expectedRevision: lifecycleBootstrap.body.revision,
                displayName: 'Unconfirmed Internal Pilot',
                expectedUsers: 1,
                expectedEndpoints: 2,
                devices: [
                    { id: 'dell_laptop', label: 'Dell laptop', platform: 'windows' },
                    { id: 'apple_macbook', label: 'Apple MacBook', platform: 'macos' }
                ]
            });
        expect(rejected.status).toBe(400);
        expect(rejected.body.code).toBe('internal_pilot_confirmation_required');

        const duplicateDevices = await request(app)
            .post('/api/lifecycle/organisations/pilot')
            .send({
                expectedRevision: lifecycleBootstrap.body.revision,
                displayName: 'Duplicate Device Pilot',
                primaryEmail: 'admin@example.com',
                expectedUsers: 1,
                expectedEndpoints: 2,
                devices: [
                    { id: 'same_device', label: 'Dell laptop', platform: 'windows' },
                    { id: 'SAME_DEVICE', label: 'Apple MacBook', platform: 'macos' }
                ],
                confirmInternalPilot: true
            });
        expect(duplicateDevices.status).toBe(400);
        expect(duplicateDevices.body.code).toBe('pilot_device_ids_not_unique');

        const unsupportedPlatform = await request(app)
            .post('/api/lifecycle/organisations/pilot')
            .send({
                expectedRevision: lifecycleBootstrap.body.revision,
                displayName: 'Unsupported Platform Pilot',
                primaryEmail: 'admin@example.com',
                expectedUsers: 1,
                expectedEndpoints: 1,
                devices: [
                    { id: 'bsd_box', label: 'BSD box', platform: 'freebsd' }
                ],
                confirmInternalPilot: true
            });
        expect(unsupportedPlatform.status).toBe(400);
        expect(unsupportedPlatform.body.code).toBe('pilot_device_platform_unsupported');
        const afterUnsupportedPlatform = await request(app).get('/api/lifecycle/bootstrap');
        expect(afterUnsupportedPlatform.body.revision).toBe(lifecycleBootstrap.body.revision);
        expect(afterUnsupportedPlatform.body.organisations).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ displayName: 'Unsupported Platform Pilot' })
        ]));

        const created = await request(app)
            .post('/api/lifecycle/organisations/pilot')
            .send({
                expectedRevision: lifecycleBootstrap.body.revision,
                displayName: 'No Fries Headquarters Route Test',
                primaryContactName: 'Test Admin',
                primaryEmail: 'admin@example.com',
                expectedUsers: 4,
                expectedEndpoints: 8,
                location: 'No Fries Headquarters',
                productivityPlatform: 'mixed',
                devices: [
                    { id: 'office_one', label: 'Office one', platform: 'windows' },
                    { id: 'office_two', label: 'Office two', platform: 'windows' },
                    { id: 'workshop_linux', label: 'Workshop Linux', platform: 'linux' }
                ],
                confirmInternalPilot: true
            });
        expect(created.status).toBe(201);
        expect(created.body.organisation).toMatchObject({
            lifecycleState: 'onboarding',
            recordType: 'customer',
            agenticManagement: {
                approvalRequired: true,
                externalChanges: false
            }
        });
        expect(created.body.organisation.customerMaster.estate).toMatchObject({
            contractedEndpoints: 8,
            plannedDevices: 3
        });
        expect(created.body.organisation.onboarding.devices).toHaveLength(3);

        const protectedApp = await request(app).get('/api/lifecycle/app.js');
        expect(protectedApp.status).toBe(200);
        expect(protectedApp.text).toContain('Create set-up customer');
        expect(protectedApp.text).toContain("name: 'devicePlan'");
        expect(protectedApp.text).toContain("min: '1', max: '50'");
        expect(protectedApp.text).toContain('representative computer row');
        expect(protectedApp.text).not.toContain("min: '2', max: '2', readonly");
        expect(protectedApp.text).not.toContain('windowsLabel');
        expect(protectedApp.text).not.toContain('with two computer plans');
        expect(protectedApp.text).toContain('Set-up coordinator');
        expect(protectedApp.text).toContain('Request activation');
        expect(protectedApp.text).toContain('Approve activation');
        expect(protectedApp.text).toContain('Execute activation');
        expect(protectedApp.text).toContain('Open Service Desk');
        expect(protectedApp.text).toContain('Operator tasks');
        expect(protectedApp.text).toContain('Key discovery details recorded · service review pending');
        expect(protectedApp.text).toContain('field-provenance');
    });

    test('read-only MCP endpoint advertises lifecycle search and fetch without exposing data anonymously', async () => {
        const initialised = await request(app)
            .post('/api/mcp')
            .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
        expect(initialised.status).toBe(200);
        expect(initialised.body.result).toMatchObject({
            protocolVersion: '2025-06-18',
            serverInfo: { name: 'nofries-lifecycle' }
        });

        const listed = await request(app)
            .post('/api/mcp')
            .send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        expect(listed.status).toBe(200);
        expect(listed.body.result.tools.map((tool) => tool.name)).toEqual(['search', 'fetch']);
        expect(listed.body.result.tools).toEqual(expect.arrayContaining([
            expect.objectContaining({
                name: 'search',
                annotations: expect.objectContaining({ readOnlyHint: true, destructiveHint: false })
            })
        ]));
    });

    test('operator-confirmed lifecycle discovery creates one linked prefilled MSP scoping assessment', async () => {
        const lifecycleBootstrap = await request(app).get('/api/lifecycle/bootstrap');
        const created = await request(app)
            .post('/api/lifecycle/organisations')
            .send({
                expectedRevision: lifecycleBootstrap.body.revision,
                displayName: 'Handoff Test Limited',
                facts: [
                    { field: 'company.name', value: 'Handoff Test Limited', certainty: 'explicit' },
                    { field: 'company.industry', value: 'Professional services', certainty: 'explicit' },
                    { field: 'company.summary', value: 'Recurring support delays', certainty: 'explicit' },
                    { field: 'endpoints.estimatedCount', value: '480', certainty: 'explicit' },
                    { field: 'security.tools', value: 'Microsoft Defender', certainty: 'explicit' },
                    { field: 'applications.important', value: 'Xero; Practice management platform', certainty: 'explicit' }
                ]
            });
        expect(created.status).toBe(201);
        const organisationId = created.body.organisation.organisationId;

        const discovery = await request(app)
            .patch(`/api/lifecycle/organisations/${organisationId}`)
            .send({
                expectedRevision: created.body.revision,
                lifecycleState: 'discovery'
            });
        expect(discovery.status).toBe(200);
        const prepared = await request(app)
            .post(`/api/lifecycle/organisations/${organisationId}/prepare-scoping`)
            .send({ expectedRevision: discovery.body.revision });
        expect(prepared.status).toBe(200);
        expect(prepared.body.handoff.url).toBe(`/scoping?organisationId=${organisationId}`);

        const preview = await request(app)
            .get(`/api/sales/lifecycle-handoffs/${organisationId}`);
        expect(preview.status).toBe(200);
        expect(preview.body.preview).toMatchObject({
            organisationId,
            displayName: 'Handoff Test Limited',
            linked: null
        });
        expect(preview.body.preview.answers['estate.endpoints'].value).toBe('250_plus');
        expect(preview.body.preview.answers['applications.critical'].value).toContain('Xero');
        expect(preview.body.preview.answers['security.endpoint'].value).toBe('');
        expect(preview.body.preview.questionGaps).toEqual(expect.arrayContaining([
            expect.objectContaining({ questionId: 'productivity.platform', status: 'unknown' }),
            expect.objectContaining({ questionId: 'security.endpoint', status: 'unknown' })
        ]));

        const confirmed = await request(app)
            .post(`/api/sales/lifecycle-handoffs/${organisationId}`)
            .send({
                expectedRevision: preview.body.revision,
                lifecycleRevision: preview.body.lifecycleRevision,
                confirmOrganisationId: organisationId,
                mode: 'create'
            });
        expect(confirmed.status).toBe(201);
        expect(confirmed.body.customer).toMatchObject({
            name: 'Handoff Test Limited',
            industry: 'Professional services',
            lifecycleOrganisationId: organisationId
        });
        expect(confirmed.body.assessment).toMatchObject({
            customerId: confirmed.body.customer.id,
            lifecycleOrganisationId: organisationId,
            status: 'draft',
            prefill: {
                source: 'lifecycle_discovery',
                organisationId
            }
        });
        expect(confirmed.body.assessment.answers['estate.endpoints'].value).toBe('250_plus');

        const linkedBootstrap = await request(app).get('/api/sales/bootstrap');
        expect(linkedBootstrap.body.assessments.find((assessment) => (
            assessment.id === confirmed.body.assessment.id
        ))).toMatchObject({
            lifecycleOrganisationId: organisationId
        });

        const linkedLifecycle = await request(app)
            .get(`/api/lifecycle/organisations/${organisationId}`);
        expect(linkedLifecycle.body.organisation).toMatchObject({
            lifecycleState: 'scoping',
            links: { salesCustomerId: confirmed.body.customer.id },
            scope: {
                status: 'in_progress',
                salesCustomerId: confirmed.body.customer.id,
                assessmentId: confirmed.body.assessment.id
            }
        });

        const exported = await request(app)
            .get(`/api/lifecycle/organisations/${organisationId}/export`);
        expect(exported.status).toBe(200);
        expect(exported.headers['content-disposition']).toContain(`nofries-lifecycle-${organisationId}.json`);
        expect(exported.body.organisation.organisationId).toBe(organisationId);

        const blockedDeletion = await request(app)
            .delete(`/api/lifecycle/organisations/${organisationId}`)
            .send({
                expectedRevision: linkedLifecycle.body.revision,
                confirmName: 'Handoff Test Limited'
            });
        expect(blockedDeletion.status).toBe(409);
        expect(blockedDeletion.body.code).toBe('linked_lifecycle_deletion_blocked');

        const repeatedPreview = await request(app)
            .get(`/api/sales/lifecycle-handoffs/${organisationId}`);
        expect(repeatedPreview.body.preview.linked).toMatchObject({
            customerId: confirmed.body.customer.id,
            assessmentId: confirmed.body.assessment.id
        });
        const replayed = await request(app)
            .post(`/api/sales/lifecycle-handoffs/${organisationId}`)
            .send({
                expectedRevision: repeatedPreview.body.revision,
                lifecycleRevision: repeatedPreview.body.lifecycleRevision,
                confirmOrganisationId: organisationId,
                mode: 'resume'
            });
        expect(replayed.status).toBe(200);
        expect(replayed.body.convergence).toBe('completed');
        expect(replayed.body.operation.operationId).toBe(confirmed.body.operation.operationId);
    });

    test('lifecycle handoff requires the operator to link a reviewed same-name customer candidate', async () => {
        const salesBootstrap = await request(app).get('/api/sales/bootstrap');
        const candidate = await request(app)
            .post('/api/sales/customers')
            .send({
                expectedRevision: salesBootstrap.body.revision,
                name: 'Candidate Link Limited'
            });
        expect(candidate.status).toBe(201);

        const lifecycleBootstrap = await request(app).get('/api/lifecycle/bootstrap');
        const created = await request(app)
            .post('/api/lifecycle/organisations')
            .send({
                expectedRevision: lifecycleBootstrap.body.revision,
                displayName: 'Candidate Link Limited',
                facts: [
                    { field: 'company.name', value: 'Candidate Link Limited', certainty: 'explicit' },
                    { field: 'company.summary', value: 'Needs reliable support', certainty: 'explicit' }
                ]
            });
        const discovery = await request(app)
            .patch(`/api/lifecycle/organisations/${created.body.organisation.organisationId}`)
            .send({ expectedRevision: created.body.revision, lifecycleState: 'discovery' });
        const prepared = await request(app)
            .post(`/api/lifecycle/organisations/${created.body.organisation.organisationId}/prepare-scoping`)
            .send({ expectedRevision: discovery.body.revision });
        const preview = await request(app)
            .get(`/api/sales/lifecycle-handoffs/${created.body.organisation.organisationId}`);
        expect(preview.body.preview.candidateCustomers).toEqual([
            expect.objectContaining({ id: candidate.body.customer.id, name: 'Candidate Link Limited' })
        ]);

        const unreviewed = await request(app)
            .post(`/api/sales/lifecycle-handoffs/${created.body.organisation.organisationId}`)
            .send({
                expectedRevision: preview.body.revision,
                lifecycleRevision: preview.body.lifecycleRevision,
                confirmOrganisationId: created.body.organisation.organisationId,
                mode: 'link',
                customerId: 'customer_not_reviewed'
            });
        expect(unreviewed.status).toBe(409);
        expect(unreviewed.body.code).toBe('customer_match_selection_required');

        const linked = await request(app)
            .post(`/api/sales/lifecycle-handoffs/${created.body.organisation.organisationId}`)
            .send({
                expectedRevision: preview.body.revision,
                lifecycleRevision: preview.body.lifecycleRevision,
                confirmOrganisationId: created.body.organisation.organisationId,
                mode: 'link',
                customerId: candidate.body.customer.id
            });
        expect(linked.status).toBe(201);
        expect(linked.body.customer.id).toBe(candidate.body.customer.id);
        expect(linked.body.customer.lifecycleOrganisationId).toBe(created.body.organisation.organisationId);
        expect(prepared.body.handoff.integrationStatus).toBe('operator_confirmation_required');
    });

    test('identity parser captures the Microsoft Entra tenant claim', () => {
        const parsed = parseStaticWebAppsPrincipal(principal('admin@example.com', 'nofries-test-tenant', 'Admin User'));
        expect(parsed.email).toBe('admin@example.com');
        expect(parsed.tenantId).toBe('nofries-test-tenant');
        expect(parsed.name).toBe('Admin User');
    });

    test('hosted tenant access fails closed for unapproved identities', async () => {
        const previousAuth = process.env.NOFRIES_REQUIRE_AUTH;
        process.env.NOFRIES_REQUIRE_AUTH = 'true';
        try {
            const missing = await request(app).get('/api/sales/bootstrap');
            expect(missing.status).toBe(403);
            expect(missing.body.reason).toBe('authentication_required');

            const unapproved = await request(app)
                .get('/api/sales/bootstrap')
                .set('x-ms-client-principal', principal('outsider@invalid.example'));
            expect(unapproved.status).toBe(403);
            expect(unapproved.body.code).toBe('tenant_access_required');

            const approved = await request(app)
                .get('/api/sales/bootstrap')
                .set('x-ms-client-principal', principal('admin@example.com'));
            expect(approved.status).toBe(200);
            expect(approved.body.user.role).toBe('admin');
            expect(approved.body.user.capabilities).toContain('catalogue:publish');
        } finally {
            process.env.NOFRIES_REQUIRE_AUTH = previousAuth;
        }
    });

    test('tenant access remains fail-closed when the authentication setting is omitted', async () => {
        const previousAuth = process.env.NOFRIES_REQUIRE_AUTH;
        delete process.env.NOFRIES_REQUIRE_AUTH;
        try {
            const response = await request(app)
                .get('/api/sales/bootstrap?email=admin@example.com')
                .set('X-NoFries-Email', 'admin@example.com');
            expect(response.status).toBe(403);
            expect(response.body.reason).toBe('authentication_required');
        } finally {
            process.env.NOFRIES_REQUIRE_AUTH = previousAuth;
        }
    });

    test('workspace mutations reject cross-origin browser requests', async () => {
        const response = await request(app)
            .post('/api/sales/customers')
            .set('Origin', 'https://attacker.invalid')
            .set('Sec-Fetch-Site', 'cross-site')
            .send({ name: 'Should not be created' });
        expect(response.status).toBe(403);
        expect(response.body.code).toBe('same_origin_required');
    });

    test('hosted mutations reject requests without a browser same-origin signal', () => {
        const previousAuth = process.env.NOFRIES_REQUIRE_AUTH;
        process.env.NOFRIES_REQUIRE_AUTH = 'true';
        try {
            expect(() => assertSameOriginForMutation({
                method: 'POST',
                headers: {}
            })).toThrow(expect.objectContaining({
                statusCode: 403,
                details: { code: 'same_origin_required' }
            }));

            expect(() => assertSameOriginForMutation({
                method: 'POST',
                headers: { 'sec-fetch-site': 'same-origin' }
            })).not.toThrow();
        } finally {
            process.env.NOFRIES_REQUIRE_AUTH = previousAuth;
        }
    });

    test('rate limiting ignores a caller-supplied forwarded address before the edge address', () => {
        expect(getClientKeyFromHeaders({
            'x-forwarded-for': '198.51.100.77, 192.0.2.44:443'
        }, '203.0.113.9')).toBe('192.0.2.44');
    });

    test('same-origin checks reject Azure preview origins for protected mutations', () => {
        const previousPublicUrl = process.env.NOFRIES_PUBLIC_URL;
        process.env.NOFRIES_PUBLIC_URL = 'https://nofries.nz';
        try {
            expect(() => assertSameOriginForMutation({
                method: 'POST',
                headers: {
                    origin: 'https://ambitious-pond-05b99161e-42.westus2.7.azurestaticapps.net',
                    host: 'preview-api.internal.azurestaticapps.net',
                    'x-forwarded-host': 'preview-api.internal.azurestaticapps.net',
                    'sec-fetch-site': 'same-origin'
                }
            })).toThrow(expect.objectContaining({
                statusCode: 403,
                details: { code: 'same_origin_required' }
            }));
        } finally {
            if (previousPublicUrl == null) {
                delete process.env.NOFRIES_PUBLIC_URL;
            } else {
                process.env.NOFRIES_PUBLIC_URL = previousPublicUrl;
            }
        }
    });

    test('same-origin checks reject a non-Azure origin even when the fetch-site header is spoofed', () => {
        const previousPublicUrl = process.env.NOFRIES_PUBLIC_URL;
        process.env.NOFRIES_PUBLIC_URL = 'https://nofries.nz';
        try {
            expect(() => assertSameOriginForMutation({
                method: 'POST',
                headers: {
                    origin: 'https://attacker.invalid',
                    'sec-fetch-site': 'same-origin'
                }
            })).toThrow(expect.objectContaining({
                statusCode: 403,
                details: { code: 'same_origin_required' }
            }));
        } finally {
            if (previousPublicUrl == null) {
                delete process.env.NOFRIES_PUBLIC_URL;
            } else {
                process.env.NOFRIES_PUBLIC_URL = previousPublicUrl;
            }
        }
    });

    test('same-origin checks accept the configured public host behind a proxy', () => {
        const previousPublicUrl = process.env.NOFRIES_PUBLIC_URL;
        process.env.NOFRIES_PUBLIC_URL = 'https://nofries.nz';
        try {
            expect(() => assertSameOriginForMutation({
                method: 'POST',
                headers: {
                    origin: 'https://nofries.nz',
                    host: 'nofries-gap-analysis.azurestaticapps.net',
                    'x-forwarded-host': 'nofries-gap-analysis.azurestaticapps.net',
                    'sec-fetch-site': 'same-origin'
                }
            })).not.toThrow();
        } finally {
            if (previousPublicUrl == null) {
                delete process.env.NOFRIES_PUBLIC_URL;
            } else {
                process.env.NOFRIES_PUBLIC_URL = previousPublicUrl;
            }
        }
    });

    test('blueprint contains the compact six-section MSP onboarding scope', () => {
        const blueprint = getAssessmentBlueprint();
        expect(blueprint.estimatedMinutes).toBe(25);
        expect(blueprint.sections).toHaveLength(6);
        expect(blueprint.questions).toHaveLength(22);
        expect(blueprint.questions.find((item) => item.id === 'productivity.platform').options.map((item) => item.value)).toContain('microsoft_365');
        expect(blueprint.questions.find((item) => item.id === 'support.frustrations').type).toBe('multi');
        expect(blueprint.questions.find((item) => item.id === 'operations.incumbent_handover')).toBeDefined();
        expect(blueprint.questions.find((item) => item.id === 'priorities.next_step').options.map((item) => item.value)).toContain('proposal');
        expect(blueprint.questions.find((item) => item.id === 'security.cloud_posture')).toBeUndefined();
        expect(blueprint.questions.find((item) => item.id === 'network.service_needs')).toBeUndefined();
    });

    test('private default catalogue contains only No Fries MSP services with valid rules', async () => {
        const catalogueState = createNoFriesCatalogueState();
        const services = catalogueState.versions[0].services;
        const blueprint = getAssessmentBlueprint();
        const questions = new Map(blueprint.questions.map((item) => [item.id, item]));

        expect(NOFRIES_SERVICE_COUNT).toBe(10);
        expect(services).toHaveLength(10);
        expect(services.map((item) => item.name)).toEqual(expect.arrayContaining([
            'No Fries Managed IT',
            'Phone, chat and email support',
            'Managed device care',
            'Microsoft 365 support',
            'Google Workspace support',
            'Threat protection and after-hours security help',
            'Work-file backup and recovery',
            'Proof every month',
            'Getting started with No Fries Managed IT'
        ]));
        services.forEach((service) => {
            expect(service.classification).toBe('internal');
            Object.values(service.rules).flat().forEach((rule) => {
                const question = questions.get(rule.questionId);
                expect(question).toBeDefined();
                const allowed = new Set((question.options || []).map((item) => item.value));
                rule.values.forEach((value) => expect(allowed.has(value)).toBe(true));
            });
        });
        const serialised = JSON.stringify(services);
        expect(serialised).not.toContain('Kordia');
        expect(serialised).not.toContain('MDR enabled by Microsoft');
        expect(serialised).not.toContain('sharepoint.com');

        const bootstrap = await request(app).get('/api/sales/bootstrap');
        expect(bootstrap.body.counts.publishedServices).toBe(10);
        const catalogue = await request(app).get('/api/sales/catalogue');
        expect(catalogue.body.published.services).toHaveLength(10);
    });

    test('No Fries rules identify standard managed IT components from MSP discovery', () => {
        const services = createNoFriesCatalogueState().versions[0].services;
        const recommendations = matchServices({ answers: answerSet() }, services);
        const byKey = new Map(recommendations.map((item) => [item.serviceKey, item]));

        expect(byKey.get('managed-it-core').fit).toBe('strong_fit');
        expect(byKey.get('ai-service-desk').fit).toBe('strong_fit');
        expect(byKey.get('datto-rmm').fit).toBe('strong_fit');
        expect(byKey.get('microsoft-365-admin').fit).toBe('strong_fit');
        expect(byKey.get('endpoint-security').fit).toBe('strong_fit');
        expect(byKey.get('endpoint-backup').fit).toBe('strong_fit');
        expect(byKey.get('supplier-coordination').fit).toBe('strong_fit');
        expect(byKey.get('customer-onboarding').fit).toBe('strong_fit');
    });

    test('Google Workspace and micro-estate discovery map to the reusable lean service', () => {
        const services = createNoFriesCatalogueState().versions[0].services;
        const recommendations = matchServices({
            answers: {
                'business.priorities': answer(['reliable_support', 'ownership', 'cost']),
                'business.concerns': answer(['no_ownership', 'capacity']),
                'estate.endpoints': answer('under_10'),
                'productivity.platform': answer('google_workspace'),
                'support.frustrations': answer(['slow_response', 'poor_follow_through']),
                'support.hours': answer('business_hours'),
                'support.delivery': answer('remote_first')
            }
        }, services);
        const byKey = new Map(recommendations.map((item) => [item.serviceKey, item]));

        expect(byKey.get('managed-it-core').fit).toBe('strong_fit');
        expect(byKey.get('ai-service-desk').fit).toBe('strong_fit');
        expect(byKey.get('datto-rmm').fit).not.toBe('not_currently_suitable');
        expect(byKey.get('google-workspace-admin').fit).toBe('strong_fit');
        expect(byKey.get('microsoft-365-admin').fit).not.toBe('strong_fit');
    });

    test('known system-seeded catalogues are retained and superseded by immutable v4 without replacing manual catalogues', () => {
        const legacy = {
            publishedVersionId: 'catalogue_nofries_msp_2026_08_16',
            versions: [{
                id: 'catalogue_nofries_msp_2026_08_16',
                versionNumber: 1,
                label: 'No Fries managed IT catalogue — 16 August 2026',
                status: 'published',
                services: []
            }]
        };
        const upgraded = upgradeNoFriesCatalogueState(legacy);
        expect(upgraded.publishedVersionId).toBe(CATALOGUE_VERSION_ID);
        expect(upgraded.versions).toHaveLength(2);
        expect(upgraded.versions[0].status).toBe('superseded');
        expect(upgraded.versions[1].services).toHaveLength(10);
        expect(upgraded.versions[1]).toMatchObject({
            id: 'catalogue_nofries_msp_2026_08_23_v4',
            versionNumber: 4,
            label: 'No Fries Managed IT catalogue — 23 August 2026',
            importedAt: '2026-08-23T09:00:00.000Z',
            publishedAt: '2026-08-23T09:00:00.000Z'
        });

        const v3Document = {
            id: 'catalogue_nofries_msp_2026_08_19_v3',
            versionNumber: 3,
            label: 'No Fries Lean Managed IT catalogue — 19 August 2026',
            status: 'published',
            serviceCount: 1,
            services: [{
                id: 'service_managed_it_core',
                key: 'managed-it-core',
                name: 'No Fries Lean Managed IT',
                sourceDocuments: ['No Fries Lean Managed IT service guide — 19 August 2026']
            }],
            warnings: [{ row: 1, message: 'Retained v3 warning' }],
            importedBy: 'system:catalogue-seed',
            importedAt: '2026-08-19T09:00:00.000Z',
            publishedBy: 'system:catalogue-seed',
            publishedAt: '2026-08-19T09:00:00.000Z'
        };
        const v3Catalogue = {
            publishedVersionId: v3Document.id,
            versions: [v3Document]
        };
        const originalV3Catalogue = JSON.parse(JSON.stringify(v3Catalogue));
        const upgradedV3 = upgradeNoFriesCatalogueState(v3Catalogue);
        const retainedV3 = upgradedV3.versions.find((version) => version.id === v3Document.id);
        const currentV4 = upgradedV3.versions.find((version) => version.id === CATALOGUE_VERSION_ID);

        expect(v3Catalogue).toEqual(originalV3Catalogue);
        expect(upgradedV3.publishedVersionId).toBe('catalogue_nofries_msp_2026_08_23_v4');
        expect(retainedV3).toEqual(Object.assign({}, originalV3Catalogue.versions[0], {
            status: 'superseded'
        }));
        expect(currentV4).toMatchObject({
            id: 'catalogue_nofries_msp_2026_08_23_v4',
            versionNumber: 4,
            status: 'published'
        });
        expect(currentV4.id).not.toBe(retainedV3.id);
        expect(crypto.createHash('sha256').update(JSON.stringify(currentV4.services)).digest('hex'))
            .not.toBe(crypto.createHash('sha256').update(JSON.stringify(retainedV3.services)).digest('hex'));

        const manual = {
            publishedVersionId: 'catalogue_customer_approved',
            versions: [{ id: 'catalogue_customer_approved', status: 'published', services: [] }]
        };
        expect(upgradeNoFriesCatalogueState(manual)).toEqual(manual);
    });

    test('catalogue validator rejects unknown questions and accepts an auditable MSP template', () => {
        const valid = validateCatalogueCsv(catalogueCsv());
        expect(valid.errors).toEqual([]);
        expect(valid.services).toHaveLength(2);
        expect(valid.services[0].rules.strong[0]).toEqual({
            questionId: 'security.monitoring',
            values: ['absent', 'business_hours']
        });

        const invalid = validateCatalogueCsv(catalogueCsv().replace('security.monitoring=absent|business_hours', 'made.up.question=yes'));
        expect(invalid.errors.some((item) => item.message.includes('Unknown assessment question'))).toBe(true);
    });

    test('administrator can import and publish a tenant-private catalogue', async () => {
        const template = await request(app).get('/api/sales/catalogue/template');
        expect(template.status).toBe(200);
        expect(template.headers['content-type']).toContain('text/csv');
        expect(template.text).toContain('service_key');

        const bootstrap = await request(app).get('/api/sales/bootstrap');
        const imported = await request(app)
            .post('/api/sales/catalogue/import')
            .send({
                expectedRevision: bootstrap.body.revision,
                label: 'Approved No Fries pilot catalogue',
                csv: catalogueCsv()
            });
        expect(imported.status).toBe(201);
        expect(imported.body.version.status).toBe('draft');
        expect(imported.body.version.services).toHaveLength(2);

        const published = await request(app)
            .post('/api/sales/catalogue/publish')
            .send({
                expectedRevision: imported.body.revision,
                versionId: imported.body.version.id
            });
        expect(published.status).toBe(200);
        expect(published.body.published.status).toBe('published');

        const catalogue = await request(app).get('/api/sales/catalogue');
        expect(catalogue.body.published.services).toHaveLength(2);
        expect(catalogue.body.published.services[0].classification).toBe('restricted');
    });

    test('consultants can read but cannot import or publish the service catalogue', async () => {
        const previousAuth = process.env.NOFRIES_REQUIRE_AUTH;
        process.env.NOFRIES_REQUIRE_AUTH = 'true';
        try {
            const read = await request(app)
                .get('/api/sales/catalogue')
                .set('x-ms-client-principal', principal('consultant@example.com'));
            expect(read.status).toBe(200);

            const write = await request(app)
                .post('/api/sales/catalogue/import')
                .set('x-ms-client-principal', principal('consultant@example.com'))
                .set('Sec-Fetch-Site', 'same-origin')
                .send({ csv: catalogueCsv(), expectedRevision: read.body.revision });
            expect(write.status).toBe(403);
            expect(write.body.code).toBe('capability_required');
        } finally {
            process.env.NOFRIES_REQUIRE_AUTH = previousAuth;
        }
    });

    test('full customer scope, matching, review, proposal, export, and optional CRM preview flow works', async () => {
        const bootstrap = (await request(app).get('/api/sales/bootstrap')).body;
        const customerResponse = await request(app)
            .post('/api/sales/customers')
            .send({
                expectedRevision: bootstrap.revision,
                name: 'Fictional Logistics Ltd',
                industry: 'Logistics',
                region: 'Auckland',
                classification: 'internal'
            });
        expect(customerResponse.status).toBe(201);
        const customer = customerResponse.body.customer;

        const assessmentResponse = await request(app)
            .post('/api/sales/assessments')
            .send({
                expectedRevision: customerResponse.body.revision,
                customerId: customer.id,
                title: 'Managed IT scope'
            });
        expect(assessmentResponse.status).toBe(201);
        const assessmentId = assessmentResponse.body.assessment.id;

        const saved = await request(app)
            .put(`/api/sales/assessments/${assessmentId}/answers`)
            .send({
                expectedRevision: assessmentResponse.body.revision,
                status: 'completed',
                answers: answerSet()
            });
        expect(saved.status).toBe(200);
        expect(saved.body.assessment.status).toBe('completed');
        expect(saved.body.assessment.answers['security.cloud_posture']).toBeUndefined();

        const matched = await request(app)
            .post(`/api/sales/assessments/${assessmentId}/match`)
            .send({ expectedRevision: saved.body.revision });
        expect(matched.status).toBe(200);
        expect(matched.body.assessment.recommendations).toHaveLength(2);
        const managedSecurity = matched.body.assessment.recommendations.find((item) => item.serviceKey === 'managed-security');
        expect(managedSecurity.fit).toBe('strong_fit');
        expect(managedSecurity.reasons.join(' ')).toContain('Business-hours response only');
        expect(managedSecurity.blockers).toEqual([]);

        const reviewed = await request(app)
            .post(`/api/sales/assessments/${assessmentId}/recommendations/${managedSecurity.id}`)
            .send({
                expectedRevision: matched.body.revision,
                decision: 'accepted',
                roadmap: 'now',
                estimatedMrr: 5000,
                oneOffRevenue: 12000,
                owner: 'Fictional consultant',
                nextAction: 'Validate endpoint coverage and transition plan',
                customerOutcome: 'Consistent endpoint protection with managed alert response',
                consultantRationale: 'The customer has only business-hours security response.'
            });
        expect(reviewed.status).toBe(200);
        expect(reviewed.body.recommendation.review.decision).toBe('accepted');

        const proposalResponse = await request(app)
            .post(`/api/sales/assessments/${assessmentId}/proposal`)
            .send({ expectedRevision: reviewed.body.revision });
        expect(proposalResponse.status).toBe(201);
        const proposal = proposalResponse.body.proposal;
        expect(proposal.recommendations).toHaveLength(1);
        expect(proposal.pricing).toMatchObject({
            policyId: 'managed_it_2026_08_4',
            policyVersion: '2026.08.4',
            perUserMonthly: 119,
            includedEndpointsPerUser: 1,
            onboardingFrom: 750,
            additionalEndpointMonthly: 20,
            additionalLocationMonthly: 125
        });
        expect(proposal.commercialPolicy).toMatchObject({
            policyId: 'managed_it_2026_08_4',
            policyVersion: '2026.08.4',
            serviceName: 'No Fries Managed IT'
        });
        expect(JSON.stringify(proposal)).not.toContain('estimatedMrr');

        const aiReview = await request(app)
            .post(`/api/sales/proposals/${proposal.id}/review`)
            .send({ expectedRevision: proposalResponse.body.revision });
        expect(aiReview.status).toBe(200);
        expect(aiReview.body.review).toMatchObject({
            reviewId: expect.any(String),
            sourceRevision: expect.any(Number),
            sourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            suggestionSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            identities: {
                promptVersion: 'proposal-review-v2',
                outputSchemaVersion: 'proposal-review-schema-v1',
                policyId: 'managed_it_2026_08_4'
            }
        });
        const mismatchedAccept = await request(app)
            .put(`/api/sales/proposals/${proposal.id}`)
            .send({
                expectedRevision: aiReview.body.revision,
                title: aiReview.body.review.suggestedProposal.title,
                executiveSummary: `${aiReview.body.review.suggestedProposal.executiveSummary} Unreviewed change.`,
                objectives: aiReview.body.review.suggestedProposal.objectives,
                observations: aiReview.body.review.suggestedProposal.observations,
                assumptions: aiReview.body.review.suggestedProposal.assumptions,
                nextStep: aiReview.body.review.suggestedProposal.nextStep,
                commercial: proposal.commercial,
                recommendations: aiReview.body.review.suggestedProposal.recommendations,
                reviewFeedback: {
                    reviewId: aiReview.body.review.reviewId,
                    outcome: 'accepted',
                    changedSections: aiReview.body.review.changedSections
                },
                status: 'draft'
            });
        expect(mismatchedAccept.status).toBe(409);
        expect(mismatchedAccept.body.code).toBe('proposal_review_feedback_content_mismatch');
        const persistedApply = await request(app)
            .put(`/api/sales/proposals/${proposal.id}`)
            .send({
                expectedRevision: aiReview.body.revision,
                title: aiReview.body.review.suggestedProposal.title,
                executiveSummary: aiReview.body.review.suggestedProposal.executiveSummary,
                objectives: aiReview.body.review.suggestedProposal.objectives,
                observations: aiReview.body.review.suggestedProposal.observations,
                assumptions: aiReview.body.review.suggestedProposal.assumptions,
                nextStep: aiReview.body.review.suggestedProposal.nextStep,
                commercial: proposal.commercial,
                recommendations: aiReview.body.review.suggestedProposal.recommendations,
                reviewFeedback: {
                    reviewId: aiReview.body.review.reviewId,
                    outcome: 'accepted',
                    changedSections: aiReview.body.review.changedSections
                },
                status: 'draft'
            });
        expect(persistedApply.status).toBe(200);
        expect(persistedApply.body.proposal.aiReview.feedback).toMatchObject({
            outcome: 'accepted',
            sourceSha256: aiReview.body.review.sourceSha256,
            suggestionSha256: aiReview.body.review.suggestionSha256,
            persistedProposalSha256: aiReview.body.review.suggestionSha256,
            resultingProposalRevision: persistedApply.body.revision
        });
        const persistedEdit = await request(app)
            .put(`/api/sales/proposals/${proposal.id}`)
            .send({
                expectedRevision: persistedApply.body.revision,
                title: aiReview.body.review.suggestedProposal.title,
                executiveSummary: `${aiReview.body.review.suggestedProposal.executiveSummary} Operator clarification.`,
                objectives: aiReview.body.review.suggestedProposal.objectives,
                observations: aiReview.body.review.suggestedProposal.observations,
                assumptions: aiReview.body.review.suggestedProposal.assumptions,
                nextStep: aiReview.body.review.suggestedProposal.nextStep,
                commercial: proposal.commercial,
                recommendations: aiReview.body.review.suggestedProposal.recommendations,
                reviewFeedback: {
                    reviewId: aiReview.body.review.reviewId,
                    outcome: 'edited',
                    changedSections: ['executiveSummary']
                },
                status: 'draft'
            });
        expect(persistedEdit.status).toBe(200);
        expect(persistedEdit.body.proposal.aiReview.feedback).toMatchObject({
            outcome: 'edited',
            changedSections: ['executiveSummary'],
            persistedProposalSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            resultingProposalRevision: persistedEdit.body.revision
        });
        const conflictingFeedback = await request(app)
            .post(`/api/sales/proposals/${proposal.id}/review-feedback`)
            .send({
                expectedRevision: persistedEdit.body.revision,
                reviewId: aiReview.body.review.reviewId,
                outcome: 'rejected',
                resultingProposalRevision: persistedEdit.body.revision
            });
        expect(conflictingFeedback.status).toBe(409);
        expect(conflictingFeedback.body.code).toBe('proposal_review_feedback_conflict');
        const reviewedProposal = await request(app).get(`/api/sales/proposals/${proposal.id}`);
        expect(reviewedProposal.body.proposal.aiReview).toMatchObject({
            reviewId: aiReview.body.review.reviewId,
            promptVersion: 'proposal-review-v2',
            outputSchemaVersion: 'proposal-review-schema-v1',
            policyId: 'managed_it_2026_08_4',
            sourceSha256: aiReview.body.review.sourceSha256,
            suggestionSha256: aiReview.body.review.suggestionSha256,
            feedback: { outcome: 'edited' },
            feedbackHistory: [
                expect.objectContaining({ outcome: 'accepted' }),
                expect.objectContaining({ outcome: 'edited' })
            ]
        });
        expect(reviewedProposal.body.proposal.aiReviewHistory).toEqual([
            expect.objectContaining({
                reviewId: aiReview.body.review.reviewId,
                sourceSha256: aiReview.body.review.sourceSha256,
                suggestionSha256: aiReview.body.review.suggestionSha256,
                feedbackHistory: [
                    expect.objectContaining({ outcome: 'accepted' }),
                    expect.objectContaining({ outcome: 'edited' })
                ]
            })
        ]);

        const blockedApproval = await request(app)
            .put(`/api/sales/proposals/${proposal.id}`)
            .send({
                expectedRevision: persistedEdit.body.revision,
                title: proposal.title,
                executiveSummary: proposal.executiveSummary,
                objectives: proposal.objectives,
                observations: proposal.observations,
                assumptions: proposal.assumptions,
                nextStep: proposal.nextStep,
                recommendations: proposal.recommendations,
                status: 'approved'
            });
        expect(blockedApproval.status).toBe(422);
        expect(blockedApproval.body.code).toBe('proposal_approval_blocked');
        expect(blockedApproval.body.warnings).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'exact_user_count_required' }),
            expect.objectContaining({ code: 'exact_endpoint_count_required' }),
            expect.objectContaining({ code: 'exact_location_count_required' }),
            expect.objectContaining({ code: 'commercial_confirmation_required' }),
            expect.objectContaining({ code: 'stale_next_step' }),
            expect.objectContaining({ code: 'raw_discovery_copy' })
        ]));

        const commercial = {
            ...proposal.commercial,
            userCount: 50,
            managedEndpointCount: 50,
            locationCount: 2,
            onboardingFeeExGst: 750,
            termMonths: 12,
            plannedStart: '2026-09-01',
            confirmed: true
        };
        const approved = await request(app)
            .put(`/api/sales/proposals/${proposal.id}`)
            .send({
                expectedRevision: persistedEdit.body.revision,
                title: proposal.title,
                executiveSummary: proposal.executiveSummary,
                objectives: proposal.objectives,
                observations: ['Business-hours security response and endpoint coverage need improvement.'],
                assumptions: proposal.assumptions,
                nextStep: 'Review and accept the managed IT proposal.',
                recommendations: proposal.recommendations,
                commercial,
                status: 'approved'
            });
        if (approved.status !== 200) {
            throw new Error(`Proposal approval failed: ${JSON.stringify(approved.body)}`);
        }
        expect(approved.status).toBe(200);
        expect(approved.body.proposal.status).toBe('approved');
        expect(approved.body.proposal.commercial).toMatchObject({
            userCount: 50,
            managedEndpointCount: 50,
            locationCount: 2,
            monthlyTotalExGst: 6075,
            confirmed: true
        });

        const word = await request(app).get(`/api/sales/proposals/${proposal.id}/export?format=word`);
        expect(word.status).toBe(200);
        expect(word.headers['content-type']).toContain('application/msword');
        expect(word.text).toContain('Fictional Logistics Ltd');
        expect(word.text).toContain('Managed endpoint security');
        expect(word.text).toContain('NZ$6,075 + GST per month');
        expect(word.text).toContain('Based on 50 supported people, 50 managed computers and 2 supported locations.');
        expect(word.text).toContain('Initial set-up: NZ$750 + GST.');
        expect(word.text).toContain('Proposed term: 12 months.');
        expect(word.text).not.toContain('5000');
        expect(word.text).not.toContain('Fictional consultant');

        const preview = await request(app)
            .post('/api/sales/integrations/dynamics/preview')
            .send({ proposalId: proposal.id });
        expect(preview.status).toBe(200);
        expect(preview.body.configured).toBe(false);
        expect(preview.body.payload.opportunities[0].estimatedMonthlyRevenue).toBe(5000);
        expect(preview.body.payload.opportunities[0].deduplicationKey).toContain(assessmentId);

        const blockedHandoff = await request(app)
            .post('/api/sales/integrations/dynamics/handoff')
            .send({
                expectedRevision: approved.body.revision,
                proposalId: proposal.id,
                confirmed: true
            });
        expect(blockedHandoff.status).toBe(503);
        expect(blockedHandoff.body.code).toBe('dynamics_not_configured');
    });

    test('optimistic revisions prevent a stale browser from overwriting tenant state', async () => {
        const bootstrap = (await request(app).get('/api/sales/bootstrap')).body;
        const first = await request(app)
            .post('/api/sales/customers')
            .send({
                expectedRevision: bootstrap.revision,
                name: 'Revision First'
            });
        expect(first.status).toBe(201);

        const stale = await request(app)
            .post('/api/sales/customers')
            .send({
                expectedRevision: bootstrap.revision,
                name: 'Revision Stale'
            });
        expect(stale.status).toBe(409);
        expect(stale.body.code).toBe('revision_conflict');
    });

    test('tenant storage is isolated by approved Entra tenant ID', async () => {
        const previous = {
            auth: process.env.NOFRIES_REQUIRE_AUTH,
            emails: process.env.NOFRIES_ALLOWED_EMAILS,
            tenants: process.env.NOFRIES_ALLOWED_TENANT_IDS,
            admins: process.env.NOFRIES_ADMIN_EMAILS
        };
        process.env.NOFRIES_REQUIRE_AUTH = 'true';
        process.env.NOFRIES_ALLOWED_EMAILS = 'one@example.com,two@example.com';
        process.env.NOFRIES_ALLOWED_TENANT_IDS = 'tenant-one,tenant-two';
        process.env.NOFRIES_ADMIN_EMAILS = 'one@example.com,two@example.com';
        try {
            const oneBootstrap = await request(app)
                .get('/api/sales/bootstrap')
                .set('x-ms-client-principal', principal('one@example.com', 'tenant-one'));
            const created = await request(app)
                .post('/api/sales/customers')
                .set('x-ms-client-principal', principal('one@example.com', 'tenant-one'))
                .set('Sec-Fetch-Site', 'same-origin')
                .send({
                    expectedRevision: oneBootstrap.body.revision,
                    name: 'Tenant One Customer'
                });
            expect(created.status).toBe(201);

            const twoBootstrap = await request(app)
                .get('/api/sales/bootstrap')
                .set('x-ms-client-principal', principal('two@example.com', 'tenant-two'));
            expect(twoBootstrap.status).toBe(200);
            expect(twoBootstrap.body.customers.find((item) => item.name === 'Tenant One Customer')).toBeUndefined();
            expect(twoBootstrap.body.tenant.id).toBe('tenant-two');
        } finally {
            process.env.NOFRIES_REQUIRE_AUTH = previous.auth;
            process.env.NOFRIES_ALLOWED_EMAILS = previous.emails;
            process.env.NOFRIES_ALLOWED_TENANT_IDS = previous.tenants || '';
            process.env.NOFRIES_ADMIN_EMAILS = previous.admins;
        }
    });

    test('admin deletion removes customer work while preserving a deletion audit event', async () => {
        let bootstrap = (await request(app).get('/api/sales/bootstrap')).body;
        const created = await request(app)
            .post('/api/sales/customers')
            .send({ expectedRevision: bootstrap.revision, name: 'Delete Me Ltd' });
        expect(created.status).toBe(201);

        const deleted = await request(app)
            .delete(`/api/sales/customers/${created.body.customer.id}`)
            .send({
                expectedRevision: created.body.revision,
                confirmName: 'Delete Me Ltd'
            });
        expect(deleted.status).toBe(200);

        bootstrap = (await request(app).get('/api/sales/bootstrap')).body;
        expect(bootstrap.customers.find((item) => item.id === created.body.customer.id)).toBeUndefined();
        const audit = await request(app).get('/api/sales/audit');
        expect(audit.body.events.some((item) => item.action === 'customer.deleted' && item.targetId === created.body.customer.id)).toBe(true);
    });

    test('legacy workspace, public sharing, and subscription routes stay retired', async () => {
        const account = await request(app).post('/api/account').send({});
        expect(account.status).toBe(410);
        expect(account.body.code).toBe('legacy_workspace_retired');

        const product = await request(app).get('/api/product/mssp.js');
        expect(product.status).toBe(410);

        const checkout = await request(app).post('/api/billing/checkout').send({});
        expect(checkout.status).toBe(410);

        const webhook = await request(app).post('/api/billing/webhook').send({});
        expect(webhook.status).toBe(410);
        expect(webhook.body.code).toBe('billing_disabled');

        const share = await request(app).get('/share/not-a-real-token');
        expect(share.status).toBe(302);
        expect(share.headers.location).toBe('/');
    });

    test('Azure Function sales route enforces the same tenant boundary and returns protected app JavaScript', async () => {
        const previousAuth = process.env.NOFRIES_REQUIRE_AUTH;
        process.env.NOFRIES_REQUIRE_AUTH = 'true';
        try {
            const denied = functionContext('bootstrap');
            await runSalesFunction(denied, {
                method: 'GET',
                headers: {
                    'x-ms-client-principal': principal('outsider@invalid.example')
                }
            });
            expect(denied.res.status).toBe(403);

            const allowed = functionContext('app.js');
            await runSalesFunction(allowed, {
                method: 'GET',
                headers: {
                    'x-ms-client-principal': principal('admin@example.com')
                }
            });
            expect(allowed.res.status).toBe(200);
            expect(allowed.res.headers['Content-Type']).toContain('application/javascript');
            expect(allowed.res.headers['Cache-Control']).toBe('private, no-store, max-age=0');
            expect(allowed.res.headers['Content-Security-Policy']).toContain("default-src 'none'");
            expect(allowed.res.headers['X-Content-Type-Options']).toBe('nosniff');
            expect(String(allowed.res.body)).toContain('NoFriesSales');
        } finally {
            process.env.NOFRIES_REQUIRE_AUTH = previousAuth;
        }
    });

    test('Azure Functions use explicit routes and derive sales paths from full request URLs', async () => {
        const functionDefinitions = fs.readdirSync(path.resolve(__dirname, '..', 'api'), { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => path.resolve(__dirname, '..', 'api', entry.name, 'function.json'))
            .filter((filePath) => fs.existsSync(filePath))
            .map((filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8')));
        const routes = functionDefinitions.map((definition) => (
            definition.bindings.find((binding) => binding.type === 'httpTrigger').route
        ));
        expect(routes).toContain('sales/app.js');
        expect(routes).toContain('sales/bootstrap');
        expect(routes).toContain('sales/assessments/{assessmentId?}/{action?}/{targetId?}');
        expect(routes).toContain('sales/lifecycle-handoffs/{organisationId}');
        expect(routes).toContain('lifecycle/retention');
        expect(routes).toContain('mcp');
        expect(routes).toContain('mcp-auth');
        expect(routes).toContain('mcp-oauth-metadata');
        expect(routes).toContain('mcp-oauth-authorize');
        expect(routes).toContain('mcp-oauth-token');
        expect(routes).not.toContain('lead');
        expect(routes.some((route) => route.includes('*'))).toBe(false);

        const previousAuth = process.env.NOFRIES_REQUIRE_AUTH;
        process.env.NOFRIES_REQUIRE_AUTH = 'true';
        try {
            const context = functionContext();
            context.bindingData = {};
            await salesBootstrapFunction(context, {
                method: 'GET',
                url: 'https://preview.invalid/api/sales/bootstrap?fresh=1',
                headers: {
                    'x-ms-client-principal': principal('admin@example.com')
                }
            });
            expect(context.res.status).toBe(200);
            expect(context.res.body.user.email).toBe('admin@example.com');
        } finally {
            process.env.NOFRIES_REQUIRE_AUTH = previousAuth;
        }
    });

    test('legacy Azure Function exports return 410 rather than reviving old billing or workspace APIs', async () => {
        const context = functionContext();
        await runFunction(context, { method: 'POST', headers: {}, body: {} }, handlers.account);
        expect(context.res.status).toBe(410);
        expect(context.res.body.code).toBe('legacy_workspace_retired');

        const billing = functionContext();
        await runFunction(billing, { method: 'POST', headers: {}, body: {} }, handlers.billingConfirm);
        expect(billing.res.status).toBe(410);
        expect(billing.res.body.code).toBe('billing_disabled');
    });

    test('production build contains the compact public funnel and hash-authorised authenticated runtimes', () => {
        execFileSync(process.execPath, ['scripts/build-static.js'], {
            cwd: path.resolve(__dirname, '..')
        });
        const dist = path.resolve(__dirname, '..', 'dist');
        expect(fs.existsSync(path.join(dist, 'index.html'))).toBe(true);
        expect(fs.existsSync(path.join(dist, 'home.css'))).toBe(true);
        expect(fs.existsSync(path.join(dist, 'scope.html'))).toBe(true);
        expect(fs.existsSync(path.join(dist, 'robots.txt'))).toBe(true);
        expect(fs.existsSync(path.join(dist, '.well-known', 'security.txt'))).toBe(true);
        expect(fs.existsSync(path.join(dist, 'app', 'mssp.html'))).toBe(true);
        expect(fs.existsSync(path.join(dist, 'app', 'support.html'))).toBe(true);
        expect(fs.existsSync(path.join(dist, 'assets', 'mssp.css'))).toBe(true);
        expect(fs.existsSync(path.join(dist, 'assets', 'support.css'))).toBe(true);
        expect(fs.existsSync(path.join(dist, 'assets', 'operator.css'))).toBe(true);
        expect(fs.readFileSync(path.join(dist, 'assets', 'operator.css'), 'utf8')).toContain('[hidden] { display: none !important; }');
        expect(fs.existsSync(path.join(dist, 'assets', 'scoping-app.js'))).toBe(false);
        expect(fs.existsSync(path.join(dist, 'js', 'app-loader.js'))).toBe(false);
        expect(fs.existsSync(path.join(dist, 'js', 'support-loader.js'))).toBe(false);
        expect(fs.existsSync(path.join(dist, 'js', 'scoping-copy.js'))).toBe(false);
        expect(fs.existsSync(path.join(dist, 'js', 'home.js'))).toBe(true);
        expect(fs.existsSync(path.join(dist, 'js', 'operator-loader.js'))).toBe(true);
        expect(fs.existsSync(path.join(dist, 'js', 'prospect-assistant.js'))).toBe(true);
        expect(fs.existsSync(path.join(dist, 'js', 'scope-access.js'))).toBe(true);
        expect(fs.existsSync(path.join(dist, 'app', 'mssp.js'))).toBe(false);
        expect(fs.existsSync(path.join(dist, 'js', 'paywall.js'))).toBe(false);
        expect(fs.existsSync(path.join(dist, 'js', 'lead-form.js'))).toBe(false);
        expect(fs.existsSync(path.join(dist, 'founder.html'))).toBe(false);
        expect(fs.existsSync(path.join(dist, 'sample-report.html'))).toBe(false);
        expect(fs.existsSync(path.join(dist, 'sitemap.xml'))).toBe(false);
        const staticConfig = JSON.parse(fs.readFileSync(path.join(dist, 'staticwebapp.config.json'), 'utf8'));
        // Static Web Apps defaults an omitted allowedRoles field to anonymous.
        staticConfig.routes = staticConfig.routes.map(route => ({
            ...route, allowedRoles: route.allowedRoles ?? ['anonymous']
        }));
        expect(staticConfig.responseOverrides['401']).toBeUndefined();
        expect(staticConfig.responseOverrides['403']).toBeUndefined();
        const scopingAppRoute = staticConfig.routes.find((route) => route.route === '/assets/scoping-app.js');
        expect(scopingAppRoute).toBeUndefined();
        const scopingDocument = fs.readFileSync(path.join(dist, 'app', 'mssp.html'), 'utf8');
        const protectedStaticApp = extractScopingRuntime(scopingDocument);
        const expectedHash = scriptSourceHash(protectedStaticApp);
        const scopingRoute = staticConfig.routes.find((route) => route.route === '/scoping');
        expect(scopingRoute).toBeDefined();
        expect(scopingRoute.allowedRoles).toEqual(['anonymous']);
        expect(scopingRoute.headers['Cache-Control']).toBe('no-store');
        expect(scopingRoute.headers['X-Robots-Tag'].split(',').map(value => value.trim())).toEqual(['noindex', 'nofollow']);
        expect(scriptSourceDirective(scopingRoute.headers['Content-Security-Policy'])).toBe(`script-src 'self' ${expectedHash}`);
        expect(scopingRoute.headers['Content-Security-Policy']).not.toContain("'unsafe-inline'");
        expect(scopingRoute.headers['Content-Security-Policy']).not.toContain('blob:');
        const supportDocument = fs.readFileSync(path.join(dist, 'app', 'support.html'), 'utf8');
        const protectedSupportApp = extractSupportRuntime(supportDocument);
        const supportRoute = staticConfig.routes.find((route) => route.route === '/support');
        expect(supportRoute).toBeDefined();
        expect(supportRoute.allowedRoles).toEqual(['anonymous']);
        expect(scriptSourceDirective(supportRoute.headers['Content-Security-Policy'])).toBe(
            `script-src 'self' ${scriptSourceHash(protectedSupportApp)}`
        );
        for (const assetRoute of ['/assets/support.css', '/assets/portal.css', '/assets/operator.css']) {
            const assetRule = staticConfig.routes.find((route) => route.route === assetRoute);
            expect(assetRule).toMatchObject({
                headers: {
                    'X-Robots-Tag': 'noindex,nofollow'
                }
            });
            expect(assetRule.headers['Cache-Control']).toBe('no-store');
        }
        expect(protectedSupportApp).not.toContain('window.NoFriesSupport = { start };');
        expect(protectedSupportApp).toContain('support_timeout');
        expect(supportDocument).toContain('/api/service-desk/app.js');
        expect(staticConfig.routes.find((route) => route.route === '/api/mcp').allowedRoles).toEqual(['anonymous']);
        expect(staticConfig.routes.find((route) => route.route === '/api/mcp-auth').allowedRoles).toEqual(['anonymous']);
        expect(staticConfig.routes.find((route) => route.route === '/api/mcp-oauth-metadata').allowedRoles).toEqual(['anonymous']);
        expect(staticConfig.routes.find((route) => route.route === '/api/mcp-oauth-authorize').allowedRoles).toEqual(['anonymous']);
        expect(staticConfig.routes.find((route) => route.route === '/api/mcp-oauth-token').allowedRoles).toEqual(['anonymous']);
        expect(staticConfig.routes.find((route) => route.route === '/.well-known/oauth-authorization-server')).toMatchObject({
            rewrite: '/api/mcp-oauth-metadata',
            allowedRoles: ['anonymous']
        });
        expect(staticConfig.routes.find((route) => route.route === '/.well-known/oauth-protected-resource/api/mcp')).toMatchObject({
            rewrite: '/api/mcp-auth',
            allowedRoles: ['anonymous']
        });
        expect(protectedStaticApp).not.toContain('window.NoFriesSales = { start };');
        expect(protectedStaticApp).toContain('bootstrap_request');
        expect(protectedStaticApp).toContain('/api/sales/app.js');
        expect(protectedStaticApp).not.toContain('Kordia');
        expect(protectedStaticApp).not.toContain('security.monitoring=absent');
        const staticBundle = fs.readdirSync(dist, { recursive: true })
            .filter((entry) => fs.statSync(path.join(dist, entry)).isFile())
            .map((entry) => fs.readFileSync(path.join(dist, entry), 'utf8'))
            .join('\n');
        expect(staticBundle).not.toContain('security.monitoring=absent');
        expect(staticBundle).not.toContain('catalogue_nofries_msp_2026_08_16');
        expect(staticBundle).not.toContain('NOFRIES_SCOPE_SIGNING_SECRET');
        expect(staticBundle).not.toContain('STRIPE_SECRET_KEY');
        expect(staticBundle).not.toContain('Kordia');
        expect(staticBundle).not.toContain('/.auth/');
    });

    test('workspace detail rendering escapes stored text unless HTML is explicitly trusted', () => {
        const protectedApp = fs.readFileSync(path.resolve(__dirname, '..', 'api', 'shared', 'protectedAssets', 'mssp.js'), 'utf8');
        expect(protectedApp).toContain('allowHtml ? value : h(value)');
        expect(protectedApp).toContain("detailItem('Industry', customer.industry || 'Not captured')");
        expect(protectedApp).toContain("detailItem('Classification', classificationBadge(customer.classification), true)");
        expect(protectedApp).not.toContain('style="width:${progress}%"');
    });
});

// The J transport suite exercises the production app constructor and genuine
// H/I/auth/runtime factories. Only external I/O is synthetic: OIDC, the browser
// session/proof stores and an explicitly unavailable SQL pool. The restricted
// PostgreSQL suite separately proves successful SQL journeys and lock ordering.
const dashboardHttp = require('node:http');
const { MemoryBrowserSessionStore: DashboardMemorySessionStore } = require('../api/shared/browserSessionStore');
const { BrowserAuthError: DashboardBrowserAuthError } = require('../api/shared/browserAuth');
const dashboardUuid = value => '71000000-0000-4000-8000-' + String(value).padStart(12, '0');
const dashboardNow = Date.parse('2026-09-08T22:00:00.000Z');
let dashboardFixtureNumber = 0;
function dashboardLatch() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}
function dashboardHttpHarness(change = {}) {
    const serial = ++dashboardFixtureNumber;
    const tenant = dashboardUuid(1), client = dashboardUuid(2), subject = dashboardUuid(3);
    const instance = dashboardUuid(4), epoch = dashboardUuid(5);
    const state = { now: dashboardNow, bytes: 1, sequence: 100, ...change.state };
    const env = {
        NOFRIES_REQUIRE_AUTH: 'true', NOFRIES_PUBLIC_URL: 'https://dashboard-' + serial + '.invalid',
        NOFRIES_ENTRA_TENANT_ID: tenant, NOFRIES_ENTRA_CLIENT_ID: client,
        NOFRIES_ENTRA_CLIENT_SECRET: 'synthetic-http-test-only-secret',
        NOFRIES_ALLOWED_SUBJECTS: tenant + ':' + subject,
        ...change.env
    };
    const store = new DashboardMemorySessionStore();
    const load = store.loadSession.bind(store);
    store.loadSession = jest.fn(async id => {
        if (state.beforeLoad) await state.beforeLoad(id);
        const record = await load(id);
        return state.afterLoad ? state.afterLoad(id, record) : record;
    });
    store.createSession = jest.fn(store.createSession.bind(store));
    store.deleteSession = jest.fn(store.deleteSession.bind(store));
    const proofs = new Map();
    const proofStore = {
        createOriginalProof: jest.fn(async (key, value) => {
            if (proofs.has(key)) throw new Error('Synthetic conditional proof collision');
            proofs.set(key, JSON.parse(JSON.stringify(value)));
        }),
        readOriginalProof: jest.fn(async key => {
            if (state.beforeProof) await state.beforeProof();
            return proofs.has(key) ? JSON.parse(JSON.stringify(proofs.get(key))) : null;
        })
    };
    const clientApplication = {
        getAuthCodeUrl: jest.fn(async input => 'https://login.microsoftonline.com/' + tenant + '/oauth2/v2.0/authorize?' +
            new URLSearchParams({ client_id: client, redirect_uri: input.redirectUri, response_type: 'code',
                response_mode: 'form_post', state: input.state, nonce: input.nonce,
                code_challenge: input.codeChallenge, code_challenge_method: 'S256' })),
        acquireTokenByCode: jest.fn(async input => ({
            idTokenClaims: { tid: tenant, oid: subject, aud: client,
                iss: 'https://login.microsoftonline.com/' + tenant + '/v2.0', nonce: input.nonce,
                exp: Math.floor(state.now / 1000) + 600,
                name: 'Synthetic HTTP operator', preferred_username: 'http-operator@example.invalid' },
            account: { tenantId: tenant, localAccountId: subject }
        })),
        getTokenCache: () => ({ removeAccount: async () => {} })
    };
    const readExternalRuntimeEpoch = jest.fn(async () => ({ instanceId: instance, restoreEpoch: epoch }));
    const newRequestId = jest.fn(() => dashboardUuid(++state.sequence));
    const newOperationId = jest.fn(() => dashboardUuid(++state.sequence));
    const pool = { end: jest.fn(), connect: jest.fn(async () => { throw new Error('PRIVATE_SYNTHETIC_SQL_UNAVAILABLE'); }) };
    const configuration = {
        browserAuthOptions: { env, store, clientApplication,
            cryptoProvider: { generatePkceCodes: async () => ({ verifier: 'v'.repeat(64), challenge: 'c'.repeat(43) }) },
            randomBytes: size => Buffer.alloc(size, state.bytes++) },
        identityPolicy: { policyId: 'synthetic-http-operator-policy', policyRevision: 0,
            issuer: 'https://login.microsoftonline.com/' + tenant + '/v2.0', identityTenantId: tenant, audience: client },
        proofStore, clock: jest.fn(() => new Date(state.now).toISOString()), readExternalRuntimeEpoch,
        newRequestId, requestBudgetMs: 1000, pool, instanceId: instance,
        historyBudget: { maxRecords: 4096, maxBytes: 67108864, maxDurationMs: 60000 },
        newId: () => dashboardUuid(++state.sequence),
        newGenerationToken: () => crypto.createHash('sha256').update(String(++state.sequence)).digest('hex'),
        newOperationId, ...change.configuration
    };
    const installed = app.createNoFriesApp({ dashboard: configuration });
    const ip = '198.18.' + Math.floor(serial / 250) + '.' + (serial % 250 + 1);
    const send = (method, url) => request(installed)[method](url).set('x-forwarded-for', ip);
    async function login() {
        const begun = await send('get', '/api/auth/login?returnTo=%2Fportal');
        expect(begun.status).toBe(302);
        const transaction = begun.headers['set-cookie'][0].split(';')[0];
        const stateValue = new URL(begun.headers.location).searchParams.get('state');
        const callback = await send('post', '/api/auth/callback').set('Cookie', transaction)
            .type('form').send({ state: stateValue, code: 'synthetic-http-code' });
        expect(callback.status).toBe(303);
        expect(callback.headers.location).toBe('/portal');
        return { cookie: callback.headers['set-cookie'][0].split(';')[0], callback, transaction, stateValue };
    }
    function resetObservations() {
        for (const spy of [store.loadSession, store.createSession, store.deleteSession,
            proofStore.createOriginalProof, proofStore.readOriginalProof, readExternalRuntimeEpoch,
            newRequestId, newOperationId, pool.connect, configuration.clock]) spy.mockClear();
    }
    function expectNoAuthorityWork() {
        for (const spy of [store.loadSession, proofStore.readOriginalProof, readExternalRuntimeEpoch,
            newRequestId, newOperationId, pool.connect]) expect(spy).not.toHaveBeenCalled();
    }
    return { installed, configuration, env, state, store, proofs, proofStore, pool, send, login, ip,
        resetObservations, expectNoAuthorityWork, newRequestId, newOperationId, readExternalRuntimeEpoch, clientApplication };
}

async function dashboardRawRequest(installed, { method = 'GET', target = '/api/dashboard/session', headers = [], body } = {}) {
    const server = dashboardHttp.createServer(installed);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        return await new Promise((resolve, reject) => {
            const req = dashboardHttp.request({ host: '127.0.0.1', port: server.address().port, method, path: target,
                headers: ['Host', 'transport.invalid', 'Connection', 'close', ...headers] }, res => {
                const chunks = [];
                res.on('data', chunk => chunks.push(chunk));
                res.on('error', reject);
                res.on('end', () => resolve({ status: res.statusCode, headers: res.headers,
                    text: Buffer.concat(chunks).toString('utf8') }));
            });
            req.on('error', reject);
            req.end(body);
        });
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
}
function expectDashboardClosed(response, status, code) {
    expect(response.status).toBe(status);
    const value = response.body && Object.keys(response.body).length ? response.body : JSON.parse(response.text);
    expect(value).toEqual({ code });
    expect(response.headers['cache-control']).toContain('private');
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.headers['content-type']).toMatch(/^application\/json; charset=utf-8$/i);
    expect(response.headers.location).toBeUndefined();
    expect(response.text).not.toMatch(/PRIVATE_SYNTHETIC|synthetic-http-test-only-secret|71000000|http-operator@example/);
}

describe('configured dashboard actual HTTP transport', () => {
    test.each(['proxy', 'accessor', 'symbol', 'hidden accessor', 'oversized', 'inherited required configuration'])
    ('J-ENV configured app rejects %s environment before any provider work', kind => {
        const h = dashboardHttpHarness(), invoked = jest.fn(() => { throw new Error('Environment accessor executed'); });
        h.resetObservations();
        let env = { ...h.env };
        if (kind === 'proxy') env = new Proxy(env, { ownKeys: invoked, get: invoked });
        if (kind === 'accessor') Object.defineProperty(env, 'NOFRIES_ENTRA_CLIENT_SECRET', { get: invoked });
        if (kind === 'symbol') env[Symbol('hidden')] = true;
        if (kind === 'hidden accessor') Object.defineProperty(env, 'hidden', { get: invoked });
        if (kind === 'oversized') env.SYNTHETIC_EXTRA = 'x'.repeat(32768);
        if (kind === 'inherited required configuration') {
            env = Object.assign(Object.create({ NOFRIES_ENTRA_CLIENT_SECRET: h.env.NOFRIES_ENTRA_CLIENT_SECRET }), env);
            delete env.NOFRIES_ENTRA_CLIENT_SECRET;
        }
        expect(() => app.createNoFriesApp({ dashboard: { ...h.configuration,
            browserAuthOptions: { ...h.configuration.browserAuthOptions, env } } })).toThrow();
        expect(invoked).not.toHaveBeenCalled(); expect(h.configuration.clock).not.toHaveBeenCalled(); h.expectNoAuthorityWork();
    });

    test('J-ENV configured app ignores inherited authority and non-enumerable environment data', async () => {
        const h = dashboardHttpHarness(), invoked = jest.fn(() => { throw new Error('Inherited accessor executed'); });
        const prototype = {};
        Object.defineProperty(prototype, 'NOFRIES_REQUIRE_AUTH', { get: invoked });
        const ownEnv = { ...h.env }; delete ownEnv.NOFRIES_REQUIRE_AUTH;
        const env = Object.assign(Object.create(prototype), ownEnv);
        Object.defineProperty(env, 'SYNTHETIC_IGNORED', { value: 'x'.repeat(32768) });
        const configured = app.createNoFriesApp({ dashboard: { ...h.configuration,
            browserAuthOptions: { ...h.configuration.browserAuthOptions, env } } });
        h.resetObservations();
        expectDashboardClosed(await request(configured).post('/api/dashboard/logout').set('X-Forwarded-For', h.ip)
            .set('Origin', h.env.NOFRIES_PUBLIC_URL).set('Sec-Fetch-Site', 'same-origin').send({}),
        401, 'dashboard_authentication_required');
        expect(invoked).not.toHaveBeenCalled(); h.expectNoAuthorityWork();
    });

    test('J-ENV native Node process.env constructs an isolated actual HTTP app', () => {
        // This child receives only synthetic allowlisted values. It proves the
        // native Node environment shape instead of Jest's process.env wrapper.
        const env = { NOFRIES_REQUIRE_AUTH: 'true', NOFRIES_PUBLIC_URL: 'https://native-http.invalid',
            NOFRIES_ENTRA_TENANT_ID: dashboardUuid(1), NOFRIES_ENTRA_CLIENT_ID: dashboardUuid(2),
            NOFRIES_ENTRA_CLIENT_SECRET: 'synthetic-native-http-only-secret',
            NOFRIES_ALLOWED_SUBJECTS: dashboardUuid(1) + ':' + dashboardUuid(3) };
        const script = `
            const request = require('supertest');
            const { MemoryBrowserSessionStore } = require('./api/shared/browserSessionStore');
            const { createNoFriesApp } = require('./server');
            const uid = n => '71000000-0000-4000-8000-' + String(n).padStart(12, '0');
            const tenant = process.env.NOFRIES_ENTRA_TENANT_ID, client = process.env.NOFRIES_ENTRA_CLIENT_ID;
            const originalOrigin = process.env.NOFRIES_PUBLIC_URL;
            const nativePrototype = Object.getPrototypeOf(process.env) !== Object.prototype;
            let clockCalls = 0, sqlCalls = 0;
            const app = createNoFriesApp({ dashboard: {
                browserAuthOptions: { env: process.env, store: new MemoryBrowserSessionStore() },
                identityPolicy: { policyId: 'synthetic-native-http-policy', policyRevision: 0,
                    issuer: 'https://login.microsoftonline.com/' + tenant + '/v2.0', identityTenantId: tenant, audience: client },
                proofStore: { async createOriginalProof() {}, async readOriginalProof() { return null; } },
                clock: () => { clockCalls++; return '2026-09-08T22:00:00.000Z'; },
                readExternalRuntimeEpoch: async () => ({ instanceId: uid(4), restoreEpoch: uid(5) }),
                newRequestId: () => uid(6), requestBudgetMs: 1000,
                pool: { async connect() { sqlCalls++; throw new Error('Unexpected synthetic SQL'); }, async end() {} },
                instanceId: uid(4), historyBudget: { maxRecords: 4096, maxBytes: 67108864, maxDurationMs: 60000 },
                newId: () => uid(7), newGenerationToken: () => 'a'.repeat(64), newOperationId: () => uid(8)
            } });
            const constructorClockCalls = clockCalls;
            process.env.NOFRIES_PUBLIC_URL = 'https://mutated.invalid';
            process.env.NOFRIES_REQUIRE_AUTH = 'false';
            request(app).post('/api/dashboard/logout').set('Origin', originalOrigin)
                .set('Sec-Fetch-Site', 'same-origin').send({}).then(response => {
                    process.stdout.write(JSON.stringify({ nativePrototype, constructorClockCalls, sqlCalls,
                        status: response.status, code: response.body.code }));
                }).catch(() => { process.exitCode = 1; });
        `;
        const output = execFileSync(process.execPath, ['-e', script], {
            cwd: path.resolve(__dirname, '..'), env, encoding: 'utf8'
        });
        expect(JSON.parse(output)).toEqual({ nativePrototype: true, constructorClockCalls: 0, sqlCalls: 0,
            status: 401, code: 'dashboard_authentication_required' });
    });

    test('the default app and separately constructed unconfigured app retain legacy/public behavior', async () => {
        const plain = app.createNoFriesApp();
        expect(typeof app).toBe('function');
        const expectedHealth = functionContext();
        await require('../api/health')(expectedHealth, { method: 'GET', headers: {} });
        for (const target of [app, plain]) {
            expect((await request(target).get('/api/dashboard/session')).status).toBe(410);
            const health = await request(target).get('/api/health');
            expect(health.status).toBe(expectedHealth.res.status);
            expect(health.body).toEqual(expectedHealth.res.body);
            expect((await request(target).get('/js/home.js')).status).toBe(200);
            const portal = await request(target).get('/portal');
            expect(portal.status).toBe(200);
            expect(portal.headers['cache-control']).toContain('no-store');
            expect(portal.text).toContain('/api/customer-portal/app.js');
        }
    });

    test.each([
        '/api/dashboard', '/api/dashboard/', '/api/dashboard/session/', '/api/dashboard/Session',
        '/api/dashboard/%73ession', '/api/dashboard/session/extra', '/api/dashboard/modules/not-registered',
        '/api/dashboard/auth/login', '/api/dashboard/readiness', '/api/dashboard/onboarding'
    ])('rejects the exact unknown route %s before authority work', async target => {
        const h = dashboardHttpHarness();
        expectDashboardClosed(await h.send('get', target), 404, 'dashboard_not_found');
        h.expectNoAuthorityWork();
    });

    test.each([
        ['put', '/api/dashboard/session', 'GET, POST'],
        ['post', '/api/dashboard/organisations', 'GET'],
        ['get', '/api/dashboard/selection', 'POST'],
        ['get', '/api/dashboard/logout', 'POST'],
        ['post', '/api/dashboard/bootstrap', 'GET'],
        ['delete', '/api/dashboard/app.js', 'GET']
    ])('returns the exact Allow for %s %s without provider access', async (method, target, allow) => {
        const h = dashboardHttpHarness();
        const response = await h.send(method, target);
        expectDashboardClosed(response, 405, 'dashboard_method_not_allowed');
        expect(response.headers.allow).toBe(allow);
        h.expectNoAuthorityWork();
    });

    test.each([
        '/api/dashboard/session?x=1', '/api/dashboard/session?', '/api/dashboard/bootstrap?x=1',
        '/api/dashboard/app.js?x=1', '/api/dashboard/organisations?limit=0',
        '/api/dashboard/organisations?limit=01', '/api/dashboard/organisations?limit=101',
        '/api/dashboard/organisations?limit=1&limit=2', '/api/dashboard/organisations?afterBindingId=bad',
        '/api/dashboard/organisations?unknown=x', '/api/dashboard/organisations?limit=%31'
    ])('rejects malformed or unsupported query %s before parent lookup', async target => {
        const h = dashboardHttpHarness();
        expectDashboardClosed(await dashboardRawRequest(h.installed, { target,
            headers: ['X-Forwarded-For', h.ip] }), 400, 'dashboard_input_invalid');
        h.expectNoAuthorityWork();
    });

    test.each(['', '?limit=1', '?limit=100&afterBindingId=' + dashboardUuid(9)])
    ('accepts the closed directory query %s and then requires genuine authentication', async query => {
        const h = dashboardHttpHarness();
        expectDashboardClosed(await h.send('get', '/api/dashboard/organisations' + query), 401, 'dashboard_authentication_required');
        expect(h.pool.connect).not.toHaveBeenCalled();
    });

    test('GET distinguishes zero received bytes from a real JSON object entity', async () => {
        const h = dashboardHttpHarness();
        const empty = await dashboardRawRequest(h.installed, { headers: ['X-Forwarded-For', h.ip, 'Content-Length', '0'] });
        expectDashboardClosed(empty, 401, 'dashboard_authentication_required');
        h.resetObservations();
        const bytes = await dashboardRawRequest(h.installed, { headers: ['X-Forwarded-For', h.ip,
            'Content-Type', 'application/json', 'Content-Length', '2'], body: Buffer.from('{}') });
        expectDashboardClosed(bytes, 400, 'dashboard_input_invalid');
        h.expectNoAuthorityWork();
    });

    test.each([
        ['empty', Buffer.alloc(0)], ['broken JSON', Buffer.from('{')], ['null', Buffer.from('null')],
        ['array', Buffer.from('[]')], ['extra property', Buffer.from('{"extra":true}')],
        ['invalid UTF-8', Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d])]
    ])('rejects actual %s POST wire bytes before auth', async (_, body) => {
        const h = dashboardHttpHarness();
        expectDashboardClosed(await dashboardRawRequest(h.installed, { method: 'POST', target: '/api/dashboard/logout',
            headers: ['X-Forwarded-For', h.ip, 'Content-Type', 'application/json', 'Content-Length', String(body.length),
                'Origin', h.env.NOFRIES_PUBLIC_URL, 'Sec-Fetch-Site', 'same-origin'], body }), 400, 'dashboard_input_invalid');
        h.expectNoAuthorityWork();
    });

    test.each([
        ['text/plain', null], ['application/json; charset=iso-8859-1', null],
        ['application/json; charset=utf-16', null], ['application/json', 'gzip'], ['application/json', 'br']
    ])('rejects media %s encoding %s before providers', async (type, encoding) => {
        const h = dashboardHttpHarness();
        const headers = ['X-Forwarded-For', h.ip, 'Content-Type', type, 'Content-Length', '2',
            'Origin', h.env.NOFRIES_PUBLIC_URL, 'Sec-Fetch-Site', 'same-origin'];
        if (encoding) headers.push('Content-Encoding', encoding);
        expectDashboardClosed(await dashboardRawRequest(h.installed, { method: 'POST', target: '/api/dashboard/logout', headers,
            body: Buffer.from('{}') }), 415, 'dashboard_unsupported_media_type');
        h.expectNoAuthorityWork();
    });

    test.each(['application/json', 'application/json; charset=utf-8'])
    ('accepts %s and requires authentication after valid bounded wire input', async type => {
        const h = dashboardHttpHarness();
        const response = await h.send('post', '/api/dashboard/logout').set('Content-Type', type)
            .set('Origin', h.env.NOFRIES_PUBLIC_URL).set('Sec-Fetch-Site', 'same-origin').send('{}');
        expectDashboardClosed(response, 401, 'dashboard_authentication_required');
        expect(h.pool.connect).not.toHaveBeenCalled();
    });

    test('counts exactly 524288 received bytes rather than compact reserialized JSON', async () => {
        const h = dashboardHttpHarness();
        for (const size of [524288, 524289]) {
            h.resetObservations();
            const body = Buffer.from('{}' + ' '.repeat(size - 2));
            const response = await dashboardRawRequest(h.installed, { method: 'POST', target: '/api/dashboard/logout',
                headers: ['X-Forwarded-For', h.ip, 'Content-Type', 'application/json', 'Content-Length', String(size),
                    'Origin', h.env.NOFRIES_PUBLIC_URL, 'Sec-Fetch-Site', 'same-origin'], body });
            expectDashboardClosed(response, size === 524288 ? 401 : 413,
                size === 524288 ? 'dashboard_authentication_required' : 'dashboard_request_too_large');
            if (size > 524288) h.expectNoAuthorityWork();
        }
    });

    test.each([
        [null, null], [null, 'same-origin'], ['null', 'same-origin'], ['https://attacker.invalid', 'same-origin'],
        ['configured', null], ['configured', 'same-site'], ['configured', 'cross-site'], ['configured/', 'same-origin']
    ])('strict dashboard POST origin=%s fetch-site=%s denies before auth', async (origin, fetchSite) => {
        const h = dashboardHttpHarness();
        let call = h.send('post', '/api/dashboard/logout').type('json').send({});
        if (origin) call = call.set('Origin', origin.replace('configured', h.env.NOFRIES_PUBLIC_URL));
        if (fetchSite) call = call.set('Sec-Fetch-Site', fetchSite);
        expectDashboardClosed(await call, 403, 'dashboard_access_denied');
        h.expectNoAuthorityWork();
    });

    test.each([undefined, 'bad', 'A'.repeat(64)])
    ('wire-valid absent parent precedes invalid generation %s', async generation => {
        const h = dashboardHttpHarness();
        let call = h.send('get', '/api/dashboard/bootstrap');
        if (generation) call = call.set('X-NoFries-Dashboard-Generation', generation);
        expectDashboardClosed(await call, 401, 'dashboard_authentication_required');
        expect(h.newRequestId).not.toHaveBeenCalled();
        expect(h.pool.connect).not.toHaveBeenCalled();
    });

    test('raw duplicate generation occurrences cannot be hidden by Node header joining', async () => {
        const h = dashboardHttpHarness(), issued = await h.login();
        h.resetObservations();
        expectDashboardClosed(await dashboardRawRequest(h.installed, { target: '/api/dashboard/bootstrap',
            headers: ['X-Forwarded-For', h.ip, 'Cookie', issued.cookie,
                'X-NoFries-Dashboard-Generation', 'a'.repeat(64), 'x-nofries-dashboard-generation', 'a'.repeat(64)] }),
        403, 'dashboard_access_denied');
        expect(h.store.loadSession).toHaveBeenCalledTimes(1);
        expect(h.proofStore.readOriginalProof).not.toHaveBeenCalled();
        expect(h.newRequestId).not.toHaveBeenCalled();
        expect(h.pool.connect).not.toHaveBeenCalled();
    });

    test('valid parent with bad generation is refused before H or SQL while an expired parent remains 401', async () => {
        const h = dashboardHttpHarness(), issued = await h.login();
        h.resetObservations();
        expectDashboardClosed(await h.send('get', '/api/dashboard/bootstrap').set('Cookie', issued.cookie)
            .set('X-NoFries-Dashboard-Generation', 'bad'), 403, 'dashboard_access_denied');
        expect(h.store.loadSession).toHaveBeenCalledTimes(1);
        expect(h.proofStore.readOriginalProof).not.toHaveBeenCalled();
        expect(h.newRequestId).not.toHaveBeenCalled();
        expect(h.pool.connect).not.toHaveBeenCalled();
        h.state.now += 9 * 60 * 60 * 1000;
        h.resetObservations();
        expectDashboardClosed(await h.send('get', '/api/dashboard/bootstrap').set('Cookie', issued.cookie)
            .set('X-NoFries-Dashboard-Generation', 'bad'), 401, 'dashboard_authentication_required');
        expect(h.store.deleteSession).toHaveBeenCalledTimes(1);
        expect(h.proofStore.readOriginalProof).not.toHaveBeenCalled();
        expect(h.pool.connect).not.toHaveBeenCalled();
    });

    test.each(['throw forged 401', 'undefined'])('provider %s cannot masquerade as absent authentication', async mode => {
        const h = dashboardHttpHarness(), issued = await h.login();
        h.resetObservations();
        h.state.afterLoad = () => {
            if (mode === 'undefined') return undefined;
            throw new DashboardBrowserAuthError(401, 'browser_auth_session_missing');
        };
        expectDashboardClosed(await h.send('get', '/api/dashboard/session').set('Cookie', issued.cookie), 503, 'dashboard_unavailable');
        expect(h.pool.connect).not.toHaveBeenCalled();
        expect(h.store.deleteSession).not.toHaveBeenCalled();
    });

    test('actual login/callback/session preserve legacy projections and create only the original private proof', async () => {
        const h = dashboardHttpHarness(), issued = await h.login();
        expect(h.proofStore.createOriginalProof).toHaveBeenCalledTimes(1);
        expect(h.store.createSession).toHaveBeenCalledTimes(1);
        expect(h.proofs.size).toBe(1);
        expect(issued.callback.headers['cache-control']).toContain('no-store');
        const session = await h.send('get', '/api/auth/session').set('Cookie', issued.cookie);
        expect(session.status).toBe(200);
        expect(session.body).toMatchObject({ authenticated: true, user: { email: 'http-operator@example.invalid' } });
        expect(Object.keys(session.body).sort()).toEqual(['authenticated', 'expiresAt', 'user']);
        expect(JSON.stringify(session.body)).not.toMatch(/operator_dashboard_issuance|sessionSha256|restoreEpoch|accessToken/);
        const replay = await h.send('post', '/api/auth/callback').set('Cookie', issued.transaction)
            .type('form').send({ state: issued.stateValue, code: 'synthetic-http-code' });
        expect(replay.status).toBe(401);
        expect(h.proofStore.createOriginalProof).toHaveBeenCalledTimes(1);
        expect(h.pool.connect).not.toHaveBeenCalled();
    });

    test('separately configured apps retain their origin and original auth policy after caller mutation', async () => {
        const first = dashboardHttpHarness(), second = dashboardHttpHarness();
        const originalOrigin = first.env.NOFRIES_PUBLIC_URL;
        first.env.NOFRIES_PUBLIC_URL = 'https://mutated.invalid';
        first.env.NOFRIES_ALLOWED_SUBJECTS = dashboardUuid(99) + ':' + dashboardUuid(100);
        const [one, two] = await Promise.all([first.login(), second.login()]);
        const [firstSession, secondSession] = await Promise.all([
            first.send('get', '/api/auth/session').set('Cookie', one.cookie),
            second.send('get', '/api/auth/session').set('Cookie', two.cookie)
        ]);
        expect(firstSession.status).toBe(200);
        expect(secondSession.status).toBe(200);
        first.resetObservations(); second.resetObservations();
        expectDashboardClosed(await first.send('post', '/api/dashboard/logout').set('Origin', second.env.NOFRIES_PUBLIC_URL)
            .set('Sec-Fetch-Site', 'same-origin').send({}), 403, 'dashboard_access_denied');
        first.expectNoAuthorityWork();
        expectDashboardClosed(await first.send('post', '/api/dashboard/logout').set('Origin', originalOrigin)
            .set('Sec-Fetch-Site', 'same-origin').send({}), 401, 'dashboard_authentication_required');
        expect(second.pool.connect).not.toHaveBeenCalled();
    });

    test('ordinary logout retains its legacy accepted origin shape without creating an absent-parent tombstone', async () => {
        const h = dashboardHttpHarness();
        const result = await h.send('post', '/api/auth/logout').set('Sec-Fetch-Site', 'same-origin')
            .type('form').send({ returnTo: '/portal' });
        expect(result.status).toBe(303);
        expect(result.headers.location).toBe('/portal');
        expect(result.headers['set-cookie'][0]).toContain('__Host-nofries-auth=;');
        expect(result.headers['set-cookie'][0]).toContain('Max-Age=0');
        expect(h.pool.connect).not.toHaveBeenCalled();
        expect(h.newOperationId).not.toHaveBeenCalled();
    });

    test('ordinary logout preserves origin-before-rate-before-service ordering', async () => {
        const h = dashboardHttpHarness({ env: { NOFRIES_RATE_API_WRITE_MAX: '1' } });
        const denied = await h.send('post', '/api/auth/logout').set('Origin', 'https://attacker.invalid').type('form').send({});
        expect(denied.status).toBe(403);
        h.expectNoAuthorityWork();
        const first = await h.send('post', '/api/auth/logout').set('Sec-Fetch-Site', 'same-origin').type('form').send({});
        expect(first.status).toBe(303);
        h.resetObservations();
        const second = await h.send('post', '/api/auth/logout').set('Sec-Fetch-Site', 'same-origin').type('form').send({});
        expect(second.status).toBe(429);
        expect(h.configuration.clock).not.toHaveBeenCalled();
        h.expectNoAuthorityWork();
    });

    test.each(['/api/auth/logout', '/api/dashboard/logout'])
    ('valid-parent %s waits for SQL revocation and cannot delete on unavailable SQL', async target => {
        const h = dashboardHttpHarness(), issued = await h.login();
        h.resetObservations();
        let call = h.send('post', target).set('Cookie', issued.cookie).set('Origin', h.env.NOFRIES_PUBLIC_URL)
            .set('Sec-Fetch-Site', 'same-origin');
        call = target.includes('/auth/') ? call.type('form').send({ returnTo: '/portal' }) : call.send({});
        const result = await call;
        expect(result.status).toBe(503);
        expect(h.pool.connect).toHaveBeenCalledTimes(1);
        expect(h.store.deleteSession).not.toHaveBeenCalled();
        expect(h.store.sessions.size).toBe(1);
        expect(result.headers.location).toBeUndefined();
        expect(result.headers['set-cookie']).toBeUndefined();
        expect(result.text).not.toContain('PRIVATE_SYNTHETIC_SQL_UNAVAILABLE');
    });

    test('common API rate rejection occurs before raw parsing and all dashboard authority work', async () => {
        const h = dashboardHttpHarness({ env: { NOFRIES_RATE_API_WRITE_MAX: '1' } });
        const first = await h.send('post', '/api/dashboard/logout').send({});
        expect(first.status).toBe(403);
        h.resetObservations();
        const second = await h.send('post', '/api/dashboard/logout').set('Content-Type', 'text/plain').send('{');
        expect(second.status).toBe(429);
        expect(second.body).toEqual({ error: 'Too many requests. Please try again later.' });
        expect(h.configuration.clock).not.toHaveBeenCalled();
        h.expectNoAuthorityWork();
    });

    test.each([
        ['/api/dashboard/session', {}],
        ['/api/dashboard/session', { operationId: 'not-a-uuid' }],
        ['/api/dashboard/session', { operationId: dashboardUuid(8), tenantId: dashboardUuid(1) }],
        ['/api/dashboard/selection', { bindingId: dashboardUuid(8), operationId: dashboardUuid(9) }],
        ['/api/dashboard/selection', { bindingId: dashboardUuid(8), operationId: dashboardUuid(9), expectedGeneration: 'A'.repeat(64) }]
    ])('closed command validation for %s precedes all authority work', async (target, body) => {
        const h = dashboardHttpHarness();
        expectDashboardClosed(await h.send('post', target).set('Origin', h.env.NOFRIES_PUBLIC_URL)
            .set('Sec-Fetch-Site', 'same-origin').send(body), 400, 'dashboard_input_invalid');
        h.expectNoAuthorityWork();
    });

    test('a chunked over-limit entity is measured from received bytes without Content-Length', async () => {
        const h = dashboardHttpHarness();
        const body = Buffer.from('{}' + ' '.repeat(524287));
        const response = await dashboardRawRequest(h.installed, { method: 'POST', target: '/api/dashboard/logout',
            headers: ['X-Forwarded-For', h.ip, 'Content-Type', 'application/json', 'Transfer-Encoding', 'chunked',
                'Origin', h.env.NOFRIES_PUBLIC_URL, 'Sec-Fetch-Site', 'same-origin'], body });
        expectDashboardClosed(response, 413, 'dashboard_request_too_large');
        h.expectNoAuthorityWork();
    });

    test.each(['app.js', 'dashboard.css'])('native %s does not require generation and still reaches genuine fresh SQL admission', async route => {
        const h = dashboardHttpHarness(), issued = await h.login();
        h.resetObservations();
        const response = await h.send('get', '/api/dashboard/' + route).set('Cookie', issued.cookie);
        expect(response.status).toBe(503);
        expect(h.store.loadSession.mock.calls.length).toBeGreaterThanOrEqual(2);
        expect(h.proofStore.readOriginalProof).toHaveBeenCalledTimes(1);
        expect(h.pool.connect).toHaveBeenCalledTimes(1);
        expect(response.headers['cache-control']).toContain('no-store');
        expect(response.headers.location).toBeUndefined();
        expect(response.text).not.toContain('PRIVATE_SYNTHETIC_SQL_UNAVAILABLE');
    });

    test('ordinary logout cannot renew its service deadline after a held initial parent read', async () => {
        const h = dashboardHttpHarness(), issued = await h.login();
        h.resetObservations();
        const entered = dashboardLatch(), release = dashboardLatch();
        h.state.beforeLoad = async () => { entered.resolve(); await release.promise; };
        let completed = false;
        const pending = h.send('post', '/api/auth/logout').set('Cookie', issued.cookie)
            .set('Sec-Fetch-Site', 'same-origin').type('form').send({ returnTo: '/portal' })
            .then(value => { completed = true; return value; });
        try {
            await entered.promise;
            h.state.now += 1001;
            await new Promise(resolve => setImmediate(resolve));
            expect(completed).toBe(false);
        } finally { release.resolve(); }
        const result = await pending;
        expect(result.status).toBe(503);
        expect(result.headers.location).toBeUndefined();
        expect(result.headers['set-cookie']).toBeUndefined();
        expect(h.newOperationId).not.toHaveBeenCalled();
        expect(h.newRequestId).not.toHaveBeenCalled();
        expect(h.pool.connect).not.toHaveBeenCalled();
        expect(h.store.deleteSession).not.toHaveBeenCalled();
    });

    test('a held later H proof cannot use its local deadline to continue after host expiry', async () => {
        const h = dashboardHttpHarness(), issued = await h.login();
        h.resetObservations();
        const entered = dashboardLatch(), release = dashboardLatch();
        h.state.beforeProof = async () => { entered.resolve(); await release.promise; };
        let completed = false;
        const pending = h.send('get', '/api/dashboard/session').set('Cookie', issued.cookie)
            .then(value => { completed = true; return value; });
        try {
            await entered.promise;
            h.state.now += 1001;
            await new Promise(resolve => setImmediate(resolve));
            expect(completed).toBe(false);
            expect(h.pool.connect).not.toHaveBeenCalled();
        } finally { release.resolve(); }
        expectDashboardClosed(await pending, 503, 'dashboard_unavailable');
        expect(h.newRequestId).toHaveBeenCalledTimes(1);
        expect(h.proofStore.readOriginalProof).toHaveBeenCalledTimes(1);
        expect(h.pool.connect).not.toHaveBeenCalled();
        expect(h.store.deleteSession).not.toHaveBeenCalled();
    });

    test('expiry of a held request in one app cannot poison an interleaved app request', async () => {
        const first = dashboardHttpHarness(), second = dashboardHttpHarness();
        const [one, two] = await Promise.all([first.login(), second.login()]);
        first.resetObservations(); second.resetObservations();
        const entered = dashboardLatch(), release = dashboardLatch();
        first.state.beforeLoad = async () => { entered.resolve(); await release.promise; };
        const pending = first.send('get', '/api/dashboard/session').set('Cookie', one.cookie).then(value => value);
        try {
            await entered.promise;
            first.state.now += 1001;
            const unrelated = await second.send('get', '/api/auth/session').set('Cookie', two.cookie);
            expect(unrelated.status).toBe(200);
            expect(second.store.loadSession).toHaveBeenCalledTimes(1);
            expect(second.pool.connect).not.toHaveBeenCalled();
        } finally { release.resolve(); }
        expectDashboardClosed(await pending, 503, 'dashboard_unavailable');
        expect(first.pool.connect).not.toHaveBeenCalled();
    });

    test('pre-context expiry awaits the held genuine parent read and permits no renewed H budget', async () => {
        const h = dashboardHttpHarness(), issued = await h.login();
        h.resetObservations();
        const entered = dashboardLatch(), release = dashboardLatch();
        h.state.beforeLoad = async () => { entered.resolve(); await release.promise; };
        let completed = false;
        const pending = h.send('get', '/api/dashboard/session').set('Cookie', issued.cookie)
            .then(value => { completed = true; return value; });
        try {
            await entered.promise;
            h.state.now += 1001;
            await new Promise(resolve => setImmediate(resolve));
            expect(completed).toBe(false);
            expect(h.pool.connect).not.toHaveBeenCalled();
        } finally { release.resolve(); }
        expectDashboardClosed(await pending, 503, 'dashboard_unavailable');
        expect(h.store.loadSession).toHaveBeenCalledTimes(1);
        expect(h.newRequestId).not.toHaveBeenCalled();
        expect(h.proofStore.readOriginalProof).not.toHaveBeenCalled();
        expect(h.pool.connect).not.toHaveBeenCalled();
    });

    test('unfinished wire input is actually closed by its finite timer without starting providers', async () => {
        const h = dashboardHttpHarness({ configuration: { requestBudgetMs: 40 } });
        const server = dashboardHttp.createServer(h.installed);
        const entered = dashboardLatch(), settled = dashboardLatch();
        server.on('request', req => {
            entered.resolve();
            req.on('close', () => settled.resolve({ aborted: req.aborted, complete: req.complete }));
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        let req;
        try {
            const clientSettled = new Promise(resolve => {
                req = dashboardHttp.request({ host: '127.0.0.1', port: server.address().port,
                    method: 'POST', path: '/api/dashboard/logout', headers: {
                        'Content-Type': 'application/json', 'Content-Length': '100', 'X-Forwarded-For': h.ip,
                        Origin: h.env.NOFRIES_PUBLIC_URL, 'Sec-Fetch-Site': 'same-origin' } }, res => {
                    res.resume(); res.on('end', () => resolve({ status: res.statusCode }));
                });
                req.on('error', error => resolve({ error: error.code }));
                req.write('{');
            });
            await entered.promise;
            const [wire, clientResult] = await Promise.all([settled.promise, clientSettled]);
            expect(wire).toEqual({ aborted: true, complete: false });
            expect(clientResult.status).toBeUndefined();
            expect(clientResult.error).toBe('ECONNRESET');
            h.expectNoAuthorityWork();
        } finally {
            if (req) req.destroy();
            await new Promise(resolve => server.close(resolve));
        }
    });

    test('an over-cap entity held without EOF settles at its original wire budget without provider work', async () => {
        const h = dashboardHttpHarness({ configuration: { requestBudgetMs: 500 } });
        const server = dashboardHttp.createServer(h.installed);
        const overflowObserved = dashboardLatch(), settled = dashboardLatch();
        const payload = Buffer.from('{}' + ' '.repeat(524287));
        let receivedBytes = 0, wireSettled = false, clientCompleted = false;
        // Observe actual transport bytes and close events only. This observer
        // neither supplies a parsed body nor replaces parsing or timer code.
        server.on('request', incoming => {
            incoming.on('data', chunk => {
                receivedBytes += chunk.length;
                if (receivedBytes >= payload.length) overflowObserved.resolve();
            });
            incoming.on('close', () => {
                wireSettled = true;
                settled.resolve({ aborted: incoming.aborted, complete: incoming.complete });
            });
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        let req;
        try {
            const clientSettled = new Promise(resolve => {
                req = dashboardHttp.request({ host: '127.0.0.1', port: server.address().port,
                    method: 'POST', path: '/api/dashboard/logout', headers: {
                        'Content-Type': 'application/json', 'Content-Length': String(payload.length + 1),
                        'X-Forwarded-For': h.ip, Origin: h.env.NOFRIES_PUBLIC_URL,
                        'Sec-Fetch-Site': 'same-origin' } }, res => {
                    res.resume();
                    res.on('end', () => { clientCompleted = true; resolve({ status: res.statusCode }); });
                });
                req.on('error', error => { clientCompleted = true; resolve({ error: error.code }); });
                // Deliberately leave one declared byte and EOF unsent. The
                // application must settle its owned input using the original
                // request timer; the test never closes it on the success path.
                req.write(payload);
            });
            await overflowObserved.promise;
            expect(receivedBytes).toBe(524289);
            expect(wireSettled).toBe(false);
            expect(clientCompleted).toBe(false);
            h.expectNoAuthorityWork();
            const [wire, result] = await Promise.all([settled.promise, clientSettled]);
            expect(wire).toEqual({ aborted: true, complete: false });
            expect(result.status).toBeUndefined();
            expect(result.error).toBe('ECONNRESET');
            expect(receivedBytes).toBe(524289);
            h.expectNoAuthorityWork();
        } finally {
            if (req) req.destroy();
            await new Promise(resolve => server.close(resolve));
        }
    });

    test('a client-aborted entity settles without session, proof or SQL activity', async () => {
        const h = dashboardHttpHarness();
        const server = dashboardHttp.createServer(h.installed);
        const entered = dashboardLatch(), settled = dashboardLatch();
        server.on('request', req => {
            entered.resolve();
            req.on('close', () => settled.resolve({ aborted: req.aborted, complete: req.complete }));
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const req = dashboardHttp.request({ host: '127.0.0.1', port: server.address().port,
            method: 'POST', path: '/api/dashboard/logout', headers: { 'Content-Type': 'application/json',
                'Content-Length': '100', 'X-Forwarded-For': h.ip,
                Origin: h.env.NOFRIES_PUBLIC_URL, 'Sec-Fetch-Site': 'same-origin' } });
        req.on('error', () => {});
        try {
            req.write('{');
            await entered.promise;
            req.destroy();
            expect(await settled.promise).toEqual({ aborted: true, complete: false });
            h.expectNoAuthorityWork();
        } finally {
            req.destroy();
            await new Promise(resolve => server.close(resolve));
        }
    });
});
