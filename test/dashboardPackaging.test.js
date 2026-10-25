'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const vm = require('node:vm');
const test = global.test || require('node:test');
const root = path.resolve(__dirname, '..');

// Compare directives and all structural/authorization fields, not optional
// HTTP header whitespace and the closed no-store policy compacted to fit the provider's configuration limit.
function assertEquivalentHeaders(actual, expected) {
    const semantic = value => JSON.parse(JSON.stringify(value), (key, entry) => {
        if (entry && typeof entry === 'object' && typeof entry.route === 'string') {
            return { ...entry, allowedRoles: entry.allowedRoles ?? ['anonymous'] };
        }
        if (key === 'Cache-Control' && entry === 'private, no-store, max-age=0') return ['no-store'];
        return typeof entry === 'string' && ['Content-Security-Policy', 'Cache-Control', 'X-Robots-Tag'].includes(key)
            ? entry.split(key === 'Content-Security-Policy' ? ';' : ',').map(part => part.trim()) : entry;
    });
    assert.deepEqual(semantic(actual), semantic(expected));
}

for (const builder of ['build-static.js', 'build-app-service.js']) {
    test(`${builder} does not package the synthetic dashboard fixture or development generator`, () => {
        const copied = [];
        const fakeFs = { rmSync() {}, mkdirSync() {}, writeFileSync() {}, existsSync: () => true,
            copyFileSync: source => copied.push(source), cpSync: source => copied.push(source),
            readFileSync: file => {
                if (file.endsWith('package.json')) return JSON.stringify({ name: 'test', dependencies: {}, overrides: {} });
                if (file.endsWith('staticwebapp.config.json')) return JSON.stringify({ routes: ['/', '/scoping', '/support', '/portal', '/dashboard', '/signup'].map(route => ({ route, headers: { 'Content-Security-Policy': "default-src 'none'" } })) });
                return '<html>synthetic build-contract placeholder</html>';
            } };
        function requireStub(name) {
            if (name === 'fs') return fakeFs;
            if (name === 'path' || name === 'crypto') return require(name);
            if (name === '../lib/publicAssets') return require('../lib/publicAssets');
            if (name.endsWith('Document')) return new Proxy({}, { get: () => () => ({ html: '<html></html>', contentSecurityPolicy: "default-src 'none'" }) });
            throw new Error('Unexpected build dependency: ' + name);
        }
        vm.runInNewContext(fs.readFileSync(path.join(root, 'scripts', builder), 'utf8'), {
            require: requireStub, __dirname: path.join(root, 'scripts'), console, Buffer
        });
        for (const file of ['test/fixtures/dashboardFixture.js', 'test/fixtures/dashboard-preview.html', 'scripts/build-dashboard-preview.js']) {
            const candidate = path.join(root, file);
            assert.ok(!copied.some(source => source === candidate || candidate.startsWith(source + path.sep)), `${file} was included`);
        }
        assert.ok(copied.length > 5, 'The real build copy plan must have executed');
        if (builder === 'build-app-service.js') {
            assert.ok(copied.includes(path.join(root, 'app/dashboard.css')),
                'The provider-independent protected CSS response requires the packaged stylesheet');
            assert.ok(copied.includes(path.join(root, 'api')),
                'The admission service and protected renderer must be packaged together');
            assert.ok(copied.includes(path.join(root, 'app/dashboard.html')),
                'The private generic dashboard document must be packaged');
        } else {
            assert.ok(copied.includes(path.join(root, 'app/dashboard.html')));
            for (const file of ['app/dashboard.css', 'js/dashboard-loader.js', 'api/shared/protectedAssets/dashboardRegistry.js', 'api/shared/protectedAssets/dashboardShell.js',
                'api/shared/protectedAssets/ncscAssessmentClient.js', 'api/shared/protectedAssets/ncscQuestionnaire.js', 'api/shared/protectedAssets/assessmentExplanation.js', 'api/shared/protectedAssets/organisationPicture.js', 'api/shared/protectedAssets/improvementActionPlanView.js', 'api/shared/protectedAssets/improvementActionPlanClient.js']) {
                const candidate = path.join(root, file);
                assert.ok(!copied.some(source => source === candidate || candidate.startsWith(source + path.sep)), `${file} was exposed in the static package`);
            }
        }
    });
}

test('development preview has no external channel and fixture is not imported by legacy runtime', () => {
    const builder = fs.readFileSync(path.join(root, 'scripts/build-dashboard-preview.js'), 'utf8');
    assert.match(builder, /connect-src 'none'/); assert.match(builder, /Synthetic development preview/);
    assert.match(builder, /test\/fixtures\/dashboard-preview\.html/);
    const runtime = fs.readFileSync(path.join(root, 'api/shared/customerPortalRuntime.js'), 'utf8');
    assert.doesNotMatch(runtime, /dashboardFixture|dashboardProjection|dashboardShell/);
    assert.match(runtime, /assertCustomerPortalRuntimeEnabled/);
});

