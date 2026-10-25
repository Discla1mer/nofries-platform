'use strict';

const crypto = require('crypto');
const { withFrontendReleaseInformation } = require('./frontendReleaseInfo');

const DASHBOARD_RUNTIME_MARKER = '<!-- DASHBOARD_RUNTIME -->';
const APP_INTEGRITY_MARKER = 'DASHBOARD_APP_INTEGRITY';
const STYLE_INTEGRITY_MARKER = 'DASHBOARD_STYLE_INTEGRITY';

// This is an entry/presentation hint, never identity or permission evidence.
// Preserve the source body attributes and reject ambiguous document markers.
function withCustomerProvider(html, provider) {
    if (typeof html !== 'string' || !['auto', 'legacy', 'external', 'staff'].includes(provider)) {
        throw new Error('customer_provider_invalid');
    }
    const bodies = [...html.matchAll(/<body\b([^>]*)>/gi)];
    if (bodies.length !== 1) throw new Error('customer_provider_invalid');
    const markers = [...bodies[0][1].matchAll(/(?:^|\s)data-customer-provider(?=\s|=|$)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/gi)];
    if (markers.length) {
        if (markers.length !== 1 || (markers[0][1] ?? markers[0][2] ?? markers[0][3]) !== provider) {
            throw new Error('customer_provider_invalid');
        }
        return html;
    }
    return html.replace(bodies[0][0], () => bodies[0][0].slice(0, -1) + ` data-customer-provider="${provider}">`);
}

function buildDashboardDocument(options = {}) {
    const { template: suppliedTemplate, loaderSource, protectedAppSource, protectedStyleSource } = options;
    if (options.customerTransport !== undefined && (!['auto', 'external'].includes(options.customerTransport) || options.customerLogin !== true)) {
        throw new Error('dashboard_customer_transport_invalid');
    }
    for (const [name, value] of Object.entries({ template: suppliedTemplate, loaderSource, protectedAppSource, protectedStyleSource })) {
        if (typeof value !== 'string' || !value.trim()) {
            throw new Error(`The dashboard document ${name} was empty.`);
        }
    }
    const provider = options.customerLogin === true ? options.customerTransport || 'legacy' : 'staff';
    const customerEntry = provider === 'auto' ? '/login' : '/login?provider=' + provider;
    let template = withCustomerProvider(withFrontendReleaseInformation(suppliedTemplate), provider);
    if (options.customerLogin === true) {
        template = template
            .replaceAll('href="/api/auth/login?returnTo=%2Fdashboard"', `href="${customerEntry}"`)
            .replaceAll('href="/api/dashboard/login?returnTo=%2Fdashboard"', `href="${customerEntry}"`);
    }
    if (provider === 'external') {
        template = template.replaceAll('href="/login"', 'href="/login?provider=external"')
            .replaceAll('href="/api/customer-auth/login"', 'href="/api/external-customer-auth/login"');
    }
    if (/<\/script/i.test(loaderSource)) {
        throw new Error('The dashboard loader contained a forbidden closing script token.');
    }
    if (/<script\b/i.test(template)) {
        throw new Error('The dashboard template must not contain another script.');
    }
    for (const marker of [DASHBOARD_RUNTIME_MARKER, APP_INTEGRITY_MARKER, STYLE_INTEGRITY_MARKER]) {
        if (template.split(marker).length - 1 !== 1) {
            throw new Error(`The dashboard document must contain exactly one ${marker} marker.`);
        }
    }
    const integrity = source => `sha256-${crypto.createHash('sha256').update(source, 'utf8').digest('base64')}`;
    const scriptHash = `'${integrity(loaderSource)}'`;
    const appIntegrity = integrity(protectedAppSource);
    const styleIntegrity = integrity(protectedStyleSource);
    const contentSecurityPolicy = [
        "default-src 'none'",
        "base-uri 'none'",
        "object-src 'none'",
        "frame-src 'none'",
        "frame-ancestors 'none'",
        "form-action 'self'",
        "img-src 'self' data:",
        `script-src 'self' ${scriptHash}`,
        "script-src-attr 'none'",
        "style-src 'self'",
        "style-src-attr 'none'",
        "connect-src 'self'",
        "font-src 'self'",
        "worker-src 'none'",
        'upgrade-insecure-requests'
    ].join('; ');
    return {
        html: template
            .replace(APP_INTEGRITY_MARKER, () => appIntegrity)
            .replace(STYLE_INTEGRITY_MARKER, () => styleIntegrity)
            .replace(DASHBOARD_RUNTIME_MARKER, () => `<script id="dashboardRuntime">${loaderSource}</script>`),
        runtime: loaderSource,
        scriptHash,
        appIntegrity,
        styleIntegrity,
        contentSecurityPolicy
    };
}

module.exports = { DASHBOARD_RUNTIME_MARKER, buildDashboardDocument, withCustomerProvider };
