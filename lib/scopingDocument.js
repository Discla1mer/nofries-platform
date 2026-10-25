const crypto = require('crypto');

const SCOPING_RUNTIME_MARKER = '<!-- SCOPING_RUNTIME -->';
const CLOSING_SCRIPT_PATTERN = /<\/script/i;

function buildScopingRuntime(loaderSource, copySource) {
    const sources = [
        ['loader', loaderSource],
        ['copy', copySource]
    ];

    for (const [name, source] of sources) {
        if (typeof source !== 'string' || source.length === 0) {
            throw new Error(`The scoping ${name} source was empty.`);
        }
        rejectClosingScriptToken(source, `scoping ${name} source`);
    }

    const runtime = sources.map(([, source]) => source).join('\n;\n');
    rejectClosingScriptToken(runtime, 'combined scoping runtime');
    return runtime;
}

function scopingScriptHash(runtime) {
    if (typeof runtime !== 'string' || runtime.length === 0) {
        throw new Error('The scoping runtime was empty.');
    }

    return `'sha256-${crypto.createHash('sha256').update(runtime, 'utf8').digest('base64')}'`;
}

function scopingContentSecurityPolicy(scriptHash) {
    if (typeof scriptHash !== 'string' || !/^'sha256-[A-Za-z0-9+/]+={0,2}'$/.test(scriptHash)) {
        throw new Error('The scoping script hash was invalid.');
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

function buildScopingDocument(options) {
    const settings = options || {};
    const template = settings.template;
    if (typeof template !== 'string' || template.length === 0) {
        throw new Error('The scoping document template was empty.');
    }

    const markerCount = template.split(SCOPING_RUNTIME_MARKER).length - 1;
    if (markerCount !== 1) {
        throw new Error(`The scoping document must contain exactly one ${SCOPING_RUNTIME_MARKER} marker.`);
    }

    const runtime = buildScopingRuntime(settings.loaderSource, settings.copySource);
    const scriptHash = scopingScriptHash(runtime);
    const inlineScript = `<script id="scopingRuntime">${runtime}</script>`;
    const html = template.replace(SCOPING_RUNTIME_MARKER, () => inlineScript);

    return {
        html,
        document: html,
        runtime,
        scriptHash,
        contentSecurityPolicy: scopingContentSecurityPolicy(scriptHash)
    };
}

function rejectClosingScriptToken(source, description) {
    if (CLOSING_SCRIPT_PATTERN.test(source)) {
        throw new Error(`The ${description} contained a forbidden closing script token.`);
    }
}

module.exports = {
    SCOPING_RUNTIME_MARKER,
    buildScopingDocument,
    buildScopingRuntime,
    scopingContentSecurityPolicy,
    scopingScriptHash
};