function withBuildFixture(run) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-dashboard-package-'));
    try {
        const { PUBLIC_ROOT_FILES } = require('../lib/publicAssets');
        const files = ['package.json', 'package-lock.json', 'app-service.js', 'server.js', 'staticwebapp.config.json',
            'scripts/build-static.js', 'scripts/build-app-service.js', 'scripts/build-dashboard-preview.js', ...PUBLIC_ROOT_FILES];
        for (const file of files) {
            fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
            fs.copyFileSync(path.join(root, file), path.join(directory, file));
        }
        for (const name of ['api', 'app', 'assets', 'images', 'js', 'lib', 'azure']) {
            fs.cpSync(path.join(root, name), path.join(directory, name), {
                recursive: true,
                filter: source => !path.relative(root, source).split(path.sep).includes('node_modules')
            });
        }
        fs.mkdirSync(path.join(directory, 'test/fixtures'), { recursive: true });
        fs.writeFileSync(path.join(directory, 'test/fixtures/dashboardFixture.js'), 'module.exports = "synthetic dashboard package exclusion sentinel";');
        fs.writeFileSync(path.join(directory, 'test/fixtures/dashboard-preview.html'), '<html>synthetic dashboard package exclusion sentinel</html>');
        return Promise.resolve(run(directory)).finally(() => fs.rmSync(directory, { recursive: true, force: true }));
    } catch (error) {
        fs.rmSync(directory, { recursive: true, force: true });
        throw error;
    }
}

test('real static and App Service builds bind their distinct customer entry modes to protected bytes and serve the dormant packaged app', async () => {
    await withBuildFixture(async directory => {
        for (const builder of ['build-static.js', 'build-app-service.js']) {
            execFileSync(process.execPath, [path.join(directory, 'scripts', builder)], { cwd: directory, stdio: 'pipe' });
        }
        const staticRoot = path.join(directory, 'dist');
        const serviceRoot = path.join(directory, 'app-service-dist');
        const read = (base, file) => fs.readFileSync(path.join(base, file), 'utf8');
        const { buildDashboardDocument } = require('../lib/dashboardDocument');
        const { withSharedAssistantDocument } = require('../lib/withSharedAssistantDocument');
        const documentInputs = {
            customerLogin: true,
            template: read(serviceRoot, 'app/dashboard.html'),
            loaderSource: read(serviceRoot, 'js/dashboard-loader.js'),
            protectedAppSource: ['dashboardRegistry.js', 'dashboardShell.js', 'ncscAssessmentClient.js', 'ncscQuestionnaire.js', 'assessmentExplanation.js', 'organisationPicture.js', 'improvementActionPlanView.js', 'improvementActionPlanClient.js']
                .map(file => read(serviceRoot, 'api/shared/protectedAssets/' + file)).join('\n'),
            protectedStyleSource: read(serviceRoot, 'app/dashboard.css')
        };
        const expected = buildDashboardDocument({ ...documentInputs, customerTransport: 'auto' });
        const dynamic = buildDashboardDocument(documentInputs);
        assert.equal(read(staticRoot, 'app/dashboard.html'), withSharedAssistantDocument(expected.html, 'dashboard'));
        const config = JSON.parse(read(staticRoot, 'staticwebapp.config.json'));
        for (const alias of ['/dashboard']) {
            const routes = config.routes.filter(route => route.route === alias);
            assert.equal(routes.length, 1);
            assert.equal(routes[0].rewrite, '/app/dashboard.html');
            assertEquivalentHeaders({ 'Content-Security-Policy': routes[0].headers['Content-Security-Policy'] },
                { 'Content-Security-Policy': expected.contentSecurityPolicy });
            assert.deepEqual(routes[0].headers['Cache-Control'].split(',').map(value => value.trim()), ['no-store']);
            assert.match(routes[0].headers['X-Robots-Tag'], /noindex/);
        }
        for (const file of ['app/dashboard.html', 'app/dashboard.css', 'js/dashboard-loader.js', 'lib/dashboardDocument.js',
            'api/shared/protectedAssets/dashboardRegistry.js', 'api/shared/protectedAssets/dashboardShell.js',
            'api/shared/protectedAssets/ncscAssessmentClient.js', 'api/shared/protectedAssets/ncscQuestionnaire.js', 'api/shared/protectedAssets/assessmentExplanation.js', 'api/shared/protectedAssets/organisationPicture.js', 'api/shared/protectedAssets/improvementActionPlanView.js', 'api/shared/protectedAssets/improvementActionPlanClient.js',
            'api/shared/dashboardService.js', 'api/shared/dashboardRuntimeHandlers.js', 'api/shared/dashboardOperatorSession.js',
            'api/shared/dashboardOperatorLogout.js']) {
            assert.equal(read(serviceRoot, file), read(directory, file), `${file} changed while packaging`);
        }
        for (const file of ['app/dashboard.css', 'assets/dashboard.css', 'dashboard.css', 'dashboard.js', 'js/dashboard-loader.js',
            'api', 'lib', 'node_modules']) {
            assert.equal(fs.existsSync(path.join(staticRoot, file)), false, `${file} was exposed in the static package`);
        }
        for (const base of [staticRoot, serviceRoot]) {
            for (const file of ['test', 'scripts', 'database', '.agent', 'node_modules']) {
                assert.equal(fs.existsSync(path.join(base, file)), false, `${file} was included in ${path.basename(base)}`);
            }
        }
        assert.equal(read(serviceRoot, 'lib/publicAssets.js'), read(root, 'lib/publicAssets.js'));
        assert.equal(JSON.parse(read(serviceRoot, 'package.json')).scripts.start, 'node app-service.js');

        // Resolve the already-installed dependency graph outside the output package;
        // loading server.js does not invoke the standalone host or a scheduler.
        fs.symlinkSync(fs.realpathSync(path.join(root, 'node_modules')), path.join(directory, 'node_modules'), 'dir');
        const app = require(path.join(serviceRoot, 'server.js'));
        const request = require('supertest');
        for (const alias of ['/dashboard', '/dashboard/']) {
            const response = await request(app).get(alias);
            assert.equal(response.status, 200);
            assert.match(response.headers['content-type'], /^text\/html/);
            assert.equal(response.headers['content-security-policy'], dynamic.contentSecurityPolicy);
            assert.equal(response.headers['cache-control'], 'private, no-store, max-age=0');
            assert.equal(response.headers['x-content-type-options'], 'nosniff');
            assert.match(response.headers['x-robots-tag'], /noindex/);
            assert.equal(response.text, withSharedAssistantDocument(dynamic.html, 'dashboard'));
        }
        for (const endpoint of ['/api/dashboard/session', '/api/dashboard/bootstrap', '/api/dashboard/app.js', '/api/dashboard/dashboard.css']) {
            const response = await request(app).get(endpoint);
            assert.equal(response.status, 410, `${endpoint} was activated by packaging`);
            assert.equal(response.body.code, 'legacy_workspace_retired');
        }
        for (const endpoint of ['/js/dashboard-loader.js', '/assets/dashboard.css', '/app/dashboard.html', '/app/dashboard.css']) {
            const response = await request(app).get(endpoint);
            assert.ok([404, 410].includes(response.status), `${endpoint} was exposed`);
            assert.notEqual(response.text, expected.html);
        }
    });
}, 20000);

