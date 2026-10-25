'use strict';

const { randomUUID } = require('node:crypto');
const { ImprovementPlanServiceError, normaliseImprovementCommand, normaliseImprovementSelector,
    requireImprovementContext, createImprovementPlanService } = require('../api/shared/improvementPlan/improvementPlanService');
const { resolveImprovementAccess, resolveEligibleOwner } = require('../api/shared/improvementPlan/improvementPlanAccess');
const { createTenantRequestContext } = require('../api/shared/appLifecycle/tenantRequestContext');
const { applyMembershipCommand } = require('../api/shared/appLifecycle/membershipDomain');
const { fixture, SUBJECT, NOW } = require('./fixtures/dashboardFixture');

const OWNER = '10000000-0000-4000-8000-000000000000:10000000-0000-4000-8000-000000000002';
const UNKNOWN = '10000000-0000-4000-8000-000000000000:10000000-0000-4000-8000-000000000003';
const clone = value => JSON.parse(JSON.stringify(value));
const scope = { tenantId: 'synthetic-tenant', organisationId: 'synthetic-workshop' };
const generate = () => ({ planId: 'plan-a', type: 'generate', operationId: 'generate-a',
    expectedRevision: null, actionId: null, payload: { assessmentId: 'assessment-a', assessmentRevision: 2,
        assessmentRevisionSha256: 'a'.repeat(64) } });
const command = (type = 'assign', payload = { ownerSubjectKey: OWNER, dueDate: '2026-10-01' }) => ({
    planId: 'plan-a', type, operationId: 'operation-a', expectedRevision: 0, actionId: 'action:synthetic-a', payload });
function resolver(selectedScope = scope, subjectKey = SUBJECT) {
    return createTenantRequestContext({ authenticate: async () => ({ authenticated: true, subjectKey }),
        resolveScope: async () => selectedScope, clock: () => NOW, createRequestId: randomUUID });
}
function harness(requestContext = resolver()) {
    const repository = { readImprovementPlan: jest.fn(async () => ({ schemaVersion: 1, plan: null })),
        executeImprovementPlan: jest.fn(async () => ({ schemaVersion: 1, plan: null })) };
    return { repository, requestContext, service: createImprovementPlanService({ repository, requestContext }) };
}
function expectInputInvalid(work) {
    expect(work).toThrow(ImprovementPlanServiceError);
    try { work(); } catch (error) { expect(error).toMatchObject({ code: 'improvement_input_invalid', statusCode: 400 }); }
}
function expectDenied(work) {
    expect(work).toThrow(ImprovementPlanServiceError);
    try { work(); } catch (error) { expect(error).toMatchObject({ code: 'improvement_access_denied', statusCode: 403 }); }
}
function authority(options = {}) {
    const source = clone(fixture({ role: options.role || 'editor', tier: options.tier || 'dashboard_score',
        ...(options.service ? { service: 'fractional_advisory' } : {}) }));
    const snapshot = { tenantAggregate: source.tenantAggregate, membershipState: source.membershipState,
        entitlementState: source.entitlementState, flags: source.flags,
        advisorAssignments: Object.values(source.advisorAssignments) };
    // A synthetic advisor has an explicit improvement grant; the general fixture
    // intentionally starts with a Cyber-only grant.
    for (const assignment of snapshot.advisorAssignments) {
        assignment.modules = ['improvement_plan'];
        assignment.permissions = ['improvement.read', 'improvement.write'];
    }
    return snapshot;
}
function changeMember(snapshot, action, subjectKey = SUBJECT) {
    const membership = snapshot.membershipState.memberships.find(row => row.subjectKey === subjectKey);
    snapshot.membershipState = applyMembershipCommand(snapshot.membershipState, snapshot.tenantAggregate,
        { ...scope, expectedRevision: snapshot.membershipState.revision, actorSubjectKey: SUBJECT,
            now: NOW, action, payload: { membershipId: membership.membershipId } });
}
function addOwner(snapshot) {
    const member = snapshot.membershipState.memberships[0];
    const invite = { ...snapshot.membershipState.invitations[0], invitationId: 'owner-invitation',
        membershipId: 'owner-membership', subjectKey: OWNER, roles: ['viewer'], updatedBy: OWNER };
    const owner = { ...member, membershipId: 'owner-membership', invitationId: 'owner-invitation',
        subjectKey: OWNER, roles: ['viewer'], createdBy: OWNER, updatedBy: OWNER };
    snapshot.membershipState.invitations.push(invite);
    snapshot.membershipState.memberships.push(owner);
    return owner;
}

