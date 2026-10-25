const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { buildScopingDocument } = require('../lib/scopingDocument');
const { buildSupportDocument } = require('../lib/supportDocument');
const { buildPortalDocument } = require('../lib/portalDocument');
const { buildDashboardDocument } = require('../lib/dashboardDocument');
const { buildGatewayDocument } = require('../lib/gatewayDocument');
const { buildHostedSignupDocument } = require('../lib/signupDocument');
const { withSharedAssistantDocument, publicAssistantPage } = require('../lib/withSharedAssistantDocument');
const { withHashBoundSharedAssistantDocument } = require('../lib/withHashBoundSharedAssistantDocument');
const {
    PUBLIC_ROOT_FILES,
    PUBLIC_SCRIPT_FILES
} = require('../lib/publicAssets');

const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
// The production deployment client rejected 20,322 bytes. Stay within both
// decimal and binary interpretations of its documented 20 KB limit.
const MAX_STATIC_CONFIG_BYTES = 20000;

const staticWebAppConfig = fs.existsSync(path.join(rootDir, 'staticwebapp.config.json'))
    ? path.join(rootDir, 'staticwebapp.config.json')
    : path.join(rootDir, 'azure', 'staticwebapp.config.example.json');
validateStaticWebAppRoutes(JSON.parse(fs.readFileSync(staticWebAppConfig, 'utf8')));

fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(distDir, { recursive: true });

for (const fileName of PUBLIC_ROOT_FILES) {
    copyIfExists(path.join(rootDir, fileName), path.join(distDir, fileName));
}
copyIfExists(
    path.join(rootDir, 'api', 'shared', 'releaseManifest.json'),
    path.join(distDir, 'release.json')
);

copyDirectory(path.join(rootDir, 'images'), path.join(distDir, 'images'));
for (const extension of ['pptx', 'pdf']) {
    const relativePath = 'assets/workshops/No_Fries_Questionnaire_Onsite_Companion_v2_NZISM.' + extension;
    const destination = path.join(distDir, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(rootDir, relativePath), destination);
}
PUBLIC_SCRIPT_FILES.forEach((fileName) => {
    copyIfExists(path.join(rootDir, 'js', fileName), path.join(distDir, 'js', fileName));
});
copyIfExists(path.join(rootDir, 'app', 'mssp.html'), path.join(distDir, 'app', 'mssp.html'));
copyIfExists(path.join(rootDir, 'app', 'mssp.css'), path.join(distDir, 'assets', 'mssp.css'));
copyIfExists(path.join(rootDir, 'app', 'support.html'), path.join(distDir, 'app', 'support.html'));
copyIfExists(path.join(rootDir, 'app', 'support.css'), path.join(distDir, 'assets', 'support.css'));
copyIfExists(path.join(rootDir, 'app', 'operator.html'), path.join(distDir, 'app', 'operator.html'));
copyIfExists(path.join(rootDir, 'app', 'operator.css'), path.join(distDir, 'assets', 'operator.css'));
copyIfExists(path.join(rootDir, 'app', 'portal.html'), path.join(distDir, 'app', 'portal.html'));
copyIfExists(path.join(rootDir, 'app', 'portal.css'), path.join(distDir, 'assets', 'portal.css'));
copyIfExists(path.join(rootDir, 'app', 'dashboard.html'), path.join(distDir, 'app', 'dashboard.html'));
fingerprintScopingCss();
const scopingDocument = writeScopingDocument();
const supportDocument = writeSupportDocument();
const portalDocument = writePortalDocument();
const dashboardDocument = writeDashboardDocument();
const signupDocument = writeSignupDocument();
const gatewayDocument = buildGatewayDocument({
    customerLogin: true, customerTransport: 'auto', template: fs.readFileSync(path.join(rootDir, 'index.html'), 'utf8'),
    loaderSource: fs.readFileSync(path.join(rootDir, 'js', 'dashboard-loader.js'), 'utf8'),
    protectedAppSource: ['dashboardRegistry.js', 'dashboardShell.js', 'ncscAssessmentClient.js', 'ncscQuestionnaire.js', 'assessmentExplanation.js', 'organisationPicture.js', 'improvementActionPlanView.js', 'improvementActionPlanClient.js']
        .map(file => fs.readFileSync(path.join(rootDir, 'api', 'shared', 'protectedAssets', file), 'utf8')).join('\n'),
    protectedStyleSource: fs.readFileSync(path.join(rootDir, 'app', 'dashboard.css'), 'utf8')
});
fs.writeFileSync(path.join(distDir, 'index.html'), gatewayDocument.html);
for (const fileName of [...PUBLIC_ROOT_FILES.filter(file => file.endsWith('.html')),
    'app/mssp.html', 'app/support.html', 'app/portal.html', 'app/dashboard.html', 'app/operator.html']) {
    const documentPath = path.join(distDir, fileName);
    fs.writeFileSync(documentPath, withSharedAssistantDocument(fs.readFileSync(documentPath, 'utf8'), publicAssistantPage(fileName)));
}

