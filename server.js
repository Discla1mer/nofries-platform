const express = require('express');
const fs = require('fs');
const path = require('path');
const { buildScopingDocument } = require('./lib/scopingDocument');
const { buildSupportDocument } = require('./lib/supportDocument');
const { buildPortalDocument } = require('./lib/portalDocument');
const { buildDashboardDocument, withCustomerProvider } = require('./lib/dashboardDocument');
const { buildGatewayDocument } = require('./lib/gatewayDocument');
const { withSharedAssistantDocument, publicAssistantPage } = require('./lib/withSharedAssistantDocument');
const { withHashBoundSharedAssistantDocument } = require('./lib/withHashBoundSharedAssistantDocument');
const {
    checkRateLimit,
    getClientKeyFromHeaders,
    isBlockedUserAgent,
    rateLimitHeaders
} = require('./api/shared/abuseProtection');
const {
    errorResponse,
    handleSalesRequest
} = require('./api/shared/salesRuntime');
const {
    errorResponse: serviceDeskErrorResponse,
    handleServiceDeskRequest
} = require('./api/shared/serviceDeskRuntime');
const {
    errorResponse: customerPortalErrorResponse,
    handleCustomerPortalRequest
} = require('./api/shared/customerPortalRuntime');
const {
    errorResponse: lifecycleErrorResponse,
    getLifecycleService: getAppLifecycleService,
    handleLifecycleRequest
} = require('./api/shared/appLifecycleRuntime');
const {
    errorResponse: dattoRmmErrorResponse,
    handleDattoRmmRequest
} = require('./api/shared/dattoRmmRuntime');
const {
    errorResponse: prospectErrorResponse,
    handleProspectChatRequest,
    handleProspectSessionRequest
} = require('./api/shared/prospectRuntime');
const {
    handleMcpAuthMetadataRequest,
    handleMcpRequest
} = require('./api/shared/mcpRuntime');
const {
    handleMcpOauthAuthorizeRequest,
    handleMcpOauthMetadataRequest,
    handleMcpOauthTokenRequest
} = require('./api/shared/mcpOauthBridge');
const {
    clearAccessCookie,
    createScopeAccessService,
    ScopeAccessError
} = require('./api/shared/scopeAccess');
const { getServiceScope } = require('./api/shared/serviceScope');
const { API_SECURITY_HEADERS, assertSameOriginForMutation } = require('./api/shared/securityHeaders');
const { requestBodySize } = require('./api/shared/requestLimits');
const { createAuthLoginFunction } = require('./api/authLogin');
const { createAuthCallbackFunction } = require('./api/authCallback');
const { createAuthLogoutFunction } = require('./api/authLogout');
const { createAuthSessionFunction } = require('./api/authSession');
const healthFunction = require('./api/health');
const {
    PRIVATE_WORKSPACE_STYLES,
    PUBLIC_ROOT_FILES,
    PUBLIC_SCRIPT_FILES
} = require('./lib/publicAssets');
const { startStandaloneHost } = require('./lib/hostStartup');
const { createDashboardRuntimeHandlers } = require('./api/shared/dashboardRuntimeHandlers');
const { createDashboardAdminService } = require('./api/shared/dashboardAdmin/service');
const { createSignupListService } = require('./api/shared/dashboardAdmin/signupService');
const { createDashboardAdminHandlers } = require('./api/shared/dashboardAdmin/handlers');
const { createCustomerSignupRuntime, customerSignupErrorResponse } = require('./api/shared/customerSignup/customerSignupRuntime');
const { withSignupSupportContext } = require('./api/shared/customerSignup/signupSupportContext');
const { buildSignupDocument, buildSignupUnavailableDocument } = require('./lib/signupDocument');
const { BrowserAuthError, clearRetainedReadTransactionCookie, externalCustomerCallbackPurpose } = require('./api/shared/browserAuth');
const { fields, copy, freeze } = require('./api/shared/appLifecycle/dashboardRuntimeRecords');
const { normaliseRetainedTrialReadSelection } = require('./api/shared/customerSignup/retainedTrialAssessmentReader');
const { buildRetainedTrialReadDocument, retainedResultPath, contentSecurityPolicy: retainedReadContentSecurityPolicy } = require('./lib/retainedTrialReadDocument');
const { isProxy } = require('node:util').types;
const { AsyncLocalStorage } = require('node:async_hooks');
const { IncomingMessage } = require('node:http');

function dashboardEnvironmentSnapshot(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) throw new Error();
    // Accept native process.env without retaining its live object/prototype or
    // evaluating an accessor. The configured app owns only this bounded data.
    const snapshot = {};
    for (const key of Reflect.ownKeys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (typeof key !== 'string' || !descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) throw new Error();
        if (descriptor.enumerable) Object.defineProperty(snapshot, key, { value: descriptor.value, enumerable: true });
    }
    return freeze(copy(snapshot, 32768));
}