test('normalizers preserve exact detached caller intent and expose only selectors and action commands', () => {
    const source = generate(), normalized = normaliseImprovementCommand(source);
    expect(normalized).toEqual(source);
    source.payload.assessmentId = 'changed-after-normalization';
    expect(normalized.payload.assessmentId).toBe('assessment-a');
    expect(Object.isFrozen(normalized.payload)).toBe(true);
    expect(normaliseImprovementSelector({ planId: 'plan-a' })).toEqual({ planId: 'plan-a' });
    expect(Object.isFrozen(normaliseImprovementSelector({ planId: 'plan-a' }))).toBe(true);
    for (const input of [command(), command('start', {}), command('block', { reason: '  Waiting.\n  ' }),
        command('complete', { note: '  Done.\n  ', evidenceReference: 'opaque:evidence-a' }),
        command('reopen', { reason: 'Review identified further work.' })]) {
        expect(normaliseImprovementCommand(input)).toEqual(input);
    }
});

test.each(['tenantId', 'organisationId', 'actorSubjectKey', 'at', 'now', 'evaluationOutputSha256',
    'eligibleOwnerSubjectKeys', 'entitlement', 'source', 'commands', 'revision'])
('rejects injected server-owned command field %s', key => {
    expectInputInvalid(() => normaliseImprovementCommand({ ...generate(), [key]: 'untrusted' }));
    expectInputInvalid(() => normaliseImprovementCommand({ ...command(), [key]: 'untrusted' }));
});

test('command and selector envelopes are closed at every nested boundary', () => {
    for (const input of [null, [], {}, { ...generate(), type: 'create' },
        { ...generate(), actionId: 'action:unexpected' }, { ...generate(), expectedRevision: 0 },
        { ...generate(), payload: { ...generate().payload, evaluation: {} } },
        { ...generate(), payload: { assessmentId: 'assessment-a', assessmentRevision: 2 } },
        command('start', { ownerSubjectKey: OWNER }), command('block', { reason: 'Blocked.', admin: true }),
        command('complete', { note: 'Done.' }), command('reopen', { reason: 'Again.', at: NOW }),
        command('assign', { ownerSubjectKey: OWNER, dueDate: '2026-02-30' }),
        command('assign', { ownerSubjectKey: 'untrusted-user', dueDate: '2026-10-01' })]) {
        expectInputInvalid(() => normaliseImprovementCommand(input));
    }
    for (const key of Object.keys(generate())) {
        const input = generate(); delete input[key];
        expectInputInvalid(() => normaliseImprovementCommand(input));
    }
    for (const input of [null, {}, { planId: 'plan-a', tenantId: 'other' },
        { planId: 'plan-a', organisationId: 'other' }, { planId: 'plan-a', actorSubjectKey: SUBJECT }]) {
        expectInputInvalid(() => normaliseImprovementSelector(input));
    }
});

test('identifiers, source seals and revision bounds reject rather than normalize', () => {
    for (const key of ['planId', 'operationId', 'actionId']) {
        expect(normaliseImprovementCommand({ ...command(), [key]: 'A'.repeat(120) })[key]).toHaveLength(120);
        for (const value of ['', ' leading', 'trailing ', '*', 'a/b', 'é', 'A'.repeat(121)]) {
            expectInputInvalid(() => normaliseImprovementCommand({ ...command(), [key]: value }));
        }
    }
    expect(normaliseImprovementCommand({ ...command(), expectedRevision: 1023 }).expectedRevision).toBe(1023);
    for (const value of [null, -1, -0, 1024, 0.5, Number.MAX_SAFE_INTEGER + 1, '0']) {
        expectInputInvalid(() => normaliseImprovementCommand({ ...command(), expectedRevision: value }));
    }
    for (const value of ['A'.repeat(64), 'a'.repeat(63), 'not-a-source-seal']) {
        const input = generate(); input.payload.assessmentRevisionSha256 = value;
        expectInputInvalid(() => normaliseImprovementCommand(input));
    }
    const maximumSource = generate(); maximumSource.payload.assessmentRevision = 128;
    expect(normaliseImprovementCommand(maximumSource).payload.assessmentRevision).toBe(128);
    for (const value of [null, -1, -0, 129, 1.5, '2']) {
        const input = generate(); input.payload.assessmentRevision = value;
        expectInputInvalid(() => normaliseImprovementCommand(input));
    }
});

