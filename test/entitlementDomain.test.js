'use strict';

const assert = require('node:assert/strict');
const test = global.test || require('node:test');
const { createTenantAggregate } = require('../api/shared/appLifecycle/tenantDomain');
const { MODULES, TIERS, SERVICES, EntitlementDomainError, normaliseEntitlementState,
    resolveEntitlements, assertServiceEntitlement, consumeEntitlementLimit } = require('../api/shared/appLifecycle/entitlementDomain');

const START = '2026-09-01T00:00:00.000Z', NOW = '2026-09-05T00:00:00.000Z';
const CHANGE = '2026-09-15T00:00:00.000Z', END = '2026-10-01T00:00:00.000Z';
const SCOPE = { tenantId: 'synthetic-a', organisationId: 'org-1' };
const copy = value => JSON.parse(JSON.stringify(value));
const tenant = (tenantId = SCOPE.tenantId) => createTenantAggregate({
    tenant: { tenantId, displayName: 'Synthetic workspace' },
    organisations: ['org-1', 'org-2'].map(organisationId => ({ tenantId, organisationId, displayName: organisationId }))
});
const product = overrides => ({ ...SCOPE, grantId: 'product-1', code: 'dashboard_score', status: 'active',
    validFrom: START, validUntil: END, agreementRef: 'synthetic-order-1', modules: [...TIERS.dashboard_score],
    frameworks: [{ moduleId: 'cyber_security', profileId: 'synthetic-profile', version: '1.0' }],
    limits: { assessment_runs: 2, report_exports: 2, evidence_bytes: 1024, memberships: 2, ai_requests: 1 },
    coverage: [], actions: [], ...overrides });
const service = overrides => ({ ...SCOPE, grantId: 'service-1', code: 'managed_endpoint', status: 'active',
    validFrom: START, validUntil: END, agreementRef: 'synthetic-service-order', modules: ['services'],
    frameworks: [], limits: {}, coverage: ['device-1'], actions: ['view'], ...overrides });
const state = (grants = [product()], overrides) => ({ schemaVersion: 1, ...SCOPE, revision: 3, grants, ...overrides });
const flags = (enabled = {}, overrides) => ({ ...SCOPE, revision: 2,
    frameworks: [{ moduleId: 'cyber_security', profileId: 'synthetic-profile', version: '1.0' },
        { moduleId: 'ai_governance', profileId: 'synthetic-ai', version: '2.0' },
        { moduleId: 'it_optimisation', profileId: 'synthetic-it', version: '1.0' }],
    enabled: { dashboard: true, ...Object.fromEntries(MODULES.map(key => [key, true])), ...enabled }, ...overrides });
const resolve = (s = state(), cfg = flags(), now = NOW, scope = SCOPE, t = tenant()) =>
    resolveEntitlements(s, t, scope, now, cfg);
const usage = overrides => ({ schemaVersion: 1, ...SCOPE, grantId: 'product-1', revision: 4,
    counters: { assessment_runs: 0, report_exports: 0, evidence_bytes: 0, memberships: 0, ai_requests: 0 }, ...overrides });
const command = overrides => ({ ...SCOPE, grantId: 'product-1', expectedEntitlementRevision: 3,
    expectedFlagRevision: 2, expectedUsageRevision: 4, moduleId: 'cyber_security', limit: 'assessment_runs', amount: 1,
    framework: { profileId: 'synthetic-profile', version: '1.0' }, ...overrides });
const consume = (u = usage(), c = command(), s = state(), cfg = flags(), now = NOW, t = tenant()) =>
    consumeEntitlementLimit(s, t, u, c, now, cfg);
const serviceRequest = overrides => ({ ...SCOPE, code: 'managed_endpoint', moduleId: 'services',
    targetId: 'device-1', action: 'view', ...overrides });
const checkService = (s = state([service()]), req = serviceRequest(), cfg = flags({ 'service:managed_endpoint': true })) =>
    assertServiceEntitlement(s, tenant(), req, NOW, cfg);
function rejects(fn, code, status) {
    assert.throws(fn, error => error instanceof EntitlementDomainError &&
        error.code === `entitlement_${code}` && (!status || error.statusCode === status));
}