for (const alias of ['/', '/dashboard', '/signup']) {
    for (const defect of ['missing route', 'duplicate route', 'missing headers', 'missing CSP']) {
        test(`the actual static build refuses ${alias} with ${defect}`, async () => {
            await withBuildFixture(directory => {
                const configPath = path.join(directory, 'staticwebapp.config.json');
                const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                const route = config.routes.find(value => value.route === alias);
                assert.ok(route, 'The governed source fixture must contain the real alias');
                if (defect === 'missing route') config.routes = config.routes.filter(value => value !== route);
                if (defect === 'duplicate route') config.routes.push({ ...route });
                if (defect === 'missing headers') delete route.headers;
                if (defect === 'missing CSP') delete route.headers['Content-Security-Policy'];
                fs.writeFileSync(configPath, JSON.stringify(config));
                assert.throws(() => execFileSync(process.execPath, [path.join(directory, 'scripts/build-static.js')], {
                    cwd: directory, stdio: 'pipe'
                }), error => String(error.stderr).includes(defect === 'duplicate route'
                    ? 'overlapping routes after trailing-slash normalization'
                    : `exactly one ${alias} route with a Content-Security-Policy header`));
            });
        });
    }
}

test('the real static build binds the canonical dashboard route using the Azure example configuration', async () => {
    await withBuildFixture(directory => {
        fs.unlinkSync(path.join(directory, 'staticwebapp.config.json'));
        execFileSync(process.execPath, [path.join(directory, 'scripts/build-static.js')], { cwd: directory, stdio: 'pipe' });
        const html = fs.readFileSync(path.join(directory, 'dist/app/dashboard.html'), 'utf8');
        const loader = html.match(/<script id="dashboardRuntime">([\s\S]*?)<\/script>/)[1];
        const scriptHash = require('node:crypto').createHash('sha256').update(loader, 'utf8').digest('base64');
        const config = JSON.parse(fs.readFileSync(path.join(directory, 'dist/staticwebapp.config.json'), 'utf8'));
        for (const alias of ['/dashboard']) {
            const routes = config.routes.filter(route => route.route === alias);
            assert.equal(routes.length, 1);
            assert.ok(routes[0].headers['Content-Security-Policy'].includes(`'sha256-${scriptHash}'`));
        }
    });
});


