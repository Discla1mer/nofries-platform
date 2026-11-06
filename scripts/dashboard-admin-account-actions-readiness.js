'use strict';

// Source inspection only. This is neither an Azure edge emulator nor release,
// deployment, account-operation or staff-access authority. It reads one fixed
// checked-in file; it never reads environment, credentials or private bindings.
const fs = require('node:fs');
const path = require('node:path');

const CONFIG_FILE = 'staticwebapp.config.json';
const MAX_CONFIG_BYTES = 131072, MAX_ROUTES = 256;
const NAMESPACE = '/api/dashboard-admin/actions';
const ACTION_PATHS = Object.freeze(['inspect', 'prepare', 'execute', 'outcome'].map(action => NAMESPACE + '/' + action));
const METHODS = Object.freeze(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE', 'CONNECT']);
const own = (value, key) => Object.hasOwn(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (reason, ruleIndex = null) => { throw Object.assign(new Error(reason), { reason, ruleIndex }); };
const same = (actual, expected) => Array.isArray(actual) && actual.length === expected.length && actual.every((value, index) => value === expected[index]);

function properties(value, allowed, required = []) {
    if (!object(value) || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !own(value, key))) {
        fail('unsupported_configuration_shape');
    }
}
function headers(value) {
    if (!object(value) || Object.keys(value).length > 64) fail('invalid_headers');
    const names = new Set();
    for (const [key, text] of Object.entries(value)) {
        if (!/^[A-Za-z0-9-]{1,100}$/.test(key) || names.has(key.toLowerCase()) || typeof text !== 'string' ||
            text.length > 16384 || /[\r\n\0]/.test(text)) fail('invalid_headers');
        names.add(key.toLowerCase());
    }
}
function routePattern(value) {
    // Deliberately support only the existing source's exact paths and terminal
    // prefix wildcards. Other syntax needs review, not guessed platform behavior.
    if (typeof value !== 'string' || value.length > 256 || !/^\/[A-Za-z0-9._~!$&'()+,;=@/-]*\*?$/.test(value) ||
        value.includes('//') || /(?:^|\/)\.{1,2}(?:\/|\*?$)/.test(value)) fail('unsupported_route_pattern');
}
function validate(text) {
    if (typeof text !== 'string' || !text.length || Buffer.byteLength(text, 'utf8') > MAX_CONFIG_BYTES) fail('configuration_size_or_type_invalid');
    let config;
    try { config = JSON.parse(text); } catch (_) { fail('configuration_json_invalid'); }
    // Existing source tools use lossless JSON round trips to reject duplicate
    // keys. Preserve strings while removing insignificant whitespace; alternate
    // escape/number encodings conservatively need review as well. No new parser.
    const compact = text.replace(/"(?:\\[\s\S]|[^"\\])*"|\s+/g, token => token.startsWith('"') ? token : '');
    if (JSON.stringify(config) !== compact) fail('configuration_json_not_lossless');
    properties(config, ['$schema', 'routes', 'globalHeaders', 'responseOverrides'], ['routes']);
    if (own(config, '$schema') && (typeof config.$schema !== 'string' || config.$schema.length > 2048)) fail('unsupported_configuration_shape');
    if (own(config, 'globalHeaders')) headers(config.globalHeaders);
    if (own(config, 'responseOverrides')) {
        properties(config.responseOverrides, ['404']);
        if (own(config.responseOverrides, '404')) {
            const response = config.responseOverrides['404'];
            properties(response, ['rewrite', 'statusCode'], ['rewrite', 'statusCode']);
            if (response.rewrite !== '/404.html' || response.statusCode !== 404) fail('unsupported_response_override');
        }
    }
    if (!Array.isArray(config.routes) || !config.routes.length || config.routes.length > MAX_ROUTES) fail('route_collection_invalid');
    const seen = new Map();
    for (const [index, rule] of config.routes.entries()) {
        try {
            properties(rule, ['route', 'methods', 'allowedRoles', 'headers', 'redirect', 'rewrite', 'statusCode'], ['route']);
            routePattern(rule.route);
            if (own(rule, 'methods') && (!Array.isArray(rule.methods) || !rule.methods.length || rule.methods.length > METHODS.length ||
                new Set(rule.methods).size !== rule.methods.length || rule.methods.some(method => !METHODS.includes(method)))) fail('invalid_methods');
            if (own(rule, 'allowedRoles') && (!Array.isArray(rule.allowedRoles) || !rule.allowedRoles.length || rule.allowedRoles.length > 8 ||
                new Set(rule.allowedRoles).size !== rule.allowedRoles.length || rule.allowedRoles.some(role =>
                    typeof role !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(role)))) fail('invalid_roles');
            if (own(rule, 'headers')) headers(rule.headers);
            for (const key of ['redirect', 'rewrite']) if (own(rule, key) && (typeof rule[key] !== 'string' ||
                !rule[key].length || rule[key].length > 2048 || /[\r\n\0]/.test(rule[key]))) fail('invalid_route_transform');
            if (own(rule, 'redirect') && own(rule, 'rewrite')) fail('ambiguous_route_transform');
            if (own(rule, 'statusCode') && (!Number.isInteger(rule.statusCode) || rule.statusCode < 100 || rule.statusCode > 599)) fail('invalid_status_code');
            const methods = rule.methods || METHODS, prior = seen.get(rule.route) || new Set();
            if (methods.some(method => prior.has(method))) fail('overlapping_duplicate_route');
            seen.set(rule.route, new Set([...prior, ...methods]));
        } catch (error) { fail(error.reason || 'unsupported_configuration_shape', index); }
    }
    return config;
}
function matches(rule, method, pathname) {
    return (!rule.methods || rule.methods.includes(method)) &&
        (rule.route.endsWith('*') ? pathname.startsWith(rule.route.slice(0, -1)) : rule.route === pathname);
}
function firstMatch(routes, method, pathname) {
    const index = routes.findIndex(rule => matches(rule, method, pathname));
    return index === -1 ? null : { index, rule: routes[index] };
}
function projection(match) {
    return match === null ? null : { index: match.index, route: match.rule.route,
        methods: match.rule.methods || null, allowedRoles: match.rule.allowedRoles || null };
}
const transforms = rule => ['redirect', 'rewrite', 'statusCode'].some(key => own(rule, key));
const anonymous = rule => !rule.allowedRoles || rule.allowedRoles.includes('anonymous');
const guarded = match => match !== null && match.rule.route === '/api/*' && !own(match.rule, 'methods') &&
    same(match.rule.allowedRoles, ['authenticated']) && !transforms(match.rule);

function unsafeNamespaceRule(routes) {
    return routes.findIndex(rule => {
        if (!anonymous(rule)) return false;
        if (!rule.route.endsWith('*')) return (rule.route === NAMESPACE || rule.route.startsWith(NAMESPACE + '/')) && !ACTION_PATHS.includes(rule.route);
        const prefix = rule.route.slice(0, -1);
        return (NAMESPACE + '/').startsWith(prefix) || prefix.startsWith(NAMESPACE + '/');
    });
}
function inspectPath(routes, pathname, unsafeIndex) {
    const matched = firstMatch(routes, 'POST', pathname), reasons = [], exactRuleIndices = [];
    routes.forEach((rule, index) => { if (rule.route === pathname) exactRuleIndices.push(index); });
    if (matched === null) reasons.push('missing_post_rule');
    else {
        const rule = matched.rule;
        if (rule.route !== pathname) reasons.push(rule.route === '/api/*' && same(rule.allowedRoles, ['authenticated'])
            ? 'swa_authenticated_catch_all' : 'first_match_is_not_exact');
        if (!same(rule.methods, ['POST'])) reasons.push('post_only_method_required');
        if (!same(rule.allowedRoles, ['admin'])) reasons.push('explicit_admin_role_required');
        if (transforms(rule)) reasons.push('request_transform_not_forwarding');
        // Existing BFF exceptions are exactly these three fields. Additional
        // route behavior must be reviewed rather than silently called ready.
        if (rule.route === pathname && Object.keys(rule).some(key => !['route', 'methods', 'allowedRoles'].includes(key))) reasons.push('noncanonical_bff_exception');
    }
    if (exactRuleIndices.length !== 1) reasons.push(exactRuleIndices.length ? 'multiple_exact_rules' : 'missing_exact_exception');
    if (unsafeIndex !== -1) reasons.push('anonymous_action_namespace_expansion');
    let guardFailure = null;
    const probes = [
        ...METHODS.filter(method => method !== 'POST').map(method => [method, pathname]),
        ...[pathname + '/', pathname + '/other', pathname + '-other', NAMESPACE + '/unknown'].flatMap(url => METHODS.map(method => [method, url]))
    ];
    for (const [method, url] of probes) {
        const found = firstMatch(routes, method, url);
        if (!guarded(found)) { guardFailure = { method, path: url, firstMatch: projection(found) }; break; }
    }
    if (guardFailure) reasons.push('adjacent_method_or_path_guard_changed');
    return { method: 'POST', path: pathname, status: reasons.length ? 'blocked' : 'pass',
        firstMatch: projection(matched), exactRuleIndices, reasons, guardFailure,
        unsafeAnonymousRule: unsafeIndex === -1 ? null : projection({ index: unsafeIndex, rule: routes[unsafeIndex] }) };
}
function report(findings, review = null) {
    return { schemaVersion: 1, configFile: CONFIG_FILE, scope: 'source_rule_inspection_only',
        sourceForwardingContract: review ? 'review_required' : findings.every(finding => finding.status === 'pass') ? 'pass' : 'blocked',
        azureEdge: 'not_checked', liveStaffAcceptance: 'not_checked', releaseAuthority: 'not_assessed', findings, review };
}
function reviewReport(reason, ruleIndex = null) {
    return report(ACTION_PATHS.map(pathname => ({ method: 'POST', path: pathname, status: 'review_required',
        firstMatch: null, exactRuleIndices: [], reasons: ['configuration_requires_review'], guardFailure: null,
        unsafeAnonymousRule: null })), { reason, ruleIndex });
}
function inspectConfiguration(text) {
    try {
        const config = validate(text), unsafeIndex = unsafeNamespaceRule(config.routes);
        return report(ACTION_PATHS.map(pathname => inspectPath(config.routes, pathname, unsafeIndex)));
    } catch (error) { return reviewReport(error.reason || 'configuration_inspection_failed', error.ruleIndex ?? null); }
}
function readCheckedInConfiguration() {
    let descriptor;
    try {
        descriptor = fs.openSync(path.resolve(__dirname, '..', CONFIG_FILE), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const before = fs.fstatSync(descriptor);
        if (!before.isFile() || before.size < 1 || before.size > MAX_CONFIG_BYTES) fail('configuration_file_invalid');
        const bytes = Buffer.alloc(MAX_CONFIG_BYTES + 1); let length = 0, count;
        while (length < bytes.length && (count = fs.readSync(descriptor, bytes, length, bytes.length - length, null)) > 0) length += count;
        const after = fs.fstatSync(descriptor);
        if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || length > MAX_CONFIG_BYTES) fail('configuration_file_changed');
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
    } catch (error) { fail(error.reason || 'configuration_file_unreadable'); }
    finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}
function run(args = []) {
    if (!Array.isArray(args) || args.length) return reviewReport('arguments_not_supported');
    try { return inspectConfiguration(readCheckedInConfiguration()); }
    catch (error) { return reviewReport(error.reason || 'configuration_file_unreadable'); }
}
const exitCode = result => result.sourceForwardingContract === 'pass' ? 0 : result.sourceForwardingContract === 'blocked' ? 1 : 2;
if (require.main === module) {
    const result = run(process.argv.slice(2));
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exitCode = exitCode(result);
}
module.exports = { ACTION_PATHS, MAX_CONFIG_BYTES, inspectConfiguration, run, exitCode };
