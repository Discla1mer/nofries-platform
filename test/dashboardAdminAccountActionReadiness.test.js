'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { ACTION_PATHS, MAX_CONFIG_BYTES, inspectConfiguration, run, exitCode } =
    require('../scripts/dashboard-admin-account-actions-readiness');

const root = path.resolve(__dirname, '..'), script = path.join(root, 'scripts/dashboard-admin-account-actions-readiness.js');
const configPath = path.join(root, 'staticwebapp.config.json');
const checkedIn = fs.readFileSync(configPath, 'utf8');
const exception = pathname => ({ route: pathname, methods: ['POST'], allowedRoles: ['admin'] });
const broker = () => ({ route: '/api/*', allowedRoles: ['authenticated'] });
const candidate = () => ({ routes: [...ACTION_PATHS.map(exception), broker()] });
const inspect = config => inspectConfiguration(JSON.stringify(config));
function sourceOnly(result) {
    expect(result).toMatchObject({ schemaVersion: 1, configFile: 'staticwebapp.config.json', scope: 'source_rule_inspection_only',
        azureEdge: 'not_checked', liveStaffAcceptance: 'not_checked', releaseAuthority: 'not_assessed' });
    expect(result.findings.map(({ method, path: pathname }) => [method, pathname])).toEqual(ACTION_PATHS.map(pathname => ['POST', pathname]));
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(32768);
}
afterEach(() => jest.restoreAllMocks());

test('removing the four exact exceptions reproduces the original authenticated broker catch-all blocker', () => {
    const config = JSON.parse(checkedIn);
    config.routes = config.routes.filter(rule => !ACTION_PATHS.includes(rule.route));
    const result = inspect(config);
    const index = config.routes.findIndex(rule => rule.route === '/api/*');
    sourceOnly(result); expect(result.sourceForwardingContract).toBe('blocked'); expect(exitCode(result)).toBe(1);
    for (const finding of result.findings) {
        expect(finding).toMatchObject({ status: 'blocked', firstMatch: { index, route: '/api/*', methods: null,
            allowedRoles: ['authenticated'] }, exactRuleIndices: [], guardFailure: null });
        expect(finding.reasons).toContain('swa_authenticated_catch_all');
        expect(finding.reasons).toContain('missing_exact_exception');
    }
});

test('checked-in exact POST exceptions plus unchanged guards pass only the source contract, without live claims', () => {
    const config = JSON.parse(checkedIn), first = config.routes.findIndex(rule => rule.route === ACTION_PATHS[0]);
    const result = inspectConfiguration(checkedIn);
    sourceOnly(result); expect(result.sourceForwardingContract).toBe('pass'); expect(exitCode(result)).toBe(0);
    result.findings.forEach((finding, i) => expect(finding).toEqual({ method: 'POST', path: ACTION_PATHS[i], status: 'pass',
        firstMatch: { index: first + i, route: ACTION_PATHS[i], methods: ['POST'], allowedRoles: ['admin'] },
        exactRuleIndices: [first + i], reasons: [], guardFailure: null, unsafeAnonymousRule: null }));
    // Readiness inspection never edits the source file.
    expect(fs.readFileSync(configPath, 'utf8')).toBe(checkedIn);
});

test('findings preserve actual rule indices while remaining in fixed action order', () => {
    const config = candidate(); config.routes = [...config.routes.slice(0, 4).reverse(), broker()];
    const result = inspect(config);
    expect(result.sourceForwardingContract).toBe('pass');
    expect(result.findings.map(finding => finding.firstMatch.index)).toEqual([3, 2, 1, 0]);
    expect(result.findings.map(finding => finding.path)).toEqual(ACTION_PATHS);
});