function createNoFriesApp(configuration = {}) {
    // Native request correlation stays private to this app's asynchronous
    // administration invocation; it never becomes client/audit data.
    const dashboardAdminRequests = new AsyncLocalStorage();
    const nativeAdminInvocation = () => {
        const invocation = dashboardAdminRequests.getStore();
        if (!(invocation?.request instanceof IncomingMessage) || invocation.signal.aborted) {
            throw new Error('dashboard_admin_native_request_unavailable');
        }
        return invocation;
    };
    const nativeAdminRequest = () => nativeAdminInvocation().request;
    const nativeSignupContext = signal => {
        const invocation = nativeAdminInvocation();
        return Object.freeze({ request: invocation.request, signal: AbortSignal.any([signal, invocation.signal]) });
    };
    let dashboardAdminSignupListService = null;
    let dashboard = null, customerSignup = null, externalCustomerSignup = null, authEnvironment = null, retainedTrialRead = null, dashboardAdminService = null, dashboardAdminRequestBudgetMs = 10000;
    try {
        if (!configuration || typeof configuration !== 'object' || isProxy(configuration)) throw new Error();
        const keys = Reflect.ownKeys(configuration);
        fields(configuration, keys);
        if (keys.some(key => !['dashboard', 'dashboardAdmin', 'dashboardAdminSignupList', 'customerSignup', 'externalCustomerSignup', 'signupBootstrap', 'organisationSetup', 'externalOrganisationSetup', 'starterClients', 'externalStarterClients', 'customerEntry', 'retainedTrialRead'].includes(key))) throw new Error();
        if (keys.includes('customerEntry') && configuration.customerEntry !== 'external') throw new Error();
        if (keys.includes('starterClients') && typeof configuration.starterClients !== 'function') throw new Error();
        if (keys.includes('externalStarterClients') && typeof configuration.externalStarterClients !== 'function') throw new Error();
        if (keys.includes('dashboard') && configuration.dashboard !== null) {
            const supplied = configuration.dashboard;
            const names = ['browserAuthOptions', 'identityPolicy', 'proofStore', 'clock', 'readExternalRuntimeEpoch',
                'newRequestId', 'requestBudgetMs', 'pool', 'instanceId', 'historyBudget', 'newId', 'newGenerationToken', 'newOperationId'];
            for (const optional of ['ncsc', 'improvementEnabled', 'customer', 'externalCustomer', 'activation']) if (supplied && !isProxy(supplied) && Object.prototype.hasOwnProperty.call(supplied, optional)) names.push(optional);
            fields(supplied, names);
            const snapshot = Object.fromEntries(names.map(name => [name, supplied[name]]));
            const auth = snapshot.browserAuthOptions;
            if (!auth || typeof auth !== 'object' || isProxy(auth)) throw new Error();
            const authKeys = Reflect.ownKeys(auth);
            fields(auth, authKeys);
            if (!authKeys.includes('env')) throw new Error();
            authEnvironment = dashboardEnvironmentSnapshot(auth.env);
            snapshot.browserAuthOptions = Object.freeze({ ...auth, env: authEnvironment });
            dashboard = createDashboardRuntimeHandlers(Object.freeze(snapshot));
        }
        if (keys.includes('dashboardAdmin') && configuration.dashboardAdmin !== null) {
            if (!dashboard) throw new Error();
            const port = fields(configuration.dashboardAdmin, ['authoriseOperator', 'readAuthoritySnapshot', 'audit', 'clock', 'requestBudgetMs']);
            if (typeof port.authoriseOperator !== 'function' || isProxy(port.authoriseOperator)) throw new Error();
            if (port.readAuthoritySnapshot !== null &&
                (typeof port.readAuthoritySnapshot !== 'function' || isProxy(port.readAuthoritySnapshot))) throw new Error();
            if (typeof port.audit !== 'function' || isProxy(port.audit)) throw new Error();
            const authoriseOperator = port.authoriseOperator;
            const readAuthoritySnapshot = port.readAuthoritySnapshot;
            const audit = port.audit;
            // Source-only opt-in. The trusted policy must preserve current
            // dashboard session-gate and restore-epoch revocation controls.
            // Ordinary staff admin status supplies no cross-tenant authority.
            dashboardAdminService = createDashboardAdminService(Object.freeze({ ...port,
                authoriseOperator(input) {
                    let request;
                    try { request = nativeAdminRequest(); } catch (_) { return false; }
                    return authoriseOperator(Object.freeze({ principal: input.principal, selector: input.selector, request }));
                },
                readAuthoritySnapshot: readAuthoritySnapshot === null ? null : (scope, principal, selector) => {
                    if (!selector || !Object.isFrozen(selector)) throw new Error('dashboard_admin_selector_unavailable');
                    return readAuthoritySnapshot(scope, principal, selector,
                        Object.freeze({ request: nativeAdminRequest(), selector }));
                },
                audit(event, selector) {
                    if (!selector || !Object.isFrozen(selector)) throw new Error('dashboard_admin_selector_unavailable');
                    return audit(event, Object.freeze({ request: nativeAdminRequest(), selector }));
                } }));
            dashboardAdminRequestBudgetMs = port.requestBudgetMs;
        }
        if (keys.includes('dashboardAdminSignupList') && configuration.dashboardAdminSignupList !== null) {
            if (!dashboard) throw new Error();
            const port = fields(configuration.dashboardAdminSignupList,
                ['authoriseSignupList', 'readSignupPage', 'audit', 'clock', 'requestBudgetMs']);
            for (const key of ['authoriseSignupList', 'clock']) {
                if (typeof port[key] !== 'function' || isProxy(port[key])) throw new Error();
            }
            for (const key of ['readSignupPage', 'audit']) {
                if (port[key] !== null && (typeof port[key] !== 'function' || isProxy(port[key]))) throw new Error();
            }
            const { authoriseSignupList, readSignupPage, audit } = port;
            // Independent source-only opt-in: neither lookup authority nor staff
            // admin status grants listing. Production supplies none of these ports.
            dashboardAdminSignupListService = createSignupListService(Object.freeze({ ...port,
                async authoriseSignupList(input) {
                    const result = await authoriseSignupList(Object.freeze({ principal: input.principal,
                        capability: input.capability, request: nativeAdminRequest() }));
                    nativeAdminInvocation();
                    return result;
                },
                readSignupPage: readSignupPage === null ? null : async (query, context) => {
                    const result = await readSignupPage(query, nativeSignupContext(context.signal));
                    nativeAdminInvocation();
                    return result;
                },
                audit: audit === null ? null : async (event, grant, context) => {
                    const result = await audit(event, grant, nativeSignupContext(context.signal));
                    nativeAdminInvocation();
                    return result;
                }
            }));
            dashboardAdminRequestBudgetMs = dashboardAdminService
                ? Math.max(dashboardAdminRequestBudgetMs, port.requestBudgetMs) : port.requestBudgetMs;
        }
        if (keys.includes('customerSignup') && configuration.customerSignup !== null) {
            customerSignup = createCustomerSignupRuntime(configuration.customerSignup);
        }
        if (keys.includes('externalCustomerSignup') && configuration.externalCustomerSignup !== null) {
            if (!dashboard?.authServices.externalCustomer) throw new Error();
            externalCustomerSignup = createCustomerSignupRuntime(configuration.externalCustomerSignup);
        }
        if (configuration.customerEntry && !externalCustomerSignup) throw new Error();
        if (keys.includes('retainedTrialRead')) {
            if (!externalCustomerSignup || !dashboard?.authServices.externalCustomer) throw new Error();
            const port = fields(configuration.retainedTrialRead, ['beginLogin', 'completeLogin', 'read', 'logout']);
            if (Object.values(port).some(value => typeof value !== 'function' || isProxy(value))) throw new Error();
            retainedTrialRead = Object.freeze({ ...port });
        }
    } catch (_) { throw new BrowserAuthError(503, 'browser_auth_dashboard_unavailable'); }
    const apiEnvironment = authEnvironment || process.env;
    const dashboardAdmin = createDashboardAdminHandlers({ service: dashboardAdminService,
        signupListService: dashboardAdminSignupListService,
        readOperatorSession: dashboard ? cookie => dashboard.authServices.session.readSessionDetails(cookie) : null,
        env: apiEnvironment, requestBudgetMs: dashboardAdminRequestBudgetMs });

const app = express();
app.disable('x-powered-by');
const scopeAccessService = createScopeAccessService();
const authLoginFunction = createAuthLoginFunction(dashboard ? { env: authEnvironment, service: dashboard.authServices.login } : {});
const authCallbackFunction = createAuthCallbackFunction(dashboard ? { env: authEnvironment, service: dashboard.authServices.callback } : {});
const authLogoutFunction = createAuthLogoutFunction(dashboard ? { env: authEnvironment, service: dashboard.authServices.logout } : {});
const authSessionFunction = createAuthSessionFunction(dashboard ? { env: authEnvironment, service: dashboard.authServices.session } : {});
const publicContentSecurityPolicy = "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data:; script-src 'self'; script-src-attr 'none'; style-src 'self'; style-src-attr 'none'; connect-src 'self'; upgrade-insecure-requests";
const privateContentSecurityPolicy = "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data:; script-src 'self'; script-src-attr 'none'; style-src 'self'; style-src-attr 'none'; connect-src 'self'; upgrade-insecure-requests";
const securityHeaders = {
    'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
    'Content-Security-Policy': publicContentSecurityPolicy,
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'X-XSS-Protection': '0',
    'X-Permitted-Cross-Domain-Policies': 'none',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'accelerometer=(), autoplay=(), camera=(), display-capture=(), encrypted-media=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), midi=(), payment=(), picture-in-picture=(), usb=(), xr-spatial-tracking=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Origin-Agent-Cluster': '?1'
};
const scopingDocument = buildScopingDocument({
    template: fs.readFileSync(path.join(__dirname, 'app', 'mssp.html'), 'utf8'),
    loaderSource: fs.readFileSync(path.join(__dirname, 'js', 'app-loader.js'), 'utf8'),
    copySource: fs.readFileSync(path.join(__dirname, 'js', 'scoping-copy.js'), 'utf8')
});
const supportDocument = buildSupportDocument({
    template: fs.readFileSync(path.join(__dirname, 'app', 'support.html'), 'utf8'),
    loaderSource: fs.readFileSync(path.join(__dirname, 'js', 'support-loader.js'), 'utf8')
});
const portalDocument = buildPortalDocument({
    template: fs.readFileSync(path.join(__dirname, 'app', 'portal.html'), 'utf8'),
    loaderSource: fs.readFileSync(path.join(__dirname, 'js', 'portal-loader.js'), 'utf8')
});
const dashboardInputs = {
    customerLogin: true,
    template: fs.readFileSync(path.join(__dirname, 'app', 'dashboard.html'), 'utf8'),
    loaderSource: fs.readFileSync(path.join(__dirname, 'js', 'dashboard-loader.js'), 'utf8'),
    protectedAppSource: ['dashboardRegistry.js', 'dashboardShell.js', 'ncscAssessmentClient.js', 'ncscQuestionnaire.js', 'assessmentExplanation.js', 'organisationPicture.js', 'improvementActionPlanView.js', 'improvementActionPlanClient.js']
        .map(file => fs.readFileSync(path.join(__dirname, 'api', 'shared', 'protectedAssets', file), 'utf8')).join('\n'),
    protectedStyleSource: fs.readFileSync(path.join(__dirname, 'app', 'dashboard.css'), 'utf8')
};
const dashboardDocument = buildDashboardDocument(dashboardInputs);
const externalDashboardDocument = buildDashboardDocument({ ...dashboardInputs, customerTransport: 'external' });
const gatewayInputs = {
    customerLogin: true,
    template: fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8'),
    loaderSource: fs.readFileSync(path.join(__dirname, 'js', 'dashboard-loader.js'), 'utf8'),
    protectedAppSource: ['dashboardRegistry.js', 'dashboardShell.js', 'ncscAssessmentClient.js', 'ncscQuestionnaire.js', 'assessmentExplanation.js', 'organisationPicture.js', 'improvementActionPlanView.js', 'improvementActionPlanClient.js']
        .map(file => fs.readFileSync(path.join(__dirname, 'api', 'shared', 'protectedAssets', file), 'utf8')).join('\n'),
    protectedStyleSource: fs.readFileSync(path.join(__dirname, 'app', 'dashboard.css'), 'utf8')
};
const gatewayDocument = buildGatewayDocument(gatewayInputs);
const externalGatewayDocument = buildGatewayDocument({ ...gatewayInputs, customerTransport: 'external' });
const signupAssistantSources = Object.freeze({
    prospectSource: fs.readFileSync(path.join(__dirname, 'js/prospect-assistant.js'), 'utf8'),
    sharedSource: fs.readFileSync(path.join(__dirname, 'js/shared-assistant.js'), 'utf8')
});
const signupDocument = withHashBoundSharedAssistantDocument(buildSignupDocument({
    clientSource: fs.readFileSync(path.join(__dirname, 'api/shared/customerSignup/signupClient.js'), 'utf8'),
    journeySource: fs.readFileSync(path.join(__dirname, 'api/shared/customerSignup/signupJourney.js'), 'utf8'),
    customerLogin: !!dashboard?.authServices.customer
}), signupAssistantSources);
const externalSignupDocument = externalCustomerSignup ? withHashBoundSharedAssistantDocument(buildSignupDocument({
    clientSource: fs.readFileSync(path.join(__dirname, 'api/shared/customerSignup/signupClient.js'), 'utf8'),
    journeySource: fs.readFileSync(path.join(__dirname, 'api/shared/customerSignup/signupJourney.js'), 'utf8'),
    customerLogin: true, customerTransport: 'external'
}), signupAssistantSources) : null;
function signupSelection(req, res) {
    const cookie = req.headers.cookie || '';
    const legacy = /(?:^|;)\s*__Host-nofries-customer=/.test(cookie);
    const external = /(?:^|;)\s*__Host-nofries-external-customer=/.test(cookie);
    if (legacy && external) { res.status(401).send('Sign-in is ambiguous. Return to your original sign-in page.'); return null; }
    if (req.query.provider !== undefined && !['legacy', 'external'].includes(req.query.provider)) {
        res.status(400).send('Invalid sign-in entry.'); return null;
    }
    return req.query.provider === 'external' || req.query.provider === undefined && (external || !legacy &&
        (configuration.customerEntry === 'external' && !['/signup', '/signup/'].includes(req.path) || !customerSignup && externalCustomerSignup))
        ? { document: externalSignupDocument, runtime: externalCustomerSignup, external: true }
        : { document: signupDocument, runtime: customerSignup, external: false };
}
function sendSignupPage(res, selected) {
    if (selected.document) res.setHeader('Content-Security-Policy', selected.document.contentSecurityPolicy);
    return res.status(selected.runtime ? 200 : 503).type('html').send(selected.runtime
        ? selected.document.html : buildSignupUnavailableDocument());
}

app.set('trust proxy', 1);
app.set('case sensitive routing', true);
app.use(applySecurityHeaders);
app.use(blockSuspiciousUserAgents);
app.use(['/scope.html', '/support', '/support/', '/portal', '/portal/', '/operator', '/operator/', '/dashboard', '/dashboard/', '/dashboard-admin', '/dashboard-admin/'], applyPrivateDocumentHeaders);

// Keep the standalone server and Azure Function entry points on the same
// browser-auth implementation. These routes intentionally run before the
// generic API middleware because their Function handlers apply their own
// method-specific abuse controls and response headers.
// One public customer entry. Staff access remains at /operator.
app.get('/api/dashboard/login', (_req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.redirect(303, '/login');
});
app.get('/login', (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    if (req.query.reauthenticate !== undefined && req.query.reauthenticate !== '1') {
        return res.status(400).send('Invalid sign-in entry.');
    }
    const selected = signupSelection(req, res); if (!selected) return;
    if (req.query.reauthenticate === '1') {
        const customerAuth = dashboard?.authServices[selected.external ? 'externalCustomer' : 'customer'];
        if (!selected.runtime || !customerAuth) return sendSignupPage(res, { ...selected, runtime: null });
        // A fresh client proof needs a new auth transaction, even if the current
        // dashboard SID is still valid. Keep provider selection/ambiguity here;
        // the existing auth endpoint owns identity and one-use transactions.
        return res.redirect(303, selected.external ? '/api/external-customer-auth/login' : '/api/customer-auth/login');
    }
    if (selected.external) {
        if (!configuration.externalOrganisationSetup) return sendSignupPage(res, selected);
        const html = withCustomerProvider(fs.readFileSync(path.join(__dirname, 'login.html'), 'utf8'), 'external')
            .replaceAll('href="/api/customer-auth/login"', 'href="/api/external-customer-auth/login"');
        return res.type('html').send(withSharedAssistantDocument(html));
    }
    // Legacy deployments may allow customer sign-in while new email setup is
    // disabled. Reuse the authenticated signup-state document, whose explicit
    // sign-in button starts customer OIDC, without calling a missing setup API
    // or creating an automatic redirect loop after a provider failure.
    if (!configuration.organisationSetup && dashboard?.authServices.customer && customerSignup) {
        res.setHeader('Content-Security-Policy', signupDocument.contentSecurityPolicy);
        return res.type('html').send(signupDocument.html);
    }
    res.type('html').send(withSharedAssistantDocument(fs.readFileSync(path.join(__dirname, 'login.html'), 'utf8')));
});
for (const [key, route, clearTransactionCookie] of [
    ['customer', '/api/customer-auth', require('./api/shared/browserAuth').clearCustomerTransactionCookie],
    ['externalCustomer', '/api/external-customer-auth', require('./api/shared/browserAuth').clearExternalCustomerTransactionCookie]
]) {
    const customerAuth = dashboard?.authServices[key];
    if (!customerAuth) continue;
    app.get(route + '/login', asyncRoute(async (req, res) => {
        // The bootstrap cookie is passed only to the trusted customer policy.
        const login = createAuthLoginFunction({ env: authEnvironment, customerEntry: true,
            ...(key === 'externalCustomer' ? { customerTransport: 'external' } : {}), service: {
            async beginLogin(input) {
                const result = await customerAuth.login.beginLogin({ ...input, cookieHeader: req.headers.cookie || '' });
                return key === 'externalCustomer' && retainedTrialRead ? { ...result,
                    cookie: [...(Array.isArray(result.cookie) ? result.cookie : [result.cookie]), clearRetainedReadTransactionCookie()] } : result;
            }
        } });
        await sendFunctionResponse(login, req, res);
    }));
    app.post(route + '/callback', express.urlencoded({ extended: false, limit: '16kb' }), asyncRoute(async (req, res) => {
        let retained = false;
        const callback = createAuthCallbackFunction({ env: authEnvironment, customerEntry: true,
            ...(key === 'externalCustomer' ? { customerTransport: 'external' } : {}),
            clearTransactionCookie: () => retained ? clearRetainedReadTransactionCookie() : clearTransactionCookie(),
            service: { completeLogin(input) {
                if (key === 'externalCustomer' && retainedTrialRead) retained = externalCustomerCallbackPurpose(input.cookieHeader) === 'retained_read';
                return retained ? retainedTrialRead.completeLogin(input) : customerAuth.callback.completeLogin(input);
            } } });
        await sendFunctionResponse(callback, req, res);
    }));
    if (key === 'externalCustomer') {
        const setupLogout = createAuthLogoutFunction({ env: authEnvironment, service: customerAuth.setupLogout, setupAccountChange: true });
        app.post(route + '/logout', express.urlencoded({ extended: false, limit: '16kb' }), asyncRoute(async (req, res) => {
            await sendFunctionResponse(setupLogout, req, res);
        }));
    }
}
app.get('/api/auth/login', asyncRoute(async (req, res) => {
    await sendFunctionResponse(authLoginFunction, req, res);
}));
app.post('/api/auth/callback', express.urlencoded({ extended: false, limit: '16kb' }), asyncRoute(async (req, res) => {
    await sendFunctionResponse(authCallbackFunction, req, res);
}));
app.post('/api/auth/logout', express.urlencoded({ extended: false, limit: '16kb' }), asyncRoute(async (req, res) => {
    await sendFunctionResponse(authLogoutFunction, req, res);
}));
app.get('/api/auth/session', asyncRoute(async (req, res) => {
    await sendFunctionResponse(authSessionFunction, req, res);
}));

app.get('/api/health', asyncRoute(async (req, res) => {
    await sendFunctionResponse(healthFunction, req, res);
}));

app.get('/release.json', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.sendFile(path.join(__dirname, 'api', 'shared', 'releaseManifest.json'));
});