test('Score resolves ordered dashboard modules without provider identifiers', () => {
    const result = resolve();
    assert.equal(result.product.code, 'dashboard_score');
    assert.equal(result.modules.cyber_security.eligible, true);
    assert.equal(result.modules.ai_governance.eligible, false);
    assert.equal(result.frameworks[0].version, '1.0');
    assert.equal(result.admissionGranted, false);
    assert.equal(result.providerAccessGranted, false);
    assert.equal(result.services.managed_endpoint.entitled, false);
});

test('Govern is not an implicit grant of every module or service', () => {
    const result = resolve(state([product({ code: 'dashboard_govern', modules: ['overview'], frameworks: [] })]));
    assert.equal(result.modules.overview.eligible, true);
    assert.equal(result.modules.cyber_security.reason, 'not_ordered');
    assert.equal(result.modules.ai_governance.eligible, false);
    assert.equal(result.services.fractional_advisory.entitled, false);
});

test('retained grants above 256 do not disable the current dashboard product', () => {
    const history = Array.from({ length: 300 }, (_, i) => service({
        grantId: `retained-${i}`, status: 'revoked'
    }));
    const s = state([...history, product()]);
    const before = copy(s);
    const result = resolve(s);
    assert.equal(result.modules.overview.eligible, true);
    assert.equal(result.product.grantId, 'product-1');
    assert.deepEqual(s, before);
});

test('covered fleets above 256 preserve dashboard and exact last-target service access', () => {
    const coverage = Array.from({ length: 300 }, (_, i) => `device-${i}`);
    const s = state([product(), service({ coverage })]);
    const cfg = flags({ 'service:managed_endpoint': true });
    assert.equal(resolve(s, cfg).modules.overview.eligible, true);
    assert.equal(checkService(s, serviceRequest({ targetId: 'device-299' }), cfg).entitled, true);
    rejects(() => checkService(s, serviceRequest({ targetId: 'device-300' }), cfg), 'service_not_entitled', 403);
});

test('a matching service grant beyond a first page still makes authority ambiguous', () => {
    const history = Array.from({ length: 300 }, (_, i) => service({
        grantId: `retained-${i}`, status: 'revoked'
    }));
    rejects(() => checkService(state([service(), ...history, service({ grantId: 'tail-grant' })])),
        'service_ambiguous', 403);
});

test('large unsorted adjacent product terms resolve and overlapping tail terms reject', () => {
    const start = Date.parse('2025-01-01T00:00:00.000Z');
    const terms = Array.from({ length: 300 }, (_, i) => product({
        grantId: `term-${i}`, validFrom: new Date(start + i * 86400000).toISOString(),
        validUntil: new Date(start + (i + 1) * 86400000).toISOString()
    })).reverse();
    assert.equal(resolve(state(terms), flags(), terms[0].validFrom).product.grantId, 'term-299');
    const bad = [...terms, product({ grantId: 'overlap-tail',
        validFrom: terms[0].validFrom, validUntil: terms[0].validUntil })];
    rejects(() => resolve(state(bad)), 'product_overlap', 409);
});

test('Govern can include explicitly ordered AI/IT modules with exact profiles', () => {
    const p = product({ code: 'dashboard_govern', modules: [...MODULES] });
    p.frameworks.push({ moduleId: 'ai_governance', profileId: 'synthetic-ai', version: '2.0' },
        { moduleId: 'it_optimisation', profileId: 'synthetic-it', version: '1.0' });
    assert.equal(resolve(state([p])).frameworks.length, 3);
});

test('governance workflow requires Govern, improvement scope and its own flag', () => {
    const cfg = flags({ governance_workflow: true });
    assert.equal(resolve(state(), cfg).governanceWorkflowEligible, false);
    assert.equal(resolve(state([product({ code: 'dashboard_govern' })]), cfg).governanceWorkflowEligible, true);
    assert.equal(resolve(state([product({ code: 'dashboard_govern' })])).governanceWorkflowEligible, false);
});

test('missing flags, empty flags and global kill switch deny all dashboard features', () => {
    for (const cfg of [undefined, flags({}, { enabled: {} }), flags({ dashboard: false })]) {
        const result = resolveEntitlements(state(), tenant(), SCOPE, NOW, cfg);
        assert.ok(Object.values(result.modules).every(module => !module.eligible));
    }
});