test.each(['A'.repeat(180), '證據'.repeat(90), '😀'.repeat(90), 'Opaque:Case|/path?like#id'])
('completion retains existing opaque evidence identity %s', evidenceReference => {
    const value = normaliseImprovementCommand(command('complete', { note: 'Checked synthetic work.', evidenceReference }));
    expect(value.payload.evidenceReference).toBe(evidenceReference);
    expect(Object.isFrozen(value.payload)).toBe(true);
});

test('completion references reject locations and malformed Unicode without widening evidence access', () => {
    for (const evidenceReference of ['a'.repeat(181), '\ud800', '\udc00', '\u0000', ' leading', 'trailing ',
        'https://example.invalid/evidence', 'HTTP:example.invalid', 's3://bucket/key', 'file:///tmp/evidence',
        'data:text/plain,hello', 'javascript:alert(1)', '/tmp/evidence', '../evidence', './evidence',
        '..\\evidence', 'C:\\evidence', '\\\\server\\evidence']) {
        expectInputInvalid(() => normaliseImprovementCommand(command('complete', { note: 'Done.', evidenceReference })));
    }
});

test.each(['complete', 'block', 'reopen'])('%s notes reject malformed Unicode and preserve valid text', type => {
    const payload = value => type === 'complete' ? { note: value, evidenceReference: 'evidence:a' } : { reason: value };
    const text = '  Māori 日本語 e\u0301 😀\n\tUnchanged.  ';
    expect(normaliseImprovementCommand(command(type, payload(text))).payload).toEqual(payload(text));
    for (const value of [' ', '\ud800', '\udc00', '\u0000', 'x'.repeat(1001)]) {
        expectInputInvalid(() => normaliseImprovementCommand(command(type, payload(value))));
    }
});

test('hostile input hooks cannot run during command or selector validation', () => {
    let hooks = 0;
    const getter = generate();
    Object.defineProperty(getter.payload, 'assessmentId', { enumerable: true, get() { hooks++; return 'assessment-a'; } });
    const proxy = new Proxy(generate(), { ownKeys() { hooks++; return []; } });
    const toJSON = generate(); toJSON.payload.toJSON = () => { hooks++; return {}; };
    const symbol = generate(); symbol[Symbol('scope')] = 'forged';
    const hidden = generate(); Object.defineProperty(hidden, 'hidden', { value: 'forged' });
    const cycle = generate(); cycle.payload.self = cycle;
    for (const input of [getter, proxy, toJSON, symbol, hidden, cycle, Object.create(generate()),
        { ...generate(), payload: new Date() }, { ...generate(), payload: undefined },
        { ...generate(), payload: 1n }, { ...generate(), payload: Infinity }]) {
        expectInputInvalid(() => normaliseImprovementCommand(input));
    }
    const selector = {};
    Object.defineProperty(selector, 'planId', { enumerable: true, get() { hooks++; return 'plan-a'; } });
    expectInputInvalid(() => normaliseImprovementSelector(selector));
    expect(hooks).toBe(0);
});

test('a genuine context requires its process brand and representable selected scope', async () => {
    const context = await resolver().resolve({});
    expect(requireImprovementContext(context)).toBe(context);
    for (const value of [null, clone(context), { ...context }, Object.create(context)]) {
        expectDenied(() => requireImprovementContext(value));
    }
    const unsupported = await resolver({ ...scope, tenantId: 'é-tenant' }).resolve({});
    expect(() => requireImprovementContext(unsupported)).toThrow(ImprovementPlanServiceError);
});