// This namespace owns its limiter and parser before generic per-address limiting.
const websiteAnalytics = require('./api/shared/websiteAnalyticsRuntime').createRuntime({ env: apiEnvironment,
    identityStore: configuration.dashboard?.browserAuthOptions?.store });
app.use('/api/website-analytics', applyApiSecurityHeaders, applyPrivateHeaders,
    express.raw({ type: () => true, limit: '512b' }), asyncRoute(async (req, res) => {
        const result = await websiteAnalytics(req, req.path);
        Object.entries(result.headers).forEach(([key, value]) => res.setHeader(key, value));
        return result.status === 204 ? res.status(204).end() : res.status(result.status).json(result.body);
    }));

app.use('/api', applyApiSecurityHeaders, applyPrivateHeaders, rateLimitApiRequests);
// These exact protected routes own their bounded wire parsing before the
// application's general JSON parser. There is no production composition.
async function sendDashboardAdmin(req, res, route) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    // IncomingMessage.aborted can remain false after a complete POST body.
    // An unfinished response closing must also stop source/audit continuation.
    const responseClosed = () => { if (!res.writableEnded) abort(); };
    req.once('aborted', abort); res.once('close', responseClosed);
    if (req.aborted || res.destroyed) abort();
    try {
        const result = await dashboardAdminRequests.run(Object.freeze({ request: req, signal: controller.signal }),
            () => dashboardAdmin.handle(req, route));
        if (!controller.signal.aborted && !res.destroyed && !res.writableEnded) {
            const customerCookie = /(?:^|;)\s*__Host-nofries-(?:external-customer|customer|retained-read)=/.test(String(req.headers.cookie || ''));
            if (['document', 'entry'].includes(route) && result.status === 401 && !customerCookie) {
                await sendFunctionResponse(authLoginFunction, {
                    method: 'GET', headers: req.headers, query: { returnTo: '/dashboard-admin/entry' }
                }, res);
            } else sendResult(res, result);
        }
    } finally {
        controller.abort();
        req.removeListener('aborted', abort); res.removeListener('close', responseClosed);
    }
}
    // SWA forwards linked App Service requests only under /api. Keep these
    // exact GET aliases on the same private handlers as the browser routes.
    // Express GET routes also match HEAD; never start sign-in for that method.
    app.get('/api/dashboard-admin', asyncRoute(async (req, res, next) => {
        if (req.method !== 'GET' || req.path !== '/api/dashboard-admin') return next();
        await sendDashboardAdmin(req, res, 'document');
    }));
    app.get('/api/dashboard-admin/entry', asyncRoute(async (req, res, next) => {
        if (req.method !== 'GET' || req.path !== '/api/dashboard-admin/entry') return next();
        await sendDashboardAdmin(req, res, 'entry');
    }));
    app.use('/api/dashboard-admin', asyncRoute(async (req, res) => {
    const route = /^\/(?:app\.js|app\.css|capabilities|lookup|entry\.js|entry-capabilities)$/.test(req.path) ||
        dashboardAdminSignupListService && req.path === '/signups' ? req.path.slice(1) : null;
    await sendDashboardAdmin(req, res, route);
}));
app.all(['/dashboard-admin', '/dashboard-admin/'], asyncRoute(async (req, res) => {
    await sendDashboardAdmin(req, res, 'document');
}));
app.all('/dashboard-admin/entry', asyncRoute(async (req, res) => {
    await sendDashboardAdmin(req, res, req.path === '/dashboard-admin/entry' ? 'entry' : null);
}));
if (retainedTrialRead) {
    function retainedSelection(req) {
        try {
            const query = { ...req.query };
            if (Object.hasOwn(query, 'signin')) {
                if (query.signin !== '1') throw new Error('retained_read_input_invalid');
                delete query.signin;
            }
            return normaliseRetainedTrialReadSelection(query);
        } catch (_) { throw new BrowserAuthError(400, 'retained_read_input_invalid'); }
    }
    app.get('/api/retained-results', applyPrivateDocumentHeaders, asyncRoute(async (req, res) => {
        let selection = null;
        res.setHeader('Content-Security-Policy', retainedReadContentSecurityPolicy);
        if (req.method !== 'GET') return res.status(405).set('Allow', 'GET').end();
        try {
            selection = retainedSelection(req);
            if (Object.hasOwn(req.query, 'signin')) {
                const login = createAuthLoginFunction({ env: authEnvironment, customerEntry: true, customerTransport: 'external', service: {
                    beginLogin() { return retainedTrialRead.beginLogin({ returnTo: retainedResultPath(selection), cookieHeader: req.headers.cookie || '' }); }
                } });
                return await sendFunctionResponse(login, req, res);
            }
            const result = await retainedTrialRead.read(req, selection);
            return res.type('html').send(buildRetainedTrialReadDocument({ selection, result, status: 'result' }));
        } catch (error) {
            const status = [400, 401, 403, 404].includes(error?.statusCode) ? error.statusCode : 503;
            return res.status(status).type('html').send(buildRetainedTrialReadDocument({ selection,
                status: status === 401 ? 'signin' : 'unavailable' }));
        }
    }));
    const retainedBodyOptions = { limit: '16kb', verify(req, _res, bytes) { req.retainedReadBodyPresent = bytes.length > 0; } };
    app.post('/api/retained-results', express.json(retainedBodyOptions), express.urlencoded({ ...retainedBodyOptions, extended: false }), asyncRoute(async (req, res) => {
        // Only the empty native sign-out form is accepted. No request field can
        // turn this exact endpoint into an assessment command or redirect.
        if (Object.keys(req.query).length || req.retainedReadBodyPresent || Object.keys(req.body || {}).length ||
            Number(req.headers['content-length'] || 0) > 0 || req.headers['transfer-encoding'] ||
            req.headers['content-type'] && !req.is(['application/json', 'application/x-www-form-urlencoded'])) {
            return res.status(400).json({ error: 'Invalid saved-result request', code: 'retained_read_input_invalid' });
        }
        const logout = createAuthLogoutFunction({ env: authEnvironment, service: { logout: () => retainedTrialRead.logout(req) } });
        await sendFunctionResponse(logout, req, res);
    }));
}
if (dashboard) app.use('/api/dashboard', asyncRoute(async (req, res) => {
    const result = await dashboard.handleRequest(req);
    if (!res.destroyed && !res.writableEnded) sendResult(res, result);
}));
for (const [prefix, setup, customerAuth, signup] of [
    ['/api/organisation-setup', configuration.organisationSetup, dashboard?.authServices.customer, customerSignup],
    ['/api/external-organisation-setup', configuration.externalOrganisationSetup, dashboard?.authServices.externalCustomer, externalCustomerSignup]
]) app.all(prefix + '/:action', express.json({ limit: '8kb' }), asyncRoute(async (req, res) => {
    const stateRead = req.method === 'GET' && req.path === prefix + '/state' &&
        !Object.keys(req.query).length && !Object.keys(req.body || {}).length;
    const automaticEntry = prefix === '/api/organisation-setup' && stateRead &&
        req.headers['x-nofries-customer-entry'] === 'auto';
    // Returning legacy sign-in remains independent of setup or entry-choice
    // failures. This capability never authorizes automatic navigation or POST.
    if (stateRead && customerAuth && signup) {
        res.setHeader('X-NoFries-Customer-Sign-In', 'available');
    }
    let entry;
    if (automaticEntry) {
        // This fixed UI choice is not identity proof. Keep HttpOnly cookie
        // precedence on the server, including the existing ambiguity denial.
        const cookie = req.headers.cookie || '';
        const legacyCustomer = /(?:^|;)\s*__Host-nofries-customer=/.test(cookie);
        const externalCustomer = /(?:^|;)\s*__Host-nofries-external-customer=/.test(cookie);
        // Keep the existing selector's ambiguity rejection, with the state
        // API's stable JSON error contract rather than an HTML document error.
        if (legacyCustomer && externalCustomer) return res.status(401).json({ code: 'setup_unavailable' });
        const selected = signupSelection(req, res); if (!selected) return;
        const { COOKIE, cookieToken } = require('./api/shared/organisationSetup');
        const setupCookies = cookie.split(';').filter(part => part.trim().split('=')[0].trim() === COOKIE);
        if (setupCookies.length > 1 || setupCookies.length === 1 && !cookieToken(cookie)) {
            return res.status(503).json({ code: 'setup_unavailable' });
        }
        const externalAvailable = configuration.customerEntry === 'external' &&
            dashboard?.authServices.externalCustomer && externalCustomerSignup;
        if (externalCustomer && !externalAvailable) return res.status(503).json({ code: 'setup_unavailable' });
        entry = { external: !!externalAvailable && selected.external, legacyCustomer, externalCustomer,
            setupPresent: setupCookies.length === 1 };
    }
    function entryResponse(result) {
        if (automaticEntry && result.status === 200 &&
            ['start', 'sign_in', 'awaiting_code', 'verified'].includes(result.body?.state)) {
            const continuation = !['start', 'sign_in'].includes(result.body.state);
            const external = entry.external && !entry.legacyCustomer &&
                (entry.externalCustomer || !continuation);
            res.setHeader('X-NoFries-Customer-Entry', external ? 'external' : 'legacy');
        }
        sendResult(res, result);
    }
    // Provider selection is only a presentation choice. An existing external
    // cookie must not depend on the unrelated legacy setup store; the external
    // signup/auth services still validate its session and admission themselves.
    if (automaticEntry && entry.externalCustomer) {
        return entryResponse({ status: 200, body: { state: 'sign_in' } });
    }
    if (!setup || typeof setup.handle !== 'function') {
        // A valid setup cookie may still refer to resumable legacy progress.
        // Without its reader, no customer-cookie choice means unresolved.
        if (automaticEntry && entry.setupPresent && !entry.legacyCustomer && !entry.externalCustomer) {
            return res.status(503).json({ code: 'setup_unavailable' });
        }
        // SWA serves /login.html directly. Its client needs the same explicit
        // capability fallback as the Express document; do not infer it from a
        // transient setup/storage error or enable any setup mutations.
        if (stateRead && (customerAuth && signup || automaticEntry && entry.external && !entry.legacyCustomer)) {
            // The marked public entry may select a composed external-only
            // runtime. Unmarked/explicit legacy requests keep their old gate.
            return entryResponse({ status: 200, body: { state: 'sign_in' } });
        }
        return res.status(503).json({ code: 'setup_unavailable' });
    }
    const result = await setup.handle({ method: req.method, path: req.path.replace(prefix, '/api/organisation-setup'),
        originalUrl: req.originalUrl.replace(prefix, '/api/organisation-setup'), headers: req.headers, body: req.body,
        clientKey: getClientKeyFromHeaders(req.headers, req.ip) });
    entryResponse(result);
}));
app.use(express.json({ limit: '3mb' }));
if (configuration.signupBootstrap) {
    if (typeof configuration.signupBootstrap !== 'function') throw new Error('signup_bootstrap_invalid');
    app.post('/api/customer-signup/bootstrap', asyncRoute(async (req, res) => {
        if (requestBodySize(req) > 1024) return res.status(413).json({ code: 'signup_request_invalid' });
        try { sendResult(res, await configuration.signupBootstrap(req)); }
        catch (_) { res.status(403).json({ code: 'signup_bootstrap_invalid' }); }
    }));
}


