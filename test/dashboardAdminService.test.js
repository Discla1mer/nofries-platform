'use strict';

const { createDashboardAdminService, normaliseSelector } = require('../api/shared/dashboardAdmin/service');
const { createPostgresDashboardRepository } = require('../api/shared/appLifecycle/postgresDashboardRepository');
const { dataCodec } = require('../api/shared/appLifecycle/postgresDashboardBootstrap');
const { applyMembershipCommand } = require('../api/shared/appLifecycle/membershipDomain');
const { fixture, SUBJECT, NOW } = require('./fixtures/dashboardFixture');

const OTHER = SUBJECT.slice(0, -1) + '2';
const ACTOR = SUBJECT.slice(0, -1) + '9';
const principal = { provider: 'entra-bff', isAuthenticated: true, subjectKey: ACTOR };
const clone = value => JSON.parse(JSON.stringify(value));
function setup(overrides = {}) {
    const f = fixture();
    const snapshot = { tenantAggregate: clone(f.tenantAggregate), membershipState: clone(f.membershipState),
        entitlementState: clone(f.entitlementState), flags: clone(f.flags), advisorAssignments: [],
        usage: f.entitlementState.grants.map(dataCodec.newUsage) };
    const state = { allowed: true, now: NOW };
    const selector = { ...f.scope, provider: 'legacy', subjectKey: SUBJECT };
    const config = { clock: () => state.now, requestBudgetMs: 1000,
        authoriseOperator: jest.fn(({ principal: p, selector: s }) => state.allowed && p.subjectKey === ACTOR &&
            (!s || s.provider === 'legacy' && s.tenantId === f.scope.tenantId && s.organisationId === f.scope.organisationId)),
        readAuthoritySnapshot: jest.fn(async () => ({ snapshot, revisions: dataCodec.revisionVector(snapshot), evaluatedAt: state.now })),
        audit: jest.fn(async () => true), ...overrides };
    return { f, snapshot, state, selector, config, service: createDashboardAdminService(config) };
}

test('explicit composition requires an audit/policy/clock and never discovers a reader or default grant', () => {
    const h = setup();
    for (const key of ['authoriseOperator', 'audit', 'clock', 'readAuthoritySnapshot']) {
        expect(() => createDashboardAdminService({ ...h.config, [key]: undefined })).toThrow('dashboard_admin_unavailable');
    }
    expect(() => createDashboardAdminService({ ...h.config, requestBudgetMs: 60001 })).toThrow();
    expect(() => createDashboardAdminService({ ...h.config, write: () => {} })).toThrow();
});

test.each([null, {}, { ...principal, provider: 'local' }, { ...principal, isAuthenticated: false },
    { ...principal, subjectKey: 'email@example.invalid' }])('untrusted/anonymous principal denies before policy, reader or audit: %p', async input => {
    const h = setup();
    await expect(h.service.lookup(input, h.selector)).rejects.toMatchObject({ statusCode: 403 });
    expect(h.config.authoriseOperator).not.toHaveBeenCalled();
    expect(h.config.readAuthoritySnapshot).not.toHaveBeenCalled();
    expect(h.config.audit).not.toHaveBeenCalled();
});

test.each([false, undefined, 'true', {}])('explicit policy requires literal true: %p', async value => {
    const h = setup({ authoriseOperator: jest.fn(async () => value) });
    await expect(h.service.lookup(principal, h.selector)).rejects.toMatchObject({ statusCode: 403 });
    expect(h.config.readAuthoritySnapshot).not.toHaveBeenCalled();
});

test.each(['provider', 'subjectKey', 'tenantId', 'organisationId'])('rejects target substitution for %s through current exact scoped policy', async key => {
    const h = setup();
    h.config.authoriseOperator.mockImplementation(({ selector }) => !selector || JSON.stringify(selector) === JSON.stringify(normaliseSelector(h.selector)));
    const substitute = { ...h.selector, [key]: key === 'provider' ? 'external' : key === 'subjectKey' ? OTHER : 'another-scope' };
    await expect(h.service.lookup(principal, substitute)).rejects.toMatchObject({ statusCode: 403 });
    expect(h.config.readAuthoritySnapshot).not.toHaveBeenCalled();
});