copyIfExists(staticWebAppConfig, path.join(distDir, 'staticwebapp.config.json'));
writeScopingContentSecurityPolicy(scopingDocument.contentSecurityPolicy);
writeSupportContentSecurityPolicy(supportDocument.contentSecurityPolicy);
writePortalContentSecurityPolicy(portalDocument.contentSecurityPolicy);
writePrivateDocumentContentSecurityPolicy(dashboardDocument.contentSecurityPolicy, ['/dashboard']);
writePrivateDocumentContentSecurityPolicy(signupDocument.contentSecurityPolicy, ['/signup']);
writePrivateDocumentContentSecurityPolicy(gatewayDocument.contentSecurityPolicy, ['/']);
finalizeStaticWebAppConfig();

function fingerprintScopingCss() {
    const shellPath = path.join(distDir, 'app', 'mssp.html');
    if (!fs.existsSync(shellPath)) {
        return;
    }

    const assetPaths = ['/assets/mssp.css'];
    let shell = fs.readFileSync(shellPath, 'utf8');

    for (const assetPath of assetPaths) {
        const filePath = path.join(distDir, assetPath.replace(/^\//, ''));
        if (!fs.existsSync(filePath)) {
            continue;
        }
        const digest = crypto.createHash('sha256')
            .update(fs.readFileSync(filePath))
            .digest('hex')
            .slice(0, 12);
        shell = shell.replace(assetPath, `${assetPath}?v=${digest}`);
    }

    fs.writeFileSync(shellPath, shell);
}

function writeScopingDocument() {
    const shellPath = path.join(distDir, 'app', 'mssp.html');
    if (!fs.existsSync(shellPath)) {
        throw new Error('The scoping document template was not copied to dist.');
    }

    const result = buildScopingDocument({
        template: fs.readFileSync(shellPath, 'utf8'),
        loaderSource: fs.readFileSync(path.join(rootDir, 'js', 'app-loader.js'), 'utf8'),
        copySource: fs.readFileSync(path.join(rootDir, 'js', 'scoping-copy.js'), 'utf8')
    });

    fs.writeFileSync(shellPath, result.html);
    return result;
}

function writeSupportDocument() {
    const shellPath = path.join(distDir, 'app', 'support.html');
    if (!fs.existsSync(shellPath)) {
        throw new Error('The support document template was not copied to dist.');
    }

    const result = buildSupportDocument({
        template: fs.readFileSync(shellPath, 'utf8'),
        loaderSource: fs.readFileSync(path.join(rootDir, 'js', 'support-loader.js'), 'utf8')
    });

    fs.writeFileSync(shellPath, result.html);
    return result;
}

function writePortalDocument() {
    const shellPath = path.join(distDir, 'app', 'portal.html');
    if (!fs.existsSync(shellPath)) {
        throw new Error('The customer portal document template was not copied to dist.');
    }
    const result = buildPortalDocument({
        template: fs.readFileSync(shellPath, 'utf8'),
        loaderSource: fs.readFileSync(path.join(rootDir, 'js', 'portal-loader.js'), 'utf8')
    });
    fs.writeFileSync(shellPath, result.html);
    return result;
}

function writeDashboardDocument() {
    const shellPath = path.join(distDir, 'app', 'dashboard.html');
    if (!fs.existsSync(shellPath)) {
        throw new Error('The dashboard document template was not copied to dist.');
    }
    const result = buildDashboardDocument({
        customerLogin: true, customerTransport: 'auto',
        template: fs.readFileSync(shellPath, 'utf8'),
        loaderSource: fs.readFileSync(path.join(rootDir, 'js', 'dashboard-loader.js'), 'utf8'),
        protectedAppSource: ['dashboardRegistry.js', 'dashboardShell.js', 'ncscAssessmentClient.js', 'ncscQuestionnaire.js', 'assessmentExplanation.js', 'organisationPicture.js', 'improvementActionPlanView.js', 'improvementActionPlanClient.js']
            .map(file => fs.readFileSync(path.join(rootDir, 'api', 'shared', 'protectedAssets', file), 'utf8')).join('\n'),
        protectedStyleSource: fs.readFileSync(path.join(rootDir, 'app', 'dashboard.css'), 'utf8')
    });
    fs.writeFileSync(shellPath, result.html);
    return result;
}

function writeSignupDocument() {
    // Signup's hash-only policy and its helper bundle must be composed together.
    const result = withHashBoundSharedAssistantDocument(buildHostedSignupDocument({
        clientSource: fs.readFileSync(path.join(rootDir, 'api/shared/customerSignup/signupClient.js'), 'utf8'),
        journeySource: fs.readFileSync(path.join(rootDir, 'api/shared/customerSignup/signupJourney.js'), 'utf8'),
        customerLogin: true
    }), {
        prospectSource: fs.readFileSync(path.join(rootDir, 'js/prospect-assistant.js'), 'utf8'),
        sharedSource: fs.readFileSync(path.join(rootDir, 'js/shared-assistant.js'), 'utf8')
    });
    const shellPath = path.join(distDir, 'app', 'signup.html');
    fs.mkdirSync(path.dirname(shellPath), { recursive: true });
    fs.writeFileSync(shellPath, result.html);
    return result;
}

function writeScopingContentSecurityPolicy(contentSecurityPolicy) {
    const configPath = path.join(distDir, 'staticwebapp.config.json');
    if (!fs.existsSync(configPath)) {
        throw new Error('The Static Web Apps configuration was not copied to dist.');
    }

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const scopingRoute = Array.isArray(config.routes)
        ? config.routes.find((route) => route.route === '/scoping')
        : null;
    if (!scopingRoute || !scopingRoute.headers) {
        throw new Error('The Static Web Apps configuration did not contain a /scoping route with headers.');
    }

    scopingRoute.headers['Content-Security-Policy'] = contentSecurityPolicy;
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

function writeSupportContentSecurityPolicy(contentSecurityPolicy) {
    const configPath = path.join(distDir, 'staticwebapp.config.json');
    if (!fs.existsSync(configPath)) {
        throw new Error('The Static Web Apps configuration did not contain a built file.');
    }

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const supportRoute = Array.isArray(config.routes)
        ? config.routes.find((route) => route.route === '/support')
        : null;
    if (!supportRoute || !supportRoute.headers) {
        throw new Error('The Static Web Apps configuration did not contain a /support route with headers.');
    }

    supportRoute.headers['Content-Security-Policy'] = contentSecurityPolicy;
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

function writePortalContentSecurityPolicy(contentSecurityPolicy) {
    const configPath = path.join(distDir, 'staticwebapp.config.json');
    if (!fs.existsSync(configPath)) {
        throw new Error('The Static Web Apps configuration did not contain a built file.');
    }
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const portalRoute = Array.isArray(config.routes)
        ? config.routes.find((route) => route.route === '/portal')
        : null;
    if (!portalRoute || !portalRoute.headers) {
        throw new Error('The Static Web Apps configuration did not contain a /portal route with headers.');
    }
    portalRoute.headers['Content-Security-Policy'] = contentSecurityPolicy;
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

function writePrivateDocumentContentSecurityPolicy(contentSecurityPolicy, aliases) {
    const configPath = path.join(distDir, 'staticwebapp.config.json');
    if (!fs.existsSync(configPath)) {
        throw new Error('The Static Web Apps configuration did not contain a built file.');
    }
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    for (const alias of aliases) {
        const routes = Array.isArray(config.routes) ? config.routes.filter(route => route.route === alias) : [];
        if (routes.length !== 1 || !routes[0].headers ||
            !Object.hasOwn(routes[0].headers, 'Content-Security-Policy')) {
            throw new Error(`The Static Web Apps configuration must contain exactly one ${alias} route with a Content-Security-Policy header.`);
        }
        routes[0].headers['Content-Security-Policy'] = contentSecurityPolicy;
    }
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}


function validateStaticWebAppRoutes(config) {
    // Azure rejects equivalent slash aliases before publication. Check the source
    // before constructing a package; never silently discard a competing policy.
    const allMethods = ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'CONNECT', 'OPTIONS', 'TRACE', 'PATCH'];
    if (!Array.isArray(config.routes)) {
        throw new Error('Static Web Apps configuration must contain a routes array.');
    }
    const seen = new Map();
    for (const rule of config.routes) {
        if (!rule || typeof rule.route !== 'string' || !rule.route.startsWith('/')) {
            throw new Error('Static Web Apps configuration contains an invalid route.');
        }
        validateRedirectStatus(rule, 'route ' + rule.route);
        const methods = rule.methods === undefined ? allMethods : rule.methods;
        if (!Array.isArray(methods) || methods.length === 0 ||
            methods.some(method => !allMethods.includes(method))) {
            throw new Error('Static Web Apps configuration contains invalid route methods: ' + rule.route);
        }
        const normalized = rule.route.replace(/\/+$/, '') || '/';
        const previous = seen.get(normalized) || [];
        const collision = previous.find(entry => methods.some(method => entry.methods.includes(method)));
        if (collision) {
            throw new Error('Static Web Apps configuration contains overlapping routes after trailing-slash normalization: ' +
                collision.route + ' and ' + rule.route + '.');
        }
        previous.push({ route: rule.route, methods });
        seen.set(normalized, previous);
    }
    for (const [status, response] of Object.entries(config.responseOverrides || {})) {
        validateRedirectStatus(response, 'response override ' + status);
    }
}

function validateRedirectStatus(response, location) {
    // Azure supports explicit 301/302 only; an omitted redirect status defaults
    // to 302. Do not apply this constraint to ordinary rewrite/error responses.
    if (response && Object.hasOwn(response, 'redirect') && Object.hasOwn(response, 'statusCode') &&
        ![301, 302].includes(response.statusCode)) {
        throw new Error('Static Web Apps configuration contains an unsupported redirect status for ' +
            location + '; use 301, 302, or omit statusCode for the default 302.');
    }
}

function finalizeStaticWebAppConfig() {
    const configPath = path.join(distDir, 'staticwebapp.config.json');
    // Bind every document's CSP before compacting. Keep source configurations
    // readable and preserve effective headers and all routing/authorization rules.
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const policyHeader = 'Content-Security-Policy';
    const globalPolicy = config.globalHeaders?.[policyHeader];
    if (typeof globalPolicy === 'string' && globalPolicy.length > 0) {
        for (const route of config.routes) {
            // Only these exact static-document bindings may inherit the identical
            // global policy. API responses do not inherit global headers.
            const staticDocument = (route.route === '/scope.html' && route.rewrite === undefined) ||
                (route.route === '/operator' && route.rewrite === '/app/operator.html');
            if (staticDocument && route.redirect === undefined && route.statusCode === undefined &&
                route.headers?.[policyHeader] === globalPolicy) {
                delete route.headers[policyHeader];
            }
        }
    }
    // Optional whitespace between these header directives has no semantic
    // effect. Keep every directive and route while respecting SWA's hard 20 KB
    // limit; do not remove API headers (they do not inherit global headers).
    for (const route of config.routes) {
        // SWA's documented default for an omitted allowedRoles is anonymous.
        // Omit only that exact redundant singleton, retaining every protected,
        // custom or mixed role list and all path/method/header restrictions.
        // https://learn.microsoft.com/azure/static-web-apps/configuration#define-routes
        if (Array.isArray(route.allowedRoles) && route.allowedRoles.length === 1 &&
            route.allowedRoles[0] === 'anonymous') delete route.allowedRoles;
        const headers = route.headers;
        if (typeof headers?.[policyHeader] === 'string') headers[policyHeader] = headers[policyHeader].replace(/; +/g, ';');
        // This closed comma-list permits optional whitespace. Preserve both
        // directives on every existing route; save only its separator space.
        if (headers?.['X-Robots-Tag'] === 'noindex, nofollow') headers['X-Robots-Tag'] = 'noindex,nofollow';
        // The identical closed document policy has the same optional comma
        // whitespace. Preserve every directive and leave custom values intact.
        if ((route.route.startsWith('/api/') || headers?.['Cache-Control'] === 'private, no-store, max-age=0') &&
            typeof headers?.['Cache-Control'] === 'string') {
            headers['Cache-Control'] = headers['Cache-Control'].replace(/, +/g, ',');
        }
        // RFC 9111 section 5.2.2.5 prohibits storage and reuse in both private
        // and shared caches. Only this closed policy has redundant private and
        // freshness directives; retain all custom/partial/extended policies.
        if (headers?.['Cache-Control'] === 'private,no-store,max-age=0') headers['Cache-Control'] = 'no-store';
    }
    const serialized = JSON.stringify(config) + '\n';
    const bytes = Buffer.byteLength(serialized, 'utf8');
    if (bytes > MAX_STATIC_CONFIG_BYTES) {
        throw new Error('Static Web Apps configuration is ' + bytes +
            ' UTF-8 bytes; maximum is ' + MAX_STATIC_CONFIG_BYTES + ' bytes.');
    }
    fs.writeFileSync(configPath, serialized);
}

function copyDirectory(source, destination) {
    if (!fs.existsSync(source)) {
        return;
    }
    fs.cpSync(source, destination, { recursive: true });
}

function copyIfExists(source, destination) {
    if (!fs.existsSync(source)) {
        return;
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
}