for (const [runtime, prefix] of [[customerSignup, '/api/customer-signup'], [externalCustomerSignup, '/api/external-customer-signup']]) {
    if (!runtime) continue;
    app.all([prefix + '/state', prefix + '/terms', prefix + '/setup'], asyncRoute(async (req, res) => {
        if (!signupSelection(req, res)) return;
        const route = req.path.slice(prefix.length + 1);
        sendResult(res, await withSignupSupportContext(async () => {
            try { return await runtime.handle(req, route); }
            catch (error) { return customerSignupErrorResponse(error); }
        }));
    }));
}

if (configuration.starterClients || configuration.externalStarterClients) app.all('/api/customer-signup/clients', asyncRoute(async (req, res) => {
    const selected = signupSelection(req, res); if (!selected) return;
    const clients = selected.external ? configuration.externalStarterClients : configuration.starterClients;
    try { if (!clients) throw new Error('starter_signup_unavailable'); sendResult(res, await clients(req)); }
    catch (error) {
        if (['starter_reauthentication_required', 'signup_identity_required'].includes(error?.code || error?.message)) {
            return res.status(401).set('Cache-Control', 'no-store').json({ code: 'starter_reauthentication_required' });
        }
        const code = ['starter_client_limit', 'starter_details_locked'].includes(error?.code || error?.message)
            ? error.code || error.message : 'starter_signup_unavailable';
        res.status(code === 'starter_signup_unavailable' ? 503 : 409).set('Cache-Control', 'no-store').json({ code });
    }
}));