test('one disabled module does not disable unrelated ordered modules', () => {
    const result = resolve(state(), flags({ cyber_security: false }));
    assert.equal(result.modules.cyber_security.reason, 'feature_disabled');
    assert.equal(result.modules.board_reports.eligible, true);
    assert.deepEqual(result.frameworks, []);
});

test('missing product grants no dashboard even with every feature flag on', () => {
    const result = resolve(state([]));
    assert.equal(result.product, null);
    assert.ok(Object.values(result.modules).every(module => !module.eligible));
});

for (const status of ['suspended', 'revoked']) {
    test(`${status} product grants nothing`, () => {
        assert.equal(resolve(state([product({ status })])).product, null);
    });
}

test('effective dates include start and exclude end without wall-clock dependence', () => {
    assert.ok(resolve(state(), flags(), START).product);
    assert.equal(resolve(state(), flags(), '2026-08-31T23:59:59.999Z').product, null);
    assert.equal(resolve(state(), flags(), END).product, null);
    assert.deepEqual(resolve(), resolve());
});

for (const owner of ['tenant', 'organisation']) {
    for (const status of ['suspended', 'closed']) {
        test(`${owner} ${status} denies product and service resolution`, () => {
            const t = copy(tenant());
            (owner === 'tenant' ? t.tenant : t.organisations[0]).recordStatus = status;
            const result = resolve(state([product(), service()]), flags(), NOW, SCOPE, t);
            assert.equal(result.product, null);
            assert.equal(result.services.managed_endpoint.entitled, false);
        });
    }
}

test('state and flags are bound to both tenant and organisation', () => {
    rejects(() => resolve(state([], { organisationId: 'org-2' })), 'not_found', 404);
    rejects(() => resolve(state(), flags({}, { organisationId: 'org-2' })), 'not_found', 404);
    rejects(() => resolve(state(), flags({}, { tenantId: 'synthetic-b' })), 'not_found', 404);
    assert.throws(() => resolve(state(), flags(), NOW, { ...SCOPE, tenantId: 'synthetic-b' }));
});

test('same local organisation and grant IDs in different tenants stay independent', () => {
    const other = { tenantId: 'synthetic-b', organisationId: 'org-1' };
    const result = resolve(state([product(other)], other), flags({}, other), NOW, other, tenant(other.tenantId));
    assert.equal(result.tenantId, other.tenantId);
    assert.throws(() => resolveEntitlements(state([product()], other), tenant(), other, NOW, flags({}, other)));
});

test('tier switch at an exact boundary uses the new explicit grant and limits', () => {
    const old = product({ validUntil: CHANGE });
    const next = product({ grantId: 'product-2', code: 'dashboard_govern', validFrom: CHANGE,
        modules: ['overview'], frameworks: [], limits: { memberships: 1 } });
    const s = state([next, old]);
    assert.equal(resolve(s, flags(), NOW).product.code, 'dashboard_score');
    const result = resolve(s, flags(), CHANGE);
    assert.equal(result.product.code, 'dashboard_govern');
    assert.equal(result.modules.cyber_security.eligible, false);
    assert.deepEqual(result.product.limits, { memberships: 1 });
});

test('downgrade drops Govern workflow without carrying prior entitlement scope', () => {
    const s = state([product({ code: 'dashboard_govern', validUntil: CHANGE }),
        product({ grantId: 'product-2', validFrom: CHANGE })]);
    const cfg = flags({ governance_workflow: true });
    assert.equal(resolve(s, cfg, NOW).governanceWorkflowEligible, true);
    assert.equal(resolve(s, cfg, CHANGE).governanceWorkflowEligible, false);
});

test('overlapping active products, including future or same-tier duplicates, fail closed', () => {
    for (const code of ['dashboard_score', 'dashboard_govern']) {
        rejects(() => resolve(state([product(), product({ grantId: 'product-2', code, validFrom: CHANGE })])), 'product_overlap', 409);
    }
});

for (const code of ['unknown', 'datto_rmm', 'mdr', 'backup', 'endpoint_backup', 'managed_endpoint_internal_pilot']) {
    test(`canonical resolver does not promote legacy/internal key ${code}`, () => {
        rejects(() => resolve(state([service({ code })])), 'code_unknown');
    });
}