for (const useExample of [false, true]) {
    for (const [i, allowedRoles] of [['authenticated'], ['administrator'], ['anonymous', 'administrator'], ['anonymous'], undefined].entries()) {
        test('anonymous-default compaction preserves ' + (allowedRoles ? JSON.stringify(allowedRoles) : 'omitted roles') +
            ' using ' + (useExample ? 'the Azure example' : 'production'), async () => {
            await withBuildFixture(directory => {
                const filename = path.join(directory, useExample ? 'azure/staticwebapp.config.example.json' : 'staticwebapp.config.json');
                const source = JSON.parse(fs.readFileSync(filename, 'utf8'));
                // Probe only this isolated fixture's existing protected fallback.
                // Appending a synthetic route would test padding, not role
                // compaction, when the real configuration is near its hard cap.
                const rule = source.routes.find(route => route.route === '/api/*');
                assert.ok(rule);
                if (allowedRoles) rule.allowedRoles = allowedRoles;
                else delete rule.allowedRoles;
                fs.writeFileSync(filename, JSON.stringify(source));
                if (useExample) fs.unlinkSync(path.join(directory, 'staticwebapp.config.json'));
                execFileSync(process.execPath, [path.join(directory, 'scripts/build-static.js')], { cwd: directory, stdio: 'pipe' });
                const configText = fs.readFileSync(path.join(directory, 'dist/staticwebapp.config.json'), 'utf8');
                const built = JSON.parse(configText);
                assert.ok(Buffer.byteLength(configText, 'utf8') <= 20000);
                assert.equal(built.routes.length, source.routes.length);
                const actual = built.routes.find(r => r.route === rule.route);
                if (i < 3) {
                    assert.deepEqual(actual.allowedRoles, allowedRoles);
                    assertEquivalentHeaders(actual, rule);
                }
                else {
                    assert.equal(Object.hasOwn(actual, 'allowedRoles'), false);
                    assertEquivalentHeaders(actual, rule);
                }
            });
        });
    }
    test('actual static build publishes signup and BFF routes using ' + (useExample ? 'the Azure example' : 'the production configuration'), async () => {
        await withBuildFixture(directory => {
            const sourceConfig = JSON.parse(fs.readFileSync(path.join(directory,
                useExample ? 'azure/staticwebapp.config.example.json' : 'staticwebapp.config.json'), 'utf8'));
            if (useExample) fs.unlinkSync(path.join(directory, 'staticwebapp.config.json'));
            execFileSync(process.execPath, [path.join(directory, 'scripts/build-static.js')], { cwd: directory, stdio: 'pipe' });
            const built = path.join(directory, 'dist');
            assert.ok(fs.existsSync(path.join(built, 'app/signup.html')), 'Signup must be present in the deployed static package');
            const html = fs.readFileSync(path.join(built, 'app/signup.html'), 'utf8');
            const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
            assert.equal(scripts.length, 1);
            assert.match(scripts[0][1], /window\.location\.assign\('\/api\/customer-auth\/login'\)/);
            assert.doesNotMatch(scripts[0][1], /\/api\/auth\/login\?returnTo/);
            const scriptHash = require('node:crypto').createHash('sha256').update(scripts[0][1]).digest('base64');
            const configText = fs.readFileSync(path.join(built, 'staticwebapp.config.json'), 'utf8');
            const config = JSON.parse(configText);
            assert.equal(configText, JSON.stringify(config) + '\n', 'Deploy compact JSON, not formatting overhead');
            assert.ok(Buffer.byteLength(configText, 'utf8') <= 20000, 'The actual deployed configuration must fit the conservative budget');
            const documentCaches = sourceConfig.routes.filter(route => !route.route.startsWith('/api/') &&
                route.headers?.['Cache-Control'] === 'private, no-store, max-age=0');
            assert.ok(documentCaches.length > 0);
            for (const route of documentCaches) {
                const actual = config.routes.find(value => value.route === route.route).headers['Cache-Control'];
                assert.equal(actual, 'no-store');
                assertEquivalentHeaders({ 'Cache-Control': actual }, { 'Cache-Control': route.headers['Cache-Control'] });
            }
            // Preserve every routing and authorization value and every effective
            // response header, including the two inherited static-document CSPs.
            for (const alias of ['/', '/scoping', '/support', '/portal', '/dashboard', '/signup']) {
                sourceConfig.routes.find(route => route.route === alias).headers['Content-Security-Policy'] =
                    config.routes.find(route => route.route === alias).headers['Content-Security-Policy'];
            }
            const effectiveConfig = JSON.parse(JSON.stringify(config));
            for (const alias of ['/scope.html', '/operator']) {
                const sourceRoute = sourceConfig.routes.find(route => route.route === alias);
                const builtRoute = config.routes.find(route => route.route === alias);
                assert.equal(sourceRoute.headers['Content-Security-Policy'], sourceConfig.globalHeaders['Content-Security-Policy']);
                assert.equal(Object.hasOwn(builtRoute.headers, 'Content-Security-Policy'), false);
                sourceRoute.headers = { ...sourceConfig.globalHeaders, ...sourceRoute.headers };
                effectiveConfig.routes.find(route => route.route === alias).headers = {
                    ...config.globalHeaders, ...builtRoute.headers
                };
            }
            assertEquivalentHeaders(effectiveConfig, sourceConfig);
            // Azure defaults an omitted redirect status to 302. These existing
            // aliases keep their destinations and effective status while their
            // redundant fields make room for the exact starter API routes.
            for (const [alias, target] of Object.entries({
                '/service-desk': '/support', '/mssp': '/scoping', '/workspace': '/scoping',
                '/app': '/scoping', '/app/*': '/scoping', '/legacy-cyber-check': '/scoping',
                '/free-check': '/scoping', '/sample-report.html': '/', '/share/*': '/',
                '/founder': '/scoping', '/founder.html': '/scoping', '/about.html': '/', '/About.html': '/'
            })) {
                const route = config.routes.find(rule => rule.route === alias);
                assert.equal(route?.redirect, target, alias + ' must retain its redirect destination');
                assert.equal(route.statusCode ?? 302, 302, alias + ' must retain its effective redirect status');
            }
            // These surfaces use only exact routes and terminal-prefix wildcards.
            const matched = (method, url) => config.routes.find(route =>
                (route.route.endsWith('*') ? url.startsWith(route.route.slice(0, -1)) : route.route === url) &&
                (!route.methods || route.methods.includes(method)));
            for (const alias of ['/signup']) {
                const route = matched('GET', alias);
                assert.equal(route?.rewrite, '/app/signup.html');
                assert.deepEqual((route.allowedRoles ?? ['anonymous']), ['anonymous']);
                assert.deepEqual(route.headers['Cache-Control'].split(',').map(value => value.trim()), ['no-store']);
                assert.match(route.headers['X-Robots-Tag'], /noindex/);
                const csp = route.headers['Content-Security-Policy'];
                assert.ok(csp.includes("script-src 'sha256-" + scriptHash + "'"));
                assert.ok(csp.includes("connect-src 'self'"));
                assert.ok(csp.includes("script-src-attr 'none'"));
                assert.ok(!csp.includes("'unsafe-inline'"));
            }
            const endpoints = [
                ['GET', '/api/organisation-setup/state'],
                ['POST', '/api/organisation-setup/state'],
                ['GET', '/api/dashboard/login'],
                ['GET', '/api/customer-auth/login'],
                ['POST', '/api/customer-auth/callback'],
                ['POST', '/api/customer-signup/bootstrap'],
                ['GET', '/api/customer-signup/state'],
                ['POST', '/api/customer-signup/terms'],
                ['GET', '/api/dashboard/ncsc/assessments'],
                ['POST', '/api/dashboard/ncsc/assessments'],
                ['GET', '/api/dashboard/ncsc/assessments/assessment-1'],
                ['POST', '/api/dashboard/ncsc/assessments/assessment-1/save'],
                ['POST', '/api/dashboard/ncsc/assessments/assessment-1/submit'],
                ['GET', '/api/dashboard/improvement/plans'],
                ['GET', '/api/dashboard/improvement/list'],
                ['GET', '/api/dashboard/improvement/view'],
                ['POST', '/api/dashboard/improvement/execute']
            ];
            for (const [method, endpoint] of endpoints) {
                const route = matched(method, endpoint);
                assert.deepEqual((route?.allowedRoles ?? ['anonymous']), ['anonymous'], method + ' ' + endpoint + ' must reach BFF authentication');
                assert.deepEqual(route.headers['Cache-Control'].split(',').map(value => value.trim()), ['no-store']);
                assert.deepEqual(matched('DELETE', endpoint)?.allowedRoles, ['authenticated']);
            }
            for (const [endpoint, methods] of [
                ['/api/organisation-setup/choose', ['POST']],
                ['/api/organisation-setup/details', ['POST']],
                ['/api/customer-signup/clients', ['GET', 'POST']]
            ]) {
                for (const method of methods) {
                    const route = matched(method, endpoint);
                    assert.equal(route?.route, endpoint, method + ' ' + endpoint + ' must match its exact route');
                    assert.deepEqual((route.allowedRoles ?? ['anonymous']), ['anonymous'], method + ' ' + endpoint + ' must reach BFF authentication');
                    assert.equal(route.headers['Cache-Control'], 'no-store');
                }
                for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'CONNECT', 'OPTIONS', 'TRACE', 'PATCH'].filter(method => !methods.includes(method))) {
                    assert.deepEqual(matched(method, endpoint)?.allowedRoles, ['authenticated'], method + ' ' + endpoint + ' must retain the catch-all');
                }
            }
            for (const [method, endpoint] of [
                ['GET', '/api/organisation-setup/details'], ['PUT', '/api/organisation-setup/details'],
                ['POST', '/api/organisation-setup/details-extra'], ['POST', '/api/organisation-setup/details/nested'],
                ['PUT', '/api/customer-signup/clients'], ['PATCH', '/api/customer-signup/clients'],
                ['GET', '/api/customer-signup/clients-extra'], ['POST', '/api/customer-signup/clients/nested'],
                ['GET', '/api/customer-auth/callback'], ['POST', '/api/customer-auth/login'],
                ['POST', '/api/customer-signup/state'], ['GET', '/api/customer-signup/terms'],
                ['GET', '/api/customer-signup/bootstrap'], ['POST', '/api/dashboard/login'],
                ['POST', '/api/customer-signup/invitations'], ['GET', '/api/customer-auth/token'],
                ['POST', '/api/admin/roles'], ['GET', '/api/dashboard/ncsc/other']
            ]) {
                assert.deepEqual(matched(method, endpoint)?.allowedRoles, ['authenticated'], method + ' ' + endpoint + ' must retain the catch-all');
            }
            const dashboard = fs.readFileSync(path.join(built, 'app/dashboard.html'), 'utf8');
            assert.match(dashboard, /<body\b[^>]*\bdata-customer-provider="auto"/);
            assert.match(dashboard, /id="dashboardSignIn" href="\/login"/);
            // The shared loader retains an explicit staff branch. Public entry
            // is automatic; its emitted markup must expose no workforce link.
            const markup = dashboard.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
            assert.doesNotMatch(markup, /href="\/api\/auth\/login(?:\?|"|\/)/);
            assert.equal(fs.existsSync(path.join(built, 'api')), false);
            assert.equal(fs.existsSync(path.join(built, 'lib')), false);
        });
    }, 20000);
}