app.post('/api/scope/request', asyncRoute(async (req, res) => {
    try {
        if (requestBodySize(req) > 16 * 1024) {
            return res.status(413).json({ error: 'Request body is too large', code: 'request_too_large' });
        }
        assertSameOriginForMutation(req);
        const result = await scopeAccessService.requestAccess({
            email: req.body && req.body.email,
            website: req.body && req.body.website,
            ip: getClientKeyFromHeaders(req.headers, req.ip || req.socket.remoteAddress)
        });
        res.status(200).json(result);
    } catch (error) {
        sendScopeError(res, error);
    }
}));

app.post('/api/scope/verify', asyncRoute(async (req, res) => {
    try {
        if (requestBodySize(req) > 16 * 1024) {
            return res.status(413).json({ error: 'Request body is too large', code: 'request_too_large' });
        }
        assertSameOriginForMutation(req);
        const result = await scopeAccessService.verifyAccess({
            challengeId: req.body && req.body.challengeId,
            code: req.body && req.body.code
        });
        res.setHeader('Set-Cookie', result.cookie);
        res.status(200).json({ verified: true, emailHint: result.emailHint });
    } catch (error) {
        sendScopeError(res, error);
    }
}));

app.get('/api/scope/verify', asyncRoute(async (req, res) => {
    try {
        const result = await scopeAccessService.verifyAccess({
            challengeId: req.query && req.query.id,
            linkToken: req.query && req.query.token
        });
        res.setHeader('Set-Cookie', result.cookie);
        res.redirect(302, '/scope.html');
    } catch (error) {
        res.setHeader('Set-Cookie', clearAccessCookie());
        res.redirect(302, `/scope.html?error=${encodeURIComponent(error.code || 'verification')}`);
    }
}));