test.each([{ email: 'someone@example.invalid' }, { limit: 50 }, { after: 'cursor' }, { subjectKey: '*' },
    { subjectKey: 'A' + SUBJECT.slice(1) }, { provider: 'all' }, { organisationId: '' }])('no directory/fuzzy/email/pagination contract: %p', async changes => {
    const h = setup();
    await expect(h.service.lookup(principal, { ...h.selector, ...changes })).rejects.toMatchObject({ statusCode: 400 });
    expect(h.config.readAuthoritySnapshot).not.toHaveBeenCalled();
});

test('proxy/accessor inputs fail without invoking their code; oversized query fails before reads', () => {
    const h = setup(), getter = jest.fn(() => SUBJECT);
    const input = { ...h.selector };
    Object.defineProperty(input, 'subjectKey', { enumerable: true, get: getter });
    expect(() => normaliseSelector(input)).toThrow('dashboard_admin_input_invalid');
    expect(getter).not.toHaveBeenCalled();
    expect(() => normaliseSelector(new Proxy(h.selector, { get: getter }))).toThrow();
    expect(getter).not.toHaveBeenCalled();
    expect(() => normaliseSelector({ ...h.selector, organisationId: 'x'.repeat(3000) })).toThrow();
});

test('missing reader truthfully disables capability and cannot be used as account absence', async () => {
    const h = setup({ readAuthoritySnapshot: null });
    expect(await h.service.capabilities(principal)).toEqual({ lookup: false, recovery: [] });
    await expect(h.service.lookup(principal, h.selector)).rejects.toMatchObject({ statusCode: 503 });
    expect(h.config.audit).not.toHaveBeenCalled();
});