for (const useExample of [false, true]) {
    const configurationName = useExample ? 'the Azure example' : 'the production configuration';
    for (const statusCode of [308, 307, 200, '301', null]) {
        test('actual static build rejects redirect status ' + JSON.stringify(statusCode) + ' before packaging for ' + configurationName, async () => {
            await withBuildFixture(directory => {
                const configPath = path.join(directory, useExample ? 'azure/staticwebapp.config.example.json' : 'staticwebapp.config.json');
                if (useExample) fs.unlinkSync(path.join(directory, 'staticwebapp.config.json'));
                const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                config.routes.find(route => route.route === '/index.html').statusCode = statusCode;
                fs.writeFileSync(configPath, JSON.stringify(config));
                assert.throws(() => execFileSync(process.execPath, [path.join(directory, 'scripts/build-static.js')], {
                    cwd: directory, stdio: 'pipe'
                }), error => String(error.stderr).includes('unsupported redirect status for route /index.html'));
                assert.equal(fs.existsSync(path.join(directory, 'dist')), false, 'Reject unsupported redirects before producing a package');
            });
        }, 20000);
    }
    test('actual static build rejects unsupported response-override redirects before packaging for ' + configurationName, async () => {
        await withBuildFixture(directory => {
            const configPath = path.join(directory, useExample ? 'azure/staticwebapp.config.example.json' : 'staticwebapp.config.json');
            if (useExample) fs.unlinkSync(path.join(directory, 'staticwebapp.config.json'));
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            config.responseOverrides['404'] = { redirect: '/', statusCode: 308 };
            fs.writeFileSync(configPath, JSON.stringify(config));
            assert.throws(() => execFileSync(process.execPath, [path.join(directory, 'scripts/build-static.js')], {
                cwd: directory, stdio: 'pipe'
            }), error => String(error.stderr).includes('unsupported redirect status for response override 404'));
            assert.equal(fs.existsSync(path.join(directory, 'dist')), false);
        });
    }, 20000);
    for (const statusCode of [301, 302, undefined]) {
        test('actual static build preserves redirect status ' + (statusCode ?? 'default 302') + ' for ' + configurationName, async () => {
            await withBuildFixture(directory => {
                const configPath = path.join(directory, useExample ? 'azure/staticwebapp.config.example.json' : 'staticwebapp.config.json');
                if (useExample) fs.unlinkSync(path.join(directory, 'staticwebapp.config.json'));
                const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                const route = config.routes.find(route => route.route === '/index.html');
                assert.equal(route.statusCode, 301, 'The checked-in root redirect must use the supported permanent status');
                route.statusCode = statusCode;
                config.responseOverrides['404'] = { redirect: '/', statusCode };
                fs.writeFileSync(configPath, JSON.stringify(config));
                execFileSync(process.execPath, [path.join(directory, 'scripts/build-static.js')], { cwd: directory, stdio: 'pipe' });
                const built = JSON.parse(fs.readFileSync(path.join(directory, 'dist/staticwebapp.config.json'), 'utf8'));
                assert.deepEqual(built.routes.find(route => route.route === '/index.html'), JSON.parse(JSON.stringify(route)));
                assert.deepEqual(built.responseOverrides, JSON.parse(JSON.stringify(config.responseOverrides)));
            });
        }, 20000);
    }
    test('actual static build emits unique canonical dashboard/signup rules for ' + configurationName, async () => {
        await withBuildFixture(directory => {
            if (useExample) fs.unlinkSync(path.join(directory, 'staticwebapp.config.json'));
            execFileSync(process.execPath, [path.join(directory, 'scripts/build-static.js')], { cwd: directory, stdio: 'pipe' });
            const config = JSON.parse(fs.readFileSync(path.join(directory, 'dist/staticwebapp.config.json'), 'utf8'));
            for (const document of ['dashboard', 'signup']) {
                const rules = config.routes.filter(route => route.route === '/' + document || route.route === '/' + document + '/');
                assert.equal(rules.length, 1);
                assert.equal(rules[0].route, '/' + document);
                assert.equal(rules[0].rewrite, '/app/' + document + '.html');
                assert.deepEqual((rules[0].allowedRoles ?? ['anonymous']), ['anonymous']);
                assert.match(rules[0].headers['Content-Security-Policy'], /sha256-/);
                assert.deepEqual(rules[0].headers['Cache-Control'].split(',').map(value => value.trim()), ['no-store']);
            }
        });
    }, 20000);

    for (const scenario of ['dashboard alias', 'signup different policy', 'exact duplicate', 'API slash alias', 'overlapping methods', 'unspecified methods']) {
        test('actual static build rejects ' + scenario + ' before packaging for ' + configurationName, async () => {
            await withBuildFixture(directory => {
                const configPath = path.join(directory, useExample ? 'azure/staticwebapp.config.example.json' : 'staticwebapp.config.json');
                if (useExample) fs.unlinkSync(path.join(directory, 'staticwebapp.config.json'));
                const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                if (scenario === 'dashboard alias' || scenario === 'signup different policy') {
                    const canonical = scenario === 'dashboard alias' ? '/dashboard' : '/signup';
                    const original = config.routes.find(route => route.route === canonical);
                    config.routes.push({ ...original, route: canonical + '/',
                        ...(scenario === 'signup different policy' ? { allowedRoles: ['authenticated'] } : {}) });
                } else {
                    const first = { route: '/api/route-regression', allowedRoles: ['authenticated'] };
                    const second = { route: scenario === 'exact duplicate' ? first.route : first.route + '/', allowedRoles: ['anonymous'] };
                    if (scenario === 'overlapping methods') {
                        first.methods = ['GET', 'POST'];
                        second.methods = ['POST'];
                    } else if (scenario === 'unspecified methods') {
                        second.methods = ['PATCH'];
                    }
                    config.routes.unshift(first, second);
                }
                fs.writeFileSync(configPath, JSON.stringify(config));
                assert.throws(() => execFileSync(process.execPath, [path.join(directory, 'scripts/build-static.js')], {
                    cwd: directory, stdio: 'pipe'
                }), error => String(error.stderr).includes('overlapping routes after trailing-slash normalization'));
                assert.equal(fs.existsSync(path.join(directory, 'dist')), false, 'Reject collisions before producing a package');
            });
        }, 20000);
    }

    test('actual static build preserves non-overlapping method rules for ' + configurationName, async () => {
        await withBuildFixture(directory => {
            const configPath = path.join(directory, useExample ? 'azure/staticwebapp.config.example.json' : 'staticwebapp.config.json');
            if (useExample) fs.unlinkSync(path.join(directory, 'staticwebapp.config.json'));
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            // Reuse two API rules: this routing test must not
            // add artificial padding to the independently tested byte budget.
            const getRule = config.routes.find(route => route.route === '/api/organisation-setup/state');
            const postRule = config.routes.find(route => route.route === '/api/organisation-setup/request');
            assert.deepEqual(getRule?.methods, ['GET', 'POST']);
            assert.deepEqual(postRule?.methods, ['POST']);
            const rules = [
                { ...getRule, methods: ['GET'], route: '/api/route-regression', allowedRoles: ['authenticated'] },
                { ...postRule, route: '/api/route-regression/', allowedRoles: ['anonymous'] }
            ];
            config.routes = config.routes.filter(route => route !== getRule && route !== postRule);
            config.routes.unshift(...rules);
            fs.writeFileSync(configPath, JSON.stringify(config));
            execFileSync(process.execPath, [path.join(directory, 'scripts/build-static.js')], { cwd: directory, stdio: 'pipe' });
            const built = JSON.parse(fs.readFileSync(path.join(directory, 'dist/staticwebapp.config.json'), 'utf8'));
            assertEquivalentHeaders(built.routes.slice(0, 2), rules);
        });
    }, 20000);
}