test('service detaches caller input before awaiting context and passes only branded identity', async () => {
    const context = await resolver().resolve({}), request = { tenantId: 'forged', actorSubjectKey: UNKNOWN };
    let release;
    const requestContext = { resolve: jest.fn(() => new Promise(resolve => { release = () => resolve(context); })) };
    const h = harness(requestContext), source = generate(), original = clone(source);
    const pending = h.service.execute(request, source);
    source.payload.assessmentId = 'changed-during-authentication';
    expect(h.repository.executeImprovementPlan).not.toHaveBeenCalled();
    await Promise.resolve(); release(); await pending;
    expect(requestContext.resolve).toHaveBeenCalledWith(request);
    expect(h.repository.executeImprovementPlan).toHaveBeenCalledWith(context, original);
    expect(Object.isFrozen(h.repository.executeImprovementPlan.mock.calls[0][1].payload)).toBe(true);
    expect(Object.keys(h.service).sort()).toEqual(['execute', 'read']);
});

test('service resolves each request and never treats a previous success as current authority', async () => {
    const context = await resolver().resolve({}), requestContext = { resolve: jest.fn(async () => context) };
    const h = harness(requestContext), firstRequest = {}, secondRequest = {}, readRequest = {};
    const accepted = { schemaVersion: 1, plan: { planId: 'plan-a', revision: 0 } };
    h.repository.executeImprovementPlan.mockResolvedValueOnce(accepted)
        .mockRejectedValueOnce(new ImprovementPlanServiceError('improvement_access_denied', 403));
    expect(await h.service.execute(firstRequest, generate())).toBe(accepted);
    await expect(h.service.execute(secondRequest, generate())).rejects.toMatchObject({ code: 'improvement_access_denied' });
    await h.service.read(readRequest, { planId: 'plan-a' });
    expect(requestContext.resolve.mock.calls).toEqual([[firstRequest], [secondRequest], [readRequest]]);
    expect(h.repository.readImprovementPlan).toHaveBeenCalledWith(context, { planId: 'plan-a' });
});

test('invalid input and fabricated contexts never reach a repository', async () => {
    const requestContext = { resolve: jest.fn(async () => ({ scope, identity: { subjectKey: SUBJECT } })) }, h = harness(requestContext);
    await expect(h.service.execute({}, { ...generate(), tenantId: 'forged' })).rejects.toMatchObject({ code: 'improvement_input_invalid' });
    await expect(h.service.read({}, { planId: 'plan-a', organisationId: 'forged' })).rejects.toMatchObject({ code: 'improvement_input_invalid' });
    expect(requestContext.resolve).not.toHaveBeenCalled();
    await expect(h.service.execute({}, generate())).rejects.toMatchObject({ code: 'improvement_access_denied' });
    await expect(h.service.read({}, { planId: 'plan-a' })).rejects.toMatchObject({ code: 'improvement_access_denied' });
    expect(h.repository.readImprovementPlan).not.toHaveBeenCalled();
    expect(h.repository.executeImprovementPlan).not.toHaveBeenCalled();
});

test('service composition requires the fixed repository and request-context boundary', () => {
    const h = harness();
    for (const adapters of [undefined, {}, { repository: h.repository },
        { repository: h.repository, requestContext: {} },
        { repository: { readImprovementPlan() {} }, requestContext: resolver() },
        { repository: h.repository, requestContext: resolver(), policy: {} }]) {
        expect(() => createImprovementPlanService(adapters)).toThrow(ImprovementPlanServiceError);
    }
});

test('access uses existing improvement roles and Score entitlement without requiring the governance workflow', async () => {
    const context = await resolver().resolve({});
    for (const role of ['admin', 'editor']) {
        const snapshot = authority({ role }); snapshot.flags.enabled.governance_workflow = false;
        for (const permission of ['improvement.read', 'improvement.write']) {
            expect(() => resolveImprovementAccess(snapshot, context, permission, NOW)).not.toThrow();
        }
    }
    for (const permission of ['improvement.read', 'improvement.write']) {
        expectDenied(() => resolveImprovementAccess(authority({ role: 'viewer' }), context, permission, NOW));
    }
    expectDenied(() => resolveImprovementAccess(authority(), context, 'assessment.write', NOW));
});