app.get('/api/scope/content', (req, res) => {
    try {
        const viewer = scopeAccessService.authorize({
            cookie: req.get('cookie'),
            authorization: req.get('authorization')
        });
        res.status(200).json({
            viewer: { emailHint: viewer.emailHint, expiresAt: viewer.expiresAt },
            scope: getServiceScope()
        });
    } catch (error) {
        res.setHeader('Set-Cookie', clearAccessCookie());
        sendScopeError(res, error);
    }
});

app.get('/api/prospect/session', asyncRoute(async (req, res) => {
    let result;
    try {
        result = await handleProspectSessionRequest(req);
    } catch (error) {
        result = prospectErrorResponse(error, console);
    }
    sendResult(res, result);
}));

app.post('/api/prospect/chat', asyncRoute(async (req, res) => {
    let streamStarted = false;
    try {
        const result = await handleProspectChatRequest(req, {
            onHeaders(headers) {
                Object.entries(headers || {}).forEach(([name, value]) => res.setHeader(name, value));
                res.status(200);
                if (typeof res.flushHeaders === 'function') res.flushHeaders();
                streamStarted = true;
            },
            onEvent(frame) {
                res.write(frame);
            }
        });
        if (streamStarted) {
            res.end();
            return;
        }
        sendResult(res, result);
    } catch (error) {
        const result = prospectErrorResponse(error, console);
        if (streamStarted || res.headersSent) {
            res.write(`event: error\ndata: ${JSON.stringify(result.body)}\n\n`);
            res.end();
            return;
        }
        sendResult(res, result);
    }
}));