test.each([
    ['catch-all before exceptions', () => broker()],
    ['earlier protected namespace', () => ({ route: '/api/dashboard-admin/*', allowedRoles: ['authenticated'] })],
    ['earlier anonymous namespace', () => ({ route: '/api/dashboard-admin/actions/*', allowedRoles: ['anonymous'] })]
])('%s shadows the exact POST candidates and cannot pass', (_name, first) => {
    const config = candidate(); config.routes.unshift(first());
    // Avoid a duplicate /api/* rule; this case tests order, not duplicate validation.
    if (config.routes[0].route === '/api/*') config.routes.pop();
    const result = inspect(config);
    expect(result.sourceForwardingContract).toBe('blocked');
    for (const finding of result.findings) expect(finding.firstMatch.index).toBe(0);
});

test.each([
    { route: '/api/dashboard-admin/actions/*', methods: ['POST'], allowedRoles: ['anonymous'] },
    { route: '/api/dashboard-admin/*', allowedRoles: ['anonymous'] },
    { route: '/api/dashboard-admin/actions/reset', methods: ['POST'], allowedRoles: ['anonymous'] }
])('unreachable namespace expansion after the catch-all still cannot earn readiness: %p', rule => {
    const config = candidate(); config.routes.push(rule);
    const result = inspect(config);
    expect(result.sourceForwardingContract).toBe('blocked');
    expect(result.findings[0]).toMatchObject({ firstMatch: { index: 0 }, unsafeAnonymousRule: { index: 5, route: rule.route } });
    expect(result.findings[0].reasons).toContain('anonymous_action_namespace_expansion');
});

test('an anonymous /api/* fallback fails even when all four exact POST exceptions exist', () => {
    const config = candidate(); config.routes[4].allowedRoles = ['anonymous'];
    const result = inspect(config);
    expect(result.sourceForwardingContract).toBe('blocked');
    expect(result.findings[0].guardFailure).toMatchObject({ method: 'GET', path: ACTION_PATHS[0],
        firstMatch: { index: 4, route: '/api/*', allowedRoles: ['anonymous'] } });
});

test.each([
    ['omitted methods', rule => { delete rule.methods; }],
    ['multiple methods', rule => { rule.methods = ['POST', 'DELETE']; }],
    ['wrong method', rule => { rule.methods = ['GET']; }],
    ['implicit anonymous roles', rule => { delete rule.allowedRoles; }],
    ['mixed roles', rule => { rule.allowedRoles = ['anonymous', 'authenticated']; }]
])('an exact path with %s is not the existing BFF forwarding contract', (_name, change) => {
    const config = candidate(); change(config.routes[0]);
    const result = inspect(config);
    expect(result.sourceForwardingContract).toBe('blocked'); expect(result.findings[0].status).toBe('blocked');
});

test.each([
    ['redirect', { redirect: '/api/dashboard-admin/lookup' }],
    ['rewrite', { rewrite: '/api/dashboard-admin/lookup' }],
    ['status override', { statusCode: 302 }],
    ['additional header behavior', { headers: { 'Cache-Control': 'no-store' } }]
])('exact POST exception with %s does not falsely pass unchanged forwarding', (_name, extra) => {
    const config = candidate(); Object.assign(config.routes[0], extra);
    const result = inspect(config);
    expect(result.sourceForwardingContract).toBe('blocked'); expect(result.findings[0].reasons).toContain('noncanonical_bff_exception');
    if (!extra.headers) expect(result.findings[0].reasons).toContain('request_transform_not_forwarding');
});

test('a protected-rule redirect on a neighboring path fails the forwarding guard', () => {
    const config = candidate(); config.routes.splice(4, 0, { route: ACTION_PATHS[0] + '/other', allowedRoles: ['authenticated'], redirect: '/login' });
    const result = inspect(config);
    expect(result.sourceForwardingContract).toBe('blocked');
    expect(result.findings[0].guardFailure).toMatchObject({ path: ACTION_PATHS[0] + '/other', firstMatch: { index: 4 } });
});