test('Managed IT package parent is metadata only and never a wildcard', () => {
    const p = service({ code: 'managed_it_core', modules: [], coverage: [], actions: [] });
    const result = resolve(state([p]), flags({ 'service:managed_it_core': true }));
    assert.equal(result.product, null);
    assert.equal(result.services.managed_it_core.entitled, false);
    assert.ok(Object.values(result.services).every(s => !s.entitled));
    rejects(() => resolve(state([service({ code: 'managed_it_core' })])), 'package_parent_not_authorising');
});

test('service purchase is separately flagged and does not imply operational readiness', () => {
    const result = resolve(state([service()]));
    assert.equal(result.services.managed_endpoint.entitled, true);
    assert.equal(result.services.managed_endpoint.enabled, false);
    assert.equal(result.services.managed_endpoint.operational, false);
    const proof = checkService();
    assert.equal(proof.entitled, true);
    assert.equal(proof.providerBinding, 'required');
    assert.equal(proof.providerAccessGranted, false);
    assert.equal(proof.admissionGranted, false);
});

test('service assertion requires exact target, action, module, term and enabled feature', () => {
    for (const changes of [{ targetId: 'device-2' }, { action: 'manage' }, { moduleId: 'overview' }]) {
        rejects(() => checkService(state([service()]), serviceRequest(changes)), 'service_not_entitled', 403);
    }
    rejects(() => checkService(state([service()]), serviceRequest(), flags()), 'feature_disabled', 403);
    rejects(() => checkService(state([service({ validUntil: NOW })])), 'service_not_entitled', 403);
    rejects(() => checkService(state([service(), service({ grantId: 'service-2' })])), 'service_ambiguous', 403);
});

test('advisory and human Tier 1 are not roles or the AI helpdesk', () => {
    const grants = [service({ code: 'fractional_advisory' }), service({ grantId: 'tier1', code: 'tier1_support' })];
    const result = resolve(state(grants), flags({ 'service:fractional_advisory': true, 'service:tier1_support': true }));
    assert.equal(result.services.fractional_advisory.assignmentRequired, true);
    assert.equal(result.services.tier1_support.entitled, true);
    assert.equal(result.services.ai_service_desk.entitled, false);
    assert.equal(result.admissionGranted, false);
});

test('unknown/missing lifecycle fields cannot silently become active', () => {
    const p = product(); delete p.status;
    rejects(() => resolve(state([p])), 'shape_invalid');
    rejects(() => resolve(state([product({ status: undefined })])), 'status_invalid');
    rejects(() => resolve(state([product({ status: 'trial' })])), 'status_invalid');
    rejects(() => resolve({ ...state(), schemaVersion: 2 }), 'schema_unsupported');
    rejects(() => resolve({ ...state(), revision: undefined }), 'integer_invalid');
});

test('product scope and framework pins cannot be broadened implicitly', () => {
    rejects(() => resolve(state([product({ modules: ['ai_governance'], frameworks: [
        { moduleId: 'ai_governance', profileId: 'synthetic', version: '1' }] })])), 'product_scope_invalid');
    rejects(() => resolve(state([product({ frameworks: [] })])), 'framework_required');
    rejects(() => resolve(state([product({ modules: ['overview'] })])), 'framework_scope_invalid');
    rejects(() => resolve(state([product({ modules: ['overview', 'overview'], frameworks: [] })])), 'duplicate');
    rejects(() => resolve(state([product({ coverage: ['device-1'] })])), 'product_scope_invalid');
});

for (const date of [null, '', '2026-09-05', '2026-09-05T00:00:00Z', '2026-02-30T00:00:00.000Z']) {
    test(`invalid canonical time ${JSON.stringify(date)} fails closed`, () => {
        rejects(() => resolve(state(), flags(), date), 'timestamp_invalid');
    });
}

test('zero/negative windows, duplicate grants and unknown flags are invalid', () => {
    rejects(() => resolve(state([product({ validUntil: START })])), 'window_invalid');
    rejects(() => resolve(state([product(), product()])), 'duplicate');
    rejects(() => resolve(state(), flags({ anything: true })), 'shape_invalid');
    rejects(() => resolve(state(), flags({ dashboard: 'true' })), 'flag_invalid');
});