app.all(['/api/lifecycle', '/api/lifecycle/*'], asyncRoute(async (req, res) => {
    let result;
    try {
        result = await handleLifecycleRequest(req, {
            path: req.params && req.params[0] || ''
        });
    } catch (error) {
        result = lifecycleErrorResponse(error, console);
    }
    sendResult(res, result);
}));

app.all(['/api/service-desk', '/api/service-desk/*'], asyncRoute(async (req, res) => {
    let result;
    try {
        result = await handleServiceDeskRequest(req, {
            path: req.params && req.params[0] || ''
        });
    } catch (error) {
        result = serviceDeskErrorResponse(error, console);
    }
    sendResult(res, result);
}));

app.all(['/api/customer-portal', '/api/customer-portal/*'], asyncRoute(async (req, res) => {
    let result;
    try {
        result = await handleCustomerPortalRequest(req, {
            path: req.params && req.params[0] || ''
        });
    } catch (error) {
        result = customerPortalErrorResponse(error, console);
    }
    sendResult(res, result);
}));

app.all(['/api/datto-rmm', '/api/datto-rmm/*'], asyncRoute(async (req, res) => {
    let result;
    try {
        result = await handleDattoRmmRequest(req, {
            path: req.params && req.params[0] || ''
        });
    } catch (error) {
        result = dattoRmmErrorResponse(error, console);
    }
    sendResult(res, result);
}));

app.all(['/api/sales', '/api/sales/*'], asyncRoute(async (req, res) => {
    let result;
    try {
        result = await handleSalesRequest(req, {
            path: req.params && req.params[0] || ''
        });
    } catch (error) {
        result = errorResponse(error, console);
    }
    sendResult(res, result);
}));

app.post('/api/mcp', asyncRoute(async (req, res) => {
    sendResult(res, await handleMcpRequest(req, { lifecycle: getAppLifecycleService() }));
}));

app.get([
    '/api/mcp-auth',
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-protected-resource/api/mcp'
], (req, res) => {
    sendResult(res, handleMcpAuthMetadataRequest(req));
});

app.get(['/.well-known/oauth-authorization-server', '/api/mcp-oauth-metadata'], (req, res) => {
    sendResult(res, handleMcpOauthMetadataRequest(req));
});

app.get('/api/mcp-oauth-authorize', (req, res) => {
    sendResult(res, handleMcpOauthAuthorizeRequest(req));
});

app.post('/api/mcp-oauth-token', express.urlencoded({ extended: false, limit: '32kb' }), asyncRoute(async (req, res) => {
    sendResult(res, await handleMcpOauthTokenRequest(req));
}));

app.all('/api/billing/*', (req, res) => {
    res.status(410).json({
        error: 'Public subscription billing is disabled for the tenant pilot',
        code: 'billing_disabled'
    });
});

app.all('/api/*', (req, res) => {
    res.status(410).json({
        error: 'This legacy API route has been retired',
        code: 'legacy_workspace_retired'
    });
});

app.get(['/scoping', '/scoping/'], (req, res) => {
    res.setHeader('Content-Security-Policy', scopingDocument.contentSecurityPolicy);
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.status(200).type('html').send(withSharedAssistantDocument(scopingDocument.html));
});

app.get(['/support', '/support/'], (req, res) => {
    res.setHeader('Content-Security-Policy', supportDocument.contentSecurityPolicy);
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.status(200).type('html').send(withSharedAssistantDocument(supportDocument.html));
});

app.get(['/portal', '/portal/'], (req, res) => {
    res.setHeader('Content-Security-Policy', portalDocument.contentSecurityPolicy);
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.status(200).type('html').send(withSharedAssistantDocument(portalDocument.html));
});

app.get(['/dashboard', '/dashboard/'], (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    const selected = signupSelection(req, res); if (!selected) return;
    const document = selected.external ? externalDashboardDocument : dashboardDocument;
    res.setHeader('Content-Security-Policy', document.contentSecurityPolicy);
    res.status(200).type('html').send(withSharedAssistantDocument(document.html));
});

app.get(['/signup', '/signup/'], (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    const selected = signupSelection(req, res); if (selected) sendSignupPage(res, selected);
});

app.get(['/operator', '/operator/'], (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.type('html').send(withSharedAssistantDocument(fs.readFileSync(path.join(__dirname, 'app', 'operator.html'), 'utf8')));
});

app.get(['/service-desk', '/service-desk/'], (req, res) => {
    res.redirect(302, '/support');
});

app.get(['/mssp', '/mssp/', '/workspace', '/workspace/', '/app', '/app/', '/app/mssp.html', '/legacy-cyber-check', '/legacy-cyber-check/', '/free-check'], (req, res) => {
    res.redirect(302, '/scoping');
});

app.get(['/sample-report.html', '/share', '/share/*', '/share.html', '/about.html', '/About.html'], (req, res) => {
    res.redirect(302, '/');
});

app.get(['/founder', '/founder/', '/founder.html'], (req, res) => {
    res.redirect(302, '/scoping');
});

app.get(['/CloudPC.html', '/NoFries.html'], (req, res) => {
    res.redirect(301, '/scoping');
});

app.use('/app', (req, res) => {
    res.status(404).type('text/plain').send('Not found');
});

