const crypto = require('crypto');

const SUPPORT_RUNTIME_MARKER = '<!-- SUPPORT_RUNTIME -->';
const CLOSING_SCRIPT_PATTERN = /<\/script/i;

function buildSupportRuntime(loaderSource) {
    const sources = [['loader', loaderSource]];

    for (const [name, source] of sources) {
        if (typeof source !== 'string' || source.length === 0) {
            throw new Error(`The support ${name} source was empty.`);
        }
        rejectClosingScriptToken(source, `support ${name} source`);
    }

    const runtime = sources.map(([, source]) => source).join('\n;\n');
    rejectClosingScriptToken(runtime, 'combined support runtime');
    return runtime;
}

function supportScriptHash(runtime) {
    if (typeof runtime !== 'string' || runtime.length === 0) {
        throw new Error('The support runtime was empty.');
    }
    return `'sha256-${crypto.createHash('sha256').update(runtime, 'utf8').digest('base64')}'`;
}

function supportContentSecurityPolicy(scriptHash) {
    if (typeof scriptHash !== 'string' || !/^'sha256-[A-Za-z0-9+/]+={0,2}'$/.test(scriptHash)) {
        throw new Error('The support script hash was invalid.');
    }

    return [
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
}

function buildSupportDocument(options) {
    const settings = options || {};
    const template = settings.template;
    if (typeof template !== 'string' || template.length === 0) {
        throw new Error('The support document template was empty.');
    }

    const markerCount = template.split(SUPPORT_RUNTIME_MARKER).length - 1;
    if (markerCount !== 1) {
        throw new Error(`The support document must contain exactly one ${SUPPORT_RUNTIME_MARKER} marker.`);
    }

    const runtime = buildSupportRuntime(settings.loaderSource);
    const scriptHash = supportScriptHash(runtime);
    const html = template.replace(
        SUPPORT_RUNTIME_MARKER,
        () => `<script id="supportRuntime">${runtime}</script>`
    );

    return {
        html,
        document: html,
        runtime,
        scriptHash,
        contentSecurityPolicy: supportContentSecurityPolicy(scriptHash)
    };
}

function rejectClosingScriptToken(source, description) {
    if (CLOSING_SCRIPT_PATTERN.test(source)) {
        throw new Error(`The ${description} contained a forbidden closing script token.`);
    }
}

module.exports = {
    SUPPORT_RUNTIME_MARKER,
    buildSupportDocument,
    buildSupportRuntime,
    supportContentSecurityPolicy,
    supportScriptHash
};