test('canonical objects reject accessors, prototype grants, sparse arrays and wildcard selectors', () => {
    let called = false;
    const s = state(); Object.defineProperty(s, 'grants', { get() { called = true; return []; } });
    rejects(() => resolve(s), 'shape_invalid');
    assert.equal(called, false);
    rejects(() => resolve(Object.create(state())), 'shape_invalid');
    rejects(() => resolve(state(new Array(1))), 'array_invalid');
    const a = [product()]; a.extra = product();
    rejects(() => resolve(state(a)), 'array_invalid');
    rejects(() => resolve(state([product({ grantId: '*' })])), 'identifier_invalid');
});

test('normalisation is deterministic and deeply immutable without changing inputs', () => {
    const s = state([service(), product()]), before = JSON.stringify(s);
    const canonical = normaliseEntitlementState(s, tenant());
    assert.deepEqual(canonical, normaliseEntitlementState(canonical, tenant()));
    assert.equal(JSON.stringify(s), before);
    assert.ok(Object.isFrozen(canonical.grants[0].limits));
    assert.throws(() => { canonical.grants[0].limits.assessment_runs = 999; }, TypeError);
    assert.ok(Object.isFrozen(resolve().modules.overview));
});

test('limit consumption accepts the last available unit, returns next revision and never mutates input', () => {
    const u = usage(), before = JSON.stringify(u);
    const first = consume(u);
    assert.equal(first.counters.assessment_runs, 1);
    assert.equal(first.revision, 5);
    assert.equal(JSON.stringify(u), before);
    const last = consume(first, command({ expectedUsageRevision: 5 }));
    assert.equal(last.counters.assessment_runs, 2);
    rejects(() => consume(last, command({ expectedUsageRevision: 6 })), 'limit_exceeded', 403);
});

test('missing quantities and missing server counters do not default to unlimited or zero', () => {
    rejects(() => consume(usage(), command(), state([product({ limits: {} })])), 'limit_required', 403);
    rejects(() => consume(usage({ counters: {} })), 'limit_required', 403);
    rejects(() => consume(usage(), command(), state([product({ limits: { assessment_runs: 0 } })])), 'limit_exceeded', 403);
});