app.get([
    '/js/analytics.js',
    '/js/config.js',
    '/js/founder.js',
    '/js/lead-form.js',
    '/js/app-loader.js',
    '/js/portal-loader.js',
    '/js/dashboard-loader.js',
    '/js/support-loader.js',
    '/js/paywall.js',
    '/js/scoping-copy.js',
    '/js/share.js',
    '/js/site.js'
], (req, res) => {
    res.status(404).type('text/plain').send('Not found');
});

app.get('/index.html', (_req, res) => res.redirect(308, '/'));
app.get('/', (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    const selected = signupSelection(req, res); if (!selected) return;
    const document = selected.external ? externalGatewayDocument : gatewayDocument;
    res.setHeader('Content-Security-Policy', document.contentSecurityPolicy);
    res.status(200).type('html').send(withSharedAssistantDocument(document.html, 'home'));
});
mountPublicAssets(app);

app.use((req, res) => {
    res.status(404).type('html').send(withSharedAssistantDocument(fs.readFileSync(path.join(__dirname, '404.html'), 'utf8')));
});

app.use((error, req, res, next) => {
    if (req.path.startsWith('/api/')) {
        if (error && (error.type === 'entity.too.large' || error.status === 413)) {
            return res.status(413).json({ error: 'Request body is too large', code: 'request_too_large' });
        }
        if (error && (error.type === 'entity.parse.failed' || error instanceof SyntaxError)) {
            return res.status(400).json({ error: 'Request body must contain valid JSON', code: 'invalid_json' });
        }
        return res.status(500).json({ error: 'No Fries could not complete that request' });
    }
    return res.status(500).type('html').send(withSharedAssistantDocument(fs.readFileSync(path.join(__dirname, 'error.html'), 'utf8')));
});


function asyncRoute(handler) {
    return (req, res, next) => {
        Promise.resolve(handler(req, res, next)).catch(next);
    };
}

function applySecurityHeaders(req, res, next) {
    Object.entries(securityHeaders).forEach(([name, value]) => res.setHeader(name, value));
    next();
}

function applyPrivateDocumentHeaders(req, res, next) {
    res.setHeader('Content-Security-Policy', privateContentSecurityPolicy);
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    next();
}

function applyApiSecurityHeaders(req, res, next) {
    Object.entries(API_SECURITY_HEADERS).forEach(([name, value]) => res.setHeader(name, value));
    next();
}

function blockSuspiciousUserAgents(req, res, next) {
    if (!isBlockedUserAgent(req.get('user-agent'), apiEnvironment)) {
        return next();
    }
    if (req.path.startsWith('/api/')) {
        return res.status(403).json({ error: 'Request blocked' });
    }
    return res.status(403).type('text/plain').send('Request blocked');
}

function rateLimitApiRequests(req, res, next) {
    const method = String(req.method || 'GET').toUpperCase();
    const bucket = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ? 'apiWrite' : 'apiRead';
    const clientKey = getClientKeyFromHeaders(req.headers, req.ip || req.socket.remoteAddress);
    const result = checkRateLimit(bucket, clientKey, apiEnvironment);
    Object.entries(rateLimitHeaders(result)).forEach(([name, value]) => {
        if (value) {
            res.setHeader(name, value);
        }
    });
    if (!result.allowed) {
        return res.status(429).json({ error: 'Too many requests. Please try again later.' });
    }
    return next();
}

function applyPrivateHeaders(req, res, next) {
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    next();
}

function sendResult(res, result) {
    Object.entries(result.headers || {}).forEach(([name, value]) => res.setHeader(name, value));
    if (result.isRaw) {
        res.status(result.status).send(result.body);
        return;
    }
    res.status(result.status).json(result.body);
}

async function sendFunctionResponse(handler, req, res) {
    const context = { log: console };
    await handler(context, req);
    const result = context.res;
    if (!result || !Number.isInteger(result.status)) {
        throw new Error('The function handler did not return a valid response');
    }
    Object.entries(result.headers || {}).forEach(([name, value]) => res.setHeader(name, value));
    if (result.body === '' || result.body == null) {
        res.status(result.status).send();
        return;
    }
    if (typeof result.body === 'object' && !Buffer.isBuffer(result.body)) {
        res.status(result.status).json(result.body);
        return;
    }
    res.status(result.status).send(result.body);
}

function mountPublicAssets(application) {
    const rootRoutes = PUBLIC_ROOT_FILES
        .filter((fileName) => fileName !== '.well-known/security.txt')
        .map((fileName) => [`/${fileName}`, fileName]);
    rootRoutes.push(['/', 'index.html']);
    rootRoutes.forEach(([route, fileName]) => {
        application.get(route, (req, res) => {
            if (fileName.endsWith('.html')) {
                return res.type('html').send(withSharedAssistantDocument(fs.readFileSync(path.join(__dirname, fileName), 'utf8'), publicAssistantPage(fileName)));
            }
            res.sendFile(path.join(__dirname, fileName));
        });
    });

    PUBLIC_SCRIPT_FILES.forEach((fileName) => {
        application.get(`/js/${fileName}`, (req, res) => {
            res.sendFile(path.join(__dirname, 'js', fileName));
        });
    });

    Object.entries(PRIVATE_WORKSPACE_STYLES).forEach(([route, fileName]) => {
        application.get(route, (req, res) => {
            res.setHeader('Cache-Control', 'private, no-store, max-age=0');
            res.setHeader('X-Robots-Tag', 'noindex, nofollow');
            res.sendFile(path.join(__dirname, fileName));
        });
    });

    application.get('/.well-known/security.txt', (req, res) => {
        res.sendFile(path.join(__dirname, '.well-known', 'security.txt'));
    });
    application.use('/images', express.static(path.join(__dirname, 'images'), publicStaticOptions()));
    application.use('/assets', express.static(path.join(__dirname, 'assets'), publicStaticOptions()));
}

function publicStaticOptions() {
    return {
        dotfiles: 'deny',
        etag: true,
        fallthrough: true,
        index: false,
        maxAge: 0,
        redirect: false
    };
}

function sendScopeError(res, error) {
    if (error instanceof ScopeAccessError) {
        res.status(error.status).json({ error: error.publicMessage, code: error.code });
        return;
    }
    if (error && error.statusCode >= 400 && error.statusCode < 500) {
        res.status(error.statusCode).json(Object.assign({ error: error.message }, error.details || {}));
        return;
    }
    console.error(error);
    res.status(500).json({ error: 'No Fries could not complete that request.' });
}

return app;
}

const app = createNoFriesApp();
app.createNoFriesApp = createNoFriesApp;
if (require.main === module) {
    try {
        startStandaloneHost(app);
    } catch (error) {
        console.error(error && error.message || 'The No Fries standalone host could not start.');
        process.exitCode = 1;
    }
}

module.exports = app;
