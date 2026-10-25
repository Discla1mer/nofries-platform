'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createDashboardAdmission, DashboardAdmissionError,
    createDashboardAdmissionDecision, DashboardAdmissionUnavailableError } = require('./dashboardAdmission');
const { apiSecurityHeaders } = require('./securityHeaders');
const registry = require('./protectedAssets/dashboardRegistry');

/** Read-only source adapter. No default dependencies, production route registration,
 * environment switch, provider factory, database mutation or external write exists.
 * The trusted host passes the exact relative route, and supplies its existing
 * request/session/rate-limit boundaries when separately approved for integration.
 */
function createDashboardService(adapters) {
    const admit = createDashboardAdmission(adapters);
    return Object.freeze({
        async handleRequest(request, route) {
            if (request?.method !== 'GET') return response(405, { code: 'dashboard_method_not_allowed' }, { Allow: 'GET' });
            const resource = typeof route === 'string' && route.startsWith('modules/')
                ? registry.modules.find(item => route === 'modules/' + item.key) : null;
            if (!['bootstrap', 'app.js', 'dashboard.css'].includes(route) && !resource) {
                return response(404, { code: 'dashboard_route_not_found' });
            }
            try {
                const projection = await admit(request, resource?.key ?? null);
                return resourceResponse(projection, route, resource);
            } catch (error) {
                return error instanceof DashboardAdmissionError
                    ? response(403, { code: 'dashboard_access_denied' })
                    : response(503, { code: 'dashboard_unavailable' });
            }
        }
    });
}

/** Fixed internal resource preparation. The owning transaction controls when a
 * buffered result is audited, rechecked and disclosed; this object exposes no SQL.
 */
function createDashboardBufferedService(adapters) {
    const decide = createDashboardAdmissionDecision(adapters);
    return Object.freeze({
        async handleResource(request, route) {
            try {
                if (request?.method !== 'GET') throw new DashboardAdmissionUnavailableError();
                const resource = typeof route === 'string' && route.startsWith('modules/')
                    ? registry.modules.find(item => route === 'modules/' + item.key) : null;
                if (!['bootstrap', 'app.js', 'dashboard.css'].includes(route) && !resource) throw new DashboardAdmissionUnavailableError();
                const decision = await decide(request, resource?.key ?? null);
                const buffered = decision.outcome === 'denied'
                    ? response(403, { code: 'dashboard_access_denied' })
                    : resourceResponse(decision.projection, route, resource);
                return freeze({ outcome: decision.outcome, response: buffered });
            } catch (error) {
                throw new DashboardAdmissionUnavailableError();
            }
        }
    });
}

function resourceResponse(projection, route, resource) {
    if (route === 'app.js') {
        const assets = path.join(__dirname, 'protectedAssets');
        return response(200, ['dashboardRegistry.js', 'dashboardShell.js', 'ncscAssessmentClient.js', 'ncscQuestionnaire.js', 'assessmentExplanation.js', 'organisationPicture.js', 'improvementActionPlanView.js', 'improvementActionPlanClient.js']
            .map(file => fs.readFileSync(path.join(assets, file), 'utf8')).join('\n'),
        { 'Content-Type': 'application/javascript; charset=utf-8' }, true);
    }
    if (route === 'dashboard.css') {
        return response(200, fs.readFileSync(path.join(__dirname, '../../app/dashboard.css'), 'utf8'),
            { 'Content-Type': 'text/css; charset=utf-8' }, true);
    }
    if (resource) return response(200, moduleView(projection, resource.key));
    return response(200, projection);
}
function freeze(value) {
    if (value && typeof value === 'object') {
        Object.values(value).forEach(freeze);
        Object.freeze(value);
    }
    return value;
}

function moduleView(projection, key) {
    return {
        schemaVersion: 1, context: projection.context, generatedAt: projection.generatedAt,
        module: projection.modules.find(item => item.key === key),
        // This is the authorised display contract only. Record-level APIs, writes,
        // draft reports and provider routes need their own exact action guards.
        summary: key === 'overview' ? projection.summary : { state: 'empty', attention: [], metrics: [] },
        services: key === 'services' ? projection.services : [],
        admissionGranted: false, providerAccessGranted: false
    };
}
function response(status, body, headers = {}, isRaw = false) {
    return { status, headers: apiSecurityHeaders({ 'Content-Type': 'application/json; charset=utf-8', ...headers }), body, isRaw };
}

module.exports = { createDashboardService, createDashboardBufferedService };
