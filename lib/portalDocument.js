'use strict';

const crypto = require('crypto');

const PORTAL_RUNTIME_MARKER = '<!-- PORTAL_RUNTIME -->';
const CLOSING_SCRIPT_PATTERN = /<\/script/i;

function buildPortalDocument(options = {}) {
    const template = options.template;
    const loaderSource = options.loaderSource;
    if (typeof template !== 'string' || !template) throw new Error('The portal document template was empty.');
    if (typeof loaderSource !== 'string' || !loaderSource) throw new Error('The portal loader source was empty.');
    if (CLOSING_SCRIPT_PATTERN.test(loaderSource)) throw new Error('The portal loader contained a forbidden closing script token.');
    if (template.split(PORTAL_RUNTIME_MARKER).length - 1 !== 1) {
        throw new Error(`The portal document must contain exactly one ${PORTAL_RUNTIME_MARKER} marker.`);
    }
    const scriptHash = `'sha256-${crypto.createHash('sha256').update(loaderSource, 'utf8').digest('base64')}'`;
    const contentSecurityPolicy = [
        "default-src 'self'",
        "base-uri 'self'",
        "object-src 'none'",
        "frame-ancestors 'none'",
        "form-action 'self'",
        "img-src 'self' data:",
        `script-src 'self' ${scriptHash}`,
        "script-src-attr 'none'",
        "style-src 'self'",
        "style-src-attr 'none'",
        "connect-src 'self'",
        'upgrade-insecure-requests'
    ].join('; ');
    return {
        html: template.replace(PORTAL_RUNTIME_MARKER, () => `<script id="portalRuntime">${loaderSource}</script>`),
        runtime: loaderSource,
        scriptHash,
        contentSecurityPolicy
    };
}

module.exports = {
    PORTAL_RUNTIME_MARKER,
    buildPortalDocument
};