test('static CSP inheritance preserves different policies, API headers and unlisted routes', async () => {
    await withBuildFixture(directory => {
        fs.unlinkSync(path.join(directory, 'staticwebapp.config.json'));
        const sourcePath = path.join(directory, 'azure/staticwebapp.config.example.json');
        const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
        const policyHeader = 'Content-Security-Policy';
        const globalPolicy = source.globalHeaders[policyHeader];
        const scope = source.routes.find(route => route.route === '/scope.html');
        const operator = source.routes.find(route => route.route === '/operator');
        const api = source.routes.find(route => route.route === '/api/*');
        assert.ok(scope && operator && api);
        scope.headers[policyHeader] = "default-src 'none'; frame-ancestors 'none'";
        operator.rewrite = '/api/health';
        api.headers = { ...api.headers, [policyHeader]: globalPolicy };
        const other = { route: '/other-static.html', allowedRoles: ['authenticated'], headers: { [policyHeader]: globalPolicy } };
        source.routes.push(other);
        fs.writeFileSync(sourcePath, JSON.stringify(source));
        execFileSync(process.execPath, [path.join(directory, 'scripts/build-static.js')], { cwd: directory, stdio: 'pipe' });
        const built = JSON.parse(fs.readFileSync(path.join(directory, 'dist/staticwebapp.config.json'), 'utf8'));
        assert.deepEqual(built.globalHeaders, source.globalHeaders);
        for (const expected of [scope, operator, api, other]) {
            assertEquivalentHeaders(built.routes.find(route => route.route === expected.route), expected);
        }
    });
}, 20000);