test('canonical read sends operator actor and exact scope; projection minimises target rows and private references', async () => {
    const h = setup();
    h.snapshot.membershipState = applyMembershipCommand(h.snapshot.membershipState, h.snapshot.tenantAggregate, {
        ...h.f.scope, expectedRevision: h.snapshot.membershipState.revision, actorSubjectKey: SUBJECT, now: NOW,
        action: 'invite', payload: { invitationId: 'private-other-invitation', subjectKey: OTHER, roles: ['viewer'],
            validFrom: NOW, validUntil: '2026-09-07T09:00:00.000Z', expiresAt: '2026-09-07T09:00:00.000Z', grantEvidenceId: 'private-other-proof' } });
    const value = await h.service.lookup({ ...principal, email: 'private@example.invalid' }, h.selector);
    expect(h.config.readAuthoritySnapshot).toHaveBeenCalledWith(h.f.scope, { authenticated: true, subjectKey: ACTOR }, h.selector);
    expect(value.result).toMatchObject({ status: 'found', identity: { provider: 'legacy', subjectKey: SUBJECT },
        memberships: [{ status: 'active', effectiveStatus: 'active', roles: ['admin'] }],
        tenant: { status: 'active' }, organisation: { status: 'active' }, signup: { status: 'unavailable' },
        diagnostics: { status: 'unavailable' }, recovery: [] });
    expect(value.result.entitlements[0].validUntil).toBe(h.snapshot.entitlementState.grants[0].validUntil);
    const text = JSON.stringify(value);
    for (const secret of [OTHER, 'private-other', 'private@example', 'agreementRef', 'grantEvidenceId', 'invitationId', 'createdBy', 'domains']) expect(text).not.toContain(secret);
    expect(h.config.audit.mock.calls.map(([event]) => event.outcome)).toEqual(['attempt', 'found']);
    for (const [event, selected] of h.config.audit.mock.calls) {
        expect(event).toMatchObject({ category: 'dashboard_admin_read', actorSubjectKey: ACTOR, targetSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
        expect(JSON.stringify(event)).not.toContain(SUBJECT);
        expect(selected).toEqual(h.selector);
        expect(Object.isFrozen(selected)).toBe(true);
    }
    expect(Object.isFrozen(value.result.memberships[0])).toBe(true);
});

test('no matching member/invitation is only absence in this exact scope, with no unrelated organisation payload', async () => {
    const h = setup();
    const value = await h.service.lookup(principal, { ...h.selector, subjectKey: OTHER });
    expect(value.result.status).toBe('not_found');
    expect(value.result).not.toHaveProperty('organisation');
    expect(value.result).not.toHaveProperty('memberships');
    expect(value.result.signup.status).toBe('unavailable');
});

test('expired memberships and actual grant validity stay visible without declaring signup success', async () => {
    const h = setup(); h.state.now = '2026-09-08T09:00:00.000Z';
    const { result } = await h.service.lookup(principal, h.selector);
    expect(result.memberships[0]).toMatchObject({ status: 'active', effectiveStatus: 'expired', validUntil: '2026-09-07T09:00:00.000Z' });
    expect(result.entitlements[0].validUntil).toBe('2026-09-07T09:00:00.000Z');
    expect(result.signup).toEqual({ status: 'unavailable' });
});

test.each(['scope', 'revision', 'null', 'error', 'future', 'unknown_field'])('malformed/unavailable authority %s never becomes a success or account absence', async mode => {
    const h = setup();
    h.config.readAuthoritySnapshot.mockImplementation(async () => {
        if (mode === 'error') throw new Error('private database details');
        if (mode === 'null') return null;
        const value = { snapshot: clone(h.snapshot), revisions: clone(dataCodec.revisionVector(h.snapshot)), evaluatedAt: NOW };
        if (mode === 'scope') value.snapshot.membershipState.organisationId = 'elsewhere';
        if (mode === 'revision') value.revisions.membership++;
        if (mode === 'future') value.evaluatedAt = '2026-09-07T09:00:00.000Z';
        if (mode === 'unknown_field') value.snapshot.rawDiagnostics = 'private diagnostic body';
        return value;
    });
    const result = await h.service.lookup(principal, h.selector);
    expect(result.result.status).toBe('unavailable');
    expect(result.result).not.toHaveProperty('memberships');
    expect(JSON.stringify(result)).not.toContain('private');
    expect(h.config.audit.mock.calls.at(-1)[0].outcome).toBe('unavailable');
});

test('underlying canonical administrative denial remains a permission denial', async () => {
    const h = setup({ readAuthoritySnapshot: jest.fn(async () => { throw Object.assign(new Error(), { code: 'dashboard_administration_denied' }); }) });
    await expect(h.service.lookup(principal, h.selector)).rejects.toMatchObject({ statusCode: 403 });
});

test.each(['tenant_status', 'organisation_status', 'tenant_schema', 'organisation_schema', 'domains', 'tenant_revision', 'organisation_revision'])(
    'incomplete canonical aggregate %s stays unavailable rather than manufacturing active state', async mode => {
        const h = setup();
        const tenant = h.snapshot.tenantAggregate.tenant, organisation = h.snapshot.tenantAggregate.organisations[0];
        if (mode === 'tenant_status') delete tenant.recordStatus;
        if (mode === 'organisation_status') delete organisation.recordStatus;
        if (mode === 'tenant_schema') delete tenant.schemaVersion;
        if (mode === 'organisation_schema') delete organisation.schemaVersion;
        if (mode === 'domains') delete organisation.domains;
        if (mode === 'tenant_revision') delete tenant.revision;
        if (mode === 'organisation_revision') delete organisation.revision;
        const { result } = await h.service.lookup(principal, h.selector);
        expect(result.status).toBe('unavailable');
        expect(result).not.toHaveProperty('tenant');
        expect(result).not.toHaveProperty('organisation');
    });

test('audit admission failure prevents reads, and final audit failure withholds results', async () => {
    const h = setup(); h.config.audit.mockResolvedValueOnce(false);
    await expect(h.service.lookup(principal, h.selector)).rejects.toMatchObject({ statusCode: 503 });
    expect(h.config.readAuthoritySnapshot).not.toHaveBeenCalled();
    h.config.audit.mockResolvedValueOnce(true).mockRejectedValueOnce(new Error('private audit failure'));
    await expect(h.service.lookup(principal, h.selector)).rejects.toMatchObject({ statusCode: 503 });
    expect(h.config.readAuthoritySnapshot).toHaveBeenCalledTimes(1);
});

test.each(['during_read', 'during_audit'])('current authorization recheck denies revocation %s', async stage => {
    const h = setup();
    if (stage === 'during_read') h.config.readAuthoritySnapshot.mockImplementation(async () => {
        h.state.allowed = false; return { snapshot: h.snapshot, revisions: dataCodec.revisionVector(h.snapshot), evaluatedAt: NOW };
    });
    else h.config.audit.mockImplementation(async event => { if (event.outcome === 'found') h.state.allowed = false; return true; });
    await expect(h.service.lookup(principal, h.selector)).rejects.toMatchObject({ statusCode: 403 });
});

test('hard budget ends a hung reader without later audit or data release', async () => {
    let complete;
    const h = setup({ requestBudgetMs: 25, readAuthoritySnapshot: jest.fn(() => new Promise(resolve => { complete = resolve; })) });
    await expect(h.service.lookup(principal, h.selector)).rejects.toMatchObject({ statusCode: 503 });
    complete({ snapshot: h.snapshot, revisions: dataCodec.revisionVector(h.snapshot), evaluatedAt: NOW });
    await new Promise(resolve => setImmediate(resolve));
    expect(h.config.audit).toHaveBeenCalledTimes(1);
});

test('repeated lookup rereads source; request selectors are detached before awaiting reader', async () => {
    const h = setup(), input = { ...h.selector };
    h.config.readAuthoritySnapshot.mockImplementationOnce(async (_scope, _actor, selected) => {
        input.subjectKey = OTHER;
        expect(selected.subjectKey).toBe(SUBJECT);
        return { snapshot: h.snapshot, revisions: dataCodec.revisionVector(h.snapshot), evaluatedAt: NOW };
    });
    expect((await h.service.lookup(principal, input)).result.status).toBe('found');
    expect((await h.service.lookup(principal, input)).result.status).toBe('not_found');
    expect(h.config.readAuthoritySnapshot).toHaveBeenCalledTimes(2);
});

test('real canonical repository read contract works through service without writes or a universal callback', async () => {
    const h = setup();
    const payloads = { dashboard_tenants: [h.snapshot.tenantAggregate.tenant],
        dashboard_organisations: h.snapshot.tenantAggregate.organisations,
        dashboard_membership_states: [h.snapshot.membershipState], dashboard_entitlement_states: [h.snapshot.entitlementState],
        dashboard_feature_flags: [h.snapshot.flags], dashboard_advisor_assignments: [], dashboard_usage: h.snapshot.usage };
    const query = jest.fn(async (sql, params) => {
        expect(sql).toMatch(/^SELECT /);
        expect(params[0]).toBe(h.selector.tenantId);
        const values = payloads[sql.match(/nofries\.(dashboard_\w+)/)[1]];
        return { rows: values.map(payload => ({ tenant_id: payload.tenantId, organisation_id: payload.organisationId,
            grant_id: payload.grantId, schema_version: 1, revision: payload.revision, payload })) };
    });
    const repository = createPostgresDashboardRepository({ database: { withTenantTransaction: async (tenantId, work) => {
        expect(tenantId).toBe(h.selector.tenantId); return work({ query });
    } }, clock: () => NOW, authoriseAdministration: (command) => command.type === 'authority.read' &&
        command.actorSubjectKey === ACTOR && command.tenantId === h.selector.tenantId && command.organisationId === h.selector.organisationId });
    const service = createDashboardAdminService({ ...h.config, readAuthoritySnapshot: repository.readAuthoritySnapshot });
    expect((await service.lookup(principal, h.selector)).result.status).toBe('found');
    expect(query.mock.calls[0][0]).toContain('FOR SHARE');
    expect(query).toHaveBeenCalledTimes(7);
});