test.each([
    ['duplicate overlapping exact rule', config => config.routes.splice(1, 0, exception(ACTION_PATHS[0]))],
    ['unsupported wildcard grammar', config => { config.routes[0].route = '/api/*/actions/inspect'; }],
    ['duplicate method', config => { config.routes[0].methods = ['POST', 'POST']; }],
    ['unknown forwarding field', config => { config.routes[0].forward = '/api/elsewhere'; }],
    ['unexpected navigation fallback', config => { config.navigationFallback = { rewrite: '/index.html' }; }],
    ['authentication response override', config => { config.responseOverrides = { 401: { redirect: '/login', statusCode: 302 } }; }],
    ['missing route list', config => { delete config.routes; }]
])('ambiguous or unsupported %s requires review without inferring platform behavior', (_name, change) => {
    const config = candidate(); change(config);
    const result = inspect(config);
    sourceOnly(result); expect(result.sourceForwardingContract).toBe('review_required'); expect(exitCode(result)).toBe(2);
    expect(result.findings.every(finding => finding.firstMatch === null && finding.status === 'review_required')).toBe(true);
});

test('lossless parsing rejects duplicate policy keys that ordinary JSON.parse would silently replace', () => {
    const text = JSON.stringify(candidate()).replace('"allowedRoles":["admin"]',
        '"allowedRoles":["authenticated"],"allowedRoles":["anonymous"]');
    expect(JSON.parse(text).routes[0].allowedRoles).toEqual(['anonymous']);
    expect(inspectConfiguration(text)).toMatchObject({ sourceForwardingContract: 'review_required',
        review: { reason: 'configuration_json_not_lossless' } });
});

test('malformed, excessive and executable inputs produce fixed bounded review reports', () => {
    const getter = jest.fn(), input = {};
    Object.defineProperty(input, 'routes', { get: getter });
    for (const value of ['{', ' '.repeat(MAX_CONFIG_BYTES + 1), input, new Proxy({}, { get: getter })]) {
        const result = inspectConfiguration(value); sourceOnly(result);
        expect(result.sourceForwardingContract).toBe('review_required');
    }
    expect(getter).not.toHaveBeenCalled();
});

test('fixed-path CLI works from another directory and reports source contract pass without live claims', () => {
    const processResult = spawnSync(process.execPath, [script], { cwd: os.tmpdir(), encoding: 'utf8', timeout: 5000, maxBuffer: 32768 });
    expect(processResult.error).toBeUndefined(); expect(processResult.status).toBe(0); expect(processResult.stderr).toBe('');
    expect(JSON.parse(processResult.stdout)).toEqual(inspectConfiguration(checkedIn));
});

test('CLI accepts neither path substitutions nor approval arguments and reads no file for them', () => {
    const open = jest.spyOn(fs, 'openSync');
    for (const args of [['--config', '/tmp/other.json'], ['--approval-file', 'PRIVATE_APPROVAL'], ['--live']]) {
        const result = run(args);
        expect(result).toMatchObject({ sourceForwardingContract: 'review_required', review: { reason: 'arguments_not_supported' } });
        expect(JSON.stringify(result)).not.toContain('PRIVATE_APPROVAL');
    }
    expect(open).not.toHaveBeenCalled();
});

test('normal invocation reads only the fixed file without writes or network requests', () => {
    const open = jest.spyOn(fs, 'openSync'), write = jest.spyOn(fs, 'writeFileSync'), unlink = jest.spyOn(fs, 'unlinkSync');
    const request = jest.spyOn(require('node:https'), 'request'), fetch = jest.spyOn(globalThis, 'fetch');
    const result = run();
    expect(result.sourceForwardingContract).toBe('pass');
    expect(open).toHaveBeenCalledWith(configPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    expect(open).toHaveBeenCalledTimes(1);
    for (const operation of [write, unlink, request, fetch]) expect(operation).not.toHaveBeenCalled();
    expect(fs.readFileSync(configPath, 'utf8')).toBe(checkedIn);
});

test('an unreadable source file returns a fixed review reason without provider or path diagnostics', () => {
    jest.spyOn(fs, 'openSync').mockImplementation(() => { throw new Error('PRIVATE_PATH_AND_PROVIDER_DETAIL'); });
    const result = run();
    expect(result).toMatchObject({ sourceForwardingContract: 'review_required', review: { reason: 'configuration_file_unreadable' } });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_PATH');
});