for (const value of [-1, NaN, Infinity, '2', 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    test(`unsafe quantity ${String(value)} is rejected`, () => {
        rejects(() => consume(usage(), command({ amount: value })), 'integer_invalid');
    });
}

test('zero amount, overflow and exhausted revisions fail without partial writes', () => {
    rejects(() => consume(usage(), command({ amount: 0 })), 'amount_invalid');
    const huge = Number.MAX_SAFE_INTEGER;
    rejects(() => consume(usage({ counters: { assessment_runs: huge } }), command(),
        state([product({ limits: { assessment_runs: huge } })])), 'limit_exceeded', 403);
    rejects(() => consume(usage({ revision: huge }), command({ expectedUsageRevision: huge })), 'revision_exhausted', 409);
});

test('every counter operation is bound to tenant, organisation and active product grant', () => {
    rejects(() => consume(usage({ organisationId: 'org-2' })), 'not_found', 404);
    rejects(() => consume(usage({ tenantId: 'synthetic-b' })), 'not_found', 404);
    rejects(() => consume(usage({ grantId: 'other' })), 'quota_grant_mismatch', 409);
    rejects(() => consume(usage(), command({ grantId: 'service-1' })), 'quota_grant_mismatch', 409);
    rejects(() => consume(usage(), command(), state(), flags(), END), 'quota_grant_mismatch', 409);
});

for (const field of ['expectedEntitlementRevision', 'expectedFlagRevision', 'expectedUsageRevision']) {
    test(`stale or future ${field} conflicts`, () => {
        rejects(() => consume(usage(), command({ [field]: 0 })), 'revision_conflict', 409);
        rejects(() => consume(usage(), command({ [field]: 100 })), 'revision_conflict', 409);
    });
}

test('repository compare-and-swap contract admits only one concurrent last-unit write', () => {
    let stored = usage({ counters: { assessment_runs: 1 } });
    const a = consume(stored), b = consume(stored);
    const commit = next => {
        assert.equal(stored.revision + 1, next.revision, 'stale write must not commit');
        stored = next;
    };
    commit(a);
    assert.throws(() => commit(b), /stale write/);
    assert.equal(stored.counters.assessment_runs, 2);
    rejects(() => consume(stored), 'revision_conflict', 409);
});

test('assessment consumption requires the exact ordered module/profile/version', () => {
    rejects(() => consume(usage(), command({ framework: { profileId: 'synthetic-profile', version: '2.0' } })), 'framework_not_entitled', 403);
    rejects(() => consume(usage(), command({ framework: null })), 'shape_invalid');
    rejects(() => consume(usage(), command({ moduleId: 'board_reports' })), 'limit_scope_invalid');
    rejects(() => consume(usage(), command(), state(), flags({ cyber_security: false })), 'module_not_entitled', 403);
});

test('report, evidence and membership limits map only to their named modules', () => {
    for (const [limit, moduleId] of [['report_exports', 'board_reports'], ['evidence_bytes', 'evidence'], ['memberships', 'overview']]) {
        const next = consume(usage(), command({ limit, moduleId, framework: null }));
        assert.equal(next.counters[limit], 1);
        rejects(() => consume(usage(), command({ limit, moduleId: 'cyber_security', framework: null })), 'limit_scope_invalid');
    }
});

test('AI allowance is finite, separately disabled, and irrelevant to deterministic assessment work', () => {
    const cmd = command({ limit: 'ai_requests', framework: null });
    rejects(() => consume(usage(), cmd), 'feature_disabled', 403);
    const cfg = flags({ ai_drafting: true });
    const next = consume(usage(), cmd, state(), cfg);
    assert.equal(next.counters.ai_requests, 1);
    rejects(() => consume(next, { ...cmd, expectedUsageRevision: 5 }, state(), cfg), 'limit_exceeded', 403);
    assert.equal(consume().counters.assessment_runs, 1);
});

test('tier changes cannot reuse a previous product grant counter', () => {
    rejects(() => consume(usage(), command(), state([product({ grantId: 'new-grant', code: 'dashboard_govern' })])), 'quota_grant_mismatch', 409);
});

test('failed service and quota assertions preserve canonical state byte-for-byte', () => {
    const s = state([product(), service()]), before = JSON.stringify(s);
    rejects(() => checkService(s, serviceRequest({ action: 'manage' })), 'service_not_entitled', 403);
    rejects(() => consume(usage(), command({ amount: 3 }), s), 'limit_exceeded', 403);
    assert.equal(JSON.stringify(s), before);
});


test('purchased framework is unusable until that exact profile version is activated', () => {
    const cfg = flags({}, { frameworks: [] });
    const result = resolve(state(), cfg);
    assert.equal(result.modules.cyber_security.reason, 'framework_unavailable');
    assert.equal(result.modules.overview.eligible, true);
    assert.deepEqual(result.frameworks, []);
    rejects(() => consume(usage(), command(), state(), cfg), 'module_not_entitled', 403);
});

test('activating another profile version cannot activate an ordered older version', () => {
    const cfg = flags({}, { frameworks: [{ moduleId: 'cyber_security', profileId: 'synthetic-profile', version: '2.0' }] });
    assert.equal(resolve(state(), cfg).modules.cyber_security.eligible, false);
});

test('a second purchased but inactive profile version is absent from eligible scope', () => {
    const p = product();
    p.frameworks.push({ moduleId: 'cyber_security', profileId: 'synthetic-profile', version: '2.0' });
    const result = resolve(state([p]));
    assert.equal(result.modules.cyber_security.eligible, true);
    assert.deepEqual(result.frameworks.map(f => f.version), ['1.0']);
    rejects(() => consume(usage(), command({ framework: { profileId: 'synthetic-profile', version: '2.0' } }), state([p])), 'framework_not_entitled', 403);
});

test('activation registry rejects duplicate and non-assessment profile scope', () => {
    const cfg = flags(); cfg.frameworks.push(copy(cfg.frameworks[0]));
    rejects(() => resolve(state(), cfg), 'duplicate');
    const invalid = flags({}, { frameworks: [{ moduleId: 'overview', profileId: 'bad', version: '1' }] });
    rejects(() => resolve(state(), invalid), 'framework_scope_invalid');
});


for (const foreign of [{ tenantId: 'synthetic-b' }, { organisationId: 'org-2' }]) {
    test(`foreign grant ownership ${JSON.stringify(foreign)} cannot be hidden inside a valid envelope`, () => {
        rejects(() => resolve(state([product(foreign)])), 'not_found', 404);
        rejects(() => resolve(state([product(), service(foreign)])), 'not_found', 404);
    });
}