for (const alias of ['/scope.html', '/operator']) {
    for (const responseChange of ['redirect', 'statusCode']) {
        test(`static CSP inheritance preserves the explicit policy on ${alias} with ${responseChange}`, async () => {
            await withBuildFixture(directory => {
                fs.unlinkSync(path.join(directory, 'staticwebapp.config.json'));
                const sourcePath = path.join(directory, 'azure/staticwebapp.config.example.json');
                const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
                const route = source.routes.find(value => value.route === alias);
                if (responseChange === 'redirect') {
                    delete route.rewrite;
                    route.redirect = '/scoping';
                } else {
                    route.statusCode = 404;
                }
                fs.writeFileSync(sourcePath, JSON.stringify(source));
                execFileSync(process.execPath, [path.join(directory, 'scripts/build-static.js')], { cwd: directory, stdio: 'pipe' });
                const built = JSON.parse(fs.readFileSync(path.join(directory, 'dist/staticwebapp.config.json'), 'utf8'));
                assertEquivalentHeaders(built.routes.find(value => value.route === alias), route);
            });
        }, 20000);
    }
}

for (const useExample of [false, true]) {
    const configurationName = useExample ? 'the Azure example' : 'the production configuration';
    test('actual static build accepts the exact byte budget and rejects one byte over for ' + configurationName, async () => {
        await withBuildFixture(directory => {
            const sourcePath = path.join(directory,
                useExample ? 'azure/staticwebapp.config.example.json' : 'staticwebapp.config.json');
            if (useExample) fs.unlinkSync(path.join(directory, 'staticwebapp.config.json'));
            const build = () => execFileSync(process.execPath, [path.join(directory, 'scripts/build-static.js')], {
                cwd: directory, stdio: 'pipe'
            });
            const outputPath = path.join(directory, 'dist/staticwebapp.config.json');
            build();
            const built = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
            const header = 'X-Test';
            built.globalHeaders = { ...built.globalHeaders, [header]: '' };
            const padding = 20000 - Buffer.byteLength(JSON.stringify(built) + '\n', 'utf8');
            assert.ok(padding > 1, 'The real compact configuration must retain byte headroom');
            const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
            source.globalHeaders = { ...source.globalHeaders, [header]: 'x'.repeat(padding) };
            fs.writeFileSync(sourcePath, JSON.stringify(source, null, 2) + '\n');
            build();
            assert.equal(fs.statSync(outputPath).size, 20000);
            assert.equal(JSON.parse(fs.readFileSync(outputPath, 'utf8')).globalHeaders[header], 'x'.repeat(padding));
            source.globalHeaders[header] += 'x';
            fs.writeFileSync(sourcePath, JSON.stringify(source, null, 2) + '\n');
            assert.throws(build, error => String(error.stderr).includes(
                'configuration is 20001 UTF-8 bytes; maximum is 20000 bytes.'));
        });
    }, 20000);

    test('actual static build counts UTF-8 bytes rather than characters for ' + configurationName, async () => {
        await withBuildFixture(directory => {
            const sourcePath = path.join(directory,
                useExample ? 'azure/staticwebapp.config.example.json' : 'staticwebapp.config.json');
            if (useExample) fs.unlinkSync(path.join(directory, 'staticwebapp.config.json'));
            const build = () => execFileSync(process.execPath, [path.join(directory, 'scripts/build-static.js')], {
                cwd: directory, stdio: 'pipe'
            });
            build();
            const built = JSON.parse(fs.readFileSync(path.join(directory, 'dist/staticwebapp.config.json'), 'utf8'));
            const header = 'X-Test';
            built.globalHeaders = { ...built.globalHeaders, [header]: '' };
            const remaining = 20000 - Buffer.byteLength(JSON.stringify(built) + '\n', 'utf8');
            assert.ok(remaining > 2);
            const value = '界'.repeat(Math.floor(remaining / 3) + 1);
            built.globalHeaders[header] = value;
            const compact = JSON.stringify(built) + '\n';
            assert.ok(compact.length < 20000, 'Character counting would wrongly admit this fixture');
            assert.ok(Buffer.byteLength(compact, 'utf8') > 20000);
            const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
            source.globalHeaders = { ...source.globalHeaders, [header]: value };
            fs.writeFileSync(sourcePath, JSON.stringify(source, null, 2) + '\n');
            assert.throws(build, error => String(error.stderr).includes(
                'UTF-8 bytes; maximum is 20000 bytes.'));
        });
    }, 20000);
}

test('the public dashboard login redirects to the single customer entry while staff access stays separate', async () => {
    const response = await require('supertest')(require('../server.js')).get('/api/dashboard/login');
    assert.equal(response.status, 303);
    assert.equal(response.headers.location, '/login');
    assert.doesNotMatch(response.text, /Operator account|Customer account|Staff/);
    const operator = await require('supertest')(require('../server.js')).get('/operator');
    assert.equal(operator.status, 200);
    assert.match(operator.text, /operator/i);
    assert.equal(response.headers['set-cookie'], undefined);
    assert.match(response.headers['cache-control'], /no-store/);
}, 20000);

test('the real App Service build fails when the required dashboard document is missing', async () => {
    await withBuildFixture(directory => {
        fs.unlinkSync(path.join(directory, 'app/dashboard.html'));
        assert.throws(() => execFileSync(process.execPath, [path.join(directory, 'scripts/build-app-service.js')], {
            cwd: directory, stdio: 'pipe'
        }), error => String(error.stderr).includes('Required App Service runtime path is missing: app/dashboard.html'));
    });
});