test.each(['suspended', 'removed', 'expired', 'foreign-tenant', 'foreign-organisation', 'past-context',
    'product-revoked', 'product-expired', 'module-not-ordered', 'module-disabled', 'dashboard-disabled',
    'organisation-suspended', 'tenant-suspended'])('current %s denies improvement access', async kind => {
    const snapshot = authority(); let selectedScope = scope, at = NOW;
    if (kind === 'suspended' || kind === 'removed') changeMember(snapshot, kind === 'suspended' ? 'suspend' : 'remove');
    else if (kind === 'expired') at = snapshot.membershipState.memberships[0].validUntil;
    else if (kind === 'foreign-tenant') selectedScope = { ...scope, tenantId: 'other-tenant' };
    else if (kind === 'foreign-organisation') selectedScope = { ...scope, organisationId: 'other-organisation' };
    else if (kind === 'past-context') at = '2026-09-06T08:59:59.999Z';
    else if (kind === 'product-revoked') snapshot.entitlementState.grants[0].status = 'revoked';
    else if (kind === 'product-expired') snapshot.entitlementState.grants[0].validUntil = NOW;
    else if (kind === 'module-not-ordered') snapshot.entitlementState.grants[0].modules = ['overview'];
    else if (kind === 'module-disabled') snapshot.flags.enabled.improvement_plan = false;
    else if (kind === 'dashboard-disabled') snapshot.flags.enabled.dashboard = false;
    else if (kind === 'organisation-suspended') snapshot.tenantAggregate.organisations[0].recordStatus = 'suspended';
    else snapshot.tenantAggregate.tenant.recordStatus = 'suspended';
    const context = await resolver(selectedScope).resolve({});
    for (const permission of ['improvement.read', 'improvement.write']) {
        expectDenied(() => resolveImprovementAccess(snapshot, context, permission, at));
    }
});

test('an advisor needs current explicit improvement assignment and purchased advisory service', async () => {
    const context = await resolver().resolve({}), active = authority({ role: 'fractional_advisor', service: true });
    expect(() => resolveImprovementAccess(active, context, 'improvement.write', NOW)).not.toThrow();
    for (const kind of ['service-absent', 'service-revoked', 'service-disabled', 'assignment-revoked', 'assignment-expired',
        'permission-missing', 'module-missing']) {
        const snapshot = clone(active);
        if (kind === 'service-absent') snapshot.entitlementState.grants = snapshot.entitlementState.grants.filter(grant => grant.code !== 'fractional_advisory');
        else if (kind === 'service-revoked') snapshot.entitlementState.grants.find(grant => grant.code === 'fractional_advisory').status = 'revoked';
        else if (kind === 'service-disabled') snapshot.flags.enabled['service:fractional_advisory'] = false;
        else if (kind === 'assignment-revoked') snapshot.advisorAssignments[0].status = 'revoked';
        else if (kind === 'assignment-expired') snapshot.advisorAssignments[0].validUntil = NOW;
        else if (kind === 'permission-missing') snapshot.advisorAssignments[0].permissions = ['improvement.read'];
        else snapshot.advisorAssignments[0].modules = ['cyber_security'];
        expectDenied(() => resolveImprovementAccess(snapshot, context, 'improvement.write', NOW));
    }
});

test('owner eligibility is current organisation membership, not a supplied subject key or write grant', async () => {
    const snapshot = authority(), owner = addOwner(snapshot), context = await resolver().resolve({});
    expect(() => resolveEligibleOwner(snapshot, context, OWNER, NOW)).not.toThrow();
    expect(owner.roles).toEqual(['viewer']);
    expect(() => resolveEligibleOwner(snapshot, context, UNKNOWN, NOW)).toThrow();
    expect(() => resolveEligibleOwner(snapshot, context, 'untrusted-subject', NOW)).toThrow();
    for (const action of ['suspend', 'remove']) {
        const changed = clone(snapshot); changeMember(changed, action, OWNER);
        expect(() => resolveEligibleOwner(changed, context, OWNER, NOW)).toThrow();
    }
    expect(() => resolveEligibleOwner(snapshot, context, OWNER, owner.validUntil)).toThrow();
    const foreign = await resolver({ ...scope, organisationId: 'other-organisation' }).resolve({});
    expect(() => resolveEligibleOwner(snapshot, foreign, OWNER, NOW)).toThrow();
});
